# The Redis-backed store

**Status: built.** `src/lib/redisStore.ts`, selected by `createStore()` in
`src/lib/store.ts`. This resolves item 1 of [PUBLISHING.md](PUBLISHING.md) —
the decision that gates a public instance — in favour of **route A, a shared
store**, on Upstash Redis behind a Vercel deployment.

`MessageStore` was built for exactly this: every method was already async, and
nothing outside `lib/store.ts` changed. What follows is why, the arithmetic
that says it fits in a free tier, and the decisions the code cannot state for
itself.

## Why not route B after all

The assumption behind "B is the cheaper honest answer" was a free always-on
host. Checked in September 2026, that host mostly does not exist:

| Host | Free today | What it does to an in-memory store |
| --- | --- | --- |
| Fly.io | **No.** Free allowances withdrawn in 2024; new orgs get a 2-hour trial | The original route-B recommendation is gone |
| Render | Yes | Spins down after **15 minutes** with no inbound traffic |
| Koyeb | Yes | Scales to zero after **1 hour** idle; cannot be disabled |
| Oracle Cloud Always Free | Yes, genuinely always-on | Real, but you own a VM: patching, TLS, restarts — and Oracle reclaims idle instances |

Render's 15 minutes is disqualifying on its own: endpoints would evaporate
mid-session, which is the one failure a debugging tool cannot have.

Koyeb is the one honest route-B option left, and it is nearly defensible: its
1-hour idle window coincides with the 1-hour endpoint TTL that item 3 wants
anyway, so an hour of total silence would lose only endpoints that were about to
expire. It gets Notifyr *public*. It does not make it *correct*, and it leaves
items 2 and 3 still to write.

Route A costs a day and answers all three.

## Why Redis and not Postgres

Not preference — the primitives are the invariants. Every rule `lib/store.ts`
currently holds by being careful becomes a rule the storage engine holds
structurally:

| Invariant (DESIGN.md) | Redis |
| --- | --- |
| Counters are cumulative, never derived from the retained list | `HINCRBY` on the endpoint hash. It cannot decrease when trimming happens — the invariant stops being a rule anyone can break |
| 100 messages per endpoint, newest first | `LPUSH` + `LTRIM 0 99`. The cap *is* the write |
| A taken id returns 409 and never joins | `HSETNX`. Atomic, and strictly better than the in-memory check-then-set, which is a race in principle |
| `version` bumps drive the dashboard poll | `HINCRBY` in the same pipeline as the write it describes |
| Snapshots must not alias live state | Free. Deserialising is a copy; `getSnapshot`'s `structuredClone` calls exist only for the in-memory implementation |
| At most 20 tracked subscriptions, most recent first | One JSON field, ordered, capped on write |
| **Endpoint expiry (item 3)** | `EXPIRE` on every write. The TTL that item wanted, at no extra cost |
| **Rate limiting (item 2)** | `INCR` + `EXPIRE`, same connection, no second dependency |

Postgres would do all of this too, with a hand-rolled trimming query, a
hand-rolled TTL sweep and a migration story, for a dataset that is deliberately
ephemeral and never queried by anything but primary key.

## The arithmetic

`POLL_INTERVAL_MS` is 2000 and the loop pauses on `visibilitychange`
(`useEndpointPoll.ts`), so the unit of cost is **one visible dashboard-hour =
1,800 polls**. A poll that finds nothing new is a single `HGET`.

| Budget | Free allowance | Visible dashboard-hours |
| --- | --- | --- |
| Upstash commands | 500K / month | **~275** |
| Vercel invocations | 1M / month | ~550 |
| Vercel active CPU | 4 CPU-hours / month | ~400 |

Upstash binds first, at roughly nine hours a day of somebody, somewhere,
watching a dashboard. Notification writes are a rounding error against that: one
pipeline of six commands each.

Two consequences worth stating rather than discovering:

- **Vercel Hobby is personal, non-commercial use only.** Crossing an included
  limit blocks the feature for 30 days rather than billing for it.
- **SSE is still not worth it here**, even though this change is what unlocks
  it. An SSE stream holds a function open per viewer, which is far worse against
  4 CPU-hours than a 2-second poll. SSE earns its place on a long-lived process
  or on Cloudflare Durable Objects, not on Vercel functions.

## Key layout

```
endpoint:{id}            HASH   metadata, counters, rules, continuity, version
endpoint:{id}:messages   LIST   JSON, newest first, LTRIM'd to 100
ratelimit:{scope}:{key}  STRING INCR + EXPIRE          (item 2, same connection)
```

Two keys per endpoint, both carrying the same TTL, both refreshed by the same
pipeline. Counters live as their own hash fields so `HINCRBY` can reach them;
everything structural — response rules, continuity — lives as JSON in a field.

`MAX_ENDPOINTS`, the 500-endpoint cap with oldest-first eviction, **goes away**.
It exists to bound memory in a process that never forgets; a TTL bounds it
better. What replaces it as the bound on abuse is rate limiting, which is why
items 1 and 2 want doing in the same sitting.

## What each method becomes

| Method | Commands | Round trips |
| --- | --- | --- |
| `createEndpoint` | `HSETNX`, then `HSET` + `EXPIRE` | 2 |
| `getEndpoint` | `HGETALL` | 1 |
| `addMessage` | `EXISTS`, then `LPUSH` + `LTRIM` + 2-3 x `HINCRBY` + 2 x `EXPIRE` | 2 |
| `getSnapshot` | `HGETALL` + `LRANGE` + 2 x `EXPIRE`, pipelined | 1 |
| poll with `?since=` | `HGET version` | 1 |
| `updateResponseRules` | `HSET` (one field per patched type) + `HINCRBY version` | 1 |
| `updateExpectedPayloadContent` | `HSET` or `HDEL`, + `HINCRBY version` | 1 |
| `updateHeartbeatPeriod` | `HGETALL`, then `HSET` + `HINCRBY version` + `EXPIRE` | 2 |
| `recordContinuity` | `HGETALL`, compute, `HSET` | 2 |

The two continuity paths read with `HGETALL` rather than `HMGET`: Upstash
returns an object keyed by field either way, and `HGETALL` answers "does this
endpoint exist" in the same command, where `HMGET` on a missing key is
indistinguishable from one whose fields are unset.

Response rules are stored **one field per notification type** precisely so that
`updateResponseRules` is a partial `HSET` rather than a read-merge-write. Two
tabs toggling different switches cannot clobber each other.

## The implementation

The code is `src/lib/redisStore.ts`; what follows is what reading it will not
tell you.

**It depends on a hand-written `RedisLike` interface, not on the Upstash
client.** Ten commands, listed in one place. That is partly documentation — the
whole surface this store needs, in fifteen lines — and partly what makes the
test suite possible: `tests/support/fakeRedis.ts` implements the same
interface in process, so `RedisStore` runs the *same* contract as
`InMemoryStore` in `tests/store.test.ts`, with no network and no container.
Every case runs twice.

That fake covers this store's own logic — ordering, trimming, counter
arithmetic, the 409, continuity folding. It cannot cover Upstash's wire
behaviour, which is what `npm run test:live` is for: four cases in the same
file, skipped unless `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
are present, so `npm test` and CI stay network-free. Copy `.env.example` to
`.env.local` to run them.

**Values come back parsed.** The Upstash client JSON-decodes responses, so a
field written as `JSON.stringify(record)` returns as an object, and a field
written as `0` returns as a number rather than `"0"`. Every read goes through
`parseJson` or `numberFrom`, which accept both — the fake reproduces the
decoding for the same reason.

**The endpoint hash is the existence check.** `hash.id === undefined` is how
"no such endpoint" is spelled, because a hash that has expired, was never
created, or was trimmed to nothing are the same answer to the caller: `null`.

**Response rules are one field per notification type** (`rule:handshake` and
so on), so `updateResponseRules` is a partial `HSET` rather than a
read-merge-write. Two dashboards toggling different switches cannot clobber each
other — an improvement on the in-memory store, which merges a whole object.

**The TTL is refreshed on writes and on snapshot reads**, so an endpoint someone
is actively watching does not expire under them. The `?since=` fast path does
not refresh; see "Still open".

Selecting the implementation is credentials, not configuration:

```ts
export function createStore(): MessageStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisStore(new Redis({ url, token }));
  return (globalForStore.__notifyrStore ??= new InMemoryStore());
}
```

A deployment either has somewhere shared to put its data or it does not; a
separate flag would only add a way for the two answers to disagree. Half
configured falls back to in-memory rather than constructing a client that fails
on every request — wrong in a way the dashboard already warns about, instead of
wrong on every notification. All three cases are tested.

## The one race

`recordContinuity` reads the continuity field, folds one observation into it and
writes it back. Two notifications for the same endpoint landing on two instances
within the same few milliseconds can lose one fold.

The blast radius is worth stating precisely, because it looks worse than it is:

- **It cannot corrupt a record**, only lose an increment — the write is a whole
  valid JSON array either way.
- **It cannot affect a stored message, a counter or a wire status.** Those are
  `HINCRBY` and `LPUSH` on other fields: atomic, and untouched by this.
- **The common case is a single sender delivering sequentially**, which is one
  writer per subscription reference by construction.

So the cost is that under genuinely concurrent delivery a missed-event warning
may under-count. Two upgrades exist if that ever matters — a `SET NX PX` lock
per endpoint, or a Lua `EVAL` doing compare-and-set against a revision field —
and neither earns its complexity until someone sees it happen.

## Staging

1. ~~**`RedisStore` plus the config seam**, with `tests/store.test.ts`
   parameterised so both implementations answer the same contract.~~ Done.
2. ~~**TTL, and no `MAX_ENDPOINTS`** — one change, since the cap and the TTL
   are two answers to the same question.~~ Done: `TTL_SECONDS`, refreshed on
   every write, and `RedisStore` has no endpoint cap.
3. **Rate limiting** (item 2) on the same connection. Now load-bearing rather
   than merely wanted, since the endpoint cap that shared the job is gone.
4. ~~**A live smoke test** against a real Upstash database.~~ Done:
   `npm run test:live`, plus an end-to-end pass through the running app —
   handshake and two heartbeats posted to `/hook/:id`, read back through
   `/api/endpoints/:id/messages` with the counters, the per-type tallies, the
   continuity warnings and the `?since=` fast path all correct against a real
   database.
5. Deploy, then items 4 and 5 of PUBLISHING.md.

Steps 1 and 2 are done; step 3 is an hour once the connection exists.

## Still open

- **Does a poll refresh the TTL?** As sketched, only a full snapshot fetch does,
  not the `?since=` fast path — refreshing on every poll would double the
  binding budget. A dashboard left open on a completely silent endpoint for a
  full hour would therefore watch it expire. That is also, almost exactly, the
  definition of an abandoned endpoint.
- **`getSnapshot` now reads only what the caller asked for.** `LRANGE` takes the
  limit, where the in-memory store always held all 100 and sliced. Nothing
  observable changes, but DESIGN.md's retention section describes the old shape.
- **Cloudflare Durable Objects** remain the better long-term answer — one object
  per endpoint gives a single writer (no race above), storage, and WebSocket
  push that deletes the polling loop entirely. The cost is porting Next 16 via
  OpenNext and rewriting the store around DO storage: a different project, not a
  bigger version of this one.

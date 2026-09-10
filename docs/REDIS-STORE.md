# The Redis-backed store

**Status: designed, not built.** This resolves item 1 of
[PUBLISHING.md](PUBLISHING.md) — the decision that gates a public instance — in
favour of **route A, a shared store**, on Upstash Redis behind a Vercel
deployment.

`MessageStore` was built for exactly this: every method is already async, so
nothing outside `lib/store.ts` changes. What follows is the mapping, the
arithmetic that says it fits in a free tier, and a sketch close enough to type
from.

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
| `updateHeartbeatPeriod` | read + write of the continuity field, + `HINCRBY version` | 2 |
| `recordContinuity` | `HGET continuity`, compute, `HSET` | 2 |

Response rules are stored **one field per notification type** precisely so that
`updateResponseRules` is a partial `HSET` rather than a read-merge-write. Two
tabs toggling different switches cannot clobber each other.

## Sketch

```ts
import { Redis } from "@upstash/redis";

import { observe, type ContinuityObservation } from "@/lib/continuity";
import { randomEndpointId } from "@/lib/endpointId";
import type { MessageStore } from "@/lib/store";
import {
  DEFAULT_HEARTBEAT_PERIOD_SECONDS,
  defaultResponseRules,
  emptyNotificationCounts,
  MAX_RECENT_MESSAGES,
  MAX_STORED_MESSAGES,
  type Endpoint,
  type EndpointSnapshot,
  type Message,
  type NewMessage,
  type ResponseRules,
  type SubscriptionContinuity,
  type ValidationError,
} from "@/lib/types";

/** An hour with no traffic. Answers PUBLISHING.md item 3, and replaces MAX_ENDPOINTS. */
const TTL_SECONDS = 3600;

const MAX_TRACKED_SUBSCRIPTIONS = 20;

const endpointKey = (id: string) => `endpoint:${id}`;
const messagesKey = (id: string) => `endpoint:${id}:messages`;

export class RedisStore implements MessageStore {
  constructor(private readonly redis: Redis = Redis.fromEnv()) {}

  async createEndpoint(id?: string): Promise<Endpoint | null> {
    const endpoint = newEndpoint(id ?? randomEndpointId());
    const key = endpointKey(endpoint.id);

    // The 409, atomically: of two racing creates only one sets the field. The
    // in-memory store's has() check cannot promise this, and never had to.
    if ((await this.redis.hsetnx(key, "id", endpoint.id)) === 0) return null;

    await this.redis.pipeline().hset(key, toHash(endpoint)).expire(key, TTL_SECONDS).exec();

    return endpoint;
  }

  async getEndpoint(endpointId: string): Promise<Endpoint | null> {
    const hash = await this.redis.hgetall<Record<string, string>>(endpointKey(endpointId));
    return hash ? fromHash(hash) : null;
  }

  async addMessage(endpointId: string, input: NewMessage): Promise<Message | null> {
    const key = endpointKey(endpointId);
    // A pipeline cannot branch, and "unknown endpoint" is a null, not a throw.
    if ((await this.redis.exists(key)) === 0) return null;

    const message: Message = { ...input, id: crypto.randomUUID(), endpointId };
    const pipeline = this.redis.pipeline();

    pipeline.lpush(messagesKey(endpointId), JSON.stringify(message));
    // The retention cap is the write itself. The counters below are HINCRBY on
    // separate fields, so trimming can never walk them backwards.
    pipeline.ltrim(messagesKey(endpointId), 0, MAX_STORED_MESSAGES - 1);
    pipeline.hincrby(key, message.isValid ? "validCount" : "invalidCount", 1);
    // Only valid notifications are tallied by type.
    if (message.isValid && message.notificationType) {
      pipeline.hincrby(key, `count:${message.notificationType}`, 1);
    }
    pipeline.hincrby(key, "version", 1);
    pipeline.expire(key, TTL_SECONDS);
    pipeline.expire(messagesKey(endpointId), TTL_SECONDS);

    await pipeline.exec();
    return message;
  }

  async getSnapshot(
    endpointId: string,
    limit: number = MAX_RECENT_MESSAGES,
  ): Promise<EndpointSnapshot | null> {
    // One round trip, and the TTL refresh rides along free. Traffic is not the
    // only sign an endpoint is alive; somebody watching it counts too.
    const [hash, raw] = (await this.redis
      .pipeline()
      .hgetall<Record<string, string>>(endpointKey(endpointId))
      .lrange(messagesKey(endpointId), 0, limit - 1)
      .expire(endpointKey(endpointId), TTL_SECONDS)
      .expire(messagesKey(endpointId), TTL_SECONDS)
      .exec()) as [Record<string, string> | null, string[], number, number];

    if (!hash) return null;

    // No structuredClone anywhere here: deserialising is already a copy, so
    // "snapshots must not alias live state" holds by construction.
    return { endpoint: fromHash(hash), messages: raw.map((json) => JSON.parse(json) as Message) };
  }

  async updateResponseRules(
    endpointId: string,
    patch: Partial<ResponseRules>,
  ): Promise<Endpoint | null> {
    const key = endpointKey(endpointId);
    if ((await this.redis.exists(key)) === 0) return null;

    // One field per notification type, so a partial patch is a partial HSET.
    // Two dashboards toggling different switches cannot overwrite each other.
    const fields = Object.fromEntries(
      Object.entries(patch).map(([type, rule]) => [`rule:${type}`, JSON.stringify(rule)]),
    );

    await this.redis.pipeline().hset(key, fields).hincrby(key, "version", 1).exec();
    return this.getEndpoint(endpointId);
  }

  async recordContinuity(
    endpointId: string,
    observation: Omit<ContinuityObservation, "heartbeatPeriodSeconds">,
  ): Promise<ValidationError[]> {
    const key = endpointKey(endpointId);
    const [json, period] = await this.redis.hmget<[string | null, string | null]>(
      key,
      "continuity",
      "heartbeatPeriodSeconds",
    );
    if (period === null) return [];

    const records: SubscriptionContinuity[] = json ? JSON.parse(json) : [];
    const index = records.findIndex((record) => record.reference === observation.reference);

    const { record, findings } = observe(index === -1 ? null : records[index], {
      ...observation,
      heartbeatPeriodSeconds: Number(period),
    });

    // Most recently active first, so the cap evicts whichever has been silent
    // longest — the same ordering the in-memory store keeps.
    if (index !== -1) records.splice(index, 1);
    records.unshift(record);
    records.length = Math.min(records.length, MAX_TRACKED_SUBSCRIPTIONS);

    // Read-modify-write, and the one place this store is weaker than the
    // in-memory one. See "The one race": the worst case is a lost increment on
    // a warning counter, never a corrupt record and never a wrong wire status.
    await this.redis.hset(key, { continuity: JSON.stringify(records) });
    return findings;
  }

  // updateExpectedPayloadContent and updateHeartbeatPeriod follow the same
  // shape: HSET the field, HINCRBY the version, and — for the period — clear
  // missedHeartbeats inside the continuity JSON, since those counts were
  // accumulated against the old period and mean nothing under a new one.
}

function newEndpoint(id: string): Endpoint {
  return {
    id,
    createdAt: new Date().toISOString(),
    validCount: 0,
    invalidCount: 0,
    notificationCounts: emptyNotificationCounts(),
    responseRules: defaultResponseRules(),
    expectedPayloadContent: null,
    heartbeatPeriodSeconds: DEFAULT_HEARTBEAT_PERIOD_SECONDS,
    continuity: [],
    version: 0,
  };
}

/** Flatten for storage: counters as their own fields, so HINCRBY can reach them. */
function toHash(endpoint: Endpoint): Record<string, string | number> { /* … */ }

/** And back. The inverse of toHash, and the only place field names are known. */
function fromHash(hash: Record<string, string>): Endpoint { /* … */ }
```

Selecting it stays a one-liner at the bottom of `store.ts`, and the `globalThis`
parking stays on the in-memory path where it belongs:

```ts
export const store: MessageStore = process.env.UPSTASH_REDIS_REST_URL
  ? new RedisStore()
  : (globalForStore.__notifyrStore ??= new InMemoryStore());
```

`Redis.fromEnv()` reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`,
which is also how a deployment declares "I have a shared store" — no separate
flag to drift out of step with reality. Local development keeps the in-memory
store and needs no credentials, so `npm run dev` and the test suite are
unaffected.

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

1. **`RedisStore` plus the config seam.** `tests/store.test.ts` asserts only
   interface behaviour, but it imports the `store` singleton, so pointing it at
   Redis means parameterising the suite over implementations — export a factory,
   run the same cases twice. That second run has to stay **opt-in**: the project
   guarantees tests need no network, and CI has no Redis.
2. **TTL, and the removal of `MAX_ENDPOINTS`** — one change, since the cap and
   the TTL are two answers to the same question.
3. **Rate limiting** (item 2) on the same connection.
4. Deploy, then items 4 and 5.

Steps 1 and 2 are the day; step 3 is an hour once the connection exists.

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

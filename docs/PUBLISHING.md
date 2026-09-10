# Before publishing publicly

**Status: item 1 is built; 2 is the next blocker.** Notifyr is correct and
pleasant to run locally; this is the list that separates that from an instance
strangers can point servers at.

Each item says what breaks without it, so the list can be argued with rather
than followed.

## The decision that shapes the rest — settled

In-memory storage does not work on serverless. Each Vercel instance has its own
module scope, so a notification handled by one is invisible to a dashboard poll
served by another, and everything is lost on cold start — see
[DESIGN.md](DESIGN.md#storage-and-the-swap-seam). A public instance on Vercel
today would randomly appear to forget traffic, which is the one failure a
debugging tool cannot have.

Two honest routes:

| | **A. Shared store** | **B. One always-on instance** |
| --- | --- | --- |
| What it means | Redis or Postgres behind `MessageStore` | A single process on a host that never sleeps |
| Code | A new `MessageStore` implementation. Every method is already async for exactly this reason; callers do not change | **None** |
| Effort | A day or so, plus a dependency and its credentials | An afternoon of deployment |
| Also unlocks | Rate limiting and endpoint expiry — items 2 and 3 — on the same dependency | Nothing further |
| Scales to | Many instances | One process; restarting it drops every endpoint |

**Decided: A, on Upstash Redis behind Vercel.** The full argument, the key
layout and a sketch of `RedisStore` are in
[REDIS-STORE.md](REDIS-STORE.md).

The earlier draft of this page picked B, on the assumption that a free
always-on host existed. Rechecked in September 2026, it mostly does not: Fly.io
withdrew its free allowances in 2024, and Render's free tier sleeps after 15
minutes without traffic, which would evaporate endpoints mid-session. Koyeb
(1-hour idle) and an Oracle Always Free VM survive as honest B options, but B
still leaves items 2 and 3 to write, while A brings both with it — a TTL *is*
endpoint expiry, and the same connection does rate limiting.

## Blocking

- [x] **1. Decide storage or host (above).** Decided and built: a shared store
      on Upstash Redis — `src/lib/redisStore.ts`, selected by `createStore()`
      when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set.
      Verified against a real Upstash database, end to end through the app.
      Design and caveats: [REDIS-STORE.md](REDIS-STORE.md).
- [ ] **2. Rate limiting.** There is none. The endpoint accepts 1 MB bodies,
      keeps 100 per endpoint across up to 500 endpoints, and creating endpoints
      is unauthenticated — so one loop turns the service into a memory
      exhaustion or a bill. This is the item I would least want to skip, and it
      is also the cheapest of the three: a per-IP and per-endpoint limit on
      `POST /hook/:id` and `POST /api/endpoints`. With the Redis store in
      place this is `INCR` plus `EXPIRE` on the connection that already
      exists — and it becomes *load-bearing*, because the 500-endpoint cap it
      used to share the job with goes away with the in-memory store.
- [x] **3. Endpoint expiry.** Done for a Redis deployment: every key carries a
      four-hour TTL (`NOTIFYR_ENDPOINT_TTL_SECONDS` to change it), refreshed
      on writes and on dashboard loads but *not* on the idle poll, so an
      endpoint expires four hours after both its traffic and its audience stop. This was
      always a retention question as much as a capacity one — stored headers
      include `x-forwarded-for`, which is personal data — and it is why the
      Redis store has no equivalent of the in-memory `MAX_ENDPOINTS` cap. The
      in-memory store keeps that cap, since nothing there ever forgets.

## Strongly recommended

- [ ] **4. `noindex` on `/dashboard/*` and `/hook/*`.** Anyone who links a
      dashboard hands a crawler a page of raw notification bodies and
      `Authorization` headers. A `robots` meta on those routes is minutes of
      work against a large downside.
- [ ] **5. Say the security posture on the dashboard, not only the home page.**
      The create card carries it now, which is most of the way there — but the
      moment someone is about to paste a dashboard link into Slack is the moment
      they should be reading "anyone with this URL can read everything sent
      here, credentials included".

## Worth doing, not blocking

- [x] **6. Show endpoint age and the memory caveat on the dashboard**
      ([UI-REVIEW #19](UI-REVIEW.md)). Done: the endpoint card carries "Created
      8s ago" and either a live countdown to expiry or, on the in-memory store,
      "Expires when the server restarts" — the caveat stated where the URL is
      handed out rather than in a footnote.
- [ ] **7. Band the list when polling has backed off**
      ([UI-REVIEW #20](UI-REVIEW.md)). A stale list currently looks live; the
      indicator says "Reconnecting…" but the rows do not.

## Deliberately not blocking

Dark mode, the R4 backport `Parameters` form, and the remaining UI polish. None
of them changes whether a public instance behaves correctly or safely — the
backport gap makes a class of server invisible, which matters enormously for the
tool's usefulness and not at all for its safety.

## What already holds up

Worth knowing so it is not re-litigated:

- **Payload and retention caps** — 1 MB per body, 100 messages per endpoint, 500
  endpoints with oldest-first eviction. Bounded memory by construction.
- **No outbound requests.** Notifyr never fetches a URL a caller supplies, so
  there is no SSRF surface.
- **Taken endpoint ids return 409** rather than joining the existing endpoint,
  so nobody reads a stranger's traffic by guessing a name.
- **The security posture is documented rather than accidental** — see
  [SECURITY.md](../SECURITY.md) and the README's limitations. No authentication,
  guessable chosen ids and headers shown in full are deliberate trade-offs for a
  debugging tool, not oversights.
- **CI runs lint, typecheck, tests and build on Node 20 and 22** for every push.

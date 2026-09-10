# Before publishing publicly

**Status: nothing here is done, and the first item is a decision rather than a
task.** Notifyr is correct and pleasant to run locally; this is the list that
separates that from an instance strangers can point servers at.

Each item says what breaks without it, so the list can be argued with rather
than followed.

## The decision that shapes the rest

In-memory storage does not work on serverless. Each Vercel instance has its own
module scope, so a notification handled by one is invisible to a dashboard poll
served by another, and everything is lost on cold start — see
[DESIGN.md](DESIGN.md#storage-and-the-swap-seam). A public instance on Vercel
today would randomly appear to forget traffic, which is the one failure a
debugging tool cannot have.

Two honest routes:

| | **A. Shared store** | **B. One always-on instance** |
| --- | --- | --- |
| What it means | Redis, Vercel KV or Postgres behind `MessageStore` | Deploy to Fly, Render or a VPS running a single process |
| Code | A new `MessageStore` implementation. Every method is already async for exactly this reason; callers do not change | **None** |
| Effort | A day or so, plus a dependency and its credentials | An afternoon of deployment |
| Also unlocks | SSE — the pub/sub needed for cross-instance visibility is the same thing SSE needs, so the polling loop could be replaced in the same change | Nothing further |
| Scales to | Many instances | One process; restarting it drops every endpoint |

**B is the cheaper honest answer** for a small public instance, and it keeps the
in-memory store's semantics exactly as they are documented. A goes further and
is the right long-term shape, but it is not a prerequisite for being *public* —
only for being *distributed*.

## Blocking

- [ ] **1. Decide storage or host (above).** Without it a public instance is
      wrong in a way users will read as data loss.
- [ ] **2. Rate limiting.** There is none. The endpoint accepts 1 MB bodies,
      keeps 100 per endpoint across up to 500 endpoints, and creating endpoints
      is unauthenticated — so one loop turns the service into a memory
      exhaustion or a bill. This is the item I would least want to skip, and it
      is also the cheapest of the three: a per-IP and per-endpoint limit on
      `POST /hook/:id` and `POST /api/endpoints`.
- [ ] **3. Endpoint expiry.** Abandoned endpoints hold their slot in the
      500-endpoint cap forever, and their stored traffic sits there
      indefinitely. That traffic includes `x-forwarded-for`, which is personal
      data, so this is a retention question as much as a capacity one. A TTL —
      say, an hour with no traffic — answers both.

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

- [ ] **6. Show endpoint age and the memory caveat on the dashboard**
      ([UI-REVIEW #19](UI-REVIEW.md)). `Endpoint.createdAt` is stored and never
      displayed. On a public instance whose data dies with the process, saying
      so where the data is shown is plain honesty.
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

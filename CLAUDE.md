# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev         # dev server on http://localhost:3000
npm test            # vitest, single run
npm run test:watch
npm run lint        # eslint flat config
npm run typecheck   # tsc --noEmit
npm run build       # next build
```

CI runs lint, typecheck, test and build on Node 20.x and 22.x. Run all four
before proposing a change is finished. Requires Node >= 20.9 (see `.nvmrc`).

Single test file / single test:

```bash
npx vitest run tests/subscription.test.ts
npx vitest run -t "heartbeat"
```

Tests need no dev server and no network — `tests/api.test.ts` imports the App
Router handlers directly and calls them with plain `Request` objects. Suites are
organised by concern (`validation`, `subscription`, `store`, `endpointId`,
`headers`, `responseRules`, `api`); add to the matching one rather than creating
a new file.

## Architecture

Notifyr is a Next.js 16 App Router app: a disposable webhook that receives FHIR
`Subscription` `rest-hook` notifications, validates them, and shows them live.

Request flow: a FHIR server POSTs to `src/app/hook/[endpointId]/route.ts` →
`lib/validation.ts` (which delegates notification Bundles to `lib/subscription.ts`)
→ `lib/responseRules.ts` decides the wire status → `lib/store.ts` records the
message and bumps `endpoint.version` → the dashboard's poll
(`src/hooks/useEndpointPoll.ts` → `api/endpoints/[id]/messages`) sees the new
version and re-renders.

Four constraints explain most of the code that otherwise looks odd:

- **The `fhir` npm package ships R4 conformance only, and `SubscriptionStatus`
  arrived in R4B.** Left alone the validator does not recognise the resource type
  at all, so every handshake and heartbeat would be invalid. `lib/subscription.ts`
  validates `SubscriptionStatus` entries itself and hands the rest of the Bundle
  to the library — keeping the entry and dropping only its `resource`, so entry
  indices in library messages still line up.
- **The store is in-memory and serverless has no shared module scope.**
  `MessageStore` is the swap seam: every method is async even though the
  in-memory implementation is synchronous, so a Redis/KV/Postgres implementation
  drops in without touching callers. The singleton is parked on `globalThis` so
  dev HMR does not reset it.
- **Polling, not SSE** — an SSE stream is pinned to one instance, which with the
  in-memory store only ever sees its own writes. `useEndpointPoll.ts` is the only
  file that changes when shared storage arrives. Its whole loop lives inside the
  effect so every piece of state is scoped to one `endpointId`; callers must
  remount with `key={endpointId}`.
- **The webhook reads `request.text()`, never `request.json()`.** An unparseable
  payload is exactly what the tool exists to capture, so the raw body is stored
  verbatim and never re-serialised.

Invariants worth preserving:

- **Counters are cumulative, not derived.** `validCount`, `invalidCount` and
  `notificationCounts` increment on write; deriving them from the retained list
  would make them decrease once retention trimming kicks in at 100 messages.
- **Only *valid* notifications are tallied by type** — an invalid Bundle has not
  established what kind of notification it was.
- **A response override changes only the wire status.** The message is still
  validated, stored and counted; `Message.statusOverridden` records that it
  happened. Valid override range is 201–599; 204/205/304 must return a bare
  `Response(null, …)` because `NextResponse.json()` throws on them.
- **Snapshots must not alias live store state** (`getSnapshot` deep-copies).
- **`null` means absent** across store methods rather than thrown errors.
- **Headers are stored verbatim, `Authorization` included** — flagged as
  sensitive for display only. An earlier redaction pass was reversed on purpose.
- **Endpoint ids** are the RFC 3986 unreserved set, ≤64 chars, because the id
  becomes a URL path segment. A taken id returns `409`; it never joins the
  existing endpoint.

Route handlers all set `runtime = "nodejs"` and `dynamic = "force-dynamic"` —
the in-memory store lives in module scope and must not be edge-run or statically
optimised. Public URLs are derived from the incoming request (`lib/url.ts`), not
configured.

`docs/DESIGN.md` is the authoritative "why" document, including the full
validation error/warning rules, the project layout, and known dependency
constraints (the bundled-lodash advisory in `fhir` cannot be fixed; TypeScript
and ESLint majors are pinned back by `eslint-config-next`). Read it before
changing validation, storage or the polling loop.

## Conventions

- Comments explain *why*, not *what* — most exist because the code looks wrong
  until you know a constraint. Match that bar.
- No formatter is configured; match surrounding style.
- Short imperative commit subjects with Conventional Commit prefixes
  (`fix: keep counters cumulative past the retention cap`).
- `AGENTS.md` is generated by `next dev` and committed on purpose; deleting it
  only recreates an uncommitted change.

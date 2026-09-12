# Design notes

Why Notifyr is built the way it is. The [README](../README.md) covers what it
does; this covers the decisions behind it, including the ones that look odd
until you know the constraint.

## Contents

- [Storage and the swap seam](#storage-and-the-swap-seam)
- [Real-time updates: polling, not SSE](#real-time-updates-polling-not-sse)
- [Validation pipeline](#validation-pipeline)
- [Subscription notifications](#subscription-notifications)
- [Response overrides](#response-overrides)
- [Expected payload content](#expected-payload-content)
- [Expected Subscription end](#expected-subscription-end)
- [Endpoint ids](#endpoint-ids)
- [The /metadata reachability probe](#the-metadata-reachability-probe)
- [Request headers](#request-headers)
- [Project layout](#project-layout)
- [Dependency notes](#dependency-notes)
- [Where help is most useful](#where-help-is-most-useful)

## Storage and the swap seam

`MessageStore` in `src/lib/store.ts` is the interface; `InMemoryStore` is the
only implementation today. **Every method is async even though the in-memory
implementation is synchronous**, so a Redis, Postgres or Vercel KV
implementation can replace it without touching a single caller.

The singleton is parked on `globalThis`. Without that, Next's dev HMR resets the
store on every file save, which makes testing maddening.

Two invariants worth preserving in any replacement:

- **Counters are cumulative, not derived.** `validCount`, `invalidCount` and
  `notificationCounts` increment on write. Deriving them from the retained
  message list would make them silently start *decreasing* once retention
  trimming kicks in at 100 messages.
- **Snapshots do not alias live state.** `getSnapshot` deep-copies the counts
  object, so a route handler cannot mutate the store by accident.

In-memory storage is genuinely broken on serverless — see the README's
limitations. This is the project's biggest gap.

## Real-time updates: polling, not SSE

The dashboard polls `/api/endpoints/:id/messages` every 2 seconds.

SSE looks like the better answer and is not, for one specific reason: **an SSE
stream is pinned to a single serverless instance**, and with the in-memory store
that instance only ever sees its own writes. A notification delivered to a
different instance would be invisible to the stream for its entire lifetime.
Polling re-rolls the instance every tick. Both are wrong without shared storage,
but SSE is wrong in a way that looks like a bug rather than a documented
limitation.

Secondary reasons: Vercel Hobby caps function duration at 60s, so a stream is
forced to reconnect on a timer anyway, and an open connection bills wall-clock
where a 2s poll bills a few milliseconds per tick.

**SSE becomes correct in the same change that introduces Redis/KV** — the
pub/sub needed for cross-instance visibility is exactly what SSE needs to
function. `src/hooks/useEndpointPoll.ts` is the only file that would change; the
dashboard just consumes its return value.

Polling is kept cheap and flicker-free:

- Each endpoint carries a `version` that increments on every write. The client
  sends it back as `?since=`, and an unchanged poll returns 29 bytes
  (`{"changed":false,"version":7}`). The client then skips the state update
  entirely, so **an idle dashboard performs zero re-renders** — not cheap ones,
  none.
- Polling pauses when the tab is hidden and fires immediately on focus.
- Failures back off exponentially, 2s to a 30s cap. A `404` stops polling
  outright, since a missing endpoint will not reappear.
- The loop uses recursive `setTimeout` with an `AbortController`, not
  `setInterval`, so a slow response cannot stack up overlapping requests.
- The whole loop lives inside the effect, so all its state is scoped to one
  `endpointId`. An earlier version hoisted it into a `useCallback` that
  referenced itself, which left a stale timer polling the previous endpoint
  after navigation. Callers must remount on a changed id (`key={endpointId}`).

Measured end-to-end: 5 notifications sent at irregular intervals were all
detected, worst-case lag 1.04s.

## Validation pipeline

`src/lib/validation.ts` runs three tiers, each gating the next, so a message is
only judged on rules it could plausibly satisfy.

1. **Body parses as JSON** — otherwise `400`.
2. **It is a JSON object with a `resourceType` string** — otherwise `422`.
3. **It passes the `fhir-tool` package's R4 structural and value-set validation** —
   otherwise `422`.

Tier 3 is best-effort: if the validator itself throws, the message stays valid
on tiers 1–2 and a warning is recorded, rather than blaming the sender for our
validator crashing.

The webhook reads `request.text()`, never `request.json()`. An unparseable
payload is precisely what this tool exists to capture — letting the framework's
JSON parser decide whether we record it would throw away the most interesting
failures. The raw body is stored exactly as received and never re-serialised.

## Subscription notifications

This is the part that needs the most explanation.

A rule-by-rule map of what is checked, what is only partly checked and what is
not built yet lives in [VALIDATION.md](VALIDATION.md).

The `fhir-tool` npm package ships **R4 conformance only**, and `SubscriptionStatus`
was introduced in **R4B**. Left to itself the validator does not merely
mis-grade a handshake — it does not recognise the resource type at all:

```
Resource does not have resourceType property, or value is not a valid resource type.
```

Every handshake and heartbeat would be marked invalid, which is exactly backwards
for a Subscription tester.

So `src/lib/subscription.ts` validates `SubscriptionStatus` entries itself
against the R4B/R5 definition, and hands the rest of the Bundle to the library
untouched. The mechanism matters: rather than deleting the entry, it keeps the
entry and drops only its `resource`. That preserves entry indices in library
messages, and a broken sibling resource in the same Bundle is still caught.

**Errors** (make the message invalid):

- `SubscriptionStatus.type` present and one of `handshake`, `heartbeat`,
  `event-notification`, `query-status`, `query-event`
- `subscription` present, carrying a reference
- `status` one of `requested`, `active`, `error`, `off`
- `topic` a string when present
- Every `notificationEvent` entry an object carrying an `eventNumber` (the only
  element R4B makes 1..1 there)
- An event-notification carrying at least one `notificationEvent` (invariant
  `sst-1`, which is a rule rather than a suggestion)
- `focus` and `additionalContext` References, and `error` CodeableConcepts,
  well-formed when present

**Warnings** (shown, still valid):

- `Bundle.type` other than `history`
- Missing `Bundle.timestamp`
- `SubscriptionStatus` not the first entry
- A `topic` that is not an absolute canonical URL
- A `notificationEvent.timestamp` without a timezone, or a `focus` that carries
  no reference
- An `error` carrying neither a coding nor text
- A `query-status` carrying event information, which the spec prohibits

A handshake or heartbeat carrying `notificationEvent` entries is **not**
flagged: R4B marks the element "Special" for those types - "A server MAY
include historical events for a client with a `heartbeat`, if any exist" - so a
server catching a client up after a reconnect is behaving correctly. An earlier
version warned about it, citing the page that permits it.

Every finding Notifyr raises itself carries the page that states the rule, in
`ValidationError.spec`, and the detail view renders it as a link beside the
message. The URLs live in one place, `src/lib/specs.ts`, which the References
list on the home page also reads — so a finding's citation and the published
reference list cannot drift apart. Findings from the `fhir-tool` package are left
uncited: they come from R4 conformance resources rather than from a page.

Citations are applied per block rather than per push — envelope rules, then
SubscriptionStatus rules, then payload rules — so a rule added later cannot
slip out uncited, and a test asserts every finding on a thoroughly broken
notification has one.

`eventsSinceSubscriptionStart` is accepted both as a string (R4B) and as a
number (R5).

Summaries are notification-aware, so the dashboard shows
`Handshake · Subscription/berkant-test` rather than `Bundle · history · 1 entry`.

`eventsSinceSubscriptionStart` and `topic` are lifted onto the message and shown
as their own columns in the notification list, so a heartbeat's event counter can
be watched climbing without opening each row. Both are null when the payload did
not carry them, and the column renders an em dash rather than a blank — "not
sent" and "sent as empty" should not look identical. `topic` is a canonical URL,
so the column shows its last segment with the full value as a tooltip.

### Per-type counters

`endpoint.notificationCounts` tallies notifications by type. **Only valid
notifications are counted** — a Bundle that failed validation has not
established what kind of notification it was, so it lands in `invalidCount` and
nowhere else. The tallies therefore always sum to at most `validCount`, and
usually less, since an ordinary `Patient` is valid but is not a notification.

Handshake, heartbeat and event-notification are always displayed, so a zero
heartbeat count reads as real information rather than a missing tile. The two
query types appear only once received.

### Not yet supported

The **R4 backport form**, where a notification carries a `Parameters` resource
profiled as `backport-subscription-status-r4` instead of a `SubscriptionStatus`.
R4 servers using the backport spec will have their notifications validated as a
plain `Parameters` resource and will not be counted by type.

The parameter names and the shape of the work are in
[VALIDATION.md](VALIDATION.md#3-the-r4-backport-parameters-form).

## Response overrides

Each endpoint carries a `ResponseRules` map — one `{ enabled, status }` per
overridable notification type. While a type is disabled the webhook answers its
`status` instead of the status validation produced.

Three decisions worth keeping:

- **An override changes only the wire status.** The notification is still
  validated, stored, counted by type and shown. Suppressing it would defeat the
  purpose: you switch handshakes off precisely so you can watch the server retry
  the handshake you can see arriving.
- **`Message.statusOverridden` records that it happened.** Without it a forced
  `400` sitting next to a green "Valid" badge reads as a bug in Notifyr.
- **The status range is 201-599, not "any number".** The Fetch `Response`
  constructor throws a `RangeError` outside 200-599, so an unvalidated value
  would become a 500 at response time rather than a clear message at the point
  of entry. 200 is excluded because it is what "switched on" already means.

`204`, `205` and `304` additionally forbid a body — `NextResponse.json()` throws
`Invalid response status code` on them — so the route returns a bare
`new Response(null, { status })` for those. They are legitimate things to test a
receiver with, so they are allowed rather than blocked.

Changing a rule bumps the endpoint `version`, so a dashboard open in another tab
picks the change up on its next poll rather than showing stale switches.

The overridable set is deliberately its own constant rather than reusing
`PRIMARY_NOTIFICATION_TYPES`. They happen to hold the same three types today,
but they answer different questions — "which counters are always visible" and
"which responses can be forced" — and should be free to diverge.

## Expected payload content

`backport-payload-content` is configured on the Subscription, and a receiver
never sees the Subscription — so Notifyr cannot know whether the notification in
front of it was supposed to carry resources at all. The dashboard has a select
for it, and the endpoint remembers the answer.

Four decisions worth keeping:

- **A mismatch is a warning, never an error.** It means the sender and the
  dropdown disagree, which is as often a mistyped expectation as a server bug.
  Grading it invalid would push a well-formed notification out of the per-type
  counters over a UI mistake.
- **Unset still checks something.** With no expectation the Bundle is asked
  whether it matches *any* of the three levels. One carrying resource content
  while naming no focus resources matches none of them, whatever was
  configured — and that check needs no configuration at all, so it runs for
  everyone.
- **The expectation applies from the moment it is set.** Validation runs once,
  at receive time; `Message.isValid` and the counters are written then and a
  stored message is never re-validated. So `Message.expectedPayloadContent`
  records what each notification was actually judged against, for exactly the
  reason `statusOverridden` exists: otherwise a row warning about
  `full-resource` under a dropdown now reading `id-only` looks like a bug here.
- **Only event-notifications are checked.** A handshake or heartbeat carries no
  resources whatever the Subscription was set to, so applying payload rules to
  them would report every heartbeat as failing `id-only`.

The rules themselves are in `src/lib/payload.ts`, quoted from
[payloads.html](https://hl7.org/fhir/uv/subscriptions-backport/payloads.html)
and tabulated in [VALIDATION.md](VALIDATION.md#4-payload-content-conformance).

## Expected Subscription end

`Subscription.end` is the instant a subscription is meant to be finished with.
Like the payload level and the heartbeat period it lives on the Subscription,
which a receiver never sees, so the dashboard takes it as a setting and the
endpoint remembers it. Empty switches the check off; there is no default,
because there is no conventional value to assume and guessing one would report
every notification on an unconfigured endpoint as late.

Anything arriving afterwards gets a warning naming the deadline and how far past
it the notification came, and the endpoint keeps a cumulative `afterEndCount`.

Four decisions worth keeping:

- **No tolerance, unlike the heartbeat check.** A heartbeat gets 1.5x its period
  because scheduler jitter makes an exact comparison fire constantly on a
  healthy server. The end is a single instant the server agreed to honour, and
  the question is a yes/no one — "is anything still arriving?" — so a grace
  window would answer a different question than the one being asked.
- **Every message is checked, valid or not.** Continuity needs a notification
  that validated, because a gap is measured from a counter inside the body. This
  is measured from the clock, which is known whatever the body turned out to be,
  and an unparseable POST an hour past the end is still a server that has not
  stopped.
- **A warning, never an error**, for the same reason as a payload mismatch: this
  is the sender's timing against a value the user typed, and grading it invalid
  would drop the notification out of the very tallies being watched.
- **The count is cumulative and the deadline is not retroactive.** `afterEndCount`
  increments on write like every other counter here, so "did anything arrive
  late?" keeps answering yes after the messages that proved it have been trimmed
  past the 100-message cap. Correspondingly, changing or clearing the deadline
  clears nothing — those notifications did arrive under the deadline in force at
  the time — and it does not re-grade stored messages, which are never
  re-validated. `Message.afterExpectedEnd` records the verdict each one was
  given, for the same reason `Message.expectedPayloadContent` does.

The comparison lives in `src/lib/expiry.ts`, in one place: the boolean the store
counts from and the warning the user reads cannot disagree about whether a given
notification was late.

One wrinkle is in the UI rather than the rules. The card uses a
`datetime-local` input, which carries no timezone — the browser reads it as
local wall time. That is right for "stop about ten minutes from now" and wrong
for anyone holding an exact instant from their Subscription, so the value is
resolved to an instant in the browser, stored normalised to UTC, and echoed back
under the field where a mismatched offset is visible before it produces a run of
confusing warnings.

## Endpoint ids

An id may be chosen or left blank for a random UUID. Chosen ids are taken
verbatim, case preserved, surrounding whitespace trimmed.

Because the id becomes a URL path segment, it cannot be *literally* any string:
a `/` would split the route, and a space or `?` would need percent-encoding,
handing the user a URL that does not look like what they typed. Accepted
characters are the RFC 3986 unreserved set — letters, digits and `- . _ ~`, up
to 64 characters — which survive a URL round trip untouched. `.` and `..` are
additionally rejected.

**A taken id returns `409`; it does not join the existing endpoint.** Silently
handing back someone else's endpoint would let anyone read a stranger's traffic
by guessing its name. The `409` body includes `existingDashboard` so the UI can
offer a link, and viewing an existing dashboard directly still works.

## The /metadata reachability probe

`hook/[endpointId]/route.ts` used to be a single dynamic segment, so a request
for anything past the endpoint id 404'd at the Next.js routing layer before
Notifyr's own code ever ran. That broke registering a Subscription against
`hapi.fhir.org`: its public test server optionally runs
`SubscriptionRulesInterceptor`, which — once, when a `rest-hook` Subscription
is created — does `GET {endpointUrl}/metadata` and rejects the Subscription
outright (`HAPI-2671: REST HOOK endpoint is not reachable`) if that does not
parse as a `CapabilityStatement`. A 404 HTML page does not, so every
Subscription pointed at Notifyr failed before a single notification was
attempted. This is not universal HAPI behaviour — the check is opt-in, and
`hapi-fhir-jpaserver-starter` does not enable it — but the public test server
is exactly where someone without their own FHIR server reaches for first.

The fix is `hook/[endpointId]/[[...path]]/route.ts`, an **optional catch-all**:
the bare webhook URL still matches with no subpath, and anything longer is
routed rather than 404'd. Three things follow from that:

- **`.../metadata` is answered, not captured.** `lib/capabilityStatement.ts`
  returns a static, minimal `CapabilityStatement` — `200`,
  `application/fhir+json`, no message stored, no counter touched. It is
  Notifyr's own plumbing answering a client library's precondition, not
  something the user is testing, so it does not appear in the notification
  list.
- **The statement is honest about scope.** No `rest[].resource` entries
  claiming `read` or `search` — Notifyr does not implement the FHIR REST API,
  and claiming otherwise would be a false conformance statement from a tool
  whose whole premise is telling the truth about what arrived. A
  `documentation` string says the real thing instead.
- **Every other subpath is captured like the base URL**, with the path
  attached (`Message.requestPath`, shown in the list and the detail view). A
  client hitting an unexpected tail is not a browser visit — nobody hand-types
  a random path onto a webhook URL — so unlike a bare `GET` on the base URL
  (still answered with a reminder rather than stored), an unexpected subpath
  is exactly the kind of thing this tool exists to surface.

`fhirVersion` in the statement is `4.0.1` rather than R4B or R5: nothing
observed cross-checks it against the Subscription actually under test, so the
widest common denominator is the safer default across whatever FHIR version
context makes the request.

## Request headers

Headers are stored verbatim, `Authorization` included. Checking that a FHIR
server actually sent the credential you configured is a core reason to inspect a
webhook — a masked value cannot tell you whether the token is the one you
expected, so nothing is altered on the way in.

Headers that usually carry a credential are *flagged* rather than changed, and
the detail view labels them. That is a labelling aid, not a protection: anyone
who knows an endpoint id can read these values, through the dashboard or the
API.

An earlier version redacted them at capture time. That was reversed
deliberately: a UI-only mask would have been theatre, since the value sits in
the API response either way, and dropping the value made the tool unable to
answer its own question.

Flagged: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
`x-api-key`, `api-key`, `x-auth-token`, `x-access-token`, `x-csrf-token`.

### Proxy headers are folded away, not dropped

A second flag, `platform`, marks headers added by whatever sits in front of
Notifyr rather than by the FHIR server: `x-vercel-*`, `x-forwarded-*`, `cf-*`,
`x-amzn-*`, `x-real-ip`, `via`. On a deployed instance they outnumber the
headers the sender actually set and bury the handful that answer the question
this tool exists for, so the detail view collapses them behind a disclosure.

They are classified, not discarded, for the same reason credentials are not
redacted: `x-forwarded-for` names the machine that actually called, and when the
answer is "not the one I expected" that is the whole debugging session. Dropping
them at capture would take that away to save a click.

## Project layout

```
.github/workflows/ci.yml                 Lint, typecheck, test, build on push and PR
.github/dependabot.yml                   Weekly npm + github-actions updates, grouped
eslint.config.mjs                        Flat config: next/core-web-vitals + next/typescript
vitest.config.ts                         Test runner config ("@/" alias mirrors tsconfig)
docs/DESIGN.md                           This file
docs/VALIDATION.md                       Validation scope: rule-by-rule coverage vs the IG
docs/PUBLISHING.md                       What a public instance needs first
tests/                                   validation / subscription / store / endpointId / headers / api
src/
  app/
    layout.tsx                           Shell: header, footer, global styles
    page.tsx                             Home — create endpoint, docs, walkthrough
    globals.css                          Tailwind entry
    api/endpoints/route.ts               POST — create endpoint
    api/endpoints/[endpointId]/messages/route.ts   GET — poll for counters + messages
    hook/[endpointId]/[[...path]]/route.ts   POST/GET — webhook receiver + /metadata probe
    dashboard/[endpointId]/page.tsx      Dashboard route (server, awaits params)
  components/
    DashboardView.tsx                    Dashboard client shell: layout + state
    LiveIndicator.tsx                    Connection status dot
    EndpointCard.tsx                     Webhook URL, copy, lifetime, live status, refresh
    MessageList.tsx                      Recent notifications, newest first
    MessageDetailModal.tsx               Raw body, headers, validation results
    NotificationCounters.tsx             Per-type notification tallies
    ResponseRulesCard.tsx                Per-type response override switches
    ExpectationsCard.tsx                 Expected payload level, heartbeat period, Subscription.end
    ExpectedResourceCountsCard.tsx       Expected notification counts per FHIR resource type
    CodeBlock.tsx                        Dark code block with a copy button
    FhirCandleGuide.tsx                  End-to-end walkthrough, shown in-app
    ValidationExplainer.tsx              How the validation tiers work
    References.tsx                       Links to the specs we validate against
    CopyButton.tsx                       Copy-to-clipboard
  hooks/
    useEndpointPoll.ts                   Polling loop (the SSE swap seam)
  lib/
    types.ts                             Endpoint, Message, EndpointSnapshot
    endpointId.ts                        Endpoint id rules and generation
    responseRules.ts                     Response override validation
    payload.ts                           Payload content conformance rules
    continuity.ts                        Event gaps and heartbeat liveness
    expiry.ts                            Arrivals after the expected Subscription.end
    headers.ts                           Header capture, credential flagging
    store.ts                             MessageStore interface + in-memory impl
    redisStore.ts                        Shared-store implementation, for deployments with credentials
    validation.ts                        Three-tier validation pipeline
    specs.ts                             Spec URLs cited by validation findings
    subscription.ts                      SubscriptionStatus / notification Bundles
    capabilityStatement.ts               Static CapabilityStatement for the /metadata probe
    url.ts                               Deriving the public webhook URL
```

`AGENTS.md` and `CLAUDE.md` are generated by `next dev` and committed on
purpose; deleting them only recreates an uncommitted change.

## Dependency notes

### `fhir` was renamed to `fhir-tool`, dropping the bundled lodash

The FHIR validation library (the same `lantanagroup/FHIR.js` project) was
renamed from `fhir` to `fhir-tool` on npm. Notifyr depends on `fhir-tool` for
that reason, not for new functionality — `fhir.js` (the file exporting the
`Fhir` class Notifyr uses) is byte-identical between the two packages, same
`validate()` signature and exports.

The rename matters because the old `fhir` package bundled lodash 4.17.21
**inside its own tarball**, which `npm audit` flagged as two advisories (one
high, one moderate). Being bundled meant npm `overrides` couldn't reach it and
Dependabot couldn't fix it either. `fhir-tool@5.x` ships without the bundled
lodash at all — its only dependency is `xml-js` — so the advisories are gone,
not just hidden.

### TypeScript and ESLint major bumps are ignored

`.github/dependabot.yml` ignores majors for both `typescript` and `eslint`.
Minor and patch updates still flow normally; only the major is held back.

TypeScript 7 (the native port) breaks `npm run lint` because the
`typescript-eslint` bundled inside `eslint-config-next` refuses to load against
it — `typescript-eslint does not support TS 7.0`. `tsc --noEmit`, vitest and
`next build` all pass on TS 7; only linting is blocked, and the blocker is
upstream ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).

ESLint 10 fails for the same class of reason — `eslint-plugin-react`, also
bundled by `eslint-config-next`, still calls `context.getFilename()`, removed in
ESLint 10, so the run dies loading `react/display-name`. The plugin's own peer
range stops at `^9.7`, so no version inside the `^7.37.0` that
`eslint-config-next` asks for can satisfy ESLint 10.

Both are the same underlying problem: **`eslint-config-next` bundles plugins
that lag the tooling.** Neither has a workaround in this repo — the offending
plugins are transitive dependencies of a config we do not control, and pinning
around them would mean dropping lint coverage. Drop the matching ignore entry
once upstream support lands.

## Where help is most useful

In rough order of value:

1. **A shared storage backend** (Redis, Vercel KV, Postgres) behind
   `MessageStore`. This is the change that makes a real deployment work, and it
   unlocks SSE at the same time.
2. **R4 backport notification support** — the `Parameters` form described above.
   Contained to `src/lib/subscription.ts` and its tests.
3. **Rate limiting per endpoint.** There is none today.
4. **Endpoint expiry**, so abandoned endpoints do not occupy the 500-endpoint
   cap indefinitely.
5. **Accessibility and dark mode.** The UI is light-only and has had no
   screen-reader pass.

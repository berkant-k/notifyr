# Stream continuity

**Status: implemented.** Covers both cross-notification checks in
[VALIDATION.md](VALIDATION.md#5-cross-notification-checks): **event gaps** and
**heartbeat liveness**.

The rules live in `src/lib/continuity.ts` (pure: timestamps and counts in,
findings out), the state in the store's per-endpoint tracker, and the wiring in
the webhook route — which is where it has to be, since a gap is only visible
against what came before and `validateBody` sees one body at a time.

Everything Notifyr checks today is triggered by a request arriving and judges
the bytes in that request. Both checks here are about **what did not arrive** —
which the existing pipeline cannot express, because nothing fires.

## Why these are one design and not two

They were specified separately and share almost everything that matters:

- **The same signal source.** `eventsSinceSubscriptionStart` rides on *every*
  notification type, heartbeats included. So a heartbeat's event counter jumping
  from 7 to 11 tells you three event-notifications were lost — the heartbeat
  stream is how you detect missing *events*. The two checks read the same
  messages at the same moment.
- **The same tracking record**, updated at the same point in the webhook route.
- **The same lifecycle**: forward-only, never re-grading stored messages, reset
  when the thing they are measured against changes.
- **The same output shape**: a warning on the arriving message, a cumulative
  counter, and a detail panel.

And decisively:

- **Both are per-subscription.** See below — this is the finding that makes
  combining them not just tidy but necessary.

Where they genuinely differ, the design keeps them apart rather than forcing a
false symmetry:

| | Event gaps | Heartbeat liveness |
| --- | --- | --- |
| Configuration | **None.** The sender supplies the sequence | The user must supply the period; Notifyr cannot know it |
| Certainty | **Exact.** 7 → 11 is three missing, full stop | Heuristic. 190s against a 120s period is a judgement call needing tolerance |
| Detectable while silent | **No.** A gap is only visible when a later notification reveals it | **Yes** — that is the whole point of a heartbeat |
| Needs a live gauge | No | Yes, and it brings the one architectural wrinkle |

## The finding: per-subscription keying is not optional

One endpoint can legitimately receive notifications from **several
Subscriptions**. For heartbeat liveness, conflating them is merely blurry — two
subscriptions at 120s look like one at 60s, so lateness is under-reported.

For event gaps, conflating them produces **garbage**. `eventsSinceSubscriptionStart`
counts events *for its own subscription*. Interleave subscription A (at 5) and
subscription B (at 100) and the observed sequence reads 5, 100, 6, 101 — which a
naive tracker reports as a 95-event gap, then a 94-event reset, then another gap,
forever, on a system where nothing is wrong.

So the tracker is keyed by **`SubscriptionStatus.subscription.reference`**, which
is already required, already validated and already stored on every notification.
This answers open question 3 from the earlier heartbeat-only draft: not "ship the
limitation and revisit", but "key it correctly from the start", because the
second check makes the shortcut actively wrong rather than approximate.

## The shared tracker

Per endpoint, a map from subscription reference to:

```
lastHeartbeatAt     ISO 8601, or null      — last *valid* heartbeat
lastEventCount      integer, or null       — last eventsSinceSubscriptionStart seen
missedHeartbeats    integer, cumulative
missedEvents        integer, cumulative
```

Bounded like everything else in the store: cap the map (say 20 subscriptions per
endpoint, oldest evicted), so a stray endpoint receiving traffic from many
subscriptions cannot grow without limit.

## Check 1 — event gaps (no configuration)

Runs for **every endpoint immediately**, with nothing to switch on.

On a valid notification carrying a numeric `eventsSinceSubscriptionStart`:

- **Gap:** the value exceeds `lastEventCount + 1` → warning on the arriving
  message, and the difference added to `missedEvents`.
  > `Event counter jumped from 7 to 11; 3 notifications appear to have been
  > missed.`
- **Same or +1:** normal, no finding.
- **Lower than `lastEventCount`:** treated as a **subscription restart**, not a
  gap — the counter resets when a Subscription is recreated. Record an `info`,
  reset `missedEvents` for that reference, and count nothing as missed: reading
  3 → 1 as two lost notifications would invent a loss every time someone
  recreated a Subscription.

  The restart is also **counted** (`restarts`, `lastRestartAt`) and shown in the
  continuity panel, because the pattern is the signal: one restart is a
  Subscription being recreated, and five in an hour is a server restarting one
  nobody asked it to. A per-message `info` can never show that.
- **Non-numeric:** skipped entirely. The validator already warns about the value;
  refusing to also invent a gap from it keeps one problem to one message.
- **Invalid notification:** does not update the tracker, matching how the
  per-type counters already treat a Bundle that failed validation.

`notificationEvent.eventNumber` is a second, finer signal — event numbers inside
an event-notification should continue from the last one seen. Proposed for a
later pass, not this one: the running total catches the same losses and needs no
per-event bookkeeping.

## Check 2 — heartbeat liveness (configured)

`heartbeatPeriodSeconds` on the endpoint, alongside `expectedPayloadContent`:

- **Defaults to 120 seconds**, which is what the backport IG's example and this
  app's walkthrough both configure — so an endpoint created by following the
  guide is checked correctly without touching the setting. A server on a
  different period reports late heartbeats until the number is corrected, which
  is the intended prompt to correct it.
- **0 means off** — nothing tracked, no counter, no warning.
- Otherwise **5 to 86400**. A floor because a 1–2s period is noise against a 2s
  poll; a ceiling of a day because a longer heartbeat is not a liveness check.
- A number input in the dashboard rail, and `PUT /api/endpoints/:id/heartbeat-period`.

**Late arrival.** When a heartbeat arrives, compare `receivedAt` to
`lastHeartbeatAt` for that subscription. Past the tolerance, warn on the
arriving message and add `floor(gap / period) - 1` to `missedHeartbeats`:

> `Heartbeat arrived 412s after the previous one; the configured period is 120s
> (about 2 missed).`

(Heartbeats were due at 120, 240 and 360; one arrived, so `floor(412/120) - 1`
never did.)

- **Tolerance is `period × 1.5`, floor `period + 5s`.** A server firing "every
  120 seconds" will not fire at 120.000s — scheduler granularity, delivery time
  and retries all add jitter, and a check that flags 121s gets switched off
  within a minute of being switched on.
- **Warning, never error.** Lateness is the sender's timing against a number the
  user typed, not a malformed notification — and grading it invalid would drop
  the heartbeat out of the tally being watched.
- **The first heartbeat is never late.** Nothing to measure from. The handshake
  is deliberately not the start point: the IG does not fix the delay between
  activation and the first heartbeat.

**Overdue now.** Derived at read time from `lastHeartbeatAt` and the clock — a
gauge, not a tally. It is the only thing that notices a server that has stopped
sending entirely, since nothing arrives to trigger the check above.

### The polling wrinkle

`overdueBy` changes with wall-clock time while **nothing on the server changes**.
The dashboard polls with `?since=<version>` and an unchanged endpoint answers
`{"changed":false}` — so a server-derived overdue value would never reach an idle
dashboard, which is exactly the dashboard that needs it.

**Proposal: carry `lastHeartbeatAt` and the period on the unchanged response**
(a few bytes on a 29-byte reply) and derive `overdueBy` client-side per poll. No
new timer, and the client re-renders only when the derived number changes — an
endpoint that is not overdue still re-renders zero times, preserving the
guarantee in [DESIGN.md](DESIGN.md#real-time-updates-polling-not-sse).

The alternatives are a 1s client interval (re-renders an idle dashboard forever)
or bumping `version` server-side when lateness is noticed (impossible without
something running between requests).

Event gaps need none of this: with no live gauge, they ride the existing
version-bump on write.

## UI

**Input.** A number field in the rail beside *Expected payload*, holding its
value locally while typing so a poll landing mid-edit cannot yank it — the same
pattern as the response-override status box.

**Counters.** Both misses are absences, derived from configuration or sequence,
and neither is a notification type. Putting them in the per-type row would
repeat the mistake we just corrected on the filter chips, where `Heartbeat 0` sat
under `Heartbeat 3` meaning something else entirely. So:

- `2 missed` as a **subtitle on the Heartbeat tile**.
- `3 missed` as a **subtitle on the Event notification tile**.

Each tile becomes clickable, opening one panel under the counters:

```
Subscription/notifyr-test        expected every 120s
Last heartbeat    10:42:07  (3m 12s ago) — overdue by 72s
Missed heartbeats 2
Event counter     11        3 missed
```

With more than one subscription, one block each. With no period set, the
heartbeat rows say so rather than showing zeroes that look like facts.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Period set, no heartbeat yet | "Waiting for the first heartbeat." No warning, no count |
| Period set to 0 while overdue | Tracking stops, heartbeat rows disappear; event gaps continue |
| Period changed | `missedHeartbeats` resets, `lastHeartbeatAt` kept |
| Event counter goes backwards | Subscription restart: reset that reference, `info`, count nothing |
| Event counter non-numeric | Skipped; the existing value warning stands alone |
| Invalid notification | Updates nothing — it has not established what it was |
| Notification with no `subscription.reference` | Cannot be tracked; it already fails validation for that reason |
| Server restart | In memory; endpoint and tracking die together |
| Retention trimming | Irrelevant — the tracker is not derived from the retained list |

## Suggested staging

1. **Event gaps first.** No UI input, no configuration, no polling wrinkle — it
   works for every existing endpoint the moment it ships, and it exercises the
   per-subscription tracker that the second half depends on.
2. **Heartbeat liveness second:** the period setting, its route, the rail input,
   the late-arrival warning and the overdue gauge.
3. **The panel** covering both, once there are two things to show in it.

This inverts the order you asked for, and the reason is the tracker: building it
under the check that needs no configuration means the harder half inherits
something already proven. Happy to do it the other way if you would rather see
the heartbeat feature land first.

## Test plan

All unit-testable with injected timestamps and counts — no waiting, no timers:

- **Event gaps:** contiguous → silent; +4 → warning naming both values, 3
  counted; backwards → reset, info, nothing counted; non-numeric → skipped;
  invalid message → tracker untouched; two subscriptions interleaved → **no
  phantom gaps** (the regression guard for the finding above)
- **Heartbeat:** gap under tolerance → silent; over → warning with gap and
  period; exactly `period × 1.5` → boundary; multi-period gap → count; first
  heartbeat → never late; period 0 → nothing; period changed → count resets,
  timestamp survives
- **Route:** rejects a period below 5 or above 86400, accepts 0
- **Store:** tracker keyed by reference, capped, evicts oldest
- **Derivation:** `overdueBy` exact at the boundary, absent with no heartbeat

## Rough size

Larger than the payload-content work, mostly because of the per-subscription map
and the panel: `types.ts`, `store.ts` (the tracker plus two setters), one route,
the webhook route, a continuity module with its own test suite, the rail input,
and the counter subtitles plus panel. Staged as above, step 1 is roughly half a
day and ships value on its own.

## Decisions taken

1. **Tolerance is an invisible constant** (`period × 1.5`, floor `period + 5s`),
   as agreed — no second input.
2. **Both checks shipped together**, rather than event gaps first as suggested
   above: they share the tracker and the same update point in the webhook route,
   so splitting them would have meant writing that twice.
3. **`missedHeartbeats` resets when the period changes**, timestamps and event
   counts survive.
4. **The panel shows one block per subscription**, keyed by reference.

## Still open

- **`notificationEvent.eventNumber`** as a finer signal than the running total.
  The total catches the same losses; per-event numbering would say precisely
  which events were lost.
- **Nothing announces an overdue heartbeat when the tab is hidden.** Polling
  pauses on hide, so the gauge resumes rather than accrues. Fine for a debugging
  tool watched live; worth revisiting if anyone leaves it running overnight.

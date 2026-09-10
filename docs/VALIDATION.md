# Validation scope

What Notifyr checks in a received notification, what it deliberately does not,
and what is simply not built yet.

Every rule below is traced to the [Subscriptions R5 Backport
IG](https://hl7.org/fhir/uv/subscriptions-backport/) or to the R4B/R5
`SubscriptionStatus` definition. [DESIGN.md](DESIGN.md#validation-pipeline)
covers *how* validation runs; this file covers *what it covers*.

## Contents

- [How to read this](#how-to-read-this)
- [1. Notification Bundle envelope](#1-notification-bundle-envelope)
- [2. SubscriptionStatus content (R4B/R5)](#2-subscriptionstatus-content-r4br5)
- [3. The R4 backport Parameters form](#3-the-r4-backport-parameters-form)
- [4. Payload content conformance](#4-payload-content-conformance)
- [5. Cross-notification checks](#5-cross-notification-checks)
- [6. Terminology](#6-terminology)
- [7. Out of scope: server-side artifacts](#7-out-of-scope-server-side-artifacts)
- [Roadmap](#roadmap)

## How to read this

**Status** is one of:

- **Done** — implemented and covered by a test.
- **Partial** — implemented, but not to the full strength of the rule; the
  shortfall is stated.
- **Not yet** — recognised, not built. These are the contribution targets.
- **Won't** — deliberately out of scope, with the reason.

**Severity** is what Notifyr does when the rule is broken: an `error` makes the
message invalid, a `warning` is shown but the message still counts as valid.

Every finding Notifyr raises itself also cites the page stating the rule — the
**Source** links below are the same URLs, held in `src/lib/specs.ts` — and the
detail view renders that citation beside the message. Findings from the `fhir`
package carry no citation, since they come from R4 conformance resources rather
than from a page.

### Severity is not conformance

Notifyr is a receiver, not a conformance suite. A notification whose
`SubscriptionStatus` sits second in the Bundle violates a `SHALL`, but it is
still a perfectly readable handshake — and marking it invalid would drop it out
of the per-type counters entirely, since only valid notifications are tallied
(see [DESIGN.md](DESIGN.md#per-type-counters)). So rules that stop Notifyr from
*understanding* the notification are errors, and rules the sender merely got
wrong are warnings.

## 1. Notification Bundle envelope

Sources: [notifications.html](https://hl7.org/fhir/uv/subscriptions-backport/notifications.html),
profile `http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-subscription-notification`
(R4B) and `.../backport-subscription-notification-r4` (R4).

| Rule | Severity | Status |
| --- | --- | --- |
| "all notifications are enclosed in a Bundle with the `type` of `history`" | warning | **Done** |
| "the first `entry` of the bundle SHALL be the `SubscriptionStatus` information" (invariant `backport-notification-bundle-1`) | warning | **Done** — warning rather than error, per [above](#severity-is-not-conformance) |
| `Bundle.timestamp` carried on a notification | warning | **Done** |
| `Bundle.entry` is 1..\* | — | **Partial** — implied only: with no entries there is no `SubscriptionStatus`, so the body is never recognised as a notification and falls through to ordinary resource validation |
| Invariants `bdl-3`/`bdl-4`: a history Bundle "require[s] a `Bundle.entry.request` element for *every* `Bundle.entry`" | — | **Not yet** — the `fhir` package validates structure and value sets, not invariants, so nothing checks this today |
| The status entry's "request SHALL be filled out to match a request to the `$status` operation" | — | **Not yet** |
| Other entries' request "SHOULD be filled out in a way that makes sense given the subscription" | — | **Not yet** |
| Non-`SubscriptionStatus` entries pass R4 structural and value-set validation | error | **Done** — the entry is kept and only its `resource` dropped, so sibling resources are still validated and entry indices still line up |

## 2. SubscriptionStatus content (R4B/R5)

Implemented in `src/lib/subscription.ts`, because the `fhir` package ships R4
conformance only and does not recognise the resource type at all. See
[DESIGN.md](DESIGN.md#subscription-notifications).

| Element | Definition | Severity | Status |
| --- | --- | --- | --- |
| `type` | 1..1, bound to SubscriptionNotificationType | error | **Done** — required, and rejected when outside the value set |
| `subscription` | 1..1 Reference(Subscription) | error | **Done** — required, and must carry a `reference` |
| `status` | **0..1**, bound to SubscriptionStatusCodes | error | **Done** — R4B makes it optional, so its absence is legal and only the value is checked. Only the R4 backport Parameters profile raises it to 1..1, which belongs with [section 3](#3-the-r4-backport-parameters-form) |
| `topic` | 0..1 canonical | error | **Done** — must be a string, and warns when it is not an absolute URI (a scheme is required, so `urn:uuid:…` passes and `SubscriptionTopic/x` does not) |
| `eventsSinceSubscriptionStart` | 0..1, string in R4B, integer64 in R5 | warning | **Done** — both forms accepted, normalised to a string, warned about when non-numeric |
| `notificationEvent` | 0..\* | error | **Done** — must be an array, and every entry must be an object |
| `notificationEvent` on a handshake or heartbeat | **"Special"** - "A server MAY include historical events for a client with a `heartbeat`, if any exist" | - | **Done, by not checking it.** An earlier version warned here; the spec explicitly permits it, so the warning was a false positive against a server catching a client up after a reconnect |
| `notificationEvent` on a query-status | **"Prohibited"** - "A `query-status` notification SHALL NOT contain any event information" | warning | **Done** |
| `notificationEvent` on an event-notification | invariant **`sst-1`**, a *rule*: `type = 'event-notification' implies (notificationEvent.exists() and notificationEvent.first().exists())` | error | **Done** — absent and empty are both violations, as `exists()` requires |
| `notificationEvent.eventNumber` | **1..1** | error | **Done** — required on every event, located by index; accepted as an R4B string or an R5 number, with a warning when the value is not a whole number |
| `notificationEvent.timestamp` | 0..1 instant | warning | **Done** — a timezone is required, so a bare local time is flagged |
| `notificationEvent.focus` | 0..1 Reference | error | **Done** — must be a Reference object; warns when it carries no `reference`, since naming the changed resource is the element's whole job |
| `notificationEvent.additionalContext` | 0..\* Reference | error | **Done** — must be an array, each entry checked as a Reference |
| `error` | 0..\* CodeableConcept | error | **Partial** — the shape is validated (array of CodeableConcepts, `coding` an array of objects, a warning when an entry carries neither `coding` nor `text`); codes are not checked against the value set, which is extensible, and the element is **not yet surfaced in the UI** |

Two fields are additionally lifted onto the message and shown as their own
columns: `eventsSinceSubscriptionStart` and `topic`.

## 3. The R4 backport Parameters form

Profile: `http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-subscription-status-r4`

**Status: Not yet.** This is the project's largest validation gap.

An R4 server cannot send a `SubscriptionStatus` — the resource did not exist
until R4B — so it sends a **`Parameters`** resource profiled as
`backport-subscription-status-r4` instead. Notifyr detects notifications by
looking for an entry whose `resource.resourceType` is `SubscriptionStatus`
(`inspectNotificationBundle`), so an R4 notification is not recognised as one at
all: it is validated as a plain `Parameters` resource, summarised as an ordinary
Bundle, and never counted by type.

The parameters carry the same information under different names:

| Parameter | Cardinality | Type | R4B/R5 equivalent |
| --- | --- | --- | --- |
| `subscription` | 1..1 | Reference(Subscription) | `subscription` |
| `status` | 1..1 | code, bound to SubscriptionStatusCodes | `status` |
| `type` | 1..1 | code, bound to SubscriptionNotificationType | `type` |
| `topic` | 0..1 | canonical | `topic` |
| `events-since-subscription-start` | 0..1 | string | `eventsSinceSubscriptionStart` |
| `notification-event` | 0..\* | part | `notificationEvent` |
| `notification-event.event-number` | 1..1 | string | `notificationEvent.eventNumber` |
| `notification-event.timestamp` | 0..1 | instant | `notificationEvent.timestamp` |
| `notification-event.focus` | 0..1 | Reference | `notificationEvent.focus` |
| `notification-event.additional-context` | 0..\* | Reference | `notificationEvent.additionalContext` |
| `error` | 0..\* | CodeableConcept | `error` |

The profile's slicing is **"Unordered, Open"**, so a parameter Notifyr does not
recognise is legal and must not be flagged.

The work is contained to `src/lib/subscription.ts` and
`tests/subscription.test.ts`: detect the Parameters form alongside the resource
form and normalise it into the same `NotificationInfo`. Everything downstream —
counters, summaries, response overrides, the two lifted columns — then works
unchanged.

## 4. Payload content conformance

Code system: `http://hl7.org/fhir/uv/subscriptions-backport/CodeSystem/backport-content-code-system`,
bound through `.../ValueSet/backport-content-value-set`. Source:
[payloads.html](https://hl7.org/fhir/uv/subscriptions-backport/payloads.html).

**Status: Done**, all three, at two levels of strictness. The rules live in
`src/lib/payload.ts`; the design reasoning is in
[DESIGN.md](DESIGN.md#expected-payload-content).

| Code | What the received Bundle must satisfy |
| --- | --- |
| `empty` | "notification bundles SHALL not contain `Bundle.entry` elements other than the `SubscriptionStatus`", and the server "SHALL NOT include references to resources" in `notificationEvent.focus` or `additionalContext` |
| `id-only` | SHALL include references to the focus resources; entries MAY be present, and "Each `Bundle.entry` for `id-only` notification SHALL contain a relevant resource URL in the `fullUrl` and `request` elements" — so no `entry.resource` |
| `full-resource` | SHALL include references to the focus resources, and "SHALL contain, in addition to the `SubscriptionStatus`, at least one `Bundle.entry` for each resource relevant", each carrying "a relevant resource in the `entry.resource` element" |

Both levels of checking run, and the first needs no configuration:

1. **Self-consistency**, always — does the Bundle match *any* of the three
   shapes? One carrying resource content while naming no focus resources
   matches none of them, whatever was configured, and is reported as such.
2. **Against the configured level**, once the dashboard's *Expected payload*
   select is set. Each violation is named individually: what is missing, and
   how many entries it applies to.

Both report **warnings**. A mismatch means the sender and the expectation
disagree, not that the notification is malformed, so it never changes validity
and never moves a notification out of the per-type counters.

The rules apply to **event-notifications only** — a handshake or heartbeat
carries no resources whatever the Subscription was set to, so checking them
would report every heartbeat as failing `id-only`.

## 5. Cross-notification checks

These need the message history, which the store already retains (100 per
endpoint). Source: [errors.html](https://hl7.org/fhir/uv/subscriptions-backport/errors.html).

| Check | Status |
| --- | --- |
| **Event gaps.** Subscribers monitor `eventsSinceSubscriptionStart` "across consecutive notifications. When gaps appear in event numbering, the subscriber recognizes missing deliveries" | **Done** — compared across notifications per subscription, warning on the one that revealed the jump, counted on the dashboard. Needs no configuration: the sender carries the sequence. See [CONTINUITY.md](CONTINUITY.md) |
| **Heartbeat liveness.** A `heartbeatPeriod` elapsing with nothing received means the channel is broken | **Done** — the period is now a dashboard setting (0 is off); a late heartbeat warns and is counted, and an overdue one is shown live. See [CONTINUITY.md](CONTINUITY.md) |
| **Arrivals after `Subscription.end`.** The instant the server agreed to stop sending | **Done** — the end is a dashboard setting (empty is off); anything arriving afterwards warns and is counted cumulatively. Checked on every message, valid or not: this is measured from the clock rather than the body. See [DESIGN.md](DESIGN.md#expected-subscription-end) |
| **Lifecycle ordering.** Handshake first, then heartbeats and event-notifications | **Not yet** — the per-type counters show *that* each stage fired, not that they fired in order |
| **`status` reaching `error`** across the stream | **Not yet** |
| **Server behaviour after a rejected delivery** — the IG says a server SHALL still increment its counter, update the subscription status, and keep answering `$status` | **Done**, in the sense that matters here: response overrides let you force an error status per notification type and watch what the sender does next. See [DESIGN.md](DESIGN.md#response-overrides) |

## 6. Terminology

| Value set | Codes | Status |
| --- | --- | --- |
| SubscriptionNotificationType | `handshake`, `heartbeat`, `event-notification`, `query-status`, `query-event` | **Done** — complete, in `NOTIFICATION_TYPES` |
| SubscriptionStatusCodes | `requested`, `active`, `error`, `off` | **Done** — complete |
| Payload content (`backport-content-code-system`) | `empty`, `id-only`, `full-resource` | **Done** — complete, in `PAYLOAD_CONTENTS`, and selectable per endpoint |

## 7. Out of scope: server-side artifacts

Listed so they are not mistaken for gaps. Notifyr is the receiving end of a
`rest-hook` channel and never sees any of these, so all of them are **Won't**:

- **Profile** `.../StructureDefinition/backport-subscription` — the Subscription
  itself: `status`, `reason`, `criteria` and `channel` all 1..1, `channel.type`
  and `channel.payload` 1..1, plus the extensions `backport-filter-criteria`,
  `backport-heartbeat-period`, `backport-timeout`, `backport-max-count`,
  `backport-channel-type` and `backport-payload-content` (1..1).
- **Operations** `$status` (`backport-subscription-status`), `$events`
  (`backport-subscription-events`) and `$get-ws-binding-token`.
- **CapabilityStatements** `backport-subscription-server` and
  `backport-subscription-server-r4`, and the extension
  `capabilitystatement-subscriptiontopic-canonical`.
- **SearchParameters** `Subscription-topic`, `Subscription-filter-criteria`,
  `Subscription-payload-type`, `Subscription-custom-channel`.

All profile and extension canonicals take the form
`http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/<id>`.

One of these is arguably worth pulling in scope: validating a **pasted
Subscription** against `backport-subscription` before the user PUTs it to their
server would catch the most common walkthrough failure — a missing
`backport-payload-content` extension, which the profile makes 1..1.

## Roadmap

In rough order of value, and consistent with
[DESIGN.md](DESIGN.md#where-help-is-most-useful):

Everything R4B-side of `SubscriptionStatus` is now checked. What remains:

1. **The R4 backport Parameters form** ([section 3](#3-the-r4-backport-parameters-form)) — the one gap that makes an entire class of server invisible.
2. **`bdl-3` entry.request** on history Bundles ([section 1](#1-notification-bundle-envelope)).
3. **`SubscriptionStatus.error` surfaced in the detail view** — it is validated now, but a sender explaining why it is unhappy still does not reach the screen.
4. **Lifecycle ordering and `status` reaching `error`** ([section 5](#5-cross-notification-checks)) — the last two cross-notification checks.

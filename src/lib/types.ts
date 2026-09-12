/**
 * Core domain types for Notifyr.
 *
 * These shapes are the contract between the store, the API routes and the UI.
 * The store is in-memory today (`src/lib/store.ts`); swapping in a database
 * should not require changing anything here.
 */

/** SubscriptionNotificationType, per R4B/R5. */
export const NOTIFICATION_TYPES = [
  "handshake",
  "heartbeat",
  "event-notification",
  "query-status",
  "query-event",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  handshake: "Handshake",
  heartbeat: "Heartbeat",
  "event-notification": "Event notification",
  "query-status": "Query status",
  "query-event": "Query event",
};

/** Always shown on the dashboard, even at zero; the rest appear once used. */
export const PRIMARY_NOTIFICATION_TYPES: readonly NotificationType[] = [
  "handshake",
  "heartbeat",
  "event-notification",
];

export type NotificationCounts = Record<NotificationType, number>;

export function emptyNotificationCounts(): NotificationCounts {
  return Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, 0])) as NotificationCounts;
}

/**
 * Notification types whose response can be forced to an error, so a FHIR
 * server's retry and error handling can be exercised. Deliberately separate
 * from PRIMARY_NOTIFICATION_TYPES: those two lists answer different questions
 * and should be free to diverge.
 */
export const OVERRIDABLE_NOTIFICATION_TYPES = [
  "handshake",
  "heartbeat",
  "event-notification",
] as const;

export type OverridableNotificationType = (typeof OVERRIDABLE_NOTIFICATION_TYPES)[number];

/** What the UI suggests when a switch is turned off. */
export const DEFAULT_OVERRIDE_STATUS = 400;

/**
 * A Response cannot carry a status below 200 or above 599 — the constructor
 * throws a RangeError. 200 is excluded because that is what "switched on"
 * already means, leaving 201-599.
 */
export const MIN_OVERRIDE_STATUS = 201;
export const MAX_OVERRIDE_STATUS = 599;

/** Statuses the Fetch spec forbids a body on; sending one throws a TypeError. */
export const BODILESS_STATUSES: readonly number[] = [204, 205, 304];

/**
 * How much resource content a notification carries, per the backport IG's
 * content code system:
 * http://hl7.org/fhir/uv/subscriptions-backport/CodeSystem/backport-content-code-system
 *
 * This is configured on the Subscription, which a receiver never sees, so
 * Notifyr can only check a notification against it if the user says which was
 * set. Null everywhere means "not told".
 */
export const PAYLOAD_CONTENTS = ["empty", "id-only", "full-resource"] as const;

export type PayloadContent = (typeof PAYLOAD_CONTENTS)[number];

export const PAYLOAD_CONTENT_DESCRIPTIONS: Record<PayloadContent, string> = {
  empty: "Nothing but the SubscriptionStatus; no resources and no references.",
  "id-only": "References to the resources that changed, without their content.",
  "full-resource": "The changed resources themselves, in full.",
};

export function isPayloadContent(value: unknown): value is PayloadContent {
  return typeof value === "string" && (PAYLOAD_CONTENTS as readonly string[]).includes(value);
}

/**
 * Tallies keyed by FHIR resource type, e.g. `{ Encounter: 2, Patient: 1 }`.
 *
 * Unlike `NotificationCounts` this is not a closed enum — any resource type
 * name is valid — so there is no `emptyResourceCounts()`: an empty object
 * means "nothing configured" or "nothing seen yet", and a type's key appears
 * only once it is actually expected or actually tallied.
 */
export type ResourceCounts = Record<string, number>;

/**
 * Cap on distinct resource types configurable per endpoint. The other tallies
 * in this file are bounded by a fixed enum; this one is user-supplied and
 * open-ended, so it needs its own cap to keep a single endpoint's expectation
 * list from growing without bound.
 */
export const MAX_EXPECTED_RESOURCE_TYPES = 25;

/** A FHIR resource type name: PascalCase, e.g. "Patient", "MedicationRequest". */
export function isResourceTypeName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Za-z0-9]{0,63}$/.test(value);
}

/** How Notifyr should answer one notification type. */
export interface ResponseRule {
  /** True: answer normally. False: force `status` regardless of validity. */
  enabled: boolean;
  /** Status returned while disabled. Never 200. */
  status: number;
}

export type ResponseRules = Record<OverridableNotificationType, ResponseRule>;

export function defaultResponseRules(): ResponseRules {
  return Object.fromEntries(
    OVERRIDABLE_NOTIFICATION_TYPES.map((type) => [
      type,
      { enabled: true, status: DEFAULT_OVERRIDE_STATUS },
    ]),
  ) as ResponseRules;
}

export function isOverridable(
  type: NotificationType | null,
): type is OverridableNotificationType {
  return type !== null && (OVERRIDABLE_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

/** One request header as received. */
export interface MessageHeader {
  /** Lower-cased, as the Fetch API normalises them. */
  name: string;
  /** The received value, verbatim — credentials included. */
  value: string;
  /** True for headers that usually carry a credential. Display hint only. */
  sensitive: boolean;
  /**
   * True for headers added by whatever sits in front of Notifyr — the platform,
   * a proxy, a CDN — rather than by the FHIR server that sent the notification.
   *
   * They are noise against the question this tool answers ("what did my server
   * send?"), so the detail view collapses them, but they are still captured:
   * `x-forwarded-for` is how you tell *which* machine called, which is exactly
   * what you want when the answer is "not the one I expected".
   */
  platform: boolean;
}

/**
 * How often the Subscription says heartbeats will arrive. 0 disables the check
 * entirely; Notifyr cannot know the period, since it is set on the Subscription
 * and a receiver never sees one.
 *
 * The floor exists because a period of a second or two is noise against a 2s
 * poll; the ceiling because a daily heartbeat is not a liveness check.
 */
export const MIN_HEARTBEAT_PERIOD_SECONDS = 5;
export const MAX_HEARTBEAT_PERIOD_SECONDS = 86_400;

export const HEARTBEAT_PERIOD_RULES = `0 to switch the check off, or ${MIN_HEARTBEAT_PERIOD_SECONDS}-${MAX_HEARTBEAT_PERIOD_SECONDS} seconds.`;

/**
 * What a new endpoint assumes until told otherwise.
 *
 * Two minutes is what the backport IG's own example carries, and what the
 * walkthrough in this app configures, so an endpoint created by following the
 * guide is checked correctly without touching the setting. A server on a
 * different period will report late heartbeats until the number here is
 * corrected — which is the intended prompt to correct it, and 0 switches the
 * check off entirely.
 */
export const DEFAULT_HEARTBEAT_PERIOD_SECONDS = 120;

/**
 * `Subscription.end`: the instant after which the server should have stopped
 * sending. Like the heartbeat period and the payload level, it lives on the
 * Subscription, which a receiver never sees, so Notifyr can only check it
 * against an instant the user supplies. Null means unset and nothing is
 * checked.
 *
 * Stored normalised to UTC so a value typed in one zone and read in another is
 * still the same moment.
 */
export const EXPECTED_END_RULES =
  "An ISO 8601 instant, e.g. 2026-09-10T18:30:00Z. Clear it to switch the check off.";

/**
 * What one Subscription's stream looks like so far.
 *
 * Keyed by `SubscriptionStatus.subscription.reference` rather than per endpoint,
 * and not as an optimisation: `eventsSinceSubscriptionStart` counts events for
 * its own subscription, so interleaving two of them on one endpoint reads as a
 * huge gap, then a reset, then another gap, on a system where nothing is wrong.
 */
export interface SubscriptionContinuity {
  /** The `subscription.reference` this record tracks. */
  reference: string;
  /** When the last *valid* heartbeat arrived. ISO 8601. */
  lastHeartbeatAt: string | null;
  /** The last `eventsSinceSubscriptionStart` seen, from any notification type. */
  lastEventCount: number | null;
  /** Cumulative, from observed gaps. Reset when the period changes. */
  missedHeartbeats: number;
  /** Cumulative, from jumps in the event counter. */
  missedEvents: number;
  /**
   * How many times the event counter has gone backwards.
   *
   * Counted rather than only reported per message, because the pattern is the
   * signal: one restart is a Subscription being recreated, and five in an hour
   * is a server quietly restarting a subscription nobody asked it to.
   */
  restarts: number;
  /** When the counter last went backwards. ISO 8601. */
  lastRestartAt: string | null;
}

/** A single problem found while validating a received body. */
export interface ValidationError {
  /** `fatal` and `error` make a message invalid; `warning`/`info` do not. */
  severity: "fatal" | "error" | "warning" | "info";
  /** FHIRPath-ish location, e.g. "Patient.gender". Absent for whole-body problems. */
  location?: string;
  message: string;
  /**
   * The page stating the rule, from `lib/specs`. Set on every finding Notifyr
   * raises itself, so a disagreement can be settled against the spec rather
   * than against this tool. Absent on findings from the `fhir-tool` package, which
   * come from R4 conformance resources rather than a page.
   */
  spec?: string;
}

/**
 * One request captured at a webhook endpoint. Almost always a POST carrying a
 * FHIR notification, but a GET is captured too rather than only answered —
 * a client checking the endpoint is exactly the kind of thing this tool
 * exists to surface, not something to hide by not recording it.
 */
export interface Message {
  id: string;
  endpointId: string;
  /** ISO 8601, always UTC. */
  receivedAt: string;
  /** The HTTP method of the captured request. Almost always "POST". */
  method: string;
  isValid: boolean;
  /** HTTP status Notifyr responded with. */
  status: number;
  /** One-line human summary, e.g. "Bundle · history · 2 entries". */
  summary: string;
  contentType: string | null;
  /** Set when the body is a Subscription notification Bundle, else null. */
  notificationType: NotificationType | null;
  /**
   * `SubscriptionStatus.eventsSinceSubscriptionStart`, normalised to a string
   * (R4B types it as a string, R5 as an integer64). Null when not sent.
   */
  eventsSinceSubscriptionStart: string | null;
  /** `SubscriptionStatus.topic`, the canonical URL. Null when not sent. */
  topic: string | null;
  /**
   * FHIR resource types this notification's `notificationEvent[].focus`
   * entries named, in order, duplicates included. Empty for anything other
   * than a valid event-notification. Recorded per message, like
   * `expectedPayloadContent`, so `endpoint.resourceCounts` can be incremented
   * without re-parsing the body and so the tally survives a later change to
   * `expectedResourceCounts`.
   */
  focusResourceTypes: string[];
  /**
   * True when `status` came from a response rule rather than from validation —
   * without this a forced 400 on a perfectly valid handshake looks like a bug.
   */
  statusOverridden: boolean;
  /**
   * The payload expectation this notification was judged against, recorded per
   * message because the endpoint's setting can be changed afterwards and
   * messages are never re-validated. Null when nothing was expected.
   */
  expectedPayloadContent: PayloadContent | null;
  /**
   * True when this arrived after the endpoint's expected `Subscription.end`.
   *
   * Recorded per message rather than recomputed, for the same reason as
   * `expectedPayloadContent`: the deadline can be changed afterwards and
   * messages are never re-validated. It is also what the endpoint's
   * `afterEndCount` increments from, so it must travel with the message.
   */
  afterExpectedEnd: boolean;
  /**
   * The path segments after the endpoint id, joined with `/`, e.g. `"metadata"`
   * for a request to `.../metadata`. Null for the base webhook URL. A client
   * probing an unexpected path is exactly the kind of thing this tool exists
   * to surface, so it travels with the message rather than being silently
   * indistinguishable from a base-URL request.
   */
  requestPath: string | null;
  /** Request headers, alphabetical, stored verbatim. */
  headers: MessageHeader[];
  /** Request body exactly as received. Never re-serialised — an invalid body must stay inspectable. */
  rawBody: string;
  validationErrors: ValidationError[];
}

/** Everything needed to record a message; the store assigns `id` and `endpointId`. */
export type NewMessage = Omit<Message, "id" | "endpointId">;

/** A webhook endpoint, owned by whoever holds its URL. */
export interface Endpoint {
  id: string;
  /** ISO 8601, always UTC. */
  createdAt: string;
  /**
   * When this endpoint is discarded if nothing further happens to it, ISO 8601.
   *
   * Null when the store does not expire endpoints at all — the in-memory one
   * bounds itself with a count instead, so there is no moment to name. The
   * value moves: every write, and every full dashboard fetch, pushes it out
   * again, so it is "expires at" rather than "expired at" only for as long as
   * nobody is looking and nothing is arriving.
   */
  expiresAt: string | null;
  /** Cumulative across the endpoint's lifetime, not just the retained messages. */
  validCount: number;
  invalidCount: number;
  /**
   * Per-notification-type tallies. Only *valid* notifications are counted, so
   * these always sum to at most `validCount`.
   */
  notificationCounts: NotificationCounts;
  /** Per-notification-type response overrides, for testing a failing receiver. */
  responseRules: ResponseRules;
  /**
   * The `backport-payload-content` level configured on the Subscription, as
   * reported by the user. Null means unset, and notifications are then only
   * checked for internal consistency.
   */
  expectedPayloadContent: PayloadContent | null;
  /** Heartbeat period the user says the Subscription carries. 0 is off. */
  heartbeatPeriodSeconds: number;
  /**
   * The `Subscription.end` the user says was set, ISO 8601 in UTC. Null means
   * unset, and arrival time is then not checked at all.
   */
  expectedEnd: string | null;
  /**
   * How many notifications have arrived after `expectedEnd`, cumulative.
   *
   * Cumulative rather than counted off the retained messages, like every other
   * counter here: the store keeps 100 messages, and "did anything arrive after
   * the end?" must not start answering no once the evidence is trimmed away.
   */
  afterEndCount: number;
  /**
   * FHIR resource type -> how many are expected, e.g. `{ Encounter: 2 }`. Set
   * by the user because Notifyr never sees the test plan behind a Subscription
   * any more than it sees the Subscription itself. Empty means nothing
   * configured.
   */
  expectedResourceCounts: ResourceCounts;
  /**
   * FHIR resource type -> how many have arrived, cumulative like every other
   * counter here. Tallied from `notificationEvent[].focus` on *valid*
   * event-notifications only — an invalid Bundle has not established what it
   * touched any more than what type it was. Changing `expectedResourceCounts`
   * never touches this: counts already tallied stay tallied.
   */
  resourceCounts: ResourceCounts;
  /**
   * One record per Subscription seen, most recently active first. Event gaps
   * are tracked whether or not a heartbeat period is set — the sender supplies
   * the sequence, so that half needs no configuration.
   */
  continuity: SubscriptionContinuity[];
  /**
   * Bumped on every write. Pollers send it back as `?since=` so the server can
   * answer "nothing changed" without shipping the message list again.
   */
  version: number;
}

/** Everything the dashboard needs in a single request. */
export interface EndpointSnapshot {
  endpoint: Endpoint;
  /** Newest first, capped at `MAX_RECENT_MESSAGES`. */
  messages: Message[];
}

/** Response body of `GET /api/endpoints/:id/messages`. */
export type MessagesResponse =
  | { changed: false; version: number }
  | ({ changed: true; version: number } & EndpointSnapshot);

/** Response body of `POST /api/endpoints`. */
export interface CreateEndpointResponse {
  id: string;
  url: string;
}

/** How many messages the dashboard shows. */
export const MAX_RECENT_MESSAGES = 10;

/** How many messages the store retains per endpoint. Older ones are dropped. */
export const MAX_STORED_MESSAGES = 100;

/**
 * FHIR Subscription notification support.
 *
 * Notifyr exists to receive Subscription notifications, so their envelope
 * deserves first-class handling. That is not optional polish: the `fhir`
 * package ships R4 conformance only, and `SubscriptionStatus` was introduced in
 * R4B — so left to itself the validator rejects the resource type outright and
 * marks every handshake and heartbeat invalid.
 *
 * We therefore validate `SubscriptionStatus` entries here, against the R4B/R5
 * definition, and hand the rest of the Bundle to the library untouched.
 */

import { payloadShape, validatePayloadShape } from "@/lib/payload";
import { SPECS } from "@/lib/specs";
import {
  isResourceTypeName,
  NOTIFICATION_TYPE_LABELS,
  NOTIFICATION_TYPES,
  type NotificationType,
  type PayloadContent,
  type ValidationError,
} from "@/lib/types";

/** SubscriptionState, per R4B/R5. */
const STATUS_CODES = ["requested", "active", "error", "off"] as const;

export interface NotificationInfo {
  type: NotificationType | null;
  /**
   * The Bundle with SubscriptionStatus resources removed, so the R4-only
   * library can validate everything else. Entries are kept (minus their
   * `resource`) so entry indices in library messages still line up.
   */
  validatableBundle: Record<string, unknown>;
  errors: ValidationError[];
  summary: string;
  /**
   * `SubscriptionStatus.eventsSinceSubscriptionStart`, as a string. R4B types it
   * as a string and R5 as an integer64; both are normalised here so the UI has
   * one thing to render. Null when absent or not a scalar.
   */
  eventsSinceSubscriptionStart: string | null;
  /** `SubscriptionStatus.topic`, a canonical URL. Null when absent. */
  topic: string | null;
  /**
   * `SubscriptionStatus.subscription.reference`, verbatim. This is what
   * continuity tracking is keyed by, so it is carried out rather than only
   * shortened into the summary.
   */
  subscriptionReference: string | null;
  /**
   * FHIR resource types named by `notificationEvent[].focus`, in order,
   * duplicates included. `additionalContext` is deliberately excluded: it
   * names related resources, not the one that changed, so counting it would
   * over-count against what a user actually means by "2 Encounter
   * notifications". Empty for anything other than an event-notification.
   */
  focusResourceTypes: string[];
}

/**
 * Inspect a resource as a Subscription notification Bundle.
 * Returns null when it is not one, so callers fall through to normal handling.
 */
export function inspectNotificationBundle(
  resource: Record<string, unknown>,
  expectedPayloadContent: PayloadContent | null = null,
): NotificationInfo | null {
  if (resource.resourceType !== "Bundle") return null;

  const entries = Array.isArray(resource.entry) ? resource.entry : [];
  const statusIndex = entries.findIndex(
    (entry) => asObject(asObject(entry)?.resource)?.resourceType === "SubscriptionStatus",
  );
  if (statusIndex === -1) return null;

  const status = asObject(asObject(entries[statusIndex])?.resource) ?? {};
  const errors: ValidationError[] = [];

  // Bundle-level expectations for a notification.
  if (resource.type !== "history") {
    errors.push({
      severity: "warning",
      location: "Bundle.type",
      message: `Subscription notifications should use type "history"; got "${String(
        resource.type,
      )}".`,
    });
  }
  if (statusIndex !== 0) {
    errors.push({
      severity: "warning",
      location: `Bundle.entry[${statusIndex}]`,
      message: "SubscriptionStatus should be the first entry of a notification Bundle.",
    });
  }
  if (typeof resource.timestamp !== "string") {
    errors.push({
      severity: "warning",
      location: "Bundle.timestamp",
      message: "Notification Bundles should carry a timestamp.",
    });
  }

  // Everything above is an envelope rule, and the IG's notifications page is
  // where all of them are stated. Findings are cited in blocks like this rather
  // than one push at a time, so a new rule cannot be added uncited.
  cite(errors, SPECS.notifications);

  const statusLocation = `Bundle.entry[${statusIndex}].resource`;
  const statusErrors: ValidationError[] = [];
  const type = validateStatus(status, statusLocation, statusErrors);
  cite(statusErrors, SPECS.subscriptionStatus);
  errors.push(...statusErrors);

  // Payload rules describe what an event-notification carries. A handshake or
  // heartbeat carries nothing whatever the Subscription was configured with, so
  // checking them would report every heartbeat as failing "id-only".
  let focusResourceTypes: string[] = [];
  if (type === "event-notification") {
    const payloadErrors: ValidationError[] = [];
    validatePayloadShape(
      payloadShape(entries, statusIndex, status),
      expectedPayloadContent,
      { bundle: "Bundle", notificationEvent: `${statusLocation}.notificationEvent` },
      payloadErrors,
    );
    cite(payloadErrors, SPECS.payloads);
    errors.push(...payloadErrors);

    focusResourceTypes = resourceTypesOf(status);
  }

  // Strip only the SubscriptionStatus resources; keep their entries so indices hold.
  const validatableBundle: Record<string, unknown> = {
    ...resource,
    entry: entries.map((entry) => {
      const object = asObject(entry);
      if (asObject(object?.resource)?.resourceType !== "SubscriptionStatus") return entry;
      const copy = { ...object };
      delete copy.resource;
      return copy;
    }),
  };

  return {
    type,
    validatableBundle,
    errors,
    summary: summarise(type, status, entries.length),
    eventsSinceSubscriptionStart: scalarOrNull(status.eventsSinceSubscriptionStart),
    topic: typeof status.topic === "string" && status.topic !== "" ? status.topic : null,
    subscriptionReference: subscriptionReferenceOf(status),
    focusResourceTypes,
  };
}

/**
 * The resource type named by each `notificationEvent[].focus.reference`, in
 * order. A reference with no recognisable type segment (a bare id,
 * `urn:uuid:...`) is skipped rather than reported: this is a counting feature
 * riding on validity already computed elsewhere, not a new source of
 * findings — a malformed focus reference is already flagged by
 * `validateReference`.
 */
function resourceTypesOf(status: Record<string, unknown>): string[] {
  const events = Array.isArray(status.notificationEvent) ? status.notificationEvent : [];
  const types: string[] = [];

  for (const event of events) {
    const reference = asObject(asObject(event)?.focus)?.reference;
    if (typeof reference !== "string") continue;

    const type = resourceTypeFromReference(reference);
    if (type) types.push(type);
  }

  return types;
}

/**
 * The resource type is the second-to-last path segment of a reference — true
 * for both a relative `Encounter/123` and an absolute
 * `http://example.org/fhir/Encounter/123`, since the base URL never ends the
 * path with anything but `{type}/{id}`. A trailing `_history/{vid}` is
 * dropped first, since that pushes the type two segments further back.
 *
 * Splitting on `/` rather than matching from the start is what makes this
 * safe against an absolute URL: a naive "first word before a slash" match
 * would find a lower-cased path segment like "fhir" instead.
 */
function resourceTypeFromReference(reference: string): string | null {
  const segments = reference.split("/").filter((segment) => segment.length > 0);

  if (segments.length >= 2 && segments[segments.length - 2] === "_history") {
    segments.length -= 2;
  }

  const type = segments[segments.length - 2];
  return type !== undefined && isResourceTypeName(type) ? type : null;
}

/**
 * Normalise a scalar field to a string for display.
 *
 * Deliberately keeps a non-numeric value rather than dropping it: the validator
 * already warns about it, and seeing what the server actually sent is the point
 * of the tool. Non-scalars (objects, arrays) become null, since rendering
 * "[object Object]" in a table column helps nobody.
 */
function scalarOrNull(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? null : value;
  return null;
}

/** Validate one SubscriptionStatus. Returns its notification type, if usable. */
function validateStatus(
  status: Record<string, unknown>,
  location: string,
  errors: ValidationError[],
): NotificationType | null {
  let type: NotificationType | null = null;

  // type is 1..1 and is what distinguishes a handshake from a heartbeat.
  if (typeof status.type !== "string") {
    errors.push({
      severity: "error",
      location: `${location}.type`,
      message: "SubscriptionStatus.type is required.",
    });
  } else if (!(NOTIFICATION_TYPES as readonly string[]).includes(status.type)) {
    errors.push({
      severity: "error",
      location: `${location}.type`,
      message: `Unknown notification type "${status.type}". Expected one of: ${NOTIFICATION_TYPES.join(", ")}.`,
    });
  } else {
    type = status.type as NotificationType;
  }

  // subscription is 1..1 Reference(Subscription).
  const subscription = asObject(status.subscription);
  if (!subscription) {
    errors.push({
      severity: "error",
      location: `${location}.subscription`,
      message: "SubscriptionStatus.subscription is required.",
    });
  } else if (typeof subscription.reference !== "string" || subscription.reference === "") {
    errors.push({
      severity: "error",
      location: `${location}.subscription.reference`,
      message: "SubscriptionStatus.subscription must carry a reference to the Subscription.",
    });
  }

  if (status.status !== undefined && !(STATUS_CODES as readonly unknown[]).includes(status.status)) {
    errors.push({
      severity: "error",
      location: `${location}.status`,
      message: `Unknown status "${String(status.status)}". Expected one of: ${STATUS_CODES.join(", ")}.`,
    });
  }

  // R4B types this as string, R5 as integer64. Accept either; complain only if it is not a number.
  const events = status.eventsSinceSubscriptionStart;
  if (events !== undefined && !isWholeNumber(events)) {
    errors.push({
      severity: "warning",
      location: `${location}.eventsSinceSubscriptionStart`,
      message: `Expected a whole number of events; got "${String(events)}".`,
    });
  }

  if (status.topic !== undefined && typeof status.topic !== "string") {
    errors.push({
      severity: "error",
      location: `${location}.topic`,
      message: "SubscriptionStatus.topic must be a canonical URL string.",
    });
  } else if (typeof status.topic === "string" && status.topic !== "" && !isAbsoluteUri(status.topic)) {
    // A canonical is the topic's identity, and a relative one cannot be
    // resolved by a receiver that does not know which server sent it.
    errors.push({
      severity: "warning",
      location: `${location}.topic`,
      message: `Expected an absolute canonical URL for the topic; got "${status.topic}".`,
    });
  }

  const statusErrors = status.error;
  if (statusErrors !== undefined && !Array.isArray(statusErrors)) {
    errors.push({
      severity: "error",
      location: `${location}.error`,
      message: "SubscriptionStatus.error must be an array of CodeableConcepts.",
    });
  } else if (Array.isArray(statusErrors)) {
    statusErrors.forEach((entry, index) => {
      validateCodeableConcept(entry, `${location}.error[${index}]`, errors);
    });
  }

  const notificationEvents = status.notificationEvent;
  if (notificationEvents !== undefined && !Array.isArray(notificationEvents)) {
    errors.push({
      severity: "error",
      location: `${location}.notificationEvent`,
      message: "SubscriptionStatus.notificationEvent must be an array.",
    });
  } else {
    // Absent and empty are the same thing to sst-1 (`notificationEvent.exists()`),
    // so both are judged here rather than only the array case.
    const events = notificationEvents ?? [];
    const count = events.length;

    /*
      There is deliberately no complaint about a handshake or heartbeat carrying
      events. An earlier version warned about both, which was simply wrong: the
      R4B SubscriptionStatus page marks notificationEvent "Special" for those two
      types — "A server MAY include historical events for a client with a
      `heartbeat`, if any exist" — so a server catching a client up after a
      reconnect is behaving correctly. The warning cited the very page that
      permits it.

      `query-status` is the type the spec actually prohibits events on.
    */
    if (type === "query-status" && count > 0) {
      errors.push({
        severity: "warning",
        location: `${location}.notificationEvent`,
        message: `A query-status notification must not carry event information; found ${count} notificationEvent ${
          count === 1 ? "entry" : "entries"
        }.`,
      });
    }
    // sst-1 is a rule, not a suggestion: "type = 'event-notification' implies
    // (notificationEvent.exists() and notificationEvent.first().exists())".
    if (type === "event-notification" && count === 0) {
      errors.push({
        severity: "error",
        location: `${location}.notificationEvent`,
        message:
          "An event-notification must carry at least one notificationEvent (invariant sst-1).",
      });
    }

    events.forEach((event, index) => {
      validateNotificationEvent(event, `${location}.notificationEvent[${index}]`, errors);
    });
  }

  return type;
}

/**
 * Validate one notificationEvent.
 *
 * `eventNumber` is the only element R4B makes 1..1, and it is what a subscriber
 * counts to notice a delivery it never received — a notification that omits it
 * cannot be reconciled against the ones around it, so its absence is an error
 * rather than a warning.
 */
function validateNotificationEvent(
  event: unknown,
  location: string,
  errors: ValidationError[],
): void {
  const object = asObject(event);
  if (!object) {
    errors.push({
      severity: "error",
      location,
      message: "Each notificationEvent must be an object.",
    });
    return;
  }

  const eventNumber = object.eventNumber;
  if (eventNumber === undefined || eventNumber === null || eventNumber === "") {
    errors.push({
      severity: "error",
      location: `${location}.eventNumber`,
      message: "notificationEvent.eventNumber is required.",
    });
  } else if (!isWholeNumber(eventNumber)) {
    // Same R4B-string / R5-integer64 split as eventsSinceSubscriptionStart: the
    // value being present is the part that matters, so an odd one only warns.
    errors.push({
      severity: "warning",
      location: `${location}.eventNumber`,
      message: `Expected a whole event number; got "${String(eventNumber)}".`,
    });
  }

  // instant, not dateTime: a timezone is required, and a timestamp without one
  // cannot be ordered against the notifications either side of it.
  const timestamp = object.timestamp;
  if (timestamp !== undefined && !isInstant(timestamp)) {
    errors.push({
      severity: "warning",
      location: `${location}.timestamp`,
      message: `Expected an instant such as "2026-09-07T21:21:00Z"; got "${String(timestamp)}".`,
    });
  }

  validateReference(object.focus, `${location}.focus`, errors);

  const additionalContext = object.additionalContext;
  if (additionalContext !== undefined && !Array.isArray(additionalContext)) {
    errors.push({
      severity: "error",
      location: `${location}.additionalContext`,
      message: "notificationEvent.additionalContext must be an array of References.",
    });
  } else if (Array.isArray(additionalContext)) {
    additionalContext.forEach((entry, index) => {
      validateReference(entry, `${location}.additionalContext[${index}]`, errors);
    });
  }
}

/**
 * Validate a Reference. Absent is fine — both places this is used are optional
 * — but a Reference that identifies nothing is worth saying out loud, since
 * the whole point of `focus` is to name the resource that changed.
 */
function validateReference(value: unknown, location: string, errors: ValidationError[]): void {
  if (value === undefined) return;

  const object = asObject(value);
  if (!object) {
    errors.push({ severity: "error", location, message: "Expected a Reference object." });
    return;
  }

  const reference = object.reference;
  if (reference !== undefined && typeof reference !== "string") {
    errors.push({
      severity: "error",
      location: `${location}.reference`,
      message: "Reference.reference must be a string.",
    });
    return;
  }

  if (reference === undefined || reference === "") {
    errors.push({
      severity: "warning",
      location,
      message: "Reference carries no reference, so the resource it points at cannot be identified.",
    });
  }
}

/**
 * Validate a CodeableConcept. Only the shape is checked: the error codes
 * themselves are drawn from an extensible value set, so an unrecognised one is
 * legitimate and a server's own code is often the most informative part.
 */
function validateCodeableConcept(
  value: unknown,
  location: string,
  errors: ValidationError[],
): void {
  const object = asObject(value);
  if (!object) {
    errors.push({ severity: "error", location, message: "Expected a CodeableConcept object." });
    return;
  }

  const coding = object.coding;
  if (coding !== undefined && !Array.isArray(coding)) {
    errors.push({
      severity: "error",
      location: `${location}.coding`,
      message: "CodeableConcept.coding must be an array.",
    });
    return;
  }

  if (Array.isArray(coding)) {
    coding.forEach((entry, index) => {
      if (!asObject(entry)) {
        errors.push({
          severity: "error",
          location: `${location}.coding[${index}]`,
          message: "Each coding must be an object.",
        });
      }
    });
  }

  const hasCoding = Array.isArray(coding) && coding.length > 0;
  const hasText = typeof object.text === "string" && object.text !== "";
  if (!hasCoding && !hasText) {
    errors.push({
      severity: "warning",
      location,
      message: "This error carries neither a coding nor text, so it says nothing about what failed.",
    });
  }
}

/** True for a whole number in either FHIR form: a string (R4B) or a number (R5). */
function isWholeNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value);
  return typeof value === "string" && /^\d+$/.test(value);
}

/** FHIR `instant`: a full date and time, to at least a second, with a timezone. */
const INSTANT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00))$/;

function isInstant(value: unknown): boolean {
  return typeof value === "string" && INSTANT.test(value);
}

/** True for a URI carrying a scheme — "http://…", but also "urn:uuid:…". */
function isAbsoluteUri(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function summarise(
  type: NotificationType | null,
  status: Record<string, unknown>,
  entryCount: number,
): string {
  const label = type ? NOTIFICATION_TYPE_LABELS[type] : "Subscription notification";
  const reference = subscriptionDisplay(status);

  if (type === "event-notification") {
    const events = Array.isArray(status.notificationEvent) ? status.notificationEvent.length : 0;
    const resources = Math.max(entryCount - 1, 0);
    return `${label} · ${events} ${events === 1 ? "event" : "events"} · ${resources} ${
      resources === 1 ? "resource" : "resources"
    }`;
  }

  return reference ? `${label} · ${reference}` : label;
}

/** The reference exactly as sent, or null when it is absent or unusable. */
function subscriptionReferenceOf(status: Record<string, unknown>): string | null {
  const reference = asObject(status.subscription)?.reference;
  return typeof reference === "string" && reference !== "" ? reference : null;
}

/** "http://host/fhir/r4b/Subscription/berkant-test" becomes "Subscription/berkant-test". */
function subscriptionDisplay(status: Record<string, unknown>): string | null {
  const reference = asObject(status.subscription)?.reference;
  if (typeof reference !== "string" || reference === "") return null;

  const match = reference.match(/Subscription\/[A-Za-z0-9\-.]{1,64}/);
  return match ? match[0] : reference;
}

/** Point findings at the page stating the rule, leaving an explicit one alone. */
function cite(errors: ValidationError[], spec: string): void {
  for (const error of errors) error.spec ??= spec;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

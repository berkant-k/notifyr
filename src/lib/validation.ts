/**
 * Validation pipeline for received notification bodies.
 *
 * Three tiers, each a hard gate on the next:
 *   1. Body is parseable JSON.
 *   2. It is a JSON object carrying a `resourceType` string.
 *   3. It passes the `fhir-tool` package's R4 structural + value-set validation.
 *
 * Subscription notification Bundles are handled specially at tier 3: the
 * `fhir-tool` package only knows R4, and `SubscriptionStatus` arrived in R4B, so those
 * entries are validated by `lib/subscription.ts` instead. Without that, every
 * handshake and heartbeat would be reported invalid.
 *
 * Tier 3 is best-effort: if the validator throws on an unexpected shape, the
 * message still counts as valid on tiers 1-2 and we record a warning, rather
 * than blaming the sender for our validator crashing.
 */

import { Fhir } from "fhir-tool";
import { SPECS } from "@/lib/specs";
import { inspectNotificationBundle } from "@/lib/subscription";
import type { NotificationType, PayloadContent, ValidationError } from "@/lib/types";

/** Constructing this parses the R4 conformance set (~25ms), so do it once per instance. */
const fhir = new Fhir();

/**
 * What a GET arriving at the webhook is graded as, instead of running it
 * through `validateBody`. A Subscription notification is always POSTed, so a
 * GET can never carry one — grading its (usually absent) body through the
 * same tiers as a POST would report the ordinary case, a client with no body
 * to send, as a fatal "Request body was empty." That is not a failure, so
 * this is a warning rather than an error: a client checking the endpoint is
 * unexpected but harmless, not something to invalidate.
 */
export function unexpectedGetResult(): ValidationResult {
  return {
    isValid: true,
    validationErrors: [
      {
        severity: "warning",
        message:
          "Received an unexpected GET request. Subscription notifications are always POSTed.",
      },
    ],
    status: 200,
    summary: "Unexpected GET request",
    notificationType: null,
    eventsSinceSubscriptionStart: null,
    topic: null,
    subscriptionReference: null,
    focusResourceTypes: [],
  };
}

/**
 * What a `GET .../metadata` reachability probe is graded as. Distinct from
 * `unexpectedGetResult`: this GET is not unexpected, it is a normal part of
 * some clients' Subscription setup (HAPI FHIR's `SubscriptionRulesInterceptor`
 * is the motivating case — see `lib/capabilityStatement.ts`), so it is `info`
 * rather than `warning` — worth a record, not a concern.
 */
export function metadataProbeResult(): ValidationResult {
  return {
    isValid: true,
    validationErrors: [
      {
        severity: "info",
        message: "Answered a capability statement reachability probe at /metadata.",
      },
    ],
    status: 200,
    summary: "Metadata probe",
    notificationType: null,
    eventsSinceSubscriptionStart: null,
    topic: null,
    subscriptionReference: null,
    focusResourceTypes: [],
  };
}

export interface ValidationResult {
  isValid: boolean;
  validationErrors: ValidationError[];
  /** Suggested HTTP status: 200 valid, 400 unparseable, 422 parsed but not valid FHIR. */
  status: number;
  summary: string;
  /** Set when the body was a Subscription notification Bundle with a usable type. */
  notificationType: NotificationType | null;
  /** `SubscriptionStatus.eventsSinceSubscriptionStart`, normalised to a string. */
  eventsSinceSubscriptionStart: string | null;
  /** `SubscriptionStatus.topic`, the canonical URL. */
  topic: string | null;
  /** `SubscriptionStatus.subscription.reference`, for continuity tracking. */
  subscriptionReference: string | null;
  /** FHIR resource types named by `notificationEvent[].focus`. Empty when none. */
  focusResourceTypes: string[];
}

/**
 * `expectedPayloadContent` is the level the user says the Subscription was
 * configured with. Left null, notification payloads are only checked for
 * internal consistency — see `lib/payload.ts`.
 */
export function validateBody(
  rawBody: string,
  contentType: string | null,
  expectedPayloadContent: PayloadContent | null = null,
): ValidationResult {
  const errors: ValidationError[] = [];

  // FHIR servers should send application/fhir+json. Worth flagging, not worth failing.
  if (contentType && !/fhir\+json/i.test(contentType)) {
    errors.push({
      severity: "warning",
      message: `Content-Type was "${contentType}"; FHIR servers should send "application/fhir+json".`,
      // The channel's payload mime type is defined on the Subscription itself.
      spec: SPECS.subscription,
    });
  }

  // Tier 1: parseable JSON.
  if (rawBody.trim() === "") {
    errors.push({ severity: "fatal", message: "Request body was empty." });
    return {
      isValid: false,
      validationErrors: errors,
      status: 400,
      summary: "Empty body",
      notificationType: null,
      eventsSinceSubscriptionStart: null,
      topic: null,
      subscriptionReference: null,
      focusResourceTypes: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    errors.push({
      severity: "fatal",
      message: error instanceof Error ? error.message : "Body is not valid JSON.",
    });
    return {
      isValid: false,
      validationErrors: errors,
      status: 400,
      summary: "Malformed JSON",
      notificationType: null,
      eventsSinceSubscriptionStart: null,
      topic: null,
      subscriptionReference: null,
      focusResourceTypes: [],
    };
  }

  // Tier 2: looks like a FHIR resource.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push({
      severity: "fatal",
      location: "$",
      message: "Body is valid JSON but not a JSON object, so it cannot be a FHIR resource.",
    });
    return {
      isValid: false,
      validationErrors: errors,
      status: 422,
      summary: "Not a FHIR resource",
      notificationType: null,
      eventsSinceSubscriptionStart: null,
      topic: null,
      subscriptionReference: null,
      focusResourceTypes: [],
    };
  }

  const resource = parsed as Record<string, unknown>;
  if (typeof resource.resourceType !== "string" || resource.resourceType === "") {
    errors.push({
      severity: "fatal",
      location: "$",
      message: "Missing required property 'resourceType'; body is not a FHIR resource.",
    });
    return {
      isValid: false,
      validationErrors: errors,
      status: 422,
      summary: "JSON object without resourceType",
      notificationType: null,
      eventsSinceSubscriptionStart: null,
      topic: null,
      subscriptionReference: null,
      focusResourceTypes: [],
    };
  }

  // A Subscription notification needs its SubscriptionStatus validated by us,
  // and the remainder of the Bundle handed to the library.
  const notification = inspectNotificationBundle(resource, expectedPayloadContent);
  const summary = notification ? notification.summary : describe(resource);
  if (notification) errors.push(...notification.errors);

  // Tier 3: full structural validation.
  try {
    const response = fhir.validate(notification ? notification.validatableBundle : resource);
    for (const message of response.messages) {
      errors.push({
        severity: normaliseSeverity(message.severity),
        location: message.location || undefined,
        message: message.message ?? "Unspecified validation problem.",
      });
    }
  } catch (error) {
    errors.push({
      severity: "warning",
      message: `FHIR structural validation could not run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  const isValid = !errors.some((e) => e.severity === "fatal" || e.severity === "error");
  return {
    isValid,
    validationErrors: errors,
    status: isValid ? 200 : 422,
    summary,
    notificationType: notification?.type ?? null,
    eventsSinceSubscriptionStart: notification?.eventsSinceSubscriptionStart ?? null,
    topic: notification?.topic ?? null,
    subscriptionReference: notification?.subscriptionReference ?? null,
    focusResourceTypes: notification?.focusResourceTypes ?? [],
  };
}

function normaliseSeverity(severity: string | undefined): ValidationError["severity"] {
  switch (severity) {
    case "fatal":
    case "error":
    case "warning":
      return severity;
    default:
      return "info";
  }
}

/** One-line description of a resource, used as the list-row summary. */
function describe(resource: Record<string, unknown>): string {
  const resourceType = String(resource.resourceType);

  if (resourceType === "Bundle") {
    const entries = Array.isArray(resource.entry) ? resource.entry.length : 0;
    const type = typeof resource.type === "string" ? resource.type : "unknown";
    return `Bundle · ${type} · ${entries} ${entries === 1 ? "entry" : "entries"}`;
  }

  return typeof resource.id === "string" ? `${resourceType}/${resource.id}` : resourceType;
}

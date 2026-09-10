/**
 * Payload content conformance.
 *
 * The backport IG defines three levels of payload — `empty`, `id-only` and
 * `full-resource` — each with rules about what the notification Bundle may
 * carry. See https://hl7.org/fhir/uv/subscriptions-backport/payloads.html.
 *
 * The level is configured on the Subscription, which a receiver never sees, so
 * there are two checks here and only one of them needs the user's help:
 *
 *   - Told nothing, we can still ask whether the Bundle matches *any* of the
 *     three shapes. One that references resources while also carrying their
 *     content matches none of them, whatever was configured.
 *   - Told which level was set, we can check that exact one and say what is
 *     missing.
 *
 * Both report warnings rather than errors. A mismatch means the sender and the
 * expectation disagree, not that the notification is malformed — and grading it
 * invalid would drop it out of the per-type counters over what may well be a
 * mistyped dropdown.
 */

import { PAYLOAD_CONTENTS, type PayloadContent, type ValidationError } from "@/lib/types";

/** What a notification Bundle actually carries, counted once and judged twice. */
export interface PayloadShape {
  /** Entries other than the SubscriptionStatus. */
  entries: number;
  /** Of those, how many carry a `resource`. */
  withResource: number;
  /** Of those, how many carry both a `fullUrl` and a `request`. */
  withUrl: number;
  /** References across every `notificationEvent.focus` and `.additionalContext`. */
  references: number;
}

/** Where to hang each kind of finding, so the UI can point at the right place. */
export interface PayloadLocations {
  bundle: string;
  notificationEvent: string;
}

/** Count what the Bundle carries. `statusIndex` is the SubscriptionStatus entry. */
export function payloadShape(
  entries: readonly unknown[],
  statusIndex: number,
  status: Record<string, unknown>,
): PayloadShape {
  const shape: PayloadShape = { entries: 0, withResource: 0, withUrl: 0, references: 0 };

  entries.forEach((entry, index) => {
    if (index === statusIndex) return;
    shape.entries += 1;

    const object = asObject(entry);
    if (!object) return;
    if (object.resource !== undefined) shape.withResource += 1;
    if (object.fullUrl !== undefined && object.request !== undefined) shape.withUrl += 1;
  });

  const events = Array.isArray(status.notificationEvent) ? status.notificationEvent : [];
  for (const event of events) {
    const object = asObject(event);
    if (!object) continue;
    if (object.focus !== undefined) shape.references += 1;
    if (Array.isArray(object.additionalContext)) shape.references += object.additionalContext.length;
  }

  return shape;
}

/** The payload levels this Bundle could legitimately have been sent under. */
export function compatiblePayloadContents(shape: PayloadShape): PayloadContent[] {
  return PAYLOAD_CONTENTS.filter((content) => violations(content, shape).length === 0);
}

/**
 * Check a notification's payload, against the expected level when there is one
 * and against all three otherwise.
 */
export function validatePayloadShape(
  shape: PayloadShape,
  expected: PayloadContent | null,
  locations: PayloadLocations,
  errors: ValidationError[],
): void {
  if (expected) {
    for (const violation of violations(expected, shape)) {
      errors.push({
        severity: "warning",
        location: violation.reference ? locations.notificationEvent : locations.bundle,
        message: violation.message,
      });
    }
    return;
  }

  if (compatiblePayloadContents(shape).length === 0) {
    errors.push({
      severity: "warning",
      location: locations.bundle,
      message: `This notification matches none of the payload types (${PAYLOAD_CONTENTS.join(
        ", ",
      )}): it carries ${describe(shape)}.`,
    });
  }
}

interface Violation {
  message: string;
  /** True when the problem is with the references rather than the entries. */
  reference: boolean;
}

/** Every way `shape` fails to be a `content` payload. Empty means it qualifies. */
function violations(content: PayloadContent, shape: PayloadShape): Violation[] {
  const found: Violation[] = [];

  if (content === "empty") {
    if (shape.entries > 0) {
      found.push({
        message: `An "empty" payload carries no entries besides the SubscriptionStatus; found ${count(
          shape.entries,
          "entry",
          "entries",
        )}.`,
        reference: false,
      });
    }
    if (shape.references > 0) {
      found.push({
        message: `An "empty" payload references no resources; found ${count(
          shape.references,
          "reference",
          "references",
        )}.`,
        reference: true,
      });
    }
    return found;
  }

  // Both id-only and full-resource name the resources that changed.
  if (shape.references === 0) {
    found.push({
      message: `An "${content}" payload references the resources that changed in notificationEvent.focus; none was sent.`,
      reference: true,
    });
  }

  if (content === "id-only") {
    if (shape.withResource > 0) {
      found.push({
        message: `An "id-only" payload carries no resource content; ${count(
          shape.withResource,
          "entry includes",
          "entries include",
        )} a resource.`,
        reference: false,
      });
    }
    if (shape.entries > shape.withUrl) {
      found.push({
        message: `An "id-only" entry identifies its resource by fullUrl and request; ${count(
          shape.entries - shape.withUrl,
          "entry does",
          "entries do",
        )} not.`,
        reference: false,
      });
    }
    return found;
  }

  if (shape.entries === 0) {
    found.push({
      message:
        'A "full-resource" payload carries the resources themselves; this Bundle has no entries besides the SubscriptionStatus.',
      reference: false,
    });
  } else if (shape.entries > shape.withResource) {
    found.push({
      message: `A "full-resource" entry carries its resource in entry.resource; ${count(
        shape.entries - shape.withResource,
        "entry does",
        "entries do",
      )} not.`,
      reference: false,
    });
  }

  return found;
}

/** "2 entries, 1 of them with resource content, and 0 references". */
function describe(shape: PayloadShape): string {
  return `${count(shape.entries, "entry", "entries")}, ${shape.withResource} of them with resource content, and ${count(
    shape.references,
    "reference",
    "references",
  )}`;
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

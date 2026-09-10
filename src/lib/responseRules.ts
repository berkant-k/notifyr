/**
 * Response overrides.
 *
 * Notifyr normally answers 200 for a valid notification. Switching a
 * notification type off makes it answer a chosen error status instead, so you
 * can watch how a FHIR server reacts — whether it retries a rejected handshake,
 * how many heartbeat failures it tolerates before marking a Subscription in
 * error, and so on.
 *
 * The message is still received, validated, stored and counted exactly as
 * normal. Only the status on the wire changes.
 */

import {
  BODILESS_STATUSES,
  MAX_OVERRIDE_STATUS,
  MIN_OVERRIDE_STATUS,
  OVERRIDABLE_NOTIFICATION_TYPES,
  type OverridableNotificationType,
  type ResponseRule,
  type ResponseRules,
} from "@/lib/types";

export const OVERRIDE_STATUS_RULES = `A whole number from ${MIN_OVERRIDE_STATUS} to ${MAX_OVERRIDE_STATUS}. 200 means "switched on", so it cannot be used here.`;

export type StatusCheck = { ok: true; status: number } | { ok: false; error: string };

/**
 * Validate a status a user wants Notifyr to answer with.
 *
 * The bounds are not arbitrary: the Fetch `Response` constructor throws a
 * RangeError outside 200-599, so anything else would turn into a 500 at
 * response time rather than a clear message here.
 */
export function validateOverrideStatus(value: unknown): StatusCheck {
  const status = typeof value === "string" ? Number(value.trim()) : value;

  if (typeof status !== "number" || !Number.isInteger(status)) {
    return { ok: false, error: `Status must be a whole number. ${OVERRIDE_STATUS_RULES}` };
  }
  if (status === 200) {
    return {
      ok: false,
      error: 'Use the switch to answer 200; an override must be something other than 200.',
    };
  }
  if (status < MIN_OVERRIDE_STATUS || status > MAX_OVERRIDE_STATUS) {
    return { ok: false, error: `Status ${status} is out of range. ${OVERRIDE_STATUS_RULES}` };
  }

  return { ok: true, status };
}

export type RulesCheck = { ok: true; rules: Partial<ResponseRules> } | { ok: false; error: string };

/**
 * Validate a patch of response rules from the client. Accepts a partial object
 * so the UI can send just the type it changed.
 */
export function validateResponseRulesPatch(body: unknown): RulesCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object of notification types." };
  }

  const patch: Partial<ResponseRules> = {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!(OVERRIDABLE_NOTIFICATION_TYPES as readonly string[]).includes(key)) {
      return {
        ok: false,
        error: `Unknown notification type "${key}". Expected one of: ${OVERRIDABLE_NOTIFICATION_TYPES.join(", ")}.`,
      };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: `"${key}" must be an object with enabled and status.` };
    }

    const rule = value as Record<string, unknown>;
    if (typeof rule.enabled !== "boolean") {
      return { ok: false, error: `"${key}.enabled" must be true or false.` };
    }

    // The status is validated even while enabled, so a value the user typed
    // before flipping the switch back on cannot be stored in an unusable state.
    const check = validateOverrideStatus(rule.status);
    if (!check.ok) {
      return { ok: false, error: `"${key}.status": ${check.error}` };
    }

    patch[key as OverridableNotificationType] = { enabled: rule.enabled, status: check.status };
  }

  return { ok: true, rules: patch };
}

/** The status to answer with, or null to answer normally. */
export function overrideFor(
  rules: ResponseRules,
  type: OverridableNotificationType,
): number | null {
  const rule: ResponseRule | undefined = rules[type];
  if (!rule || rule.enabled) return null;
  return rule.status;
}

/** 204, 205 and 304 must be sent without a body or the Response constructor throws. */
export function mustOmitBody(status: number): boolean {
  return BODILESS_STATUSES.includes(status);
}

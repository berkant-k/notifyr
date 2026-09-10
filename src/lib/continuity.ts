/**
 * Stream continuity: what did not arrive.
 *
 * Every other check in Notifyr is triggered by a request and judges its bytes.
 * These two are about absence, and they share one tracking record because they
 * read the same messages at the same moment:
 *
 *   - **Event gaps.** `eventsSinceSubscriptionStart` rides on every notification
 *     type, so a *heartbeat* whose counter jumps from 7 to 11 is how three lost
 *     event-notifications are discovered. Exact, and needs no configuration.
 *   - **Heartbeat liveness.** Needs the period, which only the user knows, and
 *     is a judgement call rather than an exact count — hence a tolerance.
 *
 * Both report warnings. A late heartbeat is the sender's timing against a number
 * the user typed, and a gap is a statement about deliveries that never reached
 * us; neither says the notification in hand is malformed, and grading it invalid
 * would drop it out of the very tallies being watched.
 *
 * Everything here is pure: timestamps and counts come in, findings and the next
 * record come out. See docs/CONTINUITY.md.
 */

import { SPECS } from "@/lib/specs";
import type { NotificationType, SubscriptionContinuity, ValidationError } from "@/lib/types";

/**
 * How far past the period a heartbeat may arrive before it counts as late.
 *
 * A server configured for "every 120 seconds" does not fire at 120.000s —
 * scheduler granularity, delivery time and retries all add jitter — so a check
 * that flags 121s gets switched off within a minute of being switched on. The
 * floor keeps very short periods from being hair-triggered.
 */
const TOLERANCE_FACTOR = 1.5;
const TOLERANCE_FLOOR_SECONDS = 5;

export function heartbeatToleranceSeconds(periodSeconds: number): number {
  return Math.max(periodSeconds * TOLERANCE_FACTOR, periodSeconds + TOLERANCE_FLOOR_SECONDS);
}

/** One notification, reduced to what continuity actually cares about. */
export interface ContinuityObservation {
  /** `SubscriptionStatus.subscription.reference`. */
  reference: string;
  /** ISO 8601, as stamped on the message. */
  receivedAt: string;
  notificationType: NotificationType;
  /** As sent: R4B types it a string, R5 an integer64. */
  eventsSinceSubscriptionStart: string | null;
  /** 0 when the user has not told us the period. */
  heartbeatPeriodSeconds: number;
}

export interface ContinuityUpdate {
  record: SubscriptionContinuity;
  findings: ValidationError[];
}

export function emptyContinuity(reference: string): SubscriptionContinuity {
  return {
    reference,
    lastHeartbeatAt: null,
    lastEventCount: null,
    missedHeartbeats: 0,
    missedEvents: 0,
    restarts: 0,
    lastRestartAt: null,
  };
}

/**
 * Fold one notification into a subscription's record.
 *
 * Callers pass only notifications that *validated*: an unparseable body has not
 * established that it was a heartbeat, or what its event counter said, which is
 * the same rule the per-type counters already follow.
 */
export function observe(
  previous: SubscriptionContinuity | null,
  observation: ContinuityObservation,
): ContinuityUpdate {
  const record: SubscriptionContinuity = previous
    ? { ...previous }
    : emptyContinuity(observation.reference);
  const findings: ValidationError[] = [];

  checkHeartbeat(record, observation, findings);
  checkEventCounter(record, observation, findings);

  return { record, findings };
}

function checkHeartbeat(
  record: SubscriptionContinuity,
  observation: ContinuityObservation,
  findings: ValidationError[],
): void {
  if (observation.notificationType !== "heartbeat") return;

  const period = observation.heartbeatPeriodSeconds;
  const previousAt = record.lastHeartbeatAt;

  // The first heartbeat is never late: there is nothing to measure a gap from.
  // The handshake is deliberately not the start point — the IG does not fix the
  // delay between a subscription going active and its first heartbeat.
  if (period > 0 && previousAt !== null) {
    const gap = secondsBetween(previousAt, observation.receivedAt);

    if (gap !== null && gap > heartbeatToleranceSeconds(period)) {
      const missed = Math.max(Math.floor(gap / period) - 1, 0);
      record.missedHeartbeats += missed;
      findings.push({
        severity: "warning",
        message: `Heartbeat arrived ${Math.round(gap)}s after the previous one; the configured period is ${period}s (about ${missed} missed).`,
        spec: SPECS.errors,
      });
    }
  }

  record.lastHeartbeatAt = observation.receivedAt;
}

function checkEventCounter(
  record: SubscriptionContinuity,
  observation: ContinuityObservation,
  findings: ValidationError[],
): void {
  const count = wholeNumber(observation.eventsSinceSubscriptionStart);
  // A non-numeric counter is already warned about by the validator; inventing a
  // gap from it as well would report one problem twice.
  if (count === null) return;

  const previous = record.lastEventCount;

  if (previous !== null && count < previous) {
    // Counters restart when a Subscription is recreated. That is a new stream,
    // not a loss — so the event side resets and nothing is counted. The
    // heartbeat side is left alone: the channel itself never went quiet.
    findings.push({
      severity: "info",
      message: `Event counter went backwards (${previous} to ${count}); treating this as a restarted subscription and counting from here.`,
      spec: SPECS.errors,
    });
    // Information, not a fault: recreating a Subscription legitimately restarts
    // its counter. Counting 3 -> 1 as two missed events would invent a loss
    // every time someone did that.
    record.missedEvents = 0;
    record.restarts += 1;
    record.lastRestartAt = observation.receivedAt;
  } else if (previous !== null && count > previous + 1) {
    const missed = count - previous - 1;
    record.missedEvents += missed;
    findings.push({
      severity: "warning",
      message: `Event counter jumped from ${previous} to ${count}; ${missed} ${
        missed === 1 ? "notification appears" : "notifications appear"
      } to have been missed.`,
      spec: SPECS.errors,
    });
  }

  record.lastEventCount = count;
}

/** How overdue each subscription's heartbeat is, in seconds. Empty when none is. */
export function overdueHeartbeats(
  continuity: readonly SubscriptionContinuity[],
  periodSeconds: number,
  nowMs: number,
): { reference: string; overdueBySeconds: number }[] {
  if (periodSeconds <= 0) return [];

  const tolerance = heartbeatToleranceSeconds(periodSeconds);

  return continuity.flatMap((record) => {
    if (record.lastHeartbeatAt === null) return [];
    const elapsed = (nowMs - Date.parse(record.lastHeartbeatAt)) / 1000;
    if (!Number.isFinite(elapsed) || elapsed <= tolerance) return [];
    return [{ reference: record.reference, overdueBySeconds: Math.round(elapsed - tolerance) }];
  });
}

/**
 * A value that changes only when the overdue display would change.
 *
 * The dashboard polls with `?since=`, and an unchanged endpoint answers
 * "nothing changed" — so an overdue count, which moves with the clock rather
 * than with the data, would never reach an idle dashboard. Comparing this key
 * between polls lets the client re-render exactly when the number moves, and
 * never when it does not.
 */
export function overdueKey(
  continuity: readonly SubscriptionContinuity[],
  periodSeconds: number,
  nowMs: number,
): string {
  return overdueHeartbeats(continuity, periodSeconds, nowMs)
    .map((entry) => `${entry.reference}:${entry.overdueBySeconds}`)
    .join("|");
}

/** Seconds from one ISO timestamp to another, or null if either is unparseable. */
function secondsBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return (end - start) / 1000;
}

/** The counter as a whole number, in either FHIR form. Null when it is neither. */
function wholeNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

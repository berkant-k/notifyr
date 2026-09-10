/**
 * Arrival against `Subscription.end`: what should have stopped.
 *
 * `Subscription.end` is the instant a subscription is meant to be finished
 * with. A receiver never sees the Subscription, so — like the heartbeat period
 * and the payload level — this can only be checked against an instant the user
 * supplies.
 *
 * Two things make this deliberately unlike the heartbeat check in
 * `lib/continuity`:
 *
 *   - **No tolerance.** A heartbeat gets 1.5x its period because scheduler
 *     jitter makes an exact comparison fire constantly on a healthy server.
 *     The end is a single instant the server agreed to honour, and the question
 *     being asked here is a yes/no one — "is anything still arriving?" — so a
 *     grace window would answer a different question than the one asked.
 *   - **Every message, valid or not.** Continuity needs a notification that
 *     validated, because a gap is measured from a counter inside the body. This
 *     is measured from the clock, which is known whatever the body turned out
 *     to be — and an unparseable POST arriving an hour after the end is still a
 *     server that has not stopped.
 *
 * It reports a warning, for the same reason the other configured checks do:
 * this is the sender's timing against a value the user typed, not a malformed
 * notification, and grading it invalid would drop it out of the very tallies
 * being watched.
 *
 * Pure: an instant and an arrival go in, findings come out.
 */

import { SPECS } from "@/lib/specs";
import type { ValidationError } from "@/lib/types";

/** True when `receivedAt` is past `expectedEnd`. False when either is unusable. */
export function isAfterExpectedEnd(expectedEnd: string | null, receivedAt: string): boolean {
  return overshootSeconds(expectedEnd, receivedAt) !== null;
}

/**
 * The finding for one arrival, or none.
 *
 * Empty when the check is off, when either timestamp is unparseable, or when
 * the notification arrived in time. An unparseable stored deadline is silence
 * rather than a complaint: the route rejects those on the way in, so one here
 * would be Notifyr's own bug and not something the user can act on.
 */
export function checkExpectedEnd(
  expectedEnd: string | null,
  receivedAt: string,
): ValidationError[] {
  const overshoot = overshootSeconds(expectedEnd, receivedAt);
  if (overshoot === null) return [];

  return [
    {
      severity: "warning",
      message: `Notification arrived ${overshootLabel(overshoot)} after the expected Subscription.end (${expectedEnd}); the server should have stopped sending by then.`,
      spec: SPECS.subscription,
    },
  ];
}

/**
 * Seconds past the deadline, or null when there is no overshoot to report.
 *
 * The single place the comparison is made, so the boolean the store counts
 * from and the warning the user reads can never disagree about whether one
 * notification was late.
 */
function overshootSeconds(expectedEnd: string | null, receivedAt: string): number | null {
  if (expectedEnd === null) return null;

  const end = Date.parse(expectedEnd);
  const arrived = Date.parse(receivedAt);
  if (Number.isNaN(end) || Number.isNaN(arrived)) return null;

  const seconds = (arrived - end) / 1000;
  return seconds > 0 ? seconds : null;
}

/**
 * "12s", "4m 12s", "2h 5m", "3d 4h" — the two largest units that matter.
 *
 * Not `countdownLabel` from `lib/time`: that formats a deadline still ahead for
 * a gauge that redraws on a timer, and collapses everything past zero to
 * "expired". Here the size of the overshoot is the finding, and it is written
 * once into a stored message that is never recomputed.
 */
export function overshootLabel(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;

  const minutes = Math.floor(whole / 60);
  if (minutes < 60) {
    const rest = whole % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * The instant to store for a user-supplied value, or null when it is not one.
 *
 * Normalising to UTC here means a deadline typed in one zone and read in
 * another is still the same moment, and that the string written into a warning
 * is unambiguous about which moment it names.
 */
export function normaliseExpectedEnd(value: string): string | null {
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

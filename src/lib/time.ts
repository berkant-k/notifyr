/**
 * How timestamps are shown, and when they need redrawing.
 *
 * For a tool watched live, "8s ago" answers the question the clock face does
 * not: is this stream still moving? The exact time is still one hover away, and
 * every rendered timestamp carries a machine-readable `dateTime` alongside it.
 *
 * The fixed `en-GB` locale is deliberate — a value that depends on the viewer's
 * machine cannot be compared against a colleague's screenshot.
 */

/** "just now", "8s ago", "3m ago", "2h ago", "4d ago". */
export function relativeLabel(iso: string, nowMs: number): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";

  const seconds = Math.max(Math.round((nowMs - parsed) / 1000), 0);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

/** Clock time only: 14:22:30. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

/** Date, time and zone, for a tooltip or a detail header. */
export function fullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { hour12: false, timeZoneName: "short" });
}

/**
 * A value that changes exactly when one of these labels would change.
 *
 * The dashboard re-renders when this differs between polls and not otherwise,
 * so a row reading "8s ago" is redrawn every couple of seconds while that is
 * still moving, and a list of hour-old rows is left alone until the hour turns.
 * Same trick as the overdue gauge in `lib/continuity`, for the same reason: the
 * value drifts with the clock rather than with the data.
 */
export function relativeKey(timestamps: readonly string[], nowMs: number): string {
  return timestamps.map((iso) => relativeLabel(iso, nowMs)).join("|");
}

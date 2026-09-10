"use client";

import { useState } from "react";
import { overdueHeartbeats } from "@/lib/continuity";
import { clockTime, relativeLabel as ago } from "@/lib/time";
import {
  NOTIFICATION_TYPE_LABELS,
  NOTIFICATION_TYPES,
  PRIMARY_NOTIFICATION_TYPES,
  type NotificationCounts,
  type NotificationType,
  type SubscriptionContinuity,
} from "@/lib/types";

interface Props {
  counts: NotificationCounts;
  /** One record per Subscription seen. Empty until a notification arrives. */
  continuity: readonly SubscriptionContinuity[];
  /** 0 when the user has not told us the heartbeat period. */
  heartbeatPeriodSeconds: number;
  /** From the poll hook: advances only when the overdue display would change. */
  nowMs: number;
}

/** "Subscription/notifyr-test" out of a full canonical URL. */
function referenceLabel(reference: string): string {
  const match = reference.match(/Subscription\/[A-Za-z0-9\-.]{1,64}/);
  return match ? match[0] : reference;
}

/**
 * Per-type tallies of valid Subscription notifications, plus what did not
 * arrive.
 *
 * The three primary types are always shown, so a zero heartbeat count is
 * visible information rather than a missing tile. Query types appear only once
 * they have actually been received.
 *
 * Misses are shown as a subtitle on the tile they belong to rather than as
 * tiles of their own: they are absences rather than notification types, and a
 * fourth tile reading "Missed 3" beside "Heartbeat 40" invites the reading that
 * 3 of something arrived.
 */
export default function NotificationCounters({
  counts,
  continuity,
  heartbeatPeriodSeconds,
  nowMs,
}: Props) {
  const [open, setOpen] = useState(false);

  const visible = NOTIFICATION_TYPES.filter(
    (type) => PRIMARY_NOTIFICATION_TYPES.includes(type) || counts[type] > 0,
  );
  const total = NOTIFICATION_TYPES.reduce((sum, type) => sum + counts[type], 0);

  const missedHeartbeats = continuity.reduce((sum, record) => sum + record.missedHeartbeats, 0);
  const missedEvents = continuity.reduce((sum, record) => sum + record.missedEvents, 0);
  const overdue = overdueHeartbeats(continuity, heartbeatPeriodSeconds, nowMs);

  const missedFor = (type: NotificationType): number | null => {
    if (type === "heartbeat") return missedHeartbeats > 0 ? missedHeartbeats : null;
    if (type === "event-notification") return missedEvents > 0 ? missedEvents : null;
    return null;
  };

  // Nothing to expand into until a subscription has actually been seen.
  const expandable = continuity.length > 0;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      {/*
        Everything that can appear later lives in a slot that is always here.
        This card sits above the notification list, so anything that grows when
        the first notification lands pushes the list down under whoever is
        reading it — and it lands while they watch.
      */}
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Subscription notifications
        </h2>
        <span className="flex items-baseline gap-3 text-xs text-slate-400">
          {expandable && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              className="font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
            >
              {open ? "Hide continuity" : "Continuity detail"}
            </button>
          )}
          <span>
            {total} valid {total === 1 ? "notification" : "notifications"}
          </span>
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-4">
        {visible.map((type) => {
          const missed = missedFor(type);
          const late = type === "heartbeat" && overdue.length > 0;

          return (
            <div key={type}>
              <dd
                className={`text-2xl font-semibold tabular-nums ${
                  counts[type] > 0 ? "text-slate-900" : "text-slate-300"
                }`}
              >
                {counts[type]}
              </dd>
              <dt className="mt-0.5 truncate text-xs text-slate-500">
                {NOTIFICATION_TYPE_LABELS[type]}
              </dt>
              {/* Reserved whether or not there is anything to say. */}
              <p className="mt-0.5 h-4 text-xs font-medium text-amber-700">
                {missed !== null && `${missed} missed`}
                {missed !== null && late && " · "}
                {late && "overdue"}
              </p>
            </div>
          );
        })}
      </dl>

      {expandable && (
        <>
          {open && (
            <div className="mt-3 space-y-4 border-t border-slate-200 pt-3">
              {continuity.map((record) => {
                const late = overdue.find((entry) => entry.reference === record.reference);
                return (
                  <div key={record.reference} className="text-xs">
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className="truncate font-mono font-medium text-slate-700"
                        title={record.reference}
                      >
                        {referenceLabel(record.reference)}
                      </span>
                      <span className="shrink-0 text-slate-400">
                        {heartbeatPeriodSeconds > 0
                          ? `expected every ${heartbeatPeriodSeconds}s`
                          : "no heartbeat period set"}
                      </span>
                    </div>

                    <dl className="mt-1.5 space-y-1">
                      <Row label="Last heartbeat">
                        {record.lastHeartbeatAt ? (
                          <>
                            {clockTime(record.lastHeartbeatAt)}{" "}
                            <span className="text-slate-400">
                              ({ago(record.lastHeartbeatAt, nowMs)})
                            </span>
                            {late && (
                              <span className="ml-1.5 font-medium text-amber-700">
                                overdue by {late.overdueBySeconds}s
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-slate-400">
                            none yet — waiting for the first heartbeat
                          </span>
                        )}
                      </Row>
                      <Row label="Missed heartbeats">
                        {heartbeatPeriodSeconds > 0 ? (
                          record.missedHeartbeats
                        ) : (
                          <span className="text-slate-400">not checked without a period</span>
                        )}
                      </Row>
                      <Row label="Event counter">
                        {record.lastEventCount ?? <span className="text-slate-400">—</span>}
                        {record.missedEvents > 0 && (
                          <span className="ml-1.5 font-medium text-amber-700">
                            {record.missedEvents} missed
                          </span>
                        )}
                      </Row>
                      {/*
                        Only once it has happened. One restart is a Subscription
                        being recreated; a count climbing is a server restarting
                        one nobody asked it to, and that pattern is invisible in
                        a per-message note.
                      */}
                      {record.restarts > 0 && (
                        <Row label="Counter restarts">
                          {record.restarts}
                          {record.lastRestartAt && (
                            <span className="ml-1.5 text-slate-400">
                              last {ago(record.lastRestartAt, nowMs)}
                            </span>
                          )}
                        </Row>
                      )}
                    </dl>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-36 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 flex-1 font-mono text-slate-700">{children}</dd>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { fullTimestamp, relativeLabel } from "@/lib/time";
import type { Message, ValidationError } from "@/lib/types";

interface Props {
  messages: Message[];
  /** From the poll hook: advances only when a displayed label would change. */
  nowMs: number;
  onSelect: (message: Message) => void;
}

/**
 * A topic is a canonical URL, far too long for a table cell. The last segment
 * is the part that identifies it ("encounter-complete"); the full value stays
 * available as a tooltip, and in the raw body in the detail view.
 */
function topicLabel(topic: string): string {
  const trimmed = topic.replace(/\/+$/, "");
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return lastSegment === "" ? topic : lastSegment;
}

/** Column widths shared by the header and every row, so they line up. */
const COLUMNS = {
  time: "w-20 shrink-0",
  validity: "w-16 shrink-0",
  findings: "w-4 shrink-0",
  status: "w-10 shrink-0",
  summary: "min-w-0 flex-1",
  // Hidden on narrow screens: the detail view carries the same values.
  events: "hidden w-14 shrink-0 text-right md:block",
  topic: "hidden w-40 shrink-0 md:block",
};

/** Shown when a notification did not carry the field, or was not a notification. */
function Empty() {
  return <span className="text-slate-300">—</span>;
}

/**
 * A dot when a row carries findings worth opening it for.
 *
 * Errors are already announced by the Invalid badge, so this speaks for the
 * ones that leave a message valid: a late heartbeat, a payload mismatch, a
 * counter restart. Without it those are invisible from the list, and the only
 * way to find them is to open all ten rows.
 */
function FindingsDot({ errors }: { errors: ValidationError[] }) {
  const warnings = errors.filter((issue) => issue.severity === "warning").length;
  const infos = errors.filter((issue) => issue.severity === "info").length;
  if (warnings === 0 && infos === 0) return null;

  const label = [
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null,
    infos > 0 ? `${infos} note${infos === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${
        warnings > 0 ? "bg-amber-500" : "bg-slate-400"
      }`}
      title={label}
      aria-hidden
    />
  );
}

function ValidityBadge({ isValid }: { isValid: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
        isValid ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
      }`}
    >
      {isValid ? "Valid" : "Invalid"}
    </span>
  );
}

/**
 * The most recent notifications, newest first. Rows open the detail modal.
 *
 * The arrival animation is driven by ids this component has not rendered
 * before, not by a row being new to the DOM. Otherwise it fires on everything
 * that merely re-mounts rows — the first paint, a filter change, a "Show more"
 * — and an emerald flash that does not mean "this just arrived" is worse than
 * no flash at all.
 */
export default function MessageList({ messages, nowMs, onSelect }: Props) {
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const [arrived, setArrived] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const known = seen.current;

    // The rows present on the first pass are history, not arrivals.
    if (!seeded.current) {
      seeded.current = true;
      for (const message of messages) known.add(message.id);
      return;
    }

    const fresh = messages.filter((message) => !known.has(message.id));
    for (const message of fresh) known.add(message.id);
    if (fresh.length > 0) setArrived(new Set(fresh.map((message) => message.id)));
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        No notifications yet. POST a FHIR resource to the webhook URL.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="sticky top-0 z-10 flex items-center gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        <span className={COLUMNS.time}>Time</span>
        <span className={COLUMNS.validity}>Result</span>
        <span className={COLUMNS.findings} title="Warnings and notes" />
        <span className={COLUMNS.status}>HTTP</span>
        <span className={COLUMNS.summary}>Summary</span>
        <span className={COLUMNS.events} title="SubscriptionStatus.eventsSinceSubscriptionStart">
          Events
        </span>
        <span className={COLUMNS.topic} title="SubscriptionStatus.topic">
          Topic
        </span>
      </div>

      <ul className="divide-y divide-slate-200">
        {messages.map((message) => (
          <li key={message.id} className={arrived.has(message.id) ? "message-row-enter" : undefined}>
            <button
              type="button"
              onClick={() => onSelect(message)}
              className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-slate-50"
            >
              {/*
                Relative, because the question a live list answers is "is this
                still moving?" — a clock face makes you do the arithmetic. The
                exact time is one hover away and machine-readable either way.
              */}
              <time
                dateTime={message.receivedAt}
                title={fullTimestamp(message.receivedAt)}
                className={`${COLUMNS.time} font-mono text-xs text-slate-500`}
              >
                {relativeLabel(message.receivedAt, nowMs)}
              </time>
              <span className={COLUMNS.validity}>
                <ValidityBadge isValid={message.isValid} />
              </span>
              {/* Fixed-width whether or not there is a dot, so rows never shift. */}
              <span className={`${COLUMNS.findings} flex justify-center`}>
                <FindingsDot errors={message.validationErrors} />
              </span>
              <span
                className={`${COLUMNS.status} font-mono text-xs ${
                  message.statusOverridden ? "font-semibold text-amber-700" : "text-slate-500"
                }`}
                title={
                  message.statusOverridden
                    ? "Forced by a response override, not by validation"
                    : undefined
                }
              >
                {message.status}
                {message.statusOverridden && "*"}
              </span>
              <span className={`${COLUMNS.summary} min-w-0`}>
                <span className="block truncate text-sm text-slate-800">{message.summary}</span>
                {/*
                  Below `md` the Events and Topic columns are dropped for width,
                  which took the most FHIR-specific values on the row with them.
                  They come back here as a second line rather than disappearing.
                */}
                {(message.eventsSinceSubscriptionStart !== null || message.topic !== null) && (
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500 md:hidden">
                    {message.eventsSinceSubscriptionStart !== null &&
                      `${message.eventsSinceSubscriptionStart} events`}
                    {message.eventsSinceSubscriptionStart !== null && message.topic !== null && " · "}
                    {message.topic !== null && topicLabel(message.topic)}
                  </span>
                )}
              </span>
              <span className={`${COLUMNS.events} font-mono text-xs tabular-nums text-slate-600`}>
                {message.eventsSinceSubscriptionStart ?? <Empty />}
              </span>
              <span className={`${COLUMNS.topic} truncate font-mono text-xs text-slate-600`}>
                {message.topic ? (
                  <span title={message.topic}>{topicLabel(message.topic)}</span>
                ) : (
                  <Empty />
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

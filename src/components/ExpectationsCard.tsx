"use client";

import { useState } from "react";
import InfoTip from "@/components/InfoTip";
import { fullTimestamp } from "@/lib/time";
import {
  EXPECTED_END_RULES,
  HEARTBEAT_PERIOD_RULES,
  MAX_HEARTBEAT_PERIOD_SECONDS,
  MIN_HEARTBEAT_PERIOD_SECONDS,
  PAYLOAD_CONTENT_DESCRIPTIONS,
  PAYLOAD_CONTENTS,
  type PayloadContent,
} from "@/lib/types";

interface Props {
  endpointId: string;
  expectedPayloadContent: PayloadContent | null;
  heartbeatPeriodSeconds: number;
  /** The stored deadline, ISO 8601 in UTC. Null when the check is off. */
  expectedEnd: string | null;
  /** Cumulative notifications received after it. */
  afterEndCount: number;
  /** Poll immediately so the rest of the dashboard reflects a change. */
  onChanged: () => void;
}

/**
 * Three things a Subscription carries that a receiver never sees: the payload
 * level, the heartbeat period, and when it should stop. One card rather than
 * three, because they answer the same question — "what did you configure,
 * since Notifyr cannot see the Subscription itself" — and each is independent
 * underneath: its own field, its own save, its own endpoint. A save in one
 * never touches the other two.
 */
export default function ExpectationsCard({
  endpointId,
  expectedPayloadContent,
  heartbeatPeriodSeconds,
  expectedEnd,
  afterEndCount,
  onChanged,
}: Props) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">Expectations</h2>

      <PayloadField endpointId={endpointId} expected={expectedPayloadContent} onChanged={onChanged} />

      <div className="mt-3 border-t border-slate-200 pt-3">
        <HeartbeatField
          endpointId={endpointId}
          seconds={heartbeatPeriodSeconds}
          onChanged={onChanged}
        />
      </div>

      <div className="mt-3 border-t border-slate-200 pt-3">
        <SubscriptionEndField
          endpointId={endpointId}
          expectedEnd={expectedEnd}
          afterEndCount={afterEndCount}
          onChanged={onChanged}
        />
      </div>
    </section>
  );
}

/** The select's value for "not set"; the wire format uses null. */
const UNSET = "";

/**
 * Expected payload content.
 *
 * `backport-payload-content` is configured on the Subscription, which Notifyr
 * never sees, so the exact per-level rules can only be checked if the user says
 * which level they set. Left unset, notifications are still checked for
 * internal consistency — a Bundle matching none of the three levels is reported
 * either way.
 *
 * A mismatch is a warning, never an error: it means the sender and this
 * dropdown disagree, which is as often a mistyped expectation as a server bug,
 * and grading it invalid would pull the notification out of the per-type
 * counters.
 */
function PayloadField({
  endpointId,
  expected,
  onChanged,
}: {
  endpointId: string;
  expected: PayloadContent | null;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(value: PayloadContent | null) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/endpoints/${endpointId}/payload-content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPayloadContent: value }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? `Server responded ${response.status}`);
        return;
      }
      onChanged();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-slate-600">Payload level</h3>
        <InfoTip label="About the expected payload level">
          The <code className="font-mono">backport-payload-content</code> level set on your
          Subscription. Notifyr cannot see it, so telling it here lets event-notifications be
          checked against that exact level. Mismatches are warnings and never change whether a
          notification counts as valid. Unset, notifications are still checked for internal
          consistency.
          <ul className="mt-2 space-y-1">
            {PAYLOAD_CONTENTS.map((content) => (
              <li key={content}>
                <code className="font-mono text-slate-800">{content}</code> —{" "}
                {PAYLOAD_CONTENT_DESCRIPTIONS[content]}
              </li>
            ))}
          </ul>
        </InfoTip>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <label htmlFor="expected-payload" className="text-sm text-slate-800">
          Level
        </label>
        <select
          id="expected-payload"
          value={expected ?? UNSET}
          disabled={saving}
          onChange={(event) =>
            void save(event.target.value === UNSET ? null : (event.target.value as PayloadContent))
          }
          className="rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:opacity-50"
        >
          <option value={UNSET}>not set</option>
          {PAYLOAD_CONTENTS.map((content) => (
            <option key={content} value={content}>
              {content}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/** 0, or inside the supported range. Mirrors what the route accepts. */
function isAcceptableHeartbeat(value: number): boolean {
  if (!Number.isInteger(value)) return false;
  return (
    value === 0 ||
    (value >= MIN_HEARTBEAT_PERIOD_SECONDS && value <= MAX_HEARTBEAT_PERIOD_SECONDS)
  );
}

/**
 * Expected heartbeat period.
 *
 * `backport-heartbeat-period` is set on the Subscription, which a receiver never
 * sees, so a heartbeat can only be judged late against a number the user
 * supplies. Event gaps need none of this — the sender carries the sequence — so
 * they are tracked whether or not this is set.
 *
 * The value is held locally while typing, like the response-override status box:
 * without that, a poll landing mid-edit would yank the field back.
 */
function HeartbeatField({
  endpointId,
  seconds,
  onChanged,
}: {
  endpointId: string;
  seconds: number;
  onChanged: () => void;
}) {
  const [text, setText] = useState(String(seconds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(text.trim());
  const invalid = text.trim() === "" || !isAcceptableHeartbeat(parsed);

  async function commit() {
    if (invalid || parsed === seconds) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/endpoints/${endpointId}/heartbeat-period`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ heartbeatPeriodSeconds: parsed }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? `Server responded ${response.status}`);
        return;
      }
      onChanged();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-slate-600">Heartbeat period</h3>
        <InfoTip label="About the heartbeat period">
          The <code className="font-mono">backport-heartbeat-period</code> set on your
          Subscription. Notifyr cannot see it, so telling it here lets a late heartbeat be
          reported as a warning and counted. Missed <em>events</em> are tracked either way.{" "}
          {HEARTBEAT_PERIOD_RULES}
        </InfoTip>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <label htmlFor="heartbeat-period" className="text-sm text-slate-800">
          Seconds
        </label>
        <input
          id="heartbeat-period"
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_HEARTBEAT_PERIOD_SECONDS}
          value={text}
          disabled={saving}
          aria-invalid={invalid}
          aria-describedby={error ? "heartbeat-period-error" : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={`w-24 rounded-md border px-2 py-1 text-right font-mono text-xs focus:outline-none disabled:opacity-50 ${
            invalid
              ? "border-rose-400 bg-rose-50 text-rose-900"
              : "border-slate-300 focus:border-slate-500"
          }`}
        />
      </div>

      {invalid && <p className="mt-2 text-xs text-rose-700">{HEARTBEAT_PERIOD_RULES}</p>}

      {error && (
        <p
          id="heartbeat-period-error"
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A UTC instant as the local wall time a `datetime-local` expects
 * (`YYYY-MM-DDTHH:mm:ss`).
 *
 * `toISOString` cannot be used: it would put UTC into a control the browser
 * reads as local time, shifting the displayed deadline by the viewer's offset
 * every time the card mounted.
 */
function toLocalInput(iso: string | null): string {
  if (iso === null) return "";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Expected `Subscription.end`.
 *
 * The instant the server agreed to stop sending. Notifyr cannot see the
 * Subscription, so telling it here is what lets a notification arriving
 * afterwards be reported — as a warning on the message, and as the running
 * count shown below the field.
 *
 * The control is a `datetime-local`, which has no timezone: the browser reads
 * it as local wall time. That is the right default for "stop about ten minutes
 * from now", and wrong for anyone holding an exact instant from their
 * Subscription — so the UTC instant actually stored is echoed underneath, where
 * a mismatched offset is visible before it produces confusing warnings.
 */
function SubscriptionEndField({
  endpointId,
  expectedEnd,
  afterEndCount,
  onChanged,
}: {
  endpointId: string;
  expectedEnd: string | null;
  afterEndCount: number;
  onChanged: () => void;
}) {
  const [text, setText] = useState(() => toLocalInput(expectedEnd));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const invalid = trimmed !== "" && Number.isNaN(Date.parse(trimmed));

  async function commit() {
    if (invalid) return;

    // A `datetime-local` value carries no offset, so it is resolved here in the
    // viewer's zone and sent as a real instant rather than left for the server
    // to guess a zone it has no way to know.
    const next = trimmed === "" ? null : new Date(trimmed).toISOString();
    if (next === expectedEnd) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/endpoints/${endpointId}/expected-end`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedEnd: next }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? `Server responded ${response.status}`);
        return;
      }
      onChanged();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-slate-600">Subscription end</h3>
        <InfoTip label="About the expected end">
          The <code className="font-mono">end</code> set on your Subscription — the instant it
          should stop sending. Notifyr cannot see it, so telling it here lets anything arriving
          afterwards be flagged on the message and counted. Times are entered in your own
          timezone and stored as UTC. {EXPECTED_END_RULES}
        </InfoTip>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        <label htmlFor="expected-end" className="text-sm text-slate-800">
          Expected expiry
        </label>
        <input
          id="expected-end"
          type="datetime-local"
          step={1}
          value={text}
          disabled={saving}
          aria-invalid={invalid}
          aria-describedby={error ? "expected-end-error" : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={`w-full rounded-md border px-2 py-1 font-mono text-xs focus:outline-none disabled:opacity-50 ${
            invalid
              ? "border-rose-400 bg-rose-50 text-rose-900"
              : "border-slate-300 focus:border-slate-500"
          }`}
        />
      </div>

      {/*
        The stored instant, not a reformatting of the box above: this is the
        value warnings are measured against, and seeing it is how a wrong
        timezone is caught before it explains a run of surprising findings.
      */}
      {expectedEnd !== null && (
        <p className="mt-2 text-xs text-slate-500">
          Stored as <time dateTime={expectedEnd} className="font-mono">{expectedEnd}</time>
          <span className="block text-slate-400">{fullTimestamp(expectedEnd)} in your timezone</span>
        </p>
      )}

      {expectedEnd === null && !invalid && (
        <p className="mt-2 text-xs text-slate-500">Not set — arrival times are not checked.</p>
      )}

      {invalid && <p className="mt-2 text-xs text-rose-700">{EXPECTED_END_RULES}</p>}

      {/*
        Cumulative, so this still answers "did anything arrive late?" after the
        messages that proved it have been trimmed out of the retained list.
      */}
      {afterEndCount > 0 && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold tabular-nums">{afterEndCount}</span>{" "}
          {afterEndCount === 1 ? "notification has" : "notifications have"} arrived after the end.
        </p>
      )}

      {error && (
        <p
          id="expected-end-error"
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
        >
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import InfoTip from "@/components/InfoTip";
import { fullTimestamp } from "@/lib/time";
import { EXPECTED_END_RULES } from "@/lib/types";

interface Props {
  endpointId: string;
  /** The stored deadline, ISO 8601 in UTC. Null when the check is off. */
  expectedEnd: string | null;
  /** Cumulative notifications received after it. */
  afterEndCount: number;
  /** Poll immediately so the rest of the dashboard reflects the change. */
  onChanged: () => void;
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
export default function SubscriptionEndCard({
  endpointId,
  expectedEnd,
  afterEndCount,
  onChanged,
}: Props) {
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
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Subscription end
        </h2>
        <InfoTip label="About the expected end">
          The <code className="font-mono">end</code> set on your Subscription — the instant it
          should stop sending. Notifyr cannot see it, so telling it here lets anything arriving
          afterwards be flagged on the message and counted. Times are entered in your own
          timezone and stored as UTC. {EXPECTED_END_RULES}
        </InfoTip>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
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
        <p className="mt-2 text-xs text-slate-500">
          Not set — arrival times are not checked.
        </p>
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
    </section>
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

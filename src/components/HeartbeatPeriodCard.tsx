"use client";

import { useState } from "react";
import InfoTip from "@/components/InfoTip";
import {
  HEARTBEAT_PERIOD_RULES,
  MAX_HEARTBEAT_PERIOD_SECONDS,
  MIN_HEARTBEAT_PERIOD_SECONDS,
} from "@/lib/types";

interface Props {
  endpointId: string;
  seconds: number;
  /** Poll immediately so the rest of the dashboard reflects the change. */
  onChanged: () => void;
}

/** 0, or inside the supported range. Mirrors what the route accepts. */
function isAcceptable(value: number): boolean {
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
export default function HeartbeatPeriodCard({ endpointId, seconds, onChanged }: Props) {
  const [text, setText] = useState(String(seconds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(text.trim());
  const invalid = text.trim() === "" || !isAcceptable(parsed);

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
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Heartbeat period
        </h2>
        <InfoTip label="About the heartbeat period">
          The <code className="font-mono">backport-heartbeat-period</code> set on your
          Subscription. Notifyr cannot see it, so telling it here lets a late heartbeat be
          reported as a warning and counted. Missed <em>events</em> are tracked either way.
          {" "}
          {HEARTBEAT_PERIOD_RULES}
        </InfoTip>
      </div>

      <div className="mt-3 flex items-center gap-3">
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

      {invalid && (
        <p className="mt-2 text-xs text-rose-700">{HEARTBEAT_PERIOD_RULES}</p>
      )}

      {error && (
        <p
          id="heartbeat-period-error"
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
        >
          {error}
        </p>
      )}
    </section>
  );
}

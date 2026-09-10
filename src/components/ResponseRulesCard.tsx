"use client";

import { useState } from "react";
import InfoTip from "@/components/InfoTip";
import { OVERRIDE_STATUS_RULES, validateOverrideStatus } from "@/lib/responseRules";
import {
  DEFAULT_OVERRIDE_STATUS,
  MAX_OVERRIDE_STATUS,
  MIN_OVERRIDE_STATUS,
  NOTIFICATION_TYPE_LABELS,
  OVERRIDABLE_NOTIFICATION_TYPES,
  type OverridableNotificationType,
  type ResponseRules,
} from "@/lib/types";

interface Props {
  endpointId: string;
  rules: ResponseRules;
  /** Poll immediately so the rest of the dashboard reflects the change. */
  onChanged: () => void;
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-emerald-500 hover:bg-emerald-600" : "bg-slate-300 hover:bg-slate-400"
      }`}
    >
      {/*
        `left-0.5` is load-bearing. Without an explicit inset the knob falls back
        to its static position, and a button's default `text-align: center` puts
        that at the middle of the pill — so "on" shifted the knob off the edge
        and out of sight.
      */}
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/**
 * Status box.
 *
 * Holds the text locally so typing "500" does not fire a save for "5" and "50",
 * and so a poll landing mid-edit cannot yank the cursor. The parent remounts it
 * (via `key`) whenever the committed value changes, which keeps it in step with
 * the server without an effect.
 */
function StatusInput({
  initial,
  disabled,
  label,
  onCommit,
}: {
  initial: number;
  disabled: boolean;
  label: string;
  onCommit: (status: number) => void;
}) {
  const [text, setText] = useState(String(initial));

  function commit() {
    if (text === String(initial)) return;
    const check = validateOverrideStatus(text);
    if (check.ok) onCommit(check.status);
  }

  const invalid = !validateOverrideStatus(text).ok;

  return (
    <input
      type="number"
      inputMode="numeric"
      min={MIN_OVERRIDE_STATUS}
      max={MAX_OVERRIDE_STATUS}
      value={text}
      disabled={disabled}
      aria-label={label}
      aria-invalid={invalid}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={`w-20 rounded-md border px-2 py-1 text-right font-mono text-xs focus:outline-none disabled:opacity-50 ${
        invalid
          ? "border-rose-400 bg-rose-50 text-rose-900"
          : "border-amber-300 bg-amber-50 text-amber-900 focus:border-amber-500"
      }`}
    />
  );
}

/**
 * Per-notification-type response overrides.
 *
 * Switching a type off makes the webhook answer an error status instead of its
 * normal one, so a FHIR server's retry and error handling can be exercised. The
 * notification is still received, validated, stored and counted — only the
 * status on the wire changes.
 */
export default function ResponseRulesCard({ endpointId, rules, onChanged }: Props) {
  const [saving, setSaving] = useState<OverridableNotificationType | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(type: OverridableNotificationType, enabled: boolean, status: number) {
    setSaving(type);
    setError(null);
    try {
      const response = await fetch(`/api/endpoints/${endpointId}/response-rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [type]: { enabled, status } }),
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
      setSaving(null);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Response overrides
        </h2>
        <InfoTip label="About response overrides">
          Switch a type off to answer it with an error instead of 200, and watch how your FHIR
          server reacts. Notifications are still received, validated and counted either way.
          {" "}
          {OVERRIDE_STATUS_RULES}
        </InfoTip>
      </div>

      <ul className="mt-3 space-y-2.5">
        {OVERRIDABLE_NOTIFICATION_TYPES.map((type) => {
          const rule = rules[type];
          const label = NOTIFICATION_TYPE_LABELS[type];
          const busy = saving === type;

          return (
            <li key={type} className="flex items-center gap-3">
              <Toggle
                checked={rule.enabled}
                disabled={busy}
                label={`Respond normally to ${label} notifications`}
                onChange={(next) =>
                  // A stored 200 would be unusable as an override; fall back to
                  // the suggested status.
                  void save(type, next, rule.status === 200 ? DEFAULT_OVERRIDE_STATUS : rule.status)
                }
              />
              <span className="flex-1 text-sm text-slate-800">{label}</span>

              {rule.enabled ? (
                <span className="w-20 text-right font-mono text-xs text-slate-400">200</span>
              ) : (
                <StatusInput
                  key={`${type}-${rule.status}`}
                  initial={rule.status}
                  disabled={busy}
                  label={`Status returned for ${label} notifications`}
                  onCommit={(status) => void save(type, false, status)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
        >
          {error}
        </p>
      )}

    </section>
  );
}

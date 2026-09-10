"use client";

import { useState } from "react";
import InfoTip from "@/components/InfoTip";
import {
  PAYLOAD_CONTENT_DESCRIPTIONS,
  PAYLOAD_CONTENTS,
  type PayloadContent,
} from "@/lib/types";

interface Props {
  endpointId: string;
  expected: PayloadContent | null;
  /** Poll immediately so the rest of the dashboard reflects the change. */
  onChanged: () => void;
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
export default function PayloadExpectationCard({ endpointId, expected, onChanged }: Props) {
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
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Expected payload
        </h2>
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

      <div className="mt-3 flex items-center gap-3">
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
    </section>
  );
}

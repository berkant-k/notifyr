"use client";

import { useState } from "react";
import InfoTip from "@/components/InfoTip";
import { isResourceTypeName, type ResourceCounts } from "@/lib/types";

interface Props {
  endpointId: string;
  /** User-supplied targets, e.g. { Encounter: 2 }. Empty means nothing configured. */
  expected: ResourceCounts;
  /** Cumulative arrivals, tallied from valid event-notifications only. */
  actual: ResourceCounts;
  /** Poll immediately so the rest of the dashboard reflects the change. */
  onChanged: () => void;
}

interface Row {
  id: number;
  type: string;
  count: string;
}

let nextRowId = 0;

function rowsFrom(expected: ResourceCounts): Row[] {
  return Object.entries(expected).map(([type, count]) => ({
    id: nextRowId++,
    type,
    count: String(count),
  }));
}

/**
 * Expected resource counts, e.g. "2 Encounter, 1 Patient".
 *
 * A different axis from the notification-type counters above: those tally
 * `SubscriptionStatus.type` (handshake / heartbeat / event-notification...),
 * a closed enum. This tallies the FHIR resource type named by each
 * `notificationEvent.focus` on a valid event-notification — an open set, so
 * the whole map is edited and replaced together rather than toggled per type.
 *
 * Progress is a readout, not a gate: arriving past target isn't wrong, and
 * under target isn't either mid-run, so there is no pass/fail styling here —
 * only the same "expected vs arrived" comparison the payload and heartbeat
 * cards already make.
 */
export default function ExpectedResourceCountsCard({
  endpointId,
  expected,
  actual,
  onChanged,
}: Props) {
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(expected));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(id: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [...current, { id: nextRowId++, type: "", count: "1" }]);
  }

  function removeRow(id: number) {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  async function save() {
    // Blank rows are dropped rather than rejected: a row added and left empty
    // is an edit in progress, not a submission the user asked to be told off for.
    const named = rows.filter((row) => row.type.trim() !== "");

    for (const row of named) {
      if (!isResourceTypeName(row.type.trim())) {
        setError(`"${row.type}" is not a FHIR resource type name — expected PascalCase, e.g. "Encounter".`);
        return;
      }
      if (!/^\d+$/.test(row.count.trim())) {
        setError(`The count for "${row.type}" must be a whole number.`);
        return;
      }
    }

    const payload: ResourceCounts = {};
    for (const row of named) payload[row.type.trim()] = Number(row.count.trim());

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/endpoints/${endpointId}/resource-counts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedResourceCounts: payload }),
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

  // Every type either side has an opinion about, so a type already arriving
  // shows up even before it is ever typed into a row.
  const progressTypes = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort();

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Expected resource counts
        </h2>
        <InfoTip label="About expected resource counts">
          How many notifications you expect for each FHIR resource type, e.g. 2 Encounter and 1
          Patient. Counted from <code className="font-mono">notificationEvent.focus</code> on valid
          event-notifications only. This is a progress readout, not a pass/fail check — arriving past
          the target isn&rsquo;t wrong.
        </InfoTip>
      </div>

      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Encounter"
              value={row.type}
              disabled={saving}
              onChange={(event) => updateRow(row.id, { type: event.target.value })}
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:opacity-50"
            />
            <input
              type="number"
              min={0}
              step={1}
              value={row.count}
              disabled={saving}
              onChange={(event) => updateRow(row.id, { count: event.target.value })}
              className="w-16 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              aria-label={`Remove ${row.type || "row"}`}
              disabled={saving}
              onClick={() => removeRow(row.id)}
              className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              &times;
            </button>
          </div>
        ))}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={saving}
            onClick={addRow}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Add type
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-md border border-slate-900 bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
        >
          {error}
        </p>
      )}

      {progressTypes.length > 0 && (
        <dl className="mt-3 space-y-1.5 border-t border-slate-200 pt-3">
          {progressTypes.map((type) => {
            const target = expected[type] ?? 0;
            const arrived = actual[type] ?? 0;
            const met = target > 0 && arrived >= target;
            return (
              <div key={type} className="flex items-center gap-2 text-xs">
                <dt className="min-w-0 flex-1 truncate font-mono text-slate-700">{type}</dt>
                <dd className="tabular-nums text-slate-500">
                  {arrived} / {target || "—"}
                </dd>
                <span className={`w-3 text-center font-semibold ${met ? "text-emerald-600" : "text-transparent"}`}>
                  &#10003;
                </span>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

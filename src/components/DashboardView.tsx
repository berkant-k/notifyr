"use client";

import Link from "next/link";
import { useState } from "react";
import EndpointCard from "@/components/EndpointCard";
import HeartbeatPeriodCard from "@/components/HeartbeatPeriodCard";
import LiveIndicator from "@/components/LiveIndicator";
import MessageDetailModal from "@/components/MessageDetailModal";
import MessageList from "@/components/MessageList";
import NotificationCounters from "@/components/NotificationCounters";
import PayloadExpectationCard from "@/components/PayloadExpectationCard";
import ResponseRulesCard from "@/components/ResponseRulesCard";
import SubscriptionEndCard from "@/components/SubscriptionEndCard";
import { useEndpointPoll } from "@/hooks/useEndpointPoll";
import {
  emptyNotificationCounts,
  MAX_RECENT_MESSAGES,
  MAX_STORED_MESSAGES,
  type Message,
} from "@/lib/types";

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "valid" | "invalid";
}) {
  return (
    <div className="flex-1 rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`mt-0.5 text-2xl font-semibold tabular-nums ${
          tone === "valid" ? "text-emerald-600" : "text-rose-600"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * List filters. Deliberately a flat list rather than one chip per notification
 * type plus a separate validity control: during a soak test the question is
 * always "show me one kind of row", and "invalid" is one of those kinds.
 */
const FILTERS = [
  { id: "all", label: "All" },
  { id: "handshake", label: "Handshake" },
  { id: "heartbeat", label: "Heartbeat" },
  { id: "event-notification", label: "Event" },
  { id: "invalid", label: "Invalid" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

function matches(filter: Filter): (message: Message) => boolean {
  if (filter === "all") return () => true;
  if (filter === "invalid") return (message) => !message.isValid;
  return (message) => message.notificationType === filter;
}

export default function DashboardView({
  endpointId,
  webhookUrl,
}: {
  endpointId: string;
  /** Resolved on the server, so hydration has nothing to disagree about. */
  webhookUrl: string;
}) {
  const [limit, setLimit] = useState<number>(MAX_RECENT_MESSAGES);
  const { snapshot, state, refresh, nowMs } = useEndpointPoll(endpointId, limit);
  const [selected, setSelected] = useState<Message | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const loaded = snapshot?.messages ?? [];
  const visible = loaded.filter(matches(filter));

  if (state === "not-found") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Endpoint not found</h1>
        <p className="text-sm text-slate-600">
          This endpoint does not exist, or the server restarted and lost it — data is held in
          memory only.
        </p>
        <Link href="/" className="inline-block text-sm font-medium text-slate-900 underline">
          Create a new endpoint
        </Link>
      </div>
    );
  }

  return (
    /*
      From `lg` the dashboard is exactly as tall as the shell leaves it
      (viewport minus the 53px header, 49px footer and the 40px padding above
      and below — 182px, the one measured constant here) and hands the leftover
      to the list. An earlier version capped the list at a guessed height, which
      overflowed by 179px as soon as it filled and by 283px with the continuity
      panel open. Letting flex do the arithmetic means the counters, the panel
      and the filters can all change height without anyone re-deriving anything.
    */
    <div className="space-y-4 lg:flex lg:h-[calc(100vh-182px)] lg:flex-col">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Endpoint dashboard</h1>
          <p className="mt-1 font-mono text-xs text-slate-500">{endpointId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <LiveIndicator state={state} />
          <button
            type="button"
            onClick={refresh}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {/*
        Two columns from `lg`. The notification stream is why this page exists,
        so it holds the left column and starts near the top of the viewport;
        configuration — which is read rarely and set once — moves to a rail that
        stays put while the list scrolls. Below `lg` it all stacks, settings
        last, so the stream is still the first thing after the counters.
      */}
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col space-y-4 lg:h-full">
          <div className="flex gap-4">
            <Counter label="Valid" value={snapshot?.endpoint.validCount ?? 0} tone="valid" />
            <Counter label="Invalid" value={snapshot?.endpoint.invalidCount ?? 0} tone="invalid" />
          </div>

          <NotificationCounters
            counts={snapshot?.endpoint.notificationCounts ?? emptyNotificationCounts()}
            continuity={snapshot?.endpoint.continuity ?? []}
            heartbeatPeriodSeconds={snapshot?.endpoint.heartbeatPeriodSeconds ?? 0}
            nowMs={nowMs}
          />

          <section className="flex min-h-0 flex-col space-y-3 lg:flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Notifications</h2>
                {/*
                  Deliberately no per-chip counts. They would count loaded rows,
                  while the card above counts every valid notification of that
                  type ever received — the same words over different numbers,
                  which reads as a bug. The filtered total is stated once, here.
                */}
                {filter !== "all" && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    Showing {visible.length} of {loaded.length} loaded
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {FILTERS.map(({ id, label }) => {
                  const active = filter === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFilter(id)}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1 focus-visible:outline-none ${
                        active
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/*
              An empty filter is not an empty endpoint: telling someone to POST
              a resource when 40 have already arrived reads as a bug.
            */}
            <div className="min-h-0 lg:flex-1 lg:overflow-y-auto lg:rounded-lg">
            {snapshot && loaded.length > 0 && visible.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
                No matching notifications among the {loaded.length} loaded.{" "}
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="font-medium text-slate-900 underline"
                >
                  Clear the filter
                </button>
              </div>
            ) : snapshot ? (
              <MessageList messages={visible} nowMs={nowMs} onSelect={setSelected} />
            ) : (
              <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                {state === "error" ? "Could not reach the server. Retrying…" : "Loading…"}
              </div>
            )}
            </div>

            {/*
              The store keeps 100 messages and the first page shows 10. A full
              page back is the only evidence there may be more, since the
              snapshot does not carry a total.
            */}
            {snapshot && loaded.length === limit && limit < MAX_STORED_MESSAGES && (
              <button
                type="button"
                onClick={() => setLimit((current) => Math.min(current * 5, MAX_STORED_MESSAGES))}
                className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
              >
                Show more — {limit} of up to {MAX_STORED_MESSAGES} kept
              </button>
            )}
          </section>
        </div>

        <aside className="space-y-4 lg:h-full lg:w-80 lg:shrink-0 lg:overflow-y-auto">
          <EndpointCard
            webhookUrl={webhookUrl}
            guideHref={`/dashboard/${endpointId}/guide`}
            createdAt={snapshot?.endpoint.createdAt ?? null}
            expiresAt={snapshot?.endpoint.expiresAt ?? null}
            nowMs={nowMs}
          />

          {snapshot && (
            <ResponseRulesCard
              endpointId={endpointId}
              rules={snapshot.endpoint.responseRules}
              onChanged={refresh}
            />
          )}

          {snapshot && (
            <PayloadExpectationCard
              endpointId={endpointId}
              expected={snapshot.endpoint.expectedPayloadContent}
              onChanged={refresh}
            />
          )}

          {snapshot && (
            <HeartbeatPeriodCard
              endpointId={endpointId}
              key={`heartbeat-${snapshot.endpoint.heartbeatPeriodSeconds}`}
              seconds={snapshot.endpoint.heartbeatPeriodSeconds}
              onChanged={refresh}
            />
          )}

          {/*
            Keyed on the stored deadline for the same reason as the heartbeat
            card: the field holds local state while typing, so a change made in
            another tab has to remount it to be picked up.
          */}
          {snapshot && (
            <SubscriptionEndCard
              endpointId={endpointId}
              key={`expected-end-${snapshot.endpoint.expectedEnd ?? "unset"}`}
              expectedEnd={snapshot.endpoint.expectedEnd}
              afterEndCount={snapshot.endpoint.afterEndCount}
              onChanged={refresh}
            />
          )}
        </aside>
      </div>

      <MessageDetailModal message={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

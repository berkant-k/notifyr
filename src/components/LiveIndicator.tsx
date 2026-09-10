"use client";

import type { ConnectionState } from "@/hooks/useEndpointPoll";

const LABELS: Record<ConnectionState, { text: string; dot: string; tone: string }> = {
  loading: { text: "Connecting…", dot: "bg-slate-400", tone: "text-slate-500" },
  live: { text: "Live", dot: "bg-emerald-500 animate-pulse", tone: "text-slate-600" },
  paused: { text: "Paused", dot: "bg-slate-400", tone: "text-slate-500" },
  error: { text: "Reconnecting…", dot: "bg-amber-500", tone: "text-amber-700" },
  "not-found": { text: "Disconnected", dot: "bg-rose-500", tone: "text-rose-700" },
};

/** Small status dot so it is obvious whether the page is actually updating. */
export default function LiveIndicator({ state }: { state: ConnectionState }) {
  const { text, dot, tone } = LABELS[state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {text}
    </span>
  );
}

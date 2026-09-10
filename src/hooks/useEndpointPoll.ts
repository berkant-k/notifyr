"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { overdueKey } from "@/lib/continuity";
import { relativeKey } from "@/lib/time";
import type { EndpointSnapshot, MessagesResponse } from "@/lib/types";

/**
 * Live endpoint data.
 *
 * Polling rather than SSE: an SSE stream is pinned to one serverless instance,
 * and with the in-memory store that instance can only ever see its own writes.
 * See README "Real-time updates". Swapping to SSE later should mean rewriting
 * this hook and nothing else — `DashboardView` only consumes its return value.
 *
 * The whole loop lives inside the effect so that every piece of its state is
 * scoped to one `endpointId`. Hoisting any of it out invites a stale timer from
 * a previous endpoint to outlive cleanup and keep writing to state.
 *
 * Callers must remount on a changed `endpointId` (`key={endpointId}`) so the
 * previous endpoint's snapshot cannot linger on screen.
 */

export const POLL_INTERVAL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;

export type ConnectionState = "loading" | "live" | "paused" | "not-found" | "error";

export interface EndpointPoll {
  snapshot: EndpointSnapshot | null;
  state: ConnectionState;
  /** Poll immediately, e.g. from a manual refresh button. */
  refresh: () => void;
  /**
   * Wall clock as of the last poll, but only advanced when it would change what
   * the overdue display says.
   *
   * How overdue a heartbeat is, and how long ago a row arrived, both move with
   * the clock while nothing on the server changes — and an unchanged endpoint
   * answers "nothing changed", so neither would ever reach the dashboard that
   * needs them. Advancing this on every poll would re-render an idle dashboard
   * forever, which the polling design exists to avoid; advancing it only when a
   * displayed value would actually differ keeps both properties. A list of
   * hour-old rows is left alone until the hour turns.
   */
  nowMs: number;
}

export function useEndpointPoll(endpointId: string, limit?: number): EndpointPoll {
  const [snapshot, setSnapshot] = useState<EndpointSnapshot | null>(null);
  const [state, setState] = useState<ConnectionState>("loading");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  /** The freshest snapshot, readable from inside the loop without re-subscribing. */
  const latest = useRef<EndpointSnapshot | null>(null);
  // Set by the effect below so `refresh` can reach the current loop.
  const pollNowRef = useRef<(() => void) | null>(null);

  // A changed `limit` restarts the loop, which resets `version` to null and so
  // forces a full response — asking for more rows while telling the server
  // nothing has changed would otherwise return the short list again.
  useEffect(() => {
    // All loop state is per-endpoint and dies with the effect.
    let cancelled = false;
    let paused = false;
    let version: number | null = null;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let overdue = "";

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    async function poll(): Promise<void> {
      if (cancelled || paused) return;

      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;

      let delay: number = POLL_INTERVAL_MS;

      try {
        const query = new URLSearchParams();
        if (version !== null) query.set("since", String(version));
        if (limit !== undefined) query.set("limit", String(limit));
        const suffix = query.size === 0 ? "" : `?${query}`;

        const response = await fetch(`/api/endpoints/${endpointId}/messages${suffix}`, {
          cache: "no-store",
          signal,
        });
        if (cancelled) return;

        // A missing endpoint will not reappear, so stop polling rather than
        // hammering a 404 twice a second.
        if (response.status === 404) {
          setState("not-found");
          return;
        }
        if (!response.ok) throw new Error(`Server responded ${response.status}`);

        const body: MessagesResponse = await response.json();
        if (cancelled) return;

        failures = 0;
        version = body.version;

        // Only touch state when something actually changed. This is what keeps
        // an idle dashboard from re-rendering (and the list from flickering).
        if (body.changed) {
          latest.current = { endpoint: body.endpoint, messages: body.messages };
          setSnapshot(latest.current);
        }
        setState("live");

        // Derived from the snapshot already in hand, so an unchanged response
        // still moves the overdue clock forward — but only when the number the
        // dashboard shows would actually differ.
        const current = latest.current;
        if (current) {
          const at = Date.now();
          const key = [
            overdueKey(current.endpoint.continuity, current.endpoint.heartbeatPeriodSeconds, at),
            relativeKey(
              current.messages.map((message) => message.receivedAt),
              at,
            ),
          ].join("~");
          if (key !== overdue) {
            overdue = key;
            setNowMs(at);
          }
        }
      } catch {
        if (cancelled || signal.aborted) return;
        failures += 1;
        setState("error");
        delay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
      }

      if (cancelled || paused) return;
      clearTimer();
      timer = setTimeout(() => void poll(), delay);
    }

    function pollNow() {
      clearTimer();
      void poll();
    }

    pollNowRef.current = pollNow;

    // Polling a dashboard nobody is looking at just burns serverless invocations.
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        paused = false;
        pollNow();
      } else {
        paused = true;
        clearTimer();
        setState((current) => (current === "not-found" ? current : "paused"));
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();

    return () => {
      cancelled = true;
      pollNowRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimer();
      controller?.abort();
    };
  }, [endpointId, limit]);

  const refresh = useCallback(() => {
    pollNowRef.current?.();
  }, []);

  return { snapshot, state, refresh, nowMs };
}

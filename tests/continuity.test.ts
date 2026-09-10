/**
 * Stream continuity: heartbeat liveness and event gaps.
 *
 * Everything here injects timestamps rather than waiting for them, so the whole
 * suite runs in milliseconds and a "four minutes late" case costs nothing.
 */

import { describe, expect, it } from "vitest";
import {
  emptyContinuity,
  heartbeatToleranceSeconds,
  observe,
  overdueHeartbeats,
  overdueKey,
  type ContinuityObservation,
} from "@/lib/continuity";
import type { SubscriptionContinuity } from "@/lib/types";

const REFERENCE = "http://localhost:5826/fhir/r4b/Subscription/notifyr-test";
const PERIOD = 120;

/** Seconds after a fixed origin, as an ISO stamp. */
function at(seconds: number): string {
  return new Date(Date.parse("2026-09-09T09:00:00.000Z") + seconds * 1000).toISOString();
}

function heartbeat(seconds: number, overrides: Partial<ContinuityObservation> = {}) {
  return {
    reference: REFERENCE,
    receivedAt: at(seconds),
    notificationType: "heartbeat" as const,
    eventsSinceSubscriptionStart: null,
    heartbeatPeriodSeconds: PERIOD,
    ...overrides,
  };
}

/** Fold a series of observations, returning the record and every finding raised. */
function run(observations: ContinuityObservation[]) {
  let record: SubscriptionContinuity | null = null;
  const findings = [];
  for (const observation of observations) {
    const update = observe(record, observation);
    record = update.record;
    findings.push(...update.findings);
  }
  return { record: record!, findings };
}

describe("tolerance", () => {
  it("allows half a period of jitter", () => {
    expect(heartbeatToleranceSeconds(120)).toBe(180);
  });

  // Half of 4 seconds is 2, which no real scheduler hits; the floor keeps short
  // periods from being hair-triggered.
  it("adds a floor for short periods", () => {
    expect(heartbeatToleranceSeconds(6)).toBe(11);
  });
});

describe("heartbeat liveness", () => {
  it("says nothing about the first heartbeat", () => {
    const { record, findings } = run([heartbeat(0)]);
    expect(findings).toEqual([]);
    expect(record.lastHeartbeatAt).toBe(at(0));
    expect(record.missedHeartbeats).toBe(0);
  });

  it("accepts a heartbeat inside the tolerance", () => {
    const { findings } = run([heartbeat(0), heartbeat(170)]);
    expect(findings).toEqual([]);
  });

  it("treats the tolerance boundary as on time", () => {
    const { findings } = run([heartbeat(0), heartbeat(180)]);
    expect(findings).toEqual([]);
  });

  it("warns past the tolerance and counts what was missed", () => {
    const { record, findings } = run([heartbeat(0), heartbeat(412)]);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("412s after the previous one");
    expect(findings[0].message).toContain("120s");
    // Heartbeats were due at 120, 240 and 360; one arrived, so two never did.
    expect(findings[0].message).toContain("2 missed");
    expect(record.missedHeartbeats).toBe(2);
  });

  it("accumulates across several late heartbeats", () => {
    const { record } = run([heartbeat(0), heartbeat(400), heartbeat(800)]);
    expect(record.missedHeartbeats).toBe(4);
  });

  it("tracks the timestamp but raises nothing when the period is off", () => {
    const off = { heartbeatPeriodSeconds: 0 };
    const { record, findings } = run([heartbeat(0, off), heartbeat(9999, off)]);

    expect(findings).toEqual([]);
    expect(record.missedHeartbeats).toBe(0);
    expect(record.lastHeartbeatAt).toBe(at(9999));
  });

  it("ignores the gap before a notification that is not a heartbeat", () => {
    const { findings } = run([
      heartbeat(0),
      heartbeat(600, { notificationType: "event-notification" }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe("event gaps", () => {
  function counted(seconds: number, count: string, type: ContinuityObservation["notificationType"] = "heartbeat") {
    return heartbeat(seconds, { eventsSinceSubscriptionStart: count, notificationType: type });
  }

  it("says nothing about the first counter it sees", () => {
    const { record, findings } = run([counted(0, "7")]);
    expect(findings).toEqual([]);
    expect(record.lastEventCount).toBe(7);
  });

  it("accepts a counter that stands still or advances by one", () => {
    const { findings } = run([counted(0, "7"), counted(120, "7"), counted(240, "8")]);
    expect(findings).toEqual([]);
  });

  it("warns on a jump and counts the difference", () => {
    const { record, findings } = run([counted(0, "7"), counted(120, "11")]);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("jumped from 7 to 11");
    expect(findings[0].message).toContain("3 notifications appear");
    expect(record.missedEvents).toBe(3);
  });

  it("uses the singular for one missed notification", () => {
    const { findings } = run([counted(0, "7"), counted(120, "9")]);
    expect(findings[0].message).toContain("1 notification appears");
  });

  // The counter riding on heartbeats is what makes a lost event-notification
  // visible at all: nothing else announces it.
  it("detects events missed between two heartbeats", () => {
    const { record } = run([counted(0, "4"), counted(120, "9")]);
    expect(record.missedEvents).toBe(4);
  });

  it("treats a counter going backwards as a restarted subscription", () => {
    const { record, findings } = run([counted(0, "11"), counted(120, "2")]);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].message).toContain("went backwards");
    expect(record.missedEvents).toBe(0);
    expect(record.lastEventCount).toBe(2);
  });

  // The exact case from the report: 3, then 1.
  it("reports the two counts it saw", () => {
    const { findings } = run([counted(0, "3"), counted(60, "1")]);
    expect(findings[0].message).toContain("(3 to 1)");
  });

  it("counts restarts and stamps when the last one happened", () => {
    const { record } = run([counted(0, "3"), counted(60, "1"), counted(120, "2"), counted(180, "1")]);

    expect(record.restarts).toBe(2);
    expect(record.lastRestartAt).toBe(at(180));
    expect(record.lastEventCount).toBe(1);
  });

  it("counts no restart while the counter only climbs", () => {
    const { record } = run([counted(0, "1"), counted(60, "2"), counted(120, "9")]);
    expect(record.restarts).toBe(0);
    expect(record.lastRestartAt).toBeNull();
  });

  // A restart is a new stream, not a loss: counting 3 -> 1 as missed would
  // invent two lost notifications every time a Subscription is recreated.
  it("never counts a restart as missed events", () => {
    const { record } = run([counted(0, "3"), counted(60, "1")]);
    expect(record.missedEvents).toBe(0);
  });

  it("keeps the heartbeat clock across a restart, since the channel never went quiet", () => {
    const { record } = run([counted(0, "11"), counted(120, "2")]);
    expect(record.lastHeartbeatAt).toBe(at(120));
  });

  it("skips a non-numeric counter rather than reporting it twice", () => {
    const { record, findings } = run([counted(0, "7"), counted(120, "lots"), counted(240, "8")]);
    expect(findings).toEqual([]);
    expect(record.lastEventCount).toBe(7 + 1);
  });

  it("cites the IG page that describes gap detection", () => {
    const { findings } = run([counted(0, "1"), counted(120, "5")]);
    expect(findings[0].spec).toBe("https://hl7.org/fhir/uv/subscriptions-backport/errors.html");
  });
});

// The reason both checks share one record keyed by subscription reference: two
// subscriptions on one endpoint each count their own events, so a single
// tracker would read 5, 100, 6, 101 as a 95-event gap and a 94-event reset,
// forever, on a system where nothing is wrong.
describe("two subscriptions on one endpoint", () => {
  it("keeps their counters apart", () => {
    const a = "Subscription/a";
    const b = "Subscription/b";
    const records = new Map<string, SubscriptionContinuity>();
    const findings = [];

    const stream: ContinuityObservation[] = [
      heartbeat(0, { reference: a, eventsSinceSubscriptionStart: "5" }),
      heartbeat(10, { reference: b, eventsSinceSubscriptionStart: "100" }),
      heartbeat(120, { reference: a, eventsSinceSubscriptionStart: "6" }),
      heartbeat(130, { reference: b, eventsSinceSubscriptionStart: "101" }),
    ];

    for (const observation of stream) {
      const update = observe(records.get(observation.reference) ?? null, observation);
      records.set(observation.reference, update.record);
      findings.push(...update.findings);
    }

    expect(findings).toEqual([]);
    expect(records.get(a)?.lastEventCount).toBe(6);
    expect(records.get(b)?.lastEventCount).toBe(101);
  });
});

describe("overdue derivation", () => {
  const tracked: SubscriptionContinuity[] = [
    { ...emptyContinuity(REFERENCE), lastHeartbeatAt: at(0) },
  ];
  const now = (seconds: number) => Date.parse(at(seconds));

  it("is empty inside the tolerance", () => {
    expect(overdueHeartbeats(tracked, PERIOD, now(180))).toEqual([]);
  });

  it("reports how far past the tolerance a subscription is", () => {
    expect(overdueHeartbeats(tracked, PERIOD, now(252))).toEqual([
      { reference: REFERENCE, overdueBySeconds: 72 },
    ]);
  });

  it("is empty when the check is switched off", () => {
    expect(overdueHeartbeats(tracked, 0, now(99999))).toEqual([]);
  });

  it("is empty for a subscription that has never sent a heartbeat", () => {
    expect(overdueHeartbeats([emptyContinuity(REFERENCE)], PERIOD, now(99999))).toEqual([]);
  });

  // The key is what lets an idle dashboard re-render exactly when the number
  // moves, and never when it does not.
  it("gives a key that is stable while nothing is overdue and moves once it is", () => {
    expect(overdueKey(tracked, PERIOD, now(100))).toBe("");
    expect(overdueKey(tracked, PERIOD, now(180))).toBe("");
    expect(overdueKey(tracked, PERIOD, now(252))).not.toBe("");
    expect(overdueKey(tracked, PERIOD, now(252))).toBe(overdueKey(tracked, PERIOD, now(252)));
    expect(overdueKey(tracked, PERIOD, now(253))).not.toBe(overdueKey(tracked, PERIOD, now(252)));
  });
});

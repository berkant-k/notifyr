import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { MAX_RECENT_MESSAGES, MAX_STORED_MESSAGES, type NewMessage } from "@/lib/types";

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    receivedAt: new Date().toISOString(),
    isValid: true,
    status: 200,
    summary: "Patient/a",
    contentType: "application/fhir+json",
    notificationType: null,
    eventsSinceSubscriptionStart: null,
    topic: null,
    statusOverridden: false,
    expectedPayloadContent: null,
    headers: [
      { name: "content-type", value: "application/fhir+json", sensitive: false, platform: false },
    ],
    rawBody: '{"resourceType":"Patient","id":"a"}',
    validationErrors: [],
    ...overrides,
  };
}

/** createEndpoint is nullable (id collisions); these tests never collide. */
async function newEndpoint() {
  const endpoint = await store.createEndpoint();
  if (!endpoint) throw new Error("expected endpoint creation to succeed");
  return endpoint;
}

describe("endpoints", () => {
  it("mints unique ids and starts every counter at zero", async () => {
    const a = await newEndpoint();
    const b = await newEndpoint();

    expect(a.id).not.toBe(b.id);
    expect(a.validCount).toBe(0);
    expect(a.invalidCount).toBe(0);
    expect(a.version).toBe(0);
    expect(a.notificationCounts).toEqual({
      handshake: 0,
      heartbeat: 0,
      "event-notification": 0,
      "query-status": 0,
      "query-event": 0,
    });
  });

  it("returns null for an unknown endpoint", async () => {
    expect(await store.getEndpoint("nope")).toBeNull();
    expect(await store.getSnapshot("nope")).toBeNull();
    expect(await store.addMessage("nope", message())).toBeNull();
  });
});

describe("messages", () => {
  it("returns them newest first", async () => {
    const { id } = await newEndpoint();
    await store.addMessage(id, message({ summary: "first" }));
    await store.addMessage(id, message({ summary: "second" }));

    const snapshot = await store.getSnapshot(id);
    expect(snapshot?.messages.map((m) => m.summary)).toEqual(["second", "first"]);
  });

  it("assigns an id and stamps the endpoint id", async () => {
    const { id } = await newEndpoint();
    const stored = await store.addMessage(id, message());

    expect(stored?.id).toBeTruthy();
    expect(stored?.endpointId).toBe(id);
  });

  it("caps the snapshot at the requested limit", async () => {
    const { id } = await newEndpoint();
    for (let i = 0; i < MAX_RECENT_MESSAGES + 5; i++) {
      await store.addMessage(id, message({ summary: `m${i}` }));
    }

    const snapshot = await store.getSnapshot(id);
    expect(snapshot?.messages).toHaveLength(MAX_RECENT_MESSAGES);
    expect(snapshot?.messages[0].summary).toBe(`m${MAX_RECENT_MESSAGES + 4}`);
  });

  it("retains no more than MAX_STORED_MESSAGES", async () => {
    const { id } = await newEndpoint();
    for (let i = 0; i < MAX_STORED_MESSAGES + 10; i++) {
      await store.addMessage(id, message());
    }

    const snapshot = await store.getSnapshot(id, Number.MAX_SAFE_INTEGER);
    expect(snapshot?.messages).toHaveLength(MAX_STORED_MESSAGES);
  });
});

describe("counters", () => {
  // The bug this guards: deriving counts from the trimmed message list would
  // make them silently start decreasing once retention kicks in.
  it("stays cumulative past the retention cap", async () => {
    const { id } = await newEndpoint();
    const total = MAX_STORED_MESSAGES + 14;
    for (let i = 0; i < total; i++) {
      await store.addMessage(id, message());
    }

    const snapshot = await store.getSnapshot(id);
    expect(snapshot?.endpoint.validCount).toBe(total);
    expect(snapshot?.messages.length).toBe(MAX_RECENT_MESSAGES);
  });

  it("separates valid from invalid", async () => {
    const { id } = await newEndpoint();
    await store.addMessage(id, message({ isValid: true }));
    await store.addMessage(id, message({ isValid: false, status: 422 }));
    await store.addMessage(id, message({ isValid: false, status: 400 }));

    const snapshot = await store.getSnapshot(id);
    expect(snapshot?.endpoint.validCount).toBe(1);
    expect(snapshot?.endpoint.invalidCount).toBe(2);
  });

  it("increments version on every write", async () => {
    const { id } = await newEndpoint();
    await store.addMessage(id, message());
    await store.addMessage(id, message({ isValid: false }));

    expect((await store.getSnapshot(id))?.endpoint.version).toBe(2);
  });
});

describe("notification counters", () => {
  it("tallies valid notifications by type", async () => {
    const { id } = await newEndpoint();
    await store.addMessage(id, message({ notificationType: "handshake" }));
    for (let i = 0; i < 3; i++) {
      await store.addMessage(id, message({ notificationType: "heartbeat" }));
    }
    await store.addMessage(id, message({ notificationType: "event-notification" }));

    const counts = (await store.getSnapshot(id))?.endpoint.notificationCounts;
    expect(counts?.handshake).toBe(1);
    expect(counts?.heartbeat).toBe(3);
    expect(counts?.["event-notification"]).toBe(1);
    expect(counts?.["query-status"]).toBe(0);
  });

  it("does not count invalid notifications", async () => {
    const { id } = await newEndpoint();
    await store.addMessage(id, message({ notificationType: "handshake", isValid: false, status: 422 }));

    const snapshot = await store.getSnapshot(id);
    expect(snapshot?.endpoint.notificationCounts.handshake).toBe(0);
    expect(snapshot?.endpoint.invalidCount).toBe(1);
  });

  it("does not count ordinary resources", async () => {
    const { id } = await newEndpoint();
    await store.addMessage(id, message({ notificationType: null }));

    const counts = (await store.getSnapshot(id))?.endpoint.notificationCounts;
    expect(Object.values(counts ?? {}).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("never sums to more than validCount", async () => {
    const { id } = await newEndpoint();
    await store.addMessage(id, message({ notificationType: "handshake" }));
    await store.addMessage(id, message({ notificationType: "heartbeat" }));
    await store.addMessage(id, message({ notificationType: null }));
    await store.addMessage(id, message({ notificationType: "heartbeat", isValid: false }));

    const endpoint = (await store.getSnapshot(id))!.endpoint;
    const sum = Object.values(endpoint.notificationCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(2);
    expect(sum).toBeLessThanOrEqual(endpoint.validCount);
  });

  // Snapshots are handed to route handlers; they must not alias live state.
  it("does not hand callers a live reference to the counts", async () => {
    const { id } = await newEndpoint();
    const snapshot = (await store.getSnapshot(id))!;
    snapshot.endpoint.notificationCounts.handshake = 99;

    expect((await store.getSnapshot(id))?.endpoint.notificationCounts.handshake).toBe(0);
  });
});

describe("expected payload content", () => {
  it("starts unset and round-trips a level", async () => {
    const { id } = await newEndpoint();
    expect((await store.getEndpoint(id))?.expectedPayloadContent).toBeNull();

    await store.updateExpectedPayloadContent(id, "id-only");
    expect((await store.getEndpoint(id))?.expectedPayloadContent).toBe("id-only");

    await store.updateExpectedPayloadContent(id, null);
    expect((await store.getEndpoint(id))?.expectedPayloadContent).toBeNull();
  });

  it("bumps the version so an open dashboard picks it up", async () => {
    const { id, version } = await newEndpoint();
    await store.updateExpectedPayloadContent(id, "empty");

    expect((await store.getEndpoint(id))?.version).toBe(version + 1);
  });

  it("returns null for an unknown endpoint", async () => {
    expect(await store.updateExpectedPayloadContent("nope", "empty")).toBeNull();
  });
});

describe("continuity tracking", () => {
  const A = "Subscription/a";
  const B = "Subscription/b";

  function heartbeat(reference: string, seconds: number, count: string | null = null) {
    return {
      reference,
      receivedAt: new Date(Date.parse("2026-09-09T09:00:00.000Z") + seconds * 1000).toISOString(),
      notificationType: "heartbeat" as const,
      eventsSinceSubscriptionStart: count,
    };
  }

  it("keeps one record per subscription, most recent first", async () => {
    const { id } = await newEndpoint();
    await store.recordContinuity(id, heartbeat(A, 0));
    await store.recordContinuity(id, heartbeat(B, 10));

    const { continuity } = (await store.getSnapshot(id))!.endpoint;
    expect(continuity.map((record) => record.reference)).toEqual([B, A]);
  });

  it("tracks event gaps with no period configured", async () => {
    const { id } = await newEndpoint();
    await store.recordContinuity(id, heartbeat(A, 0, "3"));
    const findings = await store.recordContinuity(id, heartbeat(A, 60, "7"));

    expect(findings).toHaveLength(1);
    expect((await store.getSnapshot(id))!.endpoint.continuity[0].missedEvents).toBe(3);
  });

  // The default period means timing is checked from the first heartbeat, with
  // nothing configured.
  it("checks timing against the default period", async () => {
    const { id } = await newEndpoint();
    expect((await store.getEndpoint(id))?.heartbeatPeriodSeconds).toBe(120);

    await store.recordContinuity(id, heartbeat(A, 0));
    const findings = await store.recordContinuity(id, heartbeat(A, 9999));
    expect(findings[0].message).toContain("the configured period is 120s");
  });

  it("raises nothing about timing once the period is switched off", async () => {
    const { id } = await newEndpoint();
    await store.updateHeartbeatPeriod(id, 0);
    await store.recordContinuity(id, heartbeat(A, 0));
    expect(await store.recordContinuity(id, heartbeat(A, 9999))).toEqual([]);
  });

  it("warns about a late heartbeat once a period is set", async () => {
    const { id } = await newEndpoint();
    await store.updateHeartbeatPeriod(id, 120);
    await store.recordContinuity(id, heartbeat(A, 0));
    const findings = await store.recordContinuity(id, heartbeat(A, 400));

    expect(findings[0].message).toContain("400s after the previous one");
    expect((await store.getSnapshot(id))!.endpoint.continuity[0].missedHeartbeats).toBe(2);
  });

  // A count accumulated against 120s means nothing under a 30s period.
  it("clears missed heartbeats when the period changes, keeping the timestamps", async () => {
    const { id } = await newEndpoint();
    await store.updateHeartbeatPeriod(id, 120);
    await store.recordContinuity(id, heartbeat(A, 0, "1"));
    await store.recordContinuity(id, heartbeat(A, 400, "2"));

    await store.updateHeartbeatPeriod(id, 30);
    const record = (await store.getSnapshot(id))!.endpoint.continuity[0];

    expect(record.missedHeartbeats).toBe(0);
    expect(record.lastHeartbeatAt).not.toBeNull();
    expect(record.lastEventCount).toBe(2);
  });

  it("bumps the version so an open dashboard notices a period change", async () => {
    const { id, version } = await newEndpoint();
    await store.updateHeartbeatPeriod(id, 60);
    expect((await store.getEndpoint(id))?.version).toBe(version + 1);
  });

  it("returns null for an unknown endpoint and records nothing", async () => {
    expect(await store.updateHeartbeatPeriod("nope", 60)).toBeNull();
    expect(await store.recordContinuity("nope", heartbeat(A, 0))).toEqual([]);
  });

  it("does not hand callers a live reference to the tracker", async () => {
    const { id } = await newEndpoint();
    await store.recordContinuity(id, heartbeat(A, 0));

    const snapshot = (await store.getSnapshot(id))!;
    snapshot.endpoint.continuity[0].missedEvents = 99;

    expect((await store.getSnapshot(id))!.endpoint.continuity[0].missedEvents).toBe(0);
  });
});

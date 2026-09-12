import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "@upstash/redis";
import { DEFAULT_ENDPOINT_TTL_SECONDS, endpointTtlSeconds, RedisStore } from "@/lib/redisStore";
import { createStore, InMemoryStore, type MessageStore } from "@/lib/store";

import { FakeRedis } from "./support/fakeRedis";
import { MAX_RECENT_MESSAGES, MAX_STORED_MESSAGES, type NewMessage } from "@/lib/types";

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    receivedAt: new Date().toISOString(),
    method: "POST",
    isValid: true,
    status: 200,
    summary: "Patient/a",
    contentType: "application/fhir+json",
    notificationType: null,
    eventsSinceSubscriptionStart: null,
    topic: null,
    focusResourceTypes: [],
    requestPath: null,
    statusOverridden: false,
    expectedPayloadContent: null,
    afterExpectedEnd: false,
    headers: [
      { name: "content-type", value: "application/fhir+json", sensitive: false, platform: false },
    ],
    rawBody: '{"resourceType":"Patient","id":"a"}',
    validationErrors: [],
    ...overrides,
  };
}

/**
 * One contract, two implementations. The in-memory store is what `npm run dev`
 * and the tests use; `RedisStore` is what a deployment with credentials gets,
 * and the point of running both is that a shared store is only a swap seam if
 * it answers identically.
 *
 * The Redis pass runs against an in-process fake (tests need no network, and CI
 * has no Redis), so it covers this store's own logic but not Upstash's wire
 * behaviour.
 */
const implementations: { name: string; create: () => MessageStore }[] = [
  { name: "in-memory", create: () => new InMemoryStore() },
  { name: "redis", create: () => new RedisStore(new FakeRedis()) },
];

describe.each(implementations)("$name store", ({ create }) => {
  let store: MessageStore;

  beforeEach(() => {
    store = create();
  });

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

    // The poll path. It has to agree with the snapshot, or a dashboard either
    // never refreshes or refreshes forever.
    it("reports the version without a snapshot", async () => {
      const { id } = await newEndpoint();
      expect(await store.getVersion(id)).toBe(0);

      await store.addMessage(id, message());
      expect(await store.getVersion(id)).toBe(1);
      expect(await store.getVersion(id)).toBe((await store.getSnapshot(id))?.endpoint.version);

      expect(await store.getVersion("nope")).toBeNull();
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

  describe("resource counts", () => {
    it("tallies valid event-notifications by focus resource type", async () => {
      const { id } = await newEndpoint();
      await store.addMessage(id, message({ focusResourceTypes: ["Encounter", "Encounter"] }));
      await store.addMessage(id, message({ focusResourceTypes: ["Patient"] }));

      const counts = (await store.getSnapshot(id))?.endpoint.resourceCounts;
      expect(counts?.Encounter).toBe(2);
      expect(counts?.Patient).toBe(1);
    });

    it("does not count an invalid notification's resource types", async () => {
      const { id } = await newEndpoint();
      await store.addMessage(
        id,
        message({ focusResourceTypes: ["Encounter"], isValid: false, status: 422 }),
      );

      expect((await store.getSnapshot(id))?.endpoint.resourceCounts.Encounter).toBeUndefined();
    });

    it("starts empty rather than pre-populated with any type", async () => {
      const { id } = await newEndpoint();
      expect((await store.getEndpoint(id))?.resourceCounts).toEqual({});
    });

    it("does not hand callers a live reference to the counts", async () => {
      const { id } = await newEndpoint();
      await store.addMessage(id, message({ focusResourceTypes: ["Encounter"] }));

      const snapshot = (await store.getSnapshot(id))!;
      snapshot.endpoint.resourceCounts.Encounter = 99;

      expect((await store.getSnapshot(id))?.endpoint.resourceCounts.Encounter).toBe(1);
    });
  });

  describe("expected resource counts", () => {
    it("starts empty and round-trips a full replacement", async () => {
      const { id } = await newEndpoint();
      expect((await store.getEndpoint(id))?.expectedResourceCounts).toEqual({});

      await store.updateExpectedResourceCounts(id, { Encounter: 2, Patient: 1 });
      expect((await store.getEndpoint(id))?.expectedResourceCounts).toEqual({
        Encounter: 2,
        Patient: 1,
      });

      // Full replace, not a merge: setting a new map drops what isn't in it.
      await store.updateExpectedResourceCounts(id, { Patient: 3 });
      expect((await store.getEndpoint(id))?.expectedResourceCounts).toEqual({ Patient: 3 });

      await store.updateExpectedResourceCounts(id, {});
      expect((await store.getEndpoint(id))?.expectedResourceCounts).toEqual({});
    });

    it("bumps the version so an open dashboard picks it up", async () => {
      const { id, version } = await newEndpoint();
      await store.updateExpectedResourceCounts(id, { Encounter: 1 });

      expect((await store.getEndpoint(id))?.version).toBe(version + 1);
    });

    it("returns null for an unknown endpoint", async () => {
      expect(await store.updateExpectedResourceCounts("nope", { Encounter: 1 })).toBeNull();
    });

    // Setting an expectation is not a judgement about arrivals already tallied.
    it("never touches resourceCounts", async () => {
      const { id } = await newEndpoint();
      await store.addMessage(id, message({ focusResourceTypes: ["Encounter"] }));

      await store.updateExpectedResourceCounts(id, { Encounter: 5 });

      expect((await store.getEndpoint(id))?.resourceCounts.Encounter).toBe(1);
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

  describe("expected end", () => {
    const END = "2026-09-10T18:30:00.000Z";

    it("starts unset and round-trips an instant", async () => {
      const { id } = await newEndpoint();
      expect((await store.getEndpoint(id))?.expectedEnd).toBeNull();

      await store.updateExpectedEnd(id, END);
      expect((await store.getEndpoint(id))?.expectedEnd).toBe(END);

      await store.updateExpectedEnd(id, null);
      expect((await store.getEndpoint(id))?.expectedEnd).toBeNull();
    });

    it("bumps the version so an open dashboard picks it up", async () => {
      const { id, version } = await newEndpoint();
      await store.updateExpectedEnd(id, END);

      expect((await store.getEndpoint(id))?.version).toBe(version + 1);
    });

    it("returns null for an unknown endpoint", async () => {
      expect(await store.updateExpectedEnd("nope", END)).toBeNull();
    });

    it("counts only the messages flagged as late", async () => {
      const { id } = await newEndpoint();
      await store.addMessage(id, message({ afterExpectedEnd: false }));
      await store.addMessage(id, message({ afterExpectedEnd: true }));
      await store.addMessage(id, message({ afterExpectedEnd: true }));

      expect((await store.getSnapshot(id))?.endpoint.afterEndCount).toBe(2);
    });

    // Same bug as the valid/invalid counters: a tally derived from the retained
    // list would start answering "nothing arrived late" once the evidence was
    // trimmed away, which is the one answer this feature must never invent.
    it("stays cumulative past the retention cap", async () => {
      const { id } = await newEndpoint();
      const total = MAX_STORED_MESSAGES + 9;
      for (let i = 0; i < total; i++) {
        await store.addMessage(id, message({ afterExpectedEnd: true }));
      }

      expect((await store.getSnapshot(id))?.endpoint.afterEndCount).toBe(total);
    });

    // Correcting the deadline does not un-receive what already arrived under
    // the old one, so unlike the heartbeat period this clears no counts.
    it("keeps the count when the deadline changes", async () => {
      const { id } = await newEndpoint();
      await store.updateExpectedEnd(id, END);
      await store.addMessage(id, message({ afterExpectedEnd: true }));

      await store.updateExpectedEnd(id, "2099-01-01T00:00:00.000Z");
      expect((await store.getEndpoint(id))?.afterEndCount).toBe(1);

      await store.updateExpectedEnd(id, null);
      expect((await store.getEndpoint(id))?.afterEndCount).toBe(1);
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
});

describe("choosing an implementation", () => {
  // The seam is credentials, not a flag, so this is the whole of the deploy
  // configuration: get it wrong and a public instance silently keeps its data
  // per-instance, which is the failure the shared store exists to prevent.
  const vars = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
  const saved = vars.map((name) => process.env[name]);

  afterEach(() => {
    vars.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  });

  it("uses the in-memory store when there are no credentials", () => {
    vars.forEach((name) => delete process.env[name]);
    expect(createStore()).toBeInstanceOf(InMemoryStore);
  });

  it("uses Redis as soon as both credentials are present", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    expect(createStore()).toBeInstanceOf(RedisStore);
  });

  // Half-configured is a deployment mistake, and falling back is the safe
  // reading: an in-memory store is wrong in a way the dashboard already warns
  // about, where a client with no token is wrong on every single request.
  it("falls back when only one of them is set", () => {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    expect(createStore()).toBeInstanceOf(InMemoryStore);
  });
});

/**
 * The one thing the fake cannot speak for: Upstash's own wire behaviour.
 *
 * Skipped unless credentials are present, so `npm test` and CI stay
 * network-free; `npm run test:live` supplies them from .env.local. Keys are
 * namespaced by run and deleted afterwards, and would expire on their own
 * within the hour regardless.
 */
const liveUrl = process.env.UPSTASH_REDIS_REST_URL;
const liveToken = process.env.UPSTASH_REDIS_REST_TOKEN;

describe.skipIf(!liveUrl || !liveToken)("live Upstash", () => {
  const redis = new Redis({ url: liveUrl!, token: liveToken! });
  const live = new RedisStore(redis);
  const ids: string[] = [];

  /** Unique per run, and within the id rules: unreserved characters only. */
  function liveId() {
    const id = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  }

  afterAll(async () => {
    await Promise.all(
      ids.flatMap((id) => [redis.del(`endpoint:${id}`), redis.del(`endpoint:${id}:messages`)]),
    );
  });

  it("round-trips an endpoint, its messages and its counters", async () => {
    const created = await live.createEndpoint(liveId());
    expect(created).not.toBeNull();
    const id = created!.id;

    await live.addMessage(id, message({ summary: "first", notificationType: "handshake" }));
    await live.addMessage(id, message({ summary: "second", isValid: false, status: 422 }));

    const snapshot = await live.getSnapshot(id);
    // Values come back JSON-decoded rather than as the strings we wrote, which
    // is the whole reason this test exists.
    expect(snapshot?.messages.map((m) => m.summary)).toEqual(["second", "first"]);
    expect(snapshot?.messages[1].headers[0].name).toBe("content-type");
    expect(snapshot?.endpoint.validCount).toBe(1);
    expect(snapshot?.endpoint.invalidCount).toBe(1);
    expect(snapshot?.endpoint.notificationCounts.handshake).toBe(1);
    expect(snapshot?.endpoint.version).toBe(2);
    expect(snapshot?.endpoint.responseRules.handshake).toEqual({ enabled: true, status: 400 });
  });

  it("refuses an id that is already taken", async () => {
    const id = liveId();
    expect(await live.createEndpoint(id)).not.toBeNull();
    expect(await live.createEndpoint(id)).toBeNull();
  });

  it("folds continuity across notifications", async () => {
    const { id } = (await live.createEndpoint(liveId()))!;
    const at = (seconds: number) =>
      new Date(Date.parse("2026-09-10T09:00:00.000Z") + seconds * 1000).toISOString();

    await live.recordContinuity(id, {
      reference: "Subscription/live",
      receivedAt: at(0),
      notificationType: "heartbeat",
      eventsSinceSubscriptionStart: "3",
    });
    const findings = await live.recordContinuity(id, {
      reference: "Subscription/live",
      receivedAt: at(60),
      notificationType: "heartbeat",
      eventsSinceSubscriptionStart: "7",
    });

    expect(findings.some((f) => f.message.includes("3 notifications appear"))).toBe(true);
    const record = (await live.getSnapshot(id))!.endpoint.continuity[0];
    expect(record.missedEvents).toBe(3);
    expect(record.lastEventCount).toBe(7);
  });

  it("puts a TTL on both keys, so abandoned endpoints expire", async () => {
    const { id } = (await live.createEndpoint(liveId()))!;
    await live.addMessage(id, message());

    expect(await redis.ttl(`endpoint:${id}`)).toBeGreaterThan(0);
    expect(await redis.ttl(`endpoint:${id}:messages`)).toBeGreaterThan(0);
  });
});

describe("endpoint lifetime", () => {
  const VAR = "NOTIFYR_ENDPOINT_TTL_SECONDS";
  const saved = process.env[VAR];

  afterEach(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  });

  it("defaults to four hours", () => {
    delete process.env[VAR];
    expect(endpointTtlSeconds()).toBe(4 * 60 * 60);
    expect(DEFAULT_ENDPOINT_TTL_SECONDS).toBe(14_400);
  });

  it("takes a deployment's own value", () => {
    process.env[VAR] = "900";
    expect(endpointTtlSeconds()).toBe(900);
  });

  it("clamps rather than trusting: a minute to a week", () => {
    process.env[VAR] = "5";
    expect(endpointTtlSeconds()).toBe(60);
    process.env[VAR] = "99999999";
    expect(endpointTtlSeconds()).toBe(7 * 24 * 60 * 60);
  });

  // A public instance that will not boot is a worse answer to a typo than one
  // that runs on the default clock.
  it("falls back to the default for nonsense", () => {
    for (const value of ["", "   ", "soon", "12.5", "-1e9x"]) {
      process.env[VAR] = value;
      expect(endpointTtlSeconds()).toBe(DEFAULT_ENDPOINT_TTL_SECONDS);
    }
  });

  it("gives Redis endpoints a deadline, and in-memory ones none", async () => {
    process.env[VAR] = "3600";

    const redis = new RedisStore(new FakeRedis());
    const endpoint = (await redis.createEndpoint())!;
    expect(endpoint.expiresAt).not.toBeNull();

    const ms = Date.parse(endpoint.expiresAt!) - Date.now();
    expect(ms).toBeGreaterThan(3_590_000);
    expect(ms).toBeLessThanOrEqual(3_600_000);

    // And it survives a round trip, rather than only being set on the way out.
    expect((await redis.getSnapshot(endpoint.id))?.endpoint.expiresAt).not.toBeNull();

    // Nothing in memory expires: the cap there is a count, not a clock.
    expect((await new InMemoryStore().createEndpoint())!.expiresAt).toBeNull();
  });

  it("pushes the deadline out on writes, but not on a version check", async () => {
    process.env[VAR] = "3600";
    const fake = new FakeRedis();
    const redis = new RedisStore(fake);
    const { id } = (await redis.createEndpoint())!;

    fake.ttls.set(`endpoint:${id}`, 5);
    await redis.getVersion(id);
    // A dashboard asking "anything new?" must not keep a dead endpoint alive.
    expect(fake.ttls.get(`endpoint:${id}`)).toBe(5);

    await redis.addMessage(id, message());
    expect(fake.ttls.get(`endpoint:${id}`)).toBe(3600);
  });
});

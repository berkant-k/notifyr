import { describe, expect, it } from "vitest";
import { validateBody } from "@/lib/validation";

const FHIR_JSON = "application/fhir+json";

/** The exact payload from the reference R4B server, used to catch regressions. */
const HANDSHAKE = {
  resourceType: "Bundle",
  id: "e221c521-673d-4d9f-8ad4-07e72664ec85",
  type: "history",
  timestamp: "2026-09-07T21:18:16.6850279+03:00",
  entry: [
    {
      fullUrl: "urn:uuid:1dd006b0-a65a-4b85-98b6-d363496d1f93",
      resource: {
        resourceType: "SubscriptionStatus",
        id: "1dd006b0-a65a-4b85-98b6-d363496d1f93",
        status: "active",
        type: "handshake",
        eventsSinceSubscriptionStart: "0",
        subscription: {
          reference: "http://localhost:5826/fhir/r4b/Subscription/berkant-test",
        },
        topic: "http://example.org/FHIR/SubscriptionTopic/encounter-complete",
      },
    },
  ],
};

/** Build a notification Bundle around one SubscriptionStatus. */
function notification(status: Record<string, unknown>, bundle: Record<string, unknown> = {}) {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "history",
    timestamp: "2026-09-07T21:18:16Z",
    entry: [{ resource: { resourceType: "SubscriptionStatus", ...status } }],
    ...bundle,
  });
}

const ACTIVE = {
  status: "active",
  subscription: { reference: "http://localhost:5826/fhir/r4b/Subscription/berkant-test" },
};

describe("accepted notifications", () => {
  // Regression guard: the `fhir-tool` package ships R4 only and SubscriptionStatus
  // arrived in R4B, so without lib/subscription.ts this is reported invalid.
  it("accepts the reference handshake payload with no issues at all", () => {
    const result = validateBody(JSON.stringify(HANDSHAKE), FHIR_JSON);
    expect(result.isValid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.validationErrors).toEqual([]);
    expect(result.notificationType).toBe("handshake");
    expect(result.summary).toBe("Handshake · Subscription/berkant-test");
  });

  it("accepts a heartbeat", () => {
    const result = validateBody(
      notification({ type: "heartbeat", eventsSinceSubscriptionStart: "4", ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.notificationType).toBe("heartbeat");
    expect(result.summary).toBe("Heartbeat · Subscription/berkant-test");
  });

  it("accepts an event-notification and counts its events and resources", () => {
    const body = JSON.stringify({
      resourceType: "Bundle",
      type: "history",
      timestamp: "2026-09-07T21:21:00Z",
      entry: [
        {
          resource: {
            resourceType: "SubscriptionStatus",
            type: "event-notification",
            notificationEvent: [{ eventNumber: "5" }],
            ...ACTIVE,
          },
        },
        { resource: { resourceType: "Patient", id: "p1" } },
      ],
    });
    const result = validateBody(body, FHIR_JSON);
    expect(result.isValid).toBe(true);
    expect(result.notificationType).toBe("event-notification");
    expect(result.summary).toBe("Event notification · 1 event · 1 resource");
  });

  it("accepts R5-style numeric eventsSinceSubscriptionStart", () => {
    const result = validateBody(
      notification({ type: "heartbeat", eventsSinceSubscriptionStart: 0, ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
  });

  it("accepts the query types", () => {
    for (const type of ["query-status", "query-event"] as const) {
      const result = validateBody(notification({ type, ...ACTIVE }), FHIR_JSON);
      expect(result.isValid).toBe(true);
      expect(result.notificationType).toBe(type);
    }
  });
});

describe("rejected notifications", () => {
  it("rejects an unknown notification type", () => {
    const result = validateBody(notification({ type: "handshakee", ...ACTIVE }), FHIR_JSON);
    expect(result.isValid).toBe(false);
    expect(result.notificationType).toBeNull();
  });

  it("rejects a missing type", () => {
    const result = validateBody(notification({ ...ACTIVE }), FHIR_JSON);
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.message.includes("type is required"))).toBe(true);
  });

  it("rejects a missing subscription", () => {
    const result = validateBody(notification({ type: "handshake", status: "active" }), FHIR_JSON);
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.message.includes("subscription is required"))).toBe(
      true,
    );
  });

  it("rejects a subscription without a reference", () => {
    const result = validateBody(
      notification({ type: "handshake", status: "active", subscription: {} }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
  });

  it("rejects an unknown status code", () => {
    const result = validateBody(
      notification({ type: "handshake", status: "activeee", subscription: ACTIVE.subscription }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
  });

  it("rejects a non-string topic", () => {
    const result = validateBody(notification({ type: "handshake", topic: 42, ...ACTIVE }), FHIR_JSON);
    expect(result.isValid).toBe(false);
  });

  // eventNumber is the only element R4B makes 1..1 on notificationEvent.
  it("rejects a notificationEvent without an eventNumber", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ timestamp: "2026-09-07T21:21:00Z" }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
    expect(
      result.validationErrors.some((e) => e.message.includes("eventNumber is required")),
    ).toBe(true);
  });

  it("locates the offending event when only one of several lacks an eventNumber", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ eventNumber: "1" }, {}, { eventNumber: "3" }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
    const locations = result.validationErrors.map((e) => e.location);
    expect(locations).toContain("Bundle.entry[0].resource.notificationEvent[1].eventNumber");
    expect(locations).not.toContain("Bundle.entry[0].resource.notificationEvent[0].eventNumber");
  });

  it("rejects an empty eventNumber, which is not a valid FHIR string", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ eventNumber: "" }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
  });

  // sst-1 is a rule, so an event-notification with no events is invalid, not
  // merely odd. Handshakes and heartbeats are untouched by it.
  it("rejects an event-notification carrying no events, per sst-1", () => {
    const result = validateBody(
      notification({ type: "event-notification", notificationEvent: [], ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.message.includes("sst-1"))).toBe(true);
  });

  it("rejects an event-notification with the element absent entirely", () => {
    const result = validateBody(
      notification({ type: "event-notification", ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
  });

  it("rejects a non-array error element", () => {
    const result = validateBody(
      notification({ type: "handshake", error: { text: "boom" }, ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
  });

  it("rejects an error entry that is not a CodeableConcept", () => {
    const result = validateBody(
      notification({ type: "handshake", error: ["boom"], ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
    expect(
      result.validationErrors.some((e) => e.location === "Bundle.entry[0].resource.error[0]"),
    ).toBe(true);
  });

  it("rejects a focus that is not a Reference object", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ eventNumber: "1", focus: "Encounter/example" }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
  });

  it("rejects a non-array additionalContext", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [
          { eventNumber: "1", additionalContext: { reference: "Patient/example" } },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
  });

  it("rejects a notificationEvent that is not an object", () => {
    const result = validateBody(
      notification({ type: "event-notification", notificationEvent: [1, "2"], ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
    expect(
      result.validationErrors.filter((e) => e.message.includes("must be an object")),
    ).toHaveLength(2);
  });

  // The status entry is stripped before the library runs; siblings must not be.
  it("still catches an invalid sibling resource in the same Bundle", () => {
    const body = JSON.stringify({
      resourceType: "Bundle",
      type: "history",
      timestamp: "2026-09-07T21:27:00Z",
      entry: [
        {
          resource: {
            resourceType: "SubscriptionStatus",
            type: "event-notification",
            notificationEvent: [{ eventNumber: "1" }],
            ...ACTIVE,
          },
        },
        { resource: { resourceType: "Patient", id: "p", gender: "NOT-A-GENDER" } },
      ],
    });
    const result = validateBody(body, FHIR_JSON);
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.location === "Patient.gender")).toBe(true);
  });
});

describe("warnings that do not fail a notification", () => {
  it("warns when Bundle.type is not history", () => {
    const result = validateBody(
      notification({ type: "handshake", ...ACTIVE }, { type: "searchset" }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors.some((e) => e.location === "Bundle.type")).toBe(true);
  });

  it("warns when the Bundle has no timestamp", () => {
    const body = JSON.stringify({
      resourceType: "Bundle",
      type: "history",
      entry: [{ resource: { resourceType: "SubscriptionStatus", type: "handshake", ...ACTIVE } }],
    });
    const result = validateBody(body, FHIR_JSON);
    expect(result.isValid).toBe(true);
    expect(result.validationErrors.some((e) => e.location === "Bundle.timestamp")).toBe(true);
  });

  /*
    The R4B SubscriptionStatus page marks notificationEvent "Special" for both
    handshake and heartbeat: "A server MAY include historical events for a
    client with a `heartbeat`, if any exist." A server catching a client up
    after a reconnect is behaving correctly, and an earlier version of this
    validator warned about it — citing the page that permits it.
  */
  it("accepts a handshake or heartbeat carrying historical events", () => {
    for (const type of ["handshake", "heartbeat"] as const) {
      const result = validateBody(
        notification({ type, notificationEvent: [{ eventNumber: "1" }], ...ACTIVE }),
        FHIR_JSON,
      );
      expect(result.isValid, type).toBe(true);
      expect(result.validationErrors, type).toEqual([]);
    }
  });

  // The one type the spec does prohibit events on: "A `query-status`
  // notification SHALL NOT contain any event information."
  it("warns when a query-status carries event information", () => {
    const result = validateBody(
      notification({ type: "query-status", notificationEvent: [{ eventNumber: "1" }], ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(
      result.validationErrors.some((e) => e.message.includes("must not carry event information")),
    ).toBe(true);
  });

  it("accepts a query-status with no events", () => {
    const result = validateBody(notification({ type: "query-status", ...ACTIVE }), FHIR_JSON);
    expect(result.isValid).toBe(true);
    expect(result.validationErrors).toEqual([]);
  });

  // R4B types eventNumber as a string and R5 as integer64; both are accepted,
  // so only a value that is not a whole number is worth mentioning.
  it("accepts an R5-style numeric eventNumber", () => {
    const result = validateBody(
      notification({ type: "event-notification", notificationEvent: [{ eventNumber: 7 }], ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors).toEqual([]);
  });

  it("warns on a non-numeric eventNumber", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ eventNumber: "seven" }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(
      result.validationErrors.some(
        (e) => e.severity === "warning" && e.message.includes("whole event number"),
      ),
    ).toBe(true);
  });

  it("accepts a fully populated event-notification with no issues at all", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [
          {
            eventNumber: "1",
            timestamp: "2026-09-07T21:21:00.123+03:00",
            focus: { reference: "Encounter/example" },
            additionalContext: [{ reference: "Patient/example" }],
          },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors).toEqual([]);
  });

  // instant requires a timezone; without one the event cannot be ordered.
  it("warns on a timestamp with no timezone", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ eventNumber: "1", timestamp: "2026-09-07T21:21:00" }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(
      result.validationErrors.some((e) => e.location?.endsWith("notificationEvent[0].timestamp")),
    ).toBe(true);
  });

  it("warns on a focus that identifies nothing", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ eventNumber: "1", focus: { display: "an encounter" } }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(
      result.validationErrors.some((e) => e.message.includes("carries no reference")),
    ).toBe(true);
  });

  it("warns on a relative topic, which a receiver cannot resolve", () => {
    const result = validateBody(
      notification({ type: "handshake", topic: "SubscriptionTopic/encounter-complete", ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors.some((e) => e.message.includes("absolute canonical"))).toBe(true);
  });

  it("accepts a urn: topic as absolute", () => {
    const result = validateBody(
      notification({ type: "handshake", topic: "urn:uuid:0e7c4a2e-96a1-4d61-9f0e-3a6b1e2c5d77", ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors).toEqual([]);
  });

  it("warns on an error that says nothing about what failed", () => {
    const result = validateBody(
      notification({ type: "handshake", error: [{}], ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors.some((e) => e.message.includes("says nothing"))).toBe(true);
  });

  it("accepts an error carrying a coding", () => {
    const result = validateBody(
      notification({
        type: "handshake",
        error: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/subscription-error",
                code: "no-endpoint",
              },
            ],
          },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors).toEqual([]);
  });

  it("warns when SubscriptionStatus is not the first entry", () => {
    const body = JSON.stringify({
      resourceType: "Bundle",
      type: "history",
      timestamp: "2026-09-07T21:18:16Z",
      entry: [
        { resource: { resourceType: "Patient", id: "p1" } },
        { resource: { resourceType: "SubscriptionStatus", type: "handshake", ...ACTIVE } },
      ],
    });
    const result = validateBody(body, FHIR_JSON);
    expect(result.isValid).toBe(true);
    expect(result.validationErrors.some((e) => e.location === "Bundle.entry[1]")).toBe(true);
  });

  it("warns on a non-numeric event count", () => {
    const result = validateBody(
      notification({ type: "heartbeat", eventsSinceSubscriptionStart: "lots", ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.validationErrors.some((e) => e.severity === "warning")).toBe(true);
  });
});

describe("eventsSinceSubscriptionStart and topic", () => {
  const TOPIC = "http://example.org/FHIR/SubscriptionTopic/encounter-complete";

  it("captures both from the reference handshake payload", () => {
    const result = validateBody(JSON.stringify(HANDSHAKE), FHIR_JSON);
    expect(result.eventsSinceSubscriptionStart).toBe("0");
    expect(result.topic).toBe("http://example.org/FHIR/SubscriptionTopic/encounter-complete");
  });

  // R4B types the field as a string, R5 as integer64. Both normalise to a
  // string so the table has one thing to render.
  it("normalises an R5 numeric count to a string", () => {
    const result = validateBody(
      notification({ type: "heartbeat", eventsSinceSubscriptionStart: 7, ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.eventsSinceSubscriptionStart).toBe("7");
  });

  it("keeps an R4B string count as sent", () => {
    const result = validateBody(
      notification({ type: "heartbeat", eventsSinceSubscriptionStart: "12", ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.eventsSinceSubscriptionStart).toBe("12");
  });

  it("preserves zero rather than treating it as absent", () => {
    const result = validateBody(
      notification({ type: "handshake", eventsSinceSubscriptionStart: 0, ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.eventsSinceSubscriptionStart).toBe("0");
  });

  it("keeps a non-numeric count so the sender can see what it sent", () => {
    const result = validateBody(
      notification({ type: "heartbeat", eventsSinceSubscriptionStart: "lots", ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.eventsSinceSubscriptionStart).toBe("lots");
    expect(result.isValid).toBe(true);
  });

  it("is null when the fields are absent", () => {
    const result = validateBody(notification({ type: "heartbeat", ...ACTIVE }), FHIR_JSON);
    expect(result.eventsSinceSubscriptionStart).toBeNull();
    expect(result.topic).toBeNull();
  });

  it("is null for a non-scalar count rather than rendering [object Object]", () => {
    const result = validateBody(
      notification({ type: "heartbeat", eventsSinceSubscriptionStart: { n: 1 }, ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.eventsSinceSubscriptionStart).toBeNull();
  });

  it("captures the topic on any notification type", () => {
    const result = validateBody(
      notification({ type: "event-notification", notificationEvent: [{ eventNumber: "1" }], topic: TOPIC, ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.topic).toBe(TOPIC);
  });

  it("is null for an invalid non-string topic", () => {
    const result = validateBody(
      notification({ type: "handshake", topic: 42, ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
    expect(result.topic).toBeNull();
  });
});

describe("spec citations", () => {
  const NOTIFICATIONS = "https://hl7.org/fhir/uv/subscriptions-backport/notifications.html";
  const STATUS = "https://hl7.org/fhir/R4B/subscriptionstatus.html";

  it("cites the IG's notifications page for envelope rules", () => {
    const result = validateBody(
      notification({ type: "handshake", ...ACTIVE }, { type: "searchset" }),
      FHIR_JSON,
    );
    const issue = result.validationErrors.find((e) => e.location === "Bundle.type");
    expect(issue?.spec).toBe(NOTIFICATIONS);
  });

  it("cites SubscriptionStatus for its element rules", () => {
    const result = validateBody(notification({ ...ACTIVE }), FHIR_JSON);
    const issue = result.validationErrors.find((e) => e.message.includes("type is required"));
    expect(issue?.spec).toBe(STATUS);
  });

  it("cites the Subscription resource for a wrong Content-Type", () => {
    const result = validateBody(notification({ type: "handshake", ...ACTIVE }), "application/json");
    const issue = result.validationErrors.find((e) => e.message.includes("Content-Type"));
    expect(issue?.spec).toBe("https://hl7.org/fhir/R4B/subscription.html");
  });

  // A new rule added without a citation should fail here rather than ship as an
  // unsourced assertion about someone else's server.
  it("cites every finding it raises itself", () => {
    const result = validateBody(
      notification(
        {
          type: "event-notification",
          status: "nonsense",
          topic: "SubscriptionTopic/relative",
          notificationEvent: [{ timestamp: "not-an-instant", focus: {} }],
          subscription: {},
        },
        { type: "searchset" },
      ),
      "application/json",
    );

    expect(result.validationErrors.length).toBeGreaterThan(5);
    for (const issue of result.validationErrors) {
      expect(issue.spec, `uncited: ${issue.message}`).toMatch(/^https:\/\/hl7\.org\//);
    }
  });

  // The `fhir-tool` package validates against R4 conformance resources, not a page.
  it("leaves library findings uncited", () => {
    const result = validateBody('{"resourceType":"Patient","gender":"NOT-A-GENDER"}', FHIR_JSON);
    const issue = result.validationErrors.find((e) => e.location === "Patient.gender");
    expect(issue).toBeDefined();
    expect(issue?.spec).toBeUndefined();
  });
});

describe("focusResourceTypes", () => {
  it("extracts the type from a relative focus reference", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [{ eventNumber: "1", focus: { reference: "Encounter/example" } }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.focusResourceTypes).toEqual(["Encounter"]);
  });

  it("extracts the type from an absolute focus reference", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [
          { eventNumber: "1", focus: { reference: "http://example.org/fhir/Encounter/123" } },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    // A naive "first word before a slash" match would find "org" here instead.
    expect(result.focusResourceTypes).toEqual(["Encounter"]);
  });

  it("drops a trailing _history/{vid} before reading the type", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [
          {
            eventNumber: "1",
            focus: { reference: "http://example.org/fhir/Encounter/123/_history/2" },
          },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.focusResourceTypes).toEqual(["Encounter"]);
  });

  it("excludes additionalContext, counting only focus", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [
          {
            eventNumber: "1",
            focus: { reference: "Encounter/example" },
            additionalContext: [{ reference: "Patient/example" }],
          },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.focusResourceTypes).toEqual(["Encounter"]);
  });

  it("counts one occurrence per notificationEvent, duplicates included", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [
          { eventNumber: "1", focus: { reference: "Encounter/a" } },
          { eventNumber: "2", focus: { reference: "Encounter/b" } },
          { eventNumber: "3", focus: { reference: "Patient/c" } },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.focusResourceTypes).toEqual(["Encounter", "Encounter", "Patient"]);
  });

  it("skips a focus reference with no recognisable type", () => {
    const result = validateBody(
      notification({
        type: "event-notification",
        notificationEvent: [
          { eventNumber: "1", focus: { reference: "urn:uuid:1dd006b0-a65a-4b85-98b6-d363496d1f93" } },
          { eventNumber: "2", focus: { reference: "example" } },
          { eventNumber: "3", focus: { reference: "Patient/example" } },
        ],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.focusResourceTypes).toEqual(["Patient"]);
  });

  it("is empty for a notification with no focus at all", () => {
    const result = validateBody(
      notification({ type: "event-notification", notificationEvent: [{ eventNumber: "1" }], ...ACTIVE }),
      FHIR_JSON,
    );
    expect(result.focusResourceTypes).toEqual([]);
  });

  it("is empty for a handshake or heartbeat, even if notificationEvent is present", () => {
    const result = validateBody(
      notification({
        type: "heartbeat",
        notificationEvent: [{ eventNumber: "1", focus: { reference: "Encounter/example" } }],
        ...ACTIVE,
      }),
      FHIR_JSON,
    );
    expect(result.focusResourceTypes).toEqual([]);
  });

  it("is empty for an ordinary, non-notification resource", () => {
    const result = validateBody('{"resourceType":"Patient","id":"a"}', FHIR_JSON);
    expect(result.focusResourceTypes).toEqual([]);
  });
});

describe("non-notifications", () => {
  it("leaves notificationType null for an ordinary resource", () => {
    const result = validateBody('{"resourceType":"Patient","id":"a"}', FHIR_JSON);
    expect(result.notificationType).toBeNull();
    expect(result.eventsSinceSubscriptionStart).toBeNull();
    expect(result.topic).toBeNull();
  });

  it("leaves notificationType null for a Bundle with no SubscriptionStatus", () => {
    const result = validateBody(
      '{"resourceType":"Bundle","type":"searchset","entry":[{"resource":{"resourceType":"Patient","id":"a"}}]}',
      FHIR_JSON,
    );
    expect(result.notificationType).toBeNull();
  });
});

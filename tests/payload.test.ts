/**
 * Payload content conformance, per
 * https://hl7.org/fhir/uv/subscriptions-backport/payloads.html.
 *
 * Driven through validateBody rather than the rules directly, so the wiring
 * that decides *when* payload rules apply is covered too — they describe what
 * an event-notification carries, and must never be applied to a handshake.
 */

import { describe, expect, it } from "vitest";
import { compatiblePayloadContents, payloadShape } from "@/lib/payload";
import type { PayloadContent } from "@/lib/types";
import { validateBody } from "@/lib/validation";

const FHIR_JSON = "application/fhir+json";
const SUBSCRIPTION = { reference: "http://localhost:5826/fhir/r4b/Subscription/berkant-test" };

const FOCUS = { eventNumber: "1", focus: { reference: "Patient/p1" } };
const ID_ONLY_ENTRY = {
  fullUrl: "http://localhost:5826/fhir/r4b/Patient/p1",
  request: { method: "PUT", url: "Patient/p1" },
};
const FULL_ENTRY = { ...ID_ONLY_ENTRY, resource: { resourceType: "Patient", id: "p1" } };

function bundle({
  type = "event-notification",
  events = [{ eventNumber: "1" }] as Record<string, unknown>[],
  entries = [] as Record<string, unknown>[],
}): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "history",
    timestamp: "2026-09-07T21:21:00Z",
    entry: [
      {
        resource: {
          resourceType: "SubscriptionStatus",
          type,
          status: "active",
          subscription: SUBSCRIPTION,
          notificationEvent: events,
        },
      },
      ...entries,
    ],
  });
}

/** Only the payload findings; every fixture here is otherwise well-formed. */
function warnings(body: string, expected: PayloadContent | null = null): string[] {
  return validateBody(body, FHIR_JSON, expected)
    .validationErrors.filter((issue) => issue.severity === "warning")
    .map((issue) => issue.message);
}

describe("shape counting", () => {
  it("counts entries, resources, URLs and references, ignoring the status entry", () => {
    const status = {
      notificationEvent: [
        { eventNumber: "1", focus: { reference: "Patient/p1" } },
        { eventNumber: "2", additionalContext: [{ reference: "Encounter/e1" }, {}] },
      ],
    };
    const shape = payloadShape([{ resource: {} }, FULL_ENTRY, ID_ONLY_ENTRY], 0, status);

    expect(shape).toEqual({ entries: 2, withResource: 1, withUrl: 2, references: 3 });
  });

  it("reads the status entry wherever it sits", () => {
    const shape = payloadShape([FULL_ENTRY, { resource: {} }], 1, {});
    expect(shape.entries).toBe(1);
    expect(shape.withResource).toBe(1);
  });
});

describe("compatibility with no expectation", () => {
  const cases: [string, Parameters<typeof payloadShape>[2], Record<string, unknown>[], PayloadContent[]][] =
    [
      ["nothing at all", {}, [], ["empty"]],
      [
        "references but no entries",
        { notificationEvent: [FOCUS] },
        [],
        ["id-only"],
      ],
      [
        "references and id-only entries",
        { notificationEvent: [FOCUS] },
        [ID_ONLY_ENTRY],
        ["id-only"],
      ],
      [
        "references and full entries",
        { notificationEvent: [FOCUS] },
        [FULL_ENTRY],
        ["full-resource"],
      ],
    ];

  for (const [name, status, entries, expected] of cases) {
    it(`treats ${name} as ${expected.join(" or ")}`, () => {
      const shape = payloadShape([{ resource: {} }, ...entries], 0, status);
      expect(compatiblePayloadContents(shape)).toEqual(expected);
    });
  }

  // The case worth catching without any configuration at all: content was sent,
  // but nothing says which resources changed, so no payload level allows it.
  it("warns when a notification matches none of the levels", () => {
    const found = warnings(bundle({ entries: [FULL_ENTRY] }));
    expect(found.some((message) => message.includes("matches none of the payload types"))).toBe(
      true,
    );
  });

  it("stays quiet when the notification matches a level", () => {
    expect(warnings(bundle({ events: [FOCUS], entries: [ID_ONLY_ENTRY] }))).toEqual([]);
    expect(warnings(bundle({ events: [FOCUS], entries: [FULL_ENTRY] }))).toEqual([]);
    expect(warnings(bundle({}))).toEqual([]);
  });
});

describe("checked against an expectation", () => {
  it("accepts each level's own shape without comment", () => {
    expect(warnings(bundle({}), "empty")).toEqual([]);
    expect(warnings(bundle({ events: [FOCUS], entries: [ID_ONLY_ENTRY] }), "id-only")).toEqual([]);
    expect(warnings(bundle({ events: [FOCUS], entries: [FULL_ENTRY] }), "full-resource")).toEqual(
      [],
    );
  });

  it("reports entries and references on an empty payload", () => {
    const found = warnings(bundle({ events: [FOCUS], entries: [FULL_ENTRY] }), "empty");
    expect(found.some((message) => message.includes("no entries besides"))).toBe(true);
    expect(found.some((message) => message.includes("references no resources"))).toBe(true);
  });

  it("reports resource content on an id-only payload", () => {
    const found = warnings(bundle({ events: [FOCUS], entries: [FULL_ENTRY] }), "id-only");
    expect(found.some((message) => message.includes("carries no resource content"))).toBe(true);
  });

  it("reports an id-only entry that identifies nothing", () => {
    const found = warnings(
      bundle({ events: [FOCUS], entries: [{ fullUrl: "http://x/Patient/p1" }] }),
      "id-only",
    );
    expect(found.some((message) => message.includes("fullUrl and request"))).toBe(true);
  });

  it("reports missing focus references on both content levels", () => {
    for (const level of ["id-only", "full-resource"] as const) {
      const found = warnings(bundle({ entries: [FULL_ENTRY] }), level);
      expect(found.some((message) => message.includes("notificationEvent.focus"))).toBe(true);
    }
  });

  it("reports a full-resource payload carrying no resources", () => {
    const found = warnings(bundle({ events: [FOCUS] }), "full-resource");
    expect(found.some((message) => message.includes("no entries besides"))).toBe(true);
  });

  it("reports a full-resource entry that carries only a URL", () => {
    const found = warnings(bundle({ events: [FOCUS], entries: [ID_ONLY_ENTRY] }), "full-resource");
    expect(found.some((message) => message.includes("entry.resource"))).toBe(true);
  });

  // A mismatch means the sender and the dropdown disagree — not that the
  // notification is malformed, and never a reason to drop it from the counters.
  it("never makes a notification invalid", () => {
    const result = validateBody(bundle({ events: [FOCUS], entries: [FULL_ENTRY] }), FHIR_JSON, "empty");
    expect(result.isValid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.notificationType).toBe("event-notification");
  });

  it("cites the IG's payloads page on every payload finding", () => {
    const issues = validateBody(
      bundle({ events: [FOCUS], entries: [FULL_ENTRY] }),
      FHIR_JSON,
      "empty",
    ).validationErrors;

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.spec).toBe("https://hl7.org/fhir/uv/subscriptions-backport/payloads.html");
    }
  });

  // Payload configuration says nothing about handshakes and heartbeats: they
  // carry no resources whatever the Subscription was set to.
  it("leaves handshakes and heartbeats alone", () => {
    for (const type of ["handshake", "heartbeat"] as const) {
      for (const level of ["empty", "id-only", "full-resource"] as const) {
        expect(warnings(bundle({ type, events: [] }), level)).toEqual([]);
      }
    }
  });
});

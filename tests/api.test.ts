/**
 * Drives the real route handlers directly. No dev server needed, so this runs
 * unchanged in CI while still covering the create -> POST -> poll round trip.
 */

import { describe, expect, it } from "vitest";
import { GET as getMessages } from "@/app/api/endpoints/[endpointId]/messages/route";
import { PUT as putExpectedEnd } from "@/app/api/endpoints/[endpointId]/expected-end/route";
import { PUT as putHeartbeatPeriod } from "@/app/api/endpoints/[endpointId]/heartbeat-period/route";
import { PUT as putPayloadContent } from "@/app/api/endpoints/[endpointId]/payload-content/route";
import { PUT as putResourceCounts } from "@/app/api/endpoints/[endpointId]/resource-counts/route";
import { PUT as putRules } from "@/app/api/endpoints/[endpointId]/response-rules/route";
import { POST as createEndpoint } from "@/app/api/endpoints/route";
import {
  GET as hookGet,
  POST as hookPost,
  PUT as hookPut,
} from "@/app/hook/[endpointId]/[[...path]]/route";
import {
  MAX_RECENT_MESSAGES,
  type CreateEndpointResponse,
  type EndpointSnapshot,
  type MessagesResponse,
} from "@/lib/types";

const ORIGIN = "http://localhost:3000";
const FHIR_JSON = "application/fhir+json";

function params(endpointId: string) {
  return { params: Promise.resolve({ endpointId }) };
}

/** Like `params`, but for the hook route's optional catch-all subpath. */
function hookParams(endpointId: string, path?: string[]) {
  return { params: Promise.resolve({ endpointId, path }) };
}

/** POST /api/endpoints, optionally requesting a specific id. */
function create(body?: unknown) {
  return createEndpoint(
    new Request(`${ORIGIN}/api/endpoints`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

async function newEndpoint(): Promise<string> {
  const body: CreateEndpointResponse = await (await create()).json();
  return body.id;
}

function send(endpointId: string, body: string, contentType: string | null = FHIR_JSON) {
  return hookPost(
    new Request(`${ORIGIN}/hook/${endpointId}`, {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : {},
      body,
    }),
    params(endpointId),
  );
}

function poll(endpointId: string, since?: number) {
  const query = since === undefined ? "" : `?since=${since}`;
  return getMessages(
    new Request(`${ORIGIN}/api/endpoints/${endpointId}/messages${query}`),
    params(endpointId),
  );
}

const HANDSHAKE = JSON.stringify({
  resourceType: "Bundle",
  type: "history",
  timestamp: "2026-09-07T21:18:16.6850279+03:00",
  entry: [
    {
      resource: {
        resourceType: "SubscriptionStatus",
        status: "active",
        type: "handshake",
        eventsSinceSubscriptionStart: "0",
        subscription: { reference: "http://localhost:5826/fhir/r4b/Subscription/berkant-test" },
        topic: "http://example.org/FHIR/SubscriptionTopic/encounter-complete",
      },
    },
  ],
});

describe("POST /api/endpoints", () => {
  it("returns 201 with an id and an absolute webhook URL", async () => {
    const response = await createEndpoint(
      new Request(`${ORIGIN}/api/endpoints`, { method: "POST" }),
    );
    expect(response.status).toBe(201);

    const body: CreateEndpointResponse = await response.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toBe(`${ORIGIN}/hook/${body.id}`);
  });

  it("accepts a caller-supplied id and uses it verbatim", async () => {
    const id = `my-test-hook-${Date.now()}`;
    const response = await create({ id });
    expect(response.status).toBe(201);

    const body: CreateEndpointResponse = await response.json();
    expect(body.id).toBe(id);
    expect(body.url).toBe(`${ORIGIN}/hook/${id}`);
  });

  it("trims whitespace around a supplied id", async () => {
    const id = `padded-${Date.now()}`;
    const body: CreateEndpointResponse = await (await create({ id: `  ${id}  ` })).json();
    expect(body.id).toBe(id);
  });

  it("falls back to a random id for an empty or absent id", async () => {
    for (const body of [undefined, {}, { id: "" }, { id: null }]) {
      const response = await create(body);
      expect(response.status).toBe(201);
      const created: CreateEndpointResponse = await response.json();
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("409s when the id is taken, and points at the existing dashboard", async () => {
    const id = `taken-${Date.now()}`;
    expect((await create({ id })).status).toBe(201);

    const response = await create({ id });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      existingDashboard: `/dashboard/${id}`,
    });
  });

  it("400s on an id with unsupported characters", async () => {
    for (const id of ["has space", "a/b", "emoji-🎉", "..", "x".repeat(65)]) {
      const response = await create({ id });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toHaveProperty("error");
    }
  });

  it("400s on a non-string id", async () => {
    expect((await create({ id: 42 })).status).toBe(400);
  });

  it("400s on a malformed JSON body", async () => {
    const response = await createEndpoint(
      new Request(`${ORIGIN}/api/endpoints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("derives the origin from proxy headers", async () => {
    const response = await createEndpoint(
      new Request(`${ORIGIN}/api/endpoints`, {
        method: "POST",
        headers: { "x-forwarded-host": "notifyr.vercel.app", "x-forwarded-proto": "https" },
      }),
    );
    const body: CreateEndpointResponse = await response.json();
    expect(body.url).toBe(`https://notifyr.vercel.app/hook/${body.id}`);
  });
});

describe("POST /hook/:endpointId", () => {
  it("404s for an unknown endpoint", async () => {
    const response = await send("does-not-exist", '{"resourceType":"Patient"}');
    expect(response.status).toBe(404);
  });

  it("accepts a valid resource with 200", async () => {
    const id = await newEndpoint();
    const response = await send(id, '{"resourceType":"Patient","id":"a","gender":"male"}');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ received: true, valid: true });
  });

  it("records malformed JSON with 400 rather than dropping it", async () => {
    const id = await newEndpoint();
    const response = await send(id, '{"resourceType":');
    expect(response.status).toBe(400);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].rawBody).toBe('{"resourceType":');
  });

  it("returns 422 for JSON that is not a FHIR resource", async () => {
    const id = await newEndpoint();
    expect((await send(id, '{"event":"ping"}', "application/json")).status).toBe(422);
  });

  it("accepts a handshake with 200", async () => {
    const id = await newEndpoint();
    const response = await send(id, HANDSHAKE);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ valid: true, issues: 0 });
  });

  it("rejects a body over the size cap with 413", async () => {
    const id = await newEndpoint();
    const huge = `{"resourceType":"Patient","id":"${"x".repeat(1_000_001)}"}`;
    expect((await send(id, huge)).status).toBe(413);
  });

  it("surfaces eventsSinceSubscriptionStart and topic on the message", async () => {
    const id = await newEndpoint();
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const message = snapshot.messages[0];

    expect(message.eventsSinceSubscriptionStart).toBe("0");
    expect(message.topic).toBe("http://example.org/FHIR/SubscriptionTopic/encounter-complete");
  });

  it("leaves both null for a plain resource", async () => {
    const id = await newEndpoint();
    await send(id, '{"resourceType":"Patient","id":"a","gender":"male"}');

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].eventsSinceSubscriptionStart).toBeNull();
    expect(snapshot.messages[0].topic).toBeNull();
  });

  it("records request headers on the message", async () => {
    const id = await newEndpoint();
    await hookPost(
      new Request(`${ORIGIN}/hook/${id}`, {
        method: "POST",
        headers: {
          "content-type": FHIR_JSON,
          "user-agent": "fhir-candle/1.0",
          authorization: "Bearer inspect-me",
        },
        body: '{"resourceType":"Patient","id":"a"}',
      }),
      params(id),
    );

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const headers = snapshot.messages[0].headers;

    expect(headers.find((h) => h.name === "user-agent")?.value).toBe("fhir-candle/1.0");
    // Authorization reaches the dashboard intact, flagged for the UI to label.
    const auth = headers.find((h) => h.name === "authorization");
    expect(auth?.value).toBe("Bearer inspect-me");
    expect(auth?.sensitive).toBe(true);
  });

  it("answers GET with 405 and a pointer to the dashboard, but still captures it", async () => {
    const id = await newEndpoint();
    const response = await hookGet(new Request(`${ORIGIN}/hook/${id}`), params(id));

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, PUT");
    await expect(response.json()).resolves.toMatchObject({ dashboard: `/dashboard/${id}` });

    // The wire response stays a helpful pointer for whoever pasted the URL
    // into a browser, but the visit is no longer invisible to the dashboard.
    // Graded as a warning, not the fatal "empty body" a POST with nothing in
    // it would get — a GET having no body is the ordinary case, not a failure.
    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].method).toBe("GET");
    expect(snapshot.messages[0].requestPath).toBeNull();
    expect(snapshot.messages[0].isValid).toBe(true);
    expect(snapshot.messages[0].summary).toBe("Unexpected GET request");
    expect(snapshot.messages[0].validationErrors).toEqual([
      {
        severity: "warning",
        message:
          "Received an unexpected GET request. Subscription notifications are always sent with a body (POST or PUT).",
      },
    ]);
  });

  it("leaves requestPath null and method POST for the base webhook URL", async () => {
    const id = await newEndpoint();
    await send(id, '{"resourceType":"Patient","id":"a"}');

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].requestPath).toBeNull();
    expect(snapshot.messages[0].method).toBe("POST");
  });

  // Firely Server, among others, delivers rest-hook notifications via PUT
  // rather than POST — graded identically, since a PUT body is exactly as
  // much a notification attempt as a POST body.
  it("captures a PUT exactly like a POST", async () => {
    const id = await newEndpoint();
    const response = await hookPut(
      new Request(`${ORIGIN}/hook/${id}`, {
        method: "PUT",
        headers: { "content-type": FHIR_JSON },
        body: '{"resourceType":"Patient","id":"a"}',
      }),
      params(id),
    );

    expect(response.status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].method).toBe("PUT");
    expect(snapshot.messages[0].isValid).toBe(true);
    expect(snapshot.messages[0].summary).toBe("Patient/a");
  });
});

describe("GET /hook/:endpointId/metadata", () => {
  // The one request HAPI FHIR's optional SubscriptionRulesInterceptor makes
  // before it will accept a rest-hook Subscription — see docs/DESIGN.md.
  it("answers with a parseable CapabilityStatement", async () => {
    const id = await newEndpoint();
    const response = await hookGet(
      new Request(`${ORIGIN}/hook/${id}/metadata`),
      hookParams(id, ["metadata"]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/fhir+json");

    const body = await response.json();
    expect(body.resourceType).toBe("CapabilityStatement");
    expect(body.status).toBe("active");
    expect(body.fhirVersion).toBe("4.0.1");
    expect(body.rest[0].mode).toBe("server");
  });

  it("shows up in the message list as an info-level, valid entry", async () => {
    const id = await newEndpoint();
    await hookGet(new Request(`${ORIGIN}/hook/${id}/metadata`), hookParams(id, ["metadata"]));

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const message = snapshot.messages[0];
    expect(message.method).toBe("GET");
    expect(message.requestPath).toBe("metadata");
    expect(message.isValid).toBe(true);
    expect(message.summary).toBe("Metadata probe");
    expect(message.validationErrors).toEqual([
      {
        severity: "info",
        message: "Answered a capability statement reachability probe at /metadata.",
      },
    ]);
    expect(snapshot.endpoint.validCount).toBe(1);
  });

  it("404s for an unknown endpoint", async () => {
    const response = await hookGet(
      new Request(`${ORIGIN}/hook/does-not-exist/metadata`),
      hookParams("does-not-exist", ["metadata"]),
    );
    expect(response.status).toBe(404);
  });
});

describe("unexpected subpaths under /hook/:endpointId", () => {
  it("captures a POST to an unexpected subpath, with the path attached", async () => {
    const id = await newEndpoint();
    await hookPost(
      new Request(`${ORIGIN}/hook/${id}/foo/bar`, {
        method: "POST",
        headers: { "content-type": FHIR_JSON },
        body: '{"resourceType":"Patient","id":"a"}',
      }),
      hookParams(id, ["foo", "bar"]),
    );

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].requestPath).toBe("foo/bar");
    expect(snapshot.messages[0].isValid).toBe(true);
  });

  // Not a browser visit — nobody hand-types a random tail onto a webhook URL —
  // so unlike a bare GET this gets the real validation-driven status on the
  // wire rather than the "POST only" pointer. Still a GET, though, so it is
  // graded the same warning way a bare GET is, not as a malformed POST.
  it("captures a GET to an unexpected subpath instead of 405ing", async () => {
    const id = await newEndpoint();
    const response = await hookGet(
      new Request(`${ORIGIN}/hook/${id}/health`),
      hookParams(id, ["health"]),
    );

    expect(response.status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].method).toBe("GET");
    expect(snapshot.messages[0].requestPath).toBe("health");
    expect(snapshot.messages[0].isValid).toBe(true);
    expect(snapshot.messages[0].summary).toBe("Unexpected GET request");
  });
});

describe("GET /api/endpoints/:endpointId/messages", () => {
  it("404s for an unknown endpoint", async () => {
    expect((await poll("does-not-exist")).status).toBe(404);
  });

  it("returns the full snapshot when no version is supplied", async () => {
    const id = await newEndpoint();
    const body: MessagesResponse = await (await poll(id)).json();

    expect(body.changed).toBe(true);
    expect(body.version).toBe(0);
  });

  it("reports no change when the version still matches", async () => {
    const id = await newEndpoint();
    const body: MessagesResponse = await (await poll(id, 0)).json();

    expect(body).toEqual({ changed: false, version: 0 });
  });

  it("reports a change once a message arrives", async () => {
    const id = await newEndpoint();
    await send(id, HANDSHAKE);

    const body: MessagesResponse = await (await poll(id, 0)).json();
    expect(body.changed).toBe(true);
    expect(body.version).toBe(1);
    expect(body).toHaveProperty("messages");
  });

  it("is not cacheable", async () => {
    const id = await newEndpoint();
    expect((await poll(id)).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("message limit", () => {
  function pollWith(endpointId: string, query: string) {
    return getMessages(
      new Request(`${ORIGIN}/api/endpoints/${endpointId}/messages?${query}`),
      params(endpointId),
    );
  }

  /** More than one page, so a raised limit has something to return. */
  async function busyEndpoint(count: number): Promise<string> {
    const id = await newEndpoint();
    for (let i = 0; i < count; i += 1) {
      await send(id, `{"resourceType":"Patient","id":"p${i}","gender":"male"}`);
    }
    return id;
  }

  it("defaults to the recent-message page size", async () => {
    const id = await busyEndpoint(MAX_RECENT_MESSAGES + 5);
    const body: EndpointSnapshot = await (await poll(id)).json();
    expect(body.messages).toHaveLength(MAX_RECENT_MESSAGES);
  });

  it("returns more when asked", async () => {
    const id = await busyEndpoint(MAX_RECENT_MESSAGES + 5);
    const body: EndpointSnapshot = await (await pollWith(id, "limit=25")).json();
    expect(body.messages).toHaveLength(MAX_RECENT_MESSAGES + 5);
  });

  it("caps at what the store retains", async () => {
    const id = await busyEndpoint(3);
    const body: EndpointSnapshot = await (await pollWith(id, "limit=100000")).json();
    expect(body.messages).toHaveLength(3);
  });

  // A nonsense limit comes from a URL someone edited, not from the UI. Falling
  // back to the default keeps a working dashboard working.
  it("falls back to the default for a nonsense limit", async () => {
    const id = await busyEndpoint(MAX_RECENT_MESSAGES + 2);
    for (const query of ["limit=0", "limit=-5", "limit=abc", "limit=2.5", "limit="]) {
      const body: EndpointSnapshot = await (await pollWith(id, query)).json();
      expect(body.messages, query).toHaveLength(MAX_RECENT_MESSAGES);
    }
  });

  it("still answers 'nothing changed' when the version matches", async () => {
    const id = await busyEndpoint(2);
    const first: MessagesResponse = await (await poll(id)).json();
    const again: MessagesResponse = await (
      await pollWith(id, `limit=50&since=${first.version}`)
    ).json();

    expect(again.changed).toBe(false);
  });
});

describe("response overrides", () => {
  function setRules(endpointId: string, patch: unknown) {
    return putRules(
      new Request(`${ORIGIN}/api/endpoints/${endpointId}/response-rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
      params(endpointId),
    );
  }

  const HEARTBEAT = JSON.stringify({
    resourceType: "Bundle",
    type: "history",
    timestamp: "2026-09-08T09:00:00Z",
    entry: [
      {
        resource: {
          resourceType: "SubscriptionStatus",
          status: "active",
          type: "heartbeat",
          eventsSinceSubscriptionStart: "3",
          subscription: { reference: "Subscription/notifyr-test" },
        },
      },
    ],
  });

  it("answers 200 by default", async () => {
    const id = await newEndpoint();
    expect((await send(id, HANDSHAKE)).status).toBe(200);
  });

  it("forces the chosen status once the type is switched off", async () => {
    const id = await newEndpoint();
    expect((await setRules(id, { handshake: { enabled: false, status: 500 } })).status).toBe(200);

    expect((await send(id, HANDSHAKE)).status).toBe(500);
  });

  it("only affects the type that was switched off", async () => {
    const id = await newEndpoint();
    await setRules(id, { handshake: { enabled: false, status: 503 } });

    expect((await send(id, HANDSHAKE)).status).toBe(503);
    expect((await send(id, HEARTBEAT)).status).toBe(200);
    expect((await send(id, '{"resourceType":"Patient","id":"a","gender":"male"}')).status).toBe(200);
  });

  it("goes back to 200 when switched on again", async () => {
    const id = await newEndpoint();
    await setRules(id, { heartbeat: { enabled: false, status: 400 } });
    expect((await send(id, HEARTBEAT)).status).toBe(400);

    await setRules(id, { heartbeat: { enabled: true, status: 400 } });
    expect((await send(id, HEARTBEAT)).status).toBe(200);
  });

  // The whole point is to see the rejected notification, not to hide it.
  it("still records, validates and counts an overridden notification", async () => {
    const id = await newEndpoint();
    await setRules(id, { handshake: { enabled: false, status: 500 } });
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const message = snapshot.messages[0];

    expect(message.status).toBe(500);
    expect(message.statusOverridden).toBe(true);
    expect(message.isValid).toBe(true);
    expect(message.validationErrors).toEqual([]);
    expect(snapshot.endpoint.validCount).toBe(1);
    expect(snapshot.endpoint.notificationCounts.handshake).toBe(1);
  });

  it("marks a normal response as not overridden", async () => {
    const id = await newEndpoint();
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].statusOverridden).toBe(false);
  });

  // 204/205/304 must be sent with no body or the Response constructor throws.
  it.each([204, 205, 304])("answers bodiless status %i without throwing", async (status) => {
    const id = await newEndpoint();
    await setRules(id, { handshake: { enabled: false, status } });

    const response = await send(id, HANDSHAKE);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });

  it("overrides an invalid notification too, replacing its 422", async () => {
    const id = await newEndpoint();
    await setRules(id, { handshake: { enabled: false, status: 503 } });

    const badHandshake = JSON.stringify({
      resourceType: "Bundle",
      type: "history",
      timestamp: "2026-09-08T09:00:00Z",
      entry: [
        {
          resource: {
            resourceType: "SubscriptionStatus",
            status: "activeee",
            type: "handshake",
            subscription: { reference: "Subscription/x" },
          },
        },
      ],
    });

    const response = await send(id, badHandshake);
    expect(response.status).toBe(503);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].isValid).toBe(false);
  });

  it("rejects a bad status with 400 and leaves the rules untouched", async () => {
    const id = await newEndpoint();
    expect((await setRules(id, { handshake: { enabled: false, status: 200 } })).status).toBe(400);
    expect((await setRules(id, { handshake: { enabled: false, status: 99 } })).status).toBe(400);

    expect((await send(id, HANDSHAKE)).status).toBe(200);
  });

  it("404s for an unknown endpoint", async () => {
    const response = await setRules("does-not-exist", {
      handshake: { enabled: false, status: 400 },
    });
    expect(response.status).toBe(404);
  });

  it("bumps the version so an open dashboard notices", async () => {
    const id = await newEndpoint();
    const before: MessagesResponse = await (await poll(id)).json();

    await setRules(id, { handshake: { enabled: false, status: 400 } });

    const after: MessagesResponse = await (await poll(id, before.version)).json();
    expect(after.changed).toBe(true);
  });

  it("exposes the rules on the snapshot", async () => {
    const id = await newEndpoint();
    await setRules(id, { "event-notification": { enabled: false, status: 418 } });

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.responseRules["event-notification"]).toEqual({
      enabled: false,
      status: 418,
    });
    expect(snapshot.endpoint.responseRules.handshake.enabled).toBe(true);
  });
});

describe("expected payload content", () => {
  function setExpectation(endpointId: string, body: unknown) {
    return putPayloadContent(
      new Request(`${ORIGIN}/api/endpoints/${endpointId}/payload-content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params(endpointId),
    );
  }

  /** An event-notification carrying resource content but no focus references. */
  const FULL_EVENT = JSON.stringify({
    resourceType: "Bundle",
    type: "history",
    timestamp: "2026-09-08T09:00:00Z",
    entry: [
      {
        resource: {
          resourceType: "SubscriptionStatus",
          status: "active",
          type: "event-notification",
          subscription: { reference: "Subscription/notifyr-test" },
          notificationEvent: [{ eventNumber: "1", focus: { reference: "Patient/p1" } }],
        },
      },
      {
        fullUrl: "http://localhost:5826/fhir/r4b/Patient/p1",
        request: { method: "PUT", url: "Patient/p1" },
        resource: { resourceType: "Patient", id: "p1" },
      },
    ],
  });

  it("defaults to unset", async () => {
    const id = await newEndpoint();
    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedPayloadContent).toBeNull();
  });

  it("stores a level and exposes it on the snapshot", async () => {
    const id = await newEndpoint();
    expect((await setExpectation(id, { expectedPayloadContent: "id-only" })).status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedPayloadContent).toBe("id-only");
  });

  it("clears back to unset with null", async () => {
    const id = await newEndpoint();
    await setExpectation(id, { expectedPayloadContent: "empty" });
    await setExpectation(id, { expectedPayloadContent: null });

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedPayloadContent).toBeNull();
  });

  it("rejects an unknown level", async () => {
    const id = await newEndpoint();
    expect((await setExpectation(id, { expectedPayloadContent: "id_only" })).status).toBe(400);
    expect((await setExpectation(id, { expectedPayloadContent: 3 })).status).toBe(400);
  });

  it("404s for an unknown endpoint", async () => {
    expect((await setExpectation("does-not-exist", { expectedPayloadContent: null })).status).toBe(
      404,
    );
  });

  it("bumps the version so an open dashboard notices", async () => {
    const id = await newEndpoint();
    const before: MessagesResponse = await (await poll(id)).json();

    await setExpectation(id, { expectedPayloadContent: "full-resource" });

    const after: MessagesResponse = await (await poll(id, before.version)).json();
    expect(after.changed).toBe(true);
  });

  it("warns against the configured level without failing the notification", async () => {
    const id = await newEndpoint();
    await setExpectation(id, { expectedPayloadContent: "id-only" });

    expect((await send(id, FULL_EVENT)).status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const message = snapshot.messages[0];
    expect(message.isValid).toBe(true);
    expect(message.expectedPayloadContent).toBe("id-only");
    expect(
      message.validationErrors.some((issue) => issue.message.includes("no resource content")),
    ).toBe(true);
    expect(snapshot.endpoint.notificationCounts["event-notification"]).toBe(1);
  });

  // The expectation is applied at receive time; stored messages are never
  // re-validated, so each one records what it was actually judged against.
  it("applies to notifications received afterwards, not to stored ones", async () => {
    const id = await newEndpoint();
    await send(id, FULL_EVENT);
    await setExpectation(id, { expectedPayloadContent: "empty" });
    await send(id, FULL_EVENT);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const [newest, oldest] = snapshot.messages;

    expect(newest.expectedPayloadContent).toBe("empty");
    expect(newest.validationErrors.some((issue) => issue.message.includes('An "empty"'))).toBe(true);

    expect(oldest.expectedPayloadContent).toBeNull();
    expect(oldest.validationErrors).toEqual([]);
  });

  it("does not record an expectation on notifications it never applies to", async () => {
    const id = await newEndpoint();
    await setExpectation(id, { expectedPayloadContent: "full-resource" });
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].expectedPayloadContent).toBeNull();
    expect(snapshot.messages[0].validationErrors).toEqual([]);
  });
});

describe("expected resource counts", () => {
  function setExpected(endpointId: string, body: unknown) {
    return putResourceCounts(
      new Request(`${ORIGIN}/api/endpoints/${endpointId}/resource-counts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params(endpointId),
    );
  }

  /** An event-notification whose focus names an Encounter. */
  const ENCOUNTER_EVENT = JSON.stringify({
    resourceType: "Bundle",
    type: "history",
    timestamp: "2026-09-08T09:00:00Z",
    entry: [
      {
        resource: {
          resourceType: "SubscriptionStatus",
          status: "active",
          type: "event-notification",
          subscription: { reference: "Subscription/notifyr-test" },
          notificationEvent: [{ eventNumber: "1", focus: { reference: "Encounter/e1" } }],
        },
      },
    ],
  });

  it("defaults to unset", async () => {
    const id = await newEndpoint();
    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedResourceCounts).toEqual({});
    expect(snapshot.endpoint.resourceCounts).toEqual({});
  });

  it("stores a full map and exposes it on the snapshot", async () => {
    const id = await newEndpoint();
    expect(
      (await setExpected(id, { expectedResourceCounts: { Encounter: 2, Patient: 1 } })).status,
    ).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedResourceCounts).toEqual({ Encounter: 2, Patient: 1 });
  });

  it("replaces rather than merges", async () => {
    const id = await newEndpoint();
    await setExpected(id, { expectedResourceCounts: { Encounter: 2, Patient: 1 } });
    await setExpected(id, { expectedResourceCounts: { Patient: 3 } });

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedResourceCounts).toEqual({ Patient: 3 });
  });

  it("clears back to unset with an empty object", async () => {
    const id = await newEndpoint();
    await setExpected(id, { expectedResourceCounts: { Encounter: 2 } });
    await setExpected(id, { expectedResourceCounts: {} });

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedResourceCounts).toEqual({});
  });

  it("rejects a non-object body", async () => {
    expect((await setExpected(await newEndpoint(), { expectedResourceCounts: [] })).status).toBe(
      400,
    );
    expect(
      (await setExpected(await newEndpoint(), { expectedResourceCounts: "Encounter" })).status,
    ).toBe(400);
  });

  it("rejects a lower-case or otherwise malformed type name", async () => {
    const id = await newEndpoint();
    expect(
      (await setExpected(id, { expectedResourceCounts: { encounter: 1 } })).status,
    ).toBe(400);
  });

  it("rejects a negative or non-integer count", async () => {
    const id = await newEndpoint();
    expect((await setExpected(id, { expectedResourceCounts: { Encounter: -1 } })).status).toBe(400);
    expect((await setExpected(id, { expectedResourceCounts: { Encounter: 1.5 } })).status).toBe(400);
    expect((await setExpected(id, { expectedResourceCounts: { Encounter: "2" } })).status).toBe(400);
  });

  it("rejects more than the maximum number of types", async () => {
    const id = await newEndpoint();
    const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`Type${i}`, 1]));
    expect((await setExpected(id, { expectedResourceCounts: many })).status).toBe(400);
  });

  it("404s for an unknown endpoint", async () => {
    expect((await setExpected("does-not-exist", { expectedResourceCounts: {} })).status).toBe(404);
  });

  it("bumps the version so an open dashboard notices", async () => {
    const id = await newEndpoint();
    const before: MessagesResponse = await (await poll(id)).json();

    await setExpected(id, { expectedResourceCounts: { Encounter: 1 } });

    const after: MessagesResponse = await (await poll(id, before.version)).json();
    expect(after.changed).toBe(true);
  });

  it("tallies arrivals against the configured expectation end to end", async () => {
    const id = await newEndpoint();
    await setExpected(id, { expectedResourceCounts: { Encounter: 2 } });
    await send(id, ENCOUNTER_EVENT);
    await send(id, ENCOUNTER_EVENT);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.resourceCounts.Encounter).toBe(2);
    // Setting the expectation never re-grades or clears what already arrived.
    await setExpected(id, { expectedResourceCounts: {} });
    const after: EndpointSnapshot = await (await poll(id)).json();
    expect(after.endpoint.resourceCounts.Encounter).toBe(2);
  });
});

describe("heartbeat period and continuity", () => {
  const SUBSCRIPTION = "http://localhost:5826/fhir/r4b/Subscription/notifyr-test";

  function setPeriod(endpointId: string, body: unknown) {
    return putHeartbeatPeriod(
      new Request(`${ORIGIN}/api/endpoints/${endpointId}/heartbeat-period`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params(endpointId),
    );
  }

  /** A heartbeat carrying a given running event count. */
  function pulse(count: string): string {
    return JSON.stringify({
      resourceType: "Bundle",
      type: "history",
      timestamp: "2026-09-09T09:00:00Z",
      entry: [
        {
          resource: {
            resourceType: "SubscriptionStatus",
            status: "active",
            type: "heartbeat",
            eventsSinceSubscriptionStart: count,
            subscription: { reference: SUBSCRIPTION },
          },
        },
      ],
    });
  }

  // Two minutes: what the backport IG's example and this app's walkthrough both
  // configure, so following the guide gives a correctly checked endpoint.
  it("defaults to two minutes", async () => {
    const id = await newEndpoint();
    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.heartbeatPeriodSeconds).toBe(120);
    expect(snapshot.endpoint.continuity).toEqual([]);
  });

  it("can be switched off", async () => {
    const id = await newEndpoint();
    expect((await setPeriod(id, { heartbeatPeriodSeconds: 0 })).status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.heartbeatPeriodSeconds).toBe(0);
  });

  it("stores a period and exposes it", async () => {
    const id = await newEndpoint();
    expect((await setPeriod(id, { heartbeatPeriodSeconds: 120 })).status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.heartbeatPeriodSeconds).toBe(120);
  });

  it("accepts 0 as the off switch", async () => {
    const id = await newEndpoint();
    await setPeriod(id, { heartbeatPeriodSeconds: 120 });
    expect((await setPeriod(id, { heartbeatPeriodSeconds: 0 })).status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.heartbeatPeriodSeconds).toBe(0);
  });

  it("rejects a period outside the supported range", async () => {
    const id = await newEndpoint();
    for (const value of [4, -1, 86_401, 1.5, "soon", null]) {
      expect((await setPeriod(id, { heartbeatPeriodSeconds: value })).status, String(value)).toBe(
        400,
      );
    }
  });

  it("404s for an unknown endpoint", async () => {
    expect((await setPeriod("does-not-exist", { heartbeatPeriodSeconds: 60 })).status).toBe(404);
  });

  it("bumps the version so an open dashboard notices", async () => {
    const id = await newEndpoint();
    const before: MessagesResponse = await (await poll(id)).json();

    await setPeriod(id, { heartbeatPeriodSeconds: 60 });

    const after: MessagesResponse = await (await poll(id, before.version)).json();
    expect(after.changed).toBe(true);
  });

  // No clock control needed: the event counter is carried by the sender, so a
  // gap is visible end to end without waiting for anything.
  it("warns on the notification that revealed an event gap", async () => {
    const id = await newEndpoint();
    await send(id, pulse("3"));
    await send(id, pulse("7"));

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const newest = snapshot.messages[0];

    expect(newest.isValid).toBe(true);
    expect(newest.validationErrors.some((issue) => issue.message.includes("jumped from 3 to 7"))).toBe(
      true,
    );
    expect(snapshot.endpoint.continuity[0].missedEvents).toBe(3);
    expect(snapshot.endpoint.continuity[0].reference).toBe(SUBSCRIPTION);
  });

  it("leaves the notification valid and still counted", async () => {
    const id = await newEndpoint();
    await send(id, pulse("1"));
    await send(id, pulse("9"));

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.notificationCounts.heartbeat).toBe(2);
    expect(snapshot.endpoint.invalidCount).toBe(0);
  });

  it("tracks nothing from an invalid notification", async () => {
    const id = await newEndpoint();
    await send(id, pulse("1"));
    await send(id, '{"resourceType":"Bundle","type":"history","entry":[{"resource":{"resourceType":"SubscriptionStatus","type":"heartbeat"}}]}');

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.continuity).toHaveLength(1);
    expect(snapshot.endpoint.continuity[0].lastEventCount).toBe(1);
  });
});

describe("expected Subscription end", () => {
  const PAST = "2020-01-01T00:00:00.000Z";
  const FUTURE = "2099-01-01T00:00:00.000Z";

  function setEnd(endpointId: string, body: unknown) {
    return putExpectedEnd(
      new Request(`${ORIGIN}/api/endpoints/${endpointId}/expected-end`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params(endpointId),
    );
  }

  it("starts unset, and nothing is checked", async () => {
    const id = await newEndpoint();
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedEnd).toBeNull();
    expect(snapshot.endpoint.afterEndCount).toBe(0);
    expect(snapshot.messages[0].afterExpectedEnd).toBe(false);
    expect(snapshot.messages[0].validationErrors).toEqual([]);
  });

  it("normalises the stored instant to UTC", async () => {
    const id = await newEndpoint();
    expect((await setEnd(id, { expectedEnd: "2099-01-01T01:00:00+01:00" })).status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedEnd).toBe(FUTURE);
  });

  // The whole point: a subscription whose end has passed should have stopped.
  it("warns when a notification arrives after the end", async () => {
    const id = await newEndpoint();
    await setEnd(id, { expectedEnd: PAST });
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    const [message] = snapshot.messages;

    expect(message.afterExpectedEnd).toBe(true);
    expect(snapshot.endpoint.afterEndCount).toBe(1);

    const finding = message.validationErrors.find((issue) =>
      issue.message.includes("Subscription.end"),
    );
    expect(finding?.severity).toBe("warning");
    // A warning, so the notification is still valid and still tallied by type.
    expect(message.isValid).toBe(true);
    expect(snapshot.endpoint.validCount).toBe(1);
    expect(snapshot.endpoint.notificationCounts.handshake).toBe(1);
  });

  it("says nothing while the end is still ahead", async () => {
    const id = await newEndpoint();
    await setEnd(id, { expectedEnd: FUTURE });
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].afterExpectedEnd).toBe(false);
    expect(snapshot.endpoint.afterEndCount).toBe(0);
    expect(snapshot.messages[0].validationErrors).toEqual([]);
  });

  // Measured from the clock, not the body: a server still POSTing rubbish past
  // the end has still not stopped.
  it("flags an unparseable body that arrives late", async () => {
    const id = await newEndpoint();
    await setEnd(id, { expectedEnd: PAST });
    await send(id, "{ not json");

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].isValid).toBe(false);
    expect(snapshot.messages[0].afterExpectedEnd).toBe(true);
    expect(snapshot.endpoint.afterEndCount).toBe(1);
  });

  it("stops checking once cleared", async () => {
    const id = await newEndpoint();
    await setEnd(id, { expectedEnd: PAST });
    await send(id, HANDSHAKE);
    expect((await setEnd(id, { expectedEnd: null })).status).toBe(200);
    await send(id, HANDSHAKE);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedEnd).toBeNull();
    expect(snapshot.messages[0].afterExpectedEnd).toBe(false);
    // The earlier arrival still happened; clearing the field does not un-receive it.
    expect(snapshot.endpoint.afterEndCount).toBe(1);
  });

  it("treats an empty string as clearing the field", async () => {
    const id = await newEndpoint();
    await setEnd(id, { expectedEnd: PAST });
    expect((await setEnd(id, { expectedEnd: "" })).status).toBe(200);

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.expectedEnd).toBeNull();
  });

  it("does not re-grade messages already stored", async () => {
    const id = await newEndpoint();
    await send(id, HANDSHAKE);
    await setEnd(id, { expectedEnd: PAST });

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.messages[0].afterExpectedEnd).toBe(false);
    expect(snapshot.endpoint.afterEndCount).toBe(0);
  });

  it("rejects a value that is not a date-time", async () => {
    const id = await newEndpoint();
    const response = await setEnd(id, { expectedEnd: "next Tuesday" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("date-time");
  });

  it("rejects a non-string, non-null value", async () => {
    const id = await newEndpoint();
    expect((await setEnd(id, { expectedEnd: 1_760_000_000 })).status).toBe(400);
  });

  it("rejects a body that is not a JSON object", async () => {
    const id = await newEndpoint();
    const response = await putExpectedEnd(
      new Request(`${ORIGIN}/api/endpoints/${id}/expected-end`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "[]",
      }),
      params(id),
    );
    expect(response.status).toBe(400);
  });

  it("404s for an unknown endpoint", async () => {
    expect((await setEnd("no-such-endpoint", { expectedEnd: FUTURE })).status).toBe(404);
  });
});

describe("counters over the whole flow", () => {
  it("tracks validity and notification type together", async () => {
    const id = await newEndpoint();

    await send(id, HANDSHAKE);
    await send(id, '{"resourceType":"Patient","id":"a","gender":"male"}');
    await send(id, '{"event":"ping"}', "application/json");

    const snapshot: EndpointSnapshot = await (await poll(id)).json();
    expect(snapshot.endpoint.validCount).toBe(2);
    expect(snapshot.endpoint.invalidCount).toBe(1);
    expect(snapshot.endpoint.notificationCounts.handshake).toBe(1);
    expect(snapshot.endpoint.notificationCounts.heartbeat).toBe(0);
  });
});

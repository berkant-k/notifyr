import { NextResponse } from "next/server";
import { capabilityStatementResponse } from "@/lib/capabilityStatement";
import { checkExpectedEnd, isAfterExpectedEnd } from "@/lib/expiry";
import { captureHeaders } from "@/lib/headers";
import { mustOmitBody, overrideFor } from "@/lib/responseRules";
import { SPECS } from "@/lib/specs";
import { store } from "@/lib/store";
import { isOverridable, type ValidationError } from "@/lib/types";
import { metadataProbeResult, unexpectedGetResult, validateBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bodies above this are rejected without being stored, to bound memory. */
const MAX_BODY_BYTES = 1_000_000;

type Params = { params: Promise<{ endpointId: string; path?: string[] }> };

/**
 * POST /hook/:endpointId[/...path] — the webhook a FHIR Subscription posts to.
 *
 * An optional catch-all rather than a single segment: a plain single-segment
 * route 404s at the Next.js routing layer for anything longer, which is what
 * broke the `.../metadata` reachability probe this file also answers (see
 * `lib/capabilityStatement.ts`). Any subpath is captured exactly like the
 * base URL — a client hitting an unexpected tail is exactly the kind of thing
 * this tool exists to surface, not something to 404 on.
 */
export async function POST(request: Request, { params }: Params) {
  const { endpointId, path } = await params;
  return capture(request, endpointId, path);
}

/**
 * PUT /hook/:endpointId[/...path].
 *
 * The spec's own rest-hook delivery is POST, but not every server sends it
 * that way — Firely Server, for one, PUTs rest-hook notifications by default.
 * The body is captured and validated exactly like a POST — there is no
 * reason this tool should only work with senders that picked one particular
 * verb — but a warning finding is added alongside it (see `capture()` below),
 * since the sender is still doing something the spec does not describe.
 */
export async function PUT(request: Request, { params }: Params) {
  const { endpointId, path } = await params;
  return capture(request, endpointId, path);
}

/**
 * GET /hook/:endpointId[/...path].
 *
 * Every GET is captured, `.../metadata` included — showing what actually
 * arrived is the point of this tool, and a reachability check is worth
 * seeing happen, not just worth answering correctly. Two things change what
 * goes back on the wire rather than whether the request is recorded:
 *  - `.../metadata` still gets the capability statement `capture()` itself
 *    would not produce (see `lib/capabilityStatement.ts`), unless the
 *    endpoint does not exist, in which case that 404 is what should go back.
 *  - A bare GET on the base URL still gets a pointer to the dashboard, since
 *    that is almost always someone pasting the URL into a browser and still
 *    the most useful thing to tell them.
 */
export async function GET(request: Request, { params }: Params) {
  const { endpointId, path } = await params;

  const captured = await capture(request, endpointId, path);

  if (path?.length === 1 && path[0] === "metadata") {
    return captured.status === 404 ? captured : capabilityStatementResponse();
  }

  if (!path || path.length === 0) {
    return NextResponse.json(
      {
        error: "This endpoint accepts POST or PUT.",
        dashboard: `/dashboard/${endpointId}`,
      },
      { status: 405, headers: { Allow: "POST, PUT" } },
    );
  }

  return captured;
}

/**
 * Always reads the body as text first: an unparseable payload is exactly the
 * case we want to capture and show, so parsing must not be what decides
 * whether we record it.
 */
async function capture(
  request: Request,
  endpointId: string,
  path: string[] | undefined,
): Promise<Response> {
  const endpoint = await store.getEndpoint(endpointId);
  if (!endpoint) {
    return NextResponse.json({ error: "Unknown endpoint" }, { status: 404 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Stamped once and reused: the continuity tracker compares this against the
  // previous heartbeat, so the value it measures must be the value stored.
  const receivedAt = new Date().toISOString();
  const contentType = request.headers.get("content-type");
  // A GET is never a Subscription notification — that is always POSTed — so
  // its (usually absent) body is not graded through the same tiers a POST is.
  // `.../metadata` gets its own result rather than the generic "unexpected"
  // one: unlike an arbitrary GET, this one is an ordinary, expected part of
  // some clients' Subscription setup. The expectation is read at receive time
  // and recorded on the message below: changing it later cannot re-grade what
  // has already arrived.
  const isMetadataProbe = request.method === "GET" && path?.length === 1 && path[0] === "metadata";
  const result = isMetadataProbe
    ? metadataProbeResult()
    : request.method === "GET"
      ? unexpectedGetResult()
      : validateBody(rawBody, contentType, endpoint.expectedPayloadContent);

  // Arrival against Subscription.end. Read at receive time like the payload
  // expectation, and applied to every message rather than only valid ones: this
  // is measured from the clock, not from the body, so an unparseable POST an
  // hour past the end is still a server that has not stopped.
  const afterExpectedEnd = isAfterExpectedEnd(endpoint.expectedEnd, receivedAt);
  const expiryFindings = checkExpectedEnd(endpoint.expectedEnd, receivedAt);

  // The rest-hook channel's own delivery mechanism is POST. A PUT still
  // carries a real notification body — graded normally above — but the
  // sender isn't doing what the spec describes, so that's worth a warning
  // alongside whatever the body itself turns out to be.
  const methodFindings: ValidationError[] =
    request.method === "PUT"
      ? [
          {
            severity: "warning",
            message:
              "Received via PUT. The rest-hook channel delivers notifications via POST; some servers (e.g. Firely Server) send PUT instead.",
            spec: SPECS.subscription,
          },
        ]
      : [];

  // Continuity is the one check that needs more than this request: a gap is
  // only visible against what came before. Recorded before the message is
  // stored, so its findings travel with the notification that revealed them.
  const continuityFindings =
    result.isValid && result.notificationType && result.subscriptionReference
      ? await store.recordContinuity(endpointId, {
          reference: result.subscriptionReference,
          receivedAt,
          notificationType: result.notificationType,
          eventsSinceSubscriptionStart: result.eventsSinceSubscriptionStart,
        })
      : [];

  // A response rule changes only what goes on the wire. The message is still
  // validated, stored and counted exactly as it would have been, because the
  // point is to watch how the sender reacts to a rejection, not to hide it.
  const override = isOverridable(result.notificationType)
    ? overrideFor(endpoint.responseRules, result.notificationType)
    : null;
  const status = override ?? result.status;

  await store.addMessage(endpointId, {
    receivedAt,
    method: request.method,
    isValid: result.isValid,
    status,
    statusOverridden: override !== null,
    expectedPayloadContent:
      result.notificationType === "event-notification" ? endpoint.expectedPayloadContent : null,
    afterExpectedEnd,
    summary: result.summary,
    contentType,
    notificationType: result.notificationType,
    eventsSinceSubscriptionStart: result.eventsSinceSubscriptionStart,
    topic: result.topic,
    focusResourceTypes: result.focusResourceTypes,
    requestPath: path && path.length > 0 ? path.join("/") : null,
    headers: captureHeaders(request),
    rawBody,
    validationErrors: [
      ...result.validationErrors,
      ...continuityFindings,
      ...expiryFindings,
      ...methodFindings,
    ],
  });

  // 204, 205 and 304 must carry no body at all; NextResponse.json would throw.
  if (mustOmitBody(status)) {
    return new Response(null, { status });
  }

  return NextResponse.json(
    {
      received: true,
      valid: result.isValid,
      issues: result.validationErrors.length,
      ...(override !== null && { statusOverridden: true }),
    },
    { status },
  );
}

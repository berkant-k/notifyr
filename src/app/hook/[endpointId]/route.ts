import { NextResponse } from "next/server";
import { checkExpectedEnd, isAfterExpectedEnd } from "@/lib/expiry";
import { captureHeaders } from "@/lib/headers";
import { mustOmitBody, overrideFor } from "@/lib/responseRules";
import { store } from "@/lib/store";
import { isOverridable } from "@/lib/types";
import { validateBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bodies above this are rejected without being stored, to bound memory. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * POST /hook/:endpointId — the webhook a FHIR Subscription posts to.
 *
 * Always reads the body as text first: an unparseable payload is exactly the
 * case we want to capture and show, so parsing must not be what decides
 * whether we record it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> },
) {
  const { endpointId } = await params;

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
  // The expectation is read at receive time and recorded on the message below:
  // changing it later cannot re-grade what has already arrived.
  const result = validateBody(rawBody, contentType, endpoint.expectedPayloadContent);

  // Arrival against Subscription.end. Read at receive time like the payload
  // expectation, and applied to every message rather than only valid ones: this
  // is measured from the clock, not from the body, so an unparseable POST an
  // hour past the end is still a server that has not stopped.
  const afterExpectedEnd = isAfterExpectedEnd(endpoint.expectedEnd, receivedAt);
  const expiryFindings = checkExpectedEnd(endpoint.expectedEnd, receivedAt);

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
    headers: captureHeaders(request),
    rawBody,
    validationErrors: [...result.validationErrors, ...continuityFindings, ...expiryFindings],
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

/** A GET here is almost always someone pasting the URL into a browser. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ endpointId: string }> },
) {
  const { endpointId } = await params;
  return NextResponse.json(
    {
      error: "This endpoint accepts POST only.",
      dashboard: `/dashboard/${endpointId}`,
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

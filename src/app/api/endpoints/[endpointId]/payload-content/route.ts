import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { isPayloadContent, PAYLOAD_CONTENTS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/endpoints/:endpointId/payload-content
 *
 * Body is `{"expectedPayloadContent": "id-only"}`, or null to stop checking
 * against an expectation. The level is configured on the Subscription, which
 * Notifyr never sees, so this is the user telling us what they set.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> },
) {
  const { endpointId } = await params;

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be a JSON object with an expectedPayloadContent property." },
      { status: 400 },
    );
  }

  const value = (body as { expectedPayloadContent?: unknown }).expectedPayloadContent;
  if (value !== null && !isPayloadContent(value)) {
    return NextResponse.json(
      {
        error: `expectedPayloadContent must be null or one of: ${PAYLOAD_CONTENTS.join(", ")}.`,
      },
      { status: 400 },
    );
  }

  const endpoint = await store.updateExpectedPayloadContent(endpointId, value);
  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  return NextResponse.json(
    { expectedPayloadContent: endpoint.expectedPayloadContent },
    { headers: { "Cache-Control": "no-store" } },
  );
}

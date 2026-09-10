import { NextResponse } from "next/server";
import { normaliseExpectedEnd } from "@/lib/expiry";
import { store } from "@/lib/store";
import { EXPECTED_END_RULES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/endpoints/:endpointId/expected-end
 *
 * Body is `{"expectedEnd": "2026-09-10T18:30:00Z"}`, or null to stop checking
 * arrival times. `Subscription.end` is set on the Subscription, which Notifyr
 * never sees, so this is the user telling us what they set.
 *
 * A past instant is accepted on purpose: "the subscription ended an hour ago,
 * is anything still arriving?" is the question this feature exists to answer,
 * and rejecting it would refuse the main use case.
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
      { error: "Body must be a JSON object with an expectedEnd property." },
      { status: 400 },
    );
  }

  const value = (body as { expectedEnd?: unknown }).expectedEnd;

  // Empty string is treated as null: it is what an emptied input box sends, and
  // clearing the field is how the check is switched off.
  if (value !== null && typeof value !== "string") {
    return NextResponse.json(
      { error: `expectedEnd must be null or a string. ${EXPECTED_END_RULES}` },
      { status: 400 },
    );
  }

  let expectedEnd: string | null = null;
  if (typeof value === "string" && value.trim() !== "") {
    // Normalised to UTC here rather than in the store, so every implementation
    // holds the same instant and the value echoed back names one moment.
    expectedEnd = normaliseExpectedEnd(value);
    if (expectedEnd === null) {
      return NextResponse.json(
        { error: `${JSON.stringify(value)} is not a date-time. ${EXPECTED_END_RULES}` },
        { status: 400 },
      );
    }
  }

  const endpoint = await store.updateExpectedEnd(endpointId, expectedEnd);
  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  return NextResponse.json(
    { expectedEnd: endpoint.expectedEnd },
    { headers: { "Cache-Control": "no-store" } },
  );
}

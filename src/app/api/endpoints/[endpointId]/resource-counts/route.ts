import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { isResourceTypeName, MAX_EXPECTED_RESOURCE_TYPES, type ResourceCounts } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/endpoints/:endpointId/resource-counts
 *
 * Body is `{"expectedResourceCounts": {"Encounter": 2, "Patient": 1}}`, or an
 * empty object to clear every expectation. Replaces the whole map — the
 * natural action for a form editing a list of rows, unlike the response
 * rules' per-switch merge.
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
      { error: "Body must be a JSON object with an expectedResourceCounts property." },
      { status: 400 },
    );
  }

  const value = (body as { expectedResourceCounts?: unknown }).expectedResourceCounts;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return NextResponse.json(
      { error: "expectedResourceCounts must be an object, e.g. {\"Encounter\": 2}." },
      { status: 400 },
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_EXPECTED_RESOURCE_TYPES) {
    return NextResponse.json(
      { error: `At most ${MAX_EXPECTED_RESOURCE_TYPES} resource types can be expected.` },
      { status: 400 },
    );
  }

  const expected: ResourceCounts = {};
  for (const [type, count] of entries) {
    if (!isResourceTypeName(type)) {
      return NextResponse.json(
        { error: `"${type}" is not a FHIR resource type name — expected PascalCase, e.g. "Encounter".` },
        { status: 400 },
      );
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return NextResponse.json(
        { error: `Expected count for "${type}" must be a non-negative whole number.` },
        { status: 400 },
      );
    }
    expected[type] = count;
  }

  const endpoint = await store.updateExpectedResourceCounts(endpointId, expected);
  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  return NextResponse.json(
    { expectedResourceCounts: endpoint.expectedResourceCounts },
    { headers: { "Cache-Control": "no-store" } },
  );
}

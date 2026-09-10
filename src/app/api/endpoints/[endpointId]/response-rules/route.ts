import { NextResponse } from "next/server";
import { validateResponseRulesPatch } from "@/lib/responseRules";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/endpoints/:endpointId/response-rules
 *
 * Body is a partial map of notification type to `{ enabled, status }`, so the
 * dashboard can send only the switch that changed. Returns the merged rules.
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

  const check = validateResponseRulesPatch(body);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const endpoint = await store.updateResponseRules(endpointId, check.rules);
  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  return NextResponse.json(
    { responseRules: endpoint.responseRules },
    { headers: { "Cache-Control": "no-store" } },
  );
}

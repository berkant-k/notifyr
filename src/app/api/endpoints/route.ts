import { NextResponse } from "next/server";
import { ENDPOINT_ID_RULES, validateEndpointId } from "@/lib/endpointId";
import { store } from "@/lib/store";
import type { CreateEndpointResponse } from "@/lib/types";
import { webhookUrlFrom } from "@/lib/url";

// The in-memory store lives in module scope, so this must not run on the edge
// runtime or be statically optimised.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/endpoints — mint a new webhook endpoint.
 *
 * Body is optional. `{"id": "my-hook"}` requests a specific id; anything else
 * (including no body at all) gets a random one.
 */
export async function POST(request: Request) {
  const raw = (await request.text()).trim();

  let requested: unknown;
  if (raw !== "") {
    try {
      requested = (JSON.parse(raw) as { id?: unknown }).id;
    } catch {
      return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
    }
  }

  let id: string | undefined;
  if (requested !== undefined && requested !== null && requested !== "") {
    if (typeof requested !== "string") {
      return NextResponse.json(
        { error: `Endpoint id must be a string. ${ENDPOINT_ID_RULES}` },
        { status: 400 },
      );
    }
    const check = validateEndpointId(requested);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }
    id = check.id;
  }

  const endpoint = await store.createEndpoint(id);
  if (!endpoint) {
    return NextResponse.json(
      {
        error: `The id "${id}" is already in use.`,
        existingDashboard: `/dashboard/${id}`,
      },
      { status: 409 },
    );
  }

  const body: CreateEndpointResponse = {
    id: endpoint.id,
    url: webhookUrlFrom(request, endpoint.id),
  };
  return NextResponse.json(body, { status: 201 });
}

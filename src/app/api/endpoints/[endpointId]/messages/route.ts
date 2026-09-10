import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import {
  MAX_RECENT_MESSAGES,
  MAX_STORED_MESSAGES,
  type MessagesResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/endpoints/:endpointId/messages[?since=<version>]
 *
 * The dashboard polls this every couple of seconds. When `since` matches the
 * endpoint's current version, the response is a few bytes saying "nothing
 * changed" — the client then skips the state update entirely, so an idle
 * dashboard never re-renders.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ endpointId: string }> },
) {
  const { endpointId } = await params;
  const query = new URL(request.url).searchParams;
  const snapshot = await store.getSnapshot(endpointId, limitFrom(query.get("limit")));

  if (!snapshot) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  const version = snapshot.endpoint.version;
  const since = query.get("since");

  const body: MessagesResponse =
    since !== null && Number(since) === version
      ? { changed: false, version }
      : { changed: true, version, ...snapshot };

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * How many messages to return. Clamped rather than rejected: `?limit=` comes
 * from a "Show more" control, and answering a nonsense value with the default
 * is friendlier than 400ing a dashboard that is otherwise working.
 *
 * The ceiling is what the store retains, so asking for more than exists is not
 * an error either — the list simply ends.
 */
function limitFrom(raw: string | null): number {
  if (raw === null) return MAX_RECENT_MESSAGES;

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) return MAX_RECENT_MESSAGES;

  return Math.min(limit, MAX_STORED_MESSAGES);
}

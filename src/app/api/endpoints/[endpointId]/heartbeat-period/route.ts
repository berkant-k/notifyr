import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import {
  HEARTBEAT_PERIOD_RULES,
  MAX_HEARTBEAT_PERIOD_SECONDS,
  MIN_HEARTBEAT_PERIOD_SECONDS,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/endpoints/:endpointId/heartbeat-period
 *
 * Body is `{"heartbeatPeriodSeconds": 120}`, or 0 to switch the check off. The
 * period is configured on the Subscription, which Notifyr never sees, so this
 * is the user telling us what they set.
 *
 * Changing it clears the missed-heartbeat counts — see the store.
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
      { error: "Body must be a JSON object with a heartbeatPeriodSeconds property." },
      { status: 400 },
    );
  }

  const raw = (body as { heartbeatPeriodSeconds?: unknown }).heartbeatPeriodSeconds;
  const seconds = typeof raw === "string" ? Number(raw.trim()) : raw;

  if (typeof seconds !== "number" || !Number.isInteger(seconds)) {
    return NextResponse.json(
      { error: `heartbeatPeriodSeconds must be a whole number. ${HEARTBEAT_PERIOD_RULES}` },
      { status: 400 },
    );
  }

  // 0 is the off switch, so the valid set is 0 plus the supported range rather
  // than one contiguous span.
  const inRange =
    seconds === 0 ||
    (seconds >= MIN_HEARTBEAT_PERIOD_SECONDS && seconds <= MAX_HEARTBEAT_PERIOD_SECONDS);
  if (!inRange) {
    return NextResponse.json(
      { error: `${seconds} is out of range. ${HEARTBEAT_PERIOD_RULES}` },
      { status: 400 },
    );
  }

  const endpoint = await store.updateHeartbeatPeriod(endpointId, seconds);
  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }

  return NextResponse.json(
    { heartbeatPeriodSeconds: endpoint.heartbeatPeriodSeconds },
    { headers: { "Cache-Control": "no-store" } },
  );
}

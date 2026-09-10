"use client";

import Link from "next/link";
import FhirCandleGuide from "@/components/FhirCandleGuide";

/**
 * The fhir-candle walkthrough on a page of its own.
 *
 * It used to expand inside the dashboard, which cost that page a screen of
 * height and made it jump: the guide was rendered only while no notifications
 * had arrived, so the first heartbeat made it disappear underneath whoever was
 * reading it. On its own page it can be left open in a second tab beside the
 * dashboard — which is how it is actually used, since every step is something
 * you paste into a FHIR server and then watch land.
 */
export default function GuideView({
  endpointId,
  webhookUrl,
}: {
  endpointId: string;
  webhookUrl: string;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">How to test with fhir-candle</h1>
        <p className="mt-2 text-sm text-slate-600">
          Every sample below is filled in with this endpoint&apos;s own URL, so it can be pasted
          straight into a server.
        </p>
        <p className="mt-1 font-mono text-xs text-slate-500">{endpointId}</p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <FhirCandleGuide webhookUrl={webhookUrl} />
      </div>

      <Link
        href={`/dashboard/${endpointId}`}
        className="inline-block text-sm font-medium text-slate-900 underline"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}

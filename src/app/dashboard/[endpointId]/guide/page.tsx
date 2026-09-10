import { headers } from "next/headers";
import GuideView from "@/components/GuideView";
import { webhookUrlFromHeaders } from "@/lib/url";

/**
 * The walkthrough for one endpoint, at its own URL so the dashboard can link to
 * it in a second tab rather than unfolding it in place.
 */
export default async function GuidePage({
  params,
}: {
  params: Promise<{ endpointId: string }>;
}) {
  const { endpointId } = await params;
  return (
    <GuideView
      endpointId={endpointId}
      webhookUrl={webhookUrlFromHeaders(await headers(), endpointId)}
    />
  );
}

import { headers } from "next/headers";
import DashboardView from "@/components/DashboardView";
import { webhookUrlFromHeaders } from "@/lib/url";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ endpointId: string }>;
}) {
  const { endpointId } = await params;
  // Resolved here so the server and the browser render the same string; see the
  // note in lib/url.ts.
  const webhookUrl = webhookUrlFromHeaders(await headers(), endpointId);

  // Keyed so navigating between dashboards remounts rather than showing the
  // previous endpoint's data until the first poll lands.
  return <DashboardView key={endpointId} endpointId={endpointId} webhookUrl={webhookUrl} />;
}

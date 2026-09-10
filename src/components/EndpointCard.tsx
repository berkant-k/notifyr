import CopyButton from "@/components/CopyButton";
import InfoTip from "@/components/InfoTip";

/** Displays a webhook endpoint's URL with a copy button and a link to the guide. */
export default function EndpointCard({
  webhookUrl,
  guideHref,
}: {
  webhookUrl: string;
  guideHref: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Webhook URL
        </div>
        <InfoTip label="About the webhook URL">
          Point a FHIR Subscription with channel type <code>rest-hook</code> at this URL.
          Everything posted to it is captured, validated and shown here.
        </InfoTip>
      </div>
      <div className="mt-2 flex items-start gap-3">
        {/*
          Wraps rather than scrolls. In the dashboard's rail the card is ~320px
          wide, and a horizontally scrolling URL hides the endpoint id — the one
          part someone needs to read back.
        */}
        <code className="min-w-0 flex-1 break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-sm">
          {webhookUrl}
        </code>
        <CopyButton value={webhookUrl} />
      </div>
      {/*
        A second tab rather than an expanding panel: the walkthrough is six
        screens long, every step is something you paste elsewhere, and it is
        useful open *beside* this page rather than on top of it.
      */}
      <a
        href={guideHref}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block text-xs font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
      >
        How to test with fhir-candle &#8599;
      </a>
    </div>
  );
}

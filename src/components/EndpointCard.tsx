import CopyButton from "@/components/CopyButton";
import InfoTip from "@/components/InfoTip";
import { countdownLabel, fullTimestamp, relativeLabel } from "@/lib/time";

/**
 * A webhook endpoint's URL, with a copy button, a link to the guide, and how
 * long it has left.
 *
 * The lifetime is here rather than tucked in a settings panel because this card
 * is what somebody copies out of and pastes into a Subscription. "This URL
 * works for another 3h 58m" belongs next to the URL itself, not two clicks
 * away — and an endpoint whose data dies with the process should say so where
 * the data is being handed out.
 */
export default function EndpointCard({
  webhookUrl,
  guideHref,
  createdAt,
  expiresAt,
  nowMs,
}: {
  webhookUrl: string;
  guideHref: string;
  createdAt: string | null;
  /** Null when the store does not expire endpoints; see `Endpoint.expiresAt`. */
  expiresAt: string | null;
  nowMs: number;
}) {
  const remaining = countdownLabel(expiresAt, nowMs);
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
      {createdAt !== null && (
        <dl className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
          <div className="flex items-baseline gap-1.5">
            <dt>Created</dt>
            <dd>
              <time dateTime={createdAt} title={fullTimestamp(createdAt)} className="text-slate-700">
                {relativeLabel(createdAt, nowMs)}
              </time>
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt>{remaining === "expired" ? "Expired" : "Expires in"}</dt>
            <dd>
              {expiresAt === null ? (
                /*
                  Not "never": the process is still the deadline, and saying so
                  where the URL is handed out is the honest version of a store
                  that forgets everything when it restarts.
                */
                <span className="text-slate-700">when the server restarts</span>
              ) : (
                <time
                  dateTime={expiresAt}
                  title={`Expires ${fullTimestamp(expiresAt)}. Traffic or a dashboard refresh pushes this out again.`}
                  className={
                    remaining === "expired" || !remaining.includes("h")
                      ? "font-medium text-amber-700 tabular-nums"
                      : "text-slate-700 tabular-nums"
                  }
                >
                  {remaining === "expired" ? "—" : remaining}
                </time>
              )}
            </dd>
          </div>
        </dl>
      )}
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

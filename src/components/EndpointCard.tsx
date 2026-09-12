import CopyButton from "@/components/CopyButton";
import InfoTip from "@/components/InfoTip";
import LiveIndicator from "@/components/LiveIndicator";
import type { ConnectionState } from "@/hooks/useEndpointPoll";
import { countdownLabel, fullTimestamp, relativeLabel } from "@/lib/time";

/**
 * A webhook endpoint's URL, with a copy button, a link to the guide, how long
 * it has left, and the poll connection status and manual refresh.
 *
 * The lifetime is here rather than tucked in a settings panel because this card
 * is what somebody copies out of and pastes into a Subscription. "This URL
 * works for another 3h 58m" belongs next to the URL itself, not two clicks
 * away — and an endpoint whose data dies with the process should say so where
 * the data is being handed out. Live status and refresh live here too, next to
 * the copy button, rather than in the page banner: they are controls over
 * *this* endpoint's stream, and the banner above has nothing else to say once
 * the id is gone from it.
 */
export default function EndpointCard({
  webhookUrl,
  guideHref,
  createdAt,
  expiresAt,
  nowMs,
  state,
  onRefresh,
}: {
  webhookUrl: string;
  guideHref: string;
  createdAt: string | null;
  /** Null when the store does not expire endpoints; see `Endpoint.expiresAt`. */
  expiresAt: string | null;
  nowMs: number;
  state: ConnectionState;
  onRefresh: () => void;
}) {
  const remaining = countdownLabel(expiresAt, nowMs);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      {/*
        One header row rather than a stack of them: the label, the lifetime and
        the guide link are all metadata about the URL below, not separate
        sections, and this card sits full-width under the page banner now
        rather than in a narrow rail — width to spread them across is exactly
        what a stacked layout was wasting.
      */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Webhook URL
          </span>
          <InfoTip label="About the webhook URL">
            Point a FHIR Subscription with channel type <code>rest-hook</code> at this URL.
            Everything posted to it is captured, validated and shown here.
          </InfoTip>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-slate-500">
          {createdAt !== null && (
            <>
              <span>
                Created{" "}
                <time dateTime={createdAt} title={fullTimestamp(createdAt)} className="text-slate-700">
                  {relativeLabel(createdAt, nowMs)}
                </time>
              </span>
              <span aria-hidden="true">&middot;</span>
              <span>
                {remaining === "expired" ? "Expired" : "Expires in"}{" "}
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
              </span>
              <span aria-hidden="true">&middot;</span>
            </>
          )}
          {/*
            A second tab rather than an expanding panel: the walkthrough is six
            screens long, every step is something you paste elsewhere, and it is
            useful open *beside* this page rather than on top of it.
          */}
          <a
            href={guideHref}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
          >
            How to test with fhir-candle &#8599;
          </a>
        </div>
      </div>

      <div className="mt-2 flex items-start gap-3">
        {/*
          Wraps rather than scrolls: a horizontally scrolling URL hides the
          endpoint id — the one part someone needs to read back.
        */}
        <code className="min-w-0 flex-1 break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-sm">
          {webhookUrl}
        </code>
        <CopyButton value={webhookUrl} />
        <span className="h-8 w-px shrink-0 self-stretch bg-slate-200" aria-hidden="true" />
        <LiveIndicator state={state} />
        <button
          type="button"
          onClick={onRefresh}
          className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

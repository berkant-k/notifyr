"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import FhirCandleGuide from "@/components/FhirCandleGuide";
import References from "@/components/References";
import ValidationExplainer from "@/components/ValidationExplainer";
import { useRef, useState } from "react";
import {
  ENDPOINT_ID_RULES,
  randomEndpointId,
  validateEndpointId,
} from "@/lib/endpointId";
import type { CreateEndpointResponse } from "@/lib/types";

interface CreateError {
  message: string;
  /** Set on a 409, so we can offer a link to the endpoint that already exists. */
  existingDashboard?: string;
}

/**
 * A collapsed section of documentation.
 *
 * The title is an `h2` inside the `summary` — legal, and the only way a screen
 * reader browsing by heading finds these sections at all. Without it the page
 * ran `h1` straight to the `h4`s nested inside the panels.
 */
function Disclosure({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-lg border border-slate-200 bg-white">
      <summary className="cursor-pointer px-5 py-4">
        <h2 className="inline text-sm font-medium text-slate-900">{title}</h2>
        <span className="mt-1 block text-xs text-slate-500">{summary}</span>
      </summary>
      <div className="border-t border-slate-200 px-5 py-4">{children}</div>
    </details>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [endpointId, setEndpointId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<CreateError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const wanted = endpointId.trim();
  // Judged on every keystroke rather than on submit. The preview below the
  // field used to render whatever was typed as a path, so `bad id!` appeared
  // as `/hook/bad id!` — a URL that can never exist — until submit said
  // otherwise. The rules are the same ones the server applies.
  const liveCheck = wanted === "" ? null : validateEndpointId(wanted);
  const liveError = liveCheck && !liveCheck.ok ? liveCheck.error : null;
  const problem = liveError ?? error?.message ?? null;

  async function handleCreate() {
    // Check locally first so a typo does not need a round trip.
    if (wanted !== "") {
      const check = validateEndpointId(wanted);
      if (!check.ok) {
        setError({ message: check.error });
        // Put the caret where the fix has to happen, rather than on the button
        // that just refused it.
        inputRef.current?.focus();
        return;
      }
    }

    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wanted === "" ? {} : { id: wanted }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError({
          message: body.error ?? `Server responded ${response.status}`,
          existingDashboard: body.existingDashboard,
        });
        setCreating(false);
        inputRef.current?.focus();
        return;
      }

      const endpoint: CreateEndpointResponse = await response.json();
      router.push(`/dashboard/${endpoint.id}`);
      // Stay disabled while the router navigates away.
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : "Could not create endpoint." });
      setCreating(false);
    }
  }

  return (
    /*
      One column, capped at reading width and centred. Wider containers left the
      prose and the card aligned to the left edge with a growing void beside
      them — 836px of it at 1912px wide.
    */
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        {/*
          Not "Notifyr – FHIR Subscription Tester": the header already says both
          of those words, so repeating them spends the largest text on the page
          on nothing.
        */}
        <h1 className="text-2xl font-semibold tracking-tight">
          A throwaway endpoint for FHIR <code>rest-hook</code> notifications
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Point a FHIR <code>Subscription</code> at the URL you get below, and every
          notification your server sends is captured in full, validated against R4B/R5, and
          shown live.
        </p>
      </div>


      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <div>
          <label htmlFor="endpoint-id" className="block text-sm font-medium text-slate-800">
            Endpoint ID <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Leave blank for a random id. {ENDPOINT_ID_RULES}
          </p>

          <div className="mt-2 flex gap-2">
            <input
              id="endpoint-id"
              type="text"
              value={endpointId}
              onChange={(event) => {
                setEndpointId(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !creating) void handleCreate();
              }}
              ref={inputRef}
              placeholder="my-test-hook"
              /*
                No maxLength. Silently swallowing the tail of a pasted id told
                the user nothing; the length rule is one of the checks above and
                now explains itself like the others.
              */
              spellCheck={false}
              autoComplete="off"
              aria-invalid={problem !== null}
              aria-describedby={problem ? "endpoint-id-error" : undefined}
              className={`min-w-0 flex-1 rounded-md border px-3 py-2 font-mono text-sm placeholder:font-sans placeholder:text-slate-500 focus:outline-none ${
                problem
                  ? "border-rose-400 bg-rose-50 text-rose-900 focus:border-rose-500"
                  : "border-slate-300 focus:border-slate-500"
              }`}
            />
            <button
              type="button"
              onClick={() => {
                setEndpointId(randomEndpointId());
                setError(null);
              }}
              className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Generate
            </button>
          </div>

          {/*
            The problem sits where the preview would have been — under the
            field it is about, rather than below the submit button two elements
            further down.
          */}
          {problem ? (
            <div
              id="endpoint-id-error"
              role="alert"
              className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
            >
              {problem}
              {error?.existingDashboard && (
                <>
                  {" "}
                  <Link href={error.existingDashboard} className="font-medium underline">
                    Open its dashboard
                  </Link>
                </>
              )}
            </div>
          ) : (
            wanted !== "" && (
              <p className="mt-2 truncate font-mono text-xs text-slate-500">/hook/{wanted}</p>
            )
          )}
        </div>

        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {creating ? "Creating…" : "Create webhook endpoint"}
        </button>

        {/*
          Said once, here, at reading size. It used to appear three times in
          12px grey — inline, as a footnote, and in the global footer — which is
          three ways of not being read.
        */}
        <p className="text-sm text-slate-600">
          Nothing is authenticated and data is kept in memory only: anyone who knows an
          endpoint&apos;s id can read everything sent to it, and a chosen id is only as private
          as it is hard to guess. A debugging tool, not a destination for real patient data.
        </p>
      </div>

      {/*
        The pitch sits below the control it argues for. Someone who already
        knows what this is can act without scrolling past three paragraphs; the
        argument is still here for someone who does not.
      */}
      <div className="space-y-3 text-sm text-slate-600">
        <p>
          Testing a <code>rest-hook</code> subscription normally means standing up a public
          server just to see what your FHIR server is actually sending. Notifyr replaces that
          with a URL you create in one click.
        </p>
        <p>Every request that arrives is:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="font-medium text-slate-900">captured in full</strong> — the raw
            body exactly as sent, even when it is malformed;
          </li>
          <li>
            <strong className="font-medium text-slate-900">validated</strong> — JSON, then FHIR
            structure and value sets, with every problem located and explained;
          </li>
          <li>
            <strong className="font-medium text-slate-900">counted by type</strong> — handshakes,
            heartbeats and event-notifications tallied separately, so you can confirm each part
            of the subscription lifecycle actually fired.
          </li>
        </ul>
      </div>

      {/*
        The title of each is a real heading, so browsing by heading finds the
        sections; the line under it says what is inside, since opening all three
        turns one screen into six.
      */}
      <div className="space-y-3">
        <Disclosure
          title="How to test with fhir-candle"
          summary="A five-step walkthrough against a real FHIR server, with the Subscription and Encounter to paste."
        >
          <FhirCandleGuide />
        </Disclosure>

        <Disclosure
          title="How Notifyr validates"
          summary="The three validation tiers, and why Subscription notifications need handling of their own."
        >
          <ValidationExplainer />
        </Disclosure>

        <Disclosure
          title="References"
          summary="The specification pages every rule here is checked against."
        >
          <References />
        </Disclosure>
      </div>
    </div>
  );
}

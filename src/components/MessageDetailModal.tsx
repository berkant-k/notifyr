"use client";

import { useEffect, useId, useRef } from "react";
import CodeBlock from "@/components/CodeBlock";
import { fullTimestamp } from "@/lib/time";
import type { Message, MessageHeader, ValidationError } from "@/lib/types";

interface Props {
  message: Message | null;
  onClose: () => void;
}

/** Pretty-print a JSON body; fall back to the raw text when it does not parse. */
function formatBody(rawBody: string): string {
  try {
    return JSON.stringify(JSON.parse(rawBody), null, 2);
  } catch {
    return rawBody;
  }
}

function issueStyle(severity: ValidationError["severity"]): string {
  switch (severity) {
    case "fatal":
    case "error":
      return "border-rose-200 bg-rose-50 text-rose-900";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-900";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

/** One group of headers, rendered the same way wherever it appears. */
function HeaderList({ headers }: { headers: MessageHeader[] }) {
  return (
    <dl className="mt-2 divide-y divide-slate-200 overflow-hidden rounded-md border border-slate-200">
      {headers.map((header) => (
        <div key={header.name} className="flex gap-3 px-3 py-1.5 text-xs">
          <dt className="w-48 shrink-0 truncate font-mono font-medium text-slate-700">
            {header.name}
          </dt>
          <dd className="min-w-0 flex-1 break-all font-mono text-slate-600">
            {header.sensitive && (
              <span className="mr-1.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                credential
              </span>
            )}
            {header.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Elements that can hold focus inside the dialog, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Full detail for one notification: raw body plus any validation problems.
 *
 * Claiming `role="dialog" aria-modal="true"` obliges the component to behave
 * like one, and an earlier version did not: focus stayed on the row behind the
 * overlay, Tab walked the page underneath, and the background scrolled. All
 * three are handled here rather than by swapping in `<dialog>`, which would
 * bring its own backdrop and stacking behaviour to fight with.
 */
export default function MessageDetailModal({ message, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (!message) return;

    // Restored on close, so dismissing the dialog puts the caret back on the
    // row that opened it rather than at the top of the document.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    // The background must not scroll under an open modal, and must go back to
    // whatever it was — not a hardcoded "visible" — when this one closes.
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      // Nothing to land on: keep focus on the panel rather than letting Tab
      // escape to the page behind.
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    /*
     * The Tab handler above wraps at the ends of the focusable list, but it
     * cannot see everything the browser considers focusable: Chrome makes a
     * scrollable region keyboard-focusable with no tabindex attribute, and the
     * modal body is one — so focus reached it, matched neither end, and Tab
     * carried on out of the dialog. Catching focus that has already landed
     * outside is the backstop that does not depend on predicting the list.
     */
    function onFocusIn(event: FocusEvent) {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.target instanceof Node && !panel.contains(event.target)) {
        panel.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [message, onClose]);

  if (!message) return null;

  const fromSender = message.headers.filter((header) => !header.platform);
  const fromPlatform = message.headers.filter((header) => header.platform);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      // Closing on mousedown rather than click: a text selection that starts
      // inside the panel and ends out here would otherwise dismiss the dialog
      // and lose what was selected.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl focus:outline-none"
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id={headingId} className="text-sm font-semibold">
              {message.summary}
            </h2>
            {/*
              The same local clock the list uses. This read the raw UTC ISO
              string, so a row saying 12:09 opened onto a header saying 09:09 —
              the same event, three hours apart, on one screen.
            */}
            <p className="mt-1 text-xs text-slate-500">
              <time dateTime={message.receivedAt} title={message.receivedAt}>
                {fullTimestamp(message.receivedAt)}
              </time>{" "}
              · HTTP {message.status} · {message.contentType ?? "no content-type"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {message.statusOverridden && (
            <p className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Notifyr answered <strong className="font-semibold">{message.status}</strong> because
              this notification type is switched off under Response overrides. The result below
              is the real validation outcome and was not affected.
            </p>
          )}
          {/*
            The endpoint's expectation can change after a message is stored, and
            stored messages are never re-validated — so say which level this one
            was actually judged against rather than letting the reader assume it
            was whatever the dropdown reads now.
          */}
          {message.expectedPayloadContent && (
            <p className="mb-5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Checked against the expected payload level{" "}
              <code className="font-mono text-xs">{message.expectedPayloadContent}</code>.
            </p>
          )}
          {message.validationErrors.length > 0 && (
            <section className="mb-5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Validation results
              </h3>
              <ul className="mt-2 space-y-2">
                {message.validationErrors.map((issue, index) => (
                  <li
                    key={index}
                    className={`rounded-md border px-3 py-2 text-sm ${issueStyle(issue.severity)}`}
                  >
                    <span className="mr-2 text-xs font-semibold uppercase">{issue.severity}</span>
                    {issue.location && (
                      <code className="mr-2 font-mono text-xs">{issue.location}</code>
                    )}
                    {issue.message}
                    {/*
                      Findings from the `fhir-tool` package have no page to cite, so
                      the link is conditional rather than a constant fixture.
                    */}
                    {issue.spec && (
                      <a
                        href={issue.spec}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 whitespace-nowrap text-xs font-medium underline underline-offset-2 opacity-70 hover:opacity-100"
                      >
                        spec ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Raw body
            </h3>
            <div className="mt-2">
              {/* Copies the pretty-printed text exactly as shown. */}
              <CodeBlock code={formatBody(message.rawBody)} />
            </div>
          </section>

          {message.headers.length > 0 && (
            <section className="mt-5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Request headers
              </h3>
              <HeaderList headers={fromSender} />

              {/*
                Everything a proxy bolted on, folded away. On a deployed instance
                these outnumber the headers the FHIR server actually sent, and
                the question this view answers is what *the server* sent. Kept
                rather than dropped — see the note in lib/headers.ts.
              */}
              {fromPlatform.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                    {fromPlatform.length} proxy header{fromPlatform.length === 1 ? "" : "s"} added
                    in front of Notifyr
                  </summary>
                  <HeaderList headers={fromPlatform} />
                </details>
              )}
              {message.headers.some((header) => header.sensitive) && (
                <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Headers are shown in full, credentials included. Anyone who knows this
                  endpoint&apos;s id can read them, so treat this page as public before sharing
                  the link.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

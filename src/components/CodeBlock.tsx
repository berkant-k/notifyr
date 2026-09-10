"use client";

import CopyButton from "@/components/CopyButton";

/**
 * A dark code block with a copy button in the corner.
 *
 * Lines wrap rather than scroll. These samples carry canonical URLs — the
 * `backport-*` extension identifiers are over 100 characters — and scrolling
 * hid up to 224px of the Subscription sample behind an edge with no scrollbar
 * to announce it, on the one block a new user has to read and get right.
 * Wrapping is uglier than a clean right margin and strictly more readable.
 */
export default function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      {/* Right padding keeps the first line clear of the button. */}
      <pre className="whitespace-pre-wrap break-words rounded-md bg-slate-900 p-4 pr-20 font-mono text-xs leading-relaxed text-slate-100">
        {code}
      </pre>
      <CopyButton
        value={code}
        className="absolute right-2 top-2 rounded-md border border-slate-600 bg-slate-800/90 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
      />
    </div>
  );
}

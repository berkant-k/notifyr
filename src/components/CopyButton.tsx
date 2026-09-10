"use client";

import { useState } from "react";

const DEFAULT_CLASS =
  "shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50";

interface Props {
  value: string;
  /** Overrides the default light styling, e.g. for use on a dark code block. */
  className?: string;
}

/** Small copy-to-clipboard button with a transient "Copied" state. */
export default function CopyButton({ value, className }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked (insecure origin, permissions).
      // The text is visible and selectable, so failing quietly is acceptable.
    }
  }

  return (
    <button type="button" onClick={copy} className={className ?? DEFAULT_CLASS}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

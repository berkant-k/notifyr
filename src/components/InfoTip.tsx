"use client";

import { useId, useState } from "react";

interface Props {
  /** What the icon is about, e.g. "About response overrides". Read to screen readers. */
  label: string;
  children: React.ReactNode;
}

/**
 * The explanation a card used to print underneath itself, folded behind an icon.
 *
 * Not a `title` attribute and not hover-only: both are unreachable from a
 * keyboard and invisible on touch. This opens on hover, on focus and on tap,
 * closes on Escape, and the panel is associated with the trigger through
 * `aria-describedby` so it is announced rather than merely drawn.
 */
export default function InfoTip({ label, children }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[10px] font-semibold text-slate-500 hover:border-slate-400 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
      >
        i
      </button>

      {open && (
        // Right-aligned: these live in a ~320px rail on the right of the page,
        // so a left-anchored panel would run off the edge.
        <span
          role="tooltip"
          id={id}
          className="absolute right-0 top-6 z-30 w-64 rounded-md border border-slate-200 bg-white p-3 text-xs font-normal leading-relaxed text-slate-600 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

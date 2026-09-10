"use client";

import { SPECS } from "@/lib/specs";

/**
 * Links out to the specifications Notifyr validates against.
 *
 * The URLs come from `lib/specs`, which is also what individual validation
 * findings cite — so this list and the "spec" link on a finding can never drift
 * apart. fhir-candle moved to the FHIR Foundation organisation.
 */

interface Reference {
  title: string;
  href: string;
  note: string;
}

const SPEC: Reference[] = [
  {
    title: "Subscription (R4B)",
    href: SPECS.subscription,
    note: "The resource itself, plus the Channels section that defines rest-hook delivery and endpoint validation.",
  },
  {
    title: "SubscriptionStatus (R4B)",
    href: SPECS.subscriptionStatus,
    note: "What every notification carries. Defines type (handshake, heartbeat, event-notification, query-status, query-event) as 1..1, and eventsSinceSubscriptionStart as a string.",
  },
  {
    title: "SubscriptionTopic (R4B)",
    href: SPECS.subscriptionTopic,
    note: "Describes which events trigger a notification and what the payload should contain.",
  },
  {
    title: "Topic-Based Subscriptions Framework (R5)",
    href: SPECS.framework,
    note: "The full framework, including the notification Bundle shape. R5 types eventsSinceSubscriptionStart as an integer64 rather than a string.",
  },
  {
    title: "Subscriptions R5 Backport IG",
    href: SPECS.backport,
    note: "How R4 servers implement the R5 model, and the source of the backport-heartbeat-period, backport-filter-criteria and backport-payload-content extensions.",
  },
  {
    title: "Notification payloads (Backport IG)",
    href: SPECS.payloads,
    note: "What empty, id-only and full-resource each require a notification Bundle to carry.",
  },
];

const TOOLING: Reference[] = [
  {
    title: "fhir-candle",
    href: "https://github.com/FHIR/fhir-candle",
    note: "In-memory FHIR server with a subscriptions reference implementation. Used in the walkthrough above.",
  },
  {
    title: "fhir (npm)",
    href: "https://www.npmjs.com/package/fhir",
    note: "The R4 validator Notifyr runs your payloads through.",
  },
];

function ReferenceList({ items }: { items: Reference[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.href}>
          <a
            href={item.href}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-slate-900 underline"
          >
            {item.title}
          </a>
          <p className="mt-0.5 text-xs text-slate-500">{item.note}</p>
        </li>
      ))}
    </ul>
  );
}

export default function References() {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Specification
        </h3>
        <div className="mt-3">
          <ReferenceList items={SPEC} />
        </div>
      </div>
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Tooling</h3>
        <div className="mt-3">
          <ReferenceList items={TOOLING} />
        </div>
      </div>
    </div>
  );
}

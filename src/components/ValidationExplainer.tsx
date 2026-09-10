"use client";

/** Explains what "valid" and "invalid" actually mean on the dashboard. */
export default function ValidationExplainer() {
  return (
    <div className="space-y-5 text-sm text-slate-600">
      <p>
        Every request runs through three tiers. Each one gates the next, so a message is only
        judged on rules it could plausibly satisfy.
      </p>

      <ol className="space-y-3">
        <li className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="font-medium text-slate-900">1. Does the body parse as JSON?</span>
          <p className="mt-1 text-xs">
            If not, the message is invalid and answered <code className="font-mono">400</code>.
            The raw body is still stored exactly as sent — an unparseable payload is usually the
            one you most need to look at.
          </p>
        </li>
        <li className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="font-medium text-slate-900">
            2. Is it a JSON object with a <code className="font-mono">resourceType</code>?
          </span>
          <p className="mt-1 text-xs">
            An array, a scalar, or an object without <code className="font-mono">resourceType</code>{" "}
            cannot be a FHIR resource. Invalid, answered{" "}
            <code className="font-mono">422</code>.
          </p>
        </li>
        <li className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="font-medium text-slate-900">
            3. Does it pass FHIR structural and value-set validation?
          </span>
          <p className="mt-1 text-xs">
            Run through the <code className="font-mono">fhir</code> package against R4. Unknown
            elements, missing required properties and codes outside their value set are reported
            with the exact path, e.g.{" "}
            <code className="font-mono">Patient.gender</code>. Invalid, answered{" "}
            <code className="font-mono">422</code>.
          </p>
        </li>
      </ol>

      <div>
        <h3 className="text-sm font-medium text-slate-900">Subscription notifications</h3>
        <p className="mt-1">
          These need special handling. The <code className="font-mono">fhir</code> package ships
          R4 conformance only, and <code className="font-mono">SubscriptionStatus</code> was
          introduced in R4B — so left alone the validator rejects the resource type outright and
          marks every handshake and heartbeat invalid.
        </p>
        <p className="mt-2">
          Notifyr therefore validates <code className="font-mono">SubscriptionStatus</code>{" "}
          entries itself against the R4B/R5 definition, and hands the rest of the Bundle to the
          library untouched, so a broken sibling resource is still caught.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          <li>
            <strong className="font-medium text-slate-900">Errors</strong> (make it invalid):{" "}
            <code className="font-mono">type</code> present and one of the five notification
            types; <code className="font-mono">subscription</code> present with a reference;{" "}
            <code className="font-mono">status</code> a known code;{" "}
            <code className="font-mono">topic</code> a string.
          </li>
          <li>
            <strong className="font-medium text-slate-900">Warnings</strong> (shown, still
            valid): <code className="font-mono">Bundle.type</code> other than{" "}
            <code className="font-mono">history</code>; a missing{" "}
            <code className="font-mono">Bundle.timestamp</code>;{" "}
            <code className="font-mono">SubscriptionStatus</code> not first; a{" "}
            <code className="font-mono">query-status</code> carrying event information, which
            the spec prohibits.
          </li>
          <li>
            A handshake or heartbeat <em>may</em> carry{" "}
            <code className="font-mono">notificationEvent</code> entries and is not flagged for
            it — R4B marks the element &quot;Special&quot; for those types, so a server catching
            a client up after a reconnect is behaving correctly.
          </li>
        </ul>
        <p className="mt-2 text-xs">
          <code className="font-mono">eventsSinceSubscriptionStart</code> is accepted both as a
          string (R4B) and as a number (R5).
        </p>
      </div>

      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        Warnings never make a message invalid, and only <em>valid</em> notifications are counted
        by type — a Bundle that failed validation has not established what kind of notification
        it was.
      </p>
    </div>
  );
}

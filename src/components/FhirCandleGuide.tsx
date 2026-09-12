"use client";

import CodeBlock from "@/components/CodeBlock";

/** Default base URL of a fhir-candle server started with the subscriptions RI. */
const CANDLE_BASE = "http://localhost:5826/fhir/r4b";

const PLACEHOLDER_HOOK = "https://your-notifyr-host/hook/your-hook-id";

function subscriptionSample(webhookUrl: string): string {
  return `{
  "resourceType": "Subscription",
  "id": "notifyr-test",
  "status": "active",
  "end": "2027-01-01T00:00:00Z",
  "reason": "Testing rest-hook notifications with Notifyr",
  "criteria": "http://example.org/FHIR/SubscriptionTopic/encounter-complete",
  "_criteria": {
    "extension": [
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
        "valueString": "Encounter?patient=Patient/example"
      }
    ]
  },
  "channel": {
    "extension": [
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-heartbeat-period",
        "valueInteger": 120
      }
    ],
    "type": "rest-hook",
    "endpoint": "${webhookUrl}",
    "payload": "application/fhir+json",
    "_payload": {
      "extension": [
        {
          "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
          "valueCode": "id-only"
        }
      ]
    }
  }
}`;
}

const ENCOUNTER_SAMPLE = `{
  "resourceType": "Encounter",
  "id": "example",
  "text": {
    "status": "generated",
    "div": "<div xmlns=\\"http://www.w3.org/1999/xhtml\\">Encounter with patient @example</div>"
  },
  "status": "active",
  "class": {
    "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
    "code": "IMP",
    "display": "inpatient encounter"
  },
  "subject": {
    "reference": "Patient/example"
  }
}`;

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h3 className="text-sm font-medium text-slate-900">{title}</h3>
        {children}
      </div>
    </li>
  );
}

/**
 * End-to-end walkthrough against fhir-candle, the reference FHIR server.
 *
 * When rendered on a dashboard the endpoint's real webhook URL is substituted
 * into the Subscription, so the sample can be pasted straight into a server.
 */
export default function FhirCandleGuide({ webhookUrl }: { webhookUrl?: string }) {
  const hook = webhookUrl ?? PLACEHOLDER_HOOK;

  return (
    <div className="space-y-5 text-sm text-slate-600">
      <p>
        <a
          href="https://github.com/FHIR/fhir-candle"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-slate-900 underline"
        >
          fhir-candle
        </a>{" "}
        is a small in-memory FHIR server with a built-in Subscriptions reference
        implementation, which makes it the quickest way to see real notifications land here.
      </p>

      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        No interest in running anything locally?{" "}
        <a
          href="https://subscriptions.argo.run/"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-slate-900 underline"
        >
          subscriptions.argo.run
        </a>{" "}
        hosts the same fhir-candle software, with{" "}
        <code className="font-mono">SubscriptionTopic/encounter-complete</code> already loaded
        at <code className="font-mono">/fhir/r4b</code> — skip straight to step 2 below with
        that base URL. It&apos;s shared, third-party infrastructure Notifyr doesn&apos;t
        control, so the local walkthrough is the one that&apos;s always reproducible and gives
        you server-side logs when something doesn&apos;t arrive.
      </p>

      {/*
        On the landing page there is no endpoint yet, so step 2 asks for a URL
        the reader does not have and the sample carries a placeholder. Say so,
        rather than letting them hunt for the value they were supposed to paste.
      */}
      {!webhookUrl && (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          Create an endpoint first — the sample in step 2 then arrives pre-filled with its own
          URL, on its dashboard.
        </p>
      )}

      <ol className="space-y-5">
        <Step number={1} title="Start fhir-candle with the subscriptions reference implementation">
          <CodeBlock code="fhir-candle --reference-implementation subscriptions -o" />
          <p className="text-xs text-slate-500">
            It serves R4B at <code className="font-mono">{CANDLE_BASE}</code> and{" "}
            <code className="font-mono">-o</code> opens its UI in a browser.
          </p>
        </Step>

        <Step number={2} title="Create a Subscription pointing at your webhook URL">
          <p className="text-xs text-slate-500">
            <code className="font-mono">PUT {CANDLE_BASE}/Subscription/notifyr-test</code>
          </p>
          <CodeBlock code={subscriptionSample(hook)} />
          <p className="text-xs text-slate-500">
            {webhookUrl ? (
              <>
                The <code className="font-mono">channel.endpoint</code> is already set to this
                endpoint&apos;s URL.{" "}
              </>
            ) : (
              <>
                Replace <code className="font-mono">channel.endpoint</code> with your own hook URL.{" "}
              </>
            )}
            The heartbeat extension is set to 120 seconds, so a heartbeat arrives every two
            minutes. Keep <code className="font-mono">end</code> in the future or the subscription
            expires.
          </p>
        </Step>

        <Step number={3} title="Watch the handshake arrive">
          <p>
            As soon as the Subscription becomes active, fhir-candle sends a{" "}
            <strong className="font-medium text-slate-900">handshake</strong>. It should appear
            here within a couple of seconds, and the Handshake counter should read 1. If it does
            not, the server could not reach your URL.
          </p>
        </Step>

        <Step number={4} title="Create an Encounter with status active">
          <p className="text-xs text-slate-500">
            <code className="font-mono">PUT {CANDLE_BASE}/Encounter/example</code>
          </p>
          <CodeBlock code={ENCOUNTER_SAMPLE} />
          <p className="text-xs text-slate-500">
            Nothing is notified yet — the topic fires on completion, not creation.
          </p>
        </Step>

        <Step number={5} title="Update the Encounter to status finished">
          <p>
            PUT the same Encounter again with{" "}
            <code className="font-mono">&quot;status&quot;: &quot;finished&quot;</code>. That
            satisfies the <code className="font-mono">encounter-complete</code> topic and triggers
            an <strong className="font-medium text-slate-900">event-notification</strong>.
          </p>
        </Step>
      </ol>

      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        You should end up with a handshake, an event-notification, and a heartbeat every two
        minutes for as long as the subscription stays active. Click any row to see its raw body
        and validation results.
      </p>
    </div>
  );
}

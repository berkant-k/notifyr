/**
 * Answers a REST client's reachability probe before it starts sending
 * notifications. The motivating case is HAPI FHIR's `SubscriptionRulesInterceptor`
 * (opt-in, and enabled on hapi.fhir.org's public test server): when a
 * Subscription with a `rest-hook` channel is created, it fetches
 * `{endpointUrl}/metadata` and rejects the Subscription outright — before a
 * single notification is attempted — if that does not parse as a
 * `CapabilityStatement`. Without an answer here, `/hook/:id/metadata` 404s at
 * the Next.js routing layer, the client throws trying to parse the 404 page,
 * and HAPI reports "HAPI-2671: REST HOOK endpoint is not reachable".
 *
 * Deliberately minimal and honest about scope: Notifyr does not implement the
 * FHIR REST API (no read, no search), so `rest` carries no `resource` entries
 * claiming otherwise — that would be a false conformance claim on a tool whose
 * entire premise is telling the truth about what arrived. The `documentation`
 * string says the real thing instead.
 */
export function capabilityStatementResponse(): Response {
  const body = {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    software: { name: "Notifyr" },
    implementation: {
      description: "Disposable webhook endpoint for FHIR Subscription rest-hook testing",
    },
    // The widest common denominator rather than R4B/R5, since nothing observed
    // cross-checks this against the FHIR version of the Subscription under
    // test — it only has to parse as a CapabilityStatement.
    fhirVersion: "4.0.1",
    format: ["json"],
    rest: [
      {
        mode: "server",
        documentation:
          "Notifyr does not implement the FHIR REST API. It accepts any HTTP body at its " +
          "webhook path and records it for inspection; this statement exists only so clients " +
          "that check reachability before delivery (e.g. HAPI FHIR's SubscriptionRulesInterceptor) " +
          "do not treat this endpoint as unreachable.",
      },
    ],
  };

  // Not NextResponse.json: this needs the exact FHIR content type, not
  // whatever NextResponse would default to.
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/fhir+json" },
  });
}

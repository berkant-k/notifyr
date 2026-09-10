/**
 * Where the rules come from.
 *
 * Every validation finding Notifyr raises itself cites one of these, so a
 * disagreement about a payload can be settled by reading the paragraph the rule
 * came from rather than by trusting this tool. Findings produced by the `fhir`
 * package carry no citation: they come from R4 conformance resources, not from
 * a page we can point at.
 *
 * Each URL was checked against the live page. Note that
 * `hl7.org/fhir/R4B/subscriptions.html` does *not* exist — R4B documents the
 * mechanism on the Subscription resource page — so linking the framework means
 * linking R5.
 */

export const SPECS = {
  /** The Subscription resource, including the Channels section that defines rest-hook. */
  subscription: "https://hl7.org/fhir/R4B/subscription.html",
  /** SubscriptionStatus: the elements every notification carries, and invariant sst-1. */
  subscriptionStatus: "https://hl7.org/fhir/R4B/subscriptionstatus.html",
  subscriptionTopic: "https://hl7.org/fhir/R4B/subscriptiontopic.html",
  /** The R5 framework, which R4B and the backport IG both model. */
  framework: "https://hl7.org/fhir/R5/subscriptions.html",
  backport: "https://hl7.org/fhir/uv/subscriptions-backport/",
  /** The notification Bundle envelope: type history, SubscriptionStatus first. */
  notifications: "https://hl7.org/fhir/uv/subscriptions-backport/notifications.html",
  /** empty / id-only / full-resource, and what each requires the Bundle to carry. */
  payloads: "https://hl7.org/fhir/uv/subscriptions-backport/payloads.html",
  /**
   * How a subscriber notices trouble: gaps in `eventsSinceSubscriptionStart`,
   * and a heartbeat period elapsing with nothing received.
   */
  errors: "https://hl7.org/fhir/uv/subscriptions-backport/errors.html",
} as const;

export type SpecUrl = (typeof SPECS)[keyof typeof SPECS];

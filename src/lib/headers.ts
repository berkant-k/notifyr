/**
 * Capturing request headers for display.
 *
 * Headers are stored verbatim, including `Authorization`. Seeing the exact
 * credential a FHIR server attached to its notification is a core reason to
 * inspect a webhook at all — a masked value cannot tell you whether the server
 * sent the token you expected.
 *
 * Credential-bearing headers are still *flagged*, so the UI can make clear
 * which values are sensitive before a dashboard link gets shared. That is a
 * labelling aid, not a protection: anyone holding the endpoint id can read
 * these values, through the page or through the API.
 */

import type { MessageHeader } from "@/lib/types";

/**
 * Headers a proxy or platform adds on the way in.
 *
 * Not sent by the FHIR server, so they answer nothing about the notification —
 * on a Vercel deployment they are most of the list, and they bury the handful of
 * headers that do matter. Flagged rather than dropped: `x-forwarded-for` names
 * the machine that actually called, and on a deployment where several servers
 * share an endpoint that is the fastest way to tell which one is misbehaving.
 */
const PLATFORM_PREFIXES = [
  "x-vercel-",
  "x-forwarded-",
  "cf-", // Cloudflare
  "x-amzn-",
  "x-middleware-",
  "x-nextjs-",
];

const PLATFORM_HEADERS = new Set(["forwarded", "x-real-ip", "via", "x-vercel-id"]);

function isPlatform(name: string): boolean {
  return (
    PLATFORM_HEADERS.has(name) || PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Headers whose values usually carry a credential. Flagged, never altered. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
]);

/** Snapshot the headers of an incoming request, alphabetically. */
export function captureHeaders(request: Request): MessageHeader[] {
  const captured: MessageHeader[] = [];

  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    captured.push({
      name,
      value,
      sensitive: SENSITIVE_HEADERS.has(lower),
      platform: isPlatform(lower),
    });
  });

  return captured.sort((a, b) => a.name.localeCompare(b.name));
}

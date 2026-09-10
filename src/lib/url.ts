/**
 * Notifyr does not know its own public hostname (it differs between localhost,
 * Vercel preview URLs and a custom domain), so webhook URLs are derived from
 * the incoming request rather than configured.
 */

/** Origin from request headers, honouring the proxy headers Vercel sets. */
export function originFromHeaders(headers: Headers): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000";
  const protocol =
    headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

/** Origin of the incoming request. */
export function originFrom(request: Request): string {
  return originFromHeaders(request.headers);
}

/** Public webhook URL from a server component's headers. */
export function webhookUrlFromHeaders(headers: Headers, endpointId: string): string {
  return `${originFromHeaders(headers)}/hook/${endpointId}`;
}

/** Public webhook URL for an endpoint, as sent to the FHIR server. */
export function webhookUrlFrom(request: Request, endpointId: string): string {
  return `${originFrom(request)}/hook/${endpointId}`;
}

/*
  There is deliberately no browser-side variant.
  
  One existed, branching on `typeof window` and returning a bare path on the
  server and an absolute URL in the browser — which is a hydration mismatch by
  construction: the server sent `/hook/berk` and the client rendered
  `http://localhost:3000/hook/berk` into the same text node. Pages compute the
  URL with `webhookUrlFromHeaders` and pass it down, so both renders agree.
*/

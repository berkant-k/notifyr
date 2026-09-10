/**
 * Endpoint ids.
 *
 * An id is free-form text, but it becomes a URL path segment (`/hook/<id>`), so
 * it cannot be literally *any* string: a `/` would split the route and a space
 * or `?` would have to be percent-encoded, giving the user a URL that does not
 * look like what they typed. We therefore accept the URL-unreserved set, which
 * survives a round trip through a URL untouched.
 */

export const MAX_ENDPOINT_ID_LENGTH = 64;

/** RFC 3986 "unreserved" characters: safe in a path segment with no encoding. */
const ALLOWED_CHARACTERS = /^[A-Za-z0-9._~-]+$/;

export const ENDPOINT_ID_RULES =
  "Letters, digits, and - . _ ~ only; up to 64 characters.";

export type EndpointIdCheck = { ok: true; id: string } | { ok: false; error: string };

/** Validate a user-supplied id, trimming surrounding whitespace. */
export function validateEndpointId(raw: string): EndpointIdCheck {
  const id = raw.trim();

  if (id === "") {
    return { ok: false, error: "Endpoint id cannot be empty." };
  }
  if (id.length > MAX_ENDPOINT_ID_LENGTH) {
    return {
      ok: false,
      error: `Endpoint id cannot be longer than ${MAX_ENDPOINT_ID_LENGTH} characters.`,
    };
  }
  if (!ALLOWED_CHARACTERS.test(id)) {
    return { ok: false, error: `Endpoint id contains unsupported characters. ${ENDPOINT_ID_RULES}` };
  }
  // Both are legal per the character rules but mean something else in a path.
  if (id === "." || id === "..") {
    return { ok: false, error: `"${id}" cannot be used as an endpoint id.` };
  }

  return { ok: true, id };
}

/** The id used when the user does not supply one. */
export function randomEndpointId(): string {
  return crypto.randomUUID();
}

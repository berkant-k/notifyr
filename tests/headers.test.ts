import { describe, expect, it } from "vitest";
import { captureHeaders } from "@/lib/headers";

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/hook/x", { method: "POST", headers, body: "{}" });
}

function valueOf(headers: ReturnType<typeof captureHeaders>, name: string) {
  return headers.find((header) => header.name === name);
}

describe("capture", () => {
  it("keeps ordinary headers verbatim", () => {
    const headers = captureHeaders(
      request({ "content-type": "application/fhir+json", "user-agent": "fhir-candle/1.0" }),
    );

    expect(valueOf(headers, "content-type")).toEqual({
      name: "content-type",
      value: "application/fhir+json",
      sensitive: false,
      platform: false,
    });
    expect(valueOf(headers, "user-agent")?.value).toBe("fhir-candle/1.0");
  });

  it("sorts alphabetically for a stable display order", () => {
    const headers = captureHeaders(request({ "z-last": "1", "a-first": "2", "m-middle": "3" }));
    const names = headers.map((header) => header.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("authorization", () => {
  // The point of inspecting a webhook is seeing exactly what the server sent,
  // so the credential is kept intact rather than masked.
  it("stores the value verbatim", () => {
    const token = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const headers = captureHeaders(request({ authorization: token }));

    expect(valueOf(headers, "authorization")?.value).toBe(token);
  });

  it("flags it as sensitive so the UI can label it", () => {
    const headers = captureHeaders(request({ authorization: "Bearer abc123" }));
    expect(valueOf(headers, "authorization")?.sensitive).toBe(true);
  });

  it("survives serialisation to the client", () => {
    const token = "Bearer round-trip-me";
    const headers = captureHeaders(request({ authorization: token }));
    expect(JSON.parse(JSON.stringify(headers))).toContainEqual({
      name: "authorization",
      value: token,
      sensitive: true,
      platform: false,
    });
  });
});

describe("sensitivity flag", () => {
  it.each([
    "authorization",
    "proxy-authorization",
    "cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-access-token",
    "x-csrf-token",
  ])("flags %s while keeping its value", (name) => {
    const secret = "value-worth-flagging";
    const header = valueOf(captureHeaders(request({ [name]: secret })), name);

    expect(header?.sensitive).toBe(true);
    expect(header?.value).toBe(secret);
  });

  it("matches case-insensitively", () => {
    const headers = captureHeaders(request({ Authorization: "Bearer abc123" }));
    expect(valueOf(headers, "authorization")?.sensitive).toBe(true);
  });

  it("leaves ordinary headers unflagged", () => {
    const headers = captureHeaders(request({ "content-type": "application/fhir+json" }));
    expect(headers.every((header) => !header.sensitive)).toBe(true);
  });
});

describe("proxy and platform headers", () => {
  function capture(names: Record<string, string>) {
    return captureHeaders(new Request("http://localhost:3000/hook/x", { headers: names }));
  }

  function platformNames(headers: ReturnType<typeof captureHeaders>) {
    return headers.filter((header) => header.platform).map((header) => header.name);
  }

  it("flags the platform's own headers", () => {
    const headers = capture({
      "x-vercel-id": "fra1::abc",
      "x-vercel-ip-country": "DE",
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-proto": "https",
      "x-real-ip": "203.0.113.7",
      via: "1.1 vegur",
      "cf-ray": "8a1b2c3d",
    });

    expect(platformNames(headers)).toHaveLength(7);
  });

  it("leaves the sender's own headers alone", () => {
    const headers = capture({
      "content-type": "application/fhir+json",
      "user-agent": "fhir-candle/1.0",
      authorization: "Bearer token",
      "x-request-id": "server-generated",
    });

    expect(platformNames(headers)).toEqual([]);
  });

  // Dropping them would take the answer to "which machine actually called?"
  // with them, which is the question when the answer is "not the one I meant".
  it("keeps the value of a platform header rather than dropping it", () => {
    const headers = capture({ "x-forwarded-for": "203.0.113.7" });
    expect(headers[0].value).toBe("203.0.113.7");
  });

  it("classifies independently of the credential flag", () => {
    const headers = capture({ authorization: "Bearer t", "x-vercel-id": "fra1::abc" });
    const authorization = headers.find((header) => header.name === "authorization");
    const vercel = headers.find((header) => header.name === "x-vercel-id");

    expect(authorization).toMatchObject({ sensitive: true, platform: false });
    expect(vercel).toMatchObject({ sensitive: false, platform: true });
  });
});

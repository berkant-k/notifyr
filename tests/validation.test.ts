import { describe, expect, it } from "vitest";
import { validateBody } from "@/lib/validation";

const FHIR_JSON = "application/fhir+json";

describe("tier 1 — JSON parseability", () => {
  it("rejects an empty body with 400", () => {
    const result = validateBody("", FHIR_JSON);
    expect(result.isValid).toBe(false);
    expect(result.status).toBe(400);
    expect(result.summary).toBe("Empty body");
  });

  it("rejects a body of only whitespace", () => {
    expect(validateBody("   \n  ", FHIR_JSON).isValid).toBe(false);
  });

  it("rejects malformed JSON with 400 and keeps the parser message", () => {
    const result = validateBody('{"resourceType":"Bundle","type":', FHIR_JSON);
    expect(result.isValid).toBe(false);
    expect(result.status).toBe(400);
    expect(result.summary).toBe("Malformed JSON");
    expect(result.validationErrors[0].severity).toBe("fatal");
  });
});

describe("tier 2 — looks like a FHIR resource", () => {
  it("rejects a JSON array", () => {
    const result = validateBody("[]", FHIR_JSON);
    expect(result.isValid).toBe(false);
    expect(result.status).toBe(422);
    expect(result.summary).toBe("Not a FHIR resource");
  });

  it("rejects a JSON scalar", () => {
    expect(validateBody('"hello"', FHIR_JSON).isValid).toBe(false);
  });

  it("rejects an object without resourceType with 422", () => {
    const result = validateBody('{"event":"ping"}', "application/json");
    expect(result.isValid).toBe(false);
    expect(result.status).toBe(422);
    expect(result.validationErrors.some((e) => e.message.includes("resourceType"))).toBe(true);
  });
});

describe("tier 3 — FHIR structural validation", () => {
  it("accepts a valid Patient", () => {
    const result = validateBody(
      '{"resourceType":"Patient","id":"example","gender":"male","birthDate":"1974-12-25"}',
      FHIR_JSON,
    );
    expect(result.isValid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.summary).toBe("Patient/example");
  });

  it("rejects a code outside its value set", () => {
    const result = validateBody(
      '{"resourceType":"Patient","id":"x","gender":"not-a-gender"}',
      FHIR_JSON,
    );
    expect(result.isValid).toBe(false);
    expect(result.status).toBe(422);
    expect(result.validationErrors.some((e) => e.location === "Patient.gender")).toBe(true);
  });

  it("summarises a plain Bundle by type and entry count", () => {
    const result = validateBody(
      '{"resourceType":"Bundle","type":"searchset","entry":[{"resource":{"resourceType":"Patient","id":"a"}}]}',
      FHIR_JSON,
    );
    expect(result.summary).toBe("Bundle · searchset · 1 entry");
  });

  it("falls back to the resource type when there is no id", () => {
    expect(validateBody('{"resourceType":"Patient"}', FHIR_JSON).summary).toBe("Patient");
  });
});

describe("content type", () => {
  it("warns on a non-FHIR content type without failing the message", () => {
    const result = validateBody('{"resourceType":"Patient","id":"a"}', "application/json");
    expect(result.isValid).toBe(true);
    expect(result.validationErrors.some((e) => e.severity === "warning")).toBe(true);
  });

  it("does not warn on application/fhir+json", () => {
    const result = validateBody('{"resourceType":"Patient","id":"a"}', FHIR_JSON);
    expect(result.validationErrors).toHaveLength(0);
  });

  it("tolerates a missing content type", () => {
    expect(validateBody('{"resourceType":"Patient","id":"a"}', null).isValid).toBe(true);
  });
});

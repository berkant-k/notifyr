import { describe, expect, it } from "vitest";
import {
  mustOmitBody,
  overrideFor,
  validateOverrideStatus,
  validateResponseRulesPatch,
} from "@/lib/responseRules";
import { defaultResponseRules, type ResponseRules } from "@/lib/types";

describe("validateOverrideStatus", () => {
  it.each([201, 202, 301, 400, 404, 418, 422, 500, 503, 599])("accepts %i", (status) => {
    expect(validateOverrideStatus(status)).toEqual({ ok: true, status });
  });

  it("accepts a numeric string, as the input element supplies", () => {
    expect(validateOverrideStatus(" 503 ")).toEqual({ ok: true, status: 503 });
  });

  // 200 is what "switched on" already means.
  it("rejects 200", () => {
    const result = validateOverrideStatus(200);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("200");
  });

  // Outside 200-599 the Response constructor throws a RangeError, which would
  // surface as a 500 instead of a clear message.
  it.each([100, 101, 199, 600, 999, 0, -1])("rejects out-of-range %i", (status) => {
    expect(validateOverrideStatus(status).ok).toBe(false);
  });

  it.each([1.5, "abc", "", null, undefined, {}, [], true])("rejects %j", (value) => {
    expect(validateOverrideStatus(value).ok).toBe(false);
  });
});

describe("mustOmitBody", () => {
  // Sending a body with these throws "Invalid response status code".
  it.each([204, 205, 304])("flags %i as bodiless", (status) => {
    expect(mustOmitBody(status)).toBe(true);
  });

  it.each([200, 201, 400, 500])("leaves %i alone", (status) => {
    expect(mustOmitBody(status)).toBe(false);
  });
});

describe("validateResponseRulesPatch", () => {
  it("accepts a single-type patch", () => {
    const result = validateResponseRulesPatch({ handshake: { enabled: false, status: 400 } });
    expect(result).toEqual({ ok: true, rules: { handshake: { enabled: false, status: 400 } } });
  });

  it("accepts every overridable type at once", () => {
    const result = validateResponseRulesPatch({
      handshake: { enabled: false, status: 500 },
      heartbeat: { enabled: true, status: 400 },
      "event-notification": { enabled: false, status: 503 },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a type that is not overridable", () => {
    const result = validateResponseRulesPatch({ "query-status": { enabled: false, status: 400 } });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-boolean enabled", () => {
    expect(validateResponseRulesPatch({ handshake: { enabled: "no", status: 400 } }).ok).toBe(false);
  });

  // Validated even while enabled, so flipping the switch later cannot land on
  // a status the Response constructor will reject.
  it("rejects a bad status even when enabled is true", () => {
    expect(validateResponseRulesPatch({ handshake: { enabled: true, status: 200 } }).ok).toBe(false);
    expect(validateResponseRulesPatch({ handshake: { enabled: true, status: 99 } }).ok).toBe(false);
  });

  it.each([null, "handshake", 42, [], [{ enabled: false, status: 400 }]])(
    "rejects a non-object body %j",
    (body) => {
      expect(validateResponseRulesPatch(body).ok).toBe(false);
    },
  );
});

describe("overrideFor", () => {
  const rules: ResponseRules = {
    handshake: { enabled: false, status: 503 },
    heartbeat: { enabled: true, status: 400 },
    "event-notification": { enabled: false, status: 418 },
  };

  it("returns the status for a disabled type", () => {
    expect(overrideFor(rules, "handshake")).toBe(503);
    expect(overrideFor(rules, "event-notification")).toBe(418);
  });

  it("returns null for an enabled type, whatever status it holds", () => {
    expect(overrideFor(rules, "heartbeat")).toBeNull();
  });

  it("returns null across the defaults, so a new endpoint overrides nothing", () => {
    const defaults = defaultResponseRules();
    expect(overrideFor(defaults, "handshake")).toBeNull();
    expect(overrideFor(defaults, "heartbeat")).toBeNull();
    expect(overrideFor(defaults, "event-notification")).toBeNull();
  });
});

describe("defaults", () => {
  it("starts every type enabled with the suggested status", () => {
    expect(defaultResponseRules()).toEqual({
      handshake: { enabled: true, status: 400 },
      heartbeat: { enabled: true, status: 400 },
      "event-notification": { enabled: true, status: 400 },
    });
  });
});

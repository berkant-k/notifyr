import { describe, expect, it } from "vitest";
import { MAX_ENDPOINT_ID_LENGTH, randomEndpointId, validateEndpointId } from "@/lib/endpointId";

describe("accepted ids", () => {
  it.each([
    "my-test-hook",
    "berkant-test",
    "hook_1",
    "a.b.c",
    "tilde~ok",
    "A",
    "9",
    "MixedCase",
    "x".repeat(MAX_ENDPOINT_ID_LENGTH),
  ])("accepts %j", (id) => {
    const result = validateEndpointId(id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBe(id);
  });

  it("trims surrounding whitespace", () => {
    const result = validateEndpointId("  my-hook  ");
    expect(result).toEqual({ ok: true, id: "my-hook" });
  });

  it("preserves case rather than normalising it", () => {
    const result = validateEndpointId("MyHook");
    if (result.ok) expect(result.id).toBe("MyHook");
  });
});

describe("rejected ids", () => {
  it.each([
    ["", "empty"],
    ["   ", "only whitespace"],
    ["has space", "a space"],
    ["a/b", "a path separator"],
    ["a?b", "a query separator"],
    ["a#b", "a fragment marker"],
    ["a%2Fb", "a percent escape"],
    ["emoji-🎉", "a non-ASCII character"],
    [".", "a bare dot"],
    ["..", "a parent-directory reference"],
    ["x".repeat(MAX_ENDPOINT_ID_LENGTH + 1), "an over-long id"],
  ])("rejects %j (%s)", (id) => {
    const result = validateEndpointId(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });
});

describe("random ids", () => {
  it("generates ids that pass validation", () => {
    for (let i = 0; i < 5; i++) {
      expect(validateEndpointId(randomEndpointId()).ok).toBe(true);
    }
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 50 }, randomEndpointId));
    expect(ids.size).toBe(50);
  });
});

describe("round trip through a URL", () => {
  // The whole point of the character rule: what the user types is what they see.
  it("leaves accepted ids unchanged when encoded", () => {
    for (const id of ["my-test-hook", "a.b_c~d", "Hook123"]) {
      expect(encodeURIComponent(id)).toBe(id);
      expect(new URL(`http://x/hook/${id}`).pathname).toBe(`/hook/${id}`);
    }
  });
});

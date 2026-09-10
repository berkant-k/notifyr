import { describe, expect, it } from "vitest";
import {
  checkExpectedEnd,
  isAfterExpectedEnd,
  normaliseExpectedEnd,
  overshootLabel,
} from "@/lib/expiry";

const END = "2026-09-10T18:30:00.000Z";

describe("isAfterExpectedEnd", () => {
  it("is false when no end is configured", () => {
    expect(isAfterExpectedEnd(null, "2099-01-01T00:00:00.000Z")).toBe(false);
  });

  it("is false for an arrival before the end", () => {
    expect(isAfterExpectedEnd(END, "2026-09-10T18:29:59.000Z")).toBe(false);
  });

  // The boundary is the whole feature: "after the end" must not include the
  // instant the subscription was still entitled to send on.
  it("is false for an arrival exactly on the end", () => {
    expect(isAfterExpectedEnd(END, END)).toBe(false);
  });

  it("is true one millisecond past the end", () => {
    expect(isAfterExpectedEnd(END, "2026-09-10T18:30:00.001Z")).toBe(true);
  });

  it("compares instants, not wall-clock strings", () => {
    // 19:30+01:00 is 18:30Z — the same moment, differently written.
    expect(isAfterExpectedEnd(END, "2026-09-10T19:30:00.000+01:00")).toBe(false);
    expect(isAfterExpectedEnd(END, "2026-09-10T19:31:00.000+01:00")).toBe(true);
  });

  it("is false when either timestamp is unparseable", () => {
    expect(isAfterExpectedEnd("not a date", "2099-01-01T00:00:00.000Z")).toBe(false);
    expect(isAfterExpectedEnd(END, "not a date")).toBe(false);
  });
});

describe("checkExpectedEnd", () => {
  it("reports nothing when the check is off", () => {
    expect(checkExpectedEnd(null, "2099-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("reports nothing for an arrival in time", () => {
    expect(checkExpectedEnd(END, "2026-09-10T18:00:00.000Z")).toEqual([]);
  });

  it("warns, rather than erroring, on a late arrival", () => {
    const [finding, ...rest] = checkExpectedEnd(END, "2026-09-10T18:34:12.000Z");

    expect(rest).toEqual([]);
    // A warning keeps the notification valid, so it stays in the per-type
    // tallies this feature exists to watch.
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("4m 12s");
    expect(finding.message).toContain(END);
    expect(finding.spec).toBeDefined();
  });

  it("agrees with isAfterExpectedEnd on the boundary", () => {
    for (const arrival of [
      "2026-09-10T18:29:59.999Z",
      END,
      "2026-09-10T18:30:00.001Z",
      "2026-09-11T00:00:00.000Z",
    ]) {
      expect(checkExpectedEnd(END, arrival).length > 0).toBe(isAfterExpectedEnd(END, arrival));
    }
  });

  it("stays silent on an unparseable stored deadline", () => {
    // The route rejects these on the way in, so one here is Notifyr's bug and
    // not something the user could act on.
    expect(checkExpectedEnd("whenever", "2099-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("overshootLabel", () => {
  it.each([
    [0, "0s"],
    [1, "1s"],
    [59, "59s"],
    [60, "1m"],
    [252, "4m 12s"],
    [3600, "1h"],
    [7500, "2h 5m"],
    [86_400, "1d"],
    [273_600, "3d 4h"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(overshootLabel(seconds)).toBe(expected);
  });
});

describe("normaliseExpectedEnd", () => {
  it("normalises to a UTC instant", () => {
    expect(normaliseExpectedEnd("2026-09-10T19:30:00+01:00")).toBe(END);
  });

  it("accepts surrounding whitespace", () => {
    expect(normaliseExpectedEnd("  2026-09-10T18:30:00Z  ")).toBe(END);
  });

  it("returns null for a non-date", () => {
    expect(normaliseExpectedEnd("next Tuesday")).toBeNull();
    expect(normaliseExpectedEnd("")).toBeNull();
  });
});

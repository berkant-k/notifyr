import { describe, expect, it } from "vitest";
import { relativeKey, relativeLabel } from "@/lib/time";

const BASE = Date.parse("2026-09-09T12:00:00.000Z");
const ago = (seconds: number) => new Date(BASE - seconds * 1000).toISOString();

describe("relativeLabel", () => {
  it("calls the last few seconds 'just now'", () => {
    expect(relativeLabel(ago(0), BASE)).toBe("just now");
    expect(relativeLabel(ago(4), BASE)).toBe("just now");
  });

  it("counts seconds, then minutes, then hours, then days", () => {
    expect(relativeLabel(ago(8), BASE)).toBe("8s ago");
    expect(relativeLabel(ago(59), BASE)).toBe("59s ago");
    expect(relativeLabel(ago(60), BASE)).toBe("1m ago");
    expect(relativeLabel(ago(3599), BASE)).toBe("59m ago");
    expect(relativeLabel(ago(3600), BASE)).toBe("1h ago");
    expect(relativeLabel(ago(86_400), BASE)).toBe("1d ago");
  });

  // Clock skew between the sender and this machine must not produce "-3s ago".
  it("never counts backwards", () => {
    expect(relativeLabel(new Date(BASE + 5000).toISOString(), BASE)).toBe("just now");
  });

  it("is empty for an unparseable timestamp rather than NaN", () => {
    expect(relativeLabel("not a date", BASE)).toBe("");
  });
});

describe("relativeKey", () => {
  // What decides whether the dashboard redraws. It must move while the label
  // moves, and hold still once the label stops changing every second.
  it("changes second by second while a row is recent", () => {
    const rows = [ago(10)];
    expect(relativeKey(rows, BASE)).not.toBe(relativeKey(rows, BASE + 1000));
  });

  it("holds still between seconds within the same minute bucket", () => {
    const rows = [ago(600)];
    expect(relativeKey(rows, BASE)).toBe(relativeKey(rows, BASE + 5000));
  });

  it("holds still for hour-old rows until the hour turns", () => {
    const rows = [ago(7200)];
    expect(relativeKey(rows, BASE)).toBe(relativeKey(rows, BASE + 59 * 60 * 1000));
    expect(relativeKey(rows, BASE)).not.toBe(relativeKey(rows, BASE + 61 * 60 * 1000));
  });

  it("covers every row, not just the newest", () => {
    const rows = [ago(7200), ago(10)];
    expect(relativeKey(rows, BASE)).not.toBe(relativeKey(rows, BASE + 1000));
  });
});

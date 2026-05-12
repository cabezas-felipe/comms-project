import { describe, expect, it } from "vitest";
import { formatClock, formatRefreshTimestamp } from "@/lib/format";

describe("formatRefreshTimestamp", () => {
  it("returns '—' for null", () => {
    expect(formatRefreshTimestamp(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatRefreshTimestamp(undefined)).toBe("—");
  });

  it("returns '—' for an empty string", () => {
    expect(formatRefreshTimestamp("")).toBe("—");
  });

  it("returns '—' for an unparseable date string", () => {
    expect(formatRefreshTimestamp("definitely not a date")).toBe("—");
  });

  it("returns the same output as formatClock(new Date(value)) for a valid ISO string", () => {
    const iso = "2026-05-08T12:34:56Z";
    expect(formatRefreshTimestamp(iso)).toBe(formatClock(new Date(iso)));
  });

  it("handles a different valid ISO string consistently with formatClock", () => {
    const iso = "2026-01-01T00:05:00Z";
    expect(formatRefreshTimestamp(iso)).toBe(formatClock(new Date(iso)));
  });
});

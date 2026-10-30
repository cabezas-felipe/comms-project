import { describe, expect, it } from "vitest";
import { formatClock, formatKeywordLabel, formatRefreshTimestamp } from "@/lib/format";

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

describe("formatKeywordLabel", () => {
  it("title-cases a lowercase single-word keyword", () => {
    expect(formatKeywordLabel("oil")).toBe("Oil");
  });

  it("title-cases each word in a multi-word keyword", () => {
    expect(formatKeywordLabel("iran trade")).toBe("Iran Trade");
  });

  it("preserves an all-uppercase acronym as-is", () => {
    expect(formatKeywordLabel("OFAC")).toBe("OFAC");
  });

  it("preserves a short uppercase token (e.g. 'US') as-is", () => {
    expect(formatKeywordLabel("US")).toBe("US");
  });

  it("preserves acronyms mixed with normal words", () => {
    expect(formatKeywordLabel("OFAC enforcement")).toBe("OFAC Enforcement");
  });

  it("treats any all-uppercase token with letters as an acronym (locks the heuristic)", () => {
    // A token with letters that's already uppercase is treated as an acronym
    // (heuristic — we cannot disambiguate "USA" from "YELLING").  This locks
    // the behavior so it doesn't drift accidentally.
    expect(formatKeywordLabel("USA")).toBe("USA");
  });

  it("collapses internal whitespace runs and trims leading/trailing space", () => {
    expect(formatKeywordLabel("  iran   trade  ")).toBe("Iran Trade");
  });

  it("returns empty string for empty or whitespace-only input", () => {
    expect(formatKeywordLabel("")).toBe("");
    expect(formatKeywordLabel("   ")).toBe("");
  });

  it("handles mixed casing input by normalizing to title case", () => {
    expect(formatKeywordLabel("sAnCtIoNs")).toBe("Sanctions");
  });
});

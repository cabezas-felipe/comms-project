import { describe, expect, it } from "vitest";
import {
  normalizeSourceIdentity,
  normalizeSourceName,
  normalizeTopicLabel,
  normalizeKeywordLabel,
} from "./label-normalization.js";

describe("normalizeSourceIdentity", () => {
  it("collapses case differences", () => {
    expect(normalizeSourceIdentity("Reuters")).toBe(
      normalizeSourceIdentity("REUTERS")
    );
    expect(normalizeSourceIdentity("Reuters")).toBe(
      normalizeSourceIdentity("reuters")
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSourceIdentity("  Reuters  ")).toBe(
      normalizeSourceIdentity("Reuters")
    );
    expect(normalizeSourceIdentity("\tReuters\n")).toBe(
      normalizeSourceIdentity("Reuters")
    );
  });

  it("collapses internal whitespace to a single space", () => {
    expect(normalizeSourceIdentity("The  New   York    Times")).toBe(
      "the new york times"
    );
    expect(normalizeSourceIdentity("The New\tYork\nTimes")).toBe(
      "the new york times"
    );
  });

  it("treats case + whitespace variants as the same identity", () => {
    const variants = [
      "Reuters",
      "reuters",
      "REUTERS",
      "  Reuters  ",
      "Reuters ",
      " reuters",
    ];
    const keys = new Set(variants.map(normalizeSourceIdentity));
    expect(keys.size).toBe(1);
  });

  it("does not apply alias resolution (NYT stays distinct from New York Times)", () => {
    // Identity collapse is formatting-only; alias resolution lives in
    // normalizeSourceName.  Keep them separate so the chip count never silently
    // merges "@nyt" and "The New York Times" into one source.
    expect(normalizeSourceIdentity("NYT")).not.toBe(
      normalizeSourceIdentity("The New York Times")
    );
  });

  it("preserves social-handle distinctness when only the leading @ varies", () => {
    expect(normalizeSourceIdentity("@latamwatcher")).not.toBe(
      normalizeSourceIdentity("latamwatcher")
    );
  });
});

// Light smoke coverage for the rest of the module — these helpers were already
// exercised indirectly via pipeline tests, but a direct unit test keeps the
// contract explicit alongside the new helper.

describe("existing normalizers (smoke)", () => {
  it("normalizeSourceName trims and resolves known aliases", () => {
    expect(normalizeSourceName("  nyt  ")).toBe("New York Times");
    expect(normalizeSourceName("The Hill")).toBe("The Hill");
  });

  it("normalizeTopicLabel resolves bilateral relations to Diplomatic relations", () => {
    expect(normalizeTopicLabel("bilateral relations")).toBe(
      "Diplomatic relations"
    );
  });

  it("normalizeKeywordLabel collapses plural forms", () => {
    expect(normalizeKeywordLabel("outbreaks")).toBe("outbreak");
  });
});

// Slice 13: Colombian / Spanish-language outlet aliases. Common spelling and
// accent variants — plus the legacy (wrong) "Silla Nacional" forms accepted as
// input only — must all fold onto the canonical publisher strings.
describe("normalizeSourceName — Spanish outlet aliases (Slice 13)", () => {
  it("folds La Silla Vacía variants (accent-dropped + lowercase) to the canonical name", () => {
    expect(normalizeSourceName("la silla vacia")).toBe("La Silla Vacía");
    expect(normalizeSourceName("la silla vacía")).toBe("La Silla Vacía");
    expect(normalizeSourceName("La Silla Vacia")).toBe("La Silla Vacía");
    expect(normalizeSourceName("La Silla Vacía")).toBe("La Silla Vacía");
  });

  it("folds the legacy (wrong) Silla Nacional spellings to La Silla Vacía", () => {
    expect(normalizeSourceName("silla nacional")).toBe("La Silla Vacía");
    expect(normalizeSourceName("la silla nacional")).toBe("La Silla Vacía");
  });

  it("folds Semana variants to the canonical name", () => {
    expect(normalizeSourceName("revista semana")).toBe("Semana");
    expect(normalizeSourceName("Semana")).toBe("Semana");
  });

  it("folds Infobae variants to the canonical name", () => {
    expect(normalizeSourceName("infobae colombia")).toBe("Infobae");
    expect(normalizeSourceName("infobae américa")).toBe("Infobae");
    expect(normalizeSourceName("Infobae")).toBe("Infobae");
  });
});

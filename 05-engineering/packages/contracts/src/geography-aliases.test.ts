import { describe, expect, it } from "vitest";
import { GEOGRAPHY_ALIASES, resolveGeographyAlias } from "./geography-aliases.js";

describe("GEOGRAPHY_ALIASES authoring invariants", () => {
  it("keys are stored lowercase (lookups normalize before consulting)", () => {
    for (const key of Object.keys(GEOGRAPHY_ALIASES)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("canonical values are non-empty strings", () => {
    for (const value of Object.values(GEOGRAPHY_ALIASES)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("includes the brief's canonical examples (Beijing → China, Montevideo → Latin America)", () => {
    expect(GEOGRAPHY_ALIASES["beijing"]).toBe("China");
    expect(GEOGRAPHY_ALIASES["montevideo"]).toBe("Latin America");
  });
});

describe("resolveGeographyAlias", () => {
  it("emits the settings-cased canonical when the alias and the canonical are both opted in", () => {
    expect(resolveGeographyAlias("Beijing", ["China", "US"])).toBe("China");
  });

  it("emits using the settings spelling, not the alias map's title-case literal", () => {
    // Settings vocabulary uses a lowercase spelling — emission must preserve
    // it so UI labels stay consistent with the user's own configuration.
    expect(resolveGeographyAlias("Beijing", ["china", "us"])).toBe("china");
  });

  it("is case-insensitive on the evidence token", () => {
    expect(resolveGeographyAlias("BEIJING", ["China"])).toBe("China");
    expect(resolveGeographyAlias("  beijing  ", ["China"])).toBe("China");
  });

  it("returns null when the canonical target is absent from settings (no fabrication)", () => {
    // "Beijing" maps to "China", but the user hasn't opted into China — the
    // alias must NOT promote itself into the output.
    expect(resolveGeographyAlias("Beijing", ["US", "Colombia"])).toBeNull();
  });

  it("returns null when the token isn't in the alias map at all", () => {
    expect(resolveGeographyAlias("Atlantis", ["China", "US"])).toBeNull();
  });

  it("never emits the alias token itself, even when settings contains it", () => {
    // Hypothetical: settings happens to include "Beijing".  The function still
    // only emits the canonical mapping target, not the alias surface form —
    // because that surface form is not a canonical entry in our vocabulary.
    expect(resolveGeographyAlias("Beijing", ["Beijing"])).toBeNull();
  });

  it("returns null for empty / non-string tokens (defensive)", () => {
    expect(resolveGeographyAlias("", ["China"])).toBeNull();
    // @ts-expect-error — runtime defense
    expect(resolveGeographyAlias(null, ["China"])).toBeNull();
    // @ts-expect-error — runtime defense
    expect(resolveGeographyAlias(undefined, ["China"])).toBeNull();
  });

  it("returns null when settings vocabulary is empty", () => {
    expect(resolveGeographyAlias("Beijing", [])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { addCommaSeparated, addTraditional, addSocial } from "@/lib/settings-list-utils";

describe("addCommaSeparated", () => {
  describe("empty / all-whitespace input", () => {
    it.each(["", "   ", ",", ", , ", ",,"])("returns warning for %j", (draft) => {
      const result = addCommaSeparated(draft, [], "topic");
      expect(result).toEqual({
        nextItems: null,
        warning: "Enter at least one new topic.",
      });
    });

    it("uses the provided label in the warning", () => {
      expect(addCommaSeparated("", [], "keyword").warning).toBe("Enter at least one new keyword.");
      expect(addCommaSeparated("", [], "geography").warning).toBe(
        "Enter at least one new geography."
      );
    });
  });

  describe("new items", () => {
    it("adds a single new item silently", () => {
      const result = addCommaSeparated("OFAC", [], "keyword");
      expect(result).toEqual({ nextItems: ["OFAC"], warning: null });
    });

    it("adds multiple new items silently", () => {
      const result = addCommaSeparated("OFAC, sanctions, bilateral", [], "keyword");
      expect(result).toEqual({ nextItems: ["OFAC", "sanctions", "bilateral"], warning: null });
    });

    it("trims outer whitespace from each segment", () => {
      const result = addCommaSeparated("  topic1 , topic2  ", [], "topic");
      expect(result).toEqual({ nextItems: ["topic1", "topic2"], warning: null });
    });

    it("preserves inner spaces within a segment", () => {
      const result = addCommaSeparated("New York, Los Angeles", [], "geography");
      expect(result).toEqual({ nextItems: ["New York", "Los Angeles"], warning: null });
    });

    it("appends to existing items", () => {
      const result = addCommaSeparated("C", ["A", "B"], "topic");
      expect(result.nextItems).toEqual(["A", "B", "C"]);
    });
  });

  describe("all duplicates", () => {
    it("returns warning when single item already exists", () => {
      const result = addCommaSeparated("OFAC", ["OFAC"], "keyword");
      expect(result).toEqual({ nextItems: null, warning: "That's already on your list." });
    });

    it("is case-insensitive — lower matches upper stored", () => {
      const result = addCommaSeparated("ofac", ["OFAC"], "keyword");
      expect(result).toEqual({ nextItems: null, warning: "That's already on your list." });
    });

    it("is case-insensitive — upper matches lower stored", () => {
      const result = addCommaSeparated("US", ["us"], "geography");
      expect(result).toEqual({ nextItems: null, warning: "That's already on your list." });
    });

    it("returns warning for all-dupe batch", () => {
      const result = addCommaSeparated("OFAC, sanctions", ["OFAC", "sanctions"], "keyword");
      expect(result).toEqual({ nextItems: null, warning: "That's already on your list." });
    });

    it("treats intra-batch duplicate as a dupe (all dropped)", () => {
      const result = addCommaSeparated("OFAC, ofac", [], "keyword");
      expect(result.nextItems).toEqual(["OFAC"]);
      expect(result.warning).toBe(
        "Some of those were already on your list. We added the rest."
      );
    });
  });

  describe("mixed new and duplicates", () => {
    it("adds new items and warns about dupes", () => {
      const result = addCommaSeparated("OFAC, bilateral", ["OFAC"], "keyword");
      expect(result.nextItems).toEqual(["OFAC", "bilateral"]);
      expect(result.warning).toBe(
        "Some of those were already on your list. We added the rest."
      );
    });

    it("preserves existing items in order", () => {
      const result = addCommaSeparated("new-item, OFAC", ["OFAC", "sanctions"], "keyword");
      expect(result.nextItems).toEqual(["OFAC", "sanctions", "new-item"]);
      expect(result.warning).toBe(
        "Some of those were already on your list. We added the rest."
      );
    });

    it("does not change stored casing of existing items", () => {
      const result = addCommaSeparated("ofac, new-item", ["OFAC"], "keyword");
      expect(result.nextItems).toEqual(["OFAC", "new-item"]);
    });
  });
});

describe("addTraditional", () => {
  it("returns warning for empty string", () => {
    expect(addTraditional("", [])).toEqual({ nextItems: null, warning: "Enter an outlet." });
  });

  it("returns warning for whitespace-only", () => {
    expect(addTraditional("   ", [])).toEqual({ nextItems: null, warning: "Enter an outlet." });
  });

  it("returns warning for case-insensitive duplicate", () => {
    expect(addTraditional("Reuters", ["reuters"])).toEqual({
      nextItems: null,
      warning: "That's already on your list.",
    });
  });

  it("adds a new outlet", () => {
    expect(addTraditional("Reuters", [])).toEqual({ nextItems: ["Reuters"], warning: null });
  });

  it("trims outer whitespace before checking/adding", () => {
    expect(addTraditional("  Reuters  ", [])).toEqual({
      nextItems: ["Reuters"],
      warning: null,
    });
  });

  it("preserves inner spaces in outlet name", () => {
    expect(addTraditional("El Tiempo", [])).toEqual({ nextItems: ["El Tiempo"], warning: null });
  });
});

describe("addSocial", () => {
  it("returns warning when missing @ prefix", () => {
    expect(addSocial("latamwatcher", [])).toEqual({
      nextItems: null,
      warning: "Handles must start with @.",
    });
  });

  it("returns warning for empty string", () => {
    expect(addSocial("", [])).toEqual({
      nextItems: null,
      warning: "Handles must start with @.",
    });
  });

  it("returns warning for @ only", () => {
    expect(addSocial("@", [])).toEqual({
      nextItems: null,
      warning: "Enter a handle after @.",
    });
  });

  it("returns warning for @ with only whitespace body", () => {
    expect(addSocial("@   ", [])).toEqual({
      nextItems: null,
      warning: "Enter a handle after @.",
    });
  });

  it("adds a valid handle", () => {
    expect(addSocial("@latamwatcher", [])).toEqual({
      nextItems: ["@latamwatcher"],
      warning: null,
    });
  });

  it("trims outer whitespace from the whole draft", () => {
    expect(addSocial("  @latamwatcher  ", [])).toEqual({
      nextItems: ["@latamwatcher"],
      warning: null,
    });
  });

  it("normalizes handle by trimming body whitespace", () => {
    expect(addSocial("@ latamwatcher", [])).toEqual({
      nextItems: ["@latamwatcher"],
      warning: null,
    });
  });

  it("trims trailing whitespace from body", () => {
    expect(addSocial("@latamwatcher  ", [])).toEqual({
      nextItems: ["@latamwatcher"],
      warning: null,
    });
  });

  it("returns warning for case-insensitive duplicate", () => {
    expect(addSocial("@LatamWatcher", ["@latamwatcher"])).toEqual({
      nextItems: null,
      warning: "That's already on your list.",
    });
  });

  it("appends to existing social handles", () => {
    const result = addSocial("@newhandle", ["@latamwatcher"]);
    expect(result.nextItems).toEqual(["@latamwatcher", "@newhandle"]);
    expect(result.warning).toBeNull();
  });
});

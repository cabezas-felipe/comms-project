// Focused tests for the shared deterministic geo-lexical matcher. Beat-fit
// (Stage 2) and the recall stage (Slice 2) both depend on this surface, so the
// canonical / synonym / alias paths are pinned here independently of the scorer
// math.

import test from "node:test";
import assert from "node:assert/strict";

import {
  geoTextMatches,
  itemMentionsConfiguredGeography,
} from "./geo-lexical-match.mjs";

test("geoTextMatches: canonical name 'Colombia' matches configured 'Colombia'", () => {
  assert.ok(
    geoTextMatches("Colombia presidential candidate enters the race", "Colombia", ["Colombia"])
  );
});

test("geoTextMatches: demonym 'Colombians' matches configured 'Colombia' via synonym parity", () => {
  // "Colombians head to the polls…" must lift the geo signal even though the
  // canonical token "Colombia\\b" would not match the pluralized demonym.
  assert.ok(
    geoTextMatches("Colombians head to the polls this weekend", "Colombia", ["Colombia"])
  );
});

test("geoTextMatches: unrelated geo text does not match configured Colombia or Kenya", () => {
  const text = "Norwegian fisheries reported a record salmon harvest this quarter";
  assert.equal(geoTextMatches(text, "Colombia", ["Colombia", "Kenya"]), false);
  assert.equal(geoTextMatches(text, "Kenya", ["Colombia", "Kenya"]), false);
});

test("geoTextMatches: US synonym 'U.S.' matches despite trailing period", () => {
  assert.ok(geoTextMatches("The U.S. announced new measures", "US", ["US"]));
});

test("geoTextMatches: alias 'Bogotá' matches configured 'Colombia' (settings-gated)", () => {
  assert.ok(geoTextMatches("Officials met in Bogotá today", "Colombia", ["Colombia"]));
  // Alias path stays gated on the configured list: Beijing must not match
  // Colombia.
  assert.equal(geoTextMatches("Officials met in Beijing", "Colombia", ["Colombia"]), false);
});

test("itemMentionsConfiguredGeography: returns the first configured geo that matches", () => {
  assert.equal(
    itemMentionsConfiguredGeography("Colombians head to the polls", ["Colombia", "Kenya"]),
    "Colombia"
  );
});

test("itemMentionsConfiguredGeography: returns null when no configured geo is mentioned", () => {
  assert.equal(
    itemMentionsConfiguredGeography("Norwegian salmon harvest", ["Colombia", "Kenya"]),
    null
  );
  assert.equal(itemMentionsConfiguredGeography("Colombia news", []), null);
});

test("itemMentionsConfiguredGeography: preserves configured iteration order (first match wins)", () => {
  // Text mentions both; the geo listed first in settings should be returned.
  assert.equal(
    itemMentionsConfiguredGeography("Colombia and the U.S. signed an accord", ["US", "Colombia"]),
    "US"
  );
  assert.equal(
    itemMentionsConfiguredGeography("Colombia and the U.S. signed an accord", ["Colombia", "US"]),
    "Colombia"
  );
});

// Phase 6: Dynamic header pill filters for the Dashboard.
//
// Locked decisions encoded here:
//   - Section order: Topics → Keywords → Geographies (rendered after the "All" pill).
//   - Sections derive from the CURRENT payload's stories — not a static enum.
//   - Empty sections are hidden by the consumer (we just return the empty array).
//   - Sorting inside each section: alphabetical, locale-aware.
//   - Keyword source is `story.tags.keywords` ONLY (no free-text inference).
//   - Topic/Geography sections fall back to the canonical `story.topic` and
//     `story.geographies` fields when `story.tags` is absent (legacy/fixture data).
//   - Selection: multi-select within a section (OR), AND across sections.
//   - "All" pill = no selection in any section.

import type { Story } from "@/data/stories";

export interface TagSections {
  topics: string[];
  keywords: string[];
  geographies: string[];
}

export interface TagSelection {
  topics: ReadonlySet<string>;
  keywords: ReadonlySet<string>;
  geographies: ReadonlySet<string>;
}

/** Resolve the topics set for a story (preferring tags, falling back to topic). */
function topicsOf(story: Story): string[] {
  if (story.tags?.topics && story.tags.topics.length > 0) return story.tags.topics;
  return story.topic ? [story.topic] : [];
}

/** Resolve the keywords set for a story (tags only — never inferred from text). */
function keywordsOf(story: Story): string[] {
  return story.tags?.keywords ?? [];
}

/**
 * Build up to 2 human-readable labels for the dashboard story card's scan row.
 * Mirrors the header-pill vocabulary (topics → keywords) but omits geographies.
 *
 * Priority — first match wins, max 2 strings:
 *   1. Two topics    → [T[0], T[1]]
 *   2. Two keywords  → [K[0], K[1]]
 *   3. Topic + kw    → [T[0], K[0]]  (fixed section order: topic left, keyword right)
 *   4. Single topic  → [T[0]]
 *   5. Single kw     → [K[0]]
 *
 * Within a section, values are deduped and sorted A→Z (locale-aware) — same
 * order used by `aggregateTagSections`.
 */
export function storyScanLabels(story: Story): string[] {
  const uniqSort = (values: string[]) =>
    [...new Set(values)].sort((a, b) => a.localeCompare(b));
  const T = uniqSort(topicsOf(story));
  const K = uniqSort(keywordsOf(story));
  if (T.length >= 2) return [T[0], T[1]];
  if (K.length >= 2) return [K[0], K[1]];
  if (T.length >= 1 && K.length >= 1) return [T[0], K[0]];
  if (T.length >= 1) return [T[0]];
  if (K.length >= 1) return [K[0]];
  return [];
}

/** Resolve the geographies set for a story (preferring tags, falling back to geographies). */
function geographiesOf(story: Story): string[] {
  if (story.tags?.geographies && story.tags.geographies.length > 0) return story.tags.geographies;
  return story.geographies ?? [];
}

/**
 * Aggregate distinct tags across all stories into the three header-pill
 * sections, sorted alphabetically.  Empty arrays signal an empty section
 * (the dashboard hides those entirely).
 */
export function aggregateTagSections(stories: Story[]): TagSections {
  const topics = new Set<string>();
  const keywords = new Set<string>();
  const geographies = new Set<string>();
  for (const s of stories ?? []) {
    for (const t of topicsOf(s)) topics.add(t);
    for (const k of keywordsOf(s)) keywords.add(k);
    for (const g of geographiesOf(s)) geographies.add(g);
  }
  const sortAlpha = (arr: string[]) => arr.slice().sort((a, b) => a.localeCompare(b));
  return {
    topics: sortAlpha([...topics]),
    keywords: sortAlpha([...keywords]),
    geographies: sortAlpha([...geographies]),
  };
}

/**
 * Apply OR-within-section / AND-across-section semantics.  A story passes when:
 *   - if any topics are selected, the story has ≥1 of them, AND
 *   - if any keywords are selected, the story has ≥1 of them, AND
 *   - if any geographies are selected, the story has ≥1 of them.
 * Empty selection on any axis = no constraint on that axis.
 */
export function storyMatchesSelection(story: Story, selection: TagSelection): boolean {
  if (selection.topics.size > 0) {
    const t = topicsOf(story);
    if (!t.some((x) => selection.topics.has(x))) return false;
  }
  if (selection.keywords.size > 0) {
    const k = keywordsOf(story);
    if (!k.some((x) => selection.keywords.has(x))) return false;
  }
  if (selection.geographies.size > 0) {
    const g = geographiesOf(story);
    if (!g.some((x) => selection.geographies.has(x))) return false;
  }
  return true;
}

/** Returns true when the user has nothing selected — the "All" pill is active. */
export function isEmptySelection(selection: TagSelection): boolean {
  return (
    selection.topics.size === 0 &&
    selection.keywords.size === 0 &&
    selection.geographies.size === 0
  );
}

/** Toggle a single tag in/out of an existing Set immutably. */
export function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

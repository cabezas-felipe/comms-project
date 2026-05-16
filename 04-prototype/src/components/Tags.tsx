// Phase 6 — tag rendering is settings-vocabulary-only.
//
// The chip components no longer accept the legacy `Topic` / `Geography`
// enum types from `data/stories.ts`; in production the values flow through
// from `story.tags.{topics,geographies}` which are open string arrays
// (canonical settings spelling preserved).  Open-string typing also lets
// non-canonical labels surfaced by the Phase 3 geography alias map (e.g.
// "China", "Latin America") render without a translation step.  Empty
// arrays render nothing — callers are expected to suppress wrapping rows
// when both axes are empty so the UI doesn't show an orphan divider.

/**
 * Render a single canonical topic chip.  Renders `null` for empty/missing
 * input so callers can compose chip rows without separate visibility checks.
 */
export function TopicTag({ topic }: { topic?: string }) {
  if (typeof topic !== "string" || topic.trim().length === 0) return null;
  return (
    <span className="eyebrow rounded-sm border border-rule/50 bg-background px-1.5 py-0.5">
      {topic}
    </span>
  );
}

// Two-letter mnemonic for the (formerly) canonical pair so the existing US/CO
// monogram styling keeps working.  For any other settings-vocabulary geo
// (e.g. "China", "Latin America"), we render the label uppercased — same
// monospaced-monogram aesthetic without forcing every label into 2 chars.
function geoDisplayLabel(geo: string): string {
  const trimmed = geo.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "us" || lower === "united states") return "US";
  if (lower === "colombia") return "CO";
  return trimmed.toUpperCase();
}

export function GeoTag({ geo }: { geo: string }) {
  const label = geoDisplayLabel(geo);
  if (!label) return null;
  return (
    <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
  );
}

export function GeoStrip({ geographies }: { geographies: string[] }) {
  const cleaned = (geographies ?? []).filter(
    (g) => typeof g === "string" && g.trim().length > 0
  );
  if (cleaned.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      {cleaned.map((g, i) => (
        <span key={g} className="flex items-center gap-1.5">
          <GeoTag geo={g} />
          {i < cleaned.length - 1 && (
            <span className="text-muted-foreground/40" aria-hidden="true">·</span>
          )}
        </span>
      ))}
    </div>
  );
}

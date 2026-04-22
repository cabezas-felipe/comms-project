

# Build plan — Tempo (converged prototype)

Locking the converged design with **Tempo** as the product name. Everything from the previously approved plan stands; this document is the build spec.

---

## Brand lock

- **Product name:** `Tempo`
- **Tagline (persistent in masthead):** *the news, in tempo · for communications professionals*
- **Onboarding CTA:** `Set the tempo →`
- **Empty state:** *"Steady tempo. Nothing new across your beat."*
- **Settings value-prop line:** *"The cleaner your beat, the steadier your tempo."*
- **"Quiet by design"** retires as a tagline phrase but its *spirit* (uncluttered, centered, focused) governs every layout decision.

---

## Scope of this build

Two-phase build, single PR's worth of work:

### Phase 1 — Brand + structure
1. Rename masthead to `Tempo` with persistent mono-muted tagline.
2. Rebuild header nav to **Feed · Settings · Archive**, plus a cog icon redundant with Settings.
3. Move existing `SignalRadar`, `EvidenceDesk`, `AnalystBriefing`, `Directions` pages under `src/pages/archive/`. Add `ArchiveIndex.tsx`. Redirect `/d/*` and `/directions` to their `/archive/*` equivalents.
4. New routes: `/onboarding`, `/dashboard`, `/settings`, `/archive`, `/archive/signal-radar`, `/archive/evidence-desk`, `/archive/analyst-briefing`. `/` redirects to `/onboarding`.
5. Thin top banner on every archive page: *"Earlier exploration — not the converged design. Back to Feed →"*

### Phase 2 — Converged surfaces
6. **Onboarding** — single centered column. Eyebrow `For communications professionals`. Hero *"Stop refreshing twelve tabs to find what actually moved."* Type/Voice toggle (Type selected by default). Both modes show *example* answers, not instructions. Plain two-line "We keep / We don't keep" privacy note (no shield icons). CTA `Set the tempo →`.
7. **Dashboard** — three zones (header / feed / on-demand source rail). Headline reflects actual state with no quotas: e.g. `2 narratives rising · 2 steady · 1 falling`, `All steady`, `1 narrative rising`. Pill row for topics + geos. Cards show status row (`↑ Rising · Diplomatic relations · updated 14m ago`), title, takeaway, activity bar with **only `updated Xm ago`** to its right. Click expands inline (Summary · Why this matters · What changed · Key Sources max 5 · Was this useful?). Trend coloring: rising=ember, steady=ink, falling=muted with `↓` glyph.
8. **Source Reader** — right rail (~480px) that mounts only when a source is clicked. Renders the **full article in-app** (outlet glyph, byline, timestamp, serif body at ~62ch, close button, "Back to story" footer). Feed spans full width when rail is closed; CSS grid transition, no jump.
9. **Settings** — eyebrow `Your scope`, hero *"What you're monitoring."* Inconspicuous value-prop line *"The cleaner your beat, the steadier your tempo."* Sections: Topics, Keywords, Geographies, Sources. Sources section split into `Traditional outlets` (■ glyph) vs `Social accounts` (◯ glyph) tabs. Clicking any source chip opens the same Source Reader rail.
10. **States** — reuse `StateBlocks` minimal variant: empty (*"Steady tempo. Nothing new across your beat."*), loading (5 card skeletons), error (*"We couldn't reach your sources. Retrying in 60s."* + retry).

---

## Technical changes

### Files to create
- `src/components/SourceReader.tsx` — right-rail full-article reader, controlled by `activeSourceId` state lifted into Dashboard and Settings.
- `src/pages/archive/ArchiveIndex.tsx` — index of the three earlier prototypes with original thesis text.

### Files to edit
- `src/components/AppHeader.tsx` — rename masthead, add tagline line, swap nav to `Feed · Settings · Archive`, add cog.
- `src/pages/Onboarding.tsx` — new copy, type/voice example content, plain privacy note, new CTA.
- `src/pages/Dashboard.tsx` — new headline logic (no quotas), pill row, expandable cards, activity bar with only `updated Xm ago`, integration with `SourceReader`.
- `src/pages/Settings.tsx` — eyebrow + hero + value-prop line, `Traditional` vs `Social` tabs, source-chip click opens reader.
- `src/data/stories.ts` — extend `Source` with `kind: "traditional" | "social"`, `weight: number`, `byline?: string`, `headline: string`, `body: string[]` (2–3 paragraphs each). Add 1–2 `@handle` social sources across the existing 5 stories.
- `src/lib/derive.ts` — rename `momentum` → `activityScore`; trend stays `rising | steady | falling`; add `keySources(story, n=5)` ranked by `weight` then earliest publish.
- `src/App.tsx` — new routes, redirects from old `/d/*` and `/directions`, root → `/onboarding`.

### Files to move
- `src/pages/SignalRadar.tsx` → `src/pages/archive/SignalRadar.tsx`
- `src/pages/EvidenceDesk.tsx` → `src/pages/archive/EvidenceDesk.tsx`
- `src/pages/AnalystBriefing.tsx` → `src/pages/archive/AnalystBriefing.tsx`
- `src/pages/Directions.tsx` → `src/pages/archive/Directions.tsx`
- Each gets a thin "Earlier exploration" banner at the top.

### Files untouched
- `index.html` `<title>` updates to `Tempo · the news, in tempo for comms`. Meta description updates to match. Everything else in `src/components/ui/*`, `tailwind.config.ts`, `index.css` design tokens stay as-is — Tempo inherits the existing ember/ink palette and Fraunces/Inter pairing.

---

## Two-click guarantee verification

| From | To | Clicks |
|---|---|---|
| Onboarding | Feed | 1 (CTA) |
| Feed | Settings | 1 (cog or text) |
| Settings | Feed | 1 (header) |
| Anywhere | Full source article | 2 (open story → click source) |
| Anywhere | Archive prototype | 2 (Archive → prototype) |

---

## Out of scope for this build

- No backend, no auth, no persistence (scope state lives in component state for the prototype).
- No fast-mode toggle yet — Tempo's name accommodates it for the next iteration, but cadence stays hourly in v0 copy and behavior.
- No new ui/* primitives — everything composes from existing shadcn pieces.


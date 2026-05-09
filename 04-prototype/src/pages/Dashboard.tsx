import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { STORIES, Source, Story } from "@/data/stories";
import { deriveSignals } from "@/lib/derive";
import StoryCard from "@/components/StoryCard";
import SourceReader from "@/components/SourceReader";
import { EmptyState, ErrorState } from "@/components/StateBlocks";
import {
  trackDashboardViewed,
  trackSourceOpenError,
  trackSourceOpened,
  trackStoryExpanded,
} from "@/lib/analytics";
import { bootstrapDashboard, fetchDashboardWithMeta } from "@/lib/api";
import {
  aggregateTagSections,
  isEmptySelection,
  storyMatchesSelection,
  toggleInSet,
  type TagSelection,
} from "@/lib/dashboard-filters";
import { type DashboardSelectionMeta, type StoryDto } from "@tempo/contracts";
import { notifyError } from "@/lib/notify";

// Phase 2: minimal status badge surfacing source-selection metadata from the
// API.  Renders nothing when there's nothing meaningful to say (strict mode +
// no unmatched + non-empty stories).  Visual treatment intentionally compact —
// the dashboard's information architecture is unchanged.
function SelectionStatusCue({
  meta,
  hasStories,
}: {
  meta: DashboardSelectionMeta | null;
  hasStories: boolean;
}) {
  if (!meta) return null;

  const messages: string[] = [];
  if (meta.sourceFallbackUsed) {
    const reason = meta.sourceFallbackReason ?? "no match";
    messages.push(
      reason === "no_selected_sources"
        ? "Showing fallback sources — pick sources in Settings to personalize."
        : reason === "all_unavailable_connectors"
          ? "Selected sources have no connector yet — showing fallback baseline."
          : "No selected sources matched the manifest — showing fallback baseline."
    );
  }
  const unmatched = meta.unmatchedSelectedSources ?? [];
  if (unmatched.length > 0 && !meta.sourceFallbackUsed) {
    messages.push(`${unmatched.length} selected source${unmatched.length === 1 ? "" : "s"} unavailable: ${unmatched.join(", ")}`);
  }
  if (
    !meta.sourceFallbackUsed &&
    !hasStories &&
    typeof meta.relevantItemCount === "number" &&
    meta.relevantItemCount === 0 &&
    (meta.matchedSourceCount ?? 0) > 0
  ) {
    messages.push("No stories match your topics or keywords in the last 24 hours.");
  }

  if (messages.length === 0) return null;
  return (
    <div className="px-6 py-2 border-b border-rule/60">
      {messages.map((m, i) => (
        <p
          key={i}
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
        >
          {m}
        </p>
      ))}
    </div>
  );
}

function dtoToStory(dto: StoryDto): Story {
  return {
    id: dto.id,
    title: dto.title,
    geographies: dto.geographies,
    topic: dto.topic,
    takeaway: dto.takeaway,
    summary: dto.summary,
    whyItMatters: dto.whyItMatters,
    whatChanged: dto.whatChanged,
    priority: dto.priority,
    outletCount: dto.outletCount,
    sources: dto.sources.map((s) => ({
      id: s.id,
      outlet: s.outlet,
      byline: s.byline,
      kind: s.kind,
      weight: s.weight,
      url: s.url,
      minutesAgo: s.minutesAgo,
      headline: s.headline,
      body: s.body,
    })),
    tags: dto.tags
      ? {
          topics: [...dto.tags.topics],
          keywords: [...dto.tags.keywords],
          geographies: [...dto.tags.geographies],
        }
      : undefined,
  };
}

export default function Dashboard() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const emptyMode = searchParams.get("empty") === "1";

  // Phase 5: bootstrap is reserved for two entry surfaces only — Landing →
  // Dashboard for recognized users, and Onboarding → Dashboard post-submit.
  // Both navigate with `state: { bootstrap: true }`.  Settings, in-app links,
  // browser back/forward, and direct URL loads do NOT carry this flag and use
  // the cheaper GET path.
  const useBootstrap = (location.state as { bootstrap?: boolean } | null)?.bootstrap === true;

  // Phase 6: dynamic, multi-select header pill state (one Set per section).
  // Empty sets across all three sections = "All" (no filters applied).
  const [selectedTopics, setSelectedTopics] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKeywords, setSelectedKeywords] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedGeographies, setSelectedGeographies] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [stories, setStories] = useState<Story[]>(emptyMode ? [] : STORIES);
  const [isLoading, setIsLoading] = useState(!emptyMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectionMeta, setSelectionMeta] = useState<DashboardSelectionMeta | null>(null);

  const tagSections = useMemo(() => aggregateTagSections(stories), [stories]);
  const tagSelection = useMemo<TagSelection>(
    () => ({ topics: selectedTopics, keywords: selectedKeywords, geographies: selectedGeographies }),
    [selectedTopics, selectedKeywords, selectedGeographies]
  );
  const allActive = isEmptySelection(tagSelection);

  const filtered = useMemo(
    () =>
      stories
        .filter((s) => storyMatchesSelection(s, tagSelection))
        .map((s) => ({ story: s, sig: deriveSignals(s) })),
    [stories, tagSelection]
  );

  const counts = useMemo(() => {
    const out = { rising: 0, steady: 0, falling: 0 };
    filtered.forEach(({ sig }) => (out[sig.trend] += 1));
    return out;
  }, [filtered]);

  const headline = useMemo(() => buildHeadline(counts), [counts]);

  const activeSourcePair = useMemo(
    () => (activeSourceId ? findSourceInStories(stories, activeSourceId) : null),
    [stories, activeSourceId]
  );
  const activeSource: Source | null = activeSourcePair?.source ?? null;
  const activeSourceStory: Story | null = activeSourcePair?.story ?? null;

  const railOpen = !!activeSource;

  useEffect(() => {
    trackDashboardViewed();
  }, []);

  useEffect(() => {
    if (expandedId) trackStoryExpanded(expandedId);
  }, [expandedId]);

  useEffect(() => {
    if (emptyMode) return;
    let canceled = false;
    setIsLoading(true);

    // Phase 5: bootstrap path runs the (potentially expensive) refresh check
    // server-side and falls back to a fresh snapshot when ≤ 60 min old.  GET
    // path stays cheap and is used for every other dashboard load.
    const loader = useBootstrap
      ? bootstrapDashboard().then(({ payload, selection }) => ({ payload, selection }))
      : fetchDashboardWithMeta();

    loader
      .then(({ payload, selection }) => {
        if (canceled) return;
        setStories(payload.stories.map(dtoToStory));
        setSelectionMeta(selection);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (canceled) return;
        const message = error instanceof Error ? error.message : "Failed to load dashboard data.";
        setLoadError(message);
        trackSourceOpenError({ message, code: "dashboard_payload_load_failed" });
        notifyError("We couldn't refresh stories. Showing cached data.");
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [emptyMode, useBootstrap]);

  const handleReset = () => {
    setSelectedTopics(new Set());
    setSelectedKeywords(new Set());
    setSelectedGeographies(new Set());
  };

  const toggleTopic = (t: string) => setSelectedTopics((prev) => toggleInSet(prev, t));
  const toggleKeyword = (k: string) => setSelectedKeywords((prev) => toggleInSet(prev, k));
  const toggleGeography = (g: string) => setSelectedGeographies((prev) => toggleInSet(prev, g));

  const handleOpenSource = (storyId: string, sourceId: string) => {
    trackSourceOpened(storyId, sourceId);
    setActiveSourceId(sourceId);
  };

  return (
    <>
      {/* Layout shell — pushes feed on lg+ when source rail is open */}
      <div
        className={`mx-auto grid max-w-[1400px] transition-[grid-template-columns] duration-300 ease-editorial ${
          railOpen ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_480px]" : "grid-cols-1"
        }`}
      >
        <section className="min-w-0">
          {/* Header zone */}
          <div className="border-b border-rule/60 px-6 py-7">
            <h1 className="font-display text-[32px] font-semibold leading-tight tracking-tight">
              {headline}
            </h1>
            {isLoading && (
              <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Refreshing stories…
              </p>
            )}

            {/* Pill row — Phase 6: dynamic sections derived from current
                payload's stories.  Order: All → Topics → Keywords → Geographies.
                Sections with zero tags are hidden entirely; separators only
                appear between non-empty sections. */}
            <div
              className="mt-5 flex flex-wrap items-center gap-1.5"
              data-testid="header-pill-row"
            >
              <Pill active={allActive} onClick={handleReset} testId="pill-all">
                All
              </Pill>
              {tagSections.topics.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {tagSections.topics.map((t) => (
                    <Pill
                      key={`topic-${t}`}
                      active={selectedTopics.has(t)}
                      onClick={() => toggleTopic(t)}
                      testId={`pill-topic-${t}`}
                    >
                      {t}
                    </Pill>
                  ))}
                </>
              )}
              {tagSections.keywords.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {tagSections.keywords.map((k) => (
                    <Pill
                      key={`keyword-${k}`}
                      active={selectedKeywords.has(k)}
                      onClick={() => toggleKeyword(k)}
                      testId={`pill-keyword-${k}`}
                    >
                      {k}
                    </Pill>
                  ))}
                </>
              )}
              {tagSections.geographies.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {tagSections.geographies.map((g) => (
                    <Pill
                      key={`geo-${g}`}
                      active={selectedGeographies.has(g)}
                      onClick={() => toggleGeography(g)}
                      testId={`pill-geo-${g}`}
                    >
                      {g}
                    </Pill>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Selection status — Phase 2: small cues for fallback / unmatched / strict-empty */}
          <SelectionStatusCue meta={selectionMeta} hasStories={filtered.length > 0} />

          {/* Error banner — non-blocking, stories still show below */}
          {loadError && (
            <ErrorState variant="dense" onRetry={() => window.location.reload()} />
          )}

          {/* Feed zone */}
          {filtered.length === 0 ? (
            <EmptyState variant="dense" onRetry={handleReset} />
          ) : (
            <ul className="divide-y divide-rule/60">
              {filtered.map(({ story, sig }) => (
                <li key={story.id}>
                  <StoryCard
                    story={story}
                    sig={sig}
                    expanded={expandedId === story.id}
                    onToggle={() => setExpandedId(expandedId === story.id ? null : story.id)}
                    onOpenSource={(sourceId) => handleOpenSource(story.id, sourceId)}
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="px-6 py-8 text-center">
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Next refresh in ~38 min
            </p>
          </div>
        </section>

        {/* Desktop source reader rail (lg+) */}
        {railOpen && (
          <aside className="hidden lg:block">
            <div className="sticky top-16 h-[calc(100vh-4rem)]">
              <SourceReader
                source={activeSource}
                storyTitle={activeSourceStory?.title}
                onClose={() => setActiveSourceId(null)}
                onBack={() => setActiveSourceId(null)}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Mobile/tablet overlay (<lg) — slides in from the right */}
      <div
        onClick={() => setActiveSourceId(null)}
        className={`fixed inset-0 top-16 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-300 lg:hidden ${
          railOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!railOpen}
      />
      <aside
        className={`fixed right-0 top-16 z-50 h-[calc(100vh-4rem)] w-full max-w-[520px] transform shadow-paper transition-transform duration-300 ease-editorial lg:hidden ${
          railOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!railOpen}
      >
        <SourceReader
          source={activeSource}
          storyTitle={activeSourceStory?.title}
          onClose={() => setActiveSourceId(null)}
          onBack={() => setActiveSourceId(null)}
        />
      </aside>
    </>
  );
}

function findSourceInStories(
  stories: Story[],
  sourceId: string
): { story: Story; source: Source } | null {
  for (const story of stories) {
    const source = story.sources.find((s) => s.id === sourceId);
    if (source) return { story, source };
  }
  return null;
}

function buildHeadline(counts: { rising: number; steady: number; falling: number }): string {
  const total = counts.rising + counts.steady + counts.falling;
  if (total === 0) return "Steady tempo across your beat.";
  if (counts.rising === 0 && counts.falling === 0) return "All steady.";
  const parts: string[] = [];
  if (counts.rising > 0)
    parts.push(`${counts.rising} ${counts.rising === 1 ? "narrative" : "narratives"} rising`);
  if (counts.steady > 0) parts.push(`${counts.steady} steady`);
  if (counts.falling > 0) parts.push(`${counts.falling} falling`);
  return parts.join(" · ");
}

function Pill({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

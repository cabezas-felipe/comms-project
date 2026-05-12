import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Source, Story } from "@/data/stories";
import { deriveSignals } from "@/lib/derive";
import StoryCard from "@/components/StoryCard";
import SourceReader from "@/components/SourceReader";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateBlocks";
import {
  trackDashboardViewed,
  trackSourceOpenError,
  trackSourceOpened,
  trackStoryExpanded,
} from "@/lib/analytics";
import { bootstrapDashboard, fetchDashboardWithMeta } from "@/lib/api";
import { formatKeywordLabel } from "@/lib/format";
import {
  aggregateTagSections,
  isEmptySelection,
  storyMatchesSelection,
  toggleInSet,
  type TagSelection,
} from "@/lib/dashboard-filters";
import { type StoryDto } from "@tempo/contracts";
import { notifyError } from "@/lib/notify";
import { useRefreshContext } from "@/lib/refresh-context";

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
  const { recordSuccessfulRefresh, heartbeatResult } = useRefreshContext();
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
  // Stories are seeded empty — no static demo fallback. The dashboard renders
  // Loading/Empty/Error blocks until the backend supplies a payload.
  const [stories, setStories] = useState<Story[]>([]);
  const [isLoading, setIsLoading] = useState(!emptyMode);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(emptyMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

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
    setLoadError(null);

    // Phase 5: bootstrap path runs the (potentially expensive) refresh check
    // server-side and falls back to a fresh snapshot when ≤ 60 min old.  GET
    // path stays cheap and is used for every other dashboard load.
    const loader = useBootstrap
      ? bootstrapDashboard().then(({ payload, selection, refreshedAt }) => ({
          payload,
          selection,
          refreshedAt,
        }))
      : fetchDashboardWithMeta();

    loader
      .then((result) => {
        if (canceled) return;
        const { payload } = result;
        setStories(payload.stories.map(dtoToStory));
        setLoadError(null);
        setHasLoadedOnce(true);
        recordSuccessfulRefresh(result);
      })
      .catch((error: unknown) => {
        if (canceled) return;
        const message = error instanceof Error ? error.message : "Failed to load dashboard data.";
        setLoadError(message);
        trackSourceOpenError({ message, code: "dashboard_payload_load_failed" });
        // Only surface a toast when there's prior fresh data on screen — the
        // full-page error block already conveys the failure on first load.
        if (stories.length > 0) {
          notifyError("We couldn't refresh stories. Showing previous run.");
        }
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });
    return () => {
      canceled = true;
    };
    // `stories.length` intentionally excluded — only used to gate the toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyMode, useBootstrap, reloadCounter, recordSuccessfulRefresh]);

  // App-scope heartbeat (lib/refresh-heartbeat) drives the 60-minute refresh
  // attempt guarantee; here we just overlay its successful result onto the
  // currently-rendered stories so a long-lived dashboard view doesn't show
  // stale content even though the header timestamp moved forward.
  useEffect(() => {
    if (emptyMode || !heartbeatResult) return;
    setStories(heartbeatResult.payload.stories.map(dtoToStory));
    setLoadError(null);
    setHasLoadedOnce(true);
  }, [emptyMode, heartbeatResult]);

  const handleRetry = useCallback(() => {
    setReloadCounter((n) => n + 1);
  }, []);

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
                    // Display-only formatting: `k` is the canonical raw value
                    // used for key/testId/selection/filtering; only the pill's
                    // visible label is title-cased so lowercase settings
                    // keywords ("oil") look consistent next to canonical
                    // topics/geographies in the row.
                    <Pill
                      key={`keyword-${k}`}
                      active={selectedKeywords.has(k)}
                      onClick={() => toggleKeyword(k)}
                      testId={`pill-keyword-${k}`}
                    >
                      {formatKeywordLabel(k)}
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

          {/* Inline banner when a refresh failed but a previous run is on-screen */}
          {loadError && stories.length > 0 && (
            <ErrorState variant="dense" onRetry={handleRetry} />
          )}

          {/* Feed zone — distinguishes loading / fetch error / legitimate empty */}
          {(() => {
            // Initial load (or retry) with no on-screen data yet.
            if (isLoading && stories.length === 0) {
              return (
                <div data-testid="dashboard-loading">
                  <LoadingState variant="dense" />
                </div>
              );
            }
            // Fetch failed and we have nothing to show — full error block, retry only.
            if (loadError && stories.length === 0) {
              return (
                <div data-testid="dashboard-error">
                  <ErrorState variant="briefing" onRetry={handleRetry} />
                </div>
              );
            }
            // Backend returned 0 stories (legitimately empty after a successful fetch).
            if (!isLoading && !loadError && stories.length === 0 && hasLoadedOnce) {
              return (
                <div data-testid="dashboard-empty">
                  <EmptyState variant="briefing" />
                </div>
              );
            }
            // Stories present, but current filters knock the visible list to zero.
            if (filtered.length === 0) {
              return <EmptyState variant="dense" onRetry={handleReset} />;
            }
            return (
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
            );
          })()}

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

export function buildHeadline(counts: {
  rising: number;
  steady: number;
  falling: number;
}): string {
  const total = counts.rising + counts.steady + counts.falling;
  if (total === 0) return "Quiet for this view.";

  const order = ["rising", "steady", "falling"] as const;
  const parts: string[] = [];
  let isFirst = true;
  for (const state of order) {
    const n = counts[state];
    if (n === 0) continue;
    if (isFirst) {
      parts.push(`${n} ${n === 1 ? "narrative" : "narratives"} ${state}`);
      isFirst = false;
    } else {
      parts.push(`${n} ${state}`);
    }
  }
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

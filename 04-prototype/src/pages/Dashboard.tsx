import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { GEOGRAPHIES, Geography, STORIES, Source, Story, TOPICS, Topic } from "@/data/stories";
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
import { fetchDashboardPayload } from "@/lib/api";
import { type StoryDto } from "@tempo/contracts";
import { notifyError } from "@/lib/notify";

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
  };
}

type TopicFilter = Topic | "All";
type GeoFilter = Geography | "All";

export default function Dashboard() {
  const [searchParams] = useSearchParams();
  const emptyMode = searchParams.get("empty") === "1";

  const [topic, setTopic] = useState<TopicFilter>("All");
  const [geo, setGeo] = useState<GeoFilter>("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [stories, setStories] = useState<Story[]>(emptyMode ? [] : STORIES);
  const [isLoading, setIsLoading] = useState(!emptyMode);
  const [loadError, setLoadError] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      stories
        .filter(
          (s) =>
            (topic === "All" || s.topic === topic) &&
            (geo === "All" || s.geographies.includes(geo))
        )
        .map((s) => ({ story: s, sig: deriveSignals(s) })),
    [stories, topic, geo]
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
    fetchDashboardPayload()
      .then((payload) => {
        if (canceled) return;
        setStories(payload.stories.map(dtoToStory));
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
  }, [emptyMode]);

  const handleReset = () => {
    setTopic("All");
    setGeo("All");
  };

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

            {/* Pill row */}
            <div className="mt-5 flex flex-wrap items-center gap-1.5">
              <Pill active={topic === "All" && geo === "All"} onClick={handleReset}>
                All
              </Pill>
              <span className="mx-1 text-rule">·</span>
              {TOPICS.map((t) => (
                <Pill key={t} active={topic === t} onClick={() => setTopic(topic === t ? "All" : t)}>
                  {t}
                </Pill>
              ))}
              <span className="mx-1 text-rule">·</span>
              {GEOGRAPHIES.map((g) => (
                <Pill key={g} active={geo === g} onClick={() => setGeo(geo === g ? "All" : g)}>
                  {g}
                </Pill>
              ))}
            </div>
          </div>

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
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
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

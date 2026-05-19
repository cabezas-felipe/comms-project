import { Story } from "@/data/stories";
import { trackSourceOpened } from "@/lib/analytics";
import { GeoStrip, TopicTag } from "./Tags";
import { timeAgo } from "@/lib/format";
import { ArrowUpRight, X } from "lucide-react";

interface Props {
  story: Story;
  onClose: () => void;
}

export default function StoryDetail({ story, onClose }: Props) {
  // Phase 6: chip row is sourced from `story.tags` (settings vocabulary).
  // The root `story.topic` / `story.geographies` fields are no longer
  // consulted for any UI label — Phase 1 already neutralized them for
  // pills/scan-row; this completes the migration in the story-detail view.
  // The first canonical topic tag (settings spelling) wins for the topic
  // chip; the geo strip uses the full tag set so multi-geo stories
  // ("US · Colombia · China") render cleanly without alias drift.
  //
  // Empty-state rule: when both axes have nothing, the chip row + divider
  // are suppressed entirely.  No orphan `|` separator with nothing on one
  // side; no empty box with no content.
  const topicTag = story.tags?.topics?.[0];
  const geoTags = story.tags?.geographies ?? [];
  const hasTopic = typeof topicTag === "string" && topicTag.length > 0;
  const hasGeos = geoTags.length > 0;
  const hasAnyTagChip = hasTopic || hasGeos;
  return (
    <aside className="fade-up flex h-full flex-col overflow-hidden bg-surface-raised">
      {/* header */}
      <div className="flex items-start justify-between gap-4 border-b border-rule/60 px-7 py-5">
        <div className="space-y-3">
          {hasAnyTagChip && (
            <div
              className="flex items-center gap-3"
              data-testid="story-detail-tag-row"
            >
              {hasTopic && <TopicTag topic={topicTag} />}
              {hasTopic && hasGeos && (
                <span className="text-rule" aria-hidden="true">|</span>
              )}
              {hasGeos && <GeoStrip geographies={geoTags} />}
            </div>
          )}
          <h2 className="font-display text-3xl font-semibold leading-[1.08] tracking-tight">
            {story.title}
          </h2>
          {/* Meta-story fields PR (Prompt 2): one-sentence contextual deck
              line under the title. Sourced from `story.subtitle` (clustering
              context, not the expanded narrative — that's `summary` below). */}
          <p
            className="text-[15px] leading-relaxed text-muted-foreground"
            data-testid="story-detail-subtitle"
          >
            {story.subtitle}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Close detail"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* body */}
      <div className="flex-1 space-y-7 overflow-y-auto px-7 py-6">
        <section>
          <h3 className="eyebrow mb-2">Summary</h3>
          <p className="text-[15px] leading-relaxed text-foreground/90">{story.summary}</p>
        </section>

        <section className="rounded-sm border border-ember/30 bg-ember-soft/40 p-4">
          <h3 className="eyebrow mb-1.5 text-ember">Why this matters</h3>
          <p className="text-[15px] leading-relaxed text-foreground/90">{story.whyItMatters}</p>
        </section>

        <section>
          <h3 className="eyebrow mb-2">What changed since last update</h3>
          <p className="text-[15px] leading-relaxed text-foreground/90">{story.whatChanged}</p>
        </section>

        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="eyebrow">Sources · {story.sources.length}</h3>
          </div>
          <ul className="divide-y divide-rule/50 border-y border-rule/50">
            {story.sources.map((s) => (
              <li key={s.id}>
                <a
                  href={s.url}
                  onClick={() => trackSourceOpened(story.id, s.id)}
                  className="group flex items-center justify-between py-3 transition-colors hover:bg-background"
                >
                  <div className="flex items-baseline gap-3">
                    <span className="font-display text-base font-medium text-foreground">
                      {s.outlet}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {timeAgo(s.minutesAgo)}
                    </span>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-60 transition-all group-hover:translate-x-0.5 group-hover:text-ember group-hover:opacity-100" />
                </a>
              </li>
            ))}
          </ul>
        </section>

      </div>
    </aside>
  );
}

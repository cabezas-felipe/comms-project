import { Story } from "@/data/stories";
import { GeoStrip, TopicTag } from "./Tags";
import { timeAgo } from "@/lib/format";
import { ArrowUpRight } from "lucide-react";

interface Props {
  story: Story;
  active: boolean;
  onSelect: () => void;
}

export default function StoryCard({ story, active, onSelect }: Props) {
  const isTop = story.priority === "top";
  return (
    <article
      onClick={onSelect}
      className={`group relative cursor-pointer border-b border-rule/60 px-6 py-6 transition-colors ${
        active ? "bg-ember-soft/40" : "hover:bg-surface"
      } ${isTop ? "ember-tick" : ""}`}
    >
      {/* meta row */}
      <div className="mb-3 flex items-center gap-3">
        <TopicTag topic={story.topic} />
        <span className="text-rule">|</span>
        <GeoStrip geographies={story.geographies} />
        <span className="text-rule">|</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {story.outletCount} outlets
        </span>
        {isTop && (
          <span className="ml-auto eyebrow text-ember">Priority</span>
        )}
      </div>

      {/* title */}
      <h3
        className={`font-display font-semibold leading-[1.15] tracking-tight ${
          isTop ? "text-2xl" : "text-xl"
        } ${active ? "text-foreground" : "text-foreground/95 group-hover:text-foreground"}`}
      >
        {story.title}
      </h3>

      {/* summary */}
      <p className="mt-2 max-w-[62ch] text-[15px] leading-relaxed text-muted-foreground">
        {story.summary}
      </p>

      {/* what changed */}
      <div className="mt-4 flex items-start gap-3 border-l-2 border-ember/70 pl-3">
        <span className="eyebrow text-ember whitespace-nowrap pt-0.5">What changed</span>
        <p className="text-sm text-foreground/85">{story.whatChanged}</p>
      </div>

      {/* sources preview */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {story.sources.slice(0, 3).map((s) => (
          <a
            key={s.outlet}
            href={s.url}
            onClick={(e) => e.stopPropagation()}
            className="group/src inline-flex items-center gap-1 text-[13px] text-foreground/80 underline-offset-4 hover:text-ember hover:underline"
          >
            <span className="font-medium">{s.outlet}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              · {timeAgo(s.minutesAgo)}
            </span>
            <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover/src:opacity-100" />
          </a>
        ))}
        {story.sources.length > 3 && (
          <span className="font-mono text-[11px] text-muted-foreground">
            +{story.sources.length - 3} more
          </span>
        )}
      </div>
    </article>
  );
}

import { Story } from "@/data/stories";
import { GeoStrip, TopicTag } from "./Tags";
import { timeAgo } from "@/lib/format";
import { ArrowUpRight, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";

interface Props {
  story: Story;
  onClose: () => void;
}

export default function StoryDetail({ story, onClose }: Props) {
  const [trust, setTrust] = useState<"up" | "down" | null>(null);

  const handleTrust = (v: "up" | "down") => {
    setTrust(v);
    toast.success(
      v === "up" ? "Marked useful — story will rank higher." : "Noted — we'll surface fewer like this."
    );
  };

  return (
    <aside className="fade-up flex h-full flex-col overflow-hidden bg-surface-raised">
      {/* header */}
      <div className="flex items-start justify-between gap-4 border-b border-rule/60 px-7 py-5">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <TopicTag topic={story.topic} />
            <span className="text-rule">|</span>
            <GeoStrip geographies={story.geographies} />
          </div>
          <h2 className="font-display text-3xl font-semibold leading-[1.08] tracking-tight">
            {story.title}
          </h2>
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
            <span className="font-mono text-[11px] text-muted-foreground">
              {story.outletCount} outlets total
            </span>
          </div>
          <ul className="divide-y divide-rule/50 border-y border-rule/50">
            {story.sources.map((s) => (
              <li key={s.outlet}>
                <a
                  href={s.url}
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

        <section className="border-t border-rule/60 pt-5">
          <h3 className="eyebrow mb-3">Was this useful?</h3>
          <div className="flex items-center gap-2">
            <Button
              variant={trust === "up" ? "default" : "outline"}
              size="sm"
              onClick={() => handleTrust("up")}
              className="gap-2"
            >
              <ThumbsUp className="h-3.5 w-3.5" />
              Useful
            </Button>
            <Button
              variant={trust === "down" ? "default" : "outline"}
              size="sm"
              onClick={() => handleTrust("down")}
              className="gap-2"
            >
              <ThumbsDown className="h-3.5 w-3.5" />
              Not useful
            </Button>
          </div>
        </section>
      </div>
    </aside>
  );
}

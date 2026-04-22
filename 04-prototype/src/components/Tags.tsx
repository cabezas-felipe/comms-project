import { Geography, Topic } from "@/data/stories";

export function TopicTag({ topic }: { topic: Topic }) {
  return (
    <span className="eyebrow rounded-sm border border-rule/50 bg-background px-1.5 py-0.5">
      {topic}
    </span>
  );
}

export function GeoTag({ geo }: { geo: Geography }) {
  return (
    <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {geo === "US" ? "US" : "CO"}
    </span>
  );
}

export function GeoStrip({ geographies }: { geographies: Geography[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {geographies.map((g, i) => (
        <span key={g} className="flex items-center gap-1.5">
          <GeoTag geo={g} />
          {i < geographies.length - 1 && (
            <span className="text-muted-foreground/40">·</span>
          )}
        </span>
      ))}
    </div>
  );
}

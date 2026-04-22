import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

const ARCHIVE = [
  {
    to: "/archive/signal-radar",
    num: "01",
    name: "Signal Radar",
    tag: "Minimal · design-forward",
    thesis:
      "A scan-first surface that ranks narratives by momentum and surfaces only what's moving — speed of recognition over depth.",
  },
  {
    to: "/archive/evidence-desk",
    num: "02",
    name: "Evidence Desk",
    tag: "Dense · information-forward",
    thesis:
      "A high-density ledger of clusters and their sources, optimized for analysts who want to verify what is happening now.",
  },
  {
    to: "/archive/analyst-briefing",
    num: "03",
    name: "Analyst Briefing",
    tag: "Recommendation · decision-forward",
    thesis:
      "A daily prepared brief that proposes a posture per cluster and asks the operator to accept or snooze each recommendation.",
  },
];

export default function ArchiveIndex() {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <header className="border-b border-rule/60 px-10 py-12">
        <div className="mx-auto max-w-[1100px]">
          <span className="eyebrow">Archive · earlier explorations</span>
          <h1 className="mt-2 font-display text-[40px] font-semibold leading-tight tracking-tight">
            Three directions we tried before Tempo.
          </h1>
          <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-muted-foreground">
            Each prototype renders the same five clusters but reorganizes hierarchy and interaction
            around a different primary user value. They informed the converged design — they are
            not the converged design.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-[1100px] px-10 py-10">
        <div className="grid gap-6 md:grid-cols-3">
          {ARCHIVE.map((d) => (
            <Link
              key={d.to}
              to={d.to}
              className="group flex flex-col rounded-sm border border-rule/60 bg-surface-raised p-6 transition-all hover:-translate-y-0.5 hover:border-foreground/40 hover:shadow-paper"
            >
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{d.num}</span>
              <h2 className="mt-2 font-display text-2xl font-semibold leading-tight">{d.name}</h2>
              <span className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ember">{d.tag}</span>
              <p className="mt-4 text-[14px] leading-relaxed text-foreground/85">{d.thesis}</p>
              <span className="mt-auto inline-flex items-center gap-1 pt-6 text-sm text-foreground group-hover:text-ember">
                Open prototype <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

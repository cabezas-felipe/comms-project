import { useEffect } from "react";
import { Source } from "@/data/stories";
import { timeAgo } from "@/lib/format";
import { X, ArrowLeft } from "lucide-react";

interface Props {
  source: Source | null;
  onClose: () => void;
  onBack?: () => void;
  /** label shown in the back-to-story footer */
  storyTitle?: string;
}

export default function SourceReader({ source, onClose, onBack, storyTitle }: Props) {
  // Esc to close
  useEffect(() => {
    if (!source) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [source, onClose]);

  if (!source) return null;

  const glyph = source.kind === "social" ? "◯" : "■";
  const kindLabel = source.kind === "social" ? "Social account" : "Traditional outlet";

  return (
    <aside
      className="fade-up flex h-full flex-col overflow-hidden border-l border-rule/60 bg-surface-raised"
      aria-label="Source reader"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-rule/60 px-7 py-5">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <span aria-hidden>{glyph}</span>
            <span>{kindLabel}</span>
          </div>
          <div className="font-display text-[20px] font-semibold leading-tight tracking-tight">
            {source.outlet}
          </div>
          {source.byline && (
            <div className="font-mono text-[11px] text-muted-foreground">
              {source.byline} · {timeAgo(source.minutesAgo)}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Close source reader"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Article */}
      <div className="flex-1 overflow-y-auto px-7 py-7">
        <article className="mx-auto max-w-[62ch]">
          <h1 className="font-display text-[28px] font-semibold leading-[1.15] tracking-tight">
            {source.headline}
          </h1>
          <div className="mt-6 space-y-5">
            {source.body.map((para, i) => (
              <p
                key={i}
                className="font-display text-[17px] leading-[1.7] text-foreground/90"
              >
                {para}
              </p>
            ))}
          </div>
          <p className="mt-8 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Excerpt rendered in Tempo · for monitoring purposes
          </p>
        </article>
      </div>

      {/* Footer */}
      {onBack && storyTitle && (
        <div className="border-t border-rule/60 px-7 py-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to story · <span className="truncate max-w-[40ch]">{storyTitle}</span>
          </button>
        </div>
      )}
    </aside>
  );
}

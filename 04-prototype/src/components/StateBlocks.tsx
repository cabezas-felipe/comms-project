import { AlertCircle, Inbox, Loader2 } from "lucide-react";

interface StateProps {
  variant: "minimal" | "dense" | "briefing";
  onRetry?: () => void;
}

/* ---------------- Loading ---------------- */
export function LoadingState({ variant }: StateProps) {
  if (variant === "minimal") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <div className="relative h-16 w-16">
          <span className="absolute inset-0 animate-ping rounded-full bg-ember/30" />
          <span className="absolute inset-3 rounded-full bg-ember" />
        </div>
        <span className="eyebrow">Sweeping signal</span>
      </div>
    );
  }
  if (variant === "dense") {
    return (
      <div className="divide-y divide-rule/50">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid grid-cols-[80px_1fr_120px] gap-4 px-6 py-4">
            <div className="h-4 animate-pulse rounded-sm bg-muted" />
            <div className="space-y-2">
              <div className="h-4 w-3/4 animate-pulse rounded-sm bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded-sm bg-muted/60" />
            </div>
            <div className="h-4 animate-pulse rounded-sm bg-muted" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="font-display text-lg text-muted-foreground">Composing briefing…</p>
    </div>
  );
}

/* ---------------- Empty ---------------- */
export function EmptyState({ variant, onRetry }: StateProps) {
  if (variant === "minimal") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
        <span className="eyebrow">Quiet</span>
        <p className="max-w-[28ch] font-display text-3xl leading-tight">
          No signal above threshold.
        </p>
        {onRetry && (
          <button onClick={onRetry} className="mt-3 text-sm text-ember hover:underline">
            Reset filters
          </button>
        )}
      </div>
    );
  }
  if (variant === "dense") {
    return (
      <div className="flex flex-col items-center gap-3 border-y border-rule/50 px-6 py-16 text-center">
        <Inbox className="h-5 w-5 text-muted-foreground" />
        <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          0 records · no sources match current scope
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded-sm border border-rule/60 px-3 py-1 text-xs hover:bg-secondary"
          >
            Clear filters
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <Inbox className="h-6 w-6 text-muted-foreground" />
      <p className="max-w-[36ch] font-display text-2xl leading-snug">
        No stories yet.
      </p>
      <p className="max-w-[44ch] text-sm text-muted-foreground">
        Your selected sources haven't published anything matching your topics in
        the last refresh window. We'll surface stories as soon as the next
        signal crosses threshold.
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded-sm border border-rule/60 px-3 py-1.5 text-sm hover:bg-secondary"
        >
          Refresh
        </button>
      )}
    </div>
  );
}

/* ---------------- Error ---------------- */
export function ErrorState({ variant, onRetry }: StateProps) {
  // Inline banner: refresh failed but a previous run is still on-screen.
  // Full-page (briefing/minimal): we have nothing to show.
  if (variant === "dense") {
    const inlineMsg = "Refresh failed — showing previous run.";
    return (
      <div className="border-y border-destructive/30 bg-destructive/5 px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="font-mono text-xs uppercase tracking-wider text-destructive">
              feed_error · {inlineMsg}
            </span>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="rounded-sm border border-destructive/40 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <AlertCircle className="h-6 w-6 text-destructive" />
      <p className="font-display text-xl">We couldn't load your stories.</p>
      <p className="max-w-[44ch] text-sm text-muted-foreground">
        The dashboard service didn't respond. Check your connection and try
        again — if this keeps happening, ping the team in #tempo-status.
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded-sm bg-foreground px-4 py-1.5 text-sm text-background hover:bg-foreground/90"
        >
          Try again
        </button>
      )}
    </div>
  );
}

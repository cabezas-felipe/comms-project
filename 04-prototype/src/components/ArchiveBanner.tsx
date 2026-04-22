import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

export default function ArchiveBanner() {
  return (
    <div className="border-b border-rule/60 bg-muted/40 px-6 py-2">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Earlier exploration · not the converged design
        </p>
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground hover:text-ember"
        >
          Back to Feed <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

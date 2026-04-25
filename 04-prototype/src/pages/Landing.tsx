import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { trackAuthCtaClicked, trackLandingViewed } from "@/lib/analytics";

export default function Landing() {
  const navigate = useNavigate();

  useEffect(() => {
    trackLandingViewed();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-paper">
      <div className="mx-auto flex min-h-screen max-w-[720px] flex-col px-6 py-12 lg:py-20">
        {/* Masthead */}
        <div className="mb-12 flex flex-col items-center text-center">
          <span className="font-display text-3xl font-semibold leading-none tracking-tight">
            Tempo
          </span>
          <span className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            The news, in tempo
          </span>
        </div>

        {/* Hero */}
        <div className="mb-12 text-center">
          <h1 className="font-display text-[40px] font-semibold leading-[1.05] tracking-tight">
            Stop refreshing twelve tabs to find what actually moved.
          </h1>
          <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            Tell Tempo what you watch. We cluster, dedupe, and source-check coverage so the news
            arrives in one calm place — however fast it moves.
          </p>
        </div>

        {/* Auth CTAs */}
        <div className="fade-up mx-auto w-full max-w-[420px] space-y-3">
          <Button
            type="button"
            size="lg"
            className="w-full gap-2 rounded-sm"
            onClick={() => { trackAuthCtaClicked("login"); navigate("/auth/login"); }}
          >
            Log in
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full rounded-sm border-rule/60"
            onClick={() => { trackAuthCtaClicked("signup"); navigate("/auth/signup"); }}
          >
            Sign up
          </Button>
          <p className="pt-2 text-center font-mono text-[11px] text-muted-foreground">
            No password. We&apos;ll send a magic link.
          </p>
        </div>
      </div>
    </div>
  );
}

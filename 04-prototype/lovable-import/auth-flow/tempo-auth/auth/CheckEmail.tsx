import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Mail, ArrowRight } from "lucide-react";

export default function CheckEmail() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = (params.get("mode") as "signup" | "login") ?? "login";
  const email = params.get("email") ?? "";
  const isSignup = mode === "signup";

  // Prototype: simulate clicking the magic link.
  // New users land in onboarding; returning users go straight to the dashboard.
  const handleSimulateClick = () => {
    navigate(isSignup ? "/onboarding" : "/dashboard");
  };

  return (
    <div className="min-h-screen bg-gradient-paper">
      <div className="mx-auto flex min-h-screen max-w-[560px] flex-col px-6 py-12 lg:py-20">
        {/* Masthead */}
        <div className="mb-12 flex flex-col items-center text-center">
          <span className="font-display text-3xl font-semibold leading-none tracking-tight">
            Tempo
          </span>
          <span className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            The news, in tempo
          </span>
        </div>

        {/* Card */}
        <div className="fade-up rounded-sm border border-rule/60 bg-surface-raised p-8 text-center">
          <div className="mx-auto mb-5 inline-flex h-12 w-12 items-center justify-center rounded-full bg-ember-soft text-ember">
            <Mail className="h-5 w-5" />
          </div>
          <span className="eyebrow">Check your email</span>
          <h1 className="mt-2 font-display text-[28px] font-semibold leading-[1.15] tracking-tight">
            We sent a magic link
            {email ? (
              <>
                {" "}
                to <span className="text-ember">{email}</span>
              </>
            ) : null}
            .
          </h1>
          <p className="mx-auto mt-3 max-w-[44ch] text-[14px] leading-relaxed text-muted-foreground">
            Open the email and tap the link to{" "}
            {isSignup ? "finish setting up your account" : "sign in"}. The link expires in 15 minutes.
          </p>

          {/* Prototype-only simulator */}
          <div className="mt-7 border-t border-rule/40 pt-6">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Prototype shortcut
            </p>
            <Button
              type="button"
              size="lg"
              onClick={handleSimulateClick}
              className="gap-2 rounded-sm"
            >
              I clicked the link
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-[13px] text-muted-foreground">
          Wrong address?{" "}
          <button
            type="button"
            onClick={() => navigate(isSignup ? "/auth/signup" : "/auth/login")}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Use a different email
          </button>
        </p>
      </div>
    </div>
  );
}

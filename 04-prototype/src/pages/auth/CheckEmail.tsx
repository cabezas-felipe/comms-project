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
      <div className="mx-auto flex min-h-screen max-w-[560px] flex-col px-5 py-10 sm:px-6 sm:py-12 lg:py-20">
        {/* Masthead */}
        <div className="mb-10 flex flex-col items-center text-center sm:mb-12">
          <span className="font-display text-2xl font-semibold leading-none tracking-tight sm:text-3xl">
            Tempo
          </span>
          <span className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            The news, in tempo
          </span>
        </div>

        {/* Card */}
        <div className="fade-up rounded-sm border border-rule/60 bg-surface-raised p-6 text-center sm:p-8">
          <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-ember-soft text-ember sm:h-16 sm:w-16">
            <Mail className="h-6 w-6" />
          </div>
          <span className="eyebrow mt-6 block">Check your email</span>

          <h1 className="mt-3 font-display text-[24px] font-semibold leading-[1.2] tracking-tight sm:text-[28px] sm:leading-[1.15]">
            Your magic link is on the way
            {email ? (
              <>
                {" "}
                to <span className="break-all text-ember">{email}</span>
              </>
            ) : null}
            .
          </h1>
          <p className="mx-auto mt-3 max-w-[44ch] text-[14px] leading-relaxed text-muted-foreground">
            Open the email and tap the link to continue. The link expires in 15 minutes.
          </p>

          <div className="mt-7 border-t border-rule/40 pt-6">
            <Button
              type="button"
              size="lg"
              onClick={handleSimulateClick}
              className="w-full gap-2 rounded-sm sm:w-auto"
            >
              Open Tempo
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-[13px] text-muted-foreground">
          Wrong address?{" "}
          <button
            type="button"
            onClick={() => navigate("/auth")}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Use a different email
          </button>
        </p>
      </div>
    </div>
  );
}

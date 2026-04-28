import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { setProtoSession } from "@/lib/auth";
import { trackLandingViewed } from "@/lib/analytics";

export default function EntryLandingPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    trackLandingViewed();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      toast.error("Enter a valid email to continue.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/resolve-destination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        toast.error(body.message ?? "Could not continue. Please try again.");
        return;
      }
      const data = (await res.json()) as {
        destination: string;
        user: { id: string; email: string } | null;
      };
      setProtoSession({ email: trimmed, userId: data.user?.id ?? null });
      navigate(data.destination);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

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
        <div className="mb-10 text-center">
          <h1 className="font-display text-[40px] font-semibold leading-[1.05] tracking-tight">
            Stay on top of what changed while the narrative keeps moving.
          </h1>
          <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            Tempo surfaces meaningful shifts across trusted sources so you can monitor, draft, and
            respond without losing focus.
          </p>
        </div>

        {/* Single email entry */}
        <form onSubmit={handleSubmit} className="fade-up mx-auto w-full max-w-[420px] space-y-3">
          <div className="rounded-sm border border-rule/60 bg-surface-raised p-5">
            <label className="eyebrow mb-2 block">Email</label>
            <Input
              type="email"
              autoFocus
              autoComplete="email"
              placeholder="you@domain.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11 rounded-sm border-rule/60 font-display text-[16px]"
            />
          </div>

          <Button type="submit" size="lg" className="w-full gap-2 rounded-sm" disabled={loading}>
            {loading ? "Opening…" : "Stay in sync"}
            <ArrowRight className="h-4 w-4" />
          </Button>

          <p className="pt-1 text-center text-[13px] text-muted-foreground">
            Access is currently invite-only.
          </p>
        </form>
      </div>
    </div>
  );
}

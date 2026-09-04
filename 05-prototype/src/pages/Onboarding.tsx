import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  trackOnboardingViewed,
  trackOnboardingCtaClicked,
  trackOnboardingSucceeded,
  trackOnboardingFailed,
} from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, Keyboard, Loader2, Mic } from "lucide-react";
import { notifyWarning, notifyError, notifySuccess } from "@/lib/notify";
import { transcribeAudio } from "@/lib/voice-upload";
import {
  saveSettingsPayload,
  SaveSettingsError,
  type SaveSettingsResult,
} from "@/lib/settings-api";
import { CONTRACT_VERSION, settingsPayloadSchema } from "@tempo/contracts";

type Mode = "type" | "voice";
type RecordingState = "idle" | "recording" | "processing" | "ready" | "error";

// Step 2: decide whether an onboarding save produced a viable dashboard.
// Prefer the Step 1 backend signal (`_meta.onboardingViable`) when present.
// When it's absent (older/degraded responses) fall back to deriving viability
// from the returned payload: extraction must have succeeded AND the merged
// payload must carry at least one source. A viable onboarding routes to the
// dashboard; a non-viable one routes to Settings so the user can finish setup.
function isOnboardingViable(result: SaveSettingsResult): boolean {
  const meta = result._meta;
  if (typeof meta?.onboardingViable === "boolean") {
    return meta.onboardingViable;
  }
  const totalSourceCount =
    (result.traditionalSources?.length ?? 0) + (result.socialSources?.length ?? 0);
  return meta?.extractionStatus === "succeeded" && totalSourceCount > 0;
}

const EXAMPLE_TEXT =
  "I lead comms for a nonprofit working on migration between the US and Colombia. I read NYT and El Tiempo, and I follow the State Department on X. Mostly I brief US boards on what's happening in Colombia.";

const PREFERRED_AUDIO_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

export default function Onboarding() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("type");
  const [topics, setTopics] = useState("");
  // Other settings fields (keywords/geographies/sources) are populated by the
  // backend extraction pipeline from the user's narrative — never seeded with
  // hard-coded demo defaults from the client. If extraction fails, those fields
  // stay empty rather than persisting unrelated placeholders.
  const [recState, setRecState] = useState<RecordingState>("idle");
  const [submitting, setSubmitting] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    trackOnboardingViewed();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const switchMode = (newMode: Mode) => {
    if (newMode === mode) return;
    if (recState === "recording" && mediaRecorderRef.current) {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.stop();
      stopStream();
      setRecState("idle");
    }
    setMode(newMode);
  };

  const handleVoiceRecord = async () => {
    if (recState === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (recState === "processing") return;
    if (recState === "error") setRecState("idle");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType =
        PREFERRED_AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopStream();
        setRecState("processing");
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });

        try {
          const transcript = await transcribeAudio(blob);
          setTopics(transcript);
          setMode("type");
          setRecState("ready");
        } catch {
          notifyError("Transcription failed. Please try again.");
          setRecState("error");
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecState("recording");
    } catch (err) {
      stopStream();
      notifyError("Could not access microphone. Please try again or type instead.");
      setRecState("error");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    trackOnboardingCtaClicked();

    if (!topics.trim()) {
      trackOnboardingFailed({ failureStage: "validation", validationReason: "empty" });
      notifyWarning("Add what you're watching to continue.");
      return;
    }
    setSubmitting(true);

    const trimmedNarrative = topics.trim();

    // Step 1: Build minimal safe payload from user-entered narrative ONLY.
    // No seeded keyword/geography/source defaults are attached here — those
    // fields are derived server-side by the extraction pipeline from the raw
    // narrative. If extraction fails, the persisted settings keep these arrays
    // empty rather than leaking unrelated placeholders into Settings.
    //
    // Topics are persisted as a single-entry array containing the full trimmed
    // narrative — NOT a comma/newline split. The narrative is prose, not a
    // delimited list, so splitting it produces fragmented chunks that surface
    // as garbage "topics" in the fallback (extraction-failed) path. The
    // backend's extraction pipeline replaces this single entry with proper
    // canonical labels when it succeeds.
    const minimalPayload = settingsPayloadSchema.parse({
      contractVersion: CONTRACT_VERSION,
      topics: [trimmedNarrative],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    });

    // Step 2: Persist raw text + baseline settings. Failure blocks navigation.
    let saveResult: Awaited<ReturnType<typeof saveSettingsPayload>>;
    try {
      saveResult = await saveSettingsPayload(minimalPayload, { onboardingRawText: trimmedNarrative });
    } catch (err) {
      const stage = err instanceof SaveSettingsError ? err.stage : "backend";
      const statusCode = err instanceof SaveSettingsError ? err.statusCode : undefined;
      trackOnboardingFailed({
        failureStage: stage,
        ...(statusCode !== undefined ? { statusCode } : {}),
      });
      notifyError("We couldn't save your changes. Please try again.");
      setSubmitting(false);
      return;
    }

    // Step 3: User is unblocked — navigate immediately.
    trackOnboardingSucceeded();
    notifySuccess("Tempo set. Welcome.");
    setSubmitting(false);

    // Viability routing (onboarding meta-stories): a non-viable onboarding
    // (extraction failed, or succeeded with zero sources) has nothing for the
    // dashboard to render yet, so send the user to Settings to complete what
    // they're monitoring — no bootstrap/refresh handoff state. The
    // extraction-failed warning toast is intentionally gone: routing to Settings
    // is now the recovery affordance, not a toast.
    if (!isOnboardingViable(saveResult)) {
      navigate("/settings");
      return;
    }

    // Phase 5: Onboarding → Dashboard post-submit is the second of the two
    // surfaces that should trigger backend-owned bootstrap freshness.
    //
    // Slice 2: also pass `forceRefresh: true` so the dashboard runs the POST
    // refresh pipeline directly instead of letting bootstrap reuse a stale
    // "fresh" snapshot (≤60 min old) written before this onboarding's settings
    // landed.  The new user's first view must reflect the beat they just
    // configured, not a pre-existing snapshot.
    //
    // Slice 4: this `forceRefresh` entry is the onboarding-driven INTERACTIVE
    // path — the Dashboard loader routes it through the backend's balanced
    // fast-path profile (bounded geo + clustering envelope) so first stories
    // land in the 20–30s band while a human waits.  Scheduled/background
    // refreshes are unaffected (they never set `forceRefresh`).
    //
    // Slice 8: when the settings save kicked off a cold-start prefetch (Slice 6),
    // forward its job handle as `coldStartJobId` so the Dashboard can later join
    // the in-flight refresh.  Absent/blank → navigate exactly as before; the job
    // id never blocks navigation.
    // Defensive: a malformed backend `_meta` could carry a non-string
    // refreshJobId; only trim when it's actually a string, otherwise treat as
    // absent (never let `.trim()` throw into the navigation path).
    const rawRefreshJobId = saveResult._meta?.refreshJobId;
    const coldStartJobId =
      typeof rawRefreshJobId === "string" ? rawRefreshJobId.trim() : undefined;
    const handoffState: {
      bootstrap: true;
      forceRefresh: true;
      coldStartJobId?: string;
    } = { bootstrap: true, forceRefresh: true };
    if (coldStartJobId) {
      handoffState.coldStartJobId = coldStartJobId;
    }
    navigate(
      import.meta.env.DEV ? "/dashboard?preview=1" : "/dashboard",
      { state: handoffState }
    );
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
          <h1 className="font-display text-[34px] font-semibold leading-[1.08] tracking-tight sm:text-[40px] sm:leading-[1.05]">
            Tell us what you&apos;re watching.
          </h1>
          <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            A few words is enough — topics, regions, sources you trust. You can refine anything
            later in Settings.
          </p>
        </div>

        {/* Mode toggle */}
        <div className="mb-8 flex justify-center">
          <div className="inline-flex rounded-sm border border-rule/60 bg-background p-0.5">
            <ModeButton
              active={mode === "type"}
              onClick={() => switchMode("type")}
              icon={<Keyboard className="h-3.5 w-3.5" />}
              label="Type"
            />
            <ModeButton
              active={mode === "voice"}
              onClick={() => switchMode("voice")}
              icon={<Mic className="h-3.5 w-3.5" />}
              label="Speak"
            />
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {mode === "voice" ? (
            <div className="fade-up rounded-sm border border-rule/60 bg-surface-raised p-6">
              <span className="eyebrow mb-3 block">For example</span>
              <p className="text-[15px] font-normal italic leading-[1.65] text-muted-foreground/70">
                {EXAMPLE_TEXT}
              </p>
              <div className="mt-5 flex flex-col items-center gap-3">
                <button
                  type="button"
                  onClick={handleVoiceRecord}
                  disabled={recState === "processing"}
                  className={`inline-flex h-14 w-14 items-center justify-center rounded-full transition-transform ${
                    recState === "recording"
                      ? "animate-pulse bg-red-500 text-white hover:scale-105"
                      : "bg-ember text-ember-foreground hover:scale-105"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                  aria-label={recState === "recording" ? "Stop recording" : "Start recording"}
                >
                  {recState === "processing" ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Mic className="h-5 w-5" />
                  )}
                </button>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {recState === "idle" && "Click to record"}
                  {recState === "recording" && "Recording… click to stop"}
                  {recState === "processing" && "Transcribing…"}
                  {recState === "error" && (
                    <button
                      type="button"
                      onClick={() => setRecState("idle")}
                      className="underline"
                    >
                      Try again
                    </button>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <div className="fade-up rounded-sm border border-rule/60 bg-surface-raised p-6">
              <span className="eyebrow mb-3 block">For example</span>
              <Textarea
                value={topics}
                onChange={(e) => setTopics(e.target.value)}
                placeholder={EXAMPLE_TEXT}
                rows={5}
                className="rounded-sm border-rule/60 text-[15px] font-normal leading-[1.65] not-italic placeholder:italic placeholder:text-muted-foreground/70"
              />
            </div>
          )}

          {/* Privacy */}
          <div className="border-t border-rule/40 pt-5 text-[13px] leading-relaxed text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">We keep:</span> your text.
            </p>
            <p>
              <span className="font-medium text-foreground">We don&apos;t keep:</span> your voice recording.
            </p>
          </div>

          {/* CTA */}
          <div className="flex justify-end pt-2">
            <Button type="submit" size="lg" className="gap-2 rounded-sm" disabled={submitting}>
              {submitting ? "Setting tempo…" : "Set the tempo"}
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-sm px-4 py-1.5 text-[13px] font-medium transition-colors ${
        active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  trackOnboardingCompleted,
  trackOnboardingSubmitted,
  trackOnboardingViewed,
} from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ArrowRight, Keyboard, Loader2, Mic } from "lucide-react";
import { toast } from "sonner";
import { transcribeAudio, uploadVoiceNote } from "@/lib/voice-upload";
import { ExtractionApiError, extractOnboardingText, saveSettingsPayload } from "@/lib/settings-api";
import { classifySources } from "@/lib/source-classification";
import { CONTRACT_VERSION, settingsPayloadSchema, type SettingsPayload } from "@tempo/contracts";

type Mode = "type" | "voice";
type RecordingState = "idle" | "recording" | "processing" | "ready" | "error";

const EXAMPLE_TEXT =
  "Track US and Colombia diplomatic stories — especially OFAC and migration. Trust NYT, Reuters, El Tiempo, and Semana.";

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
  const [topics, setTopics] = useState(EXAMPLE_TEXT);
  const [keywords, setKeywords] = useState("OFAC, sanctions, deportation routing, bilateral");
  const [geos, setGeos] = useState<string[]>(["US", "Colombia"]);
  const [sources, setSources] = useState(
    "NYT, Washington Post, Reuters, El Tiempo, El País, Semana"
  );
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

  const toggleGeo = (g: string) =>
    setGeos((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

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

        void uploadVoiceNote(blob).then((status) => {
          if (status === "skipped") {
            toast.info("Not signed in — voice note was not archived.");
          }
        });

        try {
          const transcript = await transcribeAudio(blob);
          setTopics(transcript);
          setMode("type");
          setRecState("ready");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Transcription failed.";
          toast.error(`Voice capture failed — ${msg} You can type instead.`);
          setRecState("error");
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecState("recording");
    } catch (err) {
      stopStream();
      const msg =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone permission denied."
          : "Could not access microphone.";
      toast.error(`${msg} You can type instead.`);
      setRecState("error");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topics.trim() || !geos.length) {
      toast.error("Add at least one topic and one geography to continue.");
      return;
    }
    setSubmitting(true);
    trackOnboardingSubmitted();

    let payload: SettingsPayload;
    let bothFailed = false;
    try {
      const extracted = await extractOnboardingText(topics.trim());
      const { traditionalSources, socialSources } = classifySources(extracted.sources);
      payload = settingsPayloadSchema.parse({
        contractVersion: CONTRACT_VERSION,
        topics: extracted.topics,
        keywords: extracted.keywords,
        geographies: extracted.geographies.length ? extracted.geographies : geos,
        traditionalSources,
        socialSources,
      });
    } catch (err) {
      bothFailed = err instanceof ExtractionApiError && err.status === 500;
      if (bothFailed) {
        payload = settingsPayloadSchema.parse({
          contractVersion: CONTRACT_VERSION,
          topics: [],
          keywords: [],
          geographies: [],
          traditionalSources: [],
          socialSources: [],
        });
      } else {
        toast.info("Could not extract preferences — continuing with your entered values.");
        const splitTrim = (s: string) => s.split(/[,\n]+/).map((v) => v.trim()).filter(Boolean);
        payload = settingsPayloadSchema.parse({
          contractVersion: CONTRACT_VERSION,
          topics: splitTrim(topics),
          keywords: splitTrim(keywords),
          geographies: geos,
          traditionalSources: splitTrim(sources),
          socialSources: [],
        });
      }
    }

    try {
      await saveSettingsPayload(payload);
    } catch {
      toast.error("Couldn't save your settings. Please try again.");
      setSubmitting(false);
      return;
    }

    trackOnboardingCompleted();
    if (bothFailed) {
      toast.info("We couldn't auto-configure your watchlist yet. You can refine it in Settings.");
    } else {
      toast.success("Tempo set. Welcome.");
    }
    setSubmitting(false);
    navigate(
      bothFailed
        ? import.meta.env.DEV ? "/dashboard?preview=1&empty=1" : "/dashboard?empty=1"
        : import.meta.env.DEV ? "/dashboard?preview=1" : "/dashboard"
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
          <h1 className="font-display text-[40px] font-semibold leading-[1.05] tracking-tight">
            Stop refreshing twelve tabs to find what actually moved.
          </h1>
          <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            Tell Tempo what you watch. We cluster, dedupe, and source-check coverage so the news
            arrives in one calm place — however fast it moves.
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
              label="Voice"
            />
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {mode === "voice" ? (
            <div className="fade-up rounded-sm border border-rule/60 bg-surface-raised p-6">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow">Example</span>
              </div>
              <p className="font-display text-[17px] leading-[1.6] text-foreground/85">
                &ldquo;Track US and Colombia diplomatic stories — especially OFAC and migration.
                Trust NYT, Reuters, El Tiempo, and Semana.&rdquo;
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
              {recState === "ready" && (
                <p className="mb-2 font-mono text-[11px] text-muted-foreground">
                  Transcription added. You can keep typing if needed.
                </p>
              )}
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow">Example</span>
              </div>
              <Textarea
                value={topics}
                onChange={(e) => setTopics(e.target.value)}
                rows={5}
                className="font-display text-[17px] leading-[1.6]"
              />
            </div>
          )}

          {/* CTA */}
          <div className="flex items-center justify-between pt-2">
            <p className="font-mono text-[11px] text-muted-foreground">
              You can edit anytime in Settings.
            </p>
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-[13px] font-medium text-foreground">{label}</Label>
        {hint && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

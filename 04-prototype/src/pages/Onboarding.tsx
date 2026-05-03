import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  trackOnboardingCompleted,
  trackOnboardingSubmitted,
  trackOnboardingViewed,
} from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, Keyboard, Loader2, Mic } from "lucide-react";
import { notifyWarning, notifyError, notifySuccess } from "@/lib/notify";
import { transcribeAudio } from "@/lib/voice-upload";
import { ExtractionApiError, extractOnboardingText, saveSettingsPayload } from "@/lib/settings-api";
import { classifySources } from "@/lib/source-classification";
import { CONTRACT_VERSION, settingsPayloadSchema, type SettingsPayload } from "@tempo/contracts";

type Mode = "type" | "voice";
type RecordingState = "idle" | "recording" | "processing" | "ready" | "error";

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
  const [keywords, setKeywords] = useState("OFAC, sanctions, deportation routing, bilateral");
  const [geos] = useState<string[]>(["US", "Colombia"]);
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
    if (!topics.trim() || !geos.length) {
      notifyWarning("Add what you're watching to continue.");
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
        notifyWarning("We hit an issue on our side. You can keep going and complete what you're monitoring in Settings.");
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
      notifyError("We couldn't save your changes. Please try again.");
      setSubmitting(false);
      return;
    }

    trackOnboardingCompleted();
    if (bothFailed) {
      notifyWarning("We hit an issue on our side. Please complete what you're monitoring in Settings.");
    } else {
      notifySuccess("Tempo set. Welcome.");
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
              <span className="font-medium text-foreground">We keep:</span> scope and source preferences.
            </p>
            <p>
              <span className="font-medium text-foreground">We don&apos;t keep:</span> voice recordings.
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

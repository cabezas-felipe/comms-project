import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { addCommaSeparated, addTraditional, addSocial } from "@/lib/settings-list-utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { defaultSettingsPayload, fetchSettingsPayload, saveSettingsPayload } from "@/lib/settings-api";

function warnToast(message: string) {
  toast.warning(message, {
    icon: <AlertTriangle className="h-4 w-4" style={{ color: "hsl(var(--signal-warning))" }} />,
  });
}

interface ListSectionProps {
  title: string;
  description: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  label: string;
  disabled?: boolean;
}

function ListSection({ title, description, items, onChange, placeholder, label, disabled }: ListSectionProps) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const result = addCommaSeparated(draft, items, label);
    if (result.warning) warnToast(result.warning);
    if (result.nextItems) {
      onChange(result.nextItems);
      setDraft("");
    }
  };

  const remove = (i: string) => onChange(items.filter((x) => x !== i));

  return (
    <section className="border-b border-rule/60 py-8 first:pt-0 last:border-b-0">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-[260px_1fr]">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div>
          <div className="flex flex-wrap gap-1.5">
            {items.map((item) => (
              <AlertDialog key={item}>
                <AlertDialogTrigger asChild>
                  <button
                    disabled={disabled}
                    className="group inline-flex items-center gap-1.5 rounded-sm border border-rule/60 bg-background py-1 pl-2.5 pr-1.5 text-[13px] transition-colors hover:border-ember hover:text-ember disabled:pointer-events-none disabled:opacity-50"
                  >
                    {item}
                    <X className="h-3 w-3 opacity-50 transition-opacity group-hover:opacity-100" />
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-display">Remove &ldquo;{item}&rdquo;?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Tempo will stop tracking this until you add it back.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction onClick={() => remove(item)}>
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ))}
            {items.length === 0 && (
              <span className="text-[13px] italic text-muted-foreground">Nothing here yet.</span>
            )}
          </div>

          <div className="mt-4 flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
              placeholder={placeholder}
              className="max-w-sm"
              disabled={disabled}
            />
            <Button type="button" variant="outline" onClick={add} disabled={disabled || !draft.trim()} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

type SourceTab = "traditional" | "social";

type SettingsSnapshot = {
  topics: string[];
  keywords: string[];
  geographies: string[];
  traditional: string[];
  social: string[];
};

export default function Settings() {
  // Computed once on mount; provides defaults for state and snapshot without duplicating values.
  const [_defaults] = useState(defaultSettingsPayload);
  const [topics, setTopics] = useState(_defaults.topics);
  const [keywords, setKeywords] = useState(_defaults.keywords);
  const [geographies, setGeographies] = useState(_defaults.geographies);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const saveTimer = useRef<number | null>(null);
  const [sourceTab, setSourceTab] = useState<SourceTab>("traditional");
  const [loading, setLoading] = useState(true);

  const [traditional, setTraditional] = useState<string[]>(_defaults.traditionalSources);
  const [social, setSocial] = useState<string[]>(_defaults.socialSources);
  const [draftSource, setDraftSource] = useState("");

  const snapshotRef = useRef<SettingsSnapshot>({
    topics: _defaults.topics,
    keywords: _defaults.keywords,
    geographies: _defaults.geographies,
    traditional: _defaults.traditionalSources,
    social: _defaults.socialSources,
  });

  // stateRef keeps save callback from closing over stale state values
  const stateRef = useRef({ topics, keywords, geographies, traditional, social });
  stateRef.current = { topics, keywords, geographies, traditional, social };

  // Revision counter: incremented on every user mutation. A save captures the
  // revision at launch; if the revision has advanced by the time it resolves, a
  // newer edit is pending and the response (success or failure) is ignored. This
  // covers both concurrent in-flight saves and the case where a new edit arrives
  // after a save fires but before it resolves.
  const pendingRevisionRef = useRef(0);

  const scheduleSave = () => {
    setSaveState("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const revisionAtStart = pendingRevisionRef.current;
      const s = stateRef.current;
      try {
        await saveSettingsPayload({
          contractVersion: CONTRACT_VERSION,
          topics: s.topics,
          keywords: s.keywords,
          geographies: s.geographies,
          traditionalSources: s.traditional,
          socialSources: s.social,
        });
        if (revisionAtStart !== pendingRevisionRef.current) return;
        snapshotRef.current = { ...s };
        setSaveState("saved");
      } catch {
        if (revisionAtStart !== pendingRevisionRef.current) return;
        toast.error("Could not save settings. Please try again.");
        const snap = snapshotRef.current;
        setTopics(snap.topics);
        setKeywords(snap.keywords);
        setGeographies(snap.geographies);
        setTraditional(snap.traditional);
        setSocial(snap.social);
        setSaveState("failed");
      }
    }, 600);
  };

  const markDirty = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    pendingRevisionRef.current++;
    scheduleSave();
  };

  const savedLabel =
    saveState === "saving" ? "Saving…" :
    saveState === "failed" ? "Save failed" :
    "All changes saved";

  const list = sourceTab === "traditional" ? traditional : social;
  const setList = sourceTab === "traditional" ? markDirty(setTraditional) : markDirty(setSocial);

  const addSource = () => {
    const result =
      sourceTab === "traditional"
        ? addTraditional(draftSource, list)
        : addSocial(draftSource, list);
    if (result.warning) warnToast(result.warning);
    if (result.nextItems) {
      setList(result.nextItems);
      setDraftSource("");
    }
  };

  const removeSource = (s: string) => setList(list.filter((x) => x !== s));

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    fetchSettingsPayload()
      .then((payload) => {
        if (canceled) return;
        setTopics(payload.topics);
        setKeywords(payload.keywords);
        setGeographies(payload.geographies);
        setTraditional(payload.traditionalSources);
        setSocial(payload.socialSources);
        snapshotRef.current = {
          topics: payload.topics,
          keywords: payload.keywords,
          geographies: payload.geographies,
          traditional: payload.traditionalSources,
          social: payload.socialSources,
        };
      })
      .catch(() => {
        if (canceled) return;
        toast.error("Could not load settings. Using defaults.");
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="px-6 py-12">
        <div className="mx-auto max-w-[860px]">
          <div className="mb-10 flex items-end justify-between gap-6 border-b border-rule/60 pb-6">
            <div>
              <h1 className="font-display text-[34px] font-semibold leading-tight tracking-tight">
                What you&apos;re monitoring
              </h1>
              <p className="mt-1.5 max-w-[60ch] text-[13px] leading-relaxed text-muted-foreground">
                Refine what Tempo watches. Changes take effect at the next refresh.
              </p>
            </div>
            <div
              aria-live="polite"
              className={`shrink-0 font-mono text-[11px] uppercase tracking-wider ${
                saveState === "failed" ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    saveState === "saving"
                      ? "animate-pulse bg-muted-foreground"
                      : saveState === "failed"
                      ? "bg-destructive"
                      : "bg-foreground/40"
                  }`}
                />
                {savedLabel}
              </span>
            </div>
          </div>

          <div aria-busy={loading}>
            <ListSection
              title="Topics"
              description="Broad themes Tempo clusters stories around."
              items={topics}
              onChange={markDirty(setTopics)}
              placeholder="Add a topic"
              label="topic"
              disabled={loading}
            />
            <ListSection
              title="Keywords"
              description="Specific terms Tempo treats as signal."
              items={keywords}
              onChange={markDirty(setKeywords)}
              placeholder="Add a keyword"
              label="keyword"
              disabled={loading}
            />
            <ListSection
              title="Geographies"
              description="Regions Tempo tracks."
              items={geographies}
              onChange={markDirty(setGeographies)}
              placeholder="Add a geography"
              label="geography"
              disabled={loading}
            />

            {/* Sources section with tabs */}
            <section className="border-b border-rule/60 py-8 last:border-b-0">
              <div className="grid grid-cols-1 gap-8 md:grid-cols-[260px_1fr]">
                <div>
                  <h2 className="font-display text-xl font-semibold tracking-tight">Sources</h2>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                    Outlets and accounts Tempo watches.
                  </p>
                </div>
                <div>
                  {/* Tabs */}
                  <div className="mb-4 inline-flex rounded-sm border border-rule/60 bg-background p-0.5">
                    <TabButton
                      active={sourceTab === "traditional"}
                      onClick={() => setSourceTab("traditional")}
                      glyph="■"
                      label={`Traditional outlets · ${traditional.length}`}
                      disabled={loading}
                    />
                    <TabButton
                      active={sourceTab === "social"}
                      onClick={() => setSourceTab("social")}
                      glyph="◯"
                      label={`Social accounts · ${social.length}`}
                      disabled={loading}
                    />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {list.map((s) => (
                      <AlertDialog key={s}>
                        <AlertDialogTrigger asChild>
                          <button
                            disabled={loading}
                            className="group inline-flex items-center gap-1.5 rounded-sm border border-rule/60 bg-background py-1 pl-2.5 pr-1.5 text-[13px] transition-colors hover:border-ember hover:text-ember disabled:pointer-events-none disabled:opacity-50"
                          >
                            <span aria-hidden className="font-mono text-[10px] text-muted-foreground group-hover:text-ember">
                              {sourceTab === "social" ? "◯" : "■"}
                            </span>
                            {s}
                            <X className="h-3 w-3 opacity-50 transition-opacity group-hover:opacity-100" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle className="font-display">Remove &ldquo;{s}&rdquo;?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Tempo will stop monitoring this source until you add it back.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep</AlertDialogCancel>
                            <AlertDialogAction onClick={() => removeSource(s)}>
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ))}
                    {list.length === 0 && (
                      <span className="text-[13px] italic text-muted-foreground">Nothing here yet.</span>
                    )}
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Input
                      value={draftSource}
                      onChange={(e) => setDraftSource(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSource())}
                      placeholder={sourceTab === "social" ? "Add a @handle" : "Add an outlet"}
                      className="max-w-sm"
                      disabled={loading}
                    />
                    <Button type="button" variant="outline" onClick={addSource} disabled={loading || !draftSource.trim()} className="gap-1.5">
                      <Plus className="h-3.5 w-3.5" /> Add
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  glyph,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  glyph: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
        active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <span aria-hidden>{glyph}</span>
      {label}
    </button>
  );
}

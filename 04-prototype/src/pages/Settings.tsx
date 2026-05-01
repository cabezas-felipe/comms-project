import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "lucide-react";
import { toast } from "sonner";
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
import { STORIES } from "@/data/stories";
import { CONTRACT_VERSION } from "@tempo/contracts";
import { fetchSettingsPayload, saveSettingsPayload } from "@/lib/settings-api";

interface ListSectionProps {
  title: string;
  description: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}

function ListSection({ title, description, items, onChange, placeholder, disabled }: ListSectionProps) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (items.includes(v)) {
      toast.error(`"${v}" is already in your list.`);
      return;
    }
    onChange([...items, v]);
    setDraft("");
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

export default function Settings() {
  const [topics, setTopics] = useState(["Diplomatic relations", "Migration policy", "Security cooperation"]);
  const [keywords, setKeywords] = useState(["OFAC", "sanctions", "deportation routing", "bilateral"]);
  const [geographies, setGeographies] = useState(["US", "Colombia"]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimer = useRef<number | null>(null);
  const [sourceTab, setSourceTab] = useState<SourceTab>("traditional");
  const [loading, setLoading] = useState(true);

  const seed = useMemo(() => {
    const seenT = new Set<string>();
    const seenS = new Set<string>();
    const trad: string[] = [];
    const soc: string[] = [];
    STORIES.forEach((st) =>
      st.sources.forEach((s) => {
        if (s.kind === "traditional" && !seenT.has(s.outlet)) {
          seenT.add(s.outlet);
          trad.push(s.outlet);
        }
        if (s.kind === "social" && !seenS.has(s.outlet)) {
          seenS.add(s.outlet);
          soc.push(s.outlet);
        }
      })
    );
    return { trad, soc };
  }, []);

  const [traditional, setTraditional] = useState<string[]>(seed.trad);
  const [social, setSocial] = useState<string[]>(seed.soc);
  const [draftSource, setDraftSource] = useState("");

  // stateRef keeps save callback from closing over stale state values
  const stateRef = useRef({ topics, keywords, geographies, traditional, social });
  stateRef.current = { topics, keywords, geographies, traditional, social };

  const scheduleSave = () => {
    setSaveState("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
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
        setSaveState("saved");
      } catch {
        toast.error("Could not save settings. Please try again.");
        setSaveState("idle");
      }
    }, 600);
  };

  const markDirty = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    scheduleSave();
  };

  const savedLabel = saveState === "saving" ? "Saving…" : "All changes saved";

  const list = sourceTab === "traditional" ? traditional : social;
  const setList = sourceTab === "traditional" ? markDirty(setTraditional) : markDirty(setSocial);

  const addSource = () => {
    const v = draftSource.trim();
    if (!v) return;
    if (list.includes(v)) {
      toast.error(`"${v}" is already in your sources.`);
      return;
    }
    setList([...list, v]);
    setDraftSource("");
  };

  const removeSource = (s: string) => setList(list.filter((x) => x !== s));

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
              className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    saveState === "saving" ? "animate-pulse bg-muted-foreground" : "bg-foreground/40"
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
              disabled={loading}
            />
            <ListSection
              title="Keywords"
              description="Specific terms Tempo treats as signal."
              items={keywords}
              onChange={markDirty(setKeywords)}
              placeholder="Add a keyword"
              disabled={loading}
            />
            <ListSection
              title="Geographies"
              description="Regions Tempo tracks."
              items={geographies}
              onChange={markDirty(setGeographies)}
              placeholder="Add a geography"
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
                      placeholder={sourceTab === "social" ? "@handle" : "Outlet name"}
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

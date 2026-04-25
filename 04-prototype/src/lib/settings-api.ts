import {
  CONTRACT_VERSION,
  settingsPayloadSchema,
  type SettingsPayload,
} from "@tempo/contracts";
import { STORIES } from "@/data/stories";
import { supabase } from "./supabase";

const SETTINGS_STORAGE_KEY_BASE = "tempo.settings.v1";
const SETTINGS_API_ENDPOINT = "/api/settings";
const MOCK_LATENCY_MS = 120;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getStorageKey(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user?.id) return `${SETTINGS_STORAGE_KEY_BASE}.${data.session.user.id}`;
  } catch {
    // supabase not configured — use global key
  }
  return SETTINGS_STORAGE_KEY_BASE;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      return { Authorization: `Bearer ${data.session.access_token}` };
    }
  } catch {
    // supabase not configured — no auth header
  }
  return {};
}

function seedSourcesFromStories(): { traditionalSources: string[]; socialSources: string[] } {
  const seenTraditional = new Set<string>();
  const seenSocial = new Set<string>();
  const traditionalSources: string[] = [];
  const socialSources: string[] = [];

  STORIES.forEach((story) => {
    story.sources.forEach((source) => {
      if (source.kind === "traditional" && !seenTraditional.has(source.outlet)) {
        seenTraditional.add(source.outlet);
        traditionalSources.push(source.outlet);
      }
      if (source.kind === "social" && !seenSocial.has(source.outlet)) {
        seenSocial.add(source.outlet);
        socialSources.push(source.outlet);
      }
    });
  });

  return { traditionalSources, socialSources };
}

export function defaultSettingsPayload(): SettingsPayload {
  const seeds = seedSourcesFromStories();
  return settingsPayloadSchema.parse({
    contractVersion: CONTRACT_VERSION,
    topics: ["Diplomatic relations", "Migration policy", "Security cooperation"],
    keywords: ["OFAC", "sanctions", "deportation routing", "bilateral"],
    geographies: ["US", "Colombia"],
    traditionalSources: seeds.traditionalSources,
    socialSources: seeds.socialSources,
  });
}

export type ExtractionResult = {
  topics: string[];
  keywords: string[];
  geographies: string[];
  sources: string[];
};

export async function extractOnboardingText(text: string): Promise<ExtractionResult> {
  const authHeaders = await getAuthHeaders();
  const response = await fetch("/api/onboarding/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Extraction API returned HTTP ${response.status}`);
  }
  return response.json() as Promise<ExtractionResult>;
}

export async function fetchSettingsPayload(): Promise<SettingsPayload> {
  const [storageKey, authHeaders] = await Promise.all([getStorageKey(), getAuthHeaders()]);
  try {
    const response = await fetch(SETTINGS_API_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders },
    });
    if (!response.ok) {
      throw new Error(`Settings API returned HTTP ${response.status}`);
    }
    const payload = settingsPayloadSchema.parse(await response.json());
    localStorage.setItem(storageKey, JSON.stringify(payload));
    return payload;
  } catch {
    await wait(MOCK_LATENCY_MS);
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      const fallback = defaultSettingsPayload();
      localStorage.setItem(storageKey, JSON.stringify(fallback));
      return fallback;
    }
    try {
      return settingsPayloadSchema.parse(JSON.parse(raw));
    } catch {
      const fallback = defaultSettingsPayload();
      localStorage.setItem(storageKey, JSON.stringify(fallback));
      return fallback;
    }
  }
}

export async function saveSettingsPayload(payload: SettingsPayload): Promise<SettingsPayload> {
  const validated = settingsPayloadSchema.parse(payload);
  const [storageKey, authHeaders] = await Promise.all([getStorageKey(), getAuthHeaders()]);
  try {
    const response = await fetch(SETTINGS_API_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(validated),
    });
    if (!response.ok) {
      throw new Error(`Settings API returned HTTP ${response.status}`);
    }
    const persisted = settingsPayloadSchema.parse(await response.json());
    localStorage.setItem(storageKey, JSON.stringify(persisted));
    return persisted;
  } catch {
    await wait(MOCK_LATENCY_MS);
    localStorage.setItem(storageKey, JSON.stringify(validated));
  }
  return validated;
}

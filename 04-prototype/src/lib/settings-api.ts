import {
  CONTRACT_VERSION,
  settingsPayloadSchema,
  type SettingsPayload,
} from "@tempo/contracts";
import { STORIES } from "@/data/stories";

const SETTINGS_STORAGE_KEY = "tempo.settings.v1";
const SETTINGS_API_ENDPOINT = "/api/settings";
const MOCK_LATENCY_MS = 120;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function defaultSettingsPayload(): SettingsPayload {
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

/**
 * Slice 5 adapter: local persistence with contract validation.
 * This boundary can be swapped to a real API later.
 */
export async function fetchSettingsPayload(): Promise<SettingsPayload> {
  try {
    const response = await fetch(SETTINGS_API_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Settings API returned HTTP ${response.status}`);
    }
    const payload = settingsPayloadSchema.parse(await response.json());
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    return payload;
  } catch {
    await wait(MOCK_LATENCY_MS);
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      const fallback = defaultSettingsPayload();
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(fallback));
      return fallback;
    }
    try {
      return settingsPayloadSchema.parse(JSON.parse(raw));
    } catch {
      const fallback = defaultSettingsPayload();
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(fallback));
      return fallback;
    }
  }
}

export async function saveSettingsPayload(payload: SettingsPayload): Promise<SettingsPayload> {
  const validated = settingsPayloadSchema.parse(payload);
  try {
    const response = await fetch(SETTINGS_API_ENDPOINT, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validated),
    });
    if (!response.ok) {
      throw new Error(`Settings API returned HTTP ${response.status}`);
    }
    const persisted = settingsPayloadSchema.parse(await response.json());
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(persisted));
    return persisted;
  } catch {
    await wait(MOCK_LATENCY_MS);
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
  }
  return validated;
}

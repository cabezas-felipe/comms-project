import {
  CONTRACT_VERSION,
  settingsPayloadSchema,
  type SettingsPayload,
} from "@tempo/contracts";
import { STORIES } from "@/data/stories";
import { supabase } from "./supabase";
import { getProtoSession } from "./auth";

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
    // supabase not configured
  }
  // Prototype recognized-identity fallback: use recognized userId for per-user isolation.
  const proto = getProtoSession();
  if (proto?.userId) return `${SETTINGS_STORAGE_KEY_BASE}.${proto.userId}`;
  return SETTINGS_STORAGE_KEY_BASE;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      return { Authorization: `Bearer ${data.session.access_token}` };
    }
  } catch {
    // supabase not configured
  }
  // Prototype recognized-identity fallback (not production auth).
  const proto = getProtoSession();
  if (proto) {
    return { "x-recognized-email": proto.email };
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

export type SaveSettingsResult = SettingsPayload & {
  _meta?: {
    extractionStatus?: "not_attempted" | "succeeded" | "failed";
  };
};

export async function fetchSettingsPayload(): Promise<SettingsPayload> {
  const [storageKey, authHeaders] = await Promise.all([getStorageKey(), getAuthHeaders()]);
  // Identity-bound: either a Supabase session (Bearer) or a prototype recognized identity.
  // In both cases, fail loudly on API failure rather than silently diverging to local data.
  const isIdentityBound = "Authorization" in authHeaders || "x-recognized-email" in authHeaders;
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
    if (isIdentityBound) {
      throw new Error("Identity-bound settings read failed: API unavailable.");
    }
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

export async function saveSettingsPayload(
  payload: SettingsPayload,
  options?: { onboardingRawText?: string }
): Promise<SaveSettingsResult> {
  const validated = settingsPayloadSchema.parse(payload);
  const [storageKey, authHeaders] = await Promise.all([getStorageKey(), getAuthHeaders()]);
  const isIdentityBound = "Authorization" in authHeaders || "x-recognized-email" in authHeaders;
  const requestBody: Record<string, unknown> = { ...validated };
  if (options?.onboardingRawText) {
    requestBody.onboardingRawText = options.onboardingRawText;
  }
  try {
    const response = await fetch(SETTINGS_API_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      throw new Error(`Settings API returned HTTP ${response.status}`);
    }
    const raw = (await response.json()) as SaveSettingsResult;
    const persisted = settingsPayloadSchema.parse(raw);
    localStorage.setItem(storageKey, JSON.stringify(persisted));
    return raw._meta ? { ...persisted, _meta: raw._meta } : persisted;
  } catch {
    if (isIdentityBound) {
      throw new Error("Identity-bound settings write failed: API unavailable.");
    }
    await wait(MOCK_LATENCY_MS);
    localStorage.setItem(storageKey, JSON.stringify(validated));
  }
  return validated;
}

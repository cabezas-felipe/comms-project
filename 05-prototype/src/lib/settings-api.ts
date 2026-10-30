import {
  CONTRACT_VERSION,
  settingsPayloadSchema,
  type SettingsPayload,
} from "@tempo/contracts";
import { supabase } from "./supabase";
import { getProtoSession } from "./auth";
import { isE2EIdentityOverrideEnabled } from "./e2e-identity";

const SETTINGS_STORAGE_KEY_BASE = "tempo.settings.v1";
const SETTINGS_API_ENDPOINT = "/api/settings";
const MOCK_LATENCY_MS = 120;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Storage-key precedence mirrors getAuthHeaders so local fallback isolation
// stays in sync with the identity actually sent to the server. Default: the
// Supabase session id wins; the recognized-user id is a fallback. The E2E-only
// override (VITE_E2E_IDENTITY_PRECEDENCE=recognized_email) flips this to prefer
// the recognized user so an e2e run isolates by the recognized identity.
async function getStorageKey(): Promise<string> {
  const proto = getProtoSession();
  if (proto?.userId && isE2EIdentityOverrideEnabled()) {
    return `${SETTINGS_STORAGE_KEY_BASE}.${proto.userId}`;
  }
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user?.id) return `${SETTINGS_STORAGE_KEY_BASE}.${data.session.user.id}`;
  } catch {
    // supabase not configured
  }
  // Bearer/session absent → fall back to the recognized-user id when present.
  if (proto?.userId) return `${SETTINGS_STORAGE_KEY_BASE}.${proto.userId}`;
  // Unrecognized fallback key (single-anon bucket).
  return SETTINGS_STORAGE_KEY_BASE;
}

// Identity precedence (default = production-safe): a Bearer session wins; the
// prototype recognized-email header is a fallback when no Bearer exists. The
// recognized-email-over-Bearer ordering is gated behind the E2E-only override
// (VITE_E2E_IDENTITY_PRECEDENCE=recognized_email) — kept in sync with the
// dashboard API's buildIdentityHeaders via isE2EIdentityOverrideEnabled.
async function getAuthHeaders(): Promise<Record<string, string>> {
  const proto = getProtoSession();
  // E2E-only override: recognized-email beats Bearer.
  if (proto && isE2EIdentityOverrideEnabled()) {
    return { "x-recognized-email": proto.email };
  }
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      return { Authorization: `Bearer ${data.session.access_token}` };
    }
  } catch {
    // supabase not configured
  }
  // Bearer absent → fall back to the prototype recognized identity.
  if (proto) return { "x-recognized-email": proto.email };
  return {};
}

// Phase 1 trust cleanup: defaults are fully empty.  The previous seed list
// (canonical taxonomy + sources mined from fixture stories) silently planted
// real-looking selections before the user had configured anything, which
// then drove fabricated chips/filters in the UI.  An empty default makes the
// unconfigured state honest — nothing has been chosen yet.
export function defaultSettingsPayload(): SettingsPayload {
  return settingsPayloadSchema.parse({
    contractVersion: CONTRACT_VERSION,
    topics: [],
    keywords: [],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
  });
}

export type SaveSettingsResult = SettingsPayload & {
  _meta?: {
    extractionStatus?: "not_attempted" | "succeeded" | "failed";
    // Slice 6/8: cold-start prefetch job handle (=== userId) returned when the
    // onboarding save kicked off a refresh; surfaced for the dashboard handoff.
    refreshJobId?: string;
    // Step 1 (onboarding meta-stories): viability metadata emitted only when an
    // onboarding narrative was provided. totalSourceCount is the merged
    // post-extraction source count; onboardingViable === (extraction succeeded
    // && totalSourceCount > 0). Lets the client route without inferring
    // viability from payload shape.
    totalSourceCount?: number;
    onboardingViable?: boolean;
  };
};

export class SaveSettingsError extends Error {
  readonly stage: "backend" | "network";
  readonly statusCode?: number;

  constructor(stage: "backend" | "network", statusCode?: number) {
    const detail =
      stage === "backend"
        ? statusCode !== undefined
          ? `backend: HTTP ${statusCode}`
          : "backend"
        : "network";
    super(`Identity-bound settings write failed (${detail}).`);
    this.name = "SaveSettingsError";
    this.stage = stage;
    this.statusCode = statusCode;
  }
}

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
  let response: Response;
  try {
    response = await fetch(SETTINGS_API_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(requestBody),
    });
  } catch {
    // Transport-level failure — no HTTP response received.
    if (isIdentityBound) throw new SaveSettingsError("network");
    await wait(MOCK_LATENCY_MS);
    localStorage.setItem(storageKey, JSON.stringify(validated));
    return validated;
  }

  if (!response.ok) {
    // Server responded but with a non-2xx status.
    if (isIdentityBound) throw new SaveSettingsError("backend", response.status);
    await wait(MOCK_LATENCY_MS);
    localStorage.setItem(storageKey, JSON.stringify(validated));
    return validated;
  }

  const raw = (await response.json()) as SaveSettingsResult;
  const persisted = settingsPayloadSchema.parse(raw);
  localStorage.setItem(storageKey, JSON.stringify(persisted));
  return raw._meta ? { ...persisted, _meta: raw._meta } : persisted;
}

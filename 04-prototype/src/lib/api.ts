import {
  CONTRACT_VERSION,
  dashboardPayloadSchema,
  dashboardSelectionMetaSchema,
  type DashboardPayload,
  type DashboardSelectionMeta,
} from "@tempo/contracts";
import { STORIES, type Story } from "@/data/stories";
import { supabase } from "./supabase";
import { getProtoSession } from "./auth";

export interface DashboardFetchResult {
  payload: DashboardPayload;
  selection: DashboardSelectionMeta | null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DEFAULT_ENDPOINT = "/api/dashboard";
const DEFAULT_RETRIES = 2;
const RETRY_BACKOFF_MS = 200;

interface FetchDashboardOptions {
  endpoint?: string;
  retries?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function localFallbackPayload(stories: Story[] = STORIES): DashboardPayload {
  return dashboardPayloadSchema.parse({
    contractVersion: CONTRACT_VERSION,
    stories,
  });
}

function parseSelectionMetaSafe(raw: unknown): DashboardSelectionMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const result = dashboardSelectionMetaSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// Mirrors server-side resolver precedence: bearer > email_recognition.
// Not production auth for the email path — prototype identity layer only.
async function buildIdentityHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      return { Authorization: `Bearer ${data.session.access_token}` };
    }
  } catch { /* supabase not configured */ }
  const proto = getProtoSession();
  if (proto) return { "x-recognized-email": proto.email };
  return {};
}

export async function fetchDashboardPayload(
  options: FetchDashboardOptions = {}
): Promise<DashboardPayload> {
  const result = await fetchDashboardWithMeta(options);
  return result.payload;
}

/**
 * Phase 2: returns both the parsed payload AND `_meta.selection` so the
 * dashboard can render small status cues (fallback used / unmatched names /
 * strict-empty).  `_meta` is read off the raw response — the payload itself
 * is still validated against `dashboardPayloadSchema`.
 */
export async function fetchDashboardWithMeta(
  options: FetchDashboardOptions = {}
): Promise<DashboardFetchResult> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? wait;

  const identityHeaders = await buildIdentityHeaders();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...identityHeaders,
        },
      });
      if (!response.ok) {
        throw new Error(`Dashboard API returned HTTP ${response.status}`);
      }
      const raw = (await response.json()) as { _meta?: { selection?: unknown } };
      const payload = dashboardPayloadSchema.parse(raw);
      const selection = parseSelectionMetaSafe(raw?._meta?.selection);
      return { payload, selection };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (attempt === retries) {
        return { payload: localFallbackPayload(), selection: null };
      }
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  return { payload: localFallbackPayload(), selection: null };
}

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

export interface DashboardBootstrapResult extends DashboardFetchResult {
  /**
   * Backend's decision about how to satisfy the bootstrap request.
   * `null` only when the response was a contract-validated payload but the
   * server omitted the field (older API), or when a network failure forced
   * a local fallback.
   */
  decision: DashboardBootstrapDecision | null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DEFAULT_ENDPOINT = "/api/dashboard";
const DEFAULT_BOOTSTRAP_ENDPOINT = "/api/dashboard/bootstrap";
const DEFAULT_RETRIES = 2;
const RETRY_BACKOFF_MS = 200;

interface FetchDashboardOptions {
  endpoint?: string;
  retries?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type DashboardBootstrapDecision =
  | "served_fresh_snapshot"
  | "ran_refresh"
  | "no_snapshot";

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

const VALID_BOOTSTRAP_DECISIONS: ReadonlySet<DashboardBootstrapDecision> = new Set([
  "served_fresh_snapshot",
  "ran_refresh",
  "no_snapshot",
]);

function parseBootstrapDecision(raw: unknown): DashboardBootstrapDecision | null {
  if (typeof raw !== "string") return null;
  return VALID_BOOTSTRAP_DECISIONS.has(raw as DashboardBootstrapDecision)
    ? (raw as DashboardBootstrapDecision)
    : null;
}

/**
 * Phase 5 dashboard bootstrap.
 *
 * POSTs to `/api/dashboard/bootstrap` so the backend can decide whether the
 * persisted snapshot is fresh enough (≤ 60 min) to serve as-is, or whether
 * it needs to run the refresh pipeline before responding.  Should ONLY be
 * called on the dedicated entry surfaces (Landing → Dashboard for recognized
 * users, and Onboarding → Dashboard post-submit).  Other in-app navigations
 * use `fetchDashboardPayload` / `fetchDashboardWithMeta` (GET) so we don't
 * thrash the pipeline on every link click.
 */
export async function bootstrapDashboard(
  options: FetchDashboardOptions = {}
): Promise<DashboardBootstrapResult> {
  const endpoint = options.endpoint ?? DEFAULT_BOOTSTRAP_ENDPOINT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? wait;

  const identityHeaders = await buildIdentityHeaders();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...identityHeaders,
        },
      });
      if (!response.ok) {
        throw new Error(`Bootstrap API returned HTTP ${response.status}`);
      }
      const raw = (await response.json()) as { _meta?: { selection?: unknown; bootstrapDecision?: unknown } };
      const payload = dashboardPayloadSchema.parse(raw);
      const selection = parseSelectionMetaSafe(raw?._meta?.selection);
      const decision = parseBootstrapDecision(raw?._meta?.bootstrapDecision);
      return { payload, selection, decision };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (attempt === retries) {
        return { payload: localFallbackPayload(), selection: null, decision: null };
      }
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  return { payload: localFallbackPayload(), selection: null, decision: null };
}

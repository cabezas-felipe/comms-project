import {
  dashboardPayloadSchema,
  dashboardSelectionMetaSchema,
  type DashboardPayload,
  type DashboardSelectionMeta,
} from "@tempo/contracts";
import { supabase } from "./supabase";
import { getProtoSession } from "./auth";

export interface DashboardFetchResult {
  payload: DashboardPayload;
  selection: DashboardSelectionMeta | null;
  /**
   * ISO-8601 timestamp lifted from `_meta.refreshedAt`. `null` when the
   * backend omits it or supplies a value that does not parse as a Date.
   * Parsed defensively off the raw response — not part of the contract
   * schema — so older/forward responses can't break dashboard fetches.
   */
  refreshedAt: string | null;
  /**
   * ISO-8601 timestamp lifted from `_meta.lastCheckedAt`.  Distinct from
   * `refreshedAt`: this is the last time the server *checked* the user's
   * feeds (advances on every refresh attempt, including no-ops like
   * watermark short-circuits and in-flight skips).  `refreshedAt` only
   * advances when a new snapshot is written.  `null` when the response is
   * from an older API that doesn't carry the field — callers should fall
   * back to `refreshedAt` for display.
   */
  lastCheckedAt: string | null;
  /**
   * Clustering fail-closed diagnostics lifted from `_meta` (Slice 1 server
   * contract).  When `clusteringFailed` is true the refresh succeeded HTTP-wise
   * but clustering failed after its retry, so the backend published zero
   * meta-stories on purpose — the UI must distinguish this from a quiet beat.
   *
   * `clusteringFailed` is derived from `_meta.usedFallbackClustering === true`
   * (note: the server field name is retained for back-compat; its semantics are
   * "clustering failed → 0 stories", NOT "degraded buckets shipped").  Parsed
   * defensively off the raw `_meta` — never schema-validated — so older or
   * forward responses can't break dashboard fetches.
   */
  clusteringFailed: boolean;
  clusteringFailureReason: "timeout" | "error" | null;
  clusteringAttempts: number | null;
  /** Per-attempt clustering latency (ms). Optional for the UI; null when absent/malformed. */
  clusteringLatencyMs: number[] | null;
}

interface DashboardClusteringMeta {
  clusteringFailed: boolean;
  clusteringFailureReason: "timeout" | "error" | null;
  clusteringAttempts: number | null;
  clusteringLatencyMs: number[] | null;
}

export interface DashboardBootstrapResult extends DashboardFetchResult {
  /**
   * Backend's decision about how to satisfy the bootstrap request.
   * `null` only when the response was a contract-validated payload but the
   * server omitted the field (older API).
   */
  decision: DashboardBootstrapDecision | null;
}

/**
 * Error thrown when the dashboard endpoint fails after retries are exhausted.
 * Wraps the last underlying cause so the UI can surface a precise message and
 * the caller can branch on `kind` for empty/error rendering.
 */
export class DashboardFetchError extends Error {
  readonly kind: "http" | "network" | "contract" | "abort";
  readonly status?: number;
  constructor(kind: "http" | "network" | "contract" | "abort", message: string, status?: number) {
    super(message);
    this.name = "DashboardFetchError";
    this.kind = kind;
    this.status = status;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DEFAULT_ENDPOINT = "/api/dashboard";
const DEFAULT_BOOTSTRAP_ENDPOINT = "/api/dashboard/bootstrap";
const DEFAULT_REFRESH_ENDPOINT = "/api/dashboard/refresh";
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

/**
 * Coerce any non-Abort error caught in a fetch loop to a `DashboardFetchError`
 * with a stable `kind`. Pass-through when the error is already a typed
 * `DashboardFetchError` (e.g. an HTTP non-2xx thrown from inside the try
 * block), otherwise classify Zod parse failures as "contract" and everything
 * else as "network". Callers must handle AbortError before invoking this.
 */
function normalizeFetchError(error: unknown, fallbackMessage: string): DashboardFetchError {
  if (error instanceof DashboardFetchError) return error;
  const isContract = error instanceof Error && error.name === "ZodError";
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new DashboardFetchError(isContract ? "contract" : "network", message);
}

function parseSelectionMetaSafe(raw: unknown): DashboardSelectionMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const result = dashboardSelectionMetaSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function parseIsoTimestampSafe(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? raw : null;
}

const CLUSTERING_META_EMPTY: DashboardClusteringMeta = {
  clusteringFailed: false,
  clusteringFailureReason: null,
  clusteringAttempts: null,
  clusteringLatencyMs: null,
};

/**
 * Lift clustering fail-closed diagnostics off the raw `_meta`.  Tolerant of any
 * shape: a missing/garbled `_meta`, missing keys, or wrong types all degrade to
 * `clusteringFailed: false` with nulls elsewhere (a malformed response must
 * never read as "clustering failed").  Mirrors the defensive `_meta.selection`
 * pattern — never throws.
 */
function parseClusteringMetaSafe(meta: unknown): DashboardClusteringMeta {
  if (!meta || typeof meta !== "object") return CLUSTERING_META_EMPTY;
  const m = meta as Record<string, unknown>;
  const reason = m.clusteringFailureReason;
  const attempts = m.clusteringAttempts;
  const latency = m.clusteringLatencyMs;
  return {
    clusteringFailed: m.usedFallbackClustering === true,
    clusteringFailureReason:
      reason === "timeout" || reason === "error" ? reason : null,
    clusteringAttempts:
      typeof attempts === "number" && Number.isFinite(attempts) ? attempts : null,
    clusteringLatencyMs:
      Array.isArray(latency) &&
      latency.every((n) => typeof n === "number" && Number.isFinite(n))
        ? (latency as number[])
        : null,
  };
}

// Mirrors server-side resolver precedence: bearer > email_recognition.
// Not production auth for the email path — prototype identity layer only.
async function buildIdentityHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      // Guard against stale persisted sessions in dev: only send Bearer when
      // Supabase still recognizes the token as a valid user session.
      if (typeof supabase.auth.getUser === "function") {
        const { data: userData, error } = await supabase.auth.getUser(token);
        if (!error && userData?.user) {
          return { Authorization: `Bearer ${token}` };
        }
      } else {
        // Fallback for auth stubs/older clients where getUser is unavailable.
        return { Authorization: `Bearer ${token}` };
      }
    }
  } catch { /* supabase not configured */ }
  const proto = getProtoSession();
  if (proto) return { "x-recognized-email": proto.email };
  return {};
}

/**
 * Shared retry/backoff loop used by every dashboard endpoint helper.  Each
 * caller differs only by HTTP method, endpoint, label (for error messages),
 * and whether they need to lift extra fields off `_meta` (e.g. bootstrap's
 * `decision`).  `parseExtras` runs after contract validation succeeds and is
 * spread into the returned object.
 */
async function requestDashboard<TExtras extends object>({
  method,
  options,
  label,
  defaultEndpoint,
  parseExtras,
}: {
  method: "GET" | "POST";
  options: FetchDashboardOptions;
  label: string;
  defaultEndpoint: string;
  parseExtras?: (raw: { _meta?: Record<string, unknown> }) => TExtras;
}): Promise<DashboardFetchResult & TExtras> {
  const endpoint = options.endpoint ?? defaultEndpoint;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? wait;

  const identityHeaders = await buildIdentityHeaders();

  let lastError: DashboardFetchError | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method,
        headers: {
          Accept: "application/json",
          ...identityHeaders,
        },
      });
      if (!response.ok) {
        throw new DashboardFetchError(
          "http",
          `${label} API returned HTTP ${response.status}`,
          response.status
        );
      }
      const raw = (await response.json()) as { _meta?: Record<string, unknown> };
      const payload = dashboardPayloadSchema.parse(raw);
      const meta = raw?._meta;
      const selection = parseSelectionMetaSafe(meta?.selection);
      const refreshedAt = parseIsoTimestampSafe(meta?.refreshedAt);
      const lastCheckedAt = parseIsoTimestampSafe(meta?.lastCheckedAt);
      const clustering = parseClusteringMetaSafe(meta);
      const extras = parseExtras ? parseExtras(raw) : ({} as TExtras);
      return { payload, selection, refreshedAt, lastCheckedAt, ...clustering, ...extras };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const dfe = normalizeFetchError(error, `Unknown ${label.toLowerCase()} error`);
      lastError = dfe;
      if (attempt === retries) throw dfe;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  // unreachable — the loop either returns or throws on the final attempt
  throw lastError ?? new DashboardFetchError("network", `${label} fetch failed`);
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
  return requestDashboard({
    method: "GET",
    options,
    label: "Dashboard",
    defaultEndpoint: DEFAULT_ENDPOINT,
  });
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
  return requestDashboard<{ decision: DashboardBootstrapDecision | null }>({
    method: "POST",
    options,
    label: "Bootstrap",
    defaultEndpoint: DEFAULT_BOOTSTRAP_ENDPOINT,
    parseExtras: (raw) => ({
      decision: parseBootstrapDecision(raw?._meta?.bootstrapDecision),
    }),
  });
}

/**
 * Hourly background refresh from the mounted dashboard.
 *
 * Same shape as `fetchDashboardWithMeta` but POSTs to `/api/dashboard/refresh`
 * so the backend re-runs the pipeline (vs the GET path that returns the
 * persisted snapshot).  Identity headers, retry/backoff, and contract
 * validation match the other dashboard helpers so callers can treat the
 * result interchangeably.
 */
export async function refreshDashboard(
  options: FetchDashboardOptions = {}
): Promise<DashboardFetchResult> {
  return requestDashboard({
    method: "POST",
    options,
    label: "Refresh",
    defaultEndpoint: DEFAULT_REFRESH_ENDPOINT,
  });
}

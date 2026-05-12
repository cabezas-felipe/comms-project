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

function parseRefreshedAtSafe(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? raw : null;
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

  let lastError: DashboardFetchError | null = null;
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
        throw new DashboardFetchError(
          "http",
          `Dashboard API returned HTTP ${response.status}`,
          response.status
        );
      }
      const raw = (await response.json()) as {
        _meta?: { selection?: unknown; refreshedAt?: unknown };
      };
      const payload = dashboardPayloadSchema.parse(raw);
      const selection = parseSelectionMetaSafe(raw?._meta?.selection);
      const refreshedAt = parseRefreshedAtSafe(raw?._meta?.refreshedAt);
      return { payload, selection, refreshedAt };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const dfe = normalizeFetchError(error, "Unknown dashboard fetch error");
      lastError = dfe;
      if (attempt === retries) throw dfe;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  // unreachable — the loop either returns or throws on the final attempt
  throw lastError ?? new DashboardFetchError("network", "Dashboard fetch failed");
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

  let lastError: DashboardFetchError | null = null;
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
        throw new DashboardFetchError(
          "http",
          `Bootstrap API returned HTTP ${response.status}`,
          response.status
        );
      }
      const raw = (await response.json()) as {
        _meta?: { selection?: unknown; bootstrapDecision?: unknown; refreshedAt?: unknown };
      };
      const payload = dashboardPayloadSchema.parse(raw);
      const selection = parseSelectionMetaSafe(raw?._meta?.selection);
      const decision = parseBootstrapDecision(raw?._meta?.bootstrapDecision);
      const refreshedAt = parseRefreshedAtSafe(raw?._meta?.refreshedAt);
      return { payload, selection, decision, refreshedAt };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const dfe = normalizeFetchError(error, "Unknown bootstrap error");
      lastError = dfe;
      if (attempt === retries) throw dfe;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  throw lastError ?? new DashboardFetchError("network", "Bootstrap failed");
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
  const endpoint = options.endpoint ?? DEFAULT_REFRESH_ENDPOINT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? wait;

  const identityHeaders = await buildIdentityHeaders();

  let lastError: DashboardFetchError | null = null;
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
        throw new DashboardFetchError(
          "http",
          `Refresh API returned HTTP ${response.status}`,
          response.status
        );
      }
      const raw = (await response.json()) as {
        _meta?: { selection?: unknown; refreshedAt?: unknown };
      };
      const payload = dashboardPayloadSchema.parse(raw);
      const selection = parseSelectionMetaSafe(raw?._meta?.selection);
      const refreshedAt = parseRefreshedAtSafe(raw?._meta?.refreshedAt);
      return { payload, selection, refreshedAt };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const dfe = normalizeFetchError(error, "Unknown refresh error");
      lastError = dfe;
      if (attempt === retries) throw dfe;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  throw lastError ?? new DashboardFetchError("network", "Refresh failed");
}

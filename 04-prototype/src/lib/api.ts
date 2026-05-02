import {
  CONTRACT_VERSION,
  dashboardPayloadSchema,
  type DashboardPayload,
} from "@tempo/contracts";
import { STORIES, type Story } from "@/data/stories";
import { supabase } from "./supabase";
import { getProtoSession } from "./auth";

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
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? wait;

  // Build identity headers once for all retry attempts.
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
      const payload = await response.json();
      return dashboardPayloadSchema.parse(payload);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (attempt === retries) {
        return localFallbackPayload();
      }
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  return localFallbackPayload();
}

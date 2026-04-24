// Server-side PostHog telemetry. No-op when POSTHOG_API_KEY is absent.
// Uses Node's built-in fetch (Node 18+). All failures are swallowed — telemetry
// must never crash or slow down the request path.

function getPostHogConfig() {
  return {
    apiKey: process.env.POSTHOG_API_KEY ?? null,
    host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
  };
}

/**
 * Fire-and-forget PostHog server event.
 * @param {string} name   PostHog event name (e.g. "api_dashboard_requested")
 * @param {Record<string, unknown>} properties  Arbitrary key-value pairs
 */
export function trackServerEvent(name, properties = {}) {
  const { apiKey, host } = getPostHogConfig();
  if (!apiKey) return;
  fetch(`${host}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      event: name,
      distinct_id: "tempo-api-server",
      timestamp: new Date().toISOString(),
      properties: { ...properties, $lib: "tempo-api" },
    }),
  }).catch(() => {});
}

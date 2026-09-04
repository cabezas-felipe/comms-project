import { after, before, test } from "node:test";
import assert from "node:assert/strict";

// Import after env is set so lazy reads pick up the correct value.
const { trackServerEvent } = await import("./telemetry.mjs");

const savedKey = process.env.POSTHOG_API_KEY;
const savedFetch = globalThis.fetch;

after(() => {
  process.env.POSTHOG_API_KEY = savedKey ?? "";
  globalThis.fetch = savedFetch;
});

test("trackServerEvent is a no-op when POSTHOG_API_KEY is absent", async () => {
  process.env.POSTHOG_API_KEY = "";
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return new Response(null, { status: 200 }); };
  trackServerEvent("test_event", { x: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 0, "fetch must not be called without a PostHog key");
});

test("trackServerEvent POSTs to PostHog when key is set", async () => {
  process.env.POSTHOG_API_KEY = "phc-test-key";
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return new Response(null, { status: 200 }); };
  trackServerEvent("api_dashboard_requested", { storyCount: 3 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1, "fetch must be called once");
  assert.match(calls[0].url, /\/capture\//);
  assert.equal(calls[0].body.event, "api_dashboard_requested");
  assert.equal(calls[0].body.api_key, "phc-test-key");
  assert.equal(calls[0].body.distinct_id, "tempo-api-server");
  assert.equal(calls[0].body.properties.storyCount, 3);
  assert.equal(calls[0].body.properties.$lib, "tempo-api");
});

test("trackServerEvent uses POSTHOG_HOST when set", async () => {
  process.env.POSTHOG_API_KEY = "phc-test-key";
  process.env.POSTHOG_HOST = "https://eu.posthog.example";
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return new Response(null, { status: 200 }); };
  trackServerEvent("test_host", {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls[0].url, "https://eu.posthog.example/capture/");
  process.env.POSTHOG_HOST = undefined;
});

test("trackServerEvent swallows fetch errors without throwing", async () => {
  process.env.POSTHOG_API_KEY = "phc-test-key";
  globalThis.fetch = async () => { throw new Error("network unreachable"); };
  assert.doesNotThrow(() => trackServerEvent("test_event", {}));
  await new Promise((r) => setTimeout(r, 10));
});

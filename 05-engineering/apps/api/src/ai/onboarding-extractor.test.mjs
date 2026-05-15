import { test } from "node:test";
import assert from "node:assert/strict";

const {
  EXTRACT_PROMPT_VERSION,
  extractionOutputSchema,
  buildExtractionPrompt,
  extractOnboarding,
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  resolveTimeoutMs,
} = await import("./onboarding-extractor.mjs");

// ── metadata ─────────────────────────────────────────────────────────────────

test("EXTRACT_PROMPT_VERSION is a non-empty string", () => {
  assert.ok(typeof EXTRACT_PROMPT_VERSION === "string" && EXTRACT_PROMPT_VERSION.length > 0);
});

test("buildExtractionPrompt returns the input text unchanged", () => {
  const text = "Track OFAC sanctions and Colombia diplomacy.";
  assert.equal(buildExtractionPrompt(text), text);
});

// ── extractionOutputSchema ────────────────────────────────────────────────────

test("extractionOutputSchema accepts fully populated output", () => {
  const result = extractionOutputSchema.safeParse({
    topics: ["Diplomatic relations"],
    keywords: ["OFAC", "sanctions"],
    geographies: ["US", "Colombia"],
    traditionalSources: ["Reuters"],
    socialSources: ["@latamwatcher"],
  });
  assert.ok(result.success, JSON.stringify(result.error?.errors));
});

test("extractionOutputSchema accepts all-empty arrays", () => {
  const result = extractionOutputSchema.safeParse({
    topics: [],
    keywords: [],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
  });
  assert.ok(result.success);
});

test("extractionOutputSchema rejects missing fields", () => {
  const result = extractionOutputSchema.safeParse({ topics: ["Diplomacy"] });
  assert.ok(!result.success);
});

test("extractionOutputSchema rejects non-string array items", () => {
  const result = extractionOutputSchema.safeParse({
    topics: [42],
    keywords: [],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
  });
  assert.ok(!result.success);
});

test("extractionOutputSchema rejects empty-string array items", () => {
  const result = extractionOutputSchema.safeParse({
    topics: [""],
    keywords: [],
    geographies: [],
    traditionalSources: [],
    socialSources: [],
  });
  assert.ok(!result.success);
});

test("extractionOutputSchema rejects empty-string items in traditionalSources", () => {
  const result = extractionOutputSchema.safeParse({
    topics: [],
    keywords: [],
    geographies: [],
    traditionalSources: [""],
    socialSources: [],
  });
  assert.ok(!result.success);
});

// ── extractOnboarding — mock providers ───────────────────────────────────────

test("extractOnboarding returns all five fields with mock-anthropic-haiku", async () => {
  const result = await extractOnboarding(
    "Track OFAC sanctions and Colombia-US diplomatic stories. Trust Reuters.",
    "mock-anthropic-haiku"
  );
  assert.ok(Array.isArray(result.topics));
  assert.ok(Array.isArray(result.keywords));
  assert.ok(Array.isArray(result.geographies));
  assert.ok(Array.isArray(result.traditionalSources));
  assert.ok(Array.isArray(result.socialSources));
});

test("extractOnboarding mock stays conservative on diplomacy-only phrasing", async () => {
  const result = await extractOnboarding("bilateral diplomacy talks", "mock-anthropic-haiku");
  assert.ok(!result.topics.includes("Diplomatic relations"));
});

test("extractOnboarding mock detects Migration policy topic", async () => {
  const result = await extractOnboarding("migration policy and deportation routes", "mock-anthropic-haiku");
  assert.ok(result.topics.includes("Migration policy"));
});

test("extractOnboarding mock detects Colombia geography", async () => {
  const result = await extractOnboarding("Colombia bilateral talks.", "mock-anthropic-haiku");
  assert.ok(result.geographies.includes("Colombia"));
});

test("extractOnboarding mock detects Reuters as traditionalSource", async () => {
  const result = await extractOnboarding("Trust Reuters for coverage.", "mock-openai-mini");
  assert.ok(result.traditionalSources.includes("Reuters"));
});

test("extractOnboarding mock detects NYT and El Tiempo as traditionalSources", async () => {
  const result = await extractOnboarding("Read NYT and El Tiempo.", "mock-openai-mini");
  assert.ok(result.traditionalSources.includes("New York Times"));
  assert.ok(result.traditionalSources.includes("El Tiempo"));
});

test("extractOnboarding mock detects @-handle as socialSource", async () => {
  const result = await extractOnboarding("Follow @latamwatcher for updates.", "mock-anthropic-haiku");
  assert.ok(result.socialSources.includes("@latamwatcher"));
  assert.ok(!result.traditionalSources.includes("@latamwatcher"));
});

test("extractOnboarding mock detects OFAC keyword", async () => {
  const result = await extractOnboarding("OFAC sanctions are key.", "mock-anthropic-haiku");
  assert.ok(result.keywords.includes("OFAC"));
});

test("extractOnboarding mock returns empty arrays for unrelated text", async () => {
  const result = await extractOnboarding("The weather is nice today.", "mock-anthropic-haiku");
  assert.deepEqual(result.topics, []);
  assert.deepEqual(result.keywords, []);
  assert.deepEqual(result.geographies, []);
  assert.deepEqual(result.traditionalSources, []);
  assert.deepEqual(result.socialSources, []);
});

test("extractOnboarding works with mock-openai-mini provider", async () => {
  const result = await extractOnboarding("Colombia diplomacy.", "mock-openai-mini");
  assert.ok(Array.isArray(result.topics));
  assert.ok(result.geographies.includes("Colombia"));
});

// ── extractOnboarding — key-missing errors ────────────────────────────────────

test("extractOnboarding throws when anthropic: model has no API key", async () => {
  const prevTempo = process.env.TEMPO_ANTHROPIC_API_KEY;
  const prevSdk = process.env.ANTHROPIC_API_KEY;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => extractOnboarding("text", "anthropic:claude-sonnet-4-6"),
      /TEMPO_ANTHROPIC_API_KEY/
    );
  } finally {
    if (prevTempo !== undefined) process.env.TEMPO_ANTHROPIC_API_KEY = prevTempo;
    if (prevSdk !== undefined) process.env.ANTHROPIC_API_KEY = prevSdk;
  }
});

test("extractOnboarding throws when openai: model has no API key", async () => {
  const prevTempo = process.env.TEMPO_OPENAI_API_KEY;
  const prevSdk = process.env.OPENAI_API_KEY;
  delete process.env.TEMPO_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => extractOnboarding("text", "openai:gpt-4o"),
      /TEMPO_OPENAI_API_KEY/
    );
  } finally {
    if (prevTempo !== undefined) process.env.TEMPO_OPENAI_API_KEY = prevTempo;
    if (prevSdk !== undefined) process.env.OPENAI_API_KEY = prevSdk;
  }
});

test("extractOnboarding falls through to mock-openai for unknown model prefix (default routing)", async () => {
  const result = await extractOnboarding("Colombia diplomacy.", "unknown-provider:model");
  assert.ok(Array.isArray(result.topics));
  assert.ok(Array.isArray(result.traditionalSources));
  assert.ok(Array.isArray(result.socialSources));
});

// ── timeout default + override ───────────────────────────────────────────────

test("DEFAULT_EXTRACTION_TIMEOUT_MS is the production-safe 15s", () => {
  // Regression guard: the old 1.2s default caused both Opus + Sonnet to time
  // out simultaneously and silently degrade onboarding to a baseline-only
  // persist. Anything under 5s is a regression.
  assert.equal(DEFAULT_EXTRACTION_TIMEOUT_MS, 15000);
});

test("resolveTimeoutMs returns the default when TEMPO_AI_TIMEOUT_MS is unset", () => {
  const prev = process.env.TEMPO_AI_TIMEOUT_MS;
  delete process.env.TEMPO_AI_TIMEOUT_MS;
  try {
    assert.equal(resolveTimeoutMs(), DEFAULT_EXTRACTION_TIMEOUT_MS);
  } finally {
    if (prev !== undefined) process.env.TEMPO_AI_TIMEOUT_MS = prev;
  }
});

test("resolveTimeoutMs returns the default when TEMPO_AI_TIMEOUT_MS is empty string", () => {
  const prev = process.env.TEMPO_AI_TIMEOUT_MS;
  process.env.TEMPO_AI_TIMEOUT_MS = "";
  try {
    assert.equal(resolveTimeoutMs(), DEFAULT_EXTRACTION_TIMEOUT_MS);
  } finally {
    if (prev !== undefined) process.env.TEMPO_AI_TIMEOUT_MS = prev;
    else delete process.env.TEMPO_AI_TIMEOUT_MS;
  }
});

test("resolveTimeoutMs honors TEMPO_AI_TIMEOUT_MS override", () => {
  const prev = process.env.TEMPO_AI_TIMEOUT_MS;
  process.env.TEMPO_AI_TIMEOUT_MS = "20000";
  try {
    assert.equal(resolveTimeoutMs(), 20000);
  } finally {
    if (prev !== undefined) process.env.TEMPO_AI_TIMEOUT_MS = prev;
    else delete process.env.TEMPO_AI_TIMEOUT_MS;
  }
});

test("resolveTimeoutMs honors TEMPO_AI_TIMEOUT_MS=15000 (production .env baseline)", () => {
  // Pin the 15000ms path explicitly — this is the production baseline shipped
  // in apps/api/.env templates.  If a future refactor changes resolveTimeoutMs
  // semantics around this exact string, this assertion fails loudly.
  const prev = process.env.TEMPO_AI_TIMEOUT_MS;
  process.env.TEMPO_AI_TIMEOUT_MS = "15000";
  try {
    assert.equal(resolveTimeoutMs(), 15000);
  } finally {
    if (prev !== undefined) process.env.TEMPO_AI_TIMEOUT_MS = prev;
    else delete process.env.TEMPO_AI_TIMEOUT_MS;
  }
});

test("resolveTimeoutMs falls back to default when override is non-numeric or non-positive", () => {
  const prev = process.env.TEMPO_AI_TIMEOUT_MS;
  for (const bad of ["nope", "0", "-500", "NaN"]) {
    process.env.TEMPO_AI_TIMEOUT_MS = bad;
    assert.equal(
      resolveTimeoutMs(),
      DEFAULT_EXTRACTION_TIMEOUT_MS,
      `bad value "${bad}" should fall back to default`
    );
  }
  if (prev !== undefined) process.env.TEMPO_AI_TIMEOUT_MS = prev;
  else delete process.env.TEMPO_AI_TIMEOUT_MS;
});

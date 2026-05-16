import { test } from "node:test";
import assert from "node:assert/strict";

const {
  EXTRACT_PROMPT_VERSION,
  extractionOutputSchema,
  buildExtractionPrompt,
  extractOnboarding,
  sanitizeExtraction,
  MAX_ITEM_LENGTH,
  MAX_LIST_SIZE,
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

// ── sanitizeExtraction — open vocabulary survives hygiene ────────────────────
//
// Phase 1 removed the closed ALLOWED_TOPICS / ALLOWED_KEYWORDS gates. These
// tests pin the new behavior: model-emitted labels outside any prior allowlist
// must now survive sanitize unchanged.

test("sanitizeExtraction preserves open-vocab topics outside any prior allowlist", () => {
  const result = sanitizeExtraction(
    {
      topics: ["Cyberattack response", "Election integrity", "Renewable energy transition"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    "Coverage of the region's strategic shifts."
  );
  assert.ok(result.topics.includes("Cyberattack response"));
  assert.ok(result.topics.includes("Election integrity"));
  assert.ok(result.topics.includes("Renewable energy transition"));
});

test("sanitizeExtraction preserves open-vocab keywords outside any prior allowlist", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: ["fintech", "disinformation", "subsidies"],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    ""
  );
  assert.ok(result.keywords.includes("fintech"));
  assert.ok(result.keywords.includes("disinformation"));
  assert.ok(result.keywords.includes("subsidies"));
});

test("sanitizeExtraction preserves non-Latin / Unicode tokens across every axis", () => {
  // Regression guard for the ASCII-only junk filter that previously dropped
  // any token without an [a-z0-9] character, silently erasing valid Chinese,
  // Arabic, Cyrillic, and accented-Latin inputs.
  const result = sanitizeExtraction(
    {
      topics: ["中国", "العربية", "Москва"],
      keywords: ["习近平", "café", "elección"],
      geographies: ["México", "São Paulo"],
      traditionalSources: ["Le Monde", "El País"],
      socialSources: ["@中国", "@CancilleriaCol"],
    },
    ""
  );
  for (const t of ["中国", "العربية", "Москва"]) {
    assert.ok(result.topics.includes(t), `expected topic ${t} to survive`);
  }
  for (const k of ["习近平", "café", "elección"]) {
    assert.ok(result.keywords.includes(k), `expected keyword ${k} to survive`);
  }
  for (const g of ["México", "São Paulo"]) {
    assert.ok(result.geographies.includes(g), `expected geography ${g} to survive`);
  }
  for (const s of ["Le Monde", "El País"]) {
    assert.ok(result.traditionalSources.includes(s), `expected source ${s} to survive`);
  }
  for (const h of ["@中国", "@CancilleriaCol"]) {
    assert.ok(result.socialSources.includes(h), `expected handle ${h} to survive`);
  }
});

test("sanitizeExtraction still drops pure-punctuation items even in mixed-script payloads", () => {
  const result = sanitizeExtraction(
    {
      topics: ["…", "—", "中国", "  ", "..."],
      keywords: ["???", "—", "habit", "习近平"],
      geographies: ["…", "México"],
      traditionalSources: ["!!", "Le Monde"],
      socialSources: [],
    },
    ""
  );
  for (const junk of ["…", "—", "...", "???", "!!"]) {
    assert.ok(!result.topics.includes(junk));
    assert.ok(!result.keywords.includes(junk));
    assert.ok(!result.geographies.includes(junk));
    assert.ok(!result.traditionalSources.includes(junk));
  }
  assert.ok(result.topics.includes("中国"));
  assert.ok(result.keywords.includes("habit"));
  assert.ok(result.keywords.includes("习近平"));
  assert.ok(result.geographies.includes("México"));
  assert.ok(result.traditionalSources.includes("Le Monde"));
});

// ── sanitizeExtraction — junk drops ──────────────────────────────────────────

test("sanitizeExtraction drops empty, whitespace, and punctuation-only items", () => {
  const result = sanitizeExtraction(
    {
      topics: ["", "   ", "...", "Migration policy"],
      keywords: ["—", "@@", "OFAC"],
      geographies: [".", "Colombia"],
      traditionalSources: ["!", "Reuters"],
      socialSources: ["", "@latamwatcher"],
    },
    ""
  );
  assert.deepEqual(result.topics, ["Migration policy"]);
  assert.deepEqual(result.keywords, ["OFAC"]);
  assert.deepEqual(result.geographies, ["Colombia"]);
  assert.deepEqual(result.traditionalSources, ["Reuters"]);
  assert.deepEqual(result.socialSources, ["@latamwatcher"]);
});

test("sanitizeExtraction drops items longer than MAX_ITEM_LENGTH", () => {
  const tooLong = "A".repeat(MAX_ITEM_LENGTH + 1);
  const result = sanitizeExtraction(
    {
      topics: [tooLong, "Migration policy"],
      keywords: [tooLong, "OFAC"],
      geographies: [tooLong, "Colombia"],
      traditionalSources: [tooLong, "Reuters"],
      socialSources: [`@${tooLong}`, "@latamwatcher"],
    },
    ""
  );
  assert.ok(!result.topics.includes(tooLong));
  assert.ok(result.topics.includes("Migration policy"));
  assert.ok(!result.keywords.includes(tooLong));
  assert.ok(result.keywords.includes("OFAC"));
  assert.ok(!result.geographies.includes(tooLong));
  assert.ok(result.geographies.includes("Colombia"));
  assert.ok(!result.traditionalSources.includes(tooLong));
  assert.ok(result.traditionalSources.includes("Reuters"));
  assert.equal(result.socialSources.length, 1);
  assert.equal(result.socialSources[0], "@latamwatcher");
});

test("sanitizeExtraction drops malformed @-handles from socialSources", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: ["@", "@!@#", "@ space", "no-prefix", "@ValidHandle"],
    },
    ""
  );
  assert.deepEqual(result.socialSources, ["@ValidHandle"]);
});

test("sanitizeExtraction accepts broadened handle forms (dot, dash, underscore, digits, Unicode)", () => {
  // Real-world handles use separators across platforms (e.g. `dot.handle` on
  // some networks, `dash-handle` on others). The MVP hygiene rule allows any
  // mix of letters / numbers / `_` / `.` / `-` so we don't over-restrict.
  const handles = [
    "@dot.handle",
    "@dash-handle",
    "@under_score",
    "@digits123",
    "@a.b-c_d",
    "@中国",
  ];
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: handles,
    },
    ""
  );
  for (const h of handles) {
    assert.ok(result.socialSources.includes(h), `expected ${h} to survive`);
  }
});

test("sanitizeExtraction rejects handles that lack any letter / number after '@'", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: ["@", "@.", "@-", "@_", "@----", "@!", "@..."],
    },
    ""
  );
  assert.deepEqual(result.socialSources, []);
});

test("sanitizeExtraction rejects handles that contain forbidden characters (whitespace, '@', '/')", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: ["@with space", "@dot@handle", "@path/segment", "@StateDept"],
    },
    ""
  );
  assert.deepEqual(result.socialSources, ["@StateDept"]);
});

test("sanitizeExtraction routes @-handles only to socialSources, not other axes", () => {
  const result = sanitizeExtraction(
    {
      topics: ["@handleish", "Migration policy"],
      keywords: ["@notakeyword", "OFAC"],
      geographies: ["@notgeo", "Colombia"],
      traditionalSources: ["@nothandle", "Reuters"],
      socialSources: ["@LatamWatcher"],
    },
    ""
  );
  assert.ok(!result.topics.includes("@handleish"));
  assert.ok(!result.keywords.includes("@notakeyword"));
  assert.ok(!result.geographies.includes("@notgeo"));
  assert.ok(!result.traditionalSources.includes("@nothandle"));
  assert.ok(result.socialSources.includes("@LatamWatcher"));
});

// ── sanitizeExtraction — dedupe + sort + cap ─────────────────────────────────

test("sanitizeExtraction dedupes case-insensitively (first occurrence wins)", () => {
  const result = sanitizeExtraction(
    {
      topics: ["Migration policy", "MIGRATION POLICY", "migration policy"],
      keywords: ["OFAC", "ofac"],
      geographies: ["Colombia", "colombia"],
      traditionalSources: ["Reuters", "REUTERS"],
      socialSources: ["@StateDept", "@statedept"],
    },
    ""
  );
  assert.deepEqual(result.topics, ["Migration policy"]);
  assert.deepEqual(result.keywords, ["OFAC"]);
  assert.deepEqual(result.geographies, ["Colombia"]);
  assert.deepEqual(result.traditionalSources, ["Reuters"]);
  assert.deepEqual(result.socialSources, ["@StateDept"]);
});

test("sanitizeExtraction returns each axis sorted case-insensitively", () => {
  const sortedLowercase = (xs) =>
    [...xs].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const result = sanitizeExtraction(
    {
      topics: ["Trade policy", "Border policy", "Migration policy"],
      keywords: ["zebra", "alpha", "OFAC"],
      geographies: ["Venezuela", "Brazil", "Argentina"],
      traditionalSources: ["Reuters", "BBC", "Associated Press"],
      socialSources: ["@ZHandle", "@aHandle"],
    },
    ""
  );
  assert.deepEqual(result.topics, sortedLowercase(result.topics));
  assert.deepEqual(result.keywords, sortedLowercase(result.keywords));
  assert.deepEqual(result.geographies, sortedLowercase(result.geographies));
  assert.deepEqual(result.traditionalSources, sortedLowercase(result.traditionalSources));
  assert.deepEqual(result.socialSources, sortedLowercase(result.socialSources));
});

test("sanitizeExtraction caps each axis at MAX_LIST_SIZE", () => {
  const overflow = MAX_LIST_SIZE + 10;
  // Pad with leading zeros so alphabetical order matches numeric order.
  const pad = (i) => String(i).padStart(3, "0");
  const result = sanitizeExtraction(
    {
      topics: Array.from({ length: overflow }, (_, i) => `Topic ${pad(i)}`),
      keywords: Array.from({ length: overflow }, (_, i) => `kw${pad(i)}`),
      geographies: Array.from({ length: overflow }, (_, i) => `Geo${pad(i)}`),
      traditionalSources: Array.from({ length: overflow }, (_, i) => `Source ${pad(i)}`),
      socialSources: Array.from({ length: overflow }, (_, i) => `@handle${pad(i)}`),
    },
    ""
  );
  assert.equal(result.topics.length, MAX_LIST_SIZE);
  assert.equal(result.keywords.length, MAX_LIST_SIZE);
  assert.equal(result.geographies.length, MAX_LIST_SIZE);
  assert.equal(result.traditionalSources.length, MAX_LIST_SIZE);
  assert.equal(result.socialSources.length, MAX_LIST_SIZE);
});

// ── sanitizeExtraction — canonicalization stays intact ───────────────────────

test("sanitizeExtraction canonicalizes 'bilateral relations' to 'Diplomatic relations'", () => {
  const result = sanitizeExtraction(
    {
      topics: ["bilateral relations"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    ""
  );
  assert.deepEqual(result.topics, ["Diplomatic relations"]);
});

test("sanitizeExtraction canonicalizes bare 'Migration' to 'Migration policy'", () => {
  const result = sanitizeExtraction(
    {
      topics: ["Migration"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    ""
  );
  assert.deepEqual(result.topics, ["Migration policy"]);
});

test("sanitizeExtraction canonicalizes bare 'Trade' to 'Trade policy'", () => {
  const result = sanitizeExtraction(
    {
      topics: ["Trade"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    ""
  );
  assert.deepEqual(result.topics, ["Trade policy"]);
});

test("sanitizeExtraction collapses keyword plurals via synonym map ('outbreaks' → 'outbreak')", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: ["outbreaks", "vaccines"],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    ""
  );
  assert.ok(result.keywords.includes("outbreak"));
  assert.ok(result.keywords.includes("vaccine"));
});

// ── sanitizeExtraction — source normalization preserved ──────────────────────

test("sanitizeExtraction normalizes source aliases (NYT → New York Times, AP → Associated Press, BBC News → BBC)", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: ["NYT", "AP", "BBC News", "WSJ"],
      socialSources: [],
    },
    ""
  );
  assert.ok(result.traditionalSources.includes("New York Times"));
  assert.ok(result.traditionalSources.includes("Associated Press"));
  assert.ok(result.traditionalSources.includes("BBC"));
  assert.ok(result.traditionalSources.includes("Wall Street Journal"));
});

test("sanitizeExtraction drops bulletin-style entries from traditionalSources", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: ["WHO bulletins", "WHO bulletin", "BBC"],
      socialSources: [],
    },
    ""
  );
  assert.ok(!result.traditionalSources.some((n) => /\bbulletin/i.test(n)));
  assert.ok(result.traditionalSources.includes("BBC"));
});

test("sanitizeExtraction drops bare 'WHO' from traditionalSources (org, not outlet)", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: ["WHO", "BBC"],
      socialSources: [],
    },
    ""
  );
  assert.ok(!result.traditionalSources.includes("WHO"));
  assert.ok(result.traditionalSources.includes("BBC"));
});

// ── sanitizeExtraction — additive enrichment from text ───────────────────────

test("sanitizeExtraction adds Migration policy hint when text mentions migration", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    "We focus on migration patterns this year."
  );
  assert.ok(result.topics.includes("Migration policy"));
});

test("sanitizeExtraction adds OFAC keyword from text via KEYWORD_PATTERNS", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    "Track OFAC sanctions activity."
  );
  assert.ok(result.keywords.includes("OFAC"));
  assert.ok(result.keywords.includes("sanctions"));
});

test("sanitizeExtraction drops WHO keyword when only @WHO handle context is present (no bare 'who')", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: ["WHO"],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    "Follow @WHO for vaccine updates."
  );
  assert.ok(!result.keywords.includes("WHO"));
});

test("sanitizeExtraction keeps WHO keyword when bare 'who' appears in text", () => {
  const result = sanitizeExtraction(
    {
      topics: [],
      keywords: ["WHO"],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
    },
    "WHO published new guidance."
  );
  assert.ok(result.keywords.includes("WHO"));
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

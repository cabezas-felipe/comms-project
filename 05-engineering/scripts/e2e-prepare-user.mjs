#!/usr/bin/env node
// Two-phase E2E prep with a baseline guard.
//
// The race this guards against: the old flow started the web server *before*
// the user's baseline was locked clean. Any active session (a browser tab left
// open on http://localhost:8080, or a stale dev process) could hit the dashboard
// and re-write snapshot/lock rows in the window between reset and the browser
// step — leaving the run with a dirty baseline that looked clean at reset time.
//
// New sequence:
//   1. parse args
//   2. start API ONLY (no web yet)
//   3. e2e:reset-user
//   4. e2e:assert-clean        (post-reset baseline — must pass)
//   5. baseline guard re-check (second assert-clean, just before web start)
//   6. start web               (only after BOTH cleanliness checks pass)
//   7. e2e:preflight           (strict identity behavior unchanged)
//   8. emit PASS
//
// The orchestration (`prepareUser`) takes injectable side-effect deps so it can
// be unit-tested with no network / process spawning. The entry-point guard keeps
// the real deps (spawnSync / curl) off the import path, like e2e-assert-clean.mjs.

import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ─── pure helpers ────────────────────────────────────────────────────────────

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? "")
  );
}

export function parseArgs(argv) {
  const out = { userId: null, email: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-id") out.userId = argv[++i];
    else if (a === "--email") out.email = argv[++i];
    else throw new Error(`[e2e:prepare-user] Unknown argument: ${a}`);
  }
  if (!out.userId) throw new Error("[e2e:prepare-user] Missing --user-id <uuid>");
  if (!isUuid(out.userId)) {
    throw new Error(
      `[e2e:prepare-user] Invalid --user-id '${out.userId}'. Expected a real UUID (do not pass placeholders like <e06-user-id>).`
    );
  }
  if (!out.email) throw new Error("[e2e:prepare-user] Missing --email <email>");
  return out;
}

function indent(text, pad = "    ") {
  return String(text)
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/**
 * Actionable diagnostics for a failed baseline guard: the baseline was clean at
 * reset but dirty again before the browser step. Names the likely cause (active /
 * stale session) and the exact recovery steps, and embeds the assert-clean dirty
 * report when one was captured.
 */
export function guardFailureMessage({ userId, email, report } = {}) {
  const rerun = `npm run e2e:prepare-user -- --user-id ${userId ?? "<uuid>"} --email ${email ?? "<email>"}`;
  const lines = [
    `[e2e:prepare-user] BASELINE GUARD FAILED user_id=${userId}`,
    `  baseline dirtied between reset and browser startup — the user was clean`,
    `  immediately after reset but rows reappeared before the web server started.`,
    `  Likely cause: an active or stale session touching the same user (a browser`,
    `  tab still open on http://localhost:8080, or a leftover dev process) hitting`,
    `  the dashboard and re-creating snapshot/lock rows during prep.`,
    ``,
    `  To recover: close ALL http://localhost:8080 tabs (and any stray web/dev`,
    `  processes), then rerun:`,
    `    ${rerun}`,
  ];
  if (report) {
    lines.push("", "  dirty baseline details (from e2e:assert-clean):", indent(report));
  }
  return lines.join("\n");
}

// ─── orchestration (pure control flow; side effects are injected) ────────────

/**
 * Two-phase prep. `deps` carries every side effect so this can be unit-tested.
 *   deps.log(message)
 *   deps.startApi()
 *   deps.waitForApiHealth()
 *   deps.resetUser({ userId, email })
 *   deps.assertClean({ userId, label }) -> { ok: boolean, output: string }
 *   deps.detectActiveWebSessions?() -> string | null   (warning only, optional)
 *   deps.startWeb()
 *   deps.waitForWebReady()
 *   deps.preflight({ email })
 *
 * Invariant: web is NOT started until BOTH the post-reset check and the guard
 * re-check pass.
 */
export function prepareUser({ userId, email }, deps) {
  const {
    log,
    startApi,
    waitForApiHealth,
    resetUser,
    assertClean,
    detectActiveWebSessions,
    startWeb,
    waitForWebReady,
    preflight,
  } = deps;

  // Phase 1 — API only. No web until the baseline is locked clean.
  log("[e2e:prepare-user] phase 1: clean/start API watcher in background (no web yet)");
  startApi();
  waitForApiHealth();

  log("[e2e:prepare-user] reset user state");
  resetUser({ userId, email });

  log("[e2e:prepare-user] assert clean state (post-reset baseline)");
  const baseline = assertClean({ userId, label: "post-reset baseline" });
  if (!baseline.ok) {
    throw new Error(
      "[e2e:prepare-user] post-reset baseline check failed — reset did not produce a clean baseline " +
        "(see e2e:assert-clean report above)"
    );
  }

  // Optional robustness: warn (only) if something already looks active on :8080
  // before we open the guard window. Never destructive — informational.
  if (typeof detectActiveWebSessions === "function") {
    const warning = detectActiveWebSessions();
    if (warning) log(`[e2e:prepare-user] WARNING: ${warning}`);
  }

  // Phase 2 gate — second cleanliness check immediately before starting web.
  log("[e2e:prepare-user] baseline guard re-check (just before web start)");
  const guard = assertClean({ userId, label: "baseline guard" });
  if (!guard.ok) {
    throw new Error(guardFailureMessage({ userId, email, report: guard.output }));
  }

  // Phase 2 — only now is it safe to bring up the browser-facing web server.
  log("[e2e:prepare-user] phase 2: clean/start web dev server in background");
  startWeb();
  waitForWebReady();

  log("[e2e:prepare-user] runtime preflight");
  preflight({ email });

  log(`[e2e:prepare-user] PASS user_id=${userId} email=${email}`);
}

// ─── real side effects (entry-point only) ────────────────────────────────────

function runStep(label, command, args, env = {}) {
  console.log(`[e2e:prepare-user] ${label} -> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`[e2e:prepare-user] step failed: ${label} (exit ${result.status ?? "unknown"})`);
  }
}

/**
 * Run e2e:assert-clean and capture its output so the guard can re-surface the
 * dirty-table report. Output is echoed live too, preserving the prior UX.
 */
function runAssertClean({ userId }) {
  const result = spawnSync("npm", ["run", "e2e:assert-clean", "--", "--user-id", userId], {
    encoding: "utf8",
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) console.log(output);
  return { ok: result.status === 0, output };
}

function startApiWatcherInBackground() {
  const shellCommand = [
    "TEMPO_E2E_FORCE_FIRST_FULL_REFRESH=true",
    "TEMPO_E2E_STRICT_IDENTITY=true",
    "npm run dev:api:clean",
    '> "/tmp/tempo-e2e-api.log" 2>&1 &',
  ].join(" ");
  const result = spawnSync("sh", ["-lc", shellCommand], { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error("[e2e:prepare-user] failed to launch API watcher in background");
  }
}

function startWebInBackground() {
  const shellCommand = [
    'web_port_pids=$(lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null || true);',
    'web_vite_pids=$(pgrep -f "04-prototype/node_modules/.bin/vite" 2>/dev/null || true);',
    'all_web_pids="$(printf "%s\\n%s\\n" "$web_port_pids" "$web_vite_pids" | awk "NF" | sort -u)";',
    'if [ -n "$all_web_pids" ]; then for pid in $all_web_pids; do kill -9 "$pid" 2>/dev/null || true; done; fi;',
    "VITE_E2E_IDENTITY_PRECEDENCE=recognized_email",
    "npm run dev:web",
    '> "/tmp/tempo-e2e-web.log" 2>&1 &',
  ].join(" ");
  const result = spawnSync("sh", ["-lc", shellCommand], { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error("[e2e:prepare-user] failed to launch web dev server in background");
  }
}

/**
 * Warning-only probe: is anything already listening on :8080 before we open the
 * guard window? A live browser tab there is the most common baseline-dirtier.
 * Deterministic and non-destructive — returns a message or null, never throws.
 */
function detectActiveWebSessions() {
  try {
    const raw = execSync('lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null || true', {
      encoding: "utf8",
    }).trim();
    const pids = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pids.length > 0) {
      return (
        `${pids.length} process(es) already listening on http://localhost:8080 (pids ${pids.join(", ")}). ` +
        `If a browser tab is open there it can re-dirty the baseline during prep — close all :8080 tabs.`
      );
    }
  } catch {
    // best-effort only
  }
  return null;
}

function waitForApiHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const code = execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/health', {
        encoding: "utf8",
      }).trim();
      if (code === "200") return;
    } catch {
      // keep polling
    }
    execSync("sleep 0.4");
  }
  throw new Error("[e2e:prepare-user] API /health did not become ready within 30s");
}

function waitForWebReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const code = execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:8080', {
        encoding: "utf8",
      }).trim();
      if (code === "200") return;
    } catch {
      // keep polling
    }
    execSync("sleep 0.4");
  }
  throw new Error("[e2e:prepare-user] web :8080 did not become ready within 30s");
}

/** Real side-effect deps wired to spawnSync / curl. */
function realDeps() {
  return {
    log: (m) => console.log(m),
    startApi: startApiWatcherInBackground,
    waitForApiHealth,
    resetUser: ({ userId, email }) =>
      runStep("reset user state", "npm", [
        "run",
        "e2e:reset-user",
        "--",
        "--user-id",
        userId,
        "--email",
        email,
      ]),
    assertClean: runAssertClean,
    detectActiveWebSessions,
    startWeb: startWebInBackground,
    waitForWebReady,
    preflight: ({ email }) =>
      runStep("runtime preflight", "npm", [
        "run",
        "e2e:preflight",
        "--",
        "--require-web",
        "--require-strict-identity",
        "--require-web-identity-override",
        "--identity-email",
        email,
      ]),
  };
}

function main() {
  const { userId, email } = parseArgs(process.argv.slice(2));
  prepareUser({ userId, email }, realDeps());
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  try {
    main();
  } catch (err) {
    console.error(`${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";

function parseArgs(argv) {
  const out = { userId: null, email: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-id") out.userId = argv[++i];
    else if (a === "--email") out.email = argv[++i];
    else throw new Error(`[e2e:prepare-user] Unknown argument: ${a}`);
  }
  if (!out.userId) throw new Error("[e2e:prepare-user] Missing --user-id <uuid>");
  if (!out.email) throw new Error("[e2e:prepare-user] Missing --email <email>");
  return out;
}

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

function main() {
  const { userId, email } = parseArgs(process.argv.slice(2));
  console.log("[e2e:prepare-user] clean/start API watcher in background");
  startApiWatcherInBackground();
  waitForApiHealth();
  console.log("[e2e:prepare-user] clean/start web dev server in background");
  startWebInBackground();
  waitForWebReady();
  runStep("reset user state", "npm", ["run", "e2e:reset-user", "--", "--user-id", userId, "--email", email]);
  runStep("assert clean state", "npm", ["run", "e2e:assert-clean", "--", "--user-id", userId]);
  runStep(
    "runtime preflight",
    "npm",
    [
      "run",
      "e2e:preflight",
      "--",
      "--require-web",
      "--require-strict-identity",
      "--require-web-identity-override",
      "--identity-email",
      email,
    ]
  );
  console.log(`[e2e:prepare-user] PASS user_id=${userId} email=${email}`);
}

try {
  main();
} catch (err) {
  console.error(`${err?.message ?? err}`);
  process.exitCode = 1;
}

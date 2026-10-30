#!/usr/bin/env node
import { execSync } from "node:child_process";

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const out = err?.stdout?.toString?.() ?? "";
    const msg = err?.stderr?.toString?.() ?? err?.message ?? String(err);
    throw new Error(`${cmd}\n${out}${msg}`.trim());
  }
}

function parseArgs(argv) {
  const out = {
    requireWeb: false,
    requireStrictIdentity: false,
    identityEmail: null,
    requireWebIdentityOverride: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--require-web") out.requireWeb = true;
    else if (a === "--require-strict-identity") out.requireStrictIdentity = true;
    else if (a === "--identity-email") out.identityEmail = argv[++i];
    else if (a === "--require-web-identity-override") out.requireWebIdentityOverride = true;
    else throw new Error(`[e2e:preflight] Unknown argument: ${a}`);
  }
  return out;
}

function hasEnvFlag(envDump, key) {
  return envDump.includes(`${key}=true`) || envDump.includes(`${key}=1`);
}

function checkApiListener(requireStrictIdentity) {
  const raw = sh("lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true");
  const pids = parsePidList(raw);
  if (pids.length !== 1) {
    throw new Error(
      `[e2e:preflight] expected exactly 1 API listener on :8787, found ${pids.length} (${pids.join(", ") || "none"})`
    );
  }
  const pid = pids[0];
  const env = sh(`ps eww -p ${pid}`);
  const hasForceFirst = hasEnvFlag(env, "TEMPO_E2E_FORCE_FIRST_FULL_REFRESH");
  if (!hasForceFirst) {
    throw new Error(
      `[e2e:preflight] API pid ${pid} missing TEMPO_E2E_FORCE_FIRST_FULL_REFRESH=true|1`
    );
  }
  if (requireStrictIdentity && !hasEnvFlag(env, "TEMPO_E2E_STRICT_IDENTITY")) {
    throw new Error(`[e2e:preflight] API pid ${pid} missing TEMPO_E2E_STRICT_IDENTITY=true|1`);
  }
  const code = sh("curl -s -o /dev/null -w \"%{http_code}\" http://localhost:8787/health");
  if (code !== "200") {
    throw new Error(`[e2e:preflight] /health returned ${code} (expected 200)`);
  }
  return { pid };
}

function checkWeb(requireWeb, requireWebIdentityOverride) {
  const code = sh("curl -s -o /dev/null -w \"%{http_code}\" http://localhost:8080");
  if (requireWeb && code !== "200") {
    throw new Error(`[e2e:preflight] web server on :8080 returned ${code} (expected 200)`);
  }
  const pids = parsePidList(sh("lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null || true"));
  if (requireWeb && pids.length !== 1) {
    throw new Error(
      `[e2e:preflight] expected exactly 1 web listener on :8080, found ${pids.length} (${pids.join(", ") || "none"})`
    );
  }
  if (requireWebIdentityOverride && pids.length === 1) {
    const env = sh(`ps eww -p ${pids[0]}`);
    if (!env.includes("VITE_E2E_IDENTITY_PRECEDENCE=recognized_email")) {
      throw new Error(
        `[e2e:preflight] web pid ${pids[0]} missing VITE_E2E_IDENTITY_PRECEDENCE=recognized_email`
      );
    }
  }
  return { code, pid: pids[0] ?? null };
}

function checkDebugIdentity(identityEmail, requireStrictIdentity) {
  if (!identityEmail) return null;
  const raw = sh(
    `curl -s "http://localhost:8787/api/debug/identity" -H "x-recognized-email: ${identityEmail}"`
  );
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[e2e:preflight] /api/debug/identity returned non-JSON payload`);
  }
  if (parsed?.identitySource !== "recognized_email") {
    throw new Error(
      `[e2e:preflight] /api/debug/identity expected identitySource=recognized_email, got ${parsed?.identitySource ?? "null"}`
    );
  }
  if (requireStrictIdentity && parsed?.strictIdentityEnabled !== true) {
    throw new Error("[e2e:preflight] /api/debug/identity reports strictIdentityEnabled=false");
  }
  return parsed;
}

function run() {
  const {
    requireWeb,
    requireStrictIdentity,
    identityEmail,
    requireWebIdentityOverride,
  } = parseArgs(process.argv.slice(2));
  const api = checkApiListener(requireStrictIdentity);
  const web = checkWeb(requireWeb, requireWebIdentityOverride);
  const identity = checkDebugIdentity(identityEmail, requireStrictIdentity);
  const identitySource = identity?.identitySource ?? "not_checked";
  console.log(
    `[e2e:preflight] PASS api_pid=${api.pid} web_pid=${web.pid ?? "none"} web_8080=${web.code} identity_source=${identitySource}`
  );
}

function parsePidList(raw) {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

try {
  run();
} catch (err) {
  console.error(`${err?.message ?? err}`);
  process.exitCode = 1;
}

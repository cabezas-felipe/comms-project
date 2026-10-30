import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Lightweight build-artifact check for the PWA manifest.
 * Resilient by design: if the project has not been built yet (no dist/),
 * the test is skipped rather than failing, so `npm run test` stays green
 * without requiring a prior build. When dist exists, it asserts the
 * installability-critical manifest fields.
 */
const manifestPath = resolve(__dirname, "../../dist/manifest.webmanifest");
const built = existsSync(manifestPath);

describe.skipIf(!built)("PWA build manifest", () => {
  const manifest = built
    ? JSON.parse(readFileSync(manifestPath, "utf-8"))
    : null;

  it("uses standalone display mode", () => {
    expect(manifest.display).toBe("standalone");
  });

  it("includes 192x192 and 512x512 icons", () => {
    const sizes = (manifest.icons ?? []).map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });
});

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CONTRACT_VERSION } from "@tempo/contracts";
import {
  REFRESH_WATCHDOG_MS,
  RefreshHeartbeatProvider,
  useRefreshContext,
  type AttemptToken,
  type SettleOptions,
} from "@/lib/refresh-context";
import type { DashboardFetchResult } from "@/lib/api";

const writeLastAttemptAtSpy = vi.fn();
// `readLastAttemptAt` is a spy too so individual tests can simulate
// scenarios where storage holds a newer (or older) value than the GET
// seed — the monotonic LS guard inside `seedAnchorIfMissing` must read the
// current persisted value before deciding whether to overwrite it.
// Defaults to null (cold-boot state) so existing tests keep working
// without per-test wiring.
const readLastAttemptAtSpy = vi.fn<[], number | null>(() => null);

// `refreshDashboard` is the API helper invoked by `triggerDashboardRefresh`.
// Each test wires up `mockResolvedValueOnce` / `mockRejectedValueOnce` to
// drive the success or failure path.  Defaults to a never-resolving promise
// so a test that forgets to wire it up doesn't accidentally settle the
// manual slot via the real network.
const refreshDashboardSpy = vi.fn<[], Promise<DashboardFetchResult>>(() => new Promise(() => {}));
vi.mock("@/lib/api", () => ({
  refreshDashboard: () => refreshDashboardSpy(),
}));

// The provider mounts `useRefreshHeartbeat` but for unit testing the context
// itself we replace it with an inert mock — the heartbeat hook has its own
// dedicated test file.  `seedAnchorIfMissing` / `recordAttemptStart` /
// `recordAttemptFinished` are exercised directly via the harness consumer.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ recognizedIdentity: { email: "u@example.com", userId: "u1" } }),
}));
vi.mock("@/lib/refresh-heartbeat", () => ({
  useRefreshHeartbeat: () => {},
  readLastAttemptAt: () => readLastAttemptAtSpy(),
  writeLastAttemptAt: (...args: unknown[]) => writeLastAttemptAtSpy(...args),
  LAST_REFRESH_ATTEMPT_KEY: "tempo_dashboard_last_refresh_attempt_at",
  REFRESH_INTERVAL_MS: 60 * 60 * 1000,
}));
vi.mock("@/lib/analytics", () => ({
  trackSourceOpenError: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({
  notifyError: vi.fn(),
}));

afterEach(() => {
  writeLastAttemptAtSpy.mockReset();
  readLastAttemptAtSpy.mockReset();
  // Restore the default cold-boot behavior so subsequent tests that don't
  // care about LS state aren't affected by a `mockReturnValueOnce` left
  // over from this test.
  readLastAttemptAtSpy.mockImplementation(() => null);
  refreshDashboardSpy.mockReset();
  refreshDashboardSpy.mockImplementation(() => new Promise(() => {}));
});

function HarnessConsumer({
  onRecord,
}: {
  onRecord: (record: (r: DashboardFetchResult) => void, value: string | null) => void;
}) {
  const { lastRefreshedAt, seedAnchorIfMissing } = useRefreshContext();
  onRecord(seedAnchorIfMissing, lastRefreshedAt);
  return <div data-testid="ts">{lastRefreshedAt ?? "none"}</div>;
}

function renderProvider(children: ReactNode) {
  return render(<RefreshHeartbeatProvider>{children}</RefreshHeartbeatProvider>);
}

function makeResult(overrides: Partial<DashboardFetchResult>): DashboardFetchResult {
  return {
    payload: { contractVersion: CONTRACT_VERSION, stories: [] },
    selection: null,
    refreshedAt: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

// `lastRefreshedAt` is now derived from the in-memory `lastAttemptAt` (ms),
// so the canonical ISO it emits always carries millisecond precision —
// `Date#toISOString()` format.  These helpers keep the assertions tied to
// canonical ISO regardless of what the server happened to return.
function toCanonicalIso(value: string): string {
  return new Date(value).toISOString();
}

describe("RefreshHeartbeatProvider — seedAnchorIfMissing (first paint)", () => {
  it("prefers lastCheckedAt over refreshedAt when both are present (first seed)", () => {
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => {
      recordFn!(
        makeResult({
          refreshedAt: "2026-05-08T08:00:00Z",
          lastCheckedAt: "2026-05-08T09:00:00Z",
        })
      );
    });
    expect(screen.getByTestId("ts").textContent).toBe(toCanonicalIso("2026-05-08T09:00:00Z"));
  });

  it("falls back to refreshedAt when lastCheckedAt is null (older API response)", () => {
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => {
      recordFn!(makeResult({ refreshedAt: "2026-05-08T08:00:00Z", lastCheckedAt: null }));
    });
    expect(screen.getByTestId("ts").textContent).toBe(toCanonicalIso("2026-05-08T08:00:00Z"));
  });

  it("leaves anchor as null when both timestamps are absent (no synthetic anchor from GET)", () => {
    // GET never invents an anchor from client wall-clock: a response with
    // no parseable `_meta.lastCheckedAt` / `refreshedAt` leaves the anchor
    // null and the header on "—" until a POST refresh provides one.
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => {
      recordFn!(makeResult({ refreshedAt: null, lastCheckedAt: null }));
    });
    expect(screen.getByTestId("ts").textContent).toBe("none");
  });

  it("does not move an anchor that is already set (GET remount after seed is a no-op)", () => {
    // Once any prior attempt (or earlier GET) has seeded the anchor, a
    // subsequent GET — e.g. a Settings → Dashboard remount — must not tick
    // the badge forward, even when the response carries a later server
    // timestamp.  Only POST refresh-style attempts advance the clock.
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    const first = "2026-05-08T08:00:00Z";
    const laterByOneHour = "2026-05-08T09:00:00Z";
    act(() => { recordFn!(makeResult({ lastCheckedAt: first })); });
    expect(screen.getByTestId("ts").textContent).toBe(toCanonicalIso(first));
    // A second GET arriving with a later timestamp must NOT advance the
    // anchor — only POST refresh-style attempts may do that.
    act(() => { recordFn!(makeResult({ lastCheckedAt: laterByOneHour })); });
    expect(screen.getByTestId("ts").textContent).toBe(toCanonicalIso(first));
  });
});

// ─── seedAnchorIfMissing → localStorage alignment ────────────────────────────
// On cold boot the heartbeat hook stamps `LAST_REFRESH_ATTEMPT_KEY` with
// `Date.now()` so a remount inside the 60-min window can't fire an extra
// tick.  Without persisting the GET seed, that "app opened" baseline would
// win on a full reload and the header would silently snap back to the
// app-open moment instead of the server's `lastCheckedAt`.  `seedAnchorIfMissing`
// MUST mirror the seeded value into localStorage so reload, cross-tab
// rehydration, and heartbeat scheduling all share the same baseline as the
// visible badge.

describe("RefreshHeartbeatProvider — seedAnchorIfMissing persists to localStorage", () => {
  it("writes the server timestamp to localStorage when seeding a null anchor", () => {
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    expect(writeLastAttemptAtSpy).not.toHaveBeenCalled();

    const serverIso = "2026-05-08T09:00:00Z";
    act(() => { recordFn!(makeResult({ lastCheckedAt: serverIso })); });

    expect(writeLastAttemptAtSpy).toHaveBeenCalledTimes(1);
    expect(writeLastAttemptAtSpy).toHaveBeenCalledWith(Date.parse(serverIso));
  });

  it("writes refreshedAt when lastCheckedAt is null (older API fallback path)", () => {
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    const fallbackIso = "2026-05-08T07:30:00Z";
    act(() => {
      recordFn!(makeResult({ lastCheckedAt: null, refreshedAt: fallbackIso }));
    });
    expect(writeLastAttemptAtSpy).toHaveBeenCalledTimes(1);
    expect(writeLastAttemptAtSpy).toHaveBeenCalledWith(Date.parse(fallbackIso));
  });

  it("does NOT touch localStorage when both server timestamps are absent", () => {
    // Header stays on "—" AND localStorage stays untouched — we never
    // synthesize a client-time anchor on the GET path, even in storage.
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => {
      recordFn!(makeResult({ lastCheckedAt: null, refreshedAt: null }));
    });
    expect(writeLastAttemptAtSpy).not.toHaveBeenCalled();
  });

  it("two synchronous seed calls in the same tick produce exactly one localStorage write", () => {
    // Hardening guarantee: under React's concurrent rendering and
    // StrictMode's double-invocation of pure updaters, a closure-flag
    // pattern inside `setLastAttemptAt(prev => …)` could fire the LS write
    // twice.  The provider's ref-gated implementation bails synchronously
    // on the second call, so the side effect runs once per logical seed.
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    const serverIso = "2026-05-08T09:00:00Z";
    act(() => {
      // Two calls inside one act / one tick — the second must see the ref
      // already advanced and bail before writing storage.
      recordFn!(makeResult({ lastCheckedAt: serverIso }));
      recordFn!(makeResult({ lastCheckedAt: serverIso }));
    });
    expect(writeLastAttemptAtSpy).toHaveBeenCalledTimes(1);
    expect(writeLastAttemptAtSpy).toHaveBeenCalledWith(Date.parse(serverIso));
  });

  it("does NOT overwrite a persisted value that is already newer than the GET seed (cross-tab race)", () => {
    // Scenario: another tab POSTed a real refresh after this tab's useState
    // initialization read storage (so this tab's React anchor is still
    // null), but BEFORE the storage event handler had a chance to advance
    // it.  The seed must not regress storage to the older server snapshot
    // timestamp — the cross-tab write is the authoritative latest attempt.
    const persistedIso = "2026-05-10T10:00:00Z";
    const serverIso = "2026-05-08T09:00:00Z";
    // useState init runs first and must see null (otherwise the seed gate
    // bails immediately because the React anchor is non-null).  Subsequent
    // reads — i.e. the one inside seedAnchorIfMissing's monotonic guard —
    // see the cross-tab value.
    readLastAttemptAtSpy.mockReturnValueOnce(null);
    readLastAttemptAtSpy.mockReturnValue(Date.parse(persistedIso));

    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => { recordFn!(makeResult({ lastCheckedAt: serverIso })); });

    expect(writeLastAttemptAtSpy).not.toHaveBeenCalled();
  });

  it("DOES write when the persisted value is older than the GET seed (cold-boot baseline)", () => {
    // Typical cold-boot path: the heartbeat hook stamped LS with
    // `Date.now()` at app open, but that "app opened" baseline is much
    // older than the server's `lastCheckedAt`.  The seed must overwrite
    // it so a full reload rehydrates from the server clock, not the
    // app-open moment.
    //
    // (In a real cold boot the persisted "now" is actually NEWER than the
    // server's lastCheckedAt — the spec's `< serverMs` branch handles the
    // legitimate "we just learned about a newer server attempt" case;
    // here we exercise the symmetric path with an explicitly older LS
    // value to assert the monotonic guard's positive branch.)
    const persistedIso = "2026-05-05T08:00:00Z";
    const serverIso = "2026-05-08T09:00:00Z";
    readLastAttemptAtSpy.mockReturnValueOnce(null);
    readLastAttemptAtSpy.mockReturnValue(Date.parse(persistedIso));

    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    act(() => { recordFn!(makeResult({ lastCheckedAt: serverIso })); });

    expect(writeLastAttemptAtSpy).toHaveBeenCalledTimes(1);
    expect(writeLastAttemptAtSpy).toHaveBeenCalledWith(Date.parse(serverIso));
  });

  it("does NOT write to localStorage on a subsequent GET after the anchor is seeded", () => {
    // Mirrors a Settings → Dashboard remount that returns a newer
    // lastCheckedAt: React state is already set, the seed is a no-op, and
    // the storage write must be skipped too — otherwise we'd regress
    // monotonicity by overwriting a real refresh time with a stale GET
    // snapshot.
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    const first = "2026-05-08T08:00:00Z";
    const laterByOneHour = "2026-05-08T09:00:00Z";
    act(() => { recordFn!(makeResult({ lastCheckedAt: first })); });
    expect(writeLastAttemptAtSpy).toHaveBeenCalledTimes(1);
    expect(writeLastAttemptAtSpy).toHaveBeenLastCalledWith(Date.parse(first));

    // Second GET — anchor is non-null, seed is a no-op, no LS write.
    act(() => { recordFn!(makeResult({ lastCheckedAt: laterByOneHour })); });
    expect(writeLastAttemptAtSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── recordAttemptStart / recordAttemptFinished semantics ────────────────────
// Under the unified anchor contract:
//   - recordAttemptStart only flips the in-flight flag.  The anchor must
//     stay put until settlement so the header doesn't tick forward while
//     the user is still waiting on the response.
//   - recordAttemptFinished advances `lastAttemptAt` to "now" on every
//     settlement (success, no-op, failure) so header + footer move
//     together and the badge can never lag behind the countdown.

interface AttemptHarnessApi {
  isRefreshing: boolean;
  lastAttemptAt: number | null;
  lastRefreshedAt: string | null;
  heartbeatResult: DashboardFetchResult | null;
  recordAttemptStart: () => AttemptToken;
  recordAttemptFinished: (token?: AttemptToken, options?: SettleOptions) => void;
  triggerDashboardRefresh: () => Promise<DashboardFetchResult | null>;
}

function AttemptHarness({ onApi }: { onApi: (api: AttemptHarnessApi) => void }) {
  const ctx = useRefreshContext();
  onApi({
    isRefreshing: ctx.isRefreshing,
    lastAttemptAt: ctx.lastAttemptAt,
    lastRefreshedAt: ctx.lastRefreshedAt,
    heartbeatResult: ctx.heartbeatResult,
    recordAttemptStart: ctx.recordAttemptStart,
    recordAttemptFinished: ctx.recordAttemptFinished,
    triggerDashboardRefresh: ctx.triggerDashboardRefresh,
  });
  return (
    <div>
      <span data-testid="refreshing">{String(ctx.isRefreshing)}</span>
      <span data-testid="last-attempt">{String(ctx.lastAttemptAt)}</span>
      <span data-testid="last-refreshed">{ctx.lastRefreshedAt ?? "none"}</span>
      <span data-testid="heartbeat-iso">
        {ctx.heartbeatResult?.lastCheckedAt ?? ctx.heartbeatResult?.refreshedAt ?? "none"}
      </span>
    </div>
  );
}

describe("RefreshHeartbeatProvider — attempt lifecycle", () => {
  it("recordAttemptStart flips isRefreshing without advancing lastAttemptAt or touching storage", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    expect(screen.getByTestId("last-attempt").textContent).toBe("null");
    expect(writeLastAttemptAtSpy).not.toHaveBeenCalled();

    act(() => { api!.recordAttemptStart(); });

    expect(screen.getByTestId("refreshing").textContent).toBe("true");
    // Critical: anchor stays put during the fetch — the header should not
    // advance while the user is still waiting.
    expect(screen.getByTestId("last-attempt").textContent).toBe("null");
    expect(writeLastAttemptAtSpy).not.toHaveBeenCalled();
  });

  it("recordAttemptFinished clears isRefreshing AND advances the anchor on settlement", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
    expect(screen.getByTestId("last-attempt").textContent).toBe("null");

    const beforeMs = Date.now();
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    // Anchor advanced — header + footer should now both reflect the
    // settlement moment instead of the prior (null) baseline.
    const ms = Number(screen.getByTestId("last-attempt").textContent);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(beforeMs);
    expect(screen.getByTestId("last-refreshed").textContent).toBe(new Date(ms).toISOString());
  });

  it("header + footer derive from the same anchor (lastRefreshedAt == ISO of lastAttemptAt)", () => {
    // Mathematical-consistency invariant: any time both views are read,
    // their corresponding numeric values agree exactly.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);
    act(() => { api!.recordAttemptStart(); });
    act(() => { api!.recordAttemptFinished(); });
    const ms = Number(screen.getByTestId("last-attempt").textContent);
    const iso = screen.getByTestId("last-refreshed").textContent ?? "";
    expect(Date.parse(iso)).toBe(ms);
  });

  it("counter semantics: two starts + one finish keeps isRefreshing true (overlapping attempts)", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // Simulate the heartbeat firing while the dashboard loader is also in
    // flight — both increment.  The first one to settle must not clear the
    // flag while the second is still pending.
    act(() => { api!.recordAttemptStart(); });
    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });

  it("recordAttemptFinished is clamped — extra finishes don't drive isRefreshing into an inconsistent state", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // Defensive: a stray finish (e.g. duplicate cleanup) must not leave the
    // counter negative so the next start still flips refreshing immediately.
    act(() => { api!.recordAttemptFinished(); });
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
  });

  it("anchor is monotonic — a stale settlement timestamp cannot regress lastAttemptAt", () => {
    // recordAttemptFinished({ result }) snaps to the server's lastCheckedAt
    // when present; a stray older payload (e.g. an out-of-order retry
    // response) must not pull the visible badge backward.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    const newer = "2026-05-08T10:00:00Z";
    const older = "2026-05-08T08:00:00Z";

    act(() => { api!.recordAttemptStart(); });
    act(() => {
      api!.recordAttemptFinished(undefined, {
        result: { ...makeResult({ lastCheckedAt: newer }) },
      });
    });
    expect(screen.getByTestId("last-refreshed").textContent).toBe(toCanonicalIso(newer));

    act(() => { api!.recordAttemptStart(); });
    act(() => {
      api!.recordAttemptFinished(undefined, {
        result: { ...makeResult({ lastCheckedAt: older }) },
      });
    });
    // Anchor stays at the newer value — monotonic by design.
    expect(screen.getByTestId("last-refreshed").textContent).toBe(toCanonicalIso(newer));
  });

  it("recordAttemptFinished({ advanceClock: false }) releases the slot without moving the anchor", () => {
    // Models bootstrap `served_fresh_snapshot`: the backend served the
    // persisted snapshot without running the refresh executor, so this
    // caller did NOT perform a refresh attempt.  The in-flight flag must
    // drop on settle, but the anchor must remain wherever a prior real
    // attempt left it.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // Seed anchor with a "real" attempt first so we can detect any
    // subsequent regression.
    const seededIso = "2026-05-10T10:00:00Z";
    act(() => { api!.recordAttemptStart(); });
    act(() => {
      api!.recordAttemptFinished(undefined, { result: makeResult({ lastCheckedAt: seededIso }) });
    });
    expect(screen.getByTestId("last-refreshed").textContent).toBe(toCanonicalIso(seededIso));

    // Now simulate a served_fresh_snapshot bootstrap: response carries a
    // later timestamp but advanceClock=false says "don't move the clock".
    const laterIso = "2026-05-10T11:00:00Z";
    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
    act(() => {
      api!.recordAttemptFinished(undefined, {
        result: makeResult({ lastCheckedAt: laterIso }),
        advanceClock: false,
      });
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    // Anchor stays at the seed time even though the bootstrap response
    // carried a newer server timestamp.
    expect(screen.getByTestId("last-refreshed").textContent).toBe(toCanonicalIso(seededIso));
  });

  it("recordAttemptFinished without a result advances anchor to client now() (failure fallback)", () => {
    // A refresh attempt that ends without a usable server timestamp (e.g.
    // the POST /refresh failed) must still move the clock so the next
    // countdown is bounded — only the GET path tolerates a missing anchor.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    const beforeMs = Date.now();
    act(() => { api!.recordAttemptStart(); });
    // No `result` — neither lastCheckedAt nor refreshedAt is available.
    act(() => { api!.recordAttemptFinished(); });
    const ms = Number(screen.getByTestId("last-attempt").textContent);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(beforeMs);
  });

  it("recordAttemptFinished prefers lastCheckedAt > refreshedAt > client now()", () => {
    // Display anchor prefers server-stamped lastCheckedAt; falls through to
    // refreshedAt; finally to client now() when neither is present.
    // Validates the precedence chain on a single attempt.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // lastCheckedAt wins over refreshedAt.
    act(() => { api!.recordAttemptStart(); });
    act(() => {
      api!.recordAttemptFinished(undefined, {
        result: makeResult({
          lastCheckedAt: "2026-05-10T12:00:00Z",
          refreshedAt: "2026-05-10T11:00:00Z",
        }),
      });
    });
    expect(screen.getByTestId("last-refreshed").textContent).toBe(
      toCanonicalIso("2026-05-10T12:00:00Z")
    );
  });
});

// ─── Token-based settlement: out-of-order pairing is exact ───────────────────
// `recordAttemptStart` returns an `AttemptToken`; `recordAttemptFinished(token)`
// settles that specific slot.  This protects overlapping attempts from
// settling each other's slots when completions arrive out of order.  Callers
// that don't thread the token still get safe FIFO settlement.

describe("RefreshHeartbeatProvider — token-based settlement", () => {
  it("recordAttemptStart returns a fresh AttemptToken per call (monotonic & distinct)", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    let tokenA: AttemptToken = -1;
    let tokenB: AttemptToken = -1;
    act(() => { tokenA = api!.recordAttemptStart(); });
    act(() => { tokenB = api!.recordAttemptStart(); });

    expect(typeof tokenA).toBe("number");
    expect(typeof tokenB).toBe("number");
    expect(tokenA).not.toBe(tokenB);
    // Settle both so we don't leak watchdog state into adjacent tests.
    act(() => { api!.recordAttemptFinished(tokenA); });
    act(() => { api!.recordAttemptFinished(tokenB); });
  });

  it("out-of-order settlement: finishing B first keeps A in-flight; then finishing A clears the flag", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    let tokenA: AttemptToken = -1;
    let tokenB: AttemptToken = -1;
    act(() => { tokenA = api!.recordAttemptStart(); });
    act(() => { tokenB = api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // B settles first — under FIFO this would have popped A's slot (wrong).
    // Token-based settlement removes exactly B's slot, leaving A pending.
    act(() => { api!.recordAttemptFinished(tokenB); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // A then settles — only now does the flag clear.
    act(() => { api!.recordAttemptFinished(tokenA); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });

  it("backward compat: finishing without a token uses safe FIFO and never goes negative", () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); });
    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Two no-arg finishes — pop oldest each time.  Two slots, two pops →
    // flag clears, no underflow.
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    // A stray extra no-arg finish must not corrupt state — the next start
    // still flips refreshing on cleanly.
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
  });

  it("mixed token + no-token finishes coexist in one lifecycle", () => {
    // Some call sites are token-aware (Dashboard loader, heartbeat); legacy
    // call sites may settle without one.  Both paths must drain cleanly.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    let tokenA: AttemptToken = -1;
    act(() => { tokenA = api!.recordAttemptStart(); });
    act(() => { api!.recordAttemptStart(); }); // B — token ignored on purpose
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Token settle of A removes A's slot precisely.
    act(() => { api!.recordAttemptFinished(tokenA); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Legacy no-arg settle of B — only one slot left, pop-oldest finds it.
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });

  it("settling with a stale token after the slot was already removed is a no-op", () => {
    // Mirrors a real-world race: a slow loader's `.finally(() => recordAttemptFinished(token))`
    // runs after a watchdog (or an early manual settle) already removed the
    // slot.  The stale token must NOT remove a different, newer slot.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    let tokenA: AttemptToken = -1;
    let tokenB: AttemptToken = -1;
    act(() => { tokenA = api!.recordAttemptStart(); });
    act(() => { api!.recordAttemptFinished(tokenA); }); // A drained
    act(() => { tokenB = api!.recordAttemptStart(); }); // B in flight
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Stale settle of A — filter finds no matching id, B's slot remains.
    act(() => { api!.recordAttemptFinished(tokenA); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // B legitimately settles.
    act(() => { api!.recordAttemptFinished(tokenB); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });
});

// ─── Watchdog: stale "Refreshing now…" cannot strand the UI ──────────────────
// A hung fetch (or a dropped settlement) must not leave the footer stuck on
// the in-flight copy.  Each in-flight attempt occupies its own per-attempt
// slot stamped with the moment it started; after REFRESH_WATCHDOG_MS, the
// provider expires only the slots that actually crossed the ceiling.  Newer
// overlapping slots survive so legitimate concurrent attempts still hold
// the in-flight flag until they themselves settle (or expire).  Server work
// continues — the watchdog never aborts the request.

describe("RefreshHeartbeatProvider — watchdog", () => {
  beforeEach(() => {
    // Fully synthetic clock: Date.now() only moves when a test explicitly
    // advances fake timers.  `shouldAdvanceTime` would let real wall-clock
    // drift slip in between a slot's push (Date.now() in pushSlot) and the
    // watchdog effect's Date.now() read on commit — that drift can push the
    // computed `fireIn` low enough that `advanceTimersByTimeAsync(WATCHDOG_MS - 1)`
    // ends up crossing the deadline under suite-level load.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-clears isRefreshing after the watchdog ceiling when no settlement arrives", async () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Sub-watchdog wait: still in-flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_WATCHDOG_MS - 1);
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Cross the ceiling — UI snaps back to countdown state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    // Anchor snapped forward so the next countdown is bounded, not negative.
    const ms = Number(screen.getByTestId("last-attempt").textContent);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it("does not fire when a settlement arrives before the watchdog ceiling", async () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    const settledMs = Number(screen.getByTestId("last-attempt").textContent);

    // Run past the watchdog ceiling — no additional state change should
    // happen, the anchor stays at the legitimate settlement time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_WATCHDOG_MS + 1_000);
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    expect(Number(screen.getByTestId("last-attempt").textContent)).toBe(settledMs);
  });

  it("a late settlement after a watchdog fire cannot drive isRefreshing negative", async () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_WATCHDOG_MS + 1);
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    // The original fetch eventually settles after the watchdog already
    // cleared the flag.  The counter must not go negative; the next
    // legitimate attempt must still flip the UI to in-flight.
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
  });

  it("expires only the stale slot — a newer overlapping attempt stays in-flight", async () => {
    // Repro for the over-clearing bug: a global pendingAttempts reset on
    // watchdog fire would briefly hide a still-running B attempt.  Under
    // the per-slot watchdog, only A's slot (started before the ceiling)
    // is dropped; B's slot (started 5s later) keeps the flag set.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // Attempt A starts at T=0.
    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Attempt B starts 5s later — both still in-flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    act(() => { api!.recordAttemptStart(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Cross only A's deadline (T+WATCHDOG_MS).  B has another 5s of
    // legitimate runway — its slot must survive the watchdog fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_WATCHDOG_MS - 5_000 + 1);
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // B legitimately settles — flag drops cleanly with no spurious negative
    // counter or leftover slot.
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });

  it("does not over-clear when a stale slot expires alongside multiple newer ones", async () => {
    // Heartbeat tick + dashboard retry + a second dashboard retry all
    // overlapping: only the eldest crosses the ceiling.  The two newer
    // slots must continue to assert in-flight.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); }); // A @ 0
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    act(() => { api!.recordAttemptStart(); }); // B @ 2s
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    act(() => { api!.recordAttemptStart(); }); // C @ 4s
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Cross A's deadline only — B and C are still well within runway.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_WATCHDOG_MS - 4_000 + 1);
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Two paired settlements drain B and C — flag releases.
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");
    act(() => { api!.recordAttemptFinished(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });

  it("anchor remains monotonic across a watchdog expiration interleaved with a fresh start", async () => {
    // Watchdog snaps the anchor forward when it expires a slot.  A
    // legitimate later start + finish must still leave the anchor at a
    // value >= the watchdog stamp, never regress it.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    act(() => { api!.recordAttemptStart(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_WATCHDOG_MS + 1);
    });
    const afterWatchdogMs = Number(screen.getByTestId("last-attempt").textContent);
    expect(Number.isFinite(afterWatchdogMs)).toBe(true);

    // Fresh attempt some time later — anchor must only advance.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    act(() => { api!.recordAttemptStart(); });
    act(() => { api!.recordAttemptFinished(); });
    const afterFinishMs = Number(screen.getByTestId("last-attempt").textContent);
    expect(afterFinishMs).toBeGreaterThanOrEqual(afterWatchdogMs);

    // Header (ISO) is kept in lockstep with the numeric anchor.
    expect(Date.parse(screen.getByTestId("last-refreshed").textContent ?? "")).toBe(
      afterFinishMs
    );
  });

  it("token settlement of an already-expired slot is a no-op and a newer token still settles cleanly", async () => {
    // Race: a slow loader holds a token whose slot was expired by the
    // watchdog before its `.finally` ran.  When the stale settle finally
    // arrives, it must NOT punch a hole in the in-flight list — a fresh
    // attempt started after the watchdog must still be tracked correctly.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    let staleToken: AttemptToken = -1;
    act(() => { staleToken = api!.recordAttemptStart(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_WATCHDOG_MS + 1);
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    // A new attempt begins after the watchdog already cleared the stale slot.
    let freshToken: AttemptToken = -1;
    act(() => { freshToken = api!.recordAttemptStart(); });
    expect(freshToken).not.toBe(staleToken);
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // The slow loader's `.finally` finally fires with the stale token —
    // no matching slot, so the fresh slot is preserved.
    act(() => { api!.recordAttemptFinished(staleToken); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // Fresh token settles cleanly.
    act(() => { api!.recordAttemptFinished(freshToken); });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
  });
});

// ─── triggerDashboardRefresh: manual entrypoint (Phase 2) ─────────────────────
// Settings save success calls into the context to force a fresh dashboard
// fetch.  The method must mirror the heartbeat lifecycle: flip `isRefreshing`
// on start, publish `heartbeatResult` on success, advance the anchor from
// server timestamps, surface the heartbeat error toast on failure, and always
// settle its own per-attempt slot regardless of outcome.

describe("RefreshHeartbeatProvider — triggerDashboardRefresh", () => {
  it("flips isRefreshing while the request is in flight and clears it on success", async () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // Controllable promise — lets us assert in-flight state before settlement.
    let resolve!: (r: DashboardFetchResult) => void;
    refreshDashboardSpy.mockImplementationOnce(
      () => new Promise<DashboardFetchResult>((res) => { resolve = res; })
    );

    expect(screen.getByTestId("refreshing").textContent).toBe("false");

    let pending!: Promise<DashboardFetchResult | null>;
    act(() => { pending = api!.triggerDashboardRefresh(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    const settledIso = "2026-05-12T10:00:00Z";
    await act(async () => {
      resolve(makeResult({ lastCheckedAt: settledIso }));
      await pending;
    });

    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    // Anchor advanced to the server-provided lastCheckedAt (not client now).
    expect(screen.getByTestId("last-refreshed").textContent).toBe(toCanonicalIso(settledIso));
    // heartbeatResult published so Dashboard re-renders against the fresh
    // payload without waiting for the next hourly tick.
    expect(screen.getByTestId("heartbeat-iso").textContent).toBe(settledIso);
  });

  it("returns the fetched result on success", async () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    const settledIso = "2026-05-12T11:00:00Z";
    refreshDashboardSpy.mockResolvedValueOnce(makeResult({ lastCheckedAt: settledIso }));

    let returned: DashboardFetchResult | null = null;
    await act(async () => {
      returned = await api!.triggerDashboardRefresh();
    });
    expect(returned).not.toBeNull();
    expect(returned!.lastCheckedAt).toBe(settledIso);
  });

  it("on failure: settles the slot, advances anchor to client now(), returns null", async () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    refreshDashboardSpy.mockRejectedValueOnce(new Error("network down"));

    const beforeMs = Date.now();
    let returned: DashboardFetchResult | null = null;
    await act(async () => {
      returned = await api!.triggerDashboardRefresh();
    });

    // Error path does NOT throw — callers can ignore the null return.
    expect(returned).toBeNull();
    // Slot drained.
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    // Anchor moved forward (no server timestamp available, falls back to
    // client now() — same fallback the heartbeat error path uses).
    const ms = Number(screen.getByTestId("last-attempt").textContent);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(beforeMs);
    // heartbeatResult is NOT clobbered by failure — Dashboard keeps showing
    // the previous successful run (matches the toast copy).
    expect(screen.getByTestId("heartbeat-iso").textContent).toBe("none");
  });

  it("does not regress the anchor when an older server timestamp arrives", async () => {
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    // First attempt seeds a newer anchor.
    refreshDashboardSpy.mockResolvedValueOnce(
      makeResult({ lastCheckedAt: "2026-05-12T12:00:00Z" })
    );
    await act(async () => { await api!.triggerDashboardRefresh(); });
    expect(screen.getByTestId("last-refreshed").textContent).toBe(
      toCanonicalIso("2026-05-12T12:00:00Z")
    );

    // Second attempt resolves with an older lastCheckedAt — anchor stays put.
    refreshDashboardSpy.mockResolvedValueOnce(
      makeResult({ lastCheckedAt: "2026-05-12T10:00:00Z" })
    );
    await act(async () => { await api!.triggerDashboardRefresh(); });
    expect(screen.getByTestId("last-refreshed").textContent).toBe(
      toCanonicalIso("2026-05-12T12:00:00Z")
    );
  });

  it("overlapping triggers each get their own slot and settle independently", async () => {
    // Burst protection: two manual refreshes back-to-back (e.g. a save burst
    // that escapes the upstream debounce) must hold isRefreshing true while
    // either is in flight, then drop it once both settle — no leaked slots,
    // no premature drop.
    let api: AttemptHarnessApi | null = null;
    renderProvider(<AttemptHarness onApi={(a) => { api = a; }} />);

    let resolveA!: (r: DashboardFetchResult) => void;
    let resolveB!: (r: DashboardFetchResult) => void;
    refreshDashboardSpy
      .mockImplementationOnce(() => new Promise<DashboardFetchResult>((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise<DashboardFetchResult>((r) => { resolveB = r; }));

    let pendingA!: Promise<DashboardFetchResult | null>;
    let pendingB!: Promise<DashboardFetchResult | null>;
    act(() => { pendingA = api!.triggerDashboardRefresh(); });
    act(() => { pendingB = api!.triggerDashboardRefresh(); });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // A settles — B still in flight, flag stays true.
    await act(async () => {
      resolveA(makeResult({ lastCheckedAt: "2026-05-12T13:00:00Z" }));
      await pendingA;
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("true");

    // B settles — flag drops.
    await act(async () => {
      resolveB(makeResult({ lastCheckedAt: "2026-05-12T14:00:00Z" }));
      await pendingB;
    });
    expect(screen.getByTestId("refreshing").textContent).toBe("false");
    // Anchor reflects the latest server timestamp.
    expect(screen.getByTestId("last-refreshed").textContent).toBe(
      toCanonicalIso("2026-05-12T14:00:00Z")
    );
  });
});

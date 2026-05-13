import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CONTRACT_VERSION } from "@tempo/contracts";
import {
  REFRESH_WATCHDOG_MS,
  RefreshHeartbeatProvider,
  useRefreshContext,
  type AttemptToken,
} from "@/lib/refresh-context";
import type { DashboardFetchResult } from "@/lib/api";

const writeLastAttemptAtSpy = vi.fn();

// The provider mounts `useRefreshHeartbeat` but for unit testing the context
// itself we replace it with an inert mock — the heartbeat hook has its own
// dedicated test file.  `recordSuccessfulRefresh` / `recordAttemptStart` /
// `recordAttemptFinished` are exercised directly via the harness consumer.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ recognizedIdentity: { email: "u@example.com", userId: "u1" } }),
}));
vi.mock("@/lib/refresh-heartbeat", () => ({
  useRefreshHeartbeat: () => {},
  readLastAttemptAt: () => null,
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
});

function HarnessConsumer({
  onRecord,
}: {
  onRecord: (record: (r: DashboardFetchResult) => void, value: string | null) => void;
}) {
  const { lastRefreshedAt, recordSuccessfulRefresh } = useRefreshContext();
  onRecord(recordSuccessfulRefresh, lastRefreshedAt);
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

describe("RefreshHeartbeatProvider — last-check display precedence", () => {
  it("prefers lastCheckedAt over refreshedAt when both are present", () => {
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

  it("falls back to 'now' when both timestamps are absent (still produces a valid anchor)", () => {
    // Older API responses without either timestamp must not strand the
    // header on "—" forever — the attempt happened, so the anchor advances
    // to settlement time as a defensive fallback.
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );
    const beforeMs = Date.now();
    act(() => {
      recordFn!(makeResult({ refreshedAt: null, lastCheckedAt: null }));
    });
    const after = screen.getByTestId("ts").textContent ?? "";
    expect(after).not.toBe("none");
    const afterMs = Date.parse(after);
    expect(Number.isFinite(afterMs)).toBe(true);
    expect(afterMs).toBeGreaterThanOrEqual(beforeMs);
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
  recordAttemptStart: () => AttemptToken;
  recordAttemptFinished: (token?: AttemptToken) => void;
}

function AttemptHarness({ onApi }: { onApi: (api: AttemptHarnessApi) => void }) {
  const ctx = useRefreshContext();
  onApi({
    isRefreshing: ctx.isRefreshing,
    lastAttemptAt: ctx.lastAttemptAt,
    lastRefreshedAt: ctx.lastRefreshedAt,
    recordAttemptStart: ctx.recordAttemptStart,
    recordAttemptFinished: ctx.recordAttemptFinished,
  });
  return (
    <div>
      <span data-testid="refreshing">{String(ctx.isRefreshing)}</span>
      <span data-testid="last-attempt">{String(ctx.lastAttemptAt)}</span>
      <span data-testid="last-refreshed">{ctx.lastRefreshedAt ?? "none"}</span>
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
    // recordSuccessfulRefresh adopts the server's lastCheckedAt; a stray
    // older payload (e.g. an out-of-order retry response) must not pull the
    // visible badge backward.
    let recordFn: ((r: DashboardFetchResult) => void) | null = null;
    renderProvider(
      <HarnessConsumer
        onRecord={(record) => {
          recordFn = record;
        }}
      />
    );

    const newer = "2026-05-08T10:00:00Z";
    const older = "2026-05-08T08:00:00Z";

    act(() => { recordFn!(makeResult({ lastCheckedAt: newer })); });
    expect(screen.getByTestId("ts").textContent).toBe(toCanonicalIso(newer));

    act(() => { recordFn!(makeResult({ lastCheckedAt: older })); });
    // Anchor stays at the newer value — monotonic by design.
    expect(screen.getByTestId("ts").textContent).toBe(toCanonicalIso(newer));
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

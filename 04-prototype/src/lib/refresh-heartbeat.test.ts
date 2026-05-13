import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@tempo/contracts";
import {
  LAST_REFRESH_ATTEMPT_KEY,
  REFRESH_INTERVAL_MS,
  readLastAttemptAt,
  useRefreshHeartbeat,
  writeLastAttemptAt,
} from "@/lib/refresh-heartbeat";

// In-memory Storage shim isolated per test so tests don't bleed through the
// real `window.localStorage`.
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage;
}

const OK_RESULT = {
  payload: { contractVersion: CONTRACT_VERSION, stories: [] },
  selection: null,
  refreshedAt: "2026-05-11T12:00:00Z",
  lastCheckedAt: "2026-05-11T12:00:00Z",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRefreshHeartbeat", () => {
  it("does not fire immediately on first mount when no prior attempt exists; stamps now and schedules an interval-distance tick", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    const onSuccess = vi.fn();
    const t0 = 1_000_000;

    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher,
        now: () => t0,
        storage,
        onSuccess,
      })
    );

    expect(fetcher).not.toHaveBeenCalled();
    // First mount writes the baseline timestamp so a remount cannot fire early.
    expect(readLastAttemptAt(storage)).toBe(t0);
    // Not due yet: just before the boundary.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS - 1);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fires immediately when stored timestamp is overdue (auth restore with overdue value)", async () => {
    const storage = createMemoryStorage();
    const t0 = 5_000_000;
    // Stored 2 hours ago — overdue by 1 hour.
    writeLastAttemptAt(t0 - 2 * REFRESH_INTERVAL_MS, storage);

    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    const onSuccess = vi.fn();

    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher,
        now: () => t0,
        storage,
        onSuccess,
      })
    );

    // Effect's evaluate() schedules a microtask via async tick — let it run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(OK_RESULT);
  });

  it("invariant: a remount inside the 60-min window does NOT push the next attempt past 60 min from the last attempt", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    let nowMs = 10_000_000;
    const now = () => nowMs;

    // First mount stamps `t0` and schedules tick at t0 + 60min.
    const first = renderHook(() =>
      useRefreshHeartbeat({ enabled: true, fetcher, now, storage })
    );
    expect(fetcher).not.toHaveBeenCalled();
    const t0 = nowMs;

    // 30 min pass and the user navigates: provider stays mounted in real app,
    // but we simulate a worst-case full remount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    });
    nowMs = t0 + 30 * 60 * 1000;
    first.unmount();

    const second = renderHook(() =>
      useRefreshHeartbeat({ enabled: true, fetcher, now, storage })
    );

    // 30 more minutes — exactly the original 60-min boundary from t0.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      nowMs = t0 + 60 * 60 * 1000;
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it("does not attempt before due time (no premature firing)", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    const t0 = 7_000_000;
    // Stored 10 min ago — 50 min still to go.
    writeLastAttemptAt(t0 - 10 * 60 * 1000, storage);

    renderHook(() =>
      useRefreshHeartbeat({ enabled: true, fetcher, now: () => t0, storage })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(49 * 60 * 1000);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disabling the heartbeat (logout) clears pending timers and stops firing", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    const t0 = 9_000_000;
    writeLastAttemptAt(t0 - 30 * 60 * 1000, storage);

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useRefreshHeartbeat({ enabled, fetcher, now: () => t0, storage }),
      { initialProps: { enabled: true } }
    );

    // Logout mid-interval — disable.
    rerender({ enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 5);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("in-flight guard: a second tick scheduled while a fetch is still pending is dropped", async () => {
    const storage = createMemoryStorage();
    let resolveFetch: ((v: typeof OK_RESULT) => void) | null = null;
    const fetcher = vi.fn().mockImplementation(
      () => new Promise<typeof OK_RESULT>((resolve) => { resolveFetch = resolve; })
    );
    const t0 = 11_000_000;
    writeLastAttemptAt(t0 - 2 * REFRESH_INTERVAL_MS, storage);

    renderHook(() =>
      useRefreshHeartbeat({ enabled: true, fetcher, now: () => t0, storage })
    );

    // First tick fires immediately because we're overdue.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Simulate a cross-tab storage event before the in-flight resolves.
    // The handler must NOT kick off a second fetch.
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LAST_REFRESH_ATTEMPT_KEY })
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.(OK_RESULT);
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("re-schedules the next tick a full interval after a successful refresh", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    let nowMs = 13_000_000;
    writeLastAttemptAt(nowMs - 2 * REFRESH_INTERVAL_MS, storage);

    renderHook(() =>
      useRefreshHeartbeat({ enabled: true, fetcher, now: () => nowMs, storage })
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance just under one full interval — no second call yet.
    await act(async () => {
      nowMs += REFRESH_INTERVAL_MS - 1000;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS - 1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Cross the boundary — second attempt.
    await act(async () => {
      nowMs += 2000;
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("re-schedules even after a failed refresh (no immediate retry storm)", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(OK_RESULT);
    let nowMs = 17_000_000;
    writeLastAttemptAt(nowMs - 2 * REFRESH_INTERVAL_MS, storage);
    const onError = vi.fn();

    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher,
        now: () => nowMs,
        storage,
        onError,
      })
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // No immediate retry — must wait a full interval.
    await act(async () => {
      nowMs += 5 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // After full interval, retry attempted.
    await act(async () => {
      nowMs += REFRESH_INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fires onAttemptStart / onAttemptComplete around each tick — success path", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    const onAttemptStart = vi.fn();
    const onAttemptComplete = vi.fn();
    const t0 = 21_000_000;
    // Overdue so the tick fires immediately on mount.
    writeLastAttemptAt(t0 - 2 * REFRESH_INTERVAL_MS, storage);

    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher,
        now: () => t0,
        storage,
        onAttemptStart,
        onAttemptComplete,
      })
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(onAttemptStart).toHaveBeenCalledTimes(1);
    expect(onAttemptStart).toHaveBeenCalledWith(t0);
    expect(onAttemptComplete).toHaveBeenCalledTimes(1);
  });

  it("fires onAttemptStart even when the fetch rejects (attempt timestamp updates on failed heartbeat too)", async () => {
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const onAttemptStart = vi.fn();
    const onAttemptComplete = vi.fn();
    const onError = vi.fn();
    const t0 = 23_000_000;
    writeLastAttemptAt(t0 - 2 * REFRESH_INTERVAL_MS, storage);

    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher,
        now: () => t0,
        storage,
        onAttemptStart,
        onAttemptComplete,
        onError,
      })
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Storage stamp + the start callback both fire regardless of outcome —
    // the 60-min cadence must hold even when refreshes error.
    expect(readLastAttemptAt(storage)).toBe(t0);
    expect(onAttemptStart).toHaveBeenCalledTimes(1);
    expect(onAttemptStart).toHaveBeenCalledWith(t0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAttemptComplete).toHaveBeenCalledTimes(1);
  });

  it("writes the attempt timestamp before the fetch resolves (so a concurrent tab/remount sees the in-flight attempt)", async () => {
    const storage = createMemoryStorage();
    let resolveFetch: ((v: typeof OK_RESULT) => void) | null = null;
    const fetcher = vi.fn().mockImplementation(
      () => new Promise<typeof OK_RESULT>((resolve) => { resolveFetch = resolve; })
    );
    const t0 = 19_000_000;
    writeLastAttemptAt(t0 - 2 * REFRESH_INTERVAL_MS, storage);

    renderHook(() =>
      useRefreshHeartbeat({ enabled: true, fetcher, now: () => t0, storage })
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Stamped synchronously before await.
    expect(readLastAttemptAt(storage)).toBe(t0);
    await act(async () => {
      resolveFetch?.(OK_RESULT);
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("threads the token returned by onAttemptStart back to onAttemptComplete (success + failure)", async () => {
    // The hook captures whatever the consumer returns from onAttemptStart
    // (an opaque token — e.g. a slot ID) and passes it back on settlement
    // so the consumer can pair start/finish exactly even when attempts
    // overlap.  Verified across both branches: a successful tick and a
    // failed tick.
    const storage = createMemoryStorage();
    const okFetcher = vi.fn().mockResolvedValue(OK_RESULT);
    let nowMs = 27_000_000;
    writeLastAttemptAt(nowMs - 2 * REFRESH_INTERVAL_MS, storage);
    const onAttemptStart = vi.fn().mockReturnValueOnce("token-success");
    const onAttemptComplete = vi.fn();

    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher: okFetcher,
        now: () => nowMs,
        storage,
        onAttemptStart,
        onAttemptComplete,
      })
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(onAttemptComplete).toHaveBeenCalledTimes(1);
    expect(onAttemptComplete).toHaveBeenLastCalledWith("token-success");

    // Same provider, second tick that fails — token threading must also
    // hold across the failure branch.
    const failingFetcher = vi.fn().mockRejectedValue(new Error("boom"));
    onAttemptStart.mockReturnValueOnce("token-fail");
    const storage2 = createMemoryStorage();
    writeLastAttemptAt(nowMs - 2 * REFRESH_INTERVAL_MS, storage2);
    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher: failingFetcher,
        now: () => nowMs,
        storage: storage2,
        onAttemptStart,
        onAttemptComplete,
        onError: vi.fn(),
      })
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(onAttemptComplete).toHaveBeenCalledTimes(2);
    expect(onAttemptComplete).toHaveBeenLastCalledWith("token-fail");
  });

  it("onAttemptComplete receives undefined when onAttemptStart returns nothing (legacy callers)", async () => {
    // Callers that haven't been threaded for token correlation can still
    // omit the return.  The hook must pass `undefined` rather than throwing
    // or substituting a synthetic value.
    const storage = createMemoryStorage();
    const fetcher = vi.fn().mockResolvedValue(OK_RESULT);
    const t0 = 31_000_000;
    writeLastAttemptAt(t0 - 2 * REFRESH_INTERVAL_MS, storage);
    const onAttemptStart = vi.fn();
    const onAttemptComplete = vi.fn();

    renderHook(() =>
      useRefreshHeartbeat({
        enabled: true,
        fetcher,
        now: () => t0,
        storage,
        onAttemptStart,
        onAttemptComplete,
      })
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(onAttemptComplete).toHaveBeenCalledTimes(1);
    expect(onAttemptComplete).toHaveBeenLastCalledWith(undefined);
  });
});

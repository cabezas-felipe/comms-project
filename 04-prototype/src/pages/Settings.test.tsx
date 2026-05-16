import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CONTRACT_VERSION } from "@tempo/contracts";

// ── Mocks ────────────────────────────────────────────────────────────────────

const triggerDashboardRefreshSpy = vi.fn<[], Promise<null>>(async () => null);
vi.mock("@/lib/refresh-context", () => ({
  useRefreshContext: () => ({ triggerDashboardRefresh: triggerDashboardRefreshSpy }),
}));

const fetchSettingsPayloadSpy = vi.fn<[], Promise<unknown>>();
const saveSettingsPayloadSpy = vi.fn<[unknown], Promise<unknown>>();
vi.mock("@/lib/settings-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings-api")>();
  return {
    ...actual,
    fetchSettingsPayload: () => fetchSettingsPayloadSpy(),
    saveSettingsPayload: (p: unknown) => saveSettingsPayloadSpy(p),
  };
});

vi.mock("@/lib/notify", () => ({
  notifyWarning: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

// Settings imports `useRefreshContext` from `@/lib/refresh-context`; that mock
// is set up above so we don't need to mount the real provider.  Importing
// Settings after the mocks register so the component picks them up.
const { default: Settings } = await import("@/pages/Settings");

// ── Helpers ──────────────────────────────────────────────────────────────────

const INITIAL_PAYLOAD = {
  contractVersion: CONTRACT_VERSION,
  topics: [],
  keywords: [],
  geographies: [],
  traditionalSources: [],
  socialSources: [],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSettings() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Settings />
    </MemoryRouter>
  );
}

// Mount Settings and wait for the initial `fetchSettingsPayload()` load to
// resolve.  The Topics input flips to non-disabled once `loading` clears, so
// we use that as the readiness signal.
async function mountWithSettings(payload: unknown = INITIAL_PAYLOAD) {
  fetchSettingsPayloadSpy.mockResolvedValueOnce(payload);
  renderSettings();
  await waitFor(() => {
    const input = screen.getByPlaceholderText("Add a topic") as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
}

// Adds a topic via the Topics ListSection: types into the input and presses
// Enter, which fires `add()` → `onChange(newItems)` → `markDirty(setTopics)` →
// scheduleSave (600ms debounce).
function addTopic(value: string) {
  const input = screen.getByPlaceholderText("Add a topic") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Settings — debounced save → dashboard refresh trigger", () => {
  beforeEach(() => {
    triggerDashboardRefreshSpy.mockClear();
    triggerDashboardRefreshSpy.mockImplementation(async () => null);
    fetchSettingsPayloadSpy.mockReset();
    saveSettingsPayloadSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("fires triggerDashboardRefresh once after a successful debounced save", async () => {
    await mountWithSettings();
    saveSettingsPayloadSpy.mockResolvedValue(undefined);

    addTopic("Migration policy");

    // Pre-debounce: save hasn't fired yet, so neither has the trigger.
    expect(saveSettingsPayloadSpy).not.toHaveBeenCalled();
    expect(triggerDashboardRefreshSpy).not.toHaveBeenCalled();

    // 600ms debounce + microtasks for the success branch.
    await waitFor(() => expect(saveSettingsPayloadSpy).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    await waitFor(() => expect(triggerDashboardRefreshSpy).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
  });

  it("does NOT trigger refresh when the resolving save is for a stale revision", async () => {
    // Race we're guarding: save A fires (revision=1), the user mutates again
    // mid-flight (revision=2), then save A resolves successfully.  The
    // existing stale-revision guard returns early — the trigger must not
    // fire, because save A's payload is no longer the latest user intent.
    await mountWithSettings();
    const first = deferred<void>();
    saveSettingsPayloadSpy.mockReturnValueOnce(first.promise);

    addTopic("Migration policy");
    await waitFor(() => expect(saveSettingsPayloadSpy).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });

    // Bump the revision while save A is still in flight.  We don't want save
    // B to fire during the assertion window, so set the next call to a
    // never-resolving promise.
    const blocked = deferred<void>();
    saveSettingsPayloadSpy.mockReturnValue(blocked.promise);
    addTopic("Trade policy");

    // Resolve save A — stale-revision branch returns early, no trigger call.
    await act(async () => {
      first.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Tiny real-time wait so any wayward queued trigger has a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(triggerDashboardRefreshSpy).not.toHaveBeenCalled();
  });

  it("does NOT trigger refresh on save failure", async () => {
    await mountWithSettings();
    saveSettingsPayloadSpy.mockRejectedValueOnce(new Error("network down"));

    addTopic("Migration policy");

    await waitFor(() => expect(saveSettingsPayloadSpy).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    // Give the catch branch time to set state + skip the trigger.
    await new Promise((r) => setTimeout(r, 50));
    expect(triggerDashboardRefreshSpy).not.toHaveBeenCalled();
  });

  it("does NOT trigger refresh on initial load (no user mutation)", async () => {
    await mountWithSettings();
    // No mutation — no save schedule, no refresh trigger.  Wait past a full
    // debounce window to confirm nothing slipped in.
    await new Promise((r) => setTimeout(r, 700));
    expect(saveSettingsPayloadSpy).not.toHaveBeenCalled();
    expect(triggerDashboardRefreshSpy).not.toHaveBeenCalled();
  });

  it("fires triggerDashboardRefresh per successful save (two back-to-back successful bursts)", async () => {
    await mountWithSettings();
    saveSettingsPayloadSpy.mockResolvedValue(undefined);

    addTopic("Migration policy");
    await waitFor(() => expect(triggerDashboardRefreshSpy).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });

    addTopic("Trade policy");
    await waitFor(() => expect(triggerDashboardRefreshSpy).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
  });
});

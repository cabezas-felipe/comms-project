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

// Settings reads last-refresh diagnostics via `fetchDashboardRefreshMeta`.
// Mock the module to the single export Settings uses so we don't pull in the
// real api module (and its supabase/auth deps) at runtime.
const fetchDashboardRefreshMetaSpy = vi.fn<[], Promise<unknown>>();
vi.mock("@/lib/api", () => ({
  fetchDashboardRefreshMeta: () => fetchDashboardRefreshMetaSpy(),
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
    // Default: no snapshot diagnostics → coverage panel hidden. Individual
    // coverage tests override this before mounting.
    fetchDashboardRefreshMetaSpy.mockReset();
    fetchDashboardRefreshMetaSpy.mockResolvedValue({ ok: true, meta: null });
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

describe("Settings — source coverage panel (Prompt 6)", () => {
  beforeEach(() => {
    triggerDashboardRefreshSpy.mockClear();
    triggerDashboardRefreshSpy.mockImplementation(async () => null);
    fetchSettingsPayloadSpy.mockReset();
    saveSettingsPayloadSpy.mockReset();
    fetchDashboardRefreshMetaSpy.mockReset();
    fetchDashboardRefreshMetaSpy.mockResolvedValue({ ok: true, meta: null });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  // Deterministically settle the diagnostics read: confirm the effect fired,
  // then flush its resolved/rejected continuation + the resulting re-render.
  // Used by the absence assertions (panel hidden) where there is no positive
  // element to `findBy*` on, so we never rely on ad-hoc setTimeout timing.
  async function settleCoverageRead() {
    await waitFor(() => expect(fetchDashboardRefreshMetaSpy).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("hides the panel when there is no snapshot (coverage = null via meta: null)", async () => {
    fetchDashboardRefreshMetaSpy.mockResolvedValueOnce({ ok: true, meta: null });
    await mountWithSettings();
    await settleCoverageRead();

    expect(screen.queryByText("Source coverage")).toBeNull();
    expect(screen.queryByText("All selected sources connected.")).toBeNull();
  });

  it("shows the neutral connected state when coverage is present with no gaps", async () => {
    fetchDashboardRefreshMetaSpy.mockResolvedValueOnce({
      ok: true,
      meta: {
        selection: {
          sourceSelectionMode: "strict",
          unmatchedSelectedSources: [],
          unavailableConnectorSources: [],
          blockedSocialSources: [],
        },
      },
    });
    await mountWithSettings();

    // Title is always present once the panel renders; body shows the neutral copy.
    expect(await screen.findByText("Source coverage")).toBeTruthy();
    expect(await screen.findByText("All selected sources connected.")).toBeTruthy();
    // No gap sections rendered, and the non-blocking gap copy is absent.
    expect(screen.queryByText("Not matched yet")).toBeNull();
    expect(screen.queryByText("Unavailable connectors")).toBeNull();
    expect(screen.queryByText("Blocked by allowlist")).toBeNull();
    expect(
      screen.queryByText(/Tempo will still build stories from matched sources/i)
    ).toBeNull();
  });

  // coverage present + ONE gap type only → exactly that section is shown.
  const SINGLE_GAP_CASES = [
    {
      field: "unmatchedSelectedSources",
      heading: "Not matched yet",
      value: "Made-Up Outlet",
      others: ["Unavailable connectors", "Blocked by allowlist"],
    },
    {
      field: "unavailableConnectorSources",
      heading: "Unavailable connectors",
      value: "Defunct Wire",
      others: ["Not matched yet", "Blocked by allowlist"],
    },
    {
      field: "blockedSocialSources",
      heading: "Blocked by allowlist",
      value: "@blockedhandle",
      others: ["Not matched yet", "Unavailable connectors"],
    },
  ] as const;

  for (const c of SINGLE_GAP_CASES) {
    it(`shows only the "${c.heading}" section when ${c.field} is the only gap`, async () => {
      fetchDashboardRefreshMetaSpy.mockResolvedValueOnce({
        ok: true,
        meta: { selection: { sourceSelectionMode: "strict", [c.field]: [c.value] } },
      });
      await mountWithSettings();

      // Gaps exist → non-blocking body copy + only the relevant section.
      expect(await screen.findByText("Source coverage")).toBeTruthy();
      expect(
        screen.getByText(/Tempo will still build stories from matched sources/i)
      ).toBeTruthy();
      expect(screen.getByText(c.heading)).toBeTruthy();
      expect(screen.getByText(c.value)).toBeTruthy();
      for (const other of c.others) {
        expect(screen.queryByText(other)).toBeNull();
      }
      // Not the neutral state.
      expect(screen.queryByText("All selected sources connected.")).toBeNull();
    });
  }

  it("shows all sections + names when multiple gap types are present", async () => {
    fetchDashboardRefreshMetaSpy.mockResolvedValueOnce({
      ok: true,
      meta: {
        selection: {
          sourceSelectionMode: "strict",
          unmatchedSelectedSources: ["Made-Up Outlet"],
          unavailableConnectorSources: ["Defunct Wire"],
          blockedSocialSources: ["@blockedhandle"],
        },
      },
    });
    await mountWithSettings();

    // Title + non-blocking body copy.
    expect(await screen.findByText("Source coverage")).toBeTruthy();
    expect(
      screen.getByText(/Tempo will still build stories from matched sources/i)
    ).toBeTruthy();

    // Each section header + its source name.
    expect(screen.getByText("Not matched yet")).toBeTruthy();
    expect(screen.getByText("Made-Up Outlet")).toBeTruthy();
    expect(screen.getByText("Unavailable connectors")).toBeTruthy();
    expect(screen.getByText("Defunct Wire")).toBeTruthy();
    expect(screen.getByText("Blocked by allowlist")).toBeTruthy();
    expect(screen.getByText("@blockedhandle")).toBeTruthy();
  });

  it("fails open: Settings still loads and panel is hidden when the refresh-meta fetch rejects", async () => {
    fetchDashboardRefreshMetaSpy.mockRejectedValueOnce(new Error("diagnostics down"));
    // mountWithSettings asserts the editable form became interactive — i.e. the
    // page rendered fine despite the diagnostics read failing.
    await mountWithSettings();
    await settleCoverageRead();

    // The form is usable and the coverage panel is simply absent.
    expect((screen.getByPlaceholderText("Add a topic") as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText("Source coverage")).toBeNull();
  });

  it("degrades safely (no crash) when a coverage field has a malformed non-array shape", async () => {
    // A non-array slips past the mocked helper (the real helper's schema parse
    // would reject this, but the panel must never crash if it ever did). The
    // component coerces non-arrays to empty, so no gap sections render.
    fetchDashboardRefreshMetaSpy.mockResolvedValueOnce({
      ok: true,
      meta: {
        selection: {
          sourceSelectionMode: "strict",
          blockedSocialSources: "bad-type",
        },
      },
    });
    await mountWithSettings();

    // Rendered without throwing; coverage is present but degrades to "no gaps".
    expect(await screen.findByText("All selected sources connected.")).toBeTruthy();
    expect(screen.queryByText("Blocked by allowlist")).toBeNull();
    expect(screen.queryByText("Not matched yet")).toBeNull();
    expect(screen.queryByText("Unavailable connectors")).toBeNull();
    // The malformed raw value must never be rendered as a chip.
    expect(screen.queryByText("bad-type")).toBeNull();
    // Form remains fully usable.
    expect((screen.getByPlaceholderText("Add a topic") as HTMLInputElement).disabled).toBe(false);
  });
});

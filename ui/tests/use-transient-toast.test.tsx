/**
 * Issue #1284 — transient toast timers must be cancelled on unmount.
 *
 * The defect: nine `window.setTimeout(() => setSavedToast(false), 2000)` calls
 * across eight files scheduled a state update with no cleanup. The timer
 * outlives the component, so in jsdom the callback can fire after the
 * environment is torn down (`ReferenceError: window is not defined`, reported
 * OUTSIDE the test tally — the `ui` job went red with 337/337 files passing),
 * and in a browser it is a `setState` on an unmounted tree.
 *
 * WHAT THESE TESTS ASSERT, AND WHY THAT SHAPE
 *
 * The observable defect is "a timer is still pending after unmount". That is
 * the CAUSE; the post-unmount state update is its consequence, and React 18
 * makes the consequence itself silent (the setState is a no-op, with no
 * warning). So asserting the pending-timer count is both the strongest and the
 * only reliable assertion — and, critically, it is the one a mounted-flag
 * guard does NOT satisfy: a mounted flag suppresses the setState while leaving
 * the timer armed, so `vi.getTimerCount()` would still be 1 and these tests
 * would still fail. That is deliberate; #1284 explicitly rejects that non-fix.
 *
 * Every assertion below is paired with a CONTROL that proves the measurement
 * can move: a timer really was armed before the unmount, and the render
 * recorder really does observe a dismissal render while mounted. Without those,
 * "0 pending timers" and "0 extra renders" would both be trivially true if the
 * test never armed anything at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { useTransientFlag, useTransientToast } from "@/hooks/use-transient-toast";
import { SecretRow } from "@/app/(authed)/settings/api-keys/SecretRow";
import { SafetySettingsCard } from "@/components/projects/safety-settings-card";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/settings-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/settings-api")>("@/lib/settings-api");
  return {
    ...actual,
    configApi: { setSecret: vi.fn(), clearSecret: vi.fn() },
  };
});

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return { ...actual, projectsApi: { ...actual.projectsApi, updateSafety: vi.fn() } };
});

import { configApi } from "@/lib/settings-api";
import { projectsApi } from "@/lib/projects-api";

const setSecretMock = vi.mocked(configApi.setSecret);
const clearSecretMock = vi.mocked(configApi.clearSecret);
const updateSafetyMock = vi.mocked(projectsApi.updateSafety);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Count the still-pending timers armed at exactly `delayMs`.
 *
 * The hook tests below can use `vi.getTimerCount()` directly because
 * `renderHook` mounts nothing else. The component tests cannot: React Query
 * arms its own timers around a mutation (the SafetySettingsCard save leaves
 * three, not one), so a global count neither isolates the toast's timer nor
 * proves that the ONE we care about was cancelled. Watching the scheduling
 * calls at the toast's own delay does both.
 *
 * Note what this still rejects: a mounted-flag guard never calls
 * `clearTimeout`, so its timer stays in `armed` and the count stays 1.
 */
function trackToastTimers(delayMs: number) {
  const setSpy = vi.spyOn(globalThis, "setTimeout");
  const clearSpy = vi.spyOn(globalThis, "clearTimeout");
  return {
    pending(): number {
      const armed = setSpy.mock.calls
        .map((call, i) => (call[1] === delayMs ? setSpy.mock.results[i]?.value : undefined))
        .filter((id) => id !== undefined);
      const cleared = new Set(clearSpy.mock.calls.map((call) => call[0]));
      return armed.filter((id) => !cleared.has(id)).length;
    },
  };
}

describe("useTransientToast — the timer is cancelled on unmount (#1284)", () => {
  it("leaves ZERO pending timers after unmounting with a toast showing", () => {
    const before = vi.getTimerCount();
    const { result, unmount } = renderHook(() => useTransientToast<string>(2000));

    act(() => result.current.showToast("saved"));

    // CONTROL: the toast really did arm a timer. Without this the final
    // assertion would pass vacuously on a hook that schedules nothing.
    expect(vi.getTimerCount()).toBe(before + 1);
    expect(result.current.toast).toBe("saved");

    unmount();

    expect(vi.getTimerCount()).toBe(before);
  });

  it("CONTROL: while mounted, the dismissal timer fires and re-renders with null", () => {
    const seen: Array<string | null> = [];
    function Probe() {
      const { toast, showToast } = useTransientToast<string>(2000);
      seen.push(toast);
      return (
        <button type="button" onClick={() => showToast("saved")}>
          show
        </button>
      );
    }

    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    const afterShow = seen.length;
    expect(seen.at(-1)).toBe("saved");

    act(() => void vi.advanceTimersByTime(2000));

    // The recorder DOES observe a post-timer state update while mounted. That
    // is what makes the recorder a real instrument; it is NOT what makes the
    // unmounted case below falsifiable — see the comment there.
    expect(seen.length).toBeGreaterThan(afterShow);
    expect(seen.at(-1)).toBeNull();
  });

  it("after unmount, advancing past the duration produces no further state update", () => {
    const seen: Array<string | null> = [];
    function Probe() {
      const { toast, showToast } = useTransientToast<string>(2000);
      seen.push(toast);
      return (
        <button type="button" onClick={() => showToast("saved")}>
          show
        </button>
      );
    }

    const { unmount } = render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    expect(seen.at(-1)).toBe("saved");

    unmount();
    const atUnmount = seen.length;

    // ORDER IS LOAD-BEARING. This assertion has to come BEFORE the clock moves:
    // advancing past 2000ms would FIRE an uncancelled timer and leave the count
    // at 0 either way, which is exactly how this test was vacuous when first
    // written. Asserting at the instant of unmount is the falsifiable form.
    expect(vi.getTimerCount()).toBe(0);

    act(() => void vi.advanceTimersByTime(10_000));

    // React no-ops a setState on an unmounted tree without warning, so this
    // assertion cannot fail on its own — it documents the consequence, while
    // the assertion above is what proves the cause is gone.
    expect(seen.length).toBe(atUnmount);
  });

  it("re-arms the dismissal when shown again while still visible", () => {
    const { result } = renderHook(() => useTransientToast<string>(2000));

    act(() => result.current.showToast("saved"));
    act(() => void vi.advanceTimersByTime(1500));
    expect(result.current.toast).toBe("saved");

    act(() => result.current.showToast("cleared"));
    // 1500ms after the FIRST show — the original timer would have fired at 2000
    // and wrongly dismissed the second toast at 500ms of its own life.
    act(() => void vi.advanceTimersByTime(1500));
    expect(result.current.toast).toBe("cleared");
    expect(vi.getTimerCount()).toBe(1);

    act(() => void vi.advanceTimersByTime(500));
    expect(result.current.toast).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clearToast hides immediately and cancels the pending dismissal", () => {
    const { result } = renderHook(() => useTransientToast<string>(2000));

    act(() => result.current.showToast("saved"));
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.clearToast());

    expect(result.current.toast).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clearToast is safe when nothing is pending", () => {
    const { result } = renderHook(() => useTransientToast<string>(2000));

    act(() => result.current.clearToast());

    expect(result.current.toast).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting with NO toast showing cancels nothing and throws nothing", () => {
    const { unmount } = renderHook(() => useTransientToast<string>(2000));
    expect(vi.getTimerCount()).toBe(0);
    expect(() => unmount()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useTransientFlag — boolean flavour (#1284)", () => {
  it("exposes active/show/clear and auto-dismisses", () => {
    const { result } = renderHook(() => useTransientFlag(2000));

    expect(result.current.active).toBe(false);
    act(() => result.current.show());
    expect(result.current.active).toBe(true);

    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current.active).toBe(false);
  });

  it("clear() hides immediately and cancels the pending dismissal", () => {
    const { result } = renderHook(() => useTransientFlag(2000));

    act(() => result.current.show());
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.clear());

    expect(result.current.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels its pending dismissal on unmount", () => {
    const { result, unmount } = renderHook(() => useTransientFlag(2000));

    act(() => result.current.show());
    expect(vi.getTimerCount()).toBe(1); // CONTROL — a timer was armed

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("SecretRow — both toast paths clean up on unmount (#1284)", () => {
  function renderRow(source: "vault" | "env" | "unset" = "vault") {
    return render(
      <SecretRow
        configKey="OPENAI_API_KEY"
        description="Model provider key"
        source={source}
        onChanged={() => {}}
      />,
    );
  }

  it("save path: the Saved toast timer is cancelled when the row unmounts", async () => {
    setSecretMock.mockResolvedValue(undefined as never);
    const timers = trackToastTimers(2000);
    const { unmount } = renderRow();

    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-edit"));
    fireEvent.change(screen.getByTestId("config-secret-OPENAI_API_KEY-input"), {
      target: { value: "sk-new-value" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-save"));
    });

    // CONTROL: the toast is visible and its dismissal timer really is pending.
    expect(screen.getByTestId("config-secret-OPENAI_API_KEY-toast")).toHaveTextContent("Saved");
    expect(timers.pending()).toBe(1);

    unmount();

    expect(timers.pending()).toBe(0);
  });

  it("clear path: the Cleared toast timer is cancelled when the row unmounts", async () => {
    clearSecretMock.mockResolvedValue(undefined as never);
    const timers = trackToastTimers(2000);
    const { unmount } = renderRow("vault");

    await act(async () => {
      fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-clear"));
    });

    expect(screen.getByTestId("config-secret-OPENAI_API_KEY-toast")).toHaveTextContent("Cleared");
    expect(timers.pending()).toBe(1);

    unmount();

    expect(timers.pending()).toBe(0);
  });

  it("the Saved toast still auto-dismisses after 2s while mounted", async () => {
    setSecretMock.mockResolvedValue(undefined as never);
    renderRow();

    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-edit"));
    fireEvent.change(screen.getByTestId("config-secret-OPENAI_API_KEY-input"), {
      target: { value: "sk-new-value" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-save"));
    });
    expect(screen.getByTestId("config-secret-OPENAI_API_KEY-toast")).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(2000));

    expect(screen.queryByTestId("config-secret-OPENAI_API_KEY-toast")).not.toBeInTheDocument();
  });
});

describe("SafetySettingsCard — settings-card family cleans up on unmount (#1284)", () => {
  it("cancels the Saved toast timer when the card unmounts", async () => {
    updateSafetyMock.mockResolvedValue({ id: "p1", safetyMode: "strict" } as never);
    const timers = trackToastTimers(2000);
    const Wrapper = makeWrapper({ withAuth: false });
    const { unmount } = render(
      <Wrapper>
        <SafetySettingsCard projectId="p1" current="standard" />
      </Wrapper>,
    );

    fireEvent.change(screen.getByTestId("safety-mode-select"), { target: { value: "strict" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("safety-save-button"));
    });

    expect(screen.getByTestId("safety-saved-toast")).toBeInTheDocument();
    expect(timers.pending()).toBe(1);

    unmount();

    expect(timers.pending()).toBe(0);
  });
});

describe("no component schedules a state update on a discarded timer (#1284)", () => {
  /**
   * The fourteen sites shared one shape, so the sweep is pinned by one
   * invariant rather than fourteen near-identical assertions.
   *
   * The invariant is the DEFECT, not a spelling. Issue #1284 scoped the work by
   * grepping `window.setTimeout` and found nine sites; five more carried the
   * identical bug spelled `setTimeout` with no `window.` prefix, and a sweep
   * keyed on the literal string would have let every one of them through — and
   * would let a reintroduction through too. So what is banned here is
   * `setTimeout(() => setSomething(...), n)` whose HANDLE IS DISCARDED: with no
   * id retained, no caller can ever cancel it, which is precisely why those
   * fourteen timers outlived their components.
   *
   * The legitimate idiom keeps the handle — `const t = setTimeout(...)` inside a
   * `useEffect` that returns `clearTimeout(t)` — and is untouched by this rule.
   *
   * Known limit, stated rather than hidden: this reads one line at a time and
   * only recognises the inline single-expression arrow form. A multi-line
   * `setTimeout(() => { ... })` that sets state is not detected. That form does
   * not appear among the sites #1284 is about, and widening the rule to catch it
   * would need a parser rather than a regex.
   */
  // Vitest's root is `ui/`, so `src` resolves off the cwd. The "walker reached
  // real files" control below is what proves this path was right.
  const srcRoot = resolve(process.cwd(), "src");
  const CALL = "setTimeout(";

  /** Drop block and line comments so the sweep judges code, not prose. */
  function stripComments(source: string): string {
    // `(^|[^:])` keeps `https://…` from being read as the start of a comment.
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  /**
   * True when this line arms a state-setting timer and throws the handle away.
   * `const t = setTimeout(…)`, `return setTimeout(…)` and `f(x, setTimeout(…))`
   * all retain it, so all three are allowed.
   */
  function discardsStateTimer(line: string): boolean {
    const at = line.indexOf(CALL);
    if (at === -1) return false;
    const before = line.slice(0, at);
    if (/[=(,[:]\s*$/.test(before) || /\breturn\s+$/.test(before)) return false;
    return /^\s*\(\s*\)\s*=>\s*set[A-Z]/.test(line.slice(at + CALL.length));
  }

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("finds no discarded state-setting timer anywhere under ui/src", () => {
    const files = walk(srcRoot);

    // CONTROL: the walker actually reached the files that held the fourteen
    // hits. A walker that silently returned [] would make the sweep vacuous.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join("settings", "api-keys", "SecretRow.tsx")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("components", "findings", "code-citation.tsx")))).toBe(
      true,
    );

    const offenders = files.filter((f) =>
      stripComments(readFileSync(f, "utf8")).split("\n").some(discardsStateTimer),
    );

    expect(offenders).toEqual([]);
  });

  it("CONTROL: the rule fires on both defective spellings and spares the correct idiom", () => {
    // Verbatim from the base commit e806ec50 — both spellings of the bug.
    expect(discardsStateTimer("      window.setTimeout(() => setSavedToast(false), 2000);")).toBe(
      true,
    );
    expect(discardsStateTimer('      setTimeout(() => setCopyState("idle"), 1500);')).toBe(true);
    expect(discardsStateTimer("      setTimeout(() => setCopied(false), 1500);")).toBe(true);

    // Verbatim from files that were correct all along and must NOT be churned.
    expect(discardsStateTimer("    const t = setTimeout(() => setSavedToast(false), 1500);")).toBe(
      false,
    );
    expect(
      discardsStateTimer("    const timer = setTimeout(() => setDebounced(value), delayMs);"),
    ).toBe(false);
    expect(
      discardsStateTimer("        stopTimer.current = setTimeout(() => emitTyping(false), MS);"),
    ).toBe(false);
    // A discarded timer that sets no state is out of scope, not a defect here.
    expect(discardsStateTimer('      setTimeout(() => router.push("/dashboard"), 2000);')).toBe(
      false,
    );
  });

  it("CONTROL: the sweep reads code, not prose", () => {
    // Without this the sweep could be green because `stripComments` eats
    // everything, or because the rule never matches anything at all.
    const code = "a();\n      setTimeout(() => setX(false), 2000);\n";
    expect(stripComments(code).split("\n").some(discardsStateTimer)).toBe(true);
    expect(
      stripComments("/** setTimeout(() => setX(false), 1) is what we banned */")
        .split("\n")
        .some(discardsStateTimer),
    ).toBe(false);
    expect(
      stripComments("// setTimeout(() => setX(false), 1) in a line comment")
        .split("\n")
        .some(discardsStateTimer),
    ).toBe(false);
  });
});

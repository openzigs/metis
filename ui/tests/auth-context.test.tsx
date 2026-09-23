import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PROACTIVE_REFRESH_MS, useAuth } from "@/lib/auth-context";
import { _resetAuthRetryState } from "@/lib/api-client";
import { makeWrapper, TEST_USER } from "./test-utils";
import { useRouter } from "next/navigation";

const fetchMock = vi.fn();

/** Replace `window.location` with a stub exposing pathname + search. */
function stubLocation(pathname: string, search = ""): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { pathname, search } as Location,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  _resetAuthRetryState();
  // Stable router from setup.ts — clear its spies.
  const router = (useRouter as unknown as () => Record<string, ReturnType<typeof vi.fn>>)();
  for (const fn of Object.values(router)) fn.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetAuthRetryState();
});

function ok(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("AuthProvider", () => {
  it("hydrates the user from /auth/me on mount", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, data: { user: TEST_USER } }));
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ withAuth: true }),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toEqual(TEST_USER);
    expect(result.current.isAuthenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("clears the user when /auth/me fails", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: false, error: { code: "X" } }, 401));
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ withAuth: true }),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("uses the provided initial user without calling /auth/me", () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(result.current.user).toEqual(TEST_USER);
    expect(result.current.isLoading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets the user on a successful login", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });

    fetchMock.mockResolvedValueOnce(ok({ success: true, data: { user: TEST_USER } }));

    await act(async () => {
      await result.current.login({ username: "tester", password: "pw" });
    });

    expect(result.current.user).toEqual(TEST_USER);
    const loginCall = fetchMock.mock.calls.find(([url]) => url === "/api/auth/login");
    expect(loginCall).toBeDefined();
    expect(loginCall?.[1]?.method).toBe("POST");
  });

  it("surfaces a typed error when login fails", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });

    fetchMock.mockResolvedValueOnce(
      ok({ success: false, error: { code: "AUTH_FAILED", message: "bad" } }, 401),
    );

    await act(async () => {
      await expect(result.current.login({ username: "x", password: "y" })).rejects.toMatchObject({
        status: 401,
      });
    });
    expect(result.current.error).toBe("bad");
  });

  it("clears the user and routes on logout", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, data: null }));
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });

    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.user).toBeNull();
    const router = (useRouter as unknown as () => { push: ReturnType<typeof vi.fn> })();
    expect(router.push).toHaveBeenCalledWith("/login");
  });

  it("logout still clears state when the upstream call throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });

    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.user).toBeNull();
  });

  it("refresh re-fetches the user", async () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });

    fetchMock.mockResolvedValueOnce(
      ok({ success: true, data: { user: { ...TEST_USER, displayName: "New" } } }),
    );

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.user?.displayName).toBe("New");
  });

  it("throws when used outside a provider", () => {
    expect(() => renderHook(() => useAuth())).toThrow(/useAuth must be used within/);
  });
});

describe("AuthProvider — proactive sliding-session refresh (#410)", () => {
  const REFRESH_MS = 1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Count POSTs the proactive timer made to /auth/refresh. */
  function refreshCalls(): number {
    return fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/refresh").length;
  }

  it("exposes a ~50min lead-time constant well under the 1h expiry", () => {
    expect(PROACTIVE_REFRESH_MS).toBe(50 * 60 * 1000);
    expect(PROACTIVE_REFRESH_MS).toBeLessThan(60 * 60 * 1000);
  });

  it("fires a single-flight refresh BEFORE expiry without a 401 trigger", async () => {
    // refresh POST → ok; the follow-up /auth/me re-hydrate → ok.
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url) === "/api/auth/refresh") return Promise.resolve(ok({ success: true }, 200));
      return Promise.resolve(ok({ success: true, data: { user: TEST_USER } }));
    });

    renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER, refreshIntervalMs: REFRESH_MS }),
    });

    expect(refreshCalls()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    // The proactive timer drove exactly one /auth/refresh. With an injected
    // initialUser the initial /auth/me probe is skipped, so the ONLY requests
    // are the proactive /auth/refresh followed by the re-hydrate /auth/me — no
    // reactive-401 retry chain (which would show a /auth/me 401 *before* the
    // refresh) ever ran.
    expect(refreshCalls()).toBe(1);
    const authCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u === "/api/auth/me" || u === "/api/auth/refresh");
    expect(authCalls).toEqual(["/api/auth/refresh", "/api/auth/me"]);
  });

  it("does NOT attempt a refresh while logged out", async () => {
    fetchMock.mockResolvedValue(ok({ success: true }, 200));
    renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: null, refreshIntervalMs: REFRESH_MS }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    expect(refreshCalls()).toBe(0);
  });

  it("clears the timer on logout (no further refresh after logout)", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url) === "/api/auth/refresh") return Promise.resolve(ok({ success: true }, 200));
      // /auth/logout + /auth/me both succeed.
      return Promise.resolve(ok({ success: true, data: { user: TEST_USER } }));
    });

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER, refreshIntervalMs: REFRESH_MS }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(refreshCalls()).toBe(1);

    await act(async () => {
      await result.current.logout();
    });
    const afterLogout = refreshCalls();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    // No new refresh fired once the user logged out.
    expect(refreshCalls()).toBe(afterLogout);
  });

  it("clears the timer on unmount (no refresh after unmount)", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url) === "/api/auth/refresh") return Promise.resolve(ok({ success: true }, 200));
      return Promise.resolve(ok({ success: true, data: { user: TEST_USER } }));
    });

    const { unmount } = renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER, refreshIntervalMs: REFRESH_MS }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    expect(refreshCalls()).toBe(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    });
    expect(refreshCalls()).toBe(1);
  });

  it("shares the single-flight with the reactive path (no double /auth/refresh)", async () => {
    // The proactive trigger and a concurrent reactive 401 must coalesce onto the
    // SAME /auth/refresh call. We model a slow refresh, fire the proactive timer,
    // then a manual refresh() race; only one /auth/refresh should be observed for
    // the overlapping window.
    let resolveRefresh: ((r: Response) => void) | null = null;
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url) === "/api/auth/refresh") {
        return new Promise<Response>((res) => {
          resolveRefresh = res;
        });
      }
      return Promise.resolve(ok({ success: true, data: { user: TEST_USER } }));
    });

    renderHook(() => useAuth(), {
      wrapper: makeWrapper({ initialUser: TEST_USER, refreshIntervalMs: REFRESH_MS }),
    });

    await act(async () => {
      // Fire two intervals back-to-back; the first refresh is still in flight, so
      // the second must coalesce onto it (single-flight) rather than POST again.
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      resolveRefresh?.(ok({ success: true }, 200));
    });

    expect(refreshCalls()).toBe(1);
  });
});

describe("AuthProvider — onRefreshFailure redirect (#411)", () => {
  /**
   * Mount the provider with NO initial user so its `/auth/me` probe runs:
   * /auth/me → 401 drives the reactive refresh, /auth/refresh → 401 fails, and
   * the registered `onRefreshFailure` fires the involuntary redirect.
   */
  function mountWithFailingRefresh() {
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url) === "/api/auth/refresh") return Promise.resolve(ok({ success: false }, 401));
      return Promise.resolve(ok({ success: false, error: { code: "TOKEN_EXPIRED" } }, 401));
    });
    return renderHook(() => useAuth(), { wrapper: makeWrapper({ initialUser: null }) });
  }

  it("redirects with ?next + reason=expired from a protected page", async () => {
    stubLocation("/projects/abc", "?tab=specs");
    const { result } = mountWithFailingRefresh();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent("/projects/abc?tab=specs")}&reason=expired`,
      );
    });
  });

  // The workspace-invite landing page is read by people who have no session
  // yet; an involuntary bounce to /login makes the invite link useless.
  it("does NOT redirect an anonymous visitor away from an invite link", async () => {
    stubLocation("/invites/tok-123");
    const { result } = mountWithFailingRefresh();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await Promise.resolve();
    });
    const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("does NOT redirect or strip ?next when already on /login (cold-login guard)", async () => {
    stubLocation("/login", "?next=%2Fprojects%2Fabc");
    const { result } = mountWithFailingRefresh();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Let any queued redirect flush.
    await act(async () => {
      await Promise.resolve();
    });
    const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

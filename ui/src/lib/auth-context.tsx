"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch, refreshAccessToken, setOnRefreshFailure } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUser, LoginCredentials, LoginResponse } from "@/lib/auth-types";

/**
 * Lead time for the proactive sliding-session refresh (#410, epic #404).
 *
 * The access token has a ~1h TTL. We renew it silently at ~50 minutes — ~10 min
 * before expiry — so a realtime/long-poll gap or the socket layer (Epic 2)
 * never hits the hard 1h boundary, and a long-idle tab does not return to a dead
 * session. The lead margin absorbs timer drift, a backgrounded tab's throttled
 * timers, and the round-trip of the refresh itself. The proactive refresh reuses
 * the api-client's single-flight {@link refreshAccessToken}, so it never
 * double-refreshes against the reactive 401 path.
 */
export const PROACTIVE_REFRESH_MS = 50 * 60 * 1000;

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  /** Optional initial user, useful for tests + server-side hydration. */
  initialUser?: AuthUser | null;
  /**
   * Interval (ms) between proactive sliding-session refreshes (#410). Defaults
   * to {@link PROACTIVE_REFRESH_MS}. Exposed as an injectable prop purely as a
   * test seam so specs can drive the timer with `vi.useFakeTimers()` over a
   * short interval instead of waiting ~50 minutes.
   */
  refreshIntervalMs?: number;
}

export function AuthProvider({
  children,
  initialUser = null,
  refreshIntervalMs = PROACTIVE_REFRESH_MS,
}: AuthProviderProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  // If we were given a hydrated user up front, skip the initial /me probe.
  const [isLoading, setIsLoading] = useState<boolean>(initialUser === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ user: AuthUser }>("/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }, []);

  const login = useCallback(
    async ({ username, password }: LoginCredentials) => {
      setError(null);
      try {
        const data = await apiFetch<LoginResponse>("/auth/login", {
          method: "POST",
          body: { username, password },
        });
        setUser(data.user);
        queryClient.setQueryData(queryKeys.auth.me(), data.user);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Login failed";
        setError(message);
        throw err;
      }
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Logout is best-effort — we still clear local state.
    }
    setUser(null);
    queryClient.removeQueries({ queryKey: queryKeys.auth.all });
    router.push("/login");
  }, [queryClient, router]);

  useEffect(() => {
    if (initialUser !== null) {
      return;
    }
    void refresh().finally(() => setIsLoading(false));
  }, [initialUser, refresh]);

  // #410 — proactive silent refresh (sliding session). Today refresh is ONLY
  // reactive (a 401 drives the api-client single-flight). When authenticated, we
  // mount an interval that renews the access token shortly BEFORE its ~1h expiry,
  // reusing the SAME single-flight `refreshAccessToken()` so it never races /
  // double-refreshes against the reactive 401 path, then re-hydrates `/auth/me`
  // via `refresh()` to re-sync the user. The timer exists ONLY while a user is
  // present — it is torn down on logout, on `user` becoming null, and on unmount,
  // so we never refresh while logged out and never leak a timer.
  const isAuthenticated = user !== null;
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const id = setInterval(() => {
      void (async () => {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          // Re-hydrate the user from /auth/me so a server-side profile change
          // (or rotated claims) is reflected without a full reload.
          await refresh();
        }
      })();
    }, refreshIntervalMs);
    return () => clearInterval(id);
  }, [isAuthenticated, refreshIntervalMs, refresh]);

  // Wire the api-client's "refresh failed" hook so an expired session boots the
  // user back to /login instead of leaving stale UI in place.
  //
  // #411 — preserve the return route + signal WHY on every involuntary redirect:
  //  • Cold-login guard: if we are already ON /login, do NOT redirect — that
  //    would strip the `?next` the login form is holding (the documented
  //    cold-login bug where `router.replace("/login")` dropped the deep link, so
  //    sign-in landed on /dashboard instead of the requested page). We still
  //    clear user state; we just skip the redirect.
  //  • Otherwise redirect preserving the current location as `?next` (so sign-in
  //    returns the user to where they were) and tag `reason=expired` so the login
  //    form can explain the involuntary bounce. The `?next` VALUE we set is the
  //    current same-origin pathname+search; the READ side stays guarded by
  //    `safeRedirectPath` against open-redirect (OWASP A01).
  useEffect(() => {
    setOnRefreshFailure(() => {
      setUser(null);
      queryClient.removeQueries({ queryKey: queryKeys.auth.all });
      if (window.location.pathname === "/login") {
        return;
      }
      const here = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(here)}&reason=expired`);
    });
    return () => setOnRefreshFailure(null);
  }, [queryClient, router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      error,
      login,
      logout,
      refresh,
    }),
    [user, isLoading, error, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}

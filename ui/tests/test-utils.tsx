import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/lib/auth-context";
import type { AuthUser } from "@/lib/auth-types";

interface WrapperOpts {
  initialUser?: AuthUser | null;
  withAuth?: boolean;
  withTheme?: boolean;
  /**
   * Forwarded to `<AuthProvider refreshIntervalMs>` so timer specs can drive the
   * proactive sliding-session refresh (#410) over a short interval with fake
   * timers instead of waiting ~50 minutes.
   */
  refreshIntervalMs?: number;
}

export function makeWrapper(opts: WrapperOpts = {}) {
  const { initialUser = null, withAuth = true, withTheme = false, refreshIntervalMs } = opts;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    const tree = withAuth ? (
      <AuthProvider initialUser={initialUser} refreshIntervalMs={refreshIntervalMs}>
        {children}
      </AuthProvider>
    ) : (
      children
    );
    const themed = withTheme ? (
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        {tree}
      </ThemeProvider>
    ) : (
      tree
    );
    return <QueryClientProvider client={queryClient}>{themed}</QueryClientProvider>;
  };
}

export const TEST_USER: AuthUser = {
  id: "u-1",
  username: "tester",
  displayName: "Test User",
  email: "test@example.com",
  role: "admin",
  permissions: [],
};

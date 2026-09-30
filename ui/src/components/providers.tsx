"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import { createQueryClient } from "@/lib/query-client";
import { AuthProvider } from "@/lib/auth-context";
import type { AuthUser } from "@/lib/auth-types";

interface ProvidersProps {
  children: ReactNode;
  initialUser?: AuthUser | null;
}

/**
 * Sonner defaults to `light`, so the Toaster must be told the theme the app's
 * toggle resolved to — "system" is resolved by next-themes, so toasts track the
 * same `.dark` class the `dark:` utilities do (#429). Before next-themes has
 * resolved (SSR), fall back to sonner's own `system` handling.
 *
 * Keep that fallback server-only (PR #445 review): sonner 2.x adds a matchMedia
 * listener for theme="system" and never removes it, so if it ever reached the
 * client it would later override an explicit Light/Dark choice whenever the OS
 * scheme changed.
 */
function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" || resolvedTheme === "light" ? resolvedTheme : "system";
  return <Toaster position="bottom-right" richColors closeButton theme={theme} />;
}

/**
 * Top-level client providers. Order matters:
 *  - ThemeProvider first so SSR class hydration works without flicker
 *  - QueryClientProvider before AuthProvider so the auth context can use the
 *    shared cache for `auth.me`
 *  - Devtools only mount in development
 */
export function Providers({ children, initialUser = null }: ProvidersProps) {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <AuthProvider initialUser={initialUser}>{children}</AuthProvider>
        <ThemedToaster />
        {process.env.NODE_ENV === "development" ? (
          <ReactQueryDevtools initialIsOpen={false} />
        ) : null}
      </QueryClientProvider>
    </ThemeProvider>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { createQueryClient } from "@/lib/query-client";
import { AuthProvider } from "@/lib/auth-context";
import type { AuthUser } from "@/lib/auth-types";

interface ProvidersProps {
  children: ReactNode;
  initialUser?: AuthUser | null;
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
        <Toaster position="bottom-right" richColors closeButton />
        {process.env.NODE_ENV === "development" ? (
          <ReactQueryDevtools initialIsOpen={false} />
        ) : null}
      </QueryClientProvider>
    </ThemeProvider>
  );
}

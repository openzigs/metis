"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { useAuth } from "@/lib/auth-context";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { ConnectionStatus } from "@/components/realtime/connection-status";
import { SourceOfferFooter } from "./source-offer-footer";

interface AppShellProps {
  children: ReactNode;
}

/**
 * Authenticated application shell. Renders the sidebar + header + content.
 * Middleware blocks unauthenticated requests at the edge — this component
 * provides a defence-in-depth client-side redirect for the rare case where
 * the cookie expires mid-session.
 */
export function AppShell({ children }: AppShellProps) {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // #408 — this defence-in-depth redirect is gated on `!isLoading`, and
  // `isLoading` only clears after the auth provider's initial `/auth/me` probe
  // resolves (the probe internally drives the api-client's 401 → refresh → retry
  // single-flight). So this never races ahead of an in-flight refresh: when a
  // refresh would succeed the user is already authenticated by the time this
  // runs, and it only redirects after a genuine refresh failure.
  //
  // #411 — when it DOES redirect (a genuine failure), preserve the current
  // location as `?next` so sign-in returns the user to where they were, and tag
  // `reason=expired` so the login form explains the involuntary bounce. The
  // `?next` value is the current same-origin path; the login form re-validates
  // it with `safeRedirectPath` before honouring it (OWASP A01, no open redirect).
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const here = (pathname ?? "/") + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(here)}&reason=expired`);
    }
  }, [isLoading, isAuthenticated, router, pathname]);

  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground"
      >
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-background">
      {/* #415 — app-wide realtime connection-status banner (self-hides when healthy). */}
      <ConnectionStatus />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex min-h-screen flex-col md:pl-64">
        <Header onMenuClick={() => setMobileNavOpen(true)} />
        {/*
         * R2 (#157): the shell `main` is the single, canonical source of the
         * page gutter. Pages must NOT add their own outer page padding — use at
         * most `p-2 md:p-0` for fine mobile tuning — so content never double-pads.
         */}
        <main id="main-content" role="main" className="flex-1 p-4 md:p-6">
          {children}
        </main>
        {/*
         * #1296 — AGPL-3.0 §13 source offer. Inside the content column and after
         * `main`, so it sits at the bottom of the visible page rather than one
         * viewport below the `min-h-screen` shell. Also rendered on /login, which
         * is the only page an unauthenticated remote user can see.
         */}
        <SourceOfferFooter />
      </div>
      <CommandPalette />
    </div>
  );
}

"use client";

/**
 * SSO provider buttons — fetches enabled providers and renders branded login buttons.
 *
 * Epic #748, Issue #755: Login page provider auto-detect + branded buttons.
 * Issue #429 (Epic #407): consume the safe `{ id, label, type, loginUrl }` shape
 * from `GET /api/auth/sso/providers` and navigate to the server-provided live
 * `loginUrl` (rather than hard-coding the initiation path by mode), so a provider
 * configured under Admin → SSO appears here without a redeploy.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface SSOProvider {
  id: string;
  /** Human-readable display name shown on the button. */
  label: string;
  /** Provider mode — drives the button icon. */
  type: "saml" | "oidc";
  /** SP-initiated login URL the button navigates to (live, from the server). */
  loginUrl: string;
}

const TYPE_ICONS: Record<string, string> = {
  saml: "🔐",
  oidc: "🔑",
};

export function SSOButtons() {
  const [providers, setProviders] = useState<SSOProvider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Issue #281 — the providers endpoint may be absent in some deployments
    // (e.g. mock-auth mode). Treat ANY non-OK / network failure as "no SSO
    // configured" and render nothing, without surfacing a noisy error: a 404
    // here is an expected, non-actionable condition, not a bug.
    (async () => {
      try {
        const res = await fetch("/api/auth/sso/providers", {
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          if (!cancelled) setProviders([]);
          return;
        }
        const body = (await res.json()) as { data?: { providers?: SSOProvider[] } };
        if (!cancelled) setProviders(body.data?.providers ?? []);
      } catch {
        if (!cancelled) setProviders([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;
  if (providers.length === 0) return null;

  const handleSSOLogin = (provider: SSOProvider) => {
    // Navigate to the server-provided live initiation URL (#429).
    window.location.href = provider.loginUrl;
  };

  return (
    <div className="space-y-3">
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => handleSSOLogin(provider)}
          aria-label={`Sign in with ${provider.label}`}
        >
          <span className="mr-2">{TYPE_ICONS[provider.type] ?? "🔐"}</span>
          Sign in with {provider.label}
        </Button>
      ))}
      <div className="relative">
        <Separator />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
          or
        </span>
      </div>
    </div>
  );
}

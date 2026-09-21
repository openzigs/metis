import Image from "next/image";
import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Issue #430 (epic #407) — branded application-wide 404.
 *
 * Next.js routes any *unmatched* URL (e.g. `/projects/{id}/code`, which is not a
 * real route segment) to the **root** `app/not-found.tsx` — NOT to a nested
 * segment-level `not-found.tsx`. A segment-level `not-found` (e.g.
 * `(authed)/not-found.tsx`) only renders for `notFound()` thrown *within* that
 * segment's subtree; it never catches unmatched URLs. Because this root file did
 * not exist, unmatched URLs fell through to Next's bare built-in 404 — no app
 * chrome, no brand, no escape link. (Ref: Next.js docs, "Root `app/not-found`
 * handles global unmatched URLs" since v13.3.0.)
 *
 * This page is wrapped by the root `app/layout.tsx` (`<html><body><Providers>`),
 * so it inherits global styles. It supplies the METIS brand mark and a working
 * home action so a 404 is recoverable instead of a dead end.
 */
export default function NotFound() {
  return (
    <main
      role="alert"
      data-testid="app-not-found"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground"
    >
      <Link
        href="/dashboard"
        className="flex items-center gap-2 font-bold tracking-tight"
        aria-label="METIS home"
      >
        <Image
          src="/icon.svg"
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 rounded-md"
          aria-hidden
          priority
        />
        <span>METIS</span>
      </Link>

      <FileQuestion className="h-12 w-12 text-muted-foreground" aria-hidden />
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        We couldn&apos;t find the page you were looking for. The link may be broken, or the page may
        have been moved or deleted.
      </p>

      <Button asChild className="mt-1">
        <Link href="/dashboard" data-testid="app-not-found-home">
          Back to dashboard
        </Link>
      </Button>
    </main>
  );
}

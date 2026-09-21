import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * S1 (#143) — not-found UI for the authed segment. Rendered when `notFound()`
 * is called in a page/layout. Provides a helpful message and an escape link.
 */
export default function AuthedNotFound() {
  return (
    <div
      role="alert"
      data-testid="authed-not-found"
      className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 text-center"
    >
      <FileQuestion className="h-10 w-10 text-muted-foreground" aria-hidden />
      <h2 className="text-lg font-semibold">Page not found</h2>
      <p className="text-sm text-muted-foreground">
        We couldn&apos;t find the page you were looking for. It may have been moved or deleted.
      </p>
      <Button asChild className="mt-1">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}

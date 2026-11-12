import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * #2332 — what a non-admin sees on a page hidden from them (opened from an old
 * link or a typed URL): a plain refusal with a way back, never a blank or
 * half-loaded screen. Shaped like the authed not-found page. The server still
 * refuses every admin-only route the page would have called.
 */
export function NoAccess({ testId = "no-access" }: { testId?: string }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 text-center"
    >
      <ShieldAlert className="h-10 w-10 text-muted-foreground" aria-hidden />
      <h2 className="text-lg font-semibold">You don&apos;t have access to this page</h2>
      <p className="text-sm text-muted-foreground">
        This page is for system administrators. Ask one if you need something from it.
      </p>
      <Button asChild className="mt-1">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}

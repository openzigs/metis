import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { SourceOfferFooter } from "@/components/layout/source-offer-footer";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex flex-1 items-center justify-center px-4">
        <Suspense
          fallback={
            <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
              Loading login…
            </div>
          }
        >
          <LoginForm />
        </Suspense>
      </main>
      {/*
       * #1296 — AGPL-3.0 §13 obliges the source offer to reach ALL users
       * interacting with METIS remotely. An unauthenticated visitor sees only this
       * page, so the offer has to be here as well as in the authenticated shell.
       */}
      <SourceOfferFooter />
    </div>
  );
}

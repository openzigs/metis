"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SSOButtons } from "./sso-buttons";

interface ValidationErrors {
  username?: string;
  password?: string;
}

export function validateLogin(username: string, password: string): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!username.trim()) errors.username = "Username is required";
  if (!password) errors.password = "Password is required";
  return errors;
}

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { login, isAuthenticated, isLoading } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = search?.get("next") ?? null;

  // #411 — when an involuntary redirect tagged the bounce as `reason=expired`,
  // show a short explanatory banner so the user understands WHY they are back at
  // login (vs. a normal first visit, which shows nothing). The banner copy is
  // STATIC: we only test `reason === "expired"` and never interpolate any query
  // text into the DOM, so a crafted `?reason=...` value cannot inject markup
  // (OWASP A03 — no reflected/unsanitized input).
  const sessionExpired = search?.get("reason") === "expired";

  // #408 — if a valid session already exists (or was just restored by the
  // api-client's refresh on the initial `/auth/me` probe), never strand the user
  // on the login form: redirect to `?next` (or the safe default). This closes the
  // "logged out for no reason" dead-end where an involuntary bounce landed an
  // already-authenticated user here, and makes reloading /login with a valid
  // refresh cookie restore the session and move on instead of showing the form.
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace(safeRedirectPath(next));
    }
  }, [isLoading, isAuthenticated, next, router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    const validation = validateLogin(username, password);
    setErrors(validation);
    if (Object.keys(validation).length > 0) {
      return;
    }
    setSubmitting(true);
    try {
      await login({ username, password });
      router.replace(safeRedirectPath(next));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <Image
          src="/icon.svg"
          alt="Metis logo"
          width={64}
          height={64}
          className="mb-2 rounded-xl"
          priority
        />
        <CardTitle>Sign in to METIS</CardTitle>
        <CardDescription>Master Enterprise Tool for Issue Synthesis</CardDescription>
      </CardHeader>
      <CardContent>
        {sessionExpired ? (
          <div
            role="status"
            className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
          >
            Your session expired — please sign in again.
          </div>
        ) : null}
        <SSOButtons />
        <form
          onSubmit={handleSubmit}
          noValidate
          aria-describedby={submitError ? "login-error" : undefined}
          className="space-y-4"
        >
          {submitError ? (
            <div
              id="login-error"
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {submitError}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={Boolean(errors.username)}
              aria-describedby={errors.username ? "username-error" : undefined}
            />
            {errors.username ? (
              <p id="username-error" className="text-xs text-destructive">
                {errors.username}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
            />
            {errors.password ? (
              <p id="password-error" className="text-xs text-destructive">
                {errors.password}
              </p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

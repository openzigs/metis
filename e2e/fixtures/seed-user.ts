/**
 * Mock-user seed for the full-flow Playwright suite.
 *
 * The mock auth provider (`server/src/lib/auth/mock-provider.ts`) accepts
 * `admin / password` and the `requireAuth` middleware lazily upserts the
 * matching `User` row on first login via `ensureUserRow()`. That means a
 * dedicated DB-side seed is not strictly required to authenticate.
 *
 * However the issue (#144) explicitly requires a "mock-user seeding for
 * login" helper so the credentials live in one place and so future suites
 * that need additional roles can extend the fixture without re-discovering
 * the contract. We export the canonical credentials here.
 *
 * The fixture also primes the user row by hitting the real
 * `POST /api/auth/login` endpoint once. This is a no-op when the row already
 * exists and gives us a deterministic actor id we can use for follow-up API
 * assertions before any test body runs.
 */
import { request, type APIRequestContext } from "@playwright/test";

export interface SeededUser {
  username: string;
  password: string;
  displayName: string;
  email: string;
  role: "admin" | "coordinator" | "developer" | "reader";
}

export const ADMIN_USER: SeededUser = {
  username: "admin",
  password: "password",
  displayName: "System Admin",
  email: "admin@metis.local",
  role: "admin",
};

export interface PrimeResult {
  user: SeededUser;
  userId: string;
  accessToken: string;
}

/**
 * Prime the mock admin user against a running API server. Returns the
 * server-side user id and an access token for subsequent API-level
 * assertions. UI flows still log in through the browser to exercise the
 * cookie + proxy path end-to-end.
 */
export async function primeAdminUser(apiBaseUrl: string): Promise<PrimeResult> {
  const ctx: APIRequestContext = await request.newContext({ baseURL: apiBaseUrl });
  try {
    const res = await ctx.post("/api/auth/login", {
      data: { username: ADMIN_USER.username, password: ADMIN_USER.password },
    });
    if (!res.ok()) {
      throw new Error(`Failed to prime admin user (status ${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as {
      success: boolean;
      data: { user: { id: string }; accessToken: string };
    };
    if (!body.success || !body.data?.accessToken || !body.data?.user?.id) {
      throw new Error(`Unexpected /api/auth/login response shape: ${JSON.stringify(body)}`);
    }
    return {
      user: ADMIN_USER,
      userId: body.data.user.id,
      accessToken: body.data.accessToken,
    };
  } finally {
    await ctx.dispose();
  }
}

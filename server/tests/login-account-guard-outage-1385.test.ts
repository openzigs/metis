/**
 * #1385 (#1393 panel) — the per-account cap counts a REFUSED PASSWORD only.
 *
 * A directory outage (`ECONNREFUSED`, a timeout, a failed service bind) is not a
 * guess at the password. Counting it would leave users with the right password
 * answered 429 for a window after the directory came back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthResult } from "../src/lib/auth/types.js";

const provider = vi.hoisted(() => ({ next: null as unknown as AuthResult }));
vi.mock("../src/lib/auth/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth/providers.js")>()),
  getAuthProvider: () => ({ name: "stub", authenticate: async () => provider.next }),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { $queryRawUnsafe: vi.fn(async () => 1), auditLog: { create: vi.fn(async () => ({})) } },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import request from "supertest";
import { createApp } from "../src/app.js";

afterEach(() => vi.unstubAllEnvs());

describe("per-account cap on the real login route (#1385)", () => {
  const app = createApp();
  const login = (username: string) =>
    request(app).post("/api/auth/login").send({ username, password: "whatever" });

  it("does not count an outage", async () => {
    vi.stubEnv("AUTH_ACCOUNT_RATE_LIMIT_MAX", "2");
    provider.next = { success: false, error: "Authentication service unavailable" };
    for (let i = 0; i < 5; i += 1) expect((await login("outage-user")).status).toBe(401);
  });

  it("does count a refused password", async () => {
    vi.stubEnv("AUTH_ACCOUNT_RATE_LIMIT_MAX", "2");
    provider.next = {
      success: false,
      error: "Invalid username or password",
      reason: "invalid_credentials",
    };
    expect((await login("guessed-user")).status).toBe(401);
    expect((await login("guessed-user")).status).toBe(401);
    expect((await login("guessed-user")).status).toBe(429);
  });
});

/**
 * Issue #682 (follow-up) — boot-time auth fail-fast.
 *
 * The production guard in `providers.ts` refuses the insecure mock provider,
 * but `getAuthProvider()` is otherwise called lazily on the first login. These
 * tests prove the STARTUP/bootstrap path (`assertStartupAuthConfig`, invoked in
 * the `index.ts` boot block before the server listens) actually triggers that
 * guard — so a misconfigured production process fails at boot, not on first
 * login. `tests/setup.ts` sets `METIS_NO_LISTEN=1`, so importing `index.ts`
 * here does not run the listen/boot block; we call the exported helper directly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assertStartupAuthConfig, assertStartupSecretsConfig } from "../src/index.js";
import { __resetAuthProvider } from "../src/lib/auth/providers.js";

describe("assertStartupAuthConfig (boot-time auth fail-fast)", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  const setEnv = (value: string) => {
    // NODE_ENV is typed readonly in some setups; assign via index to satisfy TS.
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };

  afterEach(() => {
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  it("throws at startup in production when AUTH_MODE=mock", () => {
    __resetAuthProvider();
    setEnv("production");
    process.env.AUTH_MODE = "mock";
    expect(() => assertStartupAuthConfig()).toThrow(/mock/i);
  });

  it("throws at startup in production when AUTH_MODE is unset", () => {
    __resetAuthProvider();
    setEnv("production");
    delete process.env.AUTH_MODE;
    expect(() => assertStartupAuthConfig()).toThrow(/production/i);
  });

  it("throws at startup in production when AUTH_MODE is a typo/unknown value", () => {
    __resetAuthProvider();
    setEnv("production");
    process.env.AUTH_MODE = "moc";
    expect(() => assertStartupAuthConfig()).toThrow(/production/i);
  });

  it("throws at startup in production when AUTH_MODE is whitespace-only", () => {
    __resetAuthProvider();
    setEnv("production");
    process.env.AUTH_MODE = "   ";
    expect(() => assertStartupAuthConfig()).toThrow(/production/i);
  });

  it("does NOT throw at startup in production for a real provider (ldap)", () => {
    __resetAuthProvider();
    setEnv("production");
    process.env.AUTH_MODE = "ldap";
    expect(() => assertStartupAuthConfig()).not.toThrow();
  });

  it("does NOT throw at startup in development with mock", () => {
    __resetAuthProvider();
    setEnv("development");
    process.env.AUTH_MODE = "mock";
    expect(() => assertStartupAuthConfig()).not.toThrow();
  });
});

/**
 * Issue #1057 — the JWT signing secret gets the same boot-time treatment. This
 * proves the startup helper is actually wired to the `jwt.ts` policy, so a
 * deployment that would sign with the published dev key dies at boot rather
 * than on the first login. The policy itself is exhaustively covered in
 * `jwt-secret-guard.test.ts`.
 */
describe("assertStartupSecretsConfig (boot-time JWT secret fail-fast)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecret = process.env.JWT_SECRET;

  const setEnv = (value: string) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalSecret;
  });

  it("throws at startup when JWT_SECRET is missing and NODE_ENV is not local development", () => {
    setEnv("staging");
    delete process.env.JWT_SECRET;
    expect(() => assertStartupSecretsConfig()).toThrow(/JWT_SECRET must be set to a strong value/);
  });

  it("does NOT throw at startup in local development without a JWT_SECRET", () => {
    setEnv("development");
    delete process.env.JWT_SECRET;
    expect(() => assertStartupSecretsConfig()).not.toThrow();
  });

  it("does NOT throw at startup in production with a strong JWT_SECRET", () => {
    setEnv("production");
    process.env.JWT_SECRET = "a".repeat(64);
    expect(() => assertStartupSecretsConfig()).not.toThrow();
  });
});

/**
 * Issue #1057 (F8, CWE-798) — the JWT dev-secret fallback must be gated on an
 * EXPLICIT positive signal for local development, never on "not production".
 *
 * The old rule was `NODE_ENV !== "production" → return a hardcoded key`, so a
 * single-string mismatch (`"Production"`, `"prod"`, unset — the default in a
 * container image that forgets to set it) silently downgraded a real deployment
 * to a publicly-known signing key. Anyone with the source could then forge an
 * admin token.
 *
 * These tests pin the new contract:
 *   - local development (NODE_ENV=development|test, not orchestrated) may fall
 *     back, and must SHOUT about it;
 *   - every other environment FAILS CLOSED;
 *   - MIN_SECRET_BYTES is enforced outside local development too, so a weak
 *     staging secret is caught instead of quietly accepted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: warnSpy,
  }),
}));

import {
  DEV_FALLBACK_SECRET,
  assertJwtSecretConfigured,
  isLocalDevelopment,
  resolveJwtSecret,
  __resetJwtSecretWarnings,
} from "../src/lib/auth/jwt.js";

/** A 64-char hex secret, i.e. what `openssl rand -hex 32` produces. */
const STRONG_SECRET = "a".repeat(64);

/**
 * Build an env snapshot from scratch. Passing an explicit object (rather than
 * mutating `process.env`) keeps these cases hermetic — the suite's own
 * NODE_ENV/JWT_SECRET from `tests/setup.ts` cannot leak in, and nothing leaks
 * out to other files.
 */
function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

beforeEach(() => {
  warnSpy.mockClear();
  __resetJwtSecretWarnings();
});

describe("isLocalDevelopment", () => {
  it("is true only for an explicit development/test NODE_ENV", () => {
    expect(isLocalDevelopment(env({ NODE_ENV: "development" }))).toBe(true);
    expect(isLocalDevelopment(env({ NODE_ENV: "test" }))).toBe(true);
    expect(isLocalDevelopment(env({ NODE_ENV: "  Development  " }))).toBe(true);
  });

  it("is false for unset, staging, production, and near-miss spellings", () => {
    expect(isLocalDevelopment(env({}))).toBe(false);
    expect(isLocalDevelopment(env({ NODE_ENV: "" }))).toBe(false);
    expect(isLocalDevelopment(env({ NODE_ENV: "staging" }))).toBe(false);
    expect(isLocalDevelopment(env({ NODE_ENV: "preview" }))).toBe(false);
    expect(isLocalDevelopment(env({ NODE_ENV: "production" }))).toBe(false);
    expect(isLocalDevelopment(env({ NODE_ENV: "prod" }))).toBe(false);
    expect(isLocalDevelopment(env({ NODE_ENV: "dev" }))).toBe(false);
  });

  it("is false inside a Kubernetes pod even when NODE_ENV says development", () => {
    // Defense in depth: a review/preview app deployed to a cluster with
    // NODE_ENV=development is NOT a developer laptop.
    expect(
      isLocalDevelopment(env({ NODE_ENV: "development", KUBERNETES_SERVICE_HOST: "10.0.0.1" })),
    ).toBe(false);
  });
});

describe("resolveJwtSecret — fails closed outside local development", () => {
  it("refuses to start when NODE_ENV is unset and JWT_SECRET is missing", () => {
    expect(() => resolveJwtSecret(env({}))).toThrow(/JWT_SECRET must be set to a strong value/);
  });

  it("refuses to start when NODE_ENV=staging and JWT_SECRET is missing", () => {
    expect(() => resolveJwtSecret(env({ NODE_ENV: "staging" }))).toThrow(
      /JWT_SECRET must be set to a strong value/,
    );
  });

  it("names the offending NODE_ENV in the error so the operator can see the mismatch", () => {
    expect(() => resolveJwtSecret(env({ NODE_ENV: "Production" }))).toThrow(/Production/);
    expect(() => resolveJwtSecret(env({}))).toThrow(/unset/);
  });

  it("refuses the shipped .env.example placeholder outside local development", () => {
    expect(() =>
      resolveJwtSecret(
        env({ NODE_ENV: "staging", JWT_SECRET: "replace-me-with-a-long-random-string" }),
      ),
    ).toThrow(/JWT_SECRET must be set to a strong value/);
  });

  it("refuses the dev fallback key even when set explicitly — it is publicly known", () => {
    expect(() =>
      resolveJwtSecret(env({ NODE_ENV: "staging", JWT_SECRET: DEV_FALLBACK_SECRET })),
    ).toThrow(/JWT_SECRET must be set to a strong value/);
  });

  it("refuses a whitespace-only JWT_SECRET", () => {
    expect(() => resolveJwtSecret(env({ NODE_ENV: "staging", JWT_SECRET: "   " }))).toThrow(
      /JWT_SECRET must be set to a strong value/,
    );
  });

  it("enforces MIN_SECRET_BYTES in staging, not just production", () => {
    expect(() =>
      resolveJwtSecret(env({ NODE_ENV: "staging", JWT_SECRET: "x".repeat(31) })),
    ).toThrow(/at least 32 bytes/);
  });

  it("enforces MIN_SECRET_BYTES when NODE_ENV is unset", () => {
    expect(() => resolveJwtSecret(env({ JWT_SECRET: "x".repeat(31) }))).toThrow(
      /at least 32 bytes/,
    );
  });

  it("fails closed inside Kubernetes even with NODE_ENV=development", () => {
    expect(() =>
      resolveJwtSecret(env({ NODE_ENV: "development", KUBERNETES_SERVICE_HOST: "10.0.0.1" })),
    ).toThrow(/JWT_SECRET must be set to a strong value/);
  });
});

describe("resolveJwtSecret — production behaviour is preserved", () => {
  it("throws when JWT_SECRET is unset in production", () => {
    expect(() => resolveJwtSecret(env({ NODE_ENV: "production" }))).toThrow(
      /must be set to a strong value/,
    );
  });

  it("throws when JWT_SECRET is shorter than 32 bytes in production", () => {
    expect(() =>
      resolveJwtSecret(env({ NODE_ENV: "production", JWT_SECRET: "x".repeat(31) })),
    ).toThrow(/at least 32 bytes/);
  });

  it("accepts a 32-byte secret in production", () => {
    expect(
      resolveJwtSecret(env({ NODE_ENV: "production", JWT_SECRET: "x".repeat(32) })).secret,
    ).toBe("x".repeat(32));
  });
});

describe("resolveJwtSecret — local development still works with no extra setup", () => {
  it("falls back to the dev key when JWT_SECRET is unset in development", () => {
    const result = resolveJwtSecret(env({ NODE_ENV: "development" }));
    expect(result.secret).toBe(DEV_FALLBACK_SECRET);
    expect(result.usingInsecureFallback).toBe(true);
  });

  it("falls back when JWT_SECRET is the .env.example placeholder in development", () => {
    const result = resolveJwtSecret(
      env({ NODE_ENV: "development", JWT_SECRET: "replace-me-with-a-long-random-string" }),
    );
    expect(result.secret).toBe(DEV_FALLBACK_SECRET);
    expect(result.usingInsecureFallback).toBe(true);
  });

  it("returns a loud warning naming the fallback as insecure", () => {
    const { warnings } = resolveJwtSecret(env({ NODE_ENV: "development" }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/INSECURE/);
    expect(warnings[0]).toMatch(/publicly known/i);
    expect(warnings[0]).toMatch(/JWT_SECRET/);
  });

  it("accepts a short secret in local development but warns (docker-compose dev default)", () => {
    // docker-compose.yml ships JWT_SECRET=docker-dev-secret-change-me (27 bytes)
    // for the dev stack. That must keep working, loudly.
    const result = resolveJwtSecret(
      env({ NODE_ENV: "development", JWT_SECRET: "docker-dev-secret-change-me" }),
    );
    expect(result.secret).toBe("docker-dev-secret-change-me");
    expect(result.usingInsecureFallback).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/shorter than 32 bytes/);
  });

  it("emits no warnings once a strong secret is configured", () => {
    const result = resolveJwtSecret(env({ NODE_ENV: "development", JWT_SECRET: STRONG_SECRET }));
    expect(result).toEqual({
      secret: STRONG_SECRET,
      usingInsecureFallback: false,
      warnings: [],
    });
  });
});

describe("resolveJwtSecret — a strong secret works in every mode", () => {
  for (const nodeEnv of ["development", "test", "staging", "production", undefined]) {
    it(`accepts a strong secret with NODE_ENV=${nodeEnv ?? "(unset)"}`, () => {
      const result = resolveJwtSecret(env({ NODE_ENV: nodeEnv, JWT_SECRET: STRONG_SECRET }));
      expect(result.secret).toBe(STRONG_SECRET);
      expect(result.usingInsecureFallback).toBe(false);
      expect(result.warnings).toEqual([]);
    });
  }

  it("preserves secret bytes exactly, including surrounding whitespace", () => {
    // Trimming would silently change the signing key for anyone whose .env has
    // a trailing space, invalidating every issued token on deploy.
    const padded = ` ${STRONG_SECRET} `;
    expect(resolveJwtSecret(env({ NODE_ENV: "production", JWT_SECRET: padded })).secret).toBe(
      padded,
    );
  });
});

describe("assertJwtSecretConfigured (startup gate)", () => {
  const withEnv = <T>(overrides: Record<string, string | undefined>, fn: () => T): T => {
    const mutable = process.env as Record<string, string | undefined>;
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(overrides)) {
      saved[key] = mutable[key];
      if (overrides[key] === undefined) delete mutable[key];
      else mutable[key] = overrides[key];
    }
    try {
      return fn();
    } finally {
      for (const key of Object.keys(overrides)) {
        if (saved[key] === undefined) delete mutable[key];
        else mutable[key] = saved[key];
      }
    }
  };

  it("throws at startup when NODE_ENV is unset and JWT_SECRET is missing", () => {
    withEnv({ NODE_ENV: undefined, JWT_SECRET: undefined }, () => {
      expect(() => assertJwtSecretConfigured()).toThrow(/must be set to a strong value/);
    });
  });

  it("logs the insecure-fallback warning at startup in development", () => {
    withEnv({ NODE_ENV: "development", JWT_SECRET: undefined }, () => {
      assertJwtSecretConfigured();
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/INSECURE/);
  });

  it("stays silent when a strong secret is configured", () => {
    withEnv({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET }, () => {
      assertJwtSecretConfigured();
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

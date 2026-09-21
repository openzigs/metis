import { describe, it, expect } from "vitest";
import {
  SECRET_KEYS,
  generateHexSecret,
  generateSecrets,
  applySecrets,
  redactSecret,
} from "./bootstrap-env.mjs";

describe("generateHexSecret", () => {
  it("produces 2*bytes hex chars from the injected RNG", () => {
    const rng = () => Buffer.from([0xab, 0xcd, 0xef]);
    expect(generateHexSecret(3, rng)).toBe("abcdef");
  });
  it("defaults to 32 bytes → 64 hex chars with the real CSPRNG", () => {
    const s = generateHexSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("generateSecrets", () => {
  it("creates a value for every secret key", () => {
    let n = 0;
    const secrets = generateSecrets(() => `secret-${n++}`);
    expect(Object.keys(secrets).sort()).toEqual([...SECRET_KEYS].sort());
    expect(new Set(Object.values(secrets)).size).toBe(SECRET_KEYS.length);
  });
});

describe("applySecrets", () => {
  it("replaces only the first matching KEY= line and preserves the rest", () => {
    const template = [
      "# comment",
      "JWT_SECRET=replace-me",
      "OTHER=keep",
      "VAULT_MASTER_KEY=replace-me-too",
      "JWT_SECRET=should-not-touch-second",
      "",
    ].join("\n");
    const out = applySecrets(template, {
      JWT_SECRET: "AAA",
      VAULT_MASTER_KEY: "BBB",
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("# comment");
    expect(lines[1]).toBe("JWT_SECRET=AAA");
    expect(lines[2]).toBe("OTHER=keep");
    expect(lines[3]).toBe("VAULT_MASTER_KEY=BBB");
    // second JWT_SECRET occurrence is left untouched
    expect(lines[4]).toBe("JWT_SECRET=should-not-touch-second");
  });

  it("leaves content unchanged when no keys match", () => {
    const template = "FOO=bar\nBAZ=qux";
    expect(applySecrets(template, { JWT_SECRET: "x" })).toBe(template);
  });
});

describe("redactSecret", () => {
  it("never echoes the value", () => {
    const out = redactSecret("supersecretvalue");
    expect(out).not.toContain("supersecretvalue");
    expect(out).toContain("16 chars");
  });
  it("handles empty / undefined", () => {
    expect(redactSecret("")).toContain("0 chars");
    // @ts-expect-error testing defensive path
    expect(redactSecret(undefined)).toContain("0 chars");
  });
});

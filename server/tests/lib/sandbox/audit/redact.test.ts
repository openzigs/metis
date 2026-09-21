/**
 * Tests for `redactSandboxPayload` (Epic #395 #413).
 */
import { describe, expect, it } from "vitest";
import {
  redactSandboxPayload,
  redactSecretsInString,
} from "../../../../src/lib/sandbox/audit/redact.js";

describe("redactSandboxPayload", () => {
  it("returns primitives untouched", () => {
    expect(redactSandboxPayload(1)).toBe(1);
    expect(redactSandboxPayload("hi")).toBe("hi");
    expect(redactSandboxPayload(null)).toBeNull();
    expect(redactSandboxPayload(undefined)).toBeUndefined();
  });

  it("strips token-shaped keys", () => {
    const out = redactSandboxPayload({
      command: "npm test",
      token: "ghp_abc",
      apiKey: "k-abc",
      Authorization: "Bearer xyz",
      password: "p",
    }) as Record<string, string>;
    expect(out.command).toBe("npm test");
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
  });

  /**
   * #1268 — this sink declares `REDACTION_SINK_POLICY: no-token-count-exemption`
   * while `logger.ts` and `audit-service.ts` declare `exempt-token-counts`.
   *
   * That is a deliberate per-sink choice, not an oversight, so it is asserted in
   * both directions here: a numeric count IS blanked (the policy), and a
   * credential IS blanked (the guard). The premise the policy rests on — that no
   * count reaches this sink — is re-derived from the four sandbox providers'
   * emit calls by `server/tests/redaction-sinks.enumeration.test.ts`, which
   * fails the moment one does. Reasoning: `docs/decisions/0008-redaction-sinks.md`.
   */
  it("blanks numeric token counts too — this sink takes no exemption (#1268)", () => {
    const out = redactSandboxPayload({
      bytes: 4096,
      durationMs: 12,
      totalTokens: 4096,
      promptTokens: 100,
      tokens: 7,
    }) as Record<string, unknown>;
    // Non-token counts are untouched, so this is a statement about /token/i and
    // not about numbers in general.
    expect(out.bytes).toBe(4096);
    expect(out.durationMs).toBe(12);
    expect(out.totalTokens).toBe("[REDACTED]");
    expect(out.promptTokens).toBe("[REDACTED]");
    expect(out.tokens).toBe("[REDACTED]");
  });

  it("keeps blanking credential-shaped keys regardless of value type (#1268)", () => {
    const out = redactSandboxPayload({
      accessToken: "ghp_abc",
      refresh_token: 12345,
      sessionId: "s-1",
      credential: "c",
      privateKey: "-----BEGIN",
    }) as Record<string, unknown>;
    expect(out.accessToken).toBe("[REDACTED]");
    // A numeric value buys nothing here: no exemption is consulted at all.
    expect(out.refresh_token).toBe("[REDACTED]");
    expect(out.sessionId).toBe("[REDACTED]");
    expect(out.credential).toBe("[REDACTED]");
    expect(out.privateKey).toBe("[REDACTED]");
  });

  it("strips file-content shaped keys", () => {
    const out = redactSandboxPayload({
      path: "/etc/secrets",
      content: "BEGIN RSA",
      body: "{}",
    }) as Record<string, string>;
    expect(out.path).toBe("/etc/secrets");
    expect(out.content).toBe("[REDACTED]");
    expect(out.body).toBe("[REDACTED]");
  });

  it("recurses into nested objects", () => {
    const out = redactSandboxPayload({
      env: { TOKEN: "x", FOO: "bar" },
    }) as { env: Record<string, string> };
    expect(out.env.TOKEN).toBe("[REDACTED]");
    expect(out.env.FOO).toBe("bar");
  });

  it("recurses into arrays", () => {
    const out = redactSandboxPayload([
      { secret: "a", k: "v" },
      { secret: "b", k: "w" },
    ]) as Array<Record<string, string>>;
    expect(out[0].secret).toBe("[REDACTED]");
    expect(out[1].secret).toBe("[REDACTED]");
  });

  it("matches case-insensitively", () => {
    const out = redactSandboxPayload({ TOKEN: "x", Secret: "y" }) as Record<string, string>;
    expect(out.TOKEN).toBe("[REDACTED]");
    expect(out.Secret).toBe("[REDACTED]");
  });

  it("does not loop infinitely on deep structures", () => {
    let cur: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 50; i++) cur = { nested: cur };
    expect(() => redactSandboxPayload(cur)).not.toThrow();
  });

  it("scrubs inline secrets inside string VALUES (not just keys)", () => {
    const out = redactSandboxPayload({
      command:
        "curl -H 'Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' https://api.example.com",
    }) as { command: string };
    expect(out.command).not.toContain("ghp_AAAA");
    expect(out.command).toContain("[REDACTED]");
    // The header name is preserved so audit consumers can see "an auth
    // header was present" without exposing the credential value.
    expect(out.command).toMatch(/Authorization:\s*Bearer\s+\[REDACTED\]/);
  });
});

describe("redactSecretsInString", () => {
  it("redacts Authorization: Bearer headers", () => {
    expect(redactSecretsInString("Authorization: Bearer abcdef.GHI_jkl-123/=")).toMatch(
      /Authorization:\s*Bearer\s+\[REDACTED\]/,
    );
  });

  it("redacts Authorization: Basic headers", () => {
    expect(redactSecretsInString("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toMatch(
      /Authorization:\s*Basic\s+\[REDACTED\]/,
    );
  });

  it("redacts OpenAI-style sk- API keys", () => {
    const input = "OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const out = redactSecretsInString(input);
    expect(out).not.toContain("sk-AbCd");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts Slack bot tokens (xoxb-)", () => {
    const out = redactSecretsInString("token=xoxb-1234567890-abcdefghij-AbCdEfGhIjKlMnOpQrStUvWx");
    expect(out).not.toContain("xoxb-1234");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub PATs (ghp_36chars)", () => {
    const out = redactSecretsInString("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA is a token");
    expect(out).not.toMatch(/ghp_AAAA/);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub server tokens (ghs_36chars)", () => {
    const out = redactSecretsInString("token=ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(out).not.toMatch(/ghs_BBBB/);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub OAuth tokens (gho_36chars)", () => {
    const out = redactSecretsInString("gho_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    expect(out).not.toMatch(/gho_CCCC/);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts AWS access key ids (AKIA + 16 upper alnum)", () => {
    const out = redactSecretsInString("--access-key AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts Google API keys (AIza + 35 chars)", () => {
    const out = redactSecretsInString("key=AIzaSyA-Z0fakegooglekey1234567890_abcdefg");
    expect(out).not.toContain("AIzaSyA");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitLab PATs (glpat- + 20+ chars)", () => {
    const out = redactSecretsInString("token=glpat-AbCdEfGhIjKlMnOpQrSt");
    expect(out).not.toContain("glpat-AbCd");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts long base64-padded secrets after = or : separators", () => {
    const a = redactSecretsInString("password=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==");
    expect(a).not.toContain("AbCdEfGh");
    expect(a).toMatch(/password=\[REDACTED\]/);
    const b = redactSecretsInString("Cookie: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==");
    expect(b).toContain("[REDACTED]");
  });

  it("leaves innocuous strings untouched", () => {
    expect(redactSecretsInString("npm install")).toBe("npm install");
    expect(redactSecretsInString("echo hello world")).toBe("echo hello world");
    expect(redactSecretsInString("ls -la /tmp")).toBe("ls -la /tmp");
  });

  it("scrubs MULTIPLE secrets in a single string", () => {
    const out = redactSecretsInString(
      "curl -H 'Authorization: Bearer abc123def456ghi789' --data 'key=AKIAIOSFODNN7EXAMPLE' https://example.com",
    );
    expect(out).not.toMatch(/Bearer\s+abc123/);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const matches = out.match(/\[REDACTED\]/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("redactSecretsInString — Anthropic keys & DB connection strings (#685)", () => {
  it("redacts Anthropic sk-ant- API keys", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-api03-Z9y8X7w6V5u4T3s2R1q0-pOnMlKjIhGfEdCbA_0123456789";
    const out = redactSecretsInString(input);
    expect(out).not.toContain("sk-ant-api03");
    expect(out).toContain("[REDACTED]");
  });

  it("collapses a full sk-ant- key to a single [REDACTED] with no prefix left behind", () => {
    const out = redactSecretsInString("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx0123456789");
    expect(out).toBe("[REDACTED]");
  });

  it("redacts connection-string credentials while keeping the host", () => {
    const out = redactSecretsInString(
      "DATABASE_URL=postgresql://dbuser:s3cr3t_P4ss@db.internal:5432/metis",
    );
    expect(out).not.toContain("s3cr3t_P4ss");
    expect(out).not.toContain("dbuser");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("db.internal:5432/metis");
  });

  it("redacts credentials across DB URI schemes (including empty user)", () => {
    const cases = [
      "mysql://root:hunter2longenoughpw@10.0.0.5/app",
      "mongodb://admin:p4ssw0rdp4ssw0rd@mongo:27017/db",
      "redis://:onlypasswordhere@cache:6379",
      "amqp://guest:guestsecretpw@rabbit:5672",
    ];
    for (const uri of cases) {
      const out = redactSecretsInString(uri);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toMatch(/hunter2|p4ssw0rd|onlypasswordhere|guestsecretpw/);
    }
  });

  it("leaves credential-less URLs intact", () => {
    const url = "clone https://github.com/openzigs/metis.git";
    expect(redactSecretsInString(url)).toBe(url);
  });

  it("redacts sk-ant keys and DB credentials nested in a payload", () => {
    const out = redactSandboxPayload({
      command:
        "psql postgresql://svc:MyP4ssw0rdHere@10.0.0.9/prod ; export ANTHROPIC_API_KEY=sk-ant-api03-Z9y8X7w6V5u4T3s2R1q0pOnMlKjIhGfEdCbA0123",
      args: ["--url", "mysql://root:rootpwlongenough@db/app"],
    }) as { command: string; args: string[] };
    expect(out.command).not.toContain("MyP4ssw0rdHere");
    expect(out.command).not.toContain("sk-ant-api03-Z9");
    expect(out.command).toContain("[REDACTED]");
    expect(out.command).toContain("10.0.0.9");
    expect(out.args[1]).not.toContain("rootpwlongenough");
    expect(out.args[1]).toContain("[REDACTED]");
  });
});

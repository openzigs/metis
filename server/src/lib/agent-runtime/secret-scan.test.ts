/** Epic #129 — no credentials in agent personas, skill bodies or supporting files. */
import { describe, expect, it } from "vitest";
import { assertNoSecrets, DefinitionSecretError, findSecretKinds } from "./secret-scan.js";

// Built at runtime so this file never carries a credential-shaped literal.
const AWS = ["AKIA", "Q3EGRTXXXXZ7Y2WB"].join("");
const GH = ["ghp_", "a".repeat(36)].join("");
const ANTHROPIC = ["sk-ant-", "api03-", "b".repeat(40)].join("");
const OPENAI = ["sk-proj-", "c".repeat(40)].join("");
const KEY_HEADER = ["-----BEGIN ", "RSA PRIVATE KEY-----"].join("");
const KEY_BLOCK = [KEY_HEADER, "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun"]
  .concat([
    "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
    "-----END RSA PRIVATE KEY-----",
  ])
  .join("\n");
const SLACK = ["xox", "b-", "1234567890-abcdefghij"].join("");
const STRIPE = ["sk_", "live_", "e".repeat(24)].join("");

describe("findSecretKinds", () => {
  it.each([
    [AWS, "AWS access key id"],
    [GH, "GitHub token"],
    [ANTHROPIC, "Anthropic API key"],
    [OPENAI, "OpenAI API key"],
    [KEY_BLOCK, "private key"],
    [SLACK, "Slack token"],
    [STRIPE, "Stripe key"],
  ])("flags %s", (value, kind) => {
    expect(findSecretKinds(`use this: ${value} ok`)).toContain(kind);
  });

  it("is narrow: the generic shapes the connector redactor removes never block a save", () => {
    // #2333 — one shared set; only its high-confidence members refuse.
    const bearer = ["Bearer ", "abcdefghijklmnopqrstuv"].join("");
    const url = ["postgres://app:", "s3cr3tPassw0rd", "@db/app"].join("");
    expect(findSecretKinds(`${bearer} ${url} ${"0123456789abcdef".repeat(3)}`)).toEqual([]);
  });

  it("does not refuse a key-block header with no key in it (#2333)", () => {
    expect(findSecretKinds(`Paste a key that starts with ${KEY_HEADER} here.`)).toEqual([]);
  });

  it("allows AWS's own documentation placeholder and ordinary prose", () => {
    expect(findSecretKinds("AKIAIOSFODNN7EXAMPLE is the doc key")).toEqual([]);
    expect(findSecretKinds("Use the sk-learn pipeline; ghp is a prefix.")).toEqual([]);
    expect(findSecretKinds("")).toEqual([]);
  });
});

describe("assertNoSecrets", () => {
  it("names the field and the kind, never the value", () => {
    let err: unknown;
    try {
      assertNoSecrets({ systemPrompt: `token ${GH}` });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DefinitionSecretError);
    expect((err as Error).message).toContain("systemPrompt");
    expect((err as Error).message).toContain("GitHub token");
    expect((err as Error).message).not.toContain(GH);
  });

  it("passes clean fields and ignores null/undefined", () => {
    expect(() => assertNoSecrets({ a: "fine", b: null, c: undefined })).not.toThrow();
  });
});

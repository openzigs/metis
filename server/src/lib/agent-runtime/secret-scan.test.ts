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
    // Keyword-anchored assignments and the AWS secret key are redacted, never refused.
    const assigned = ["DB_PASSWORD=", "s3cr3t-Pa55"].join("");
    const awsSecret = ["aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzzzzzKEYa"].join(
      "",
    );
    expect(findSecretKinds(`${assigned}\n${awsSecret}\n`)).toEqual([]);
  });

  it("does not refuse Stripe's documented sk_test_ key, but refuses its live and restricted keys", () => {
    // The shape Stripe's own API docs print, assembled at runtime.
    const docsKey = ["sk_", "test_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");
    expect(findSecretKinds(`curl -u ${docsKey}: https://api.stripe.com/v1/charges`)).toEqual([]);
    expect(findSecretKinds(["rk_", "test_", "f".repeat(24)].join(""))).toEqual(["Stripe key"]);
    expect(findSecretKinds(STRIPE)).toEqual(["Stripe key"]);
  });

  it("does not refuse Slack's documented webhook placeholder, but refuses a real webhook (#2333)", () => {
    // Assembled at runtime: the shape Slack's own docs print, and a real-shaped one.
    const hook = (path: string) => ["https://hooks.slack.com", "/services/", path].join("");
    const placeholder = hook(["T00000000", "B00000000", "X".repeat(24)].join("/"));
    expect(findSecretKinds(`curl -X POST ${placeholder}`)).toEqual([]);
    const real = hook(["T024BE7LD", "B01ABCDEF2G", "q8Lr2vWnZk4TbY7hM1sPx3Ce"].join("/"));
    expect(findSecretKinds(`curl -X POST ${real}`)).toEqual(["Slack webhook URL"]);
    // A real secret segment behind zeroed ids is still refused.
    const half = hook(["T00000000", "B00000000", "q8Lr2vWnZk4TbY7hM1sPx3Ce"].join("/"));
    expect(findSecretKinds(half)).toEqual(["Slack webhook URL"]);
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

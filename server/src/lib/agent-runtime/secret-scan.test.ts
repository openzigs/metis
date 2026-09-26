/** Epic #129 — no credentials in agent personas, skill bodies or supporting files. */
import { describe, expect, it } from "vitest";
import { assertNoSecrets, DefinitionSecretError, findSecretKinds } from "./secret-scan.js";

// Built at runtime so this file never carries a credential-shaped literal.
const AWS = ["AKIA", "Q3EGRTXXXXZ7Y2WB"].join("");
const GH = ["ghp_", "a".repeat(36)].join("");
const ANTHROPIC = ["sk-ant-", "api03-", "b".repeat(40)].join("");
const OPENAI = ["sk-proj-", "c".repeat(40)].join("");
const KEY_BLOCK = ["-----BEGIN ", "RSA PRIVATE KEY-----"].join("");

describe("findSecretKinds", () => {
  it.each([
    [AWS, "AWS access key id"],
    [GH, "GitHub token"],
    [ANTHROPIC, "Anthropic API key"],
    [OPENAI, "OpenAI API key"],
    [KEY_BLOCK, "private key"],
  ])("flags %s", (value, kind) => {
    expect(findSecretKinds(`use this: ${value} ok`)).toContain(kind);
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

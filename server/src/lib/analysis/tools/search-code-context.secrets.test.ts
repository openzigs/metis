/**
 * #2329 / #2333 — `search_code_context` returns no secret. Its spans are read
 * through `readCloneFileLines`, which redacts the whole file in place before any
 * caller slices it, so a span returns `[REDACTED:<class>]` markers at the same
 * line numbers, and its citation range is what it would have been unredacted.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: { codeSymbol: { findMany: async () => [] }, codeGraph: { findMany: async () => [] } },
}));

import { createSearchCodeContextTool } from "./search-code-context.js";
import { codeVersionIndexOf } from "../../code-graph/code-version.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const k = (...parts: string[]): string => parts.join("");
const TOKEN = k("sk-ant-", "api03-", "Qx7".repeat(14));
const FILE = [
  "package settings", // 1
  "", // 2
  "const pem = `" + k("-----BEGIN ", "OPENSSH PRIVATE KEY-----"), // 3
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", // 4
  "QyNTUxOQAAACDZ5L8m0zH2pYvU2pV7sQ8XU4z3Tn5cQ1k3Z2Xb6YvG3wAAAJgAAAAAAAAA", // 5
  k("-----END ", "OPENSSH PRIVATE KEY-----") + "`", // 6
  `const apiKey = "${TOKEN}"`, // 7
  "func Port() int { return 8080 }", // 8
].join("\n");

let clone: string;

beforeAll(async () => {
  clone = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-2329-secrets-")));
  await fs.writeFile(path.join(clone, "settings.go"), FILE);
});

afterAll(async () => {
  await fs.rm(clone, { recursive: true, force: true });
});

function tool(start: number, end: number) {
  return createSearchCodeContextTool({
    searcher: {
      search: async () => [
        { symbolId: "s1", filePath: "settings.go", name: "apiKey", kind: "variable", score: 1 },
      ],
    },
    lineLookup: {
      resolve: async () =>
        new Map([
          [
            "s1",
            { filePath: "settings.go", startLine: start, endLine: end, repoConnectionId: "r1" },
          ],
        ]),
    },
    loadVersions: async () =>
      codeVersionIndexOf([
        {
          repoConnectionId: "r1",
          commitSha: SHA,
          repo: { provider: "github", ownerOrOrg: "acme", repoName: "app", apiBaseUrl: null },
        },
      ]),
    resolveCloneDir: async () => clone,
    readHead: async () => SHA,
  });
}

/** The `N| …` lines a result printed. */
const printed = (text: string): string[] => text.split("\n").filter((l) => /^\d+\| /.test(l));

describe("#2333 — search_code_context redacts secrets", () => {
  it("returns a span with its secrets replaced and every line at its number", async () => {
    const r = await tool(3, 8).execute({ query: "api key" }, { projectId: "p1" });
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain(TOKEN);
    expect(r.content).not.toContain("b3BlbnNzaC1rZXkt");
    expect(printed(r.content)).toEqual([
      "3| const pem = `[REDACTED:private_key]",
      "4| [REDACTED:private_key]",
      "5| [REDACTED:private_key]",
      "6| [REDACTED:private_key]`",
      '7| const apiKey = "[REDACTED:anthropic_key]"',
      "8| func Port() int { return 8080 }",
    ]);
    // Redaction is line-stable: the citation is the symbol's own range.
    expect(r.citations).toHaveLength(1);
    expect(r.citations?.[0]).toMatchObject({ path: "settings.go", startLine: 3, endLine: 8 });
    expect(r.content).toContain("settings.go:3-8");
  });

  it("recognises a key block that starts above the span", async () => {
    const r = await tool(5, 7).execute({ query: "api key" }, { projectId: "p1" });
    expect(printed(r.content)).toEqual([
      "5| [REDACTED:private_key]",
      "6| [REDACTED:private_key]`",
      '7| const apiKey = "[REDACTED:anthropic_key]"',
    ]);
    expect(r.citations?.[0]).toMatchObject({ startLine: 5, endLine: 7 });
  });
});

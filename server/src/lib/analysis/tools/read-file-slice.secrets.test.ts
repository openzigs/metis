/**
 * #2333 — `read_file_slice` returns no secret: the whole file is redacted in
 * place before it is sliced, so the numbering and the header are what they
 * would have been, and a key block that starts above the requested range is
 * still recognised. Chat's tool wraps this one and inherits it.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChatReadFileSliceTool } from "./chat-read-file-slice.js";
import { readFileSliceTool } from "./read-file-slice.js";

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
  clone = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-2333-slice-")));
  await fs.writeFile(path.join(clone, "settings.go"), FILE);
});

afterAll(async () => {
  await fs.rm(clone, { recursive: true, force: true });
});

const read = (args: Record<string, unknown>) =>
  readFileSliceTool.execute(
    { filePath: "settings.go", ...args },
    { projectId: "p1", cloneDir: clone },
  );

describe("#2333 — read_file_slice redacts secrets", () => {
  it("returns the file with its secrets replaced and every line at its number", async () => {
    const out = await read({});
    expect(out.isError).toBeUndefined();
    expect(out.content).not.toContain(TOKEN);
    expect(out.content).not.toContain("b3BlbnNzaC1rZXkt");
    expect(out.content.split("\n")).toEqual([
      "settings.go (lines 1-8 of 8)",
      "1| package settings",
      "2| ",
      "3| const pem = `[REDACTED:private_key]",
      "4| [REDACTED:private_key]",
      "5| [REDACTED:private_key]",
      "6| [REDACTED:private_key]`",
      '7| const apiKey = "[REDACTED:anthropic_key]"',
      "8| func Port() int { return 8080 }",
    ]);
    expect(out.resultCount).toBe(8);
  });

  it("recognises a key block that starts above the requested range", async () => {
    const out = await read({ startLine: 5, endLine: 6 });
    expect(out.content).toBe(
      [
        "settings.go (lines 5-6 of 8)",
        "5| [REDACTED:private_key]",
        "6| [REDACTED:private_key]`",
      ].join("\n"),
    );
  });

  it("chat's read_file_slice inherits it", async () => {
    const tool = createChatReadFileSliceTool({
      listRepoIds: async () => ["r1"],
      resolveCloneDir: async () => clone,
    });
    const out = await tool.execute(
      { filePath: "settings.go", startLine: 7, endLine: 7 },
      {
        projectId: "p1",
      },
    );
    expect(out.content).toBe(
      ["settings.go (lines 7-7 of 8)", '7| const apiKey = "[REDACTED:anthropic_key]"'].join("\n"),
    );
  });
});

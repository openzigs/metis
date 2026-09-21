/**
 * Issue #773 — the tools' STRUCTURED OUTCOME contract (`isError` / `resultCount`).
 *
 * Retrieval health used to decide "did this call fail, or did it work and find
 * nothing?" by pattern-matching the tool's human-readable prose (`/^Error/i`,
 * `/^no\b/i`). #773 made that distinction LOAD-BEARING FOR VERDICTS: an error means
 * retrieval is broken (nothing can be confirmed), while a well-formed empty result is
 * the evidence a real gap is made of. A convention that copy-editing can break is not
 * good enough for that, so the tools now SAY which one it is. These tests pin the
 * contract at the tool boundary, where it is set.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFilesTool } from "./list-files.js";
import { readFileSliceTool } from "./read-file-slice.js";
import { createSearchKnowledgeTool } from "./search-knowledge.js";
import { createSearchSymbolsTool } from "./search-symbols.js";

let cloneDir: string;

beforeAll(async () => {
  cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), "metis-tools-773-"));
  await fs.mkdir(path.join(cloneDir, "src"), { recursive: true });
  await fs.writeFile(path.join(cloneDir, "src", "a.ts"), "const a = 1;\nconst b = 2;\n", "utf-8");
});

afterAll(async () => {
  await fs.rm(cloneDir, { recursive: true, force: true });
});

const ctx = () => ({ projectId: "p1", cloneDir });

describe("#773 — list_files marks errors and empties structurally", () => {
  it("flags a missing clone dir as an ERROR (retrieval is unavailable)", async () => {
    const res = await listFilesTool.execute({ pattern: "**/*.ts" }, { projectId: "p1" });
    expect(res.isError).toBe(true);
    expect(res.resultCount).toBeUndefined();
  });

  it("flags a working search that matched nothing as EMPTY, not as an error", async () => {
    const res = await listFilesTool.execute({ pattern: "**/*.rs" }, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.resultCount).toBe(0);
  });

  it("reports the result count on a hit", async () => {
    const res = await listFilesTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.resultCount).toBe(1);
  });
});

describe("#773 — read_file_slice marks errors structurally", () => {
  it("flags a missing file as an ERROR", async () => {
    const res = await readFileSliceTool.execute({ filePath: "src/nope.ts" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("flags a path-traversal attempt as an ERROR", async () => {
    const res = await readFileSliceTool.execute({ filePath: "../../etc/passwd" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("flags a missing clone dir as an ERROR", async () => {
    const res = await readFileSliceTool.execute({ filePath: "src/a.ts" }, { projectId: "p1" });
    expect(res.isError).toBe(true);
  });

  it("reports the line count it actually returned", async () => {
    const res = await readFileSliceTool.execute({ filePath: "src/a.ts" }, ctx());
    expect(res.isError).toBeUndefined();
    // 2 code lines + the trailing newline's empty line — the count is whatever the
    // slice actually handed back, which is exactly what "did this call retrieve
    // anything?" needs.
    expect(res.resultCount).toBe(3);
  });
});

describe("#773 — the search tools mark empties structurally", () => {
  it("search_knowledge: no hits ⇒ resultCount 0, never an error", async () => {
    const tool = createSearchKnowledgeTool({
      knowledgeService: { search: async () => ({ hits: [] }) } as never,
    });
    const res = await tool.execute({ query: "rate limiting" }, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.resultCount).toBe(0);
  });

  it("search_knowledge: hits ⇒ the hit count", async () => {
    const tool = createSearchKnowledgeTool({
      knowledgeService: {
        search: async () => ({
          hits: [{ filename: "spec.md", position: 0, score: 0.5, text: "t" }],
        }),
      } as never,
    });
    const res = await tool.execute({ query: "auth" }, ctx());
    expect(res.resultCount).toBe(1);
  });

  it("search_knowledge: a bad call is an ERROR, not an empty result", async () => {
    const tool = createSearchKnowledgeTool({
      knowledgeService: { search: async () => ({ hits: [] }) } as never,
    });
    const res = await tool.execute({ q: "auth" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.resultCount).toBeUndefined();
  });

  it("search_code_symbols: empty index ⇒ resultCount 0; a bad call ⇒ isError", async () => {
    const tool = createSearchSymbolsTool({
      searcher: { search: async () => [] },
      lineLookup: { resolve: async () => new Map() },
    });
    const empty = await tool.execute({ query: "rate limiting" }, ctx());
    expect(empty.isError).toBeUndefined();
    expect(empty.resultCount).toBe(0);

    const bad = await tool.execute({ qeury: "rate limiting" }, ctx());
    expect(bad.isError).toBe(true);
  });
});

/**
 * #2346 — `get_file_outline`'s parent reading and its offering in chat. The
 * tool's reads are proven against a real database in
 * `tests/index-housekeeping-2346.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../../prisma.js", () => ({
  prisma: { codeSymbol: { findMany: async () => db.rows } },
}));

import { getChatCodeTools } from "./index.js";
import { CHAT_CODE_TOOL_NAMES } from "./chat-code-tool-names.js";
import {
  FILE_OUTLINE_TOOL_NAME,
  MAX_OUTLINE_SYMBOLS,
  createFileOutlineTool,
  parentOf,
} from "./file-outline.js";
import type { ToolContext } from "./types.js";
import { NO_CODE_VERSIONS } from "../../code-graph/code-version.js";

describe("parentOf (#2346)", () => {
  it("reads the parent and depth off the qualified name", () => {
    expect(parentOf("src/a.ts::f", "src/a.ts")).toEqual({ parent: null, depth: 0 });
    expect(parentOf("src/a.ts::C::m", "src/a.ts")).toEqual({ parent: "C", depth: 1 });
    expect(parentOf("src/a.ts::Outer::Inner::m", "src/a.ts")).toEqual({
      parent: "Inner",
      depth: 2,
    });
  });

  it("puts a name that does not start with the file's path at the top", () => {
    expect(parentOf("billing.invoices.total", "db/schema.sql")).toEqual({
      parent: null,
      depth: 0,
    });
  });
});

describe("get_file_outline in chat (#2346)", () => {
  it("is nameable by an agent allowlist, and offered only when turned on", () => {
    expect(CHAT_CODE_TOOL_NAMES).toContain(FILE_OUTLINE_TOOL_NAME);
    expect(getChatCodeTools().map((t) => t.name)).not.toContain(FILE_OUTLINE_TOOL_NAME);
    expect(getChatCodeTools({ fileOutline: true }).map((t) => t.name)).toContain(
      FILE_OUTLINE_TOOL_NAME,
    );
  });

  it("takes only a path", () => {
    const tool = getChatCodeTools({ fileOutline: true }).find(
      (t) => t.name === FILE_OUTLINE_TOOL_NAME,
    )!;
    expect(tool.parameters.required).toEqual(["path"]);
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["path"]);
  });
});

describe("get_file_outline's cap across repositories (#2346 review)", () => {
  const sym = (repo: string, line: number) => ({
    name: `f${line}`,
    kind: "function",
    qualifiedName: `src/a.ts::f${line}`,
    startLine: line,
    endLine: line,
    language: "typescript",
    graph: { repoConnectionId: repo, repoConnection: { label: repo } },
  });

  it("says the second repository's symbols are not listed because the cap was reached", async () => {
    db.rows = [
      ...Array.from({ length: MAX_OUTLINE_SYMBOLS }, (_, i) => sym("first", i + 1)),
      sym("second", 7),
      sym("second", 9),
    ];
    const tool = createFileOutlineTool({ loadVersions: async () => NO_CODE_VERSIONS });
    const r = await tool.execute({ path: "src/a.ts" }, { projectId: "p1" } as ToolContext);
    const second = r.content.split("\n\n").find((b) => b.includes('"second"'))!;
    expect(second).toBeDefined();
    expect(second).not.toContain("the first 0");
    expect(second).toContain(
      `2 symbol(s), not listed: the outline's cap of ${MAX_OUTLINE_SYMBOLS} symbols was reached; they start at line 7.`,
    );
    expect(second.split("\n")).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});

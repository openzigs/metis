/**
 * #2346 — `get_file_outline`'s parent reading and its offering in chat. The
 * tool's reads are proven against a real database in
 * `tests/index-housekeeping-2346.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { getChatCodeTools } from "./index.js";
import { CHAT_CODE_TOOL_NAMES } from "./chat-code-tool-names.js";
import { FILE_OUTLINE_TOOL_NAME, parentOf } from "./file-outline.js";

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

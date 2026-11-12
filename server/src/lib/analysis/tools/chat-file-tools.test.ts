/**
 * #2327 — chat's `grep_files` and `list_files`: every clone of the session's
 * project, the caller's document ACLs, and the caps over all of them.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../../prisma.js", () => ({ prisma: { repoConnection: { findMany } } }));

import { createChatGrepFilesTool, createChatListFilesTool } from "./chat-file-tools.js";
import { codeAccessFilterOf, UNRESTRICTED_CODE_ACCESS } from "./code-access.js";
import { getChatCodeTools } from "./index.js";

let root: string;
const clones: Record<string, string> = {};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "chat-file-tools-"));
  for (const id of ["rc-a", "rc-b"]) {
    clones[id] = path.join(root, id);
    await mkdir(path.join(clones[id]!, "src"), { recursive: true });
  }
  await writeFile(path.join(clones["rc-a"]!, "src", "fee.ts"), "export const RATE = 1;\n");
  await writeFile(path.join(clones["rc-a"]!, "src", "secret.ts"), "export const RATE = 42;\n");
  await symlink("secret.ts", path.join(clones["rc-a"]!, "src", "alias.ts"));
  // The same path in the other repository is a different, unrestricted file.
  await writeFile(path.join(clones["rc-b"]!, "src", "secret.ts"), "export const RATE = 7;\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const deps = {
  listRepoIds: async () => ["rc-a", "rc-b", "rc-gone"],
  resolveCloneDir: async (id: string) => clones[id],
};
const grep = createChatGrepFilesTool(deps);
const list = createChatListFilesTool(deps);
/** `src/secret.ts` is hidden from this caller in repository rc-a only. */
const restricted = codeAccessFilterOf([{ connectorId: "rc-a", path: "src/secret.ts" }]);

describe("chat grep_files (#2327)", () => {
  it("searches every clone of the project, primary first", async () => {
    const r = await grep.execute({ text: "RATE" }, { projectId: "p" });
    expect(r.content.split("\n")).toEqual([
      "src/alias.ts:1: export const RATE = 42;",
      "src/fee.ts:1: export const RATE = 1;",
      "src/secret.ts:1: export const RATE = 42;",
      "src/secret.ts:1: export const RATE = 7;",
    ]);
    expect(r.resultCount).toBe(4);
  });

  it("neither shows nor counts a hidden file, under its name or through a symlink to it", async () => {
    const r = await grep.execute({ text: "RATE" }, { projectId: "p", codeAccess: restricted });
    expect(r.content.split("\n")).toEqual([
      "src/fee.ts:1: export const RATE = 1;",
      "src/secret.ts:1: export const RATE = 7;",
    ]);
    expect(r.content).not.toContain("42");
    const only = await grep.execute({ text: "= 42" }, { projectId: "p", codeAccess: restricted });
    expect(only).toEqual({ content: "No lines contain: = 42", resultCount: 0 });
  });

  it("refuses bad arguments before reading anything, and needs a project and a clone", async () => {
    expect((await grep.execute({ text: "x" }, { projectId: "p" })).content).toMatch(
      /grep_files requires "text"/,
    );
    expect(
      (await grep.execute({ text: "RATE", pathContains: "../" }, { projectId: "p" })).content,
    ).toMatch(/refused "pathContains"/);
    expect(await grep.execute({ text: "RATE" }, { projectId: "" })).toEqual({
      content: "Error: searching files needs a project-scoped session.",
      isError: true,
    });
    const none = createChatGrepFilesTool({
      listRepoIds: async () => ["rc-gone"],
      resolveCloneDir: async () => undefined,
    });
    expect((await none.execute({ text: "RATE" }, { projectId: "p" })).content).toMatch(
      /No repository working tree/,
    );
  });
});

describe("chat list_files (#2327)", () => {
  it("lists every clone's files and hides the caller's restricted ones", async () => {
    const all = await list.execute(
      { pattern: "src/*.ts" },
      { projectId: "p", codeAccess: UNRESTRICTED_CODE_ACCESS },
    );
    expect(all.content.split("\n")).toEqual(["src/fee.ts", "src/secret.ts", "src/secret.ts"]);
    const r = await list.execute(
      { pattern: "src/*.ts" },
      { projectId: "p", codeAccess: restricted },
    );
    // rc-a's secret.ts is hidden; rc-b's file of the same name is not.
    expect(r.content.split("\n")).toEqual(["src/fee.ts", "src/secret.ts"]);
    expect(r.resultCount).toBe(2);
  });

  it("refuses a pattern that leaves the repository, and needs a project and a clone", async () => {
    expect((await list.execute({ pattern: "../*" }, { projectId: "p" })).isError).toBe(true);
    expect((await list.execute({ pattern: "*" }, { projectId: "" })).isError).toBe(true);
    const none = createChatListFilesTool({
      listRepoIds: async () => [],
      resolveCloneDir: async () => undefined,
    });
    expect((await none.execute({ pattern: "*" }, { projectId: "p" })).content).toMatch(
      /No repository working tree/,
    );
  });

  it("reads the project's live repo connections, scoped on the project", async () => {
    findMany.mockResolvedValueOnce([]);
    const r = await createChatListFilesTool().execute({ pattern: "*" }, { projectId: "p-9" });
    expect(r.isError).toBe(true);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p-9", deletedAt: null } }),
    );
  });
});

describe("getChatCodeTools (#2327)", () => {
  it("offers grep_files, list_files and the symbol filters only with the primitives on", () => {
    const off = getChatCodeTools();
    expect(off.map((t) => t.name)).toEqual([
      "search_code_graph",
      "search_code_symbols",
      "read_file_slice",
    ]);
    expect(off[1]!.parameters.properties).not.toHaveProperty("fileGlob");
    const on = getChatCodeTools(undefined, { primitives: true });
    expect(on.map((t) => t.name)).toEqual([
      "search_code_graph",
      "search_code_symbols",
      "read_file_slice",
      "grep_files",
      "list_files",
    ]);
    expect(on[1]!.parameters.properties).toHaveProperty("fileGlob");
  });
});

/**
 * Issue #777 — the clone-existence gate, at the module boundary.
 *
 * Against a REAL filesystem (temp dirs, no `fs` mock): the bug was that the code
 * trusted a path STRING it never checked, so a test that mocks `fs` would be testing
 * the same assumption that broke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRepoClonePath } from "../connectors/repo/clone-path.js";
import { cloneDirPath, resolveExistingCloneDir } from "./clone-availability.js";
import { assembleAgenticCodeTools, REPO_FILE_TOOLS } from "./orchestrator.js";
import type { KnowledgeService } from "../rag/knowledge-service.js";

const knowledgeStub = { search: vi.fn(async () => []) } as unknown as KnowledgeService;
const toolNames = (cloneDir?: string): string[] =>
  assembleAgenticCodeTools({ knowledgeService: knowledgeStub, cloneDir }).map((t) => t.name);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "metis-clone-"));
  process.env.REPO_CLONE_DIR = root;
});

afterEach(async () => {
  delete process.env.REPO_CLONE_DIR;
  await rm(root, { recursive: true, force: true });
});

describe("cloneDirPath", () => {
  it("joins the configured root with the connector id", () => {
    expect(cloneDirPath("conn_1")).toBe(path.join(root, "conn_1"));
  });

  it("falls back to the ingest pipeline's REAL default root (#777)", () => {
    delete process.env.REPO_CLONE_DIR;
    // The default root is the one ingest actually writes to — tmpdir-anchored,
    // NOT the `./data/repos` this module used to assume. See clone-path-parity.test.ts.
    expect(cloneDirPath("conn_1")).toBe(resolveRepoClonePath("conn_1"));
    expect(cloneDirPath("conn_1")).not.toContain("data/repos");
  });
});

describe("resolveExistingCloneDir", () => {
  it("returns the path when the clone directory exists", async () => {
    await mkdir(path.join(root, "conn_1"), { recursive: true });

    await expect(resolveExistingCloneDir("conn_1")).resolves.toBe(path.join(root, "conn_1"));
  });

  it("returns undefined when the directory does not exist (THE BUG: this used to be a truthy string)", async () => {
    await expect(resolveExistingCloneDir("conn_missing")).resolves.toBeUndefined();
  });

  it("returns undefined when there is no connector at all", async () => {
    await expect(resolveExistingCloneDir(undefined)).resolves.toBeUndefined();
  });

  it("returns undefined when the path is a FILE, not a directory", async () => {
    await writeFile(path.join(root, "conn_file"), "not a clone", "utf8");

    await expect(resolveExistingCloneDir("conn_file")).resolves.toBeUndefined();
  });

  it("returns undefined when the directory cannot be read or traversed", async () => {
    const dir = path.join(root, "conn_locked");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o000);

    try {
      // An unreadable clone is, for the agent, exactly as useless as an absent one:
      // `list_files` cannot walk it and `read_file_slice` cannot open anything in it.
      await expect(resolveExistingCloneDir("conn_locked")).resolves.toBeUndefined();
    } finally {
      await chmod(dir, 0o700); // so afterEach can remove it
    }
  });

  it("returns undefined when the clone ROOT itself is missing (ephemeral/reaped disk)", async () => {
    process.env.REPO_CLONE_DIR = path.join(root, "does", "not", "exist");

    await expect(resolveExistingCloneDir("conn_1")).resolves.toBeUndefined();
  });
});

describe("assembleAgenticCodeTools — the file tools follow the clone", () => {
  it("withholds the file tools when there is no working tree", () => {
    const names = toolNames(undefined);

    expect(names).not.toContain("read_file_slice");
    expect(names).not.toContain("list_files");
    // The agent is NOT left toolless: graph + symbol search need no clone and work.
    expect(names).toEqual(
      expect.arrayContaining(["search_code_graph", "search_code_symbols", "search_knowledge"]),
    );
  });

  it("offers the file tools when a verified clone dir is passed", () => {
    const names = toolNames("/verified/clone");

    expect(names).toEqual(expect.arrayContaining(["read_file_slice", "list_files"]));
  });

  it("REPO_FILE_TOOLS names exactly the tools the clone gates", () => {
    const withClone = new Set(toolNames("/verified/clone"));
    const withoutClone = new Set(toolNames(undefined));
    const gated = [...withClone].filter((n) => !withoutClone.has(n));

    // Derived from the tool definitions themselves, so the withheld-tool set handed to
    // `summarizeRetrievalEvidence` can never drift from what is actually gated.
    expect(new Set(gated)).toEqual(new Set(REPO_FILE_TOOLS));
  });
});

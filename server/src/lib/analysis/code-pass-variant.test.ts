/**
 * #2565 — the explore-first code pass's pieces: the mode decision, A20's tool
 * set at production's read caps (lines and characters), the OWASP rules every
 * explore tool keeps at the larger cap, the transcript ceiling tied to the
 * model's window, the explorer nudge's composition with #1388's continuation,
 * and the per-pass outcome telemetry.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import { recordCodePassMode } from "./analysis-capability.js";
import { passCodeAccess, type PassReads } from "./pass-reads.js";
import type { AgentLoopContinuationState, AgentLoopOptions } from "./agent-loop.js";
import { buildAgenticPassPrompt } from "./agentic-pass-context.js";
import {
  buildExploreCodePass,
  codePassOutcome,
  composeExplorerContinuation,
  countRepeatedToolCalls,
  DEFAULT_EXPLORE_TRANSCRIPT_TOKENS,
  EXPLORE_READ_MAX_CHARS,
  EXPLORER_NUDGE,
  EXPLORER_STEPS,
  explorerSystemMessage,
  explorerTools,
  readCodeExplorationSetting,
  resolveCodePassMode,
  resolveExploreTranscriptTokens,
} from "./code-pass-variant.js";
import { DEFAULT_CODE_PASS_MODE } from "./code-exploration-setting.js";
import { DEFAULT_TRANSCRIPT_COMPACTION } from "./context-window-manager.js";
import { FILE_NOT_FOUND } from "./tools/read-file-slice.js";
import { normalizeRepoPath, type CodeAccessFilter } from "./tools/code-access.js";
import type { AgentTool, ToolContext } from "./tools/types.js";

const searchCodeGraph = { name: "search_code_graph" } as AgentTool;
const searchCodeSymbols = { name: "search_code_symbols" } as AgentTool;
const tool = (name: string): AgentTool =>
  explorerTools({ searchCodeGraph, searchCodeSymbols }).find((t) => t.name === name)!;

const k = (...parts: string[]): string => parts.join("");
const TOKEN = k("sk-ant-", "api03-", "Qx7".repeat(14));

let clone: string;
beforeAll(async () => {
  clone = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-2565-")));
  await fs.mkdir(path.join(clone, "src"), { recursive: true });
  const numbered = (n: number, width = 0) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`.padEnd(width, "x")).join("\n");
  await fs.writeFile(path.join(clone, "src", "long.ts"), numbered(1500));
  await fs.writeFile(path.join(clone, "src", "wide.ts"), numbered(1000, 500));
  // One minified line longer than the size cap, alone and followed by another line.
  await fs.writeFile(path.join(clone, "src", "bundle.min.js"), "x".repeat(100_000));
  await fs.writeFile(path.join(clone, "src", "bundle2.min.js"), `${"y".repeat(100_000)}\nend`);
  // A secret near the end of a 1000-line read: redacted at the larger cap too.
  const withSecret = numbered(950).split("\n");
  withSecret[899] = `const apiKey = "${TOKEN}"`;
  await fs.writeFile(path.join(clone, "src", "settings.ts"), withSecret.join("\n"));
  await fs.writeFile(
    path.join(clone, "src", "secret.ts"),
    "export const RATE = 0.42; // feeRate\n",
  );
  await fs.writeFile(path.join(clone, "src", "public.ts"), "export const feeRate = 1;\n");
  await fs.symlink("secret.ts", path.join(clone, "src", "alias.ts"));
});
afterAll(async () => {
  await fs.rm(clone, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.ANALYSIS_CODE_EXPLORATION;
  delete process.env.ANALYSIS_EXPLORE_READ_MAX_LINES;
  delete process.env.ANALYSIS_EXPLORE_TRANSCRIPT_TOKENS;
  delete process.env.AI_MODEL_CATALOG_OVERRIDES;
  __resetConfigSingleton();
});

const ctx = (codeAccess?: CodeAccessFilter): ToolContext => ({
  projectId: "p1",
  connectorId: "rc1",
  cloneDir: clone,
  ...(codeAccess ? { codeAccess } : {}),
});

/** A caller from whom `src/secret.ts` is hidden. */
const HIDING_SECRET: CodeAccessFilter = {
  unrestricted: false,
  hiddenPaths: () => ["src/secret.ts"],
  isHidden: (_repo, filePath) => normalizeRepoPath(filePath) === "src/secret.ts",
  hiddenFileCount: 1,
};

describe("the mode decision", () => {
  it("reads the platform key, and an unset or unknown value is explore (#2587)", () => {
    expect(DEFAULT_CODE_PASS_MODE).toBe("explore");
    expect(readCodeExplorationSetting()).toBe("explore");
    process.env.ANALYSIS_CODE_EXPLORATION = "fast";
    __resetConfigSingleton();
    expect(readCodeExplorationSetting()).toBe("fast");
    process.env.ANALYSIS_CODE_EXPLORATION = " FAST ";
    __resetConfigSingleton();
    expect(readCodeExplorationSetting()).toBe("fast");
    process.env.ANALYSIS_CODE_EXPLORATION = "deep";
    __resetConfigSingleton();
    expect(readCodeExplorationSetting()).toBe("explore");
  });

  it("follows the platform with a working tree, and is fast without one", () => {
    expect(resolveCodePassMode({ platformDefault: "explore", fileToolsAvailable: true })).toEqual({
      mode: "explore",
      reason: "platform-default",
    });
    expect(resolveCodePassMode({ platformDefault: "fast", fileToolsAvailable: true })).toEqual({
      mode: "fast",
      reason: "platform-default",
    });
    expect(resolveCodePassMode({ platformDefault: "explore", fileToolsAvailable: false })).toEqual({
      mode: "fast",
      reason: "no-working-tree",
    });
  });

  it("#2566 — takes the project's setting first, but no working tree still wins", () => {
    const mode = (platformDefault: "explore" | "fast", projectSetting: string, files = true) =>
      resolveCodePassMode({ platformDefault, projectSetting, fileToolsAvailable: files });
    expect(mode("fast", "explore")).toEqual({ mode: "explore", reason: "project-explore" });
    expect(mode("explore", "fast")).toEqual({ mode: "fast", reason: "project-fast" });
    expect(mode("explore", "auto")).toEqual({ mode: "explore", reason: "platform-default" });
    expect(mode("fast", "explore", false)).toEqual({ mode: "fast", reason: "no-working-tree" });
  });
});

describe("the explore pass's prompt and tools", () => {
  const prompt = buildAgenticPassPrompt({
    projectName: "p",
    projectDescription: "d",
    requirements: [{ id: "REQ-1", text: "t" }],
    seeds: {
      fused: { block: "", tokens: 0 },
      affectedCode: { block: "", tokens: 0 },
      affectedSchema: { block: "", tokens: 0 },
    },
    fileToolsAvailable: true,
  });

  it("swaps production's steps for the explore-first steps, and refuses a changed prompt", () => {
    const explored = explorerSystemMessage(prompt.systemMessage);
    expect(explored).toContain(EXPLORER_STEPS);
    expect(explored).not.toContain("search_knowledge");
    expect(() => explorerSystemMessage("something else")).toThrow(/investigation steps changed/);
  });

  it("is exactly A20's five tools, in order", () => {
    const pass = buildExploreCodePass({
      search: { searchCodeGraph, searchCodeSymbols },
      providerKey: "offline-stub",
      model: "stub",
    });
    expect(pass.tools.map((t) => t.name)).toEqual([
      "grep_files",
      "list_files",
      "read_file_slice",
      "search_code_graph",
      "search_code_symbols",
    ]);
    expect(pass.readMaxLines).toBe(1000);
    expect(pass.systemMessage(prompt.systemMessage)).toContain(EXPLORER_STEPS);
  });

  it("takes the read cap from ANALYSIS_EXPLORE_READ_MAX_LINES, in the tool and the steps", async () => {
    process.env.ANALYSIS_EXPLORE_READ_MAX_LINES = "300";
    __resetConfigSingleton();
    const pass = buildExploreCodePass({
      search: { searchCodeGraph, searchCodeSymbols },
      providerKey: "offline-stub",
      model: "stub",
    });
    expect(pass.systemMessage(prompt.systemMessage)).toContain("up to 300 lines a call");
    const read = pass.tools.find((t) => t.name === "read_file_slice")!;
    const out = await read.execute({ filePath: "src/long.ts" }, ctx());
    expect(out.resultCount).toBe(300);
  });

  it("falls back to the default read cap on a zero, negative or non-numeric env value", async () => {
    for (const bad of ["0", "-1", "abc"]) {
      process.env.ANALYSIS_EXPLORE_READ_MAX_LINES = bad;
      __resetConfigSingleton();
      const pass = buildExploreCodePass({
        search: { searchCodeGraph, searchCodeSymbols },
        providerKey: "offline-stub",
        model: "stub",
      });
      expect(pass.readMaxLines).toBe(1000);
      const read = pass.tools.find((t) => t.name === "read_file_slice")!;
      const out = await read.execute({ filePath: "src/long.ts" }, ctx());
      expect(out.resultCount).toBe(1000);
    }
  });
});

describe("recordCodePassMode across a multi-repository run", () => {
  it("is explore only while every pass explored; a fast pass wins, in either order", () => {
    const exploreThenFast: Parameters<typeof recordCodePassMode>[0] = {};
    recordCodePassMode(exploreThenFast, { mode: "explore", reason: "platform-default" });
    recordCodePassMode(exploreThenFast, { mode: "fast", reason: "no-working-tree" });
    expect(exploreThenFast.codePassMode).toEqual({ mode: "fast", reason: "no-working-tree" });

    const fastThenExplore: Parameters<typeof recordCodePassMode>[0] = {};
    recordCodePassMode(fastThenExplore, { mode: "fast", reason: "no-working-tree" });
    recordCodePassMode(fastThenExplore, { mode: "explore", reason: "platform-default" });
    expect(fastThenExplore.codePassMode).toEqual({ mode: "fast", reason: "no-working-tree" });

    const allExplore: Parameters<typeof recordCodePassMode>[0] = {};
    recordCodePassMode(allExplore, { mode: "explore", reason: "platform-default" });
    recordCodePassMode(allExplore, { mode: "explore", reason: "platform-default" });
    expect(allExplore.codePassMode).toEqual({ mode: "explore", reason: "platform-default" });
  });
});

describe("read_file_slice at the explore caps", () => {
  it("returns 1000 lines of a 1,500-line file when called with no endLine", async () => {
    const out = await tool("read_file_slice").execute({ filePath: "src/long.ts" }, ctx());
    expect(out.isError).toBeUndefined();
    expect(out.resultCount).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("src/long.ts (lines 1-1000 of 1500)");
    expect(out.content).toContain("request lines 1001-1500 next");
  });

  it("cuts 1000 lines of 500 characters at the size cap, truncated, naming the next range", async () => {
    const out = await tool("read_file_slice").execute({ filePath: "src/wide.ts" }, ctx());
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThan(EXPLORE_READ_MAX_CHARS + 200);
    const kept = out.resultCount!;
    expect(kept).toBeGreaterThan(100);
    expect(kept).toBeLessThan(1000);
    expect(out.content).toContain(`(lines 1-${kept} of 1000)`);
    expect(out.content).toContain(
      `[Cut at ${EXPLORE_READ_MAX_CHARS} characters per call: request lines ${kept + 1}-`,
    );
    expect(out.citations?.[0]).toMatchObject({ endLine: kept, truncated: true });
  });

  it("marks a one-line file longer than the size cap truncated, and says the line was cut", async () => {
    const out = await tool("read_file_slice").execute({ filePath: "src/bundle.min.js" }, ctx());
    expect(out.isError).toBeUndefined();
    expect(out.truncated).toBe(true);
    expect(out.content).toContain(
      `[Line 1 cut at ${EXPLORE_READ_MAX_CHARS} of its 100000 characters;`,
    );
    expect(out.content).not.toContain("request lines");
    expect(out.citations?.[0]).toMatchObject({ startLine: 1, endLine: 1, truncated: true });
    expect(out.citations?.[0]).not.toHaveProperty("next");
  });

  it("says a cut first line was cut, and names the next line, when more follow", async () => {
    const out = await tool("read_file_slice").execute({ filePath: "src/bundle2.min.js" }, ctx());
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("[Line 1 cut at");
    expect(out.content).toContain("request lines 2-2 next");
  });

  it("reads a line within the size cap whole, with no cut note", async () => {
    const out = await tool("read_file_slice").execute({ filePath: "src/long.ts" }, ctx());
    expect(out.content).not.toMatch(/\[Line \d+ cut at/);
  });

  it("cuts an explicit range at the size cap too", async () => {
    const out = await tool("read_file_slice").execute(
      { filePath: "src/wide.ts", startLine: 1, endLine: 1000 },
      ctx(),
    );
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("characters per call");
  });

  it("still redacts a secret at line 900 of a whole-file read", async () => {
    const out = await tool("read_file_slice").execute({ filePath: "src/settings.ts" }, ctx());
    expect(out.resultCount).toBe(950);
    expect(out.content).not.toContain(TOKEN);
    expect(out.content).toMatch(/^900\| const apiKey = /m);
  });

  it("refuses a hidden file, under its name and through a link, as a missing file", async () => {
    for (const filePath of ["src/secret.ts", "src/alias.ts"]) {
      const out = await tool("read_file_slice").execute({ filePath }, ctx(HIDING_SECRET));
      expect(out).toEqual({ content: `${FILE_NOT_FOUND} ${filePath}`, isError: true });
    }
    const open = await tool("read_file_slice").execute({ filePath: "src/secret.ts" }, ctx());
    expect(open.content).toContain("RATE"); // positive control: visible without the filter
  });
});

describe("grep_files and list_files keep a hidden file out (#2314 / #2448)", () => {
  it("grep_files neither matches nor counts a hidden file, nor its link", async () => {
    const hidden = await tool("grep_files").execute({ text: "feeRate" }, ctx(HIDING_SECRET));
    expect(hidden.content).toContain("src/public.ts");
    expect(hidden.content).not.toContain("src/secret.ts");
    expect(hidden.content).not.toContain("src/alias.ts");
    const open = await tool("grep_files").execute({ text: "feeRate" }, ctx());
    expect(open.content).toContain("src/secret.ts"); // positive control
  });

  it("grep_files in a starter pass records only the files that matched as read", async () => {
    const pass: PassReads = {
      analysisId: "a1",
      projectId: "p1",
      actor: {} as PassReads["actor"],
      readable: new Set(["d-public", "d-long", "d-wide"]),
      readableFiles: new Map([
        [
          "rc1",
          new Map([
            ["src/public.ts", ["d-public"]],
            ["src/long.ts", ["d-long"]],
            ["src/wide.ts", ["d-wide"]],
          ]),
        ],
      ]),
      hiddenFiles: [{ connectorId: "rc1", path: "src/secret.ts" }],
      upstream: null,
      own: new Set(),
    };
    const out = await tool("grep_files").execute({ text: "feeRate" }, ctx(passCodeAccess(pass)));
    expect(out.content).toContain("src/public.ts");
    expect(out.content).not.toContain("src/secret.ts");
    // long.ts and wide.ts were walked and searched, but nothing in them matched.
    expect([...pass.own]).toEqual(["d-public"]);
  });

  it("list_files does not list a hidden file", async () => {
    const hidden = await tool("list_files").execute({ pattern: "src/*.ts" }, ctx(HIDING_SECRET));
    expect(hidden.content).toContain("src/public.ts");
    expect(hidden.content).not.toMatch(/^src\/secret\.ts$/m);
    const open = await tool("list_files").execute({ pattern: "src/*.ts" }, ctx());
    expect(open.content).toMatch(/^src\/secret\.ts$/m); // positive control
  });
});

describe("the explore transcript ceiling (#1384)", () => {
  it("is 64k on a large-window model", () => {
    process.env.AI_MODEL_CATALOG_OVERRIDES = JSON.stringify({
      "offline-stub:big": { contextWindow: 1_000_000 },
    });
    expect(resolveExploreTranscriptTokens("offline-stub", "big")).toBe(
      DEFAULT_EXPLORE_TRANSCRIPT_TOKENS,
    );
  });

  it("is half the window on a small-window model", () => {
    process.env.AI_MODEL_CATALOG_OVERRIDES = JSON.stringify({
      "offline-stub:small": { contextWindow: 8_192 },
    });
    expect(resolveExploreTranscriptTokens("offline-stub", "small")).toBe(4_096);
    const pass = buildExploreCodePass({
      search: { searchCodeGraph, searchCodeSymbols },
      providerKey: "offline-stub",
      model: "small",
    });
    expect(pass.transcriptCompaction).toEqual({
      ...DEFAULT_TRANSCRIPT_COMPACTION,
      maxTranscriptTokens: 4_096,
    });
  });

  it("falls back to the default on a zero, negative or non-numeric env value", () => {
    process.env.AI_MODEL_CATALOG_OVERRIDES = JSON.stringify({
      "offline-stub:big": { contextWindow: 1_000_000 },
    });
    for (const bad of ["0", "-5", "abc"]) {
      process.env.ANALYSIS_EXPLORE_TRANSCRIPT_TOKENS = bad;
      __resetConfigSingleton();
      expect(resolveExploreTranscriptTokens("offline-stub", "big")).toBe(
        DEFAULT_EXPLORE_TRANSCRIPT_TOKENS,
      );
    }
  });

  it("is the configured ceiling when that is lower", () => {
    process.env.ANALYSIS_EXPLORE_TRANSCRIPT_TOKENS = "20000";
    __resetConfigSingleton();
    process.env.AI_MODEL_CATALOG_OVERRIDES = JSON.stringify({
      "offline-stub:big": { contextWindow: 1_000_000 },
    });
    expect(resolveExploreTranscriptTokens("offline-stub", "big")).toBe(20_000);
  });
});

describe("composeExplorerContinuation", () => {
  const state: AgentLoopContinuationState = { turnsUsed: 1, turnsLeft: 5, nudgesSent: 0 };
  const base = (answers: Array<string | null>) => {
    const seen: number[] = [];
    let i = 0;
    const continuation: NonNullable<AgentLoopOptions["continuation"]> = {
      maxNudges: 2,
      nudge: (_reply, s) => {
        seen.push(s.nudgesSent);
        return answers[i++] ?? null;
      },
    };
    return { continuation, seen };
  };

  it("sends the explorer nudge once, before any tool call, then defers to the base", () => {
    const { continuation, seen } = base(["coverage-1", "coverage-2", "coverage-3"]);
    const composed = composeExplorerContinuation(continuation, () => 0);
    expect(composed.maxNudges).toBe(3);
    expect(composed.nudge("{}", state)).toBe(EXPLORER_NUDGE);
    // A second tool-less answer is never nudged to explore again.
    expect(composed.nudge("{}", state)).toBe("coverage-1");
    expect(composed.nudge("{}", state)).toBe("coverage-2");
    // The base keeps its own cap: at most 3 nudges in all.
    expect(composed.nudge("{}", state)).toBeNull();
    expect(seen).toEqual([0, 1]);
  });

  it("never sends the explorer nudge once a tool was called", () => {
    const { continuation } = base([null]);
    const composed = composeExplorerContinuation(continuation, () => 1);
    expect(composed.nudge("{}", state)).toBeNull();
  });

  it("counts only the base's accepted instructions against its cap", () => {
    const { continuation } = base([null, "coverage", "again", "third"]);
    const composed = composeExplorerContinuation(continuation, () => 2);
    expect(composed.nudge("{}", state)).toBeNull();
    expect(composed.nudge("{}", state)).toBe("coverage");
    expect(composed.nudge("{}", state)).toBe("again");
    expect(composed.nudge("{}", state)).toBeNull();
  });
});

describe("the pass outcome", () => {
  it("counts repeated (tool, arguments) pairs, whatever the key order", () => {
    expect(
      countRepeatedToolCalls([
        { tool: "grep_files", args: { text: "fee", pathContains: "src" } },
        { tool: "grep_files", args: { pathContains: "src", text: "fee" } },
        { tool: "grep_files", args: { text: "fee" } },
        { tool: "read_file_slice", args: { filePath: "a.ts" } },
        { tool: "read_file_slice", args: { filePath: "a.ts" } },
        { tool: "list_files", args: [1, { b: null }] },
        { tool: "list_files", args: undefined },
      ]),
    ).toBe(2);
  });

  it("records spend against the budget, and the degradation only when there is one", () => {
    const loop = {
      usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 },
      turnsUsed: 4,
      toolCalls: [
        { tool: "grep_files", args: { text: "a" }, resultPreview: "" },
        { tool: "grep_files", args: { text: "a" }, resultPreview: "" },
      ],
    };
    expect(
      codePassOutcome({
        mode: "explore",
        loop,
        tokenBudget: 5000,
        maxTurns: 10,
        degradation: "token-budget",
      }),
    ).toEqual({
      mode: "explore",
      tokensUsed: 1000,
      tokenBudget: 5000,
      turnsUsed: 4,
      maxTurns: 10,
      degradation: "token-budget",
      repeatedToolCalls: 1,
    });
    expect(
      codePassOutcome({ mode: "fast", loop, tokenBudget: 5000, maxTurns: 10, degradation: null }),
    ).not.toHaveProperty("degradation");
  });
});

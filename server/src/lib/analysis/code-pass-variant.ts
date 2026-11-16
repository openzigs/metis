/**
 * #2565 — the analysis code pass's two modes, built in ONE place so the
 * orchestrator and the localization eval (A20, #2560) run the same pass.
 *
 * - `fast` is the pass as it was before #2565: nothing here changes it.
 * - `explore` is A20 carried into production: the investigation steps say to
 *   explore the working tree first, the tools are A20's five, `read_file_slice`
 *   reads whole files (bounded by lines AND characters), the transcript ceiling
 *   is wider (bounded by the model's window, #1384), and a pass that answers
 *   before any tool call is sent back once to explore. The pass keeps
 *   PRODUCTION's bounds: the turn cap from `resolveAgenticMaxTurns`, the token
 *   budget, the abort signal, prompt caching and the final-answer retry. A20
 *   measured that the gain comes from exploring first, not from its larger
 *   budget (`eval-data/README.md`, "The explorer arm (#2560)").
 *
 * `explore` needs the file tools, so a pass with no working tree runs `fast`
 * and says why (`no-working-tree`).
 */
import {
  CODE_PASS_MODES,
  type CodePassMode,
  type CodePassModeDecision,
  type CodePassOutcome,
} from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import type { AgentLoopOptions, AgentLoopResult } from "./agent-loop.js";
import { DEFAULT_TRANSCRIPT_COMPACTION } from "./context-window-manager.js";
import { resolveContextWindow } from "./context-watermark.js";
import { grepFilesTool } from "./tools/grep-files.js";
import { listFilesTool } from "./tools/list-files.js";
import { createReadFileSliceTool } from "./tools/read-file-slice.js";
import type { AgentTool } from "./tools/types.js";

/** The platform key that picks the mode (`explore | fast`). */
export const CODE_EXPLORATION_KEY = "ANALYSIS_CODE_EXPLORATION";
/** The platform default until #2568 re-measures and flips it. */
export const DEFAULT_CODE_PASS_MODE: CodePassMode = "fast";

/** `read_file_slice`'s line cap per call in `explore` mode (A20's). */
export const EXPLORE_READ_MAX_LINES_KEY = "ANALYSIS_EXPLORE_READ_MAX_LINES";
export const DEFAULT_EXPLORE_READ_MAX_LINES = 1000;

/**
 * `read_file_slice`'s character cap per call in `explore` mode: about 20k
 * tokens at four characters a token, under the 25k-token tool-response figure
 * Claude Code works to. A read it cuts is `truncated` and names the next range.
 */
export const EXPLORE_READ_MAX_CHARS = 80_000;

/** The transcript compaction ceiling in `explore` mode (A20's). */
export const EXPLORE_TRANSCRIPT_TOKENS_KEY = "ANALYSIS_EXPLORE_TRANSCRIPT_TOKENS";
export const DEFAULT_EXPLORE_TRANSCRIPT_TOKENS = 64_000;
/**
 * #1384 — the explore ceiling never passes this share of the model's catalogued
 * context window: 1000-line reads must not overflow a small local model.
 */
export const EXPLORE_TRANSCRIPT_WINDOW_SHARE = 0.5;

/** Production's investigation steps with a working tree (`buildAgenticCodePrompt`). */
export const GRAPH_STEPS = [
  "- Start by searching the code graph for relevant symbols (classes, functions, interfaces)",
  "- Use read_file_slice to examine specific implementations",
  "- Use list_files to discover project structure when needed",
  "- Use search_knowledge to find additional documentation context",
].join("\n");

/** The explore-first investigation steps for a `read_file_slice` cap of `readMaxLines`. */
export function explorerSteps(readMaxLines: number): string {
  return [
    "- Explore the repository the way a developer does before making the change: start with grep_files for the names, phrases and identifiers the requirement implies, and list_files to learn the layout",
    `- Use read_file_slice to read whole files (omit startLine and endLine; up to ${readMaxLines} lines a call), not just snippets, so you see how the code around a hit works`,
    "- Use search_code_graph and search_code_symbols (with fileGlob, symbolKind and language filters) when a literal search misses something named differently",
    "- Any seeded or retrieved code context in the request is a set of HINTS from a search, not an answer: confirm or discard each hint by reading the code, and look beyond it",
    "- Keep exploring until you can name every file the change would edit, then give your answer",
  ].join("\n");
}

/** The explore-first steps at the default read cap (A20's, #2560). */
export const EXPLORER_STEPS = explorerSteps(DEFAULT_EXPLORE_READ_MAX_LINES);

/**
 * #2560 — sent once when the explorer answers before calling any tool: on the
 * first Miniflux items, Sonnet answered A20's first turn from the seeded blocks
 * alone, which is A3A's pass under another label.
 */
export const EXPLORER_NUDGE =
  "You answered without reading any code. The seeded context is only a hint. Explore first: grep_files for the names the requirement implies, read the files that matter in full with read_file_slice, and check what else the change would touch. Then give your final answer as JSON.";

/**
 * Production's prompt with the investigation steps rewritten for exploration
 * first. Throws when production's steps are not found, so a prompt change
 * cannot leave the explore pass pointing the model at the wrong tools.
 */
export function explorerSystemMessage(
  systemMessage: string,
  readMaxLines: number = DEFAULT_EXPLORE_READ_MAX_LINES,
): string {
  if (!systemMessage.includes(GRAPH_STEPS)) {
    throw new Error(
      "explore: the agentic code prompt's investigation steps changed; update GRAPH_STEPS in code-pass-variant.ts",
    );
  }
  return systemMessage.replace(GRAPH_STEPS, explorerSteps(readMaxLines));
}

/** The search tools the explore pass is given beside the file tools. */
export interface ExplorerSearchTools {
  /** Production's `search_code_graph`. */
  searchCodeGraph: AgentTool;
  /** `search_code_symbols` with its filters on (`createSearchSymbolsTool(…, { filters: true })`). */
  searchCodeSymbols: AgentTool;
}

/**
 * The explore pass's tools, in the order the model is shown them: A20's five.
 * `search_knowledge` and `describe_table` are not among them, as in A20.
 */
export function explorerTools(
  search: ExplorerSearchTools,
  readMaxLines: number = DEFAULT_EXPLORE_READ_MAX_LINES,
): AgentTool[] {
  return [
    grepFilesTool,
    listFilesTool,
    createReadFileSliceTool(readMaxLines, { maxChars: EXPLORE_READ_MAX_CHARS }),
    search.searchCodeGraph,
    search.searchCodeSymbols,
  ];
}

/** The platform key's mode; an unset or unknown value is the default. */
export function readCodeExplorationSetting(): CodePassMode {
  const raw = getConfigService().get(CODE_EXPLORATION_KEY)?.trim().toLowerCase();
  return (CODE_PASS_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as CodePassMode)
    : DEFAULT_CODE_PASS_MODE;
}

/**
 * The mode a code pass runs in, and why. A pass with no working tree runs
 * `fast` (explore needs `grep_files` and the file reads).
 */
export function resolveCodePassMode(input: {
  platformDefault: CodePassMode;
  fileToolsAvailable: boolean;
}): CodePassModeDecision {
  if (!input.fileToolsAvailable) return { mode: "fast", reason: "no-working-tree" };
  return { mode: input.platformDefault, reason: "platform-default" };
}

/**
 * #1384 — the explore transcript ceiling: the configured ceiling, never more
 * than {@link EXPLORE_TRANSCRIPT_WINDOW_SHARE} of the model's catalogued window
 * (the watermark's modest fallback when the catalogue does not know it).
 */
export function resolveExploreTranscriptTokens(providerKey: string, model: string): number {
  const configured = positiveSetting(
    EXPLORE_TRANSCRIPT_TOKENS_KEY,
    DEFAULT_EXPLORE_TRANSCRIPT_TOKENS,
  );
  const window = resolveContextWindow(providerKey, model).tokens;
  return Math.max(1, Math.min(configured, Math.floor(window * EXPLORE_TRANSCRIPT_WINDOW_SHARE)));
}

/**
 * The explore pass's continuation: {@link EXPLORER_NUDGE} once, when the model
 * answers before calling any tool; every other tool-less reply goes to
 * `base` (#1388's `buildCodePassContinuation`), at most `base.maxNudges`
 * times. So a loop sends at most `base.maxNudges + 1` nudges, and each is an
 * ordinary turn (it counts against `maxTurns` and the token budget).
 */
export function composeExplorerContinuation(
  base: NonNullable<AgentLoopOptions["continuation"]>,
  toolCallsMade: () => number,
): NonNullable<AgentLoopOptions["continuation"]> {
  let explorerNudged = false;
  let baseNudges = 0;
  return {
    maxNudges: base.maxNudges + 1,
    nudge: (reply, state) => {
      if (!explorerNudged && toolCallsMade() === 0) {
        explorerNudged = true;
        return EXPLORER_NUDGE;
      }
      if (baseNudges >= base.maxNudges) return null;
      const instruction = base.nudge(reply, { ...state, nudgesSent: baseNudges });
      if (instruction !== null) baseNudges += 1;
      return instruction;
    },
  };
}

/** What the orchestrator hands `runAgentLoop` differently in `explore` mode. */
export interface ExploreCodePass {
  /** Production's system message with the explore-first steps. */
  systemMessage: (systemMessage: string) => string;
  tools: AgentTool[];
  readMaxLines: number;
  transcriptCompaction: NonNullable<Exclude<AgentLoopOptions["transcriptCompaction"], false>>;
  /** Wraps the pass's #1388 continuation with the explorer nudge. */
  continuation: (
    base: NonNullable<AgentLoopOptions["continuation"]>,
    toolCallsMade: () => number,
  ) => NonNullable<AgentLoopOptions["continuation"]>;
}

/**
 * A positive integer key, or `fallback`. The key's schema is applied only on a
 * write through the config service; a value read from the environment is not
 * validated, so `0`, a negative or a non-number would reach a tool and fail
 * every explore pass. A typo degrades to the default instead.
 */
function positiveSetting(key: string, fallback: number): number {
  const n = getConfigService().getNumber(key, fallback);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** The explore-mode pass for `providerKey`/`model`, with the given search tools. */
export function buildExploreCodePass(input: {
  search: ExplorerSearchTools;
  providerKey: string;
  model: string;
}): ExploreCodePass {
  const readMaxLines = positiveSetting(EXPLORE_READ_MAX_LINES_KEY, DEFAULT_EXPLORE_READ_MAX_LINES);
  return {
    systemMessage: (systemMessage) => explorerSystemMessage(systemMessage, readMaxLines),
    tools: explorerTools(input.search, readMaxLines),
    readMaxLines,
    transcriptCompaction: {
      ...DEFAULT_TRANSCRIPT_COMPACTION,
      maxTranscriptTokens: resolveExploreTranscriptTokens(input.providerKey, input.model),
    },
    continuation: composeExplorerContinuation,
  };
}

/** How many of a pass's tool calls repeat an earlier (tool, arguments) pair of the same pass. */
export function countRepeatedToolCalls(
  calls: ReadonlyArray<{ tool: string; args: unknown }>,
): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const call of calls) {
    const key = `${call.tool}\u0000${stableJson(call.args)}`;
    if (seen.has(key)) repeated += 1;
    else seen.add(key);
  }
  return repeated;
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` are the same call. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** One pass's {@link CodePassOutcome}, from its loop result and how it ended. */
export function codePassOutcome(input: {
  mode: CodePassMode;
  loop: Pick<AgentLoopResult, "usage" | "turnsUsed" | "toolCalls">;
  tokenBudget: number;
  maxTurns: number;
  degradation: CodePassOutcome["degradation"] | null;
}): CodePassOutcome {
  return {
    mode: input.mode,
    tokensUsed: input.loop.usage.totalTokens,
    tokenBudget: input.tokenBudget,
    turnsUsed: input.loop.turnsUsed,
    maxTurns: input.maxTurns,
    ...(input.degradation ? { degradation: input.degradation } : {}),
    repeatedToolCalls: countRepeatedToolCalls(input.loop.toolCalls),
  };
}

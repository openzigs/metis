/**
 * #2324 — how chat should SEARCH before it answers.
 *
 * #2241 (`ANSWER_POLICY_SENTENCES`, `chat-system-prompt.ts`) owns WHETHER to
 * answer: from the sources, abstaining or asking when they fall short. This
 * module owns how to LOOK before deciding, in three places:
 *
 *   1. {@link SEARCH_GUIDANCE_INSTRUCTION} — one block in the byte-stable prompt
 *      lead, present only when a code/knowledge tool is offered in the turn;
 *   2. {@link SEARCH_TOOL_USAGE} — per-tool sentences appended to the
 *      descriptions of the four grounding tools: when to use it, what a good
 *      query looks like, what to try after an empty result;
 *   3. {@link resultInstructions} — an `instructions` string carried with every
 *      grounding tool result, rendered AFTER the result's closing data fence.
 *
 * Every string here is a fixed server-side constant. Nothing is ever built
 * from retrieved text, so the instruction channel cannot carry anything a
 * document or a repository put there (A03, prompt injection): retrieved text
 * stays inside its fence.
 *
 * All three are behind `CHAT_SEARCH_GUIDANCE` (key registry), whose default
 * follows the paired `pnpm eval:ba-qa` measurement recorded on #2324.
 */
import { getConfigService } from "../config/config-service.js";

/** The registry key that turns the guidance on and off. */
export const SEARCH_GUIDANCE_KEY = "CHAT_SEARCH_GUIDANCE";

/**
 * #2324 — the guidance's default. Set from the paired measurement on the BA
 * question set (`tools-only` arm, with and without): see #2324 and
 * `eval-data/README.md`.
 */
export const SEARCH_GUIDANCE_DEFAULT = true;

/** Whether the search guidance is on for this turn. */
export function searchGuidanceEnabled(): boolean {
  return getConfigService().getBool(SEARCH_GUIDANCE_KEY, SEARCH_GUIDANCE_DEFAULT);
}

/** The canonical names of the tools that ground an answer in project sources. */
export const GROUNDING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_code_symbols",
  "search_code_graph",
  "read_file_slice",
  "search-knowledge",
]);

/**
 * The system-prompt block. It says nothing about whether to answer, abstain
 * or ask (that is {@link ANSWER_POLICY_SENTENCES}'s), and a test holds the
 * two to no shared sentence.
 */
export const SEARCH_GUIDANCE_INSTRUCTION = [
  "## How to search before you answer",
  "- Turn the question into the names the code or documents would use: a function, class, table,",
  "  route or config key. A business term is rarely the identifier that implements it.",
  "- Run two or three differently worded searches (a synonym, the identifier spelling, a narrower",
  "  or wider term) before you conclude that something is not there.",
  "- Pick the search by what you are looking for, and fall back in this order: symbol search",
  "  (search_code_symbols, search_code_graph) for a function or class; text search",
  "  (search-knowledge) for wording, rules and settings; a file's symbols (search_code_graph",
  "  with filePath); then read the code (read_file_slice). Use whichever of these you have.",
  "- Before you state that one function calls another, or that data flows from one place to",
  "  another, read the code that does it. A matching name in a search result does not show it.",
  "- When your searches find nothing, list the terms and tools you searched with.",
].join("\n");

/**
 * Appended to each grounding tool's own description. Keyed by canonical name;
 * a tool not named here keeps its description.
 */
export const SEARCH_TOOL_USAGE: Readonly<Record<string, string>> = {
  search_code_symbols:
    "When: the question names a behaviour or business term and you need the code behind it. " +
    "A good query is two to five words in the code's own vocabulary (`refresh feed interval`), " +
    "not the whole question. Empty result: reword with a synonym or the likely identifier, then " +
    "try search_code_graph with a name fragment or search-knowledge.",
  search_code_graph:
    "When: you know part of a name or path — to find a symbol (query), list a file's symbols " +
    "(filePath), or follow callers and callees (calls, calledBy). A good query is an identifier " +
    "or path fragment (`UpdateFeed`, `handlers/feed`). Empty result: try a shorter fragment or " +
    "another spelling (camelCase, snake_case), or search_code_symbols for a fuzzy match.",
  read_file_slice:
    "When: to confirm what a search hit shows before you rely on it (above all a caller, callee " +
    "or data-flow claim) and to quote the lines you cite. Ask for a narrow range around the " +
    "locator. File not found: take the exact path from a search result instead of guessing one.",
  "search-knowledge":
    "When: wording, rules, requirements or settings in the project's documents and source " +
    "excerpts. A good query names the rule the way a document would (`grace period for overdue " +
    "invoices`). No matches: reword with a synonym or the identifier form before concluding the " +
    "documents do not cover it, and try search_code_symbols for code.",
};

/** `description` with the tool's {@link SEARCH_TOOL_USAGE} appended, if it has one. */
export function withSearchUsage(name: string, description: string): string {
  const usage = SEARCH_TOOL_USAGE[name];
  return usage ? `${description} ${usage}` : description;
}

/** Carried with a grounding tool result that returned something. */
export const SOURCE_RESULT_INSTRUCTIONS =
  "Instructions from METIS, not the tool: answer only from these results and the other sources " +
  "here, cite each claim to its locator or document, and say so if they do not hold the answer.";

/** Carried with a grounding tool result that found nothing. */
export const EMPTY_RESULT_INSTRUCTIONS =
  "Instructions from METIS, not the tool: nothing was found, which does not yet show it is " +
  "absent. Search again with other wording (a synonym, the identifier, a shorter fragment) or " +
  "another tool before concluding that.";

/**
 * The `instructions` for one result of the tool named `name` (canonical), or
 * `undefined` for a tool that is not a grounding tool and for a failed call —
 * an error is not a source, and its own text says how to repair the call.
 * `resultCount: 0` is the structured "worked, found nothing" contract (#773);
 * a result without a count (a file read) returned what it was asked for.
 */
export function resultInstructions(
  name: string,
  result: { isError?: boolean; resultCount?: number },
): string | undefined {
  if (!GROUNDING_TOOL_NAMES.has(name) || result.isError === true) return undefined;
  return result.resultCount === 0 ? EMPTY_RESULT_INSTRUCTIONS : SOURCE_RESULT_INSTRUCTIONS;
}

/** True when `names` (canonical tool names offered this turn) include a grounding tool. */
export function offersGroundingTool(names: Iterable<string>): boolean {
  for (const n of names) if (GROUNDING_TOOL_NAMES.has(n)) return true;
  return false;
}

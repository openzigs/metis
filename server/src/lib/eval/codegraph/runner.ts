/**
 * Epic #712 / Issue #717 — code-graph citation eval runner.
 *
 * Wires the self-contained fixture, the deterministic offline provider, and the
 * REAL production code paths (#714 fused retrieval, #713 chat code-search tool
 * loop, #715 citation policy) into one reproducible run with two arms:
 *
 *   - flag ON  → the chat code tools are offered, the loop executes
 *     `search_code_symbols`, and the answer cites the derived locator.
 *   - flag OFF → no tools / no fused block, so the provider degrades to the
 *     legacy uncited answer — proving the flags gate cleanly.
 *
 * The runner is pure orchestration over injected pieces (no process.env reads,
 * no network) so both the CI unit test and the offline CLI drive it identically.
 */
import type { AIProvider, ChatMessage } from "../../ai/types.js";
import {
  assembleChatSystem,
  CITATION_INSTRUCTION,
  stableLeadText,
} from "../../ai/chat-system-prompt.js";
import { buildChatCodeToolRuntime, runChatCodeToolTurn } from "../../ai/chat-code-tool-runtime.js";
import {
  buildFusedCodeBlock,
  type FusedRagChunkRef,
  type FuseCodeContextResult,
} from "../../rag/fused-code-context.js";
import { citesLocator, expectedLocator, findForbiddenDisclaimer } from "./assertions.js";
import type { CodegraphFixture } from "./fixture.js";

/** Token budget / cap for the fused passive block during the eval. */
const FUSED_TOKEN_BUDGET = 4000;
const FUSED_MAX_SYMBOLS = 10;

export interface CodegraphEvalResult {
  /** Whether the fused-retrieval / code-tools flag was on for this arm. */
  enabled: boolean;
  /** The model's final answer. */
  answer: string;
  /** Tool calls the loop executed (empty in the flag-off arm). */
  toolCalls: Array<{ tool: string; args: unknown }>;
  /** The locator derived from the target `CodeSymbol` record. */
  expectedLocator: string;
  /** Whether the answer cited the derived locator. */
  cited: boolean;
  /** First forbidden disclaimer found in the answer, or null when clean. */
  disclaimer: string | null;
  /** The fused passive block (#714) built for this arm — "" when disabled. */
  fusedBlock: string;
  /** Fused merge stats (dedupe / budget) for the #714 assertion. */
  fusedStats: Pick<FuseCodeContextResult, "usedSymbols" | "droppedDuplicate" | "droppedBudget">;
  /** The byte-stable prompt lead (asserts #713/#715 ride the cacheable prefix). */
  stableLead: string;
}

export interface RunCodegraphEvalOptions {
  fixture: CodegraphFixture;
  provider: AIProvider;
  enabled: boolean;
  /**
   * Optional RAG doc chunks already in the retrieved-knowledge block, used to
   * exercise #714 dedupe (a chunk covering a symbol's file drops that symbol).
   */
  ragChunks?: FusedRagChunkRef[];
}

/**
 * Run one arm of the eval. Returns a structured result the caller asserts on
 * (the assertions themselves stay in the pure {@link assertions} helpers so the
 * unit test and CLI agree on pass/fail).
 */
export async function runCodegraphCitationEval(
  opts: RunCodegraphEvalOptions,
): Promise<CodegraphEvalResult> {
  const { fixture, provider, enabled } = opts;
  const ragChunks = opts.ragChunks ?? [];
  const locator = expectedLocator(fixture.targetSymbol);

  // #714 — build the fused passive block from the REAL merge, using the
  // fixture's in-memory searcher / line lookup. Off ⇒ empty (never queried).
  const fused = await buildFusedCodeBlock({
    projectId: fixture.projectId,
    query: fixture.spec.question,
    ragChunks,
    enabled,
    tokenBudget: FUSED_TOKEN_BUDGET,
    maxSymbols: FUSED_MAX_SYMBOLS,
    searcher: fixture.searcher,
    lineLookup: fixture.lineLookup,
  });

  // #713 — decide the code-tool runtime, injecting the fixture's searcher so the
  // tool never reaches Prisma. Off ⇒ no tools, empty schema block.
  const runtime = buildChatCodeToolRuntime({
    enabled,
    projectId: fixture.projectId,
    deps: { searcher: fixture.searcher, lineLookup: fixture.lineLookup },
  });

  // #713 + #715 — assemble the byte-stable chat prompt lead: tool schemas +
  // static citation policy ride the cacheable prefix. Off ⇒ neither is present.
  const assembled = assembleChatSystem({
    persona: "You are a helpful engineering assistant grounded in this project's code graph.",
    toolSchemas: enabled ? runtime.schemaBlock : null,
    citationInstruction: enabled ? CITATION_INSTRUCTION : null,
  });

  const conversation: ChatMessage[] = [
    ...assembled.all,
    ...(fused.block ? [{ role: "system" as const, content: fused.block }] : []),
    { role: "user", content: fixture.spec.question },
  ];

  let answer: string;
  let toolCalls: Array<{ tool: string; args: unknown }> = [];

  if (enabled) {
    // Execute the shared agent loop — the model calls the tool, the loop runs it
    // against the fixture project, and the final answer cites the locator.
    const turn = await runChatCodeToolTurn(provider, {
      messages: conversation,
      tools: runtime.tools,
      projectId: fixture.projectId,
    });
    answer = turn.finalResponse;
    toolCalls = turn.toolCalls;
  } else {
    // Flag off: single provider turn, no loop, no tools — legacy behaviour.
    const res = await provider.chat(conversation, {});
    answer = res.content;
  }

  return {
    enabled,
    answer,
    toolCalls,
    expectedLocator: locator,
    cited: citesLocator(answer, locator),
    disclaimer: findForbiddenDisclaimer(answer, fixture.spec.forbiddenDisclaimers),
    fusedBlock: fused.block,
    fusedStats: {
      usedSymbols: fused.usedSymbols,
      droppedDuplicate: fused.droppedDuplicate,
      droppedBudget: fused.droppedBudget,
    },
    stableLead: stableLeadText(assembled),
  };
}

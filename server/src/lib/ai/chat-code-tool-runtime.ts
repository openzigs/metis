/**
 * Epic #712 / Issue #713 — chat-facing agentic code-search runtime.
 *
 * The chat/stream routes historically had NO tool-execution loop, and only the
 * Copilot SDK provider honours `disableTools`; the native-Anthropic and
 * bedrock-direct providers have no tool support at all. So registering a tool is
 * insufficient — this module wires the provider-agnostic textual tool protocol
 * onto the chat surface by REUSING the analysis agent loop
 * ({@link runAgentLoop}) as the single execution mechanism, rather than forking a
 * chat-only implementation.
 *
 * Two pieces:
 *   1. {@link buildChatCodeToolRuntime} — decides whether the curated code tools
 *      are offered this request (env flag + project-scoped session) and renders
 *      their JSON Schemas via {@link formatToolSchemas} (deterministically
 *      ordered by name, the #398 pattern) for injection into the byte-stable
 *      chat-prompt lead (`assembleChatSystem`). Flag off ⇒ no tools, empty schema
 *      block ⇒ the stable lead is byte-identical to today.
 *   2. {@link runChatCodeToolTurn} — a thin adapter over `runAgentLoop` that runs
 *      the model turns NON-streaming via `provider.chat` (so the #718 tool-tag
 *      stream parser is never involved and no protocol string leaks as a delta),
 *      executes tool calls scoped to the session's project, surfaces each via an
 *      `onToolCall` callback for a structured `tool_call` frame, and returns the
 *      final answer for the caller to stream as a delta. Iterations are bounded.
 */
import type { AIProvider, ChatMessage, ChatOptions, TokenUsage } from "./types.js";
import type { AgentTool } from "../analysis/tools/types.js";
import { formatToolSchemas, runAgentLoop } from "../analysis/agent-loop.js";
import { getChatCodeTools, type ChatCodeToolDeps } from "../analysis/tools/index.js";

/**
 * Bounded loop budget for the chat code-search path: enough for a couple of
 * tool calls plus a final answer, never an unbounded tool-call loop.
 */
export const CHAT_CODE_TOOL_MAX_TURNS = 4;

export interface ChatCodeToolRuntime {
  /** Whether the curated code tools are offered + executed this request. */
  enabled: boolean;
  /** The curated tool set (empty when disabled). */
  tools: AgentTool[];
  /**
   * Rendered, name-ordered JSON-Schema block for the tools, or `""` when
   * disabled. Injected into the byte-stable chat-prompt lead.
   */
  schemaBlock: string;
}

/**
 * Decide the code-tool runtime for one chat/stream request. Offered ONLY when
 * the env flag is on AND the session is project-scoped — a chat session must
 * never reach another project's graph. Pure/synchronous so the route can build
 * the prompt lead before dispatch.
 */
export function buildChatCodeToolRuntime(opts: {
  enabled: boolean;
  projectId?: string | null;
  deps?: ChatCodeToolDeps;
}): ChatCodeToolRuntime {
  if (!opts.enabled || !opts.projectId) {
    return { enabled: false, tools: [], schemaBlock: "" };
  }
  const tools = getChatCodeTools(opts.deps);
  return { enabled: true, tools, schemaBlock: formatToolSchemas(tools) };
}

export interface ChatCodeToolTurnResult {
  /** The model's final prose answer (never a raw tool-call protocol string). */
  finalResponse: string;
  /** Accumulated token usage across the bounded loop. */
  usage: TokenUsage;
  /** Tool calls executed during the loop (in order). */
  toolCalls: Array<{ tool: string; args: unknown }>;
  /** Number of model turns taken. */
  turnsUsed: number;
}

/**
 * Run one bounded chat turn through the shared agent loop with the curated code
 * tools. Tool execution is scoped to `input.projectId` via the loop's
 * `toolContext`, so a session can only ever search its OWN project's graph.
 *
 * `input.messages` is the route's fully-assembled conversation (stable lead with
 * tool schemas, volatile tail, RAG, and history). It is passed to the loop as
 * `initialMessages` with an empty `systemPrompt`, so the loop does NOT re-render
 * schemas or prepend the analysis protocol — chat keeps its own system prompt.
 */
export async function runChatCodeToolTurn(
  provider: AIProvider,
  input: {
    messages: ChatMessage[];
    tools: AgentTool[];
    projectId: string;
  },
  options: {
    maxTurns?: number;
    signal?: AbortSignal;
    providerChatOptions?: Partial<ChatOptions>;
    onToolCall?: (call: { tool: string; args: unknown }) => void;
  } = {},
): Promise<ChatCodeToolTurnResult> {
  const result = await runAgentLoop(
    provider,
    {
      systemMessage: "",
      userMessage: "",
      tools: input.tools,
      toolContext: { projectId: input.projectId },
    },
    {
      maxTurns: options.maxTurns ?? CHAT_CODE_TOOL_MAX_TURNS,
      signal: options.signal,
      systemPrompt: "",
      initialMessages: input.messages,
      providerChatOptions: options.providerChatOptions,
      onToolCall: options.onToolCall
        ? (c) => options.onToolCall?.({ tool: c.tool, args: c.args })
        : undefined,
    },
  );

  return {
    finalResponse: result.finalResponse,
    usage: result.usage,
    toolCalls: result.toolCalls.map((c) => ({ tool: c.tool, args: c.args })),
    turnsUsed: result.turnsUsed,
  };
}

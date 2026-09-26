/**
 * Epic #128 / #140 — one chat turn with tools, on the shared agent loop.
 *
 * The session's toolset is offered NATIVELY when the model is tool-capable
 * (#141's catalog flag), and through the text protocol otherwise; either way
 * every call goes through {@link executeToolCall} and therefore through the
 * session's approval gate (#142) before it runs, and every step is reported as
 * a {@link ToolEvent} (#143).
 *
 * Tool results are capped in the MODEL's context (#138) and fenced as untrusted
 * data; the transcript keeps them in full. Each executed or refused call is
 * handed to `onToolRecord` as soon as it finishes, so a turn that fails later
 * still records what already ran — nothing is silently dropped.
 */
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse, TokenUsage } from "../types.js";
import { runAgentLoop, type AgentLoopResult } from "../../analysis/agent-loop.js";
import { withInvokeAgentSpan } from "../../otel/genai-spans.js";
import type { ApprovalGateService } from "../approval-policy.js";
import type { RuntimeToolset } from "./toolset.js";
import { executeToolCall, type ExecutedToolCall } from "./executor.js";
import type { RuntimeToolContext, ToolEvent } from "./types.js";

/** Model turns per chat turn: a few rounds of tool calls plus the answer. */
export const CHAT_TOOL_MAX_TURNS = 6;

/** One call as the transcript records it (full result, never capped). */
export interface ChatToolRecord {
  callId: string;
  tool: string;
  args: unknown;
  result: string;
  isError?: boolean;
  truncated?: boolean;
  /** The gate's decision, when the call reached it. */
  decision?: ExecutedToolCall["decision"];
  /** Fixed-vocabulary code for a refused or failed call. */
  errorCode?: ExecutedToolCall["errorCode"];
  executed: boolean;
}

export interface ChatToolTurnResult {
  finalResponse: string;
  /**
   * The reply as the user should see it. Native mode: every model turn's text
   * in order (the "Let me look…" before a tool call included), then the
   * loop's answer if it is not already the tail — the same text the /stream
   * route delivers. Text protocol: `finalResponse` (its earlier turns are
   * tool-call JSON, not prose).
   */
  replyText: string;
  usage: TokenUsage;
  finishReason?: string;
  toolResults: ChatToolRecord[];
  turnsUsed: number;
  native: boolean;
  loop: Pick<AgentLoopResult, "turnsExhausted" | "hasFinalAnswer">;
}

export interface ChatToolTurnInput {
  messages: ChatMessage[];
  toolset: RuntimeToolset;
  /** Offer tools natively (the model is tool-capable) or via the text protocol. */
  native: boolean;
  ctx: RuntimeToolContext;
  gate: ApprovalGateService;
}

export interface ChatToolTurnOptions {
  maxTurns?: number;
  signal?: AbortSignal;
  providerChatOptions?: Partial<ChatOptions>;
  /** #138 — cap on one tool result in the model's context, in characters. */
  toolResultMaxChars?: number;
  onToolEvent?: (event: ToolEvent) => void;
  onToolRecord?: (record: ChatToolRecord) => void;
  /** A streaming model caller (the /stream route); defaults to `provider.chat`. */
  callModel?: (messages: ChatMessage[], opts: ChatOptions) => Promise<ChatResponse>;
}

function capForModel(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || maxChars <= 0 || text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n…[tool result truncated: showing the first ${maxChars} of ${text.length} characters. ` +
    `The full result is kept in this conversation's transcript.]`
  );
}

/**
 * Join native turns' texts the way the /stream route streams them: a blank
 * line between turns unless the previous one already ended a line, then the
 * loop's answer if it is not already the tail (a substitute answer the model
 * never produced).
 */
export function composeReplyText(turnTexts: readonly string[], finalResponse: string): string {
  let out = "";
  for (const text of turnTexts) {
    if (!text) continue;
    if (out && !out.endsWith("\n")) out += "\n\n";
    out += text;
  }
  if (finalResponse && !out.endsWith(finalResponse)) {
    out += `${out ? "\n\n" : ""}${finalResponse}`;
  }
  return out;
}

export async function runChatToolTurn(
  provider: AIProvider,
  input: ChatToolTurnInput,
  options: ChatToolTurnOptions = {},
): Promise<ChatToolTurnResult> {
  const records: ChatToolRecord[] = [];
  let finishReason: string | undefined;
  const turnTexts: string[] = [];
  const callModel =
    options.callModel ?? ((m: ChatMessage[], o: ChatOptions) => provider.chat(m, o));

  const result = await withInvokeAgentSpan("chat", async (span) => {
    span.setAttribute("metis.session.id", input.ctx.sessionId);
    span.setAttribute("metis.tools.offered", input.toolset.tools.length);
    span.setAttribute("metis.tools.native", input.native);
    return runAgentLoop(
      provider,
      {
        systemMessage: "",
        userMessage: "",
        // The text protocol's parser matches on these names; the executor
        // resolves wire and canonical names alike.
        tools: input.toolset.tools.map((t) => ({
          name: t.wireName,
          description: t.description,
          parameters: t.parameters as never,
          execute: async () => ({ content: "" }),
        })),
        toolContext: { projectId: input.ctx.projectId ?? "" },
      },
      {
        maxTurns: options.maxTurns ?? CHAT_TOOL_MAX_TURNS,
        signal: options.signal,
        systemPrompt: "",
        initialMessages: input.messages,
        providerChatOptions: options.providerChatOptions,
        fenceToolResults: true,
        ...(input.native ? { native: { tools: input.toolset.specs() } } : {}),
        callModel: async (m, o) => {
          const r = await callModel(m, o);
          finishReason = r.finishReason;
          turnTexts.push(r.content);
          return r;
        },
        executeTool: async (call) => {
          const executed = await executeToolCall(
            { id: call.id, name: call.tool, args: call.args },
            {
              toolset: input.toolset,
              gate: input.gate,
              ctx: input.ctx,
              onEvent: options.onToolEvent,
            },
          );
          const record: ChatToolRecord = {
            callId: executed.callId,
            tool: executed.tool,
            args: executed.args,
            result: executed.text,
            executed: executed.executed,
            ...(executed.isError ? { isError: true } : {}),
            ...(executed.decision ? { decision: executed.decision } : {}),
            ...(executed.errorCode ? { errorCode: executed.errorCode } : {}),
          };
          const modelCopy = capForModel(executed.text, options.toolResultMaxChars);
          if (modelCopy !== executed.text) record.truncated = true;
          records.push(record);
          try {
            options.onToolRecord?.(record);
          } catch {
            /* a listener must never break the loop */
          }
          return {
            content: modelCopy,
            tool: executed.tool,
            fullText: executed.text,
            isError: executed.isError,
            ...(typeof executed.resultCount === "number"
              ? { resultCount: executed.resultCount }
              : {}),
          };
        },
      },
    );
  });

  return {
    finalResponse: result.finalResponse,
    replyText: input.native
      ? composeReplyText(turnTexts, result.finalResponse)
      : result.finalResponse,
    usage: result.usage,
    ...(finishReason ? { finishReason } : {}),
    toolResults: records,
    turnsUsed: result.turnsUsed,
    native: input.native,
    loop: { turnsExhausted: result.turnsExhausted, hasFinalAnswer: result.hasFinalAnswer },
  };
}

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
import { isToolCallReply, runAgentLoop, type AgentLoopResult } from "../../analysis/agent-loop.js";
import { withInvokeAgentSpan } from "../../otel/genai-spans.js";
import type { ApprovalGateService } from "../approval-policy.js";
import type { RuntimeToolset } from "./toolset.js";
import { executeToolCall, type ExecutedToolCall } from "./executor.js";
import type { RuntimeToolContext, ToolEvent, ToolSource } from "./types.js";

/** Model turns per chat turn: a few rounds of tool calls plus the answer. */
export const CHAT_TOOL_MAX_TURNS = 6;

/**
 * #736 — how many turns one chat turn may get back because every call in them
 * expired waiting for the user's approval. A tool call that nobody answered is
 * not the model's spent step, so it should not cost one; the bound keeps an
 * unattended session from waiting out approval timeouts indefinitely.
 */
export const CHAT_TOOL_MAX_APPROVAL_REFUNDS = 2;

/**
 * #772 — the last user turn of the ONE tool-free call a chat turn makes when
 * its step budget ran out mid-investigation. Before it, everything the tools
 * had read was discarded for a canned "reached the tool-call limit" message
 * the user was still billed for.
 */
export const CHAT_FINAL_SYNTHESIS_INSTRUCTION =
  "You have used every tool call available for this question, and no more tools can be run. " +
  "Answer the user's question now, using only the evidence already gathered above, and cite " +
  "the files and line ranges it came from. Say plainly what you could not verify.";

/**
 * PR #783 review — the synthesis instruction for a run whose answer has a
 * server-authored output contract (a custom agent's findings JSON, say). The
 * chat wording alone invited a prose answer that the caller then could not
 * parse, so the contract is restated after it: it is the last thing the model
 * reads before the one call that has to produce the answer.
 */
export function finalSynthesisInstruction(outputContract?: string): string {
  const contract = outputContract?.trim();
  if (!contract) return CHAT_FINAL_SYNTHESIS_INSTRUCTION;
  return (
    `${CHAT_FINAL_SYNTHESIS_INSTRUCTION}\n\n` +
    "Keep the required output format: reply exactly as this output contract specifies, " +
    `and nothing else.\n\n${contract}`
  );
}

/** A synthesis reply counts only if it says something and is not tool protocol. */
function isChatAnswer(text: string, toolNames: readonly string[]): boolean {
  return text.trim().length > 0 && !isToolCallReply(text, toolNames);
}

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
  /** #147 — the sub-agent run this call started (its stored transcript). */
  subAgentRunId?: string;
  /** #439 — where the tool comes from (`code`, `mcp`, …), when it resolved. */
  source?: ToolSource;
  /** #439 / #464 — code tools and `search-knowledge`: how many results came back (`0` = found nothing). */
  resultCount?: number;
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
  /**
   * #243 — called with each model call's reported usage as soon as that call
   * returns, so a turn that fails on a LATER call can still meter what the
   * earlier ones cost. The loop's `usage` (on success) is the sum of these.
   */
  onUsage?: (usage: TokenUsage) => void;
  /**
   * PR #783 review — the run's server-authored output contract, if any. The
   * #772 final-synthesis call restates it so a spent step budget still ends in
   * the required format, not chat prose.
   */
  outputContract?: string;
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
  // #736 — the error codes of the reply's calls, read and reset by `refundTurn`.
  let batchCodes: Array<string | undefined> = [];
  let refunds = 0;

  const wireNames = input.toolset.tools.map((t) => t.wireName);

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
        // #772 — a spent step budget still ends in an answer: one bounded,
        // tool-free call over what the tools already returned.
        finalAnswerRetry: {
          instruction: finalSynthesisInstruction(options.outputContract),
          isValidFinalAnswer: (text) => isChatAnswer(text, wireNames),
        },
        refundTurn: () => {
          const expired =
            batchCodes.length > 0 && batchCodes.every((c) => c === "TOOL_APPROVAL_EXPIRED");
          batchCodes = [];
          if (!expired || refunds >= CHAT_TOOL_MAX_APPROVAL_REFUNDS) return false;
          refunds++;
          return true;
        },
        ...(input.native ? { native: { tools: input.toolset.specs() } } : {}),
        callModel: async (m, o) => {
          const r = await callModel(m, o);
          if (r.usage) {
            try {
              options.onUsage?.(r.usage);
            } catch {
              /* a listener must never break the loop */
            }
          }
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
          batchCodes.push(executed.errorCode);
          const record: ChatToolRecord = {
            callId: executed.callId,
            tool: executed.tool,
            args: executed.args,
            result: executed.text,
            executed: executed.executed,
            ...(executed.isError ? { isError: true } : {}),
            ...(executed.decision ? { decision: executed.decision } : {}),
            ...(executed.errorCode ? { errorCode: executed.errorCode } : {}),
            ...(executed.subAgentRunId ? { subAgentRunId: executed.subAgentRunId } : {}),
          };
          const source = input.toolset.resolve(executed.tool)?.source;
          if (source) record.source = source;
          if (typeof executed.resultCount === "number") record.resultCount = executed.resultCount;
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

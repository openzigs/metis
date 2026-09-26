/**
 * Epic #127 — one chat turn on the server-owned transcript, shared by
 * `POST /api/ai/chat` and `POST /api/ai/stream`.
 *
 *   1. {@link prepareTurn} — persist the new user message FIRST (so a crash
 *      mid-call still leaves the question on record), load the history from
 *      `ai_messages`, estimate the prompt with the calibrated estimator (#137)
 *      against the catalog context window, compact when it reaches the
 *      watermark (#138), and return the history to send.
 *   2. {@link recordReply} — persist the reply with the provider-reported usage
 *      (#137), including a reply that ended early (it is marked incomplete, not
 *      dropped), then refresh the derived session snapshot.
 */
import type { SdkReasoningEffort, TranscriptPart } from "@metis/shared";
import type { ChatMessage, TokenUsage } from "../types.js";
import { prisma } from "../../prisma.js";
import { createChildLogger } from "../../logger.js";
import { getConfigService } from "../../config/config-service.js";
import {
  ContextWatermark,
  resolveContextWindow,
  type ResolvedContextWindow,
  type WatermarkCheckResult,
} from "../../analysis/context-watermark.js";
import {
  compactTranscript,
  DEFAULT_SUMMARY_MAX_TOKENS,
  type CompactionOutcome,
  type Summarizer,
} from "../../async/compaction.js";
import {
  appendMessage,
  listActiveMessages,
  partsText,
  type StoredMessage,
} from "./transcript-store.js";
import {
  buildHistory,
  DEFAULT_TOOL_RESULT_MAX_TOKENS,
  joinAdjacentUserMessages,
  type ContextBuildOptions,
} from "./context-builder.js";
import {
  contextInputTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  promptChars,
  resolveTokenRatio,
  type CalibrationSample,
  type TokenRatio,
} from "./token-estimator.js";
import { importLegacySnapshot } from "./legacy-snapshot.js";

const log = createChildLogger("chat-turn");

/** Operator knobs, read per turn so a config change applies without a restart. */
export interface ChatTurnConfig {
  watermarkPercent: number;
  contextWindowFallback: number;
  toolResultMaxTokens: number;
  summaryMaxTokens: number;
  /** Absolute cap on the watermark: project setting, else env. */
  thresholdTokens: number | null;
}

function positive(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function loadChatTurnConfig(projectThreshold?: number | null): ChatTurnConfig {
  const cfg = getConfigService();
  return {
    watermarkPercent: cfg.getNumber("CHAT_COMPACTION_WATERMARK_PERCENT", 80),
    contextWindowFallback: cfg.getNumber("CHAT_CONTEXT_WINDOW_FALLBACK", 32_768),
    toolResultMaxTokens:
      positive(cfg.getNumber("CHAT_TOOL_RESULT_MAX_TOKENS", DEFAULT_TOOL_RESULT_MAX_TOKENS)) ??
      DEFAULT_TOOL_RESULT_MAX_TOKENS,
    summaryMaxTokens:
      positive(cfg.getNumber("CHAT_COMPACTION_SUMMARY_MAX_TOKENS", DEFAULT_SUMMARY_MAX_TOKENS)) ??
      DEFAULT_SUMMARY_MAX_TOKENS,
    thresholdTokens:
      (projectThreshold && projectThreshold > 0 ? projectThreshold : null) ??
      positive(Number.parseInt(process.env.CONTEXT_COMPACTION_THRESHOLD_TOKENS ?? "", 10)),
  };
}

/** The prompt does not fit the model's window even after compacting. */
export class ContextOverflowError extends Error {
  readonly code = "CHAT_CONTEXT_OVERFLOW";
  readonly status = 413;
  constructor(
    readonly estimatedTokens: number,
    readonly contextWindow: ResolvedContextWindow,
  ) {
    super(
      `This conversation no longer fits the model's context window (about ${estimatedTokens} ` +
        `tokens against ${contextWindow.tokens}${contextWindow.source === "fallback" ? ", an assumed window" : ""}), ` +
        "even after summarising older turns. Start a new chat or fork from an earlier message.",
    );
    this.name = "ContextOverflowError";
  }
}

export interface PrepareTurnInput {
  session: {
    id: string;
    snapshot: string | null;
  };
  userText: string;
  /** System messages that lead the prompt (persona, skills, Chronicle, override). */
  prefix: ChatMessage[];
  /** Messages placed just before the new user message (the auto-RAG block). */
  beforeUser: ChatMessage[];
  provider: string;
  model: string;
  summarizer: Summarizer;
  config: ChatTurnConfig;
}

export interface PreparedTurn {
  userRow: StoredMessage;
  /** The full prompt to send: prefix, history, RAG, new user message. */
  messages: ChatMessage[];
  compaction: CompactionOutcome | null;
  /** Compaction was due but failed; the turn proceeded uncompacted. */
  compactionError: string | null;
  ratio: TokenRatio;
  contextWindow: ResolvedContextWindow;
  watermark: WatermarkCheckResult;
  /** Characters of the prompt, stored with the reply to calibrate later turns. */
  promptChars: number;
  build: ContextBuildOptions;
}

export function calibrationSamples(
  rows: readonly StoredMessage[],
  model: string,
): CalibrationSample[] {
  return rows
    .filter(
      (r) =>
        r.role === "assistant" &&
        r.kind === "message" &&
        r.model === model &&
        (r.promptChars ?? 0) > 0 &&
        (r.inputTokens ?? 0) > 0,
    )
    .map((r) => ({ promptChars: r.promptChars!, inputTokens: r.inputTokens! }));
}

/**
 * #137 — the prompt size to store with a reply as a calibration sample. A
 * code-tool turn made several model calls whose usage is summed, so one
 * prompt's characters against that sum would overstate tokens-per-char (early
 * compaction, a false 413); such a turn is not a sample (PR #205 review).
 */
export function calibrationPromptChars(
  turn: Pick<PreparedTurn, "promptChars">,
  toolCalls: readonly unknown[],
): number | null {
  return toolCalls.length > 0 ? null : turn.promptChars;
}

export async function prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
  const sessionId = input.session.id;
  let history = await listActiveMessages(sessionId);
  if (history.length === 0 && input.session.snapshot) {
    // A session from before the server owned its transcript: bring its last
    // snapshot in once, so its earlier turns are not silently missing.
    if ((await importLegacySnapshot(sessionId, input.session.snapshot)) > 0) {
      history = await listActiveMessages(sessionId);
    }
  }

  const ratio = resolveTokenRatio({
    provider: input.provider,
    model: input.model,
    samples: calibrationSamples(history, input.model),
  });
  const userMessage: ChatMessage = { role: "user", content: input.userText };
  const userRow = await appendMessage(sessionId, {
    role: "user",
    parts: [{ type: "text", text: input.userText }],
    estimatedTokens: estimateTextTokens(input.userText, ratio),
  });

  const build: ContextBuildOptions = {
    toolResultMaxChars: Math.floor(input.config.toolResultMaxTokens * ratio.charsPerToken),
  };
  const contextWindow = resolveContextWindow(input.provider, input.model, {
    fallback: input.config.contextWindowFallback,
  });
  const watermarkGate = new ContextWatermark({
    contextWindow,
    watermarkPercent: input.config.watermarkPercent,
    thresholdTokens: input.config.thresholdTokens,
  });

  const fixed = [...input.prefix, ...input.beforeUser, userMessage];
  const fixedTokens = estimateMessagesTokens(fixed, ratio);
  let built = buildHistory(history);
  let estimate = fixedTokens + estimateMessagesTokens(built, ratio);
  let watermark = watermarkGate.check(estimate);

  let compaction: CompactionOutcome | null = null;
  let compactionError: string | null = null;
  if (watermark.overWatermark) {
    try {
      compaction = await compactTranscript({
        sessionId,
        activeRows: history,
        ratio,
        build,
        contextWindow,
        fixedTokens,
        estimatedTokensBefore: estimate,
        summarizer: input.summarizer,
        provider: input.provider,
        model: input.model,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // The caller never gets a PreparedTurn to record a failure against, so
        // record here why the question got no answer (PR #205 review).
        await recordReply({
          sessionId,
          text: "",
          usage: null,
          provider: input.provider,
          model: input.model,
          promptChars: null,
          ratio,
          error: {
            code: "ABORTED",
            message: "The request was cancelled while older turns were being summarised.",
          },
        }).catch((persistErr: unknown) =>
          log.error("Failed to record a turn aborted during compaction", {
            sessionId,
            error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          }),
        );
        throw err;
      }
      compactionError = (err as Error).message;
      log.warn("Compaction failed; the turn continues uncompacted if it still fits", {
        sessionId,
        error: compactionError,
      });
    }
    if (compaction) {
      built = buildHistory(compaction.activeRows);
      estimate = fixedTokens + estimateMessagesTokens(built, ratio);
      watermark = watermarkGate.check(estimate);
    }
  }
  if (watermark.overWindow) {
    const overflow = new ContextOverflowError(estimate, contextWindow);
    // The question is already on record; so is the reason it got no answer.
    await recordReply({
      sessionId,
      text: "",
      usage: null,
      provider: input.provider,
      model: input.model,
      promptChars: null,
      ratio,
      error: { code: overflow.code, message: overflow.message },
      ...(compactionError ? { meta: { compactionError } } : {}),
    });
    throw overflow;
  }

  const messages = joinAdjacentUserMessages([
    ...input.prefix,
    ...built,
    ...input.beforeUser,
    userMessage,
  ]);
  return {
    userRow,
    messages,
    compaction,
    compactionError,
    ratio,
    contextWindow,
    watermark,
    promptChars: promptChars(messages),
    build,
  };
}

/** One executed tool call, as the chat code-tool loop reports it. */
export interface ReplyToolCall {
  tool: string;
  args: unknown;
  result: string;
  isError?: boolean;
}

export interface RecordReplyInput {
  sessionId: string;
  text: string;
  toolCalls?: ReplyToolCall[];
  usage: TokenUsage | null;
  provider: string;
  model: string;
  finishReason?: string | null;
  promptChars: number | null;
  ratio: TokenRatio;
  /** The reply ended early: kept, and marked incomplete. */
  error?: { code: string; message: string } | null;
  meta?: Record<string, unknown>;
}

export async function recordReply(input: RecordReplyInput): Promise<StoredMessage> {
  const parts: TranscriptPart[] = [];
  (input.toolCalls ?? []).forEach((c, i) => {
    const id = `call_${i + 1}`;
    parts.push({ type: "tool_call", id, name: c.tool, args: c.args });
    parts.push({
      type: "tool_result",
      toolCallId: id,
      name: c.tool,
      text: c.result,
      ...(c.isError ? { isError: true } : {}),
    });
  });
  if (input.text) parts.push({ type: "text", text: input.text });
  const reported = input.usage && input.usage.totalTokens + input.usage.promptTokens > 0;
  return appendMessage(input.sessionId, {
    role: "assistant",
    parts,
    estimatedTokens: estimateTextTokens(input.text, input.ratio),
    usage: reported
      ? {
          inputTokens: contextInputTokens(input.provider, input.usage),
          outputTokens: input.usage!.completionTokens,
          cacheReadTokens: input.usage!.cacheReadTokens ?? null,
          cacheWriteTokens: input.usage!.cacheWriteTokens ?? null,
        }
      : null,
    promptChars: input.promptChars,
    provider: input.provider,
    model: input.model,
    finishReason: input.error ? "error" : (input.finishReason ?? null),
    meta: {
      ...(input.meta ?? {}),
      ...(input.error ? { error: input.error } : {}),
    },
  });
}

/**
 * The session `snapshot` is now DERIVED from the transcript (#136): the rows
 * still in context, plus the session state. It keeps `/sessions` listing
 * (`snapshotUpdatedAt`) and older readers working; nothing reads history from
 * it any more.
 */
export async function writeDerivedSnapshot(session: {
  id: string;
  model: string;
  currentModel: string | null;
  currentReasoningEffort: string | null;
  loadedSkillIds: string;
  agentId: string | null;
}): Promise<void> {
  const rows = await listActiveMessages(session.id);
  let skills: string[] = [];
  try {
    const v: unknown = JSON.parse(session.loadedSkillIds);
    if (Array.isArray(v)) skills = v.filter((x): x is string => typeof x === "string");
  } catch {
    skills = [];
  }
  const snapshot = {
    v: 1 as const,
    derivedFrom: "ai_messages",
    messages: rows.map((r) => ({
      role: r.kind === "summary" ? ("system" as const) : r.role,
      content: partsText(r.parts),
    })),
    currentModel: session.currentModel ?? session.model,
    currentReasoningEffort: (session.currentReasoningEffort as SdkReasoningEffort | null) ?? null,
    loadedSkillIds: skills,
    customAgentIds: session.agentId ? [session.agentId] : [],
  };
  await prisma.aISession.update({
    where: { id: session.id },
    data: { snapshot: JSON.stringify(snapshot), snapshotUpdatedAt: new Date() },
  });
}

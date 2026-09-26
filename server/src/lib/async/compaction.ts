/**
 * Epic #156 (#150) — context compaction, rebuilt by #138 on the server-owned
 * transcript (#136).
 *
 * Before #138 this ran only from the manual `/compact` endpoint, over the
 * session `snapshot` JSON, and its automatic path had no caller; chat relied on
 * a sliding window that silently dropped old turns. Now:
 *
 *   • it runs before EVERY chat model call when the estimated prompt reaches the
 *     watermark (`lib/analysis/context-watermark.ts`, a share of the catalog's
 *     context window), and on demand from `POST /api/ai/sessions/:id/compact`;
 *   • the oldest turns are summarised into ONE pinned summary row, and the rows
 *     it replaces are MARKED compacted — never deleted, never rewritten — so
 *     the full conversation stays readable and nothing goes missing silently;
 *   • the system prompt and cacheable prefix are not transcript rows at all, so
 *     compaction cannot touch them: it only ever folds `ai_messages` rows;
 *   • a summary that runs into its output cap is kept but flagged
 *     (`meta.summaryTruncated`), and an EMPTY summary aborts the compaction —
 *     marking rows folded into nothing would lose them.
 */
import { randomUUID } from "node:crypto";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import {
  messageRowData,
  nextOrdinal,
  fromRow,
  partsText,
  type StoredMessage,
} from "../ai/conversation/transcript-store.js";
import {
  capToolResult,
  rowMessages,
  type ContextBuildOptions,
} from "../ai/conversation/context-builder.js";
import {
  contextInputTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  type TokenRatio,
} from "../ai/conversation/token-estimator.js";
import type { ResolvedContextWindow } from "../analysis/context-watermark.js";

const log = createChildLogger("compaction");

export const COMPACTION_SYSTEM_PROMPT =
  "You are a context compactor for a chat assistant. You are given an existing summary of the " +
  "earliest part of a conversation (possibly empty) and the next part of the conversation. " +
  "Write ONE updated summary that replaces both. Preserve every concrete decision, fact, number, " +
  "citation, file path, identifier, open question and unresolved TODO, and who asked for what. " +
  "Drop pleasantries and repetition. Write plain prose or terse bullets; no preamble.";

/** Default output cap for one summariser call. */
export const DEFAULT_SUMMARY_MAX_TOKENS = 2_048;
/** After compacting, aim for the prompt to occupy at most this share of the window. */
export const COMPACTION_TARGET_SHARE = 0.5;
/** Share of the window one summariser call's INPUT may use. */
export const SUMMARY_INPUT_SHARE = 0.5;

export interface SummaryResult {
  text: string;
  usage: TokenUsage | null;
  finishReason?: string;
}

/** Fold `transcript` into `priorSummary`, returning the replacement summary. */
export type Summarizer = (input: {
  priorSummary: string | null;
  transcript: string;
}) => Promise<SummaryResult>;

/** The provider-backed summariser the chat routes use. */
export function providerSummarizer(
  provider: AIProvider,
  opts: { model: string; signal?: AbortSignal; maxTokens?: number },
): Summarizer {
  return async ({ priorSummary, transcript }) => {
    const messages: ChatMessage[] = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Existing summary:\n${priorSummary?.trim() ? priorSummary : "(none)"}\n\n` +
          `Conversation to fold in:\n${transcript}\n\nWrite the updated summary.`,
      },
    ];
    // Deliberately NO `sessionId`: a stateful adapter would otherwise record the
    // summariser's exchange as part of the user's chat.
    const res = await provider.chat(messages, {
      model: opts.model,
      signal: opts.signal,
      maxTokens: opts.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
      disableThinking: true,
      callType: "chat",
    });
    return { text: res.content, usage: res.usage, finishReason: res.finishReason };
  };
}

export class CompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionError";
  }
}

/** Group message rows into turns: a user row plus the replies that follow it. */
export function groupTurns(rows: readonly StoredMessage[]): StoredMessage[][] {
  const groups: StoredMessage[][] = [];
  for (const r of rows) {
    if (r.role === "user" || groups.length === 0) groups.push([r]);
    else groups[groups.length - 1]!.push(r);
  }
  return groups;
}

export interface CompactionPlan {
  /** Message rows to fold (oldest first). */
  fold: StoredMessage[];
  /** Existing summaries, folded into the new one. */
  priorSummaries: StoredMessage[];
  /** Rows that stay in context verbatim. */
  keep: StoredMessage[];
}

/**
 * Decide which turns to fold. Walks back from the newest turn, keeping whole
 * turns while they fit `tailBudgetTokens`; the first turn that does not fit,
 * and everything older, is folded. The newest `keepMinTurns` turns are kept
 * regardless of the budget. Returns `null` when there is nothing to fold.
 */
export function planCompaction(
  activeRows: readonly StoredMessage[],
  opts: {
    ratio: TokenRatio;
    tailBudgetTokens: number;
    keepMinTurns: number;
  },
): CompactionPlan | null {
  const active = activeRows.filter((r) => r.compactedAt === null);
  const priorSummaries = active.filter((r) => r.kind === "summary");
  const groups = groupTurns(active.filter((r) => r.kind !== "summary"));
  const cost = (g: StoredMessage[]): number =>
    g.reduce((n, r) => n + estimateMessagesTokens(rowMessages(r), opts.ratio), 0);

  let used = 0;
  let firstKept = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const c = cost(groups[i]!);
    const forced = groups.length - i <= opts.keepMinTurns;
    if (!forced && used + c > opts.tailBudgetTokens) break;
    used += c;
    firstKept = i;
  }
  const fold = groups.slice(0, firstKept).flat();
  if (fold.length === 0) return null;
  return { fold, priorSummaries, keep: groups.slice(firstKept).flat() };
}

/** Render rows as plain text for the summariser; tool results capped. */
function renderForSummary(rows: readonly StoredMessage[], toolResultMaxChars: number): string[] {
  return rows.map((r) => {
    const lines = [`#${r.ordinal} ${r.role}: ${partsText(r.parts)}`];
    for (const p of r.parts) {
      if (p.type === "tool_result") {
        lines.push(
          `  tool ${p.name} returned: ${capToolResult(p.text, toolResultMaxChars, r.ordinal).text}`,
        );
      }
    }
    return lines.join("\n");
  });
}

/**
 * Batch rendered lines so each summariser call's input fits `budgetTokens`. A
 * single line larger than the budget is split, never dropped.
 */
export function batchForSummary(
  lines: readonly string[],
  budgetTokens: number,
  ratio: TokenRatio,
): string[] {
  const maxChars = Math.max(1_000, Math.floor(budgetTokens * ratio.charsPerToken));
  const pieces: string[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length; i += maxChars) pieces.push(line.slice(i, i + maxChars));
    if (line.length === 0) pieces.push(line);
  }
  const batches: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > maxChars) {
      batches.push(current);
      current = "";
    }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) batches.push(current);
  return batches;
}

export interface CompactTranscriptInput {
  sessionId: string;
  /** The session's ACTIVE rows (not yet folded), in ordinal order. */
  activeRows: readonly StoredMessage[];
  ratio: TokenRatio;
  build: ContextBuildOptions;
  contextWindow: ResolvedContextWindow;
  /** Tokens of everything compaction cannot touch: system prefix, RAG, new message. */
  fixedTokens: number;
  /** The whole prompt's estimate before compacting (for the record). */
  estimatedTokensBefore: number;
  summarizer: Summarizer;
  /** Manual `/compact`: fold everything but the newest turn, whatever the size. */
  force?: boolean;
  provider?: string | null;
  model?: string | null;
}

export interface CompactionOutcome {
  summary: StoredMessage;
  compactedMessages: number;
  fromOrdinal: number;
  toOrdinal: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  contextWindow: number;
  contextWindowSource: ResolvedContextWindow["source"];
  /** Rows now in context: the new summary plus the kept rows. */
  activeRows: StoredMessage[];
}

function sumUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

const MAX_PERSIST_ATTEMPTS = 3;

/**
 * Fold the oldest turns of a session into one summary row. Returns `null` when
 * there is nothing to fold, or when another request compacted the same rows
 * first (its summary then already stands in for them).
 */
export async function compactTranscript(
  input: CompactTranscriptInput,
): Promise<CompactionOutcome | null> {
  const window = input.contextWindow.tokens;
  const tailBudgetTokens = input.force
    ? 0
    : Math.max(0, Math.floor(window * COMPACTION_TARGET_SHARE) - input.fixedTokens);
  const plan = planCompaction(input.activeRows, {
    ratio: input.ratio,
    tailBudgetTokens,
    keepMinTurns: input.force ? 1 : 0,
  });
  if (!plan) return null;

  // ── Summarise, in as many calls as it takes to fit the window ──────────
  const budget = Math.max(1_024, Math.floor(window * SUMMARY_INPUT_SHARE));
  const batches = batchForSummary(
    renderForSummary(plan.fold, input.build.toolResultMaxChars),
    budget,
    input.ratio,
  );
  let running: string | null =
    plan.priorSummaries.length > 0
      ? plan.priorSummaries.map((s) => partsText(s.parts)).join("\n\n")
      : null;
  let usage: TokenUsage | null = null;
  let chars = 0;
  let truncated = false;
  for (const transcript of batches) {
    const res = await input.summarizer({ priorSummary: running, transcript });
    usage = sumUsage(usage, res.usage);
    chars += (running?.length ?? 0) + transcript.length;
    if (res.finishReason === "length" || res.finishReason === "max_tokens") truncated = true;
    running = res.text;
  }
  if (!running || !running.trim()) {
    throw new CompactionError("The summariser returned an empty summary; nothing was compacted.");
  }
  if (truncated) {
    log.warn("Compaction summary hit its output cap; it is kept and flagged", {
      sessionId: input.sessionId,
    });
  }

  // ── Coverage: the new summary stands in for its prior summaries' ranges too
  const folded = plan.fold;
  const priorFrom = plan.priorSummaries
    .map((s) => s.meta.fromOrdinal)
    .filter((v): v is number => typeof v === "number");
  const priorCount = plan.priorSummaries.reduce(
    (n, s) => n + (typeof s.meta.messageCount === "number" ? s.meta.messageCount : 0),
    0,
  );
  const fromOrdinal = Math.min(...priorFrom, ...folded.map((r) => r.ordinal));
  const toOrdinal = Math.max(...folded.map((r) => r.ordinal));
  const messageCount = priorCount + folded.length;

  const summaryText = running;
  const summaryId = randomUUID();
  const foldIds = [...folded, ...plan.priorSummaries].map((r) => r.id);
  const summaryEstimate = estimateTextTokens(summaryText, input.ratio);

  const keptTokens = plan.keep.reduce(
    (n, r) => n + estimateMessagesTokens(rowMessages(r), input.ratio),
    0,
  );
  const estimatedTokensAfter = input.fixedTokens + summaryEstimate + keptTokens;
  const now = new Date();
  const meta = {
    fromOrdinal,
    toOrdinal,
    messageCount,
    contextWindow: window,
    contextWindowSource: input.contextWindow.source,
    estimatedTokensBefore: input.estimatedTokensBefore,
    estimatedTokensAfter,
    summaryCalls: batches.length,
    ...(truncated ? { summaryTruncated: true } : {}),
    ...(input.force ? { manual: true } : {}),
  };

  for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt++) {
    try {
      const summaryRow = await prisma.$transaction(async (tx) => {
        const marked = await tx.aIMessage.updateMany({
          where: { sessionId: input.sessionId, id: { in: foldIds }, compactedAt: null },
          data: { compactedAt: now, compactedIntoId: summaryId },
        });
        if (marked.count !== foldIds.length) throw new ConcurrentCompaction();
        const ordinal = await nextOrdinal(input.sessionId, tx);
        const row = await tx.aIMessage.create({
          data: {
            id: summaryId,
            ...messageRowData(input.sessionId, ordinal, {
              role: "system",
              kind: "summary",
              parts: [{ type: "text", text: summaryText }],
              estimatedTokens: summaryEstimate,
              usage: usage
                ? {
                    inputTokens: contextInputTokens(input.provider ?? "", usage),
                    outputTokens: usage.completionTokens,
                    cacheReadTokens: usage.cacheReadTokens ?? null,
                    cacheWriteTokens: usage.cacheWriteTokens ?? null,
                  }
                : null,
              promptChars: chars,
              provider: input.provider ?? null,
              model: input.model ?? null,
              finishReason: truncated ? "length" : null,
              meta,
            }),
          },
        });
        await tx.aISession.update({
          where: { id: input.sessionId },
          data: { lastCompactedAt: now, compactionCount: { increment: 1 } },
        });
        return fromRow(row);
      });
      log.info("Compacted conversation", {
        sessionId: input.sessionId,
        compactedMessages: folded.length,
        fromOrdinal,
        toOrdinal,
        estimatedTokensBefore: input.estimatedTokensBefore,
        estimatedTokensAfter,
        contextWindow: window,
        contextWindowSource: input.contextWindow.source,
      });
      return {
        summary: summaryRow,
        compactedMessages: folded.length,
        fromOrdinal,
        toOrdinal,
        estimatedTokensBefore: input.estimatedTokensBefore,
        estimatedTokensAfter,
        contextWindow: window,
        contextWindowSource: input.contextWindow.source,
        activeRows: [summaryRow, ...plan.keep],
      };
    } catch (err) {
      if (err instanceof ConcurrentCompaction) {
        log.info("Another request compacted this conversation first", {
          sessionId: input.sessionId,
        });
        return null;
      }
      if ((err as { code?: unknown }).code !== "P2002") throw err;
    }
  }
  throw new CompactionError("Could not allocate a transcript position for the summary.");
}

class ConcurrentCompaction extends Error {}

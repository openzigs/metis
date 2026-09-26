/**
 * Epic #127 / #136 — the server-owned chat transcript (`ai_messages`).
 *
 * The browser used to hold the conversation and resend it every turn; the
 * server trusted whatever history arrived, so a client could forge an earlier
 * assistant reply or tool result. This store is now the ONLY source of prior
 * turns: the chat routes append the new user message here, read history back
 * from here, and append the reply here.
 *
 * Nothing in this module deletes a row. Compaction (#138) marks rows
 * `compactedAt` and adds a summary row; the originals stay readable.
 */
import { randomUUID } from "node:crypto";
import type { AIMessage, Prisma } from "@prisma/client";
import type {
  TranscriptKind,
  TranscriptMessageDto,
  TranscriptPart,
  TranscriptRole,
} from "@metis/shared";
import { prisma } from "../../prisma.js";

export type { TranscriptPart };

/** A row with its JSON columns parsed. */
export interface StoredMessage {
  id: string;
  sessionId: string;
  ordinal: number;
  role: TranscriptRole;
  kind: TranscriptKind;
  parts: TranscriptPart[];
  estimatedTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  promptChars: number | null;
  provider: string | null;
  model: string | null;
  finishReason: string | null;
  compactedAt: Date | null;
  compactedIntoId: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

/** Provider-reported usage for the call that produced a row. */
export interface RowUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface AppendMessageInput {
  role: TranscriptRole;
  kind?: TranscriptKind;
  parts: TranscriptPart[];
  estimatedTokens: number;
  usage?: RowUsage | null;
  promptChars?: number | null;
  provider?: string | null;
  model?: string | null;
  finishReason?: string | null;
  meta?: Record<string, unknown> | null;
}

/** How many times an append retries after losing an ordinal race. */
const MAX_ORDINAL_ATTEMPTS = 5;

type Db = Pick<Prisma.TransactionClient, "aIMessage">;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

function parseParts(raw: string): TranscriptPart[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as TranscriptPart[]) : [];
  } catch {
    // A corrupt row must still render: surface it as text rather than hiding it.
    return [{ type: "text", text: raw }];
  }
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function fromRow(row: AIMessage): StoredMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ordinal: row.ordinal,
    role: row.role as TranscriptRole,
    kind: row.kind as TranscriptKind,
    parts: parseParts(row.content),
    estimatedTokens: row.estimatedTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    promptChars: row.promptChars,
    provider: row.provider,
    model: row.model,
    finishReason: row.finishReason,
    compactedAt: row.compactedAt,
    compactedIntoId: row.compactedIntoId,
    meta: parseMeta(row.meta),
    createdAt: row.createdAt,
  };
}

/** The plain text of a row: its `text` parts, joined. Tool parts excluded. */
export function partsText(parts: readonly TranscriptPart[]): string {
  return parts
    .filter((p): p is Extract<TranscriptPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function messageRowData(sessionId: string, ordinal: number, input: AppendMessageInput) {
  return {
    sessionId,
    ordinal,
    role: input.role,
    kind: input.kind ?? "message",
    content: JSON.stringify(input.parts),
    estimatedTokens: Math.max(0, Math.round(input.estimatedTokens)),
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    cacheReadTokens: input.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
    promptChars: input.promptChars ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    finishReason: input.finishReason ?? null,
    meta: input.meta && Object.keys(input.meta).length > 0 ? JSON.stringify(input.meta) : null,
  };
}

/** The next free ordinal in a session (1-based). */
export async function nextOrdinal(sessionId: string, db: Db = prisma): Promise<number> {
  const last = await db.aIMessage.findFirst({
    where: { sessionId },
    orderBy: { ordinal: "desc" },
    select: { ordinal: true },
  });
  return (last?.ordinal ?? 0) + 1;
}

/**
 * Append one message at the end of a session's transcript. Two concurrent
 * appends race for the same ordinal; the loser hits the `(sessionId, ordinal)`
 * unique index and retries at the next one, so neither message is lost.
 */
export async function appendMessage(
  sessionId: string,
  input: AppendMessageInput,
  db: Db = prisma,
): Promise<StoredMessage> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ORDINAL_ATTEMPTS; attempt++) {
    const ordinal = await nextOrdinal(sessionId, db);
    try {
      const row = await db.aIMessage.create({ data: messageRowData(sessionId, ordinal, input) });
      return fromRow(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Every row of a session, compacted ones included, in ordinal order. */
export async function listMessages(sessionId: string, db: Db = prisma): Promise<StoredMessage[]> {
  const rows = await db.aIMessage.findMany({
    where: { sessionId },
    orderBy: { ordinal: "asc" },
  });
  return rows.map(fromRow);
}

/** The rows the model still sees: everything not folded into a summary. */
export async function listActiveMessages(
  sessionId: string,
  db: Db = prisma,
): Promise<StoredMessage[]> {
  const rows = await db.aIMessage.findMany({
    where: { sessionId, compactedAt: null },
    orderBy: { ordinal: "asc" },
  });
  return rows.map(fromRow);
}

export async function getMessageByOrdinal(
  sessionId: string,
  ordinal: number,
  db: Db = prisma,
): Promise<StoredMessage | null> {
  const row = await db.aIMessage.findUnique({
    where: { sessionId_ordinal: { sessionId, ordinal } },
  });
  return row ? fromRow(row) : null;
}

export async function countMessages(sessionId: string, db: Db = prisma): Promise<number> {
  return db.aIMessage.count({ where: { sessionId } });
}

/**
 * #139 — copy rows `1..fromOrdinal` of `sourceSessionId` into `targetSessionId`
 * with the SAME ordinals, so "turn N" means the same turn in both. Compaction
 * state is carried over: a summary at or before the fork point still stands in
 * for the rows it folded, which are copied too (their `compactedIntoId` is
 * re-pointed at the copied summary). A summary AFTER the fork point is not
 * copied, so rows it folded are copied as un-compacted — the fork sees them in
 * full, exactly as the source did at that turn.
 */
export async function copyTranscriptPrefix(
  sourceSessionId: string,
  targetSessionId: string,
  fromOrdinal: number,
  db: Db = prisma,
): Promise<number> {
  const rows = await db.aIMessage.findMany({
    where: { sessionId: sourceSessionId, ordinal: { lte: fromOrdinal } },
    orderBy: { ordinal: "asc" },
  });
  const idMap = new Map<string, string>(rows.map((r) => [r.id, randomUUID()]));
  const copied = rows.map((r) => {
    const summaryCopied = r.compactedIntoId !== null && idMap.has(r.compactedIntoId);
    return {
      id: idMap.get(r.id)!,
      sessionId: targetSessionId,
      ordinal: r.ordinal,
      role: r.role,
      kind: r.kind,
      content: r.content,
      estimatedTokens: r.estimatedTokens,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      promptChars: r.promptChars,
      provider: r.provider,
      model: r.model,
      finishReason: r.finishReason,
      compactedAt: summaryCopied ? r.compactedAt : null,
      compactedIntoId: summaryCopied ? idMap.get(r.compactedIntoId!)! : null,
      meta: r.meta,
      createdAt: r.createdAt,
    };
  });
  // Insert one by one: `createMany` is fine on Postgres, but keeping to plain
  // `create` keeps the unit fakes honest about what the store relies on.
  for (const data of copied) {
    await db.aIMessage.create({ data });
  }
  return copied.length;
}

// ── DTO ────────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function toDto(m: StoredMessage): TranscriptMessageDto {
  const summary = m.kind === "summary" ? m.meta : null;
  const from = num(summary?.fromOrdinal);
  const to = num(summary?.toOrdinal);
  const count = num(summary?.messageCount);
  const error = m.meta.error as { code?: unknown; message?: unknown } | undefined;
  return {
    id: m.id,
    ordinal: m.ordinal,
    role: m.role,
    kind: m.kind,
    parts: m.parts,
    tokens: {
      estimated: m.estimatedTokens,
      input: m.inputTokens,
      output: m.outputTokens,
      cacheRead: m.cacheReadTokens,
      cacheWrite: m.cacheWriteTokens,
    },
    provider: m.provider,
    model: m.model,
    finishReason: m.finishReason,
    compactedAt: m.compactedAt ? m.compactedAt.toISOString() : null,
    compactedIntoId: m.compactedIntoId,
    summaryOf:
      from !== null && to !== null && count !== null
        ? {
            fromOrdinal: from,
            toOrdinal: to,
            messageCount: count,
            ...(summary?.summaryTruncated === true ? { truncated: true } : {}),
          }
        : null,
    incomplete:
      error && typeof error.code === "string"
        ? { code: error.code, message: typeof error.message === "string" ? error.message : "" }
        : null,
    createdAt: m.createdAt.toISOString(),
  };
}

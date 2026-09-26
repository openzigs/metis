/**
 * Epic #127 — an in-memory stand-in for `prisma.aIMessage`, for route tests
 * that mock Prisma wholesale.
 *
 * It implements exactly the calls the transcript store makes, with the
 * behaviour those calls rely on — including the `(sessionId, ordinal)` unique
 * index (a duplicate throws Prisma's `P2002`), so an ordinal race is
 * reproducible. The real-database proof of the same store is
 * `tests/ai-conversation.sqlite.test.ts`; this fake is for everything else.
 */
import { randomUUID } from "node:crypto";

export interface FakeAiMessageRow {
  id: string;
  sessionId: string;
  ordinal: number;
  role: string;
  kind: string;
  content: string;
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
  meta: string | null;
  createdAt: Date;
}

type Where = Record<string, unknown>;

function matches(row: FakeAiMessageRow, where: Where = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond === null) {
      if (value !== null) return false;
    } else if (cond instanceof Date || typeof cond !== "object") {
      if (value !== cond) return false;
    } else {
      const c = cond as { in?: unknown[]; lte?: number; gte?: number; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      if (c.lte !== undefined && !((value as number) <= c.lte)) return false;
      if (c.gte !== undefined && !((value as number) >= c.gte)) return false;
      if ("not" in c && value === c.not) return false;
    }
  }
  return true;
}

function sortRows(
  rows: FakeAiMessageRow[],
  orderBy?: { ordinal?: "asc" | "desc" },
): FakeAiMessageRow[] {
  if (!orderBy?.ordinal) return rows;
  const dir = orderBy.ordinal === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => (a.ordinal - b.ordinal) * dir);
}

export function createFakeAiMessageDelegate(rows: FakeAiMessageRow[]) {
  const uniqueViolation = (): Error =>
    Object.assign(new Error("Unique constraint failed on (sessionId, ordinal)"), { code: "P2002" });
  return {
    async create({ data }: { data: Partial<FakeAiMessageRow> }): Promise<FakeAiMessageRow> {
      if (rows.some((r) => r.sessionId === data.sessionId && r.ordinal === data.ordinal)) {
        throw uniqueViolation();
      }
      const row: FakeAiMessageRow = {
        id: data.id ?? randomUUID(),
        sessionId: data.sessionId!,
        ordinal: data.ordinal!,
        role: data.role!,
        kind: data.kind ?? "message",
        content: data.content!,
        estimatedTokens: data.estimatedTokens ?? 0,
        inputTokens: data.inputTokens ?? null,
        outputTokens: data.outputTokens ?? null,
        cacheReadTokens: data.cacheReadTokens ?? null,
        cacheWriteTokens: data.cacheWriteTokens ?? null,
        promptChars: data.promptChars ?? null,
        provider: data.provider ?? null,
        model: data.model ?? null,
        finishReason: data.finishReason ?? null,
        compactedAt: data.compactedAt ?? null,
        compactedIntoId: data.compactedIntoId ?? null,
        meta: data.meta ?? null,
        createdAt: data.createdAt ?? new Date(),
      };
      rows.push(row);
      return { ...row };
    },
    async findFirst({ where, orderBy }: { where?: Where; orderBy?: { ordinal?: "asc" | "desc" } }) {
      const hit = sortRows(
        rows.filter((r) => matches(r, where)),
        orderBy,
      )[0];
      return hit ? { ...hit } : null;
    },
    async findMany({
      where,
      orderBy,
    }: { where?: Where; orderBy?: { ordinal?: "asc" | "desc" } } = {}) {
      return sortRows(
        rows.filter((r) => matches(r, where)),
        orderBy,
      ).map((r) => ({ ...r }));
    },
    async findUnique({
      where,
    }: {
      where: { id?: string; sessionId_ordinal?: { sessionId: string; ordinal: number } };
    }) {
      const hit = where.sessionId_ordinal
        ? rows.find(
            (r) =>
              r.sessionId === where.sessionId_ordinal!.sessionId &&
              r.ordinal === where.sessionId_ordinal!.ordinal,
          )
        : rows.find((r) => r.id === where.id);
      return hit ? { ...hit } : null;
    },
    async count({ where }: { where?: Where } = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async updateMany({ where, data }: { where?: Where; data: Partial<FakeAiMessageRow> }) {
      let count = 0;
      for (const r of rows) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    },
  };
}

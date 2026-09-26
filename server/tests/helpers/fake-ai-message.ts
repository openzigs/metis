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
      const c = cond as { in?: unknown[]; lte?: number; gte?: number; gt?: number; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      if (c.lte !== undefined && !((value as number) <= c.lte)) return false;
      if (c.gt !== undefined && !((value as number) > c.gt)) return false;
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

function pick(row: FakeAiMessageRow, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, on] of Object.entries(select)) {
    if (on) out[k] = (row as unknown as Record<string, unknown>)[k];
  }
  return out;
}

export function createFakeAiMessageDelegate(rows: FakeAiMessageRow[]) {
  const uniqueViolation = (): Error =>
    Object.assign(new Error("Unique constraint failed on (sessionId, ordinal)"), { code: "P2002" });
  const toRow = (data: Partial<FakeAiMessageRow>): FakeAiMessageRow => ({
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
  });
  const clashes = (
    a: { sessionId?: string; ordinal?: number },
    b: { sessionId?: string; ordinal?: number },
  ) => a.sessionId === b.sessionId && a.ordinal === b.ordinal;
  return {
    async create({ data }: { data: Partial<FakeAiMessageRow> }): Promise<FakeAiMessageRow> {
      if (rows.some((r) => clashes(r, data))) throw uniqueViolation();
      const row = toRow(data);
      rows.push(row);
      return { ...row };
    },
    /**
     * #212 — one statement: a `(sessionId, ordinal)` clash with a stored row OR
     * within the batch fails the whole insert and writes nothing, as a single
     * multi-row INSERT does on both SQLite and Postgres (no `skipDuplicates`).
     */
    async createMany({ data }: { data: Array<Partial<FakeAiMessageRow>> }) {
      for (let i = 0; i < data.length; i++) {
        const d = data[i]!;
        if (rows.some((r) => clashes(r, d)) || data.slice(0, i).some((e) => clashes(e, d))) {
          throw uniqueViolation();
        }
      }
      rows.push(...data.map(toRow));
      return { count: data.length };
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
      take,
      select,
    }: {
      where?: Where;
      orderBy?: { ordinal?: "asc" | "desc" };
      take?: number;
      select?: Record<string, boolean>;
    } = {}) {
      const sorted = sortRows(
        rows.filter((r) => matches(r, where)),
        orderBy,
      );
      return (take === undefined ? sorted : sorted.slice(0, take)).map((r) => pick(r, select));
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

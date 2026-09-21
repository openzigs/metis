/**
 * Epic #298 / Issue #310 — `who_calls` MCP tool.
 *
 * Given a qualified `symbol`, list every callsite. Supports cursor pagination:
 * pass `cursor` from a prior response's `nextCursor` to continue.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

export const whoCallsSchema = z.object({
  symbol: z.string().min(1).max(1024),
  projectId: z.string().min(1),
  pageSize: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type WhoCallsInput = z.infer<typeof whoCallsSchema>;

export interface WhoCallsHit {
  filePath: string;
  line: number;
  callerSymbol: string;
}
export interface WhoCallsResult {
  callers: WhoCallsHit[];
  nextCursor: string | null;
}

type WhoCallsPrisma = Pick<PrismaClient, "codeSymbol" | "codeEdge">;

export async function whoCalls(prisma: WhoCallsPrisma, rawInput: unknown): Promise<WhoCallsResult> {
  const input = whoCallsSchema.parse(rawInput);

  // Resolve the symbol → id. Ambiguous names (multiple matches) all count.
  const targets = await prisma.codeSymbol.findMany({
    where: { projectId: input.projectId, qualifiedName: input.symbol },
    select: { id: true },
  });

  // Even if no matching symbol, the unresolved-edge path may still yield hits
  // (e.g. external symbols recorded only as `toQualifiedName`).
  const targetIds = targets.map((t) => t.id);

  const edges = await prisma.codeEdge.findMany({
    where: {
      projectId: input.projectId,
      kind: { in: ["calls", "references"] },
      OR: [
        targetIds.length > 0 ? { toSymbolId: { in: targetIds } } : undefined,
        { toQualifiedName: input.symbol },
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
    },
    select: {
      id: true,
      filePath: true,
      line: true,
      fromSymbol: { select: { qualifiedName: true } },
    },
    orderBy: { id: "asc" },
    take: input.pageSize + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const hasMore = edges.length > input.pageSize;
  const page = hasMore ? edges.slice(0, input.pageSize) : edges;

  return {
    callers: page.map((e) => ({
      filePath: e.filePath,
      line: e.line,
      callerSymbol: e.fromSymbol.qualifiedName,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

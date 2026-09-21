/**
 * Epic #298 / Issue #310 — `defined_in` MCP tool.
 *
 * Resolve a qualified `symbol` to `{ filePath, line }` or `null`.
 * Returns `null` (not an error) for unknown symbols.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

export const definedInSchema = z.object({
  symbol: z.string().min(1).max(1024),
  projectId: z.string().min(1),
});
export type DefinedInInput = z.infer<typeof definedInSchema>;

export type DefinedInResult = { filePath: string; line: number } | null;

type DefinedInPrisma = Pick<PrismaClient, "codeSymbol">;

export async function definedIn(
  prisma: DefinedInPrisma,
  rawInput: unknown,
): Promise<DefinedInResult> {
  const input = definedInSchema.parse(rawInput);

  const hit = await prisma.codeSymbol.findFirst({
    where: { projectId: input.projectId, qualifiedName: input.symbol },
    select: { filePath: true, startLine: true },
    orderBy: { startLine: "asc" },
  });

  if (!hit) return null;
  return { filePath: hit.filePath, line: hit.startLine };
}

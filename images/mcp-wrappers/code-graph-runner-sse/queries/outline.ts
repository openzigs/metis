/**
 * Epic #298 / Issue #310 — `outline` MCP tool.
 *
 * Flat list of symbols defined in `file`, ordered by start line.
 * Returns an empty list (not an error) for unknown files.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

export const outlineSchema = z.object({
  file: z.string().min(1).max(1024),
  projectId: z.string().min(1),
});
export type OutlineInput = z.infer<typeof outlineSchema>;

export interface OutlineEntry {
  name: string;
  kind: string;
  qualifiedName: string;
  line: number;
}

export type OutlineResult = OutlineEntry[];

type OutlinePrisma = Pick<PrismaClient, "codeSymbol">;

export async function outline(prisma: OutlinePrisma, rawInput: unknown): Promise<OutlineResult> {
  const input = outlineSchema.parse(rawInput);

  const rows = await prisma.codeSymbol.findMany({
    where: { projectId: input.projectId, filePath: input.file },
    select: { name: true, kind: true, qualifiedName: true, startLine: true },
    orderBy: { startLine: "asc" },
  });

  return rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    qualifiedName: r.qualifiedName,
    line: r.startLine,
  }));
}

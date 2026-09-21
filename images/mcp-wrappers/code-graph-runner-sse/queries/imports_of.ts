/**
 * Epic #298 / Issue #310 — `imports_of` MCP tool.
 *
 * For a given `file`, return:
 *   - outbound: every import edge whose `filePath === file` (what the file imports)
 *   - inbound:  every import edge whose target symbol's filePath === file (what imports the file)
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

export const importsOfSchema = z.object({
  file: z.string().min(1).max(1024),
  projectId: z.string().min(1),
});
export type ImportsOfInput = z.infer<typeof importsOfSchema>;

export interface ImportEdgeView {
  fromFile: string;
  toQualifiedName: string;
  line: number;
  typeOnly: boolean;
}
export interface ImportsOfResult {
  outbound: ImportEdgeView[];
  inbound: ImportEdgeView[];
}

type ImportsOfPrisma = Pick<PrismaClient, "codeEdge" | "codeSymbol">;

function parseTypeOnly(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "typeOnly" in parsed &&
      (parsed as { typeOnly: unknown }).typeOnly === true
    );
  } catch {
    return false;
  }
}

export async function importsOf(
  prisma: ImportsOfPrisma,
  rawInput: unknown,
): Promise<ImportsOfResult> {
  const input = importsOfSchema.parse(rawInput);

  const outboundEdges = await prisma.codeEdge.findMany({
    where: { projectId: input.projectId, kind: "imports", filePath: input.file },
    select: {
      filePath: true,
      toQualifiedName: true,
      toSymbol: { select: { qualifiedName: true, filePath: true } },
      line: true,
      metadata: true,
    },
    orderBy: { line: "asc" },
  });

  const symbolsInFile = await prisma.codeSymbol.findMany({
    where: { projectId: input.projectId, filePath: input.file },
    select: { id: true },
  });
  const symbolIds = symbolsInFile.map((s) => s.id);

  const inboundEdges =
    symbolIds.length === 0
      ? []
      : await prisma.codeEdge.findMany({
          where: {
            projectId: input.projectId,
            kind: "imports",
            toSymbolId: { in: symbolIds },
          },
          select: {
            filePath: true,
            toSymbol: { select: { qualifiedName: true } },
            line: true,
            metadata: true,
          },
          orderBy: { filePath: "asc" },
        });

  return {
    outbound: outboundEdges.map((e) => ({
      fromFile: e.filePath,
      toQualifiedName: e.toSymbol?.qualifiedName ?? e.toQualifiedName ?? "<unresolved>",
      line: e.line,
      typeOnly: parseTypeOnly(e.metadata),
    })),
    inbound: inboundEdges.map((e) => ({
      fromFile: e.filePath,
      toQualifiedName: e.toSymbol?.qualifiedName ?? "<unresolved>",
      line: e.line,
      typeOnly: parseTypeOnly(e.metadata),
    })),
  };
}

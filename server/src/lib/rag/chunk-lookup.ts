/**
 * #2240 — read knowledge chunks back by id, for the excerpts a chat answer
 * cited to stay available on the next turn.
 *
 * The excerpt is read again rather than replayed from the transcript, so what
 * the next turn sees is what the project holds NOW: a chunk whose document was
 * deleted or re-ingested is simply gone, and one whose ACL no longer admits the
 * requester is dropped exactly as `KnowledgeService.search` would drop it
 * (#157, #2225). The read is scoped to the project as well as the ids, so an id
 * from another project returns nothing.
 */
import { repoDocumentPath, type RetrievedChunk } from "@metis/shared";
import { prisma } from "../prisma.js";
import { asDocumentSource } from "../documents/document-source.js";
import { readDerivedLabel } from "./derived-label.js";
import { type AclActor, filterAccessible, parseAclSubjects } from "./acl.js";

/** The chunks of `projectId` with these ids that `actor` may read, in the ids' order. */
export async function loadChunksById(
  projectId: string,
  chunkIds: readonly string[],
  actor: AclActor,
): Promise<RetrievedChunk[]> {
  const ids = [...new Set(chunkIds)];
  if (ids.length === 0) return [];
  const rows = await prisma.knowledgeChunk.findMany({
    // A soft-deleted document's excerpts are not brought back.
    where: { id: { in: ids }, projectId, document: { deletedAt: null } },
    select: {
      id: true,
      documentId: true,
      position: true,
      text: true,
      embeddingModel: true,
      metadata: true,
      aclSubjects: true,
      document: { select: { filename: true, source: true } },
    },
  });
  const { allowed } = filterAccessible(
    rows.map((r) => ({ ...r, chunkId: r.id, aclSubjects: parseAclSubjects(r.aclSubjects) })),
    actor,
  );
  const byId = new Map(allowed.map((r) => [r.chunkId, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => {
      const source = asDocumentSource(r.document.source);
      const path = source === "repo" ? repoDocumentPath(r.document.filename) : undefined;
      const derived = readDerivedLabel(r.metadata, r.document.source);
      return {
        chunkId: r.chunkId,
        documentId: r.documentId,
        filename: r.document.filename,
        position: r.position,
        text: r.text,
        score: 0,
        embeddingModel: r.embeddingModel,
        source,
        ...(path ? { path } : {}),
        ...(derived ? { derived } : {}),
      };
    });
}

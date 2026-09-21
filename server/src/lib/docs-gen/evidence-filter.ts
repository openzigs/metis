/** SQL-authoritative primary evidence gate, before search reranking (#1353). */
import { prisma } from "../prisma.js";
import { isVisibleTo, parseAclSubjects } from "../rag/acl.js";
import { assertEvidencePolicy, type EvidencePolicy } from "./evidence-policy.js";

export interface EvidenceCandidate {
  chunkId: string;
  documentId: string;
  filename: string;
  text: string;
}

export async function filterPrimaryEvidence<T extends EvidenceCandidate>(
  candidates: T[],
  policy: EvidencePolicy,
): Promise<T[]> {
  assertEvidencePolicy(policy, policy.projectId);
  if (candidates.length === 0) return [];
  const rows = await prisma.knowledgeChunk.findMany({
    where: {
      id: { in: candidates.map((c) => c.chunkId) },
      projectId: policy.projectId,
      document: { projectId: policy.projectId, deletedAt: null, indexState: "indexed" },
    },
    select: {
      id: true,
      documentId: true,
      text: true,
      metadata: true,
      chunkerIdentity: true,
      aclSubjects: true,
      document: { select: { filename: true, storagePath: true, aclSubjects: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const allowed: T[] = [];
  for (const candidate of candidates) {
    const row = byId.get(candidate.chunkId);
    if (!row || row.documentId !== candidate.documentId) continue;
    let metadata: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.metadata ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      metadata = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    // Exclude ALL generated evidence, including legacy producers and the current
    // artifact. An explicit shared-reference allowlist cannot override this.
    if (
      row.documentId === `gendoc-${policy.generatedDocumentId}` ||
      row.documentId.startsWith("gendoc-") ||
      row.document.storagePath.startsWith("generated/") ||
      row.chunkerIdentity?.startsWith("docsgen:") ||
      metadata.source === "generated-doc" ||
      typeof metadata.generatedDocumentId === "string"
    )
      continue;
    const filename = row.document.filename;
    const repoPrefix = "connector:repo:";
    const repoId = filename.startsWith(repoPrefix)
      ? filename.slice(repoPrefix.length).split(":")[0]
      : undefined;
    if (policy.repoConnectorId) {
      if (
        repoId
          ? repoId !== policy.repoConnectorId
          : !policy.sharedDocumentIds.includes(row.documentId)
      )
        continue;
    }
    // Both live ACLs must allow the actor. A malformed ACL is NOT unrestricted.
    if (![row.aclSubjects, row.document.aclSubjects].every((raw) => visible(raw, policy))) continue;
    allowed.push({ ...candidate, filename, text: row.text });
  }
  return allowed;
}

function visible(raw: string, policy: EvidencePolicy): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    const subjects = parseAclSubjects(parsed);
    if (subjects.length !== parsed.length) return false;
    return isVisibleTo({ subjects }, policy.actor);
  } catch {
    return false;
  }
}

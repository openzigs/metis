/**
 * Seed a GeneratedDocument plus its synthetic Document row directly into the
 * e2e SQLite database so Playwright specs can exercise deterministic lifecycle
 * states without relying on background generation/publication timing.
 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import { prisma } from "../src/lib/prisma.js";
import { generatedDocRevisionId } from "../src/lib/docs-gen/generated-doc-provenance.js";

type GenerationStatus = "pending" | "generating" | "ready" | "degraded" | "failed";
type IndexState = "pending" | "quarantined" | "indexed" | "rejected";

function buildSeededManifest(
  projectId: string,
  generatedDocumentId: string,
  title: string,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision: {
      revisionId: generatedDocRevisionId({
        projectId,
        generatedDocumentId,
        version: 1,
      }),
      projectId,
      generatedDocumentId,
      version: 1,
    },
    document: {
      title,
      scope: "full",
      docType: "business-requirements",
      generatedAt: new Date().toISOString(),
    },
    policy: {
      sharedDocumentIds: [],
      allowWebResearch: false,
    },
    generation: {
      pipeline: "holistic",
      model: {
        phase1: { model: "e2e-seeded" },
        phase2: { model: "e2e-seeded" },
        claim: { model: "e2e-seeded" },
        judge: { model: "e2e-seeded" },
      },
      prompts: {
        phase1: { version: 0 },
        phase2: { mode: "single" },
      },
    },
    graphFingerprint: {
      algorithm: "sha256",
      status: "unknown",
      fingerprint: null,
    },
    sourceFingerprints: [],
    selectedEvidence: {
      primary: [],
    },
    sections: [],
    historicalCitations: {
      status: "unknown",
      mode: "legacy-unknown",
    },
    legacy: {
      historicalCitations: "legacy-unknown",
    },
  });
}

function usage(): never {
  process.stderr.write(
    [
      "usage: pnpm --filter @metis/server exec tsx server/scripts/e2e-seed-generated-doc.ts",
      "  <projectId> <uploadedById> <title> <generationStatus> <indexState>",
      "  [errorMessage] [warningJson] [content]",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [
    ,
    ,
    projectId,
    uploadedById,
    title,
    generationStatus,
    indexState,
    errorMessageArg,
    warningJsonArg,
    contentArg,
  ] = process.argv;
  if (!projectId || !uploadedById || !title || !generationStatus || !indexState) usage();

  const status = generationStatus as GenerationStatus;
  const syntheticState = indexState as IndexState;
  const content =
    contentArg && contentArg !== "-"
      ? contentArg
      : `# ${title}\n\nSeeded lifecycle content for ${title}.`;

  const doc = await prisma.generatedDocument.create({
    data: {
      projectId,
      title,
      scope: "full",
      status,
      content,
      errorMessage: errorMessageArg && errorMessageArg !== "-" ? errorMessageArg : null,
      warnings:
        warningJsonArg && warningJsonArg !== "-"
          ? JSON.parse(warningJsonArg)
          : status === "degraded"
            ? [
                {
                  kind: "section-ungrounded",
                  section: "Overview",
                  message: "One section requires verification.",
                  severity: "warning",
                  ratio: 0.62,
                  threshold: 0.8,
                  tier: "literal",
                },
              ]
            : null,
      generatedAt: status === "ready" || status === "degraded" ? new Date() : null,
    },
  });

  await prisma.generatedDocumentVersion.create({
    data: {
      documentId: doc.id,
      version: 1,
      revisionId: generatedDocRevisionId({
        projectId,
        generatedDocumentId: doc.id,
        version: 1,
      }),
      provenanceManifest: buildSeededManifest(projectId, doc.id, title),
      content,
      diffSummary: "Full generation",
      changedSymbols: "[]",
    },
  });

  await prisma.document.create({
    data: {
      id: `gendoc-${doc.id}`,
      projectId,
      filename: `generated/${doc.id}.md`,
      mimeType: "text/markdown",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storagePath: `generated/${doc.id}.md`,
      checksum: randomUUID().replace(/-/g, ""),
      status: syntheticState === "indexed" ? "ready" : "processing",
      indexState: syntheticState,
      errorMessage:
        syntheticState === "rejected"
          ? errorMessageArg && errorMessageArg !== "-"
            ? errorMessageArg
            : "Synthetic indexing rejection"
          : null,
      chunkCount: syntheticState === "indexed" ? 6 : 0,
      processedAt: syntheticState === "indexed" ? new Date() : null,
      uploadedById,
    },
  });

  process.stdout.write(
    JSON.stringify({ id: doc.id, title, generationStatus: status, indexState: syntheticState }),
  );
}

main()
  .catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

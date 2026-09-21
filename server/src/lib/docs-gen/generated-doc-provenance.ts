import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvidencePolicy } from "./evidence-policy.js";
import type { DocType } from "./holistic-synthesizer.js";
import type { GroundingSource } from "./grounding/grounding-context.js";
import type { RepositoryIdentity } from "./repository-identity.js";
import type { DocsGenTuning, Phase2Router } from "./holistic-synthesizer.js";
import { generationInputSnapshotSchema } from "./regeneration-plan.js";
import { sectionSynthesisSchema, type SectionSynthesis } from "./section-reuse.js";

export const GENERATED_DOC_PROVENANCE_SCHEMA_VERSION = 1;

export interface GeneratedDocRevisionKey {
  projectId: string;
  generatedDocumentId: string;
  version: number;
}

export function generatedDocRevisionId(input: GeneratedDocRevisionKey): string {
  return `gendoc:${input.projectId}:${input.generatedDocumentId}:v${input.version}`;
}

export type HistoricalCitationStatus = "available" | "unavailable" | "unknown";
export type HistoricalCitationMode =
  | "approved-evidence-only"
  | "stored-evidence-pending"
  | "not-retained"
  | "legacy-unknown";
export type LegacyHistoricalCitationState =
  | "versioned"
  | "pending"
  | "not-retained"
  | "legacy-unknown";

const repositoryIdentitySchema = z
  .object({
    codeGraphId: z.string().min(1),
    repoConnectorId: z.string().min(1).nullable(),
  })
  .strict();

const sourceFingerprintSchema = z
  .object({
    kind: z.enum(["repository-graph", "project-scope", "database-schema"]),
    repoConnectorId: z.string().min(1).nullable(),
    codeGraphId: z.string().min(1).nullable(),
    dbConnectorId: z.string().min(1).nullable().optional(),
    commitSha: z.string().min(1).nullable().optional(),
    sourceFingerprint: z.string().min(1),
  })
  .strict();

const selectedEvidenceRowSchema = z
  .object({
    sourceId: z.string().min(1),
    kind: z.enum(["rag", "web", "facts"]),
    label: z.string().min(1),
    evidenceClass: z.enum(["repository-source", "project-reference", "web-reference"]).nullable(),
    documentId: z.string().min(1).optional(),
    chunkId: z.string().min(1).optional(),
    repository: repositoryIdentitySchema.optional(),
    filePath: z.string().min(1).optional(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    contentHash: z.string().min(1),
  })
  .strict();

const statuslessGraphFingerprintSchema = z
  .object({
    algorithm: z.literal("sha256"),
    fingerprint: z.string().min(1),
  })
  .strict();

const sectionManifestSchema = z
  .object({
    sectionSlug: z.string().min(1),
    sectionLabel: z.string().min(1),
    sectionIndex: z.number().int().min(0),
    providerKind: z.enum(["bedrock", "local", "anthropic"]),
    model: z.string().min(1),
    factsSourceIds: z.array(z.string().min(1)),
    groundingSourceIds: z.array(z.string().min(1)),
  })
  .strict();

const provenanceManifestSchema = z
  .object({
    schemaVersion: z.literal(GENERATED_DOC_PROVENANCE_SCHEMA_VERSION),
    revision: z
      .object({
        revisionId: z.string().min(1),
        projectId: z.string().min(1),
        generatedDocumentId: z.string().min(1),
        version: z.number().int().min(1),
      })
      .strict(),
    document: z
      .object({
        title: z.string().min(1),
        scope: z.string().min(1),
        docType: z.enum(["business-requirements", "architecture", "user-guide"]).nullable(),
        generatedAt: z.string().datetime(),
      })
      .strict(),
    policy: z
      .object({
        repoConnectorId: z.string().min(1).optional(),
        codeGraphId: z.string().min(1).optional(),
        sharedDocumentIds: z.array(z.string().min(1)),
        allowWebResearch: z.boolean(),
      })
      .strict(),
    generation: z
      .object({
        pipeline: z.enum([
          "holistic",
          "incremental-discovery",
          "discovery-agent",
          "database-schema",
        ]),
        model: z
          .object({
            phase1: z.object({ model: z.string().min(1) }).strict(),
            phase2: z.object({ model: z.string().min(1) }).strict(),
            claim: z.object({ model: z.string().min(1) }).strict(),
            judge: z.object({ model: z.string().min(1) }).strict(),
          })
          .strict(),
        prompts: z
          .object({
            phase1: z.object({ version: z.number().int().min(0) }).strict(),
            phase2: z.object({ mode: z.enum(["single", "hybrid"]) }).strict(),
          })
          .strict(),
      })
      .strict(),
    graphFingerprint: z
      .object({
        algorithm: z.literal("sha256"),
        status: z.enum(["available", "unknown"]),
        fingerprint: z.string().min(1).nullable(),
      })
      .strict(),
    sourceFingerprints: z.array(sourceFingerprintSchema),
    selectedEvidence: z
      .object({
        primary: z.array(selectedEvidenceRowSchema),
      })
      .strict(),
    sections: z.array(sectionManifestSchema),
    sectionSynthesis: sectionSynthesisSchema.optional(),
    inputSnapshot: generationInputSnapshotSchema.optional(),
    regeneration: z
      .discriminatedUnion("mode", [
        z
          .object({ mode: z.literal("full"), reason: z.string(), changed: z.array(z.string()) })
          .strict(),
        z
          .object({
            mode: z.literal("sections"),
            changed: z.array(z.string()),
            sections: z.array(z.string()),
          })
          .strict(),
        z.object({ mode: z.literal("unchanged"), changed: z.array(z.string()) }).strict(),
      ])
      .optional(),
    historicalCitations: z
      .object({
        status: z.enum(["available", "unavailable", "unknown"]),
        mode: z.enum([
          "approved-evidence-only",
          "stored-evidence-pending",
          "not-retained",
          "legacy-unknown",
        ]),
      })
      .strict(),
    legacy: z
      .object({
        historicalCitations: z.enum(["versioned", "pending", "not-retained", "legacy-unknown"]),
      })
      .strict(),
  })
  .strict();

const graphlessCurrentSchemaV1ManifestSchema = provenanceManifestSchema.omit({
  graphFingerprint: true,
});

const statuslessCurrentSchemaV1ManifestSchema = provenanceManifestSchema
  .omit({ graphFingerprint: true })
  .extend({ graphFingerprint: statuslessGraphFingerprintSchema });

const legacySchemaV1ManifestSchema = provenanceManifestSchema
  .omit({ generation: true, historicalCitations: true, legacy: true, graphFingerprint: true })
  .extend({
    generation: z
      .object({
        model: z
          .object({
            phase1: z.object({ model: z.string().min(1) }).strict(),
            phase2: z.object({ model: z.string().min(1) }).strict(),
            claim: z.object({ model: z.string().min(1) }).strict(),
            judge: z.object({ model: z.string().min(1) }).strict(),
          })
          .strict(),
        prompts: z
          .object({
            phase1: z.object({ version: z.number().int().min(0) }).strict(),
            phase2: z.object({ mode: z.enum(["single", "hybrid"]) }).strict(),
          })
          .strict(),
      })
      .strict(),
    historicalCitations: z
      .object({
        status: z.enum(["available", "unavailable", "unknown"]),
        mode: z.enum(["approved-evidence-only", "stored-evidence-pending", "legacy-unknown"]),
      })
      .strict(),
    legacy: z
      .object({
        historicalCitations: z.enum(["versioned", "pending", "legacy-unknown"]),
      })
      .strict(),
  });

export type GeneratedDocVersionManifest = z.infer<typeof provenanceManifestSchema>;

export function parseGeneratedDocVersionManifest(raw: unknown): GeneratedDocVersionManifest {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const current = provenanceManifestSchema.safeParse(parsed);
  if (current.success) return current.data;
  const statuslessCurrent = statuslessCurrentSchemaV1ManifestSchema.safeParse(parsed);
  if (statuslessCurrent.success) {
    return {
      ...statuslessCurrent.data,
      graphFingerprint: {
        algorithm: "sha256",
        status: "available",
        fingerprint: statuslessCurrent.data.graphFingerprint.fingerprint,
      },
    };
  }
  const graphlessCurrent = graphlessCurrentSchemaV1ManifestSchema.safeParse(parsed);
  if (graphlessCurrent.success) {
    return {
      ...graphlessCurrent.data,
      graphFingerprint: {
        algorithm: "sha256",
        status: "unknown",
        fingerprint: null,
      },
    };
  }
  const legacy = legacySchemaV1ManifestSchema.safeParse(parsed);
  if (legacy.success) {
    return {
      ...legacy.data,
      generation: {
        pipeline: "holistic",
        ...legacy.data.generation,
      },
      graphFingerprint: {
        algorithm: "sha256",
        status: "unknown",
        fingerprint: null,
      },
    };
  }
  if (typeof raw === "string") {
    return provenanceManifestSchema.parse(JSON.parse(raw));
  }
  return provenanceManifestSchema.parse(raw);
}

export function legacyGeneratedDocVersionManifest(
  revision: GeneratedDocRevisionKey,
): GeneratedDocVersionManifest {
  return {
    schemaVersion: GENERATED_DOC_PROVENANCE_SCHEMA_VERSION,
    revision: {
      revisionId: generatedDocRevisionId(revision),
      projectId: revision.projectId,
      generatedDocumentId: revision.generatedDocumentId,
      version: revision.version,
    },
    document: {
      title: "Legacy generated document version",
      scope: "legacy",
      docType: null,
      generatedAt: new Date(0).toISOString(),
    },
    policy: { sharedDocumentIds: [], allowWebResearch: false },
    generation: {
      pipeline: "holistic",
      model: {
        phase1: { model: "unknown" },
        phase2: { model: "unknown" },
        claim: { model: "unknown" },
        judge: { model: "unknown" },
      },
      prompts: { phase1: { version: 0 }, phase2: { mode: "single" } },
    },
    graphFingerprint: {
      algorithm: "sha256",
      status: "unknown",
      fingerprint: null,
    },
    sourceFingerprints: [],
    selectedEvidence: { primary: [] },
    sections: [],
    historicalCitations: { status: "unknown", mode: "legacy-unknown" },
    legacy: { historicalCitations: "legacy-unknown" },
  };
}

export interface GeneratedDocVersionRecord {
  documentId: string;
  version: number;
  revisionId: string | null;
  provenanceManifest: string | null;
}

export function normalizeGeneratedDocVersionRecord<T extends GeneratedDocVersionRecord>(
  record: T,
  revision: Omit<GeneratedDocRevisionKey, "version">,
): T & { revisionId: string; provenanceManifest: string } {
  const revisionKey = {
    projectId: revision.projectId,
    generatedDocumentId: revision.generatedDocumentId,
    version: record.version,
  };
  const manifest = record.provenanceManifest
    ? parseGeneratedDocVersionManifest(record.provenanceManifest)
    : legacyGeneratedDocVersionManifest(revisionKey);
  return {
    ...record,
    revisionId: record.revisionId ?? manifest.revision.revisionId,
    provenanceManifest: JSON.stringify(manifest),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceFingerprintOf(identity?: RepositoryIdentity): string {
  if (!identity) return sha256("project-scope");
  return sha256(JSON.stringify([identity.repoConnectorId, identity.codeGraphId]));
}

export function databaseSourceFingerprintOf(input: {
  dbConnectorId: string | null;
  schemaGraph: unknown;
}): string {
  return sha256(JSON.stringify([input.dbConnectorId, input.schemaGraph]));
}

export function repositoryRevisionFingerprint(input: {
  repoConnectorId: string | null;
  codeGraphId: string;
  commitSha?: string | null;
}): string {
  return sha256(
    JSON.stringify([input.repoConnectorId, input.codeGraphId, input.commitSha ?? null]),
  );
}

export function evidenceContentHash(source: Pick<GroundingSource, "text">): string {
  return sha256(source.text.trim());
}

export function graphFingerprintOf(contentHashes: readonly string[]): string {
  return sha256(JSON.stringify([...contentHashes]));
}

export function graphFingerprintOfValue(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function slugifySectionLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function buildGeneratedDocVersionManifest(input: {
  revision: GeneratedDocRevisionKey;
  title: string;
  scope: string;
  docType: DocType | null;
  generatedAt: Date;
  policy: EvidencePolicy;
  phase1Tuning: Pick<DocsGenTuning, "phase1Model">;
  phase2Router: Pick<Phase2Router, "primary" | "hybrid">;
  phase1PromptVersion: number;
  selectedEvidence: GroundingSource[];
  graphFingerprint: string | null;
  graphFingerprintStatus?: "available" | "unknown";
  sourceRepositories: Array<(RepositoryIdentity & { commitSha?: string | null }) | undefined>;
  sourceFingerprints?: Array<{
    kind: "repository-graph" | "project-scope" | "database-schema";
    repoConnectorId: string | null;
    codeGraphId: string | null;
    dbConnectorId?: string | null;
    commitSha?: string | null;
    sourceFingerprint: string;
  }>;
  selectedEvidenceRows?: Array<{
    sourceId: string;
    kind: "rag" | "web" | "facts";
    label: string;
    evidenceClass?: "repository-source" | "project-reference" | "web-reference" | null;
    documentId?: string;
    chunkId?: string;
    repository?: RepositoryIdentity;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    contentHash: string;
  }>;
  generationPipeline?: "holistic" | "incremental-discovery" | "discovery-agent" | "database-schema";
  generationModels?: {
    phase1: string;
    phase2: string;
    claim: string;
    judge: string;
  };
  historicalCitations?: {
    status: HistoricalCitationStatus;
    mode: HistoricalCitationMode;
    legacy: LegacyHistoricalCitationState;
  };
  sectionSynthesis?: SectionSynthesis;
  regeneration?: GeneratedDocVersionManifest["regeneration"];
  sections: Array<{
    sectionLabel: string;
    sectionIndex: number;
    providerKind: "bedrock" | "local" | "anthropic";
    model: string;
    factsSourceIds: string[];
    groundingSourceIds: string[];
  }>;
}): string {
  const primary =
    input.selectedEvidenceRows?.map((source) => ({
      sourceId: source.sourceId,
      kind: source.kind,
      label: source.label,
      evidenceClass: source.evidenceClass ?? null,
      ...(source.documentId ? { documentId: source.documentId } : {}),
      ...(source.chunkId ? { chunkId: source.chunkId } : {}),
      ...(source.repository ? { repository: source.repository } : {}),
      ...(source.filePath ? { filePath: source.filePath } : {}),
      ...(source.startLine ? { startLine: source.startLine } : {}),
      ...(source.endLine ? { endLine: source.endLine } : {}),
      contentHash: source.contentHash,
    })) ??
    input.selectedEvidence.map((source) => ({
      sourceId: source.sourceId,
      kind: source.kind,
      label: source.label,
      evidenceClass: source.evidenceClass ?? null,
      ...(source.documentId ? { documentId: source.documentId } : {}),
      ...(source.chunkId ? { chunkId: source.chunkId } : {}),
      ...(source.repository ? { repository: source.repository } : {}),
      contentHash: evidenceContentHash(source),
    }));

  const manifest: GeneratedDocVersionManifest = {
    schemaVersion: GENERATED_DOC_PROVENANCE_SCHEMA_VERSION,
    revision: {
      revisionId: generatedDocRevisionId(input.revision),
      projectId: input.revision.projectId,
      generatedDocumentId: input.revision.generatedDocumentId,
      version: input.revision.version,
    },
    document: {
      title: input.title,
      scope: input.scope,
      docType: input.docType,
      generatedAt: input.generatedAt.toISOString(),
    },
    policy: {
      ...(input.policy.repoConnectorId ? { repoConnectorId: input.policy.repoConnectorId } : {}),
      ...(input.policy.codeGraphId ? { codeGraphId: input.policy.codeGraphId } : {}),
      sharedDocumentIds: [...input.policy.sharedDocumentIds],
      allowWebResearch: input.policy.allowWebResearch,
    },
    generation: {
      pipeline: input.generationPipeline ?? "holistic",
      model: {
        phase1: { model: input.generationModels?.phase1 ?? input.phase1Tuning.phase1Model },
        phase2: {
          model: input.generationModels?.phase2 ?? input.phase2Router.primary.tuning.phase2Model,
        },
        claim: {
          model: input.generationModels?.claim ?? input.phase2Router.primary.tuning.claimModel,
        },
        judge: {
          model: input.generationModels?.judge ?? input.phase2Router.primary.tuning.judgeModel,
        },
      },
      prompts: {
        phase1: { version: input.phase1PromptVersion },
        phase2: { mode: input.phase2Router.hybrid ? "hybrid" : "single" },
      },
    },
    graphFingerprint: {
      algorithm: "sha256",
      status: input.graphFingerprintStatus ?? "available",
      fingerprint: input.graphFingerprint,
    },
    sourceFingerprints:
      input.sourceFingerprints ??
      dedupeRepositories(input.sourceRepositories).map((repository) => ({
        kind: repository ? "repository-graph" : "project-scope",
        repoConnectorId: repository?.repoConnectorId ?? null,
        codeGraphId: repository?.codeGraphId ?? null,
        ...(repository ? { commitSha: repository.commitSha ?? null } : {}),
        sourceFingerprint: repository
          ? repositoryRevisionFingerprint(repository)
          : sourceFingerprintOf(undefined),
      })),
    selectedEvidence: { primary },
    ...(input.sectionSynthesis ? { sectionSynthesis: input.sectionSynthesis } : {}),
    ...(input.regeneration ? { regeneration: input.regeneration } : {}),
    sections: input.sections.map((section) => ({
      sectionSlug: slugifySectionLabel(section.sectionLabel),
      sectionLabel: section.sectionLabel,
      sectionIndex: section.sectionIndex,
      providerKind: section.providerKind,
      model: section.model,
      factsSourceIds: [...section.factsSourceIds],
      groundingSourceIds: [...section.groundingSourceIds],
    })),
    historicalCitations: {
      status: input.historicalCitations?.status ?? "unavailable",
      mode:
        input.historicalCitations?.mode ??
        (primary.length > 0 ? "stored-evidence-pending" : "not-retained"),
    },
    legacy: {
      historicalCitations:
        input.historicalCitations?.legacy ?? (primary.length > 0 ? "pending" : "not-retained"),
    },
  };

  return JSON.stringify(provenanceManifestSchema.parse(manifest));
}

function dedupeRepositories(
  repositories: Array<(RepositoryIdentity & { commitSha?: string | null }) | undefined>,
): Array<(RepositoryIdentity & { commitSha?: string | null }) | undefined> {
  const out: Array<(RepositoryIdentity & { commitSha?: string | null }) | undefined> = [];
  const seen = new Set<string>();
  for (const repository of repositories) {
    const key = repository
      ? JSON.stringify([
          repository.repoConnectorId,
          repository.codeGraphId,
          repository.commitSha ?? null,
        ])
      : "project-scope";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repository);
  }
  return out;
}

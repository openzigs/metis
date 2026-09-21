/**
 * Project, Document, KnowledgeChunk, RepoConnection, DatabaseConnection schemas.
 */
import { z } from "zod";
import {
  DB_DRIVERS,
  DEFAULT_RETRIEVE_K,
  DOCUMENT_STATUSES,
  MAX_DOCUMENT_BYTES,
  MAX_RETRIEVE_K,
  PROJECT_STATUSES,
  REPO_PROVIDERS,
} from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";

// ---- Project ---------------------------------------------------------------
export const projectSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(128),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric/hyphen"),
    description: z.string().max(2048).default(""),
    status: z.enum(PROJECT_STATUSES),
    /**
     * v1.0.1 issue #134 — per-project AI provider override. Null/undefined
     * means "use the global default from loadAIConfig()". Validated at the
     * service layer against `SUPPORTED_PROVIDER_KEYS`.
     */
    aiProviderId: z.string().min(1).max(64).nullable().optional(),
    /**
     * v1.2.0 — per-project AI model id override (e.g. a Bedrock model id).
     * Free-form string, ≤ 200 chars. Null/undefined ⇒ use the global
     * default model from `loadAIConfig().model`.
     */
    aiModel: z.string().min(1).max(200).nullable().optional(),
    /**
     * Epic #701 — per-project opt-in toggle that allows discovery scans to
     * extract credentials from `.env*` files (always vaulted, never logged).
     * Defaults to false.
     */
    allowCredentialScan: z.boolean().optional().default(false),
    createdById: idSchema,
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type Project = z.infer<typeof projectSchema>;

export const primaryRepoInputSchema = z.object({
  ownerOrOrg: z.string().min(1).max(128),
  repoName: z.string().min(1).max(128),
  apiBaseUrl: z.string().url().max(512).optional(),
  secretRef: z.string().max(256).optional(),
});
export type PrimaryRepoInput = z.infer<typeof primaryRepoInputSchema>;

export const createProjectSchema = projectSchema
  .pick({
    name: true,
    slug: true,
    description: true,
    status: true,
    aiProviderId: true,
    aiModel: true,
  })
  .partial({ description: true, status: true, aiProviderId: true, aiModel: true });

/** Extended schema for POST /api/projects — includes optional primaryRepo and workspaceId. */
export const createProjectWithRepoSchema = createProjectSchema.extend({
  primaryRepo: primaryRepoInputSchema.optional(),
  workspaceId: z.string().cuid().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateProjectWithRepoInput = z.infer<typeof createProjectWithRepoSchema>;

export const updateProjectSchema = createProjectSchema.partial().extend({ id: idSchema });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/** Epic #701 — toggle credential extraction during repo scans. */
export const updateAllowCredentialScanSchema = z.object({
  allowCredentialScan: z.boolean(),
});
export type UpdateAllowCredentialScanInput = z.infer<typeof updateAllowCredentialScanSchema>;

// ---- Document --------------------------------------------------------------
export const documentSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().min(0).max(MAX_DOCUMENT_BYTES),
  storagePath: z.string().min(1).max(1024),
  checksum: z.string().min(1).max(128),
  status: z.enum(DOCUMENT_STATUSES).default("pending"),
  errorMessage: z.string().nullable().default(null),
  chunkCount: z.number().int().min(0).default(0),
  uploadedById: idSchema,
  uploadedAt: dateSchema,
  processedAt: dateSchema.nullable().default(null),
  deletedAt: dateSchema.nullable(),
});
export type Document = z.infer<typeof documentSchema>;

export const createDocumentSchema = documentSchema.pick({
  projectId: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  storagePath: true,
  checksum: true,
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

// ---- Retrieval -------------------------------------------------------------
/**
 * Retrieval mode (issue #131).
 *   - `dense`  — vector similarity only (legacy behaviour).
 *   - `hybrid` — dense + BM25 sparse merged via reciprocal rank fusion.
 *                Default. Cross-encoder rerank is layered on top when
 *                `RAG_RERANK=1` is set on the server.
 */
export const RETRIEVAL_MODES = ["dense", "hybrid"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = "hybrid";

export const retrieveQuerySchema = z.object({
  query: z.string().min(1).max(2048),
  k: z.number().int().min(1).max(MAX_RETRIEVE_K).default(DEFAULT_RETRIEVE_K).optional(),
  documentIds: z.array(idSchema).max(100).optional(),
  mode: z.enum(RETRIEVAL_MODES).optional(),
});
export type RetrieveQuery = z.infer<typeof retrieveQuerySchema>;

export const retrievedChunkSchema = z.object({
  chunkId: idSchema,
  documentId: idSchema,
  filename: z.string(),
  position: z.number().int().min(0),
  text: z.string(),
  score: z.number(),
  embeddingModel: z.string(),
});
export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>;

/**
 * Per-search coverage warning emitted when the project's chunks were embedded
 * with a model different from the currently-configured embedder. Only chunks
 * matching the current model are included in `hits`. See R-D1 in issue #41.
 */
export const coverageWarningSchema = z.object({
  totalChunks: z.number().int().min(0),
  matchingChunks: z.number().int().min(0),
  mismatchedModels: z.array(z.string()),
  currentModel: z.string(),
});
export type CoverageWarning = z.infer<typeof coverageWarningSchema>;

export const retrieveResponseSchema = z.object({
  hits: z.array(retrievedChunkSchema),
  coverageWarning: coverageWarningSchema.optional(),
});
export type RetrieveResponse = z.infer<typeof retrieveResponseSchema>;

// ---- KnowledgeChunk --------------------------------------------------------
export const knowledgeChunkSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  documentId: idSchema,
  position: z.number().int().min(0),
  text: z.string().min(1),
  md5: z
    .string()
    .length(32)
    .regex(/^[a-f0-9]+$/i, "md5 must be hex"),
  vectorRef: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: dateSchema,
});
export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

export const createKnowledgeChunkSchema = knowledgeChunkSchema.pick({
  projectId: true,
  documentId: true,
  position: true,
  text: true,
  md5: true,
  vectorRef: true,
  metadata: true,
});
export type CreateKnowledgeChunkInput = z.infer<typeof createKnowledgeChunkSchema>;

// ---- RepoConnection --------------------------------------------------------
export const repoConnectionSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    label: z.string().min(1).max(128),
    provider: z.enum(REPO_PROVIDERS),
    ownerOrOrg: z.string().min(1).max(128),
    repoName: z.string().min(1).max(128),
    defaultBranch: z.string().min(1).max(128),
    secretId: idSchema.nullable(),
    createdById: idSchema.nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type RepoConnection = z.infer<typeof repoConnectionSchema>;

export const createRepoConnectionSchema = repoConnectionSchema
  .pick({
    projectId: true,
    label: true,
    provider: true,
    ownerOrOrg: true,
    repoName: true,
    defaultBranch: true,
    secretId: true,
  })
  .partial({ defaultBranch: true, secretId: true });
export type CreateRepoConnectionInput = z.infer<typeof createRepoConnectionSchema>;

// ---- DatabaseConnection ----------------------------------------------------
export const databaseConnectionSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    label: z.string().min(1).max(128),
    driver: z.enum(DB_DRIVERS),
    host: z.string().max(255).nullable(),
    port: z.number().int().min(1).max(65535).nullable(),
    databaseName: z.string().max(128).nullable(),
    username: z.string().max(128).nullable(),
    secretId: idSchema.nullable(),
    options: z.string().nullable(), // JSON-encoded
    createdById: idSchema.nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type DatabaseConnection = z.infer<typeof databaseConnectionSchema>;

export const createDatabaseConnectionSchema = databaseConnectionSchema
  .pick({
    projectId: true,
    label: true,
    driver: true,
    host: true,
    port: true,
    databaseName: true,
    username: true,
    secretId: true,
    options: true,
  })
  .partial({
    host: true,
    port: true,
    databaseName: true,
    username: true,
    secretId: true,
    options: true,
  });
export type CreateDatabaseConnectionInput = z.infer<typeof createDatabaseConnectionSchema>;

// ---- SuggestedConnector test / provision (Epic #701 / Issue #704) ---------
//
// Both schemas allow ALL connection params to be overridden by the caller —
// the route falls back to the stored suggestion row and the vault-stored
// dev password when fields are omitted, so the simplest valid body is `{}`.

export const suggestedConnectorTestSchema = z
  .object({
    host: z.string().max(255).nullish(),
    port: z.number().int().min(1).max(65535).nullish(),
    database: z.string().max(128).nullish(),
    username: z.string().max(128).nullish(),
    password: z.string().max(1024).nullish(),
  })
  .strict();
export type SuggestedConnectorTestInput = z.infer<typeof suggestedConnectorTestSchema>;

export const suggestedConnectorProvisionSchema = z
  .object({
    label: z.string().min(1).max(128),
    driver: z.enum(DB_DRIVERS),
    host: z.string().max(255).nullable(),
    port: z.number().int().min(1).max(65535).nullable(),
    database: z.string().max(128).nullable(),
    username: z.string().max(128).nullable(),
    password: z.string().max(1024).nullable(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SuggestedConnectorProvisionInput = z.infer<typeof suggestedConnectorProvisionSchema>;

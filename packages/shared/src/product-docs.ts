/**
 * Product schemas for multi-repo product documentation (Epic #544).
 */
import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

// ---- Constants -------------------------------------------------------------
export const PRODUCT_REPO_ROLES = [
  "frontend",
  "backend-api",
  "shared-lib",
  "microservice",
  "gateway",
  "docs",
] as const;
export type ProductRepoRole = (typeof PRODUCT_REPO_ROLES)[number];

export const PRODUCT_EDGE_TYPES = [
  "calls",
  "imports",
  "produces",
  "consumes",
  "extends",
  "implements",
] as const;
export type ProductEdgeType = (typeof PRODUCT_EDGE_TYPES)[number];

export const PRODUCT_ANALYSIS_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ProductAnalysisStatus = (typeof PRODUCT_ANALYSIS_STATUSES)[number];

export const PRODUCT_DOC_TYPES = ["unified-architecture", "per-service", "api-contract"] as const;
export type ProductDocType = (typeof PRODUCT_DOC_TYPES)[number];

// ---- Product ---------------------------------------------------------------
export const productSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(128),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric/hyphen"),
    description: z.string().max(2048).default(""),
    createdById: idSchema,
  })
  .merge(timestampsSchema);
export type Product = z.infer<typeof productSchema>;

export const createProductSchema = z.object({
  name: z.string().min(1).max(128),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric/hyphen"),
  description: z.string().max(2048).optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2048).optional(),
});
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// ---- ProductRepo -----------------------------------------------------------
export const productRepoRoleSchema = z.enum(PRODUCT_REPO_ROLES).nullable().optional();

export const addProductRepoSchema = z.object({
  repoConnectionId: idSchema,
  role: productRepoRoleSchema,
});
export type AddProductRepoInput = z.infer<typeof addProductRepoSchema>;

export const updateProductRepoSchema = z.object({
  role: productRepoRoleSchema,
});
export type UpdateProductRepoInput = z.infer<typeof updateProductRepoSchema>;

// ---- ProductEdge -----------------------------------------------------------
export interface ProductEdgeEvidence {
  filePath: string;
  lineNumber?: number;
  pattern: string;
  snippet?: string;
  matchType: string;
}

export const productEdgeEvidenceSchema = z.object({
  filePath: z.string(),
  lineNumber: z.number().int().optional(),
  pattern: z.string(),
  snippet: z.string().optional(),
  matchType: z.string(),
});

export const productEdgeSchema = z.object({
  id: idSchema,
  productId: idSchema,
  sourceRepoId: idSchema,
  targetRepoId: idSchema,
  edgeType: z.enum(PRODUCT_EDGE_TYPES),
  confidence: z.number().min(0).max(1),
  evidence: z.array(productEdgeEvidenceSchema),
  sourceFile: z.string().nullable().optional(),
  targetFile: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
});
export type ProductEdge = z.infer<typeof productEdgeSchema>;

// ---- ProductAnalysis -------------------------------------------------------
export const productAnalysisSchema = z.object({
  id: idSchema,
  productId: idSchema,
  status: z.enum(PRODUCT_ANALYSIS_STATUSES),
  startedAt: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
  edgeCount: z.number().int().default(0),
  error: z.string().nullable().optional(),
  triggeredBy: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
});
export type ProductAnalysis = z.infer<typeof productAnalysisSchema>;

// ---- ProductDocument -------------------------------------------------------
export const productDocumentSchema = z.object({
  id: idSchema,
  productId: idSchema,
  docType: z.enum(PRODUCT_DOC_TYPES),
  title: z.string(),
  content: z.string(),
  repoId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  version: z.number().int().default(1),
  generatedAt: z.coerce.date(),
});
export type ProductDocument = z.infer<typeof productDocumentSchema>;

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

/**
 * #1618 — what crosses the boundary between the two ends of an edge, after the
 * Backstage system model (`providesApi` / `consumesApi` / `dependsOn`).
 */
export const PRODUCT_INTEGRATION_KINDS = [
  "api",
  "event",
  "database",
  "shared-library",
  "identity",
] as const;
export type ProductIntegrationKind = (typeof PRODUCT_INTEGRATION_KINDS)[number];

/**
 * #1618 — how tightly an edge couples its two ends (Khononov's integration
 * strength), STRONGEST FIRST: `intrusive` (writes a shared table, reaches
 * internals) > `functional` (a duplicated business rule) > `model` (a shared
 * library or domain type) > `contract` (a versioned API or event schema).
 * Severity ranks by this order.
 */
export const PRODUCT_COUPLING_STRENGTHS = ["intrusive", "functional", "model", "contract"] as const;
export type ProductCouplingStrength = (typeof PRODUCT_COUPLING_STRENGTHS)[number];

/** #1618 — an edge's direction, read from its source repo's side. */
export const PRODUCT_EDGE_DIRECTIONS = [
  "provides",
  "consumes",
  "reads",
  "writes",
  "depends-on",
] as const;
export type ProductEdgeDirection = (typeof PRODUCT_EDGE_DIRECTIONS)[number];

/** #1618 — whether detection found an edge or resource, or a person declared it. */
export const PRODUCT_EDGE_ORIGINS = ["detected", "declared"] as const;
export type ProductEdgeOrigin = (typeof PRODUCT_EDGE_ORIGINS)[number];

/** #1618 — a resource a product's repos share without one of them owning it. */
export const PRODUCT_RESOURCE_KINDS = [
  "database",
  "table",
  "topic",
  "identity-provider",
  "bucket",
] as const;
export type ProductResourceKind = (typeof PRODUCT_RESOURCE_KINDS)[number];

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
  /** #1618 — null only for an edge through a resource. */
  targetRepoId: idSchema.nullable(),
  edgeType: z.enum(PRODUCT_EDGE_TYPES),
  confidence: z.number().min(0).max(1),
  evidence: z.array(productEdgeEvidenceSchema),
  sourceFile: z.string().nullable().optional(),
  targetFile: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  // #1618 — null on an edge written before the coupling model (not classified).
  integrationKind: z.enum(PRODUCT_INTEGRATION_KINDS).nullable(),
  strength: z.enum(PRODUCT_COUPLING_STRENGTHS).nullable(),
  direction: z.enum(PRODUCT_EDGE_DIRECTIONS).nullable(),
  origin: z.enum(PRODUCT_EDGE_ORIGINS),
  resourceId: idSchema.nullable(),
  contractDocId: idSchema.nullable(),
  declaredById: z.string().nullable(),
});
export type ProductEdge = z.infer<typeof productEdgeSchema>;

/**
 * #1618 — the body of `POST /api/products/:id/edges`: an edge a person declares.
 * A declared edge is fully typed (kind, strength, direction) and goes to a
 * target repo, through a resource, or both — never neither. Ids are checked
 * against the product by the service (a resource or contract of another
 * product is refused as not found).
 */
export const declareProductEdgeSchema = z
  .object({
    sourceRepoId: idSchema,
    targetRepoId: idSchema.nullable().optional(),
    resourceId: idSchema.nullable().optional(),
    contractDocId: idSchema.nullable().optional(),
    edgeType: z.enum(PRODUCT_EDGE_TYPES),
    integrationKind: z.enum(PRODUCT_INTEGRATION_KINDS),
    strength: z.enum(PRODUCT_COUPLING_STRENGTHS),
    direction: z.enum(PRODUCT_EDGE_DIRECTIONS),
  })
  .strict()
  .refine((e) => Boolean(e.targetRepoId || e.resourceId), {
    message: "an edge needs a targetRepoId, a resourceId, or both",
    path: ["targetRepoId"],
  });
export type DeclareProductEdgeInput = z.infer<typeof declareProductEdgeSchema>;

/**
 * #1620 — the body of `PATCH /api/products/:id/edges/:edgeId`. Every field is
 * optional; at least one must be given. On a DETECTED edge only the
 * classification (`integrationKind`, `strength`, `direction`) may change — its
 * ends are what detection found — and the edge becomes declared, so the next
 * detection run leaves the override alone.
 */
export const updateProductEdgeSchema = z
  .object({
    targetRepoId: idSchema.nullable().optional(),
    resourceId: idSchema.nullable().optional(),
    contractDocId: idSchema.nullable().optional(),
    edgeType: z.enum(PRODUCT_EDGE_TYPES).optional(),
    integrationKind: z.enum(PRODUCT_INTEGRATION_KINDS).optional(),
    strength: z.enum(PRODUCT_COUPLING_STRENGTHS).optional(),
    direction: z.enum(PRODUCT_EDGE_DIRECTIONS).optional(),
  })
  .strict()
  .refine((e) => Object.keys(e).length > 0, { message: "nothing to update" });
export type UpdateProductEdgeInput = z.infer<typeof updateProductEdgeSchema>;

/** The edge fields a PATCH may change on a detected edge (#1620). */
export const DETECTED_EDGE_OVERRIDABLE_FIELDS = [
  "integrationKind",
  "strength",
  "direction",
] as const;

// ---- ProductResource (#1618) -----------------------------------------------
export const productResourceSchema = z.object({
  id: idSchema,
  productId: idSchema,
  kind: z.enum(PRODUCT_RESOURCE_KINDS),
  name: z.string(),
  locator: z.string().nullable(),
  origin: z.enum(PRODUCT_EDGE_ORIGINS),
  declaredById: z.string().nullable(),
});
export type ProductResource = z.infer<typeof productResourceSchema>;

/**
 * #1620 — a resource locator says where a resource lives, never how to get in:
 * a URL carrying a user name or password is refused.
 */
const resourceLocatorSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((v) => !/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i.test(v), {
    message: "a locator must not carry credentials",
  });

const resourceNameSchema = z.string().trim().min(1).max(256);

/** #1620 — the body of `POST /api/products/:id/resources`. */
export const declareProductResourceSchema = z
  .object({
    kind: z.enum(PRODUCT_RESOURCE_KINDS),
    name: resourceNameSchema,
    locator: resourceLocatorSchema.nullable().optional(),
  })
  .strict();
export type DeclareProductResourceInput = z.infer<typeof declareProductResourceSchema>;

/**
 * #1620 — the body of `PATCH /api/products/:id/resources/:resourceId`. A
 * detected resource keeps its kind and name (detection would recreate it under
 * the old ones); its locator may be set, which makes it declared.
 */
export const updateProductResourceSchema = z
  .object({
    kind: z.enum(PRODUCT_RESOURCE_KINDS).optional(),
    name: resourceNameSchema.optional(),
    locator: resourceLocatorSchema.nullable().optional(),
  })
  .strict()
  .refine((r) => Object.keys(r).length > 0, { message: "nothing to update" });
export type UpdateProductResourceInput = z.infer<typeof updateProductResourceSchema>;

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
  metadata: z.record(z.string(), z.unknown()).optional(),
  version: z.number().int().default(1),
  generatedAt: z.coerce.date(),
});
export type ProductDocument = z.infer<typeof productDocumentSchema>;

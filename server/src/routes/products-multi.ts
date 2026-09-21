/**
 * /api/products — Product CRUD + multi-repo association (Epic #544 / Issue #546).
 */
import { Router, type Request, type Response } from "express";
import {
  createProductSchema,
  updateProductSchema,
  addProductRepoSchema,
  updateProductRepoSchema,
  paginationQuerySchema,
} from "@metis/shared";
import { ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
  addProductRepo,
  removeProductRepo,
  updateProductRepo,
  ProductError,
} from "../lib/products/product-service.js";
import {
  assertProductAccessible,
  buildProductAccessWhere,
  repoConnectionProjectFilter,
} from "../lib/products/product-access.js";
import { prisma } from "../lib/prisma.js";
import { generateUnifiedArchitectureDoc } from "../lib/products/unified-doc-generator.js";
import { generateAllPerServiceDocs } from "../lib/products/per-service-doc-generator.js";
import {
  recordContractDocVersion,
  createPrismaContractDocStore,
} from "../lib/products/contract-doc-versioning.js";
import { summarizeDiff as summarizeContractDiff } from "../lib/products/contract-diff.js";
import type { ProductRepoInfo, ProductEdgeInfo } from "../lib/products/unified-doc-generator.js";
import type { ProductEdgeEvidence } from "@metis/shared";

function isProductError(err: unknown): err is ProductError {
  return err instanceof Error && err.name === "ProductError";
}

/** Extract a single string param (Express 5 params can be string | string[]). */
function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? "");
}

export function productsRouter(): Router {
  const r = Router();

  // All product endpoints require authentication
  r.use(requireAuth);

  // POST /api/products — Create a new product
  r.post("/", requirePermission("project.create"), async (req: Request, res: Response) => {
    try {
      const input = createProductSchema.parse(req.body);
      const product = await createProduct(input, { id: req.user!.userId });
      res.status(201).json({ data: product });
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
        return;
      }
      if (isProductError(err)) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // GET /api/products — List products (scoped to the caller's accessible projects)
  r.get("/", requirePermission("project.read"), async (req: Request, res: Response) => {
    const { page, pageSize } = paginationQuerySchema.parse(req.query);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const accessWhere = await buildProductAccessWhere(req.user!);
    const result = await listProducts({ page, pageSize, search, accessWhere });
    res.json({ data: result });
  });

  // GET /api/products/repo-connections — List all repo connections (for product repo picker)
  // Declared before /:id so Express doesn't match "repo-connections" as an ID param.
  r.get(
    "/repo-connections",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const where: Record<string, unknown> = { deletedAt: null };
      if (search) {
        where.OR = [
          { label: { contains: search } },
          { repoName: { contains: search } },
          { ownerOrOrg: { contains: search } },
        ];
      }
      // Issue #677 — restrict to the caller's accessible projects (admin: all).
      const projectFilter = await repoConnectionProjectFilter(req.user!);
      if (projectFilter) {
        where.projectId = projectFilter;
      }
      const connections = await prisma.repoConnection.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          label: true,
          provider: true,
          ownerOrOrg: true,
          repoName: true,
          defaultBranch: true,
          status: true,
          projectId: true,
        },
      });
      res.json({ data: connections });
    },
  );

  // GET /api/products/:id — Get product with repos
  r.get("/:id", requirePermission("project.read"), async (req: Request, res: Response) => {
    try {
      await assertProductAccessible(req.user!, param(req.params.id));
      const product = await getProduct(param(req.params.id));
      res.json({ data: product });
    } catch (err) {
      if (isProductError(err)) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // PATCH /api/products/:id — Update product metadata
  r.patch("/:id", requirePermission("project.update"), async (req: Request, res: Response) => {
    try {
      await assertProductAccessible(req.user!, param(req.params.id));
      const input = updateProductSchema.parse(req.body);
      const product = await updateProduct(param(req.params.id), input);
      res.json({ data: product });
    } catch (err) {
      if (isProductError(err)) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // DELETE /api/products/:id — Delete product
  r.delete("/:id", requirePermission("project.delete"), async (req: Request, res: Response) => {
    try {
      await assertProductAccessible(req.user!, param(req.params.id));
      await deleteProduct(param(req.params.id));
      res.status(204).send();
    } catch (err) {
      if (isProductError(err)) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // POST /api/products/:id/repos — Associate a repo connection to product
  r.post("/:id/repos", requirePermission("project.update"), async (req: Request, res: Response) => {
    try {
      await assertProductAccessible(req.user!, param(req.params.id));
      const input = addProductRepoSchema.parse(req.body);
      const result = await addProductRepo(param(req.params.id), input);
      res.status(201).json({ data: result });
    } catch (err) {
      if (isProductError(err)) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // DELETE /api/products/:id/repos/:repoId — Remove repo from product
  r.delete(
    "/:id/repos/:repoId",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      try {
        await assertProductAccessible(req.user!, param(req.params.id));
        await removeProductRepo(param(req.params.id), param(req.params.repoId));
        res.status(204).send();
      } catch (err) {
        if (isProductError(err)) {
          res.status(err.status).json({ error: { code: err.code, message: err.message } });
          return;
        }
        throw err;
      }
    },
  );

  // PATCH /api/products/:id/repos/:repoId — Update repo role within product
  r.patch(
    "/:id/repos/:repoId",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      try {
        await assertProductAccessible(req.user!, param(req.params.id));
        const input = updateProductRepoSchema.parse(req.body);
        const result = await updateProductRepo(
          param(req.params.id),
          param(req.params.repoId),
          input,
        );
        res.json({ data: result });
      } catch (err) {
        if (isProductError(err)) {
          res.status(err.status).json({ error: { code: err.code, message: err.message } });
          return;
        }
        throw err;
      }
    },
  );

  // POST /api/products/:id/analyze — Trigger cross-repo analysis & doc generation
  r.post(
    "/:id/analyze",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const productId = param(req.params.id);
      await assertProductAccessible(req.user!, productId);

      // Verify product exists and load repos + edges
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: {
          repos: {
            include: {
              repoConnection: {
                select: { id: true, ownerOrOrg: true, repoName: true, defaultBranch: true },
              },
            },
          },
          edges: true,
        },
      });
      if (!product) {
        res.status(404).json({
          error: { code: "PRODUCT_NOT_FOUND", message: `Product ${productId} not found` },
        });
        return;
      }

      // Create an analysis record
      const analysis = await prisma.productAnalysis.create({
        data: {
          productId,
          status: "running",
          startedAt: new Date(),
          triggeredBy: req.user!.userId,
        },
      });

      try {
        // Map repos/edges to generator input types
        const repoInfos: ProductRepoInfo[] = product.repos.map((r) => ({
          repoConnectionId: r.repoConnectionId,
          repoName: r.repoConnection?.repoName ?? r.repoConnectionId,
          ownerOrOrg: r.repoConnection?.ownerOrOrg ?? "",
          role: r.role,
          defaultBranch: r.repoConnection?.defaultBranch ?? "main",
        }));
        const edgeInfos: ProductEdgeInfo[] = product.edges.map((e) => ({
          sourceRepoId: e.sourceRepoId,
          targetRepoId: e.targetRepoId,
          edgeType: e.edgeType,
          confidence: e.confidence,
          evidence: (typeof e.evidence === "string"
            ? JSON.parse(e.evidence)
            : e.evidence) as ProductEdgeEvidence[],
          sourceFile: e.sourceFile,
          targetFile: e.targetFile,
        }));

        // Generate unified architecture doc
        const unifiedDoc = generateUnifiedArchitectureDoc({
          productName: product.name,
          productDescription: product.description ?? "",
          repos: repoInfos,
          edges: edgeInfos,
        });

        // Generate per-service docs
        const perServiceDocs = generateAllPerServiceDocs({
          productName: product.name,
          repos: repoInfos,
          edges: edgeInfos,
        });

        // Generate + version API contract docs (one per repo). Each run records
        // a new ProductContractDoc version (deduped by contentHash) and computes
        // the semantic diff vs the previous version (Issue #90 / epic #86).
        const contractStore = createPrismaContractDocStore(prisma.productContractDoc);
        const apiContractResults = await Promise.all(
          repoInfos.map((repo) =>
            recordContractDocVersion(
              {
                productId,
                productName: product.name,
                repoName: repo.repoName,
                repoConnectionId: repo.repoConnectionId,
                ownerOrOrg: repo.ownerOrOrg,
                specs: [], // Full crawl specs would come from an async crawl step
              },
              contractStore,
            ),
          ),
        );
        const apiContractDocs = apiContractResults.map((r) => r.doc);

        // Upsert documents into ProductDocument table
        const now = new Date();

        // Delete existing docs for this product then recreate
        await prisma.productDocument.deleteMany({ where: { productId } });

        const docsToCreate = [
          {
            productId,
            docType: "unified-architecture",
            title: unifiedDoc.title,
            content: unifiedDoc.content,
            repoId: null,
            metadata: JSON.stringify(unifiedDoc.metadata),
            generatedAt: now,
          },
          ...perServiceDocs.map((doc, i) => ({
            productId,
            docType: "per-service",
            title: doc.title,
            content: doc.content,
            repoId: repoInfos[i]?.repoConnectionId ?? null,
            metadata: JSON.stringify(doc.metadata),
            generatedAt: now,
          })),
          ...apiContractDocs.map((doc, i) => {
            const result = apiContractResults[i];
            return {
              productId,
              docType: "api-contract",
              title: doc.title,
              content: doc.content,
              repoId: repoInfos[i]?.repoConnectionId ?? null,
              // Surface the contract version + diff on the ProductDocument so the
              // UI can render a "diff badge" on the Contracts tab (epic #86 AC).
              metadata: JSON.stringify({
                ...doc.metadata,
                contractVersion: result.version,
                contentHash: result.contentHash,
                diffSummary: result.diff ? summarizeContractDiff(result.diff) : "Initial version.",
                hasContractChanges: result.diff?.hasChanges ?? false,
              }),
              version: result.version,
              generatedAt: now,
            };
          }),
        ];

        for (const doc of docsToCreate) {
          await prisma.productDocument.create({ data: doc });
        }

        // Update analysis status
        await prisma.productAnalysis.update({
          where: { id: analysis.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            edgeCount: edgeInfos.length,
          },
        });

        res.json({
          data: {
            analysisId: analysis.id,
            status: "completed",
            documentsGenerated: docsToCreate.length,
            edgesDetected: edgeInfos.length,
            contractDocs: apiContractResults.map((r, i) => ({
              repoId: repoInfos[i]?.repoConnectionId ?? null,
              version: r.version,
              created: r.created,
              diffSummary: r.diff ? summarizeContractDiff(r.diff) : "Initial version.",
              diff: r.diff,
            })),
          },
        });
      } catch (err) {
        // Mark analysis as failed
        await prisma.productAnalysis.update({
          where: { id: analysis.id },
          data: {
            status: "failed",
            completedAt: new Date(),
            error: err instanceof Error ? err.message : "Unknown error",
          },
        });
        throw err;
      }
    },
  );

  // GET /api/products/:id/documents — Get generated documents for a product
  r.get(
    "/:id/documents",
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const productId = param(req.params.id);
      await assertProductAccessible(req.user!, productId);
      const docType = typeof req.query.docType === "string" ? req.query.docType : undefined;

      const where: Record<string, unknown> = { productId };
      if (docType) where.docType = docType;

      const docs = await prisma.productDocument.findMany({
        where,
        orderBy: { generatedAt: "desc" },
        select: {
          id: true,
          docType: true,
          title: true,
          content: true,
          repoId: true,
          metadata: true,
          generatedAt: true,
          version: true,
        },
      });
      res.json({ data: docs });
    },
  );

  // GET /api/products/:id/analyses — Get analysis history for a product
  r.get("/:id/analyses", requirePermission("project.read"), async (req: Request, res: Response) => {
    const productId = param(req.params.id);
    await assertProductAccessible(req.user!, productId);
    const analyses = await prisma.productAnalysis.findMany({
      where: { productId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    res.json({ data: analyses });
  });

  return r;
}

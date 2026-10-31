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
  declareProductEdgeSchema,
  updateProductEdgeSchema,
  declareProductResourceSchema,
  updateProductResourceSchema,
  type AuthPayload,
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
  LIVE_PRODUCT_REPOS,
  ProductError,
} from "../lib/products/product-service.js";
import {
  assertProductAccessible,
  assertProductRepoReadable,
  assertRepoConnectionAttachable,
  buildProductAccessWhere,
  filterReadableProductDocuments,
  isProductRepoHiddenFrom,
  productRepoReadAccess,
  repoConnectionProjectFilter,
  withReadableProductRepos,
} from "../lib/products/product-access.js";
import {
  createDeclaredProductEdge,
  createDeclaredProductResource,
  deleteProductEdge,
  deleteProductResource,
  listReadableProductGraph,
  updateProductEdge,
  updateProductResource,
} from "../lib/products/product-edges.js";
import { audit } from "../lib/audit/audit-service.js";
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

/**
 * #1620 — the product's live repos the caller can read (#1258), the set an edge
 * or resource write is judged against. A missing product is the service's 404.
 */
async function readableRepoIdsOf(user: AuthPayload, productId: string): Promise<Set<string>> {
  const product = await getProduct(productId);
  const canRead = await productRepoReadAccess(user);
  return new Set(product.repos.filter(canRead).map((r) => r.repoConnectionId));
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
    // #1258 — each listed product shows only the repos the caller can open.
    const canRead = await productRepoReadAccess(req.user!);
    const items = result.items.map((item) => withReadableProductRepos(item, canRead));
    res.json({ data: { ...result, items } });
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
      // #1258 — a repo attached across workspaces before #1257 is not shown to a
      // caller who cannot open its project.
      const canRead = await productRepoReadAccess(req.user!);
      const visible = withReadableProductRepos(product, canRead);
      // #1618 — the typed edges and shared resources, limited to the repos shown.
      const graph = await listReadableProductGraph(
        product.id,
        new Set(visible.repos.map((r) => r.repoConnectionId)),
      );
      res.json({ data: { ...visible, ...graph } });
    } catch (err) {
      if (isProductError(err)) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // POST /api/products/:id/edges — Declare an edge detection cannot see (#1618)
  r.post("/:id/edges", requirePermission("project.update"), async (req: Request, res: Response) => {
    try {
      const productId = param(req.params.id);
      await assertProductAccessible(req.user!, productId);
      const input = declareProductEdgeSchema.parse(req.body);
      // A declared edge may not name a repo the caller cannot open (#1258): such
      // a repo is answered as not attached, like one that is not.
      await assertProductRepoReadable(req.user!, productId, input.sourceRepoId);
      if (input.targetRepoId) {
        await assertProductRepoReadable(req.user!, productId, input.targetRepoId);
      }
      const edge = await createDeclaredProductEdge(productId, input, { id: req.user!.userId });
      res.status(201).json({ data: edge });
    } catch (err) {
      if (isProductError(err)) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  });

  // #1620 — the rest of the declared-edges API. Every verb needs the product
  // edit right (`project.update`) and access to the product (404 otherwise);
  // an edge or resource the caller cannot see is answered like a missing one.
  const sendProductError = (err: unknown, res: Response): boolean => {
    if (!isProductError(err)) return false;
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return true;
  };

  // PATCH /api/products/:id/edges/:edgeId — Change an edge (a detected one: override its classification)
  r.patch(
    "/:id/edges/:edgeId",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      try {
        const productId = param(req.params.id);
        await assertProductAccessible(req.user!, productId);
        const input = updateProductEdgeSchema.parse(req.body);
        const readable = await readableRepoIdsOf(req.user!, productId);
        const edge = await updateProductEdge(
          productId,
          param(req.params.edgeId),
          input,
          { id: req.user!.userId },
          readable,
        );
        res.json({ data: edge });
      } catch (err) {
        if (!sendProductError(err, res)) throw err;
      }
    },
  );

  // DELETE /api/products/:id/edges/:edgeId — Delete a declared edge
  r.delete(
    "/:id/edges/:edgeId",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      try {
        const productId = param(req.params.id);
        await assertProductAccessible(req.user!, productId);
        const readable = await readableRepoIdsOf(req.user!, productId);
        await deleteProductEdge(productId, param(req.params.edgeId), readable);
        res.status(204).send();
      } catch (err) {
        if (!sendProductError(err, res)) throw err;
      }
    },
  );

  // POST /api/products/:id/resources — Declare a shared resource
  r.post(
    "/:id/resources",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      try {
        const productId = param(req.params.id);
        await assertProductAccessible(req.user!, productId);
        const input = declareProductResourceSchema.parse(req.body);
        await getProduct(productId); // a missing product is a 404, for an admin too
        const resource = await createDeclaredProductResource(productId, input, {
          id: req.user!.userId,
        });
        res.status(201).json({ data: resource });
      } catch (err) {
        if (!sendProductError(err, res)) throw err;
      }
    },
  );

  // PATCH /api/products/:id/resources/:resourceId — Change a resource
  r.patch(
    "/:id/resources/:resourceId",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      try {
        const productId = param(req.params.id);
        await assertProductAccessible(req.user!, productId);
        const input = updateProductResourceSchema.parse(req.body);
        const readable = await readableRepoIdsOf(req.user!, productId);
        const resource = await updateProductResource(
          productId,
          param(req.params.resourceId),
          input,
          { id: req.user!.userId },
          readable,
        );
        res.json({ data: resource });
      } catch (err) {
        if (!sendProductError(err, res)) throw err;
      }
    },
  );

  // DELETE /api/products/:id/resources/:resourceId — Delete a declared resource
  r.delete(
    "/:id/resources/:resourceId",
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      try {
        const productId = param(req.params.id);
        await assertProductAccessible(req.user!, productId);
        const readable = await readableRepoIdsOf(req.user!, productId);
        await deleteProductResource(productId, param(req.params.resourceId), readable);
        res.status(204).send();
      } catch (err) {
        if (!sendProductError(err, res)) throw err;
      }
    },
  );

  // PATCH /api/products/:id — Update product metadata
  r.patch("/:id", requirePermission("project.update"), async (req: Request, res: Response) => {
    try {
      await assertProductAccessible(req.user!, param(req.params.id));
      const input = updateProductSchema.parse(req.body);
      const product = await updateProduct(param(req.params.id), input);
      // #1258 — the response carries the repos, so it is filtered like a read.
      const canRead = await productRepoReadAccess(req.user!);
      res.json({ data: withReadableProductRepos(product, canRead) });
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
      // #1250 — the connection's own project must be accessible too.
      await assertRepoConnectionAttachable(req.user!, input.repoConnectionId);
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
        const productId = param(req.params.id);
        const repoId = param(req.params.repoId);
        await assertProductAccessible(req.user!, productId);
        // #1261 — detaching a repo the caller cannot read stays allowed (it is how
        // a cross-workspace row is cleaned up), but it is audited: read before the
        // row goes, recorded once it has.
        const hidden = await isProductRepoHiddenFrom(req.user!, productId, repoId);
        await removeProductRepo(productId, repoId);
        if (hidden) {
          audit({
            actor: { id: req.user!.userId },
            action: "product.repo.detach.unreadable",
            target: { type: "product", id: productId },
            metadata: { reason: "project-access-denied", repoConnectionId: repoId },
          });
        }
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
        // #1258 — a repo the caller cannot open is answered as not attached.
        await assertProductRepoReadable(req.user!, param(req.params.id), param(req.params.repoId));
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
            // #1261 — a connection soft-deleted after it was attached is not analysed.
            where: LIVE_PRODUCT_REPOS,
            include: {
              repoConnection: {
                select: {
                  id: true,
                  ownerOrOrg: true,
                  repoName: true,
                  defaultBranch: true,
                  projectId: true,
                },
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

      // #1258 — skip every repo whose project the caller cannot open (a row
      // attached across workspaces before #1257), and every edge touching one,
      // so another workspace's repository never feeds the generated documents.
      const canRead = await productRepoReadAccess(req.user!);
      const readable = product.repos.filter(canRead);
      const hidden = product.repos.filter((r) => !canRead(r));
      if (hidden.length > 0) {
        audit({
          actor: { id: req.user!.userId },
          action: "product.analyze.repo.skipped",
          target: { type: "product", id: productId },
          metadata: {
            reason: "project-access-denied",
            repoConnectionIds: hidden.map((r) => r.repoConnectionId),
          },
        });
      }
      const readableRepoIds = new Set(readable.map((r) => r.repoConnectionId));
      // #1618 — the generated documents are repo-to-repo, so an edge through a
      // resource with no target repo is not drawn in them.
      const readableEdges = product.edges.filter(
        (e): e is typeof e & { targetRepoId: string } =>
          e.targetRepoId !== null &&
          readableRepoIds.has(e.sourceRepoId) &&
          readableRepoIds.has(e.targetRepoId),
      );

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
        const repoInfos: ProductRepoInfo[] = readable.map((r) => ({
          repoConnectionId: r.repoConnectionId,
          repoName: r.repoConnection?.repoName ?? r.repoConnectionId,
          ownerOrOrg: r.repoConnection?.ownerOrOrg ?? "",
          role: r.role,
          defaultBranch: r.repoConnection?.defaultBranch ?? "main",
        }));
        const edgeInfos: ProductEdgeInfo[] = readableEdges.map((e) => ({
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

        // #1258 — what each document is built from, recorded in its metadata so
        // the documents read can drop one built from a repo the reader cannot
        // open. A per-service doc names its edge neighbours too.
        const sourcesOf = (repoId: string) => [
          repoId,
          ...edgeInfos.flatMap((e) =>
            e.sourceRepoId === repoId
              ? [e.targetRepoId]
              : e.targetRepoId === repoId
                ? [e.sourceRepoId]
                : [],
          ),
        ];

        // #1261 — mark, don't refuse. A document this run writes without a repo
        // it would otherwise have covered is shared with every reader, so it says
        // so: `partial` and how many repos it lacks (a count, never which). The
        // unified doc lacks every skipped repo; a per-repo doc lacks the skipped
        // repos it has an edge with. A full run writes `partial: false` over all.
        const skippedIds = new Set(hidden.map((r) => r.repoConnectionId));
        const coverage = (missing: number) => ({
          partial: missing > 0,
          inaccessibleRepoCount: missing,
        });
        const skippedNeighbours = (repoId: string) =>
          new Set(
            product.edges.flatMap((e) =>
              e.sourceRepoId === repoId && e.targetRepoId !== null && skippedIds.has(e.targetRepoId)
                ? [e.targetRepoId]
                : e.targetRepoId === repoId && skippedIds.has(e.sourceRepoId)
                  ? [e.sourceRepoId]
                  : [],
            ),
          ).size;
        const perRepoCoverage = (repoId: string | undefined) =>
          coverage(repoId ? skippedNeighbours(repoId) : 0);

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

        // Delete existing docs for this product then recreate. #1258 — only the
        // documents this run regenerates: the per-repo documents of a repo it
        // skipped stay for the readers who can open that repo.
        const skippedRepoIds = hidden.map((r) => r.repoConnectionId);
        await prisma.productDocument.deleteMany({
          where:
            skippedRepoIds.length === 0
              ? { productId }
              : { productId, OR: [{ repoId: null }, { repoId: { notIn: skippedRepoIds } }] },
        });

        const docsToCreate = [
          {
            productId,
            docType: "unified-architecture",
            title: unifiedDoc.title,
            content: unifiedDoc.content,
            repoId: null,
            metadata: JSON.stringify({
              ...unifiedDoc.metadata,
              repoConnectionIds: repoInfos.map((r) => r.repoConnectionId),
              ...coverage(skippedIds.size),
            }),
            generatedAt: now,
          },
          ...perServiceDocs.map((doc, i) => ({
            productId,
            docType: "per-service",
            title: doc.title,
            content: doc.content,
            repoId: repoInfos[i]?.repoConnectionId ?? null,
            metadata: JSON.stringify({
              ...doc.metadata,
              repoConnectionIds: repoInfos[i] ? sourcesOf(repoInfos[i].repoConnectionId) : [],
              ...perRepoCoverage(repoInfos[i]?.repoConnectionId),
            }),
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
                repoConnectionIds: repoInfos[i] ? [repoInfos[i].repoConnectionId] : [],
                contractVersion: result.version,
                contentHash: result.contentHash,
                diffSummary: result.diff ? summarizeContractDiff(result.diff) : "Initial version.",
                hasContractChanges: result.diff?.hasChanges ?? false,
                // A contract doc is built from its own repo's specs alone — no
                // edges — so a skipped neighbour leaves nothing out of it (#1262).
                ...coverage(0),
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
            inaccessibleRepoCount: hidden.length,
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
      // #1258 — drop every document built from a repo the caller cannot open.
      res.json({ data: await filterReadableProductDocuments(req.user!, productId, docs) });
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

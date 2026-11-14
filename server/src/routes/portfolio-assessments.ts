/**
 * /api/portfolio-assessments — Epic #1608 (#1625).
 *
 * A requirement checked across the product portfolio (#1622's engine), then
 * walked downstream from the products that must change (#1623's engine: the
 * `partial` products and an optional `hostProductId`), as an async job:
 *
 *   POST /             start one; 202 `{ id }`. Progress on `job:{id}`.
 *   GET  /             the newest assessments naming `?productId=`, or else the
 *                      caller's own
 *   GET  /:id          one assessment, as the caller may see it
 *   GET  /:id/export   the same, as Markdown (`?format=md`)
 *
 * Security:
 * - Every route: a pre-auth limiter, `requireAuth`, a per-user limiter and a
 *   permission (`analysis.run` to start, `analysis.read` to read). CSRF is the
 *   app-wide `csrfProtection` (#913), which runs before every `/api` router.
 * - `requirementId` must name a requirement in a project the caller can read;
 *   anything else is 404 (no existence oracle). So must (#2345) `analysisId` a
 *   live change request; its requirements are read by the server, never the form. So must (#2272) `documentId` a
 *   live document in such a project, and an `all-accessible` scope's
 *   `hostProductId` a product they can read.
 * - #2272 — a check started from a document records the document's project as
 *   its source project, so only a reader of that project may read the check
 *   (`viewPortfolioAssessment`): its statement and requirements are the
 *   document's words.
 * - Reads never trust what was stored: `viewPortfolioAssessment` re-filters
 *   every product and repo against the reader's access now.
 *
 * A run executes in this process only. It refreshes its row as it goes, and
 * `lib/portfolio/interrupted-assessments.ts` fails one whose refreshes
 * stopped, so a restart never leaves an assessment `running` for ever (#1657).
 */
import { userSourceReader } from "../lib/analysis/source-redaction.js";
import { Router } from "express";
import {
  PORTFOLIO_STATEMENT_MAX_CHARS,
  createPortfolioAssessmentSchema,
  parseAcceptanceCriteria,
  type ApiResponse,
  type AuthPayload,
  type PortfolioAssessmentListItem,
  type PortfolioNotChecked,
} from "@metis/shared";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  portfolioAssessmentPreAuthRateLimiter,
  portfolioAssessmentReadRateLimiter,
  portfolioAssessmentStartRateLimiter,
} from "../middleware/portfolio-assessments-rate-limit.js";
import { createChildLogger } from "../lib/logger.js";
import { genericFailureMessage, jobEvents } from "../lib/socket/job-events.js";
import {
  completePortfolioAssessment,
  createPortfolioAssessment,
  listPortfolioAssessmentIds,
  setPortfolioAssessmentStatus,
  touchPortfolioAssessment,
} from "../lib/portfolio/assessment-store.js";
import { PORTFOLIO_ASSESSMENT_HEARTBEAT_MS } from "../lib/portfolio/interrupted-assessments.js";
import {
  evaluatePortfolioGap,
  loadReadableSourceRequirement,
  mapWithConcurrency,
  portfolioGapInputSchema,
  scopedToChange,
  toAssessmentInput,
  type PortfolioGapDeps,
} from "../lib/portfolio/gap-engine.js";
import {
  directChangeProductIds,
  evaluatePortfolioImpact,
  withImpact,
  type PortfolioImpactDeps,
} from "../lib/portfolio/impact-engine.js";
import {
  generatePortfolioReport,
  reportContext,
  withReport,
  type PortfolioReportDeps,
} from "../lib/portfolio/assessment-report.js";
import { assertProductAccessible } from "../lib/products/product-access.js";
import { prisma } from "../lib/prisma.js";
import { canAccessProjectDiscussions } from "../lib/discussions/access.js";
import { getDocumentStorage } from "../lib/documents/storage.js";
import { isDocumentReaderEnabled } from "../lib/document-reader/flag.js";
import { readDocumentOnce } from "../lib/document-reader/reading-cache.js";
import { shapeAwareChangeExtractor } from "../lib/impact-analysis/change-request.js";
import type { ReadStoredFile } from "../lib/impact-analysis/document-source.js";
import { buildProvider } from "../lib/ai/providers/factory.js";
import {
  assertHasRequirements,
  restrictedNotChecked,
  changeRequestRef,
  loadChangeRequestSource,
  readableChangeRequest,
} from "../lib/analysis/change-request-source.js";
import { loadAIConfig } from "../lib/ai/config.js";
import type { AIProvider } from "../lib/ai/types.js";
import { estimateUsageCostUsd } from "../lib/ai/token-tracker.js";
import {
  boundedRequirements,
  cutText,
  NoDocumentRequirementsError,
  requirementsFromDocument,
  type PortfolioDocumentReader,
} from "../lib/portfolio/document-requirements.js";
import {
  renderPortfolioAssessmentMarkdown,
  resolveReaderAccess,
  toListItem,
  viewPortfolioAssessment,
} from "../lib/portfolio/assessment-view.js";

const log = createChildLogger("portfolio-assessments");

const KIND = "portfolio-assessment" as const;
/** Assessments one list returns. */
export const PORTFOLIO_ASSESSMENT_LIST_LIMIT = 25;
/** #1657 — rows one list request may look at to fill its page. */
export const PORTFOLIO_ASSESSMENT_LIST_SCAN = 100;
/** #1668 — views one list request builds at once. */
export const PORTFOLIO_ASSESSMENT_LIST_CONCURRENCY = 5;

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const notFound = () => new AppError(404, "NOT_FOUND", "Portfolio assessment not found");

const listQuerySchema = z
  .object({
    productId: z.string().min(1).max(64).optional(),
    // #2341 — the checks started from one change request's requirements.
    analysisId: z.string().min(1).max(64).optional(),
  })
  .refine((q) => !(q.productId && q.analysisId), "Filter by a product or a run, not both");
const exportQuerySchema = z.object({ format: z.literal("md").default("md") });

export interface PortfolioAssessmentsRouterDeps {
  /** Engine collaborators (tests inject a scripted model and search). */
  gap?: PortfolioGapDeps;
  /** Impact collaborators (#1623). */
  impact?: PortfolioImpactDeps;
  /** How often a running assessment refreshes its row (#1657); tests shorten it. */
  heartbeatMs?: number;
  /** Report collaborators (#1624); the model defaults to the gap engine's. */
  report?: Omit<PortfolioReportDeps, "signal">;
  /** #2272 — how a check started from a document reads it; tests inject these. */
  document?: {
    storage?: ReadStoredFile;
    /** Whether the model reads it (`ANALYSIS_DOCUMENT_READER`); default the flag. */
    readerEnabled?: () => boolean;
    /** The model reading; default the document reader on the gap engine's model. */
    reader?: PortfolioDocumentReader;
  };
}

/** #2272 — the document reader on `provider`, priced from its usage. */
function documentReaderOn(provider: AIProvider, signal?: AbortSignal): PortfolioDocumentReader {
  return async ({ title, text, document }) => {
    // #2280 — a saved reading of the same file, reader and model is reused (usage 0).
    const reading = await readDocumentOnce({
      title,
      text,
      provider,
      ...(signal ? { signal } : {}),
      ...(document ? { document } : {}),
    });
    return {
      reading,
      costUsd: estimateUsageCostUsd(provider.model, reading.usage, provider.key) ?? 0,
    };
  };
}

/**
 * #2272 — the document a check is started from, or 404: it must be live (not
 * soft-deleted) and in a project the caller can read, like a requirement
 * (`loadReadableSourceRequirement`). Unknown, deleted and unreadable answer
 * alike (no existence oracle). A readable one that is a repository's file, or
 * not yet `ready`, is a 400.
 */
async function loadReadableSourceDocument(
  user: AuthPayload,
  documentId: string,
): Promise<{ id: string; projectId: string; title: string }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      title: true,
      filename: true,
      source: true,
      status: true,
    },
  });
  if (
    !doc ||
    !(await canAccessProjectDiscussions({ id: user.userId, role: user.role }, doc.projectId))
  ) {
    throw new AppError(404, "NOT_FOUND", "Document not found");
  }
  // Only after the read check, so neither answer is an existence oracle. The page offers
  // neither; the API refuses them too: a repository's file is code, not requirements, and a
  // document still ingesting (or failed) has no text the check can rely on.
  if (doc.source === "repo") {
    throw new AppError(
      400,
      "DOCUMENT_NOT_CHECKABLE",
      "A repository file cannot be checked across the portfolio: choose an uploaded or imported document.",
    );
  }
  if (doc.status !== "ready") {
    throw new AppError(
      400,
      "DOCUMENT_NOT_READY",
      "This document is not ready yet: check it once it has finished processing.",
    );
  }
  return { id: doc.id, projectId: doc.projectId, title: doc.title ?? doc.filename };
}

/** What a run checks: its engine input, and what of its source it could not check (#2272). */
interface RunSource {
  input: ReturnType<typeof portfolioGapInputSchema.parse>;
  notChecked: PortfolioNotChecked[];
  /** #2272 — a document's requirements are read as the run starts, not in the request. */
  documentId: string | null;
  /** #2345 — the change request whose requirements are checked; null for any other source. */
  analysisId?: string | null;
  /** #2345 — a requirement checked is not approved (yet). */
  preApproval?: boolean;
}

/**
 * The engine's input for a start request, or 404 for a requirement or document
 * the caller cannot read. #2272 — nothing is cut silently: a requirement's text
 * past what one check reads, and criteria past the cap, are returned in
 * `notChecked`. A document's requirements are read when the run starts
 * ({@link resolveDocumentSource}); until then its statement names the document.
 */
async function gapInputFor(
  user: AuthPayload,
  body: ReturnType<typeof createPortfolioAssessmentSchema.parse>,
): Promise<RunSource> {
  const scoped = {
    scope: body.scope,
    productIds: body.scope === "product" ? (body.productIds ?? []) : [],
  };
  if (body.statement !== undefined) {
    return {
      input: portfolioGapInputSchema.parse({ statement: body.statement, ...scoped }),
      notChecked: [],
      documentId: null,
    };
  }
  if (body.documentId !== undefined) {
    const doc = await loadReadableSourceDocument(user, body.documentId);
    return {
      input: portfolioGapInputSchema.parse({
        statement: `Requirements read from "${doc.title.replace(/\s+/g, " ").trim().slice(0, 200)}"`,
        sourceProjectId: doc.projectId,
        ...scoped,
      }),
      notChecked: [],
      documentId: doc.id,
    };
  }
  if (body.analysisId !== undefined) {
    // #2345 — the change request's own requirements, read with the caller's
    // project access (404 for an unreadable one), never taken from the form.
    const changeRequest = await loadChangeRequestSource(
      body.analysisId,
      (projectId) => canAccessProjectDiscussions({ id: user.userId, role: user.role }, projectId),
      userSourceReader(user.userId),
    );
    assertHasRequirements(changeRequest);
    const criteria = boundedRequirements(
      changeRequest.requirements.map((r) => `${r.title}: ${r.body}`.trim()),
    );
    return {
      input: portfolioGapInputSchema.parse({
        statement: cutText(
          `Requirements of change request "${changeRequest.title}"`,
          PORTFOLIO_STATEMENT_MAX_CHARS,
        ).text,
        criteria: criteria.criteria,
        sourceProjectId: changeRequest.projectId,
        ...scoped,
      }),
      // #2447 — the requirements left out for their sources, counted.
      notChecked: [...restrictedNotChecked(changeRequest), ...criteria.notChecked],
      documentId: null,
      analysisId: changeRequest.id,
      preApproval: changeRequest.requirements.some((r) => !r.approved),
    };
  }
  // #1657 — a soft-deleted requirement is not found, like one that never existed.
  const requirement = await loadReadableSourceRequirement(user, body.requirementId!);
  const statement = cutText(
    `${requirement.title}\n\n${requirement.body}`.trim(),
    PORTFOLIO_STATEMENT_MAX_CHARS,
  );
  const criteria = boundedRequirements(parseAcceptanceCriteria(requirement.acceptanceCriteria));
  return {
    input: portfolioGapInputSchema.parse({
      statement: statement.text,
      criteria: criteria.criteria,
      sourceRequirementId: requirement.id,
      sourceProjectId: requirement.projectId,
      ...scoped,
    }),
    notChecked: [...(statement.entry ? [statement.entry] : []), ...criteria.notChecked],
    documentId: null,
    // #2345 — a requirement checked before it is approved is labelled so.
    preApproval: requirement.reviewStatus !== "approved",
  };
}

/**
 * #2272 — a document source's requirements, read now (the model reading takes
 * a while, so not in the start request): each is one criterion of the check.
 */
async function resolveDocumentSource(
  source: RunSource,
  deps: PortfolioAssessmentsRouterDeps,
): Promise<RunSource & { costUsd: number }> {
  if (!source.documentId) return { ...source, costUsd: 0 };
  const enabled = (deps.document?.readerEnabled ?? isDocumentReaderEnabled)();
  const reader = !enabled
    ? undefined
    : (deps.document?.reader ??
      documentReaderOn(
        deps.gap?.provider ?? buildProvider({ config: loadAIConfig() }),
        deps.gap?.signal,
      ));
  const read = await requirementsFromDocument(source.documentId, {
    prisma,
    storage: deps.document?.storage ?? { read: (path) => getDocumentStorage().read(path) },
    reader,
    extractor: shapeAwareChangeExtractor,
  });
  return {
    ...source,
    input: portfolioGapInputSchema.parse({
      ...source.input,
      statement: read.statement,
      criteria: read.criteria,
    }),
    notChecked: [...source.notChecked, ...read.notChecked],
    costUsd: read.costUsd,
  };
}

/**
 * #1657 — up to {@link PORTFOLIO_ASSESSMENT_LIST_LIMIT} assessments the reader
 * may read, newest first. Who may read a row is decided per row
 * (`viewPortfolioAssessment`), after the query, so rows are read a page at a
 * time until the list is full: filtering one page left it short while more
 * readable rows existed. At most {@link PORTFOLIO_ASSESSMENT_LIST_SCAN} rows
 * are looked at, so a reader who may see few of them costs a bounded scan.
 */
async function readablePage(
  access: Awaited<ReturnType<typeof resolveReaderAccess>>,
  filter: { productId: string } | { analysisId: string } | { createdById: string },
): Promise<PortfolioAssessmentListItem[]> {
  const items: PortfolioAssessmentListItem[] = [];
  let before: { createdAt: Date; id: string } | undefined;
  for (let scanned = 0; scanned < PORTFOLIO_ASSESSMENT_LIST_SCAN;) {
    const rows = await listPortfolioAssessmentIds({
      ...filter,
      take: PORTFOLIO_ASSESSMENT_LIST_LIMIT,
      before,
    });
    // #1668 — each view is a few queries; 25 at once took most of a Postgres pool.
    const views = await mapWithConcurrency(rows, PORTFOLIO_ASSESSMENT_LIST_CONCURRENCY, (r) =>
      viewPortfolioAssessment(access, r.id),
    );
    for (const view of views) {
      if (view && items.length < PORTFOLIO_ASSESSMENT_LIST_LIMIT) items.push(toListItem(view));
    }
    scanned += rows.length;
    if (items.length >= PORTFOLIO_ASSESSMENT_LIST_LIMIT) break;
    if (rows.length < PORTFOLIO_ASSESSMENT_LIST_LIMIT) break;
    before = rows[rows.length - 1];
  }
  return items;
}

/** Run an assessment created `pending` to `completed` or `failed`. Never throws. */
async function runAssessment(
  id: string,
  user: AuthPayload,
  source: RunSource,
  hostProductId: string | null,
  deps: PortfolioAssessmentsRouterDeps,
  heartbeatMs: number,
): Promise<void> {
  // #1657 — the heartbeat the interrupted-run sweep reads; stopped however the run ends.
  const heartbeat = setInterval(() => {
    touchPortfolioAssessment(id).catch((err: unknown) =>
      log.warn("Portfolio assessment heartbeat failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    // #1668 — only from `pending`: a row that ended already is not run.
    if (!(await setPortfolioAssessmentStatus(id, "running"))) return;
    jobEvents.started(KIND, id, null, "Portfolio assessment started");
    // #2272 — a document's requirements, read by the model (or split) first.
    const { input, notChecked, costUsd: readCostUsd } = await resolveDocumentSource(source, deps);
    const gap = await evaluatePortfolioGap(user, input, {
      ...deps.gap,
      // #2354 — the reading's cost counts against the run's cap, and is in the gap's cost.
      spentUsd: readCostUsd,
      onProgress: ({ done, total }) =>
        jobEvents.progress(
          KIND,
          id,
          null,
          Math.round((done / Math.max(total, 1)) * 100),
          `${done} of ${total} products checked`,
        ),
    });
    // #1623 — from the products that must change, the products downstream of them.
    const impact = await evaluatePortfolioImpact(
      user,
      {
        directChangeProductIds: directChangeProductIds(gap, hostProductId),
        listedProductIds: gap.productIds,
        hostProductId,
      },
      deps.impact,
    );
    // #1963 — the verdict over the products in scope of the change.
    const result = scopedToChange(gap, impact);
    // #1624 — the BA summary, impact paragraphs and restated requirements.
    const report = await generatePortfolioReport(reportContext(result, impact), {
      provider: deps.report?.provider ?? deps.gap?.provider,
      costOf: deps.report?.costOf ?? deps.gap?.costOf,
      signal: deps.gap?.signal,
    });
    const record = toAssessmentInput(result, {
      createdById: user.userId,
      sourceRequirementId: input.sourceRequirementId ?? null,
      sourceProjectId: input.sourceProjectId ?? null,
    });
    const written = await completePortfolioAssessment(
      id,
      withReport(
        withImpact(
          {
            ...record,
            // #2272 — what its source could not give the check, then what the run did not check.
            notChecked: [...notChecked, ...(record.notChecked ?? [])],
          },
          impact,
        ),
        report,
      ),
    );
    if (!written) {
      // #1668 — the sweep failed it while it stalled, and said so: failed is final.
      log.warn("Portfolio assessment finished after it was failed; result not stored", { id });
      return;
    }
    jobEvents.completed(KIND, id, null, "Portfolio assessment completed");
  } catch (err) {
    log.error("Portfolio assessment failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    // #2272 — a document with no requirement to check says so, on the page and in the export:
    // its message is METIS's own (never a provider's), so it is safe to show.
    const reason = err instanceof NoDocumentRequirementsError ? err.message : null;
    const statement = reason
      ? cutText(`${source.input.statement}: ${reason}`, PORTFOLIO_STATEMENT_MAX_CHARS).text
      : undefined;
    const moved = await setPortfolioAssessmentStatus(id, "failed", statement).catch(
      (e: unknown) => {
        log.error("Could not record a failed portfolio assessment", {
          id,
          error: e instanceof Error ? e.message : String(e),
        });
        return true;
      },
    );
    // #1668 — a row the sweep failed already had its failed event.
    if (moved) jobEvents.failed(KIND, id, null, reason ?? genericFailureMessage(KIND));
  } finally {
    clearInterval(heartbeat);
  }
}

export function portfolioAssessmentsRouter(deps: PortfolioAssessmentsRouterDeps = {}): Router {
  const r = Router();

  r.post(
    "/",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentStartRateLimiter,
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const user = req.user!;
        const body = createPortfolioAssessmentSchema.parse(req.body);
        // #2351 — a scope is validated here, not trusted from the picker: every
        // product it names must be one the caller can read now (the reads' own
        // rule), else the start is refused like a missing product (404), and
        // nothing is stored. Before, an unreadable one was stored `restricted`.
        if (body.scope === "product") {
          const access = await resolveReaderAccess(user);
          if (!access.admin && (body.productIds ?? []).some((id) => !access.products.has(id))) {
            throw new AppError(404, "NOT_FOUND", "Product not found");
          }
        }
        const source = await gapInputFor(user, body);
        const { input } = source;
        const hostProductId = body.hostProductId ?? null;
        // A host the caller cannot read is answered like a missing one (no existence oracle).
        if (hostProductId && body.scope === "all-accessible") {
          await assertProductAccessible(user, hostProductId);
        }
        const id = await createPortfolioAssessment({
          statement: input.statement,
          sourceRequirementId: input.sourceRequirementId,
          sourceProjectId: input.sourceProjectId,
          // #2272 — the document whose requirements it checks.
          sourceDocumentId: source.documentId,
          // #2345 — the change request it was started from, and whether it ran before approval.
          sourceAnalysisId: source.analysisId ?? null,
          preApproval: source.preApproval ?? false,
          scope: input.scope,
          productIds: input.productIds,
          // #1725 — stored so the page can say which product will build it.
          hostProductId,
          status: "pending",
          createdById: user.userId,
        });
        res.status(202).json(ok({ id }));
        void runAssessment(
          id,
          user,
          source,
          hostProductId,
          deps,
          deps.heartbeatMs ?? PORTFOLIO_ASSESSMENT_HEARTBEAT_MS,
        );
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentReadRateLimiter,
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const user = req.user!;
        const { productId, analysisId } = listQuerySchema.parse(req.query);
        const access = await resolveReaderAccess(user);
        // A product the caller cannot read lists nothing, like one with no assessments.
        if (productId && !access.admin && !access.products.has(productId)) {
          res.json(ok([]));
          return;
        }
        // #2345 — and a change request whose project the caller cannot read, like
        // an unknown one: each row is re-checked below too, but a check with no
        // recorded source project would otherwise pass on its products alone.
        if (
          analysisId &&
          !(await readableChangeRequest(
            analysisId,
            async (pid) => access.admin || (await access.canReadProject(pid)),
          ))
        ) {
          res.json(ok([]));
          return;
        }
        // #2341 — a run's checks are re-filtered per row like any other list:
        // a check of a project the caller cannot read now is not listed.
        const filter = productId
          ? { productId }
          : analysisId
            ? { analysisId }
            : { createdById: user.userId };
        res.json(ok(await readablePage(access, filter)));
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/:id",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentReadRateLimiter,
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const access = await resolveReaderAccess(req.user!);
        const view = await viewPortfolioAssessment(access, String(req.params.id));
        if (!view) throw notFound();
        // #2345 — the change request it was started from, for the link back. The
        // view is readable only by a reader of its source project, and the change
        // request is looked up in that project alone.
        const changeRequest = await changeRequestRef(
          view.sourceAnalysisId,
          view.sourceProjectId ? [view.sourceProjectId] : [],
        );
        res.json(ok({ ...view, changeRequest }));
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/:id/export",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentReadRateLimiter,
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        exportQuerySchema.parse(req.query);
        const access = await resolveReaderAccess(req.user!);
        const view = await viewPortfolioAssessment(access, String(req.params.id));
        if (!view) throw notFound();
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        // `view.id` is the stored id, never the raw path segment.
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="portfolio-assessment-${view.id}.md"`,
        );
        res.send(renderPortfolioAssessmentMarkdown(view));
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}

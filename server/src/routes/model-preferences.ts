/**
 * Model preference routes (Epic #593 / Issue #602).
 *
 * Endpoints:
 *   GET  /api/projects/:projectId/model-preferences  — read preferences
 *   PUT  /api/projects/:projectId/model-preferences  — upsert preferences
 *   GET  /api/projects/:projectId/analyses/model-recommendation — get recommendation (#600)
 *
 * #713 — the preferences list the models the ACTIVE provider runs, as the
 * recommendation does (#512): the router's Claude tiers where the provider serves
 * them, otherwise the provider's own configured model, priced by the catalog for
 * that endpoint. DeepSeek's Anthropic-compatible endpoint, for one, remaps every
 * `claude-*` id, so offering one there pinned a model the run never used, at a
 * price it never paid.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import {
  ModelRouter,
  HAIKU_MODEL_ID,
  SONNET_MODEL_ID,
  FABLE_MODEL_ID,
  OPUS_MODEL_ID,
  LEGACY_SONNET_MODEL_ID,
  ModelNotServedError,
  isOfflineStub,
  type RouterProvider,
} from "../lib/ai/model-router.js";
import { getModelCatalog, routerCatalog } from "../lib/ai/model-catalog.js";
import { loadAIConfig } from "../lib/ai/config.js";
import { buildProvider } from "../lib/ai/providers/factory.js";
import type { AIProvider } from "../lib/ai/types.js";
import type { ModelCatalogEntry } from "@metis/shared";
import { createChildLogger } from "../lib/logger.js";
import {
  estimateAnalysisRunTokens,
  profileAnalysisRun,
  readAgentCountFromMetadata,
} from "../lib/ai/analysis-run-estimate.js";
import { getProjectMonthlyAnalysisTokens } from "../lib/analysis/cost-cap.js";
import { getOrchestrator } from "../lib/analysis/orchestrator.js";

const log = createChildLogger("model-preferences");

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

// LEGACY_SONNET_MODEL_ID stays accepted (not listed in availableModels) so
// preferences saved before the Sonnet 5 rename keep validating.
const validModelIds = [
  "auto",
  HAIKU_MODEL_ID,
  SONNET_MODEL_ID,
  FABLE_MODEL_ID,
  OPUS_MODEL_ID,
  LEGACY_SONNET_MODEL_ID,
] as const;

const modelPreferenceSchema = z.object({
  // A tier id, or (#713) the active provider's configured model — checked in
  // the handler, because which one is valid depends on the provider.
  defaultModel: z.string().min(1).max(200).nullable().optional(),
  taskTypeOverrides: z.record(z.string(), z.string()).optional(),
  budgetDowngradeThreshold: z.number().int().positive().nullable().optional(),
});

const overrideSchema = z
  .enum(["auto", "force-haiku", "force-sonnet", "force-fable", "force-opus"])
  .catch("auto");

export function initModelPreferenceRouter(): Router {
  const router = Router({ mergeParams: true });

  // GET /api/projects/:projectId/model-preferences
  router.get(
    "/",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      await ensureProjectExists(projectId);

      const pref = await prisma.modelPreference.findUnique({
        where: { projectId },
      });
      const provider = activeRouterProvider();

      res.json(
        ok({
          projectId,
          defaultModel: pref?.defaultModel ?? null,
          taskTypeOverrides: pref ? safeParse(pref.taskTypeOverrides) : {},
          budgetDowngradeThreshold: pref?.budgetDowngradeThreshold ?? null,
          // #135 — the router's models as the catalog describes them (name,
          // tier, context window, price, capabilities) — the settings picker
          // renders from this, never from a list of its own. #713 — only the
          // ones the active provider runs.
          availableModels: await availableModelsFor(provider),
          // #713 — the picker's wording (tier downgrade or not) follows this.
          servesTierModels: servesTierModels(provider),
        }),
      );
    },
  );

  // PUT /api/projects/:projectId/model-preferences
  router.put(
    "/",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      await ensureProjectExists(projectId);

      const parsed = modelPreferenceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid model preference payload", {
          issues: parsed.error.flatten(),
        });
      }

      const defaultModel = parsed.data.defaultModel ?? null;
      if (defaultModel !== null && !acceptsDefaultModel(defaultModel, activeRouterProvider())) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid model preference payload", {
          issues: { fieldErrors: { defaultModel: ["Not a model this deployment can run"] } },
        });
      }

      const data = {
        defaultModel,
        taskTypeOverrides: JSON.stringify(parsed.data.taskTypeOverrides ?? {}),
        budgetDowngradeThreshold: parsed.data.budgetDowngradeThreshold ?? null,
      };

      const pref = await prisma.modelPreference.upsert({
        where: { projectId },
        create: { projectId, ...data },
        update: data,
      });

      res.json(
        ok({
          projectId,
          defaultModel: pref.defaultModel,
          taskTypeOverrides: safeParse(pref.taskTypeOverrides),
          budgetDowngradeThreshold: pref.budgetDowngradeThreshold,
        }),
      );
    },
  );

  return router;
}

/**
 * Shape of the run the caller is about to start. Issue #1095: the endpoint used
 * to take NO parameter describing the run, so it classified a constant sentence
 * and answered 16 tokens / "simple" for every project regardless of workload.
 */
const runShapeSchema = z.object({
  override: overrideSchema.optional(),
  agentKeys: z.array(z.string().min(1).max(64)).max(16).default([]),
  /**
   * The requirement text the user typed. Carried in a POST body (not a query
   * string) precisely so a long paste is classified in full rather than
   * truncated to fit a URL.
   */
  requirementText: z.string().max(20_000).default(""),
});

/** How many recent completed runs feed the empirical estimate. */
const HISTORY_SAMPLE_SIZE = 10;

/**
 * Model recommendation endpoint (Epic #593 / Issue #600, fixed in #1095).
 * Mounted as a sub-route of the analysis project-scoped router.
 */
export function initModelRecommendationRouter(): Router {
  const router = Router({ mergeParams: true });

  const handle = async (req: Request, res: Response): Promise<void> => {
    const projectId = String(req.params.projectId);
    await ensureProjectExists(projectId);

    // GET keeps working for callers that only want the override applied; POST
    // carries the full run shape (agents + requirement text) without truncation.
    const raw =
      req.method === "POST"
        ? (req.body ?? {})
        : {
            override: req.query.override,
            agentKeys:
              typeof req.query.agentKeys === "string" && req.query.agentKeys.length > 0
                ? req.query.agentKeys.split(",")
                : [],
            requirementText:
              typeof req.query.requirementText === "string" ? req.query.requirementText : "",
          };

    const parsed = runShapeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid run shape", {
        issues: parsed.error.flatten(),
      });
    }
    const override = overrideSchema.parse(parsed.data.override ?? "auto");

    const pref = await prisma.modelPreference.findUnique({ where: { projectId } });

    // #1095 — the empirical estimate: this project's own completed runs. The
    // previous implementation had no workload input at all, which is why the
    // answer was a constant.
    const priorRuns = await prisma.analysis.findMany({
      where: { projectId, status: "completed", deletedAt: null },
      orderBy: { startedAt: "desc" },
      take: HISTORY_SAMPLE_SIZE,
      select: { totalTokens: true, metadata: true },
    });
    const estimate = estimateAnalysisRunTokens(
      priorRuns.map((r) => ({
        totalTokens: r.totalTokens ?? 0,
        agentCount: readAgentCountFromMetadata(r.metadata),
      })),
      parsed.data.agentKeys.length,
    );

    const profile = profileAnalysisRun({
      requirementText: parsed.data.requirementText,
      agentKeys: parsed.data.agentKeys,
      estimatedTokens: estimate.tokens,
    });

    // #1095 (second defect) — budget awareness read `TokenUsage`, which the
    // analysis pipeline never writes, so it was always 0 and the downgrade guard
    // could not trip. Read the same table the cost-cap header reads, scoped to
    // this project, so the two numbers can no longer disagree.
    const currentMonthTokens = await getProjectMonthlyAnalysisTokens(projectId);

    // #978 — a forced tier this provider cannot run is a 400, not a card that
    // quietly names a different model.
    const provider = activeRouterProvider();
    try {
      new ModelRouter({ provider }).assertServable(override);
    } catch (err) {
      if (err instanceof ModelNotServedError) {
        throw new AppError(400, err.code, err.message, {
          requested: err.requested,
          configuredModel: err.configuredModel,
        });
      }
      throw err;
    }

    const modelRouter = new ModelRouter({
      preferences: pref
        ? {
            defaultModel: pref.defaultModel ?? undefined,
            taskTypeOverrides: safeParse(pref.taskTypeOverrides),
            budgetDowngradeThreshold: pref.budgetDowngradeThreshold,
          }
        : undefined,
      currentMonthTokens,
      provider,
    });

    const selection = modelRouter.select(profile, override);

    res.json(
      ok({
        profile,
        selection,
        estimate,
        // #978 — the panel offers the forced tiers only where the provider
        // serves them (the model preferences' rule, #713); otherwise Auto and
        // this configured model.
        servesTierModels: servesTierModels(provider),
        configuredModel: provider?.model ?? null,
      }),
    );
  };

  // Object-level scope (#674) is applied HERE rather than being inherited from
  // the `/projects/:projectId/analyses` mount that happens to sit in front of
  // this one in the router table. That inheritance is a registration-order
  // side effect; stating the guard on the router that owns the handlers keeps it
  // true if the mount order ever changes.
  router.get("/", requireAuth, requireProjectAccess(), requirePermission("analysis.read"), handle);
  router.post("/", requireAuth, requireProjectAccess(), requirePermission("analysis.read"), handle);

  return router;
}

/** One option of the settings picker. */
interface AvailableModel {
  id: string;
  name: string;
  /** The router tier, or `configured` for the provider's own model (#713). */
  tier: string;
  contextWindow: number | null;
  price: ModelCatalogEntry["price"];
  capabilities: ModelCatalogEntry["capabilities"];
}

/** The provider the preferences describe; `offline` marks the stub. */
type PreferenceProvider = RouterProvider & Partial<Pick<AIProvider, "offline">>;

/**
 * #713 — true when the router's Claude tier ids run as sent. With no resolvable
 * provider, or on the offline stub, the tier list is reported unchanged, as
 * before.
 */
function servesTierModels(provider: PreferenceProvider | undefined): boolean {
  if (!provider || isOfflineStub(provider)) return true;
  return routerCatalog().some((m) => provider.servesRouterModel?.(m.id) === true);
}

/**
 * #713 — the models a project can pick: the router tiers the provider serves,
 * or else the one model it is configured to run, described by the catalog for
 * that endpoint (`GET /api/ai/models` — DeepSeek's own price, never Anthropic's;
 * an unknown price stays `null`).
 */
async function availableModelsFor(
  provider: PreferenceProvider | undefined,
): Promise<AvailableModel[]> {
  if (servesTierModels(provider)) {
    return routerCatalog()
      .filter(
        (m) => !provider || isOfflineStub(provider) || provider.servesRouterModel?.(m.id) === true,
      )
      .map((m) => ({
        id: m.id,
        name: m.displayName,
        tier: m.routerTier ?? "configured",
        contextWindow: m.contextWindow,
        price: m.price,
        capabilities: m.capabilities,
      }));
  }
  const model = provider!.model;
  let entry: ModelCatalogEntry | undefined;
  try {
    const catalog = await getModelCatalog({ config: loadAIConfig() });
    entry = catalog.models.find((m) => m.id === model);
  } catch (err) {
    log.warn("Could not describe the configured model for the model preferences", {
      error: (err as Error).message,
    });
  }
  return [
    {
      id: model,
      name: entry?.displayName ?? model,
      tier: "configured",
      contextWindow: entry?.contextWindow ?? null,
      price: entry?.price ?? null,
      capabilities: entry?.capabilities ?? {
        tools: false,
        jsonSchema: false,
        jsonObject: false,
        vision: false,
        thinking: false,
      },
    },
  ];
}

/**
 * #713 — a default model a project may save: `auto`; a router tier id (the
 * current ones, and the legacy Sonnet id saved before the Sonnet 5 rename) only
 * where the provider serves the tiers — the same test that decides whether GET
 * lists them; or the active provider's configured model.
 */
function acceptsDefaultModel(id: string, provider: PreferenceProvider | undefined): boolean {
  if (id === "auto") return true;
  if ((validModelIds as readonly string[]).includes(id) && servesTierModels(provider)) return true;
  return provider !== undefined && id === provider.model;
}

/**
 * #512 — the provider an analysis run uses, so the Model card names the model
 * the run will actually use. The booted analysis orchestrator's own provider
 * when there is one (it is built once at boot, so a config built per request
 * could disagree with it after a runtime change); otherwise one built from the
 * same configuration the orchestrator is lazily booted from, which makes no
 * network call. A configuration that cannot be loaded leaves the
 * recommendation on tier routing (the run itself will surface that error)
 * rather than failing the form.
 */
function activeRouterProvider(): PreferenceProvider | undefined {
  try {
    return getOrchestrator().provider;
  } catch {
    // Not booted yet — fall through to the configuration.
  }
  try {
    return buildProvider({ config: loadAIConfig() });
  } catch (err) {
    log.warn("Could not resolve the active AI provider for the model recommendation", {
      error: (err as Error).message,
    });
    return undefined;
  }
}

async function ensureProjectExists(projectId: string): Promise<void> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
}

function safeParse(json: string): Record<string, string> {
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}

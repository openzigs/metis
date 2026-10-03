/**
 * Epic #195 — `apply_diff` tool registration.
 *
 * Wraps the {@link DiffApplyClient} as a registered AI tool so agents can
 * invoke morph-apply through the standard {@link ToolRegistry.invoke}
 * pipeline (zod validation + risk gate + audit). Whenever Morph fails the
 * tool falls back to a local whole-file rewrite so the run never aborts.
 *
 * Cost telemetry: every successful invocation records to the per-user token
 * tracker (`ai_token_usages`) with a `morph:` model prefix, and — when the
 * session belongs to a project — to the project ledger (`token_usages`, #792)
 * so the project usage page and budget count it.
 */
import { z } from "zod";
import {
  DiffApplyClient,
  DiffApplyClientError,
  isMorphApplyEnabled,
} from "../diff-apply-client.js";
import { getTokenTracker } from "../token-tracker.js";
import { recordUsage } from "../../finops/token-tracker.js";
import { prisma } from "../../prisma.js";
import type { ToolDefinition, ToolResult, ToolContext } from "../types.js";

export const APPLY_DIFF_TOOL_NAME = "apply_diff";

/** #792 — the step label morph spend carries on the project ledger. */
export const APPLY_DIFF_AGENT_STEP = "chat.apply-diff";

/**
 * #792 — the project a call is billed to: the tool context's own scope, else
 * the chat session's project. `null` when neither names one (a session with no
 * project has no project page to land on).
 */
async function resolveProjectId(ctx: ToolContext): Promise<string | null> {
  if (ctx.projectId) return ctx.projectId;
  const session = await prisma.aISession.findUnique({
    where: { id: ctx.sessionId },
    select: { projectId: true },
  });
  return session?.projectId ?? null;
}

export const applyDiffSchema = z.object({
  original: z.string().min(0),
  patch: z.string().min(1),
  path: z.string().optional(),
  model: z.string().optional(),
});

export type ApplyDiffArgs = z.infer<typeof applyDiffSchema>;

export interface ApplyDiffDeps {
  client?: DiffApplyClient;
  /** Override the enabled gate — test seam. */
  isEnabled?: () => boolean;
  /** Override the fallback whole-file applier — test seam. */
  fallback?: (args: ApplyDiffArgs) => string;
}

/**
 * Naïve whole-file fallback. Treats `patch` as the new file body when no
 * unified-diff parser is available. Inferior to morph but never crashes
 * the run.
 */
export function defaultFallback(args: ApplyDiffArgs): string {
  if (args.patch.startsWith("---") || args.patch.startsWith("@@")) {
    // The patch is unified-diff-shaped but we can't apply it locally — surface
    // the original so the agent knows the apply was a no-op rather than a
    // silent overwrite.
    return args.original;
  }
  return args.patch;
}

export function createApplyDiffTool(
  deps: ApplyDiffDeps = {},
): ToolDefinition<typeof applyDiffSchema> {
  const isEnabled = deps.isEnabled ?? isMorphApplyEnabled;
  const fallback = deps.fallback ?? defaultFallback;

  return {
    name: APPLY_DIFF_TOOL_NAME,
    description:
      "Apply an LLM-emitted patch to file contents using the morph-apply provider. Falls back to a whole-file rewrite when morph-apply is disabled or upstream fails.",
    schema: applyDiffSchema,
    risk: "medium",
    async exec(args: ApplyDiffArgs, ctx: ToolContext): Promise<ToolResult> {
      const start = Date.now();
      if (!isEnabled()) {
        const content = fallback(args);
        return {
          text: content,
          data: {
            content,
            provider: "fallback",
            durationMs: Date.now() - start,
          },
        };
      }
      const client = deps.client ?? new DiffApplyClient();
      try {
        const out = await client.apply(args);
        // Record to FinOps so /usage shows morph spend alongside chat.
        try {
          getTokenTracker().record({
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            // The provider key registered in TokenTracker is constrained to
            // the AI engine's `ProviderKey` union. We tag the model with a
            // `morph:` prefix so dashboards can filter morph traffic without
            // adding a new provider key (which would fan out across the
            // entire cost-cap codebase).
            provider: "openai",
            model: `morph:${out.model}`,
            usage: {
              promptTokens: out.usage.promptTokens,
              completionTokens: out.usage.completionTokens,
              totalTokens: out.usage.totalTokens,
            },
          });
        } catch (err) {
          ctx.log?.error("apply_diff failed to record FinOps usage", {
            error: (err as Error).message,
          });
        }
        // #792 — the project page reads ONE ledger, `token_usages`. The row
        // above lands only in the per-user store (`ai_token_usages`), so
        // morph spend would leave the project's cards, analytics, CSV and
        // budget. Each reader reads exactly one of the two tables, so writing
        // the call to both counts it once in each view, never twice.
        try {
          const projectId = await resolveProjectId(ctx);
          if (projectId) {
            recordUsage({
              projectId,
              sessionId: ctx.sessionId,
              ...(ctx.userId ? { userId: ctx.userId } : {}),
              agentStep: APPLY_DIFF_AGENT_STEP,
              provider: "openai",
              model: `morph:${out.model}`,
              inputTokens: out.usage.promptTokens,
              outputTokens: out.usage.completionTokens,
            });
          }
        } catch (err) {
          ctx.log?.error("apply_diff failed to record project usage", {
            error: (err as Error).message,
          });
        }
        return {
          text: out.content,
          data: {
            content: out.content,
            provider: "morph",
            model: out.model,
            usage: out.usage,
            durationMs: out.durationMs,
          },
        };
      } catch (err) {
        const isUpstream = err instanceof DiffApplyClientError;
        ctx.log?.error("apply_diff morph call failed; falling back", {
          status: isUpstream ? err.status : null,
          error: (err as Error).message,
        });
        const content = fallback(args);
        return {
          text: content,
          data: {
            content,
            provider: "fallback",
            durationMs: Date.now() - start,
            error: (err as Error).message,
          },
        };
      }
    },
  };
}

/**
 * Register the tool against a `ToolRegistry` instance. Idempotent: if the
 * tool is already registered (e.g. test reload) it's unregistered first
 * so re-registration succeeds.
 */
export function registerApplyDiff(
  registry: { register: (t: ToolDefinition) => void; unregister: (n: string) => boolean },
  deps: ApplyDiffDeps = {},
): void {
  registry.unregister(APPLY_DIFF_TOOL_NAME);
  registry.register(createApplyDiffTool(deps) as unknown as ToolDefinition);
}

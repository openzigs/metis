/**
 * `search-knowledge` AI tool (Phase 5 / issue #43).
 *
 * Wires the `KnowledgeService` into the existing AI tool registry so chat
 * sessions can retrieve project-scoped chunks at inference time. Risk is set
 * to `low`: the tool is read-only and per-project scoped (the service rejects
 * cross-project lookups by construction — see `vector-store.ts`).
 */
import { z } from "zod";
import { DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K } from "@metis/shared";
import type { ToolDefinition } from "../ai/types.js";
import { getToolRegistry } from "../ai/tool-registry.js";
import { getKnowledgeService, type KnowledgeService } from "./knowledge-service.js";

const argsSchema = z.object({
  projectId: z.string().min(1).max(120),
  query: z.string().min(1).max(2048),
  k: z.number().int().min(1).max(MAX_RETRIEVE_K).optional(),
  documentIds: z.array(z.string().min(1).max(120)).max(100).optional(),
});

export interface BuildSearchKnowledgeToolOptions {
  service?: KnowledgeService;
}

export function buildSearchKnowledgeTool(
  opts: BuildSearchKnowledgeToolOptions = {},
): ToolDefinition<typeof argsSchema> {
  return {
    name: "search-knowledge",
    description:
      "Retrieve the top-k most relevant document chunks from a project's knowledge base. Returns ranked snippets with source attribution.",
    risk: "low",
    schema: argsSchema,
    async exec(args, ctx) {
      const service = opts.service ?? getKnowledgeService();
      // Belt-and-braces: if a session is bound to a project, the requested
      // projectId MUST match it. This is the bedrock of the per-project
      // isolation guarantee called out in the security focus.
      if (ctx.projectId && ctx.projectId !== args.projectId) {
        return {
          text: "ERROR: cross-project knowledge access is not permitted",
          isError: true,
        };
      }
      const { hits, coverageWarning } = await service.search(args.projectId, args.query, {
        k: args.k ?? DEFAULT_RETRIEVE_K,
        documentIds: args.documentIds,
      });
      const lines = hits.map(
        (h, i) => `[${i + 1}] (score=${h.score.toFixed(4)}) ${h.filename}#${h.position}\n${h.text}`,
      );
      const header = coverageWarning
        ? `⚠️ Partial coverage: ${coverageWarning.matchingChunks}/${coverageWarning.totalChunks} chunks match the current model '${coverageWarning.currentModel}'. Other models present: ${coverageWarning.mismatchedModels.join(", ")}.\n\n`
        : "";
      return {
        text: hits.length === 0 ? `${header}(no matches)` : `${header}${lines.join("\n\n---\n\n")}`,
        data: { hits, coverageWarning },
      };
    },
  };
}

let registered = false;

/** Idempotent registration. Safe to call from both runtime and tests. */
export function registerSearchKnowledgeTool(opts: BuildSearchKnowledgeToolOptions = {}): void {
  const registry = getToolRegistry();
  if (registry.has("search-knowledge")) registered = true;
  if (registered) return;
  registry.register(buildSearchKnowledgeTool(opts));
  registered = true;
}

/** Test seam — re-registration without leaking state across specs. */
export function __resetSearchKnowledgeRegistration(): void {
  const registry = getToolRegistry();
  registry.unregister("search-knowledge");
  registered = false;
}

/**
 * Issue #534 — `search-knowledge-global` AI tool.
 *
 * Cross-project knowledge search tool for AI sessions that are not bound to
 * a single project. Calls FederatedSearchService to search across all (or
 * selected) projects the user has access to.
 *
 * Unlike `search-knowledge`, this tool does NOT require `ctx.projectId` —
 * it works in unscoped sessions (e.g., the global Chat page without a
 * project binding).
 */
import { z } from "zod";
import { MAX_RETRIEVE_K, DEFAULT_RETRIEVE_K } from "@metis/shared";
import type { ToolDefinition } from "../ai/types.js";
import { getToolRegistry } from "../ai/tool-registry.js";
import {
  getFederatedSearchService,
  type FederatedSearchService,
} from "./federated-search-service.js";

const argsSchema = z.object({
  query: z.string().min(1).max(2048),
  projectIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  k: z.number().int().min(1).max(MAX_RETRIEVE_K).optional(),
});

export interface BuildSearchKnowledgeGlobalToolOptions {
  service?: FederatedSearchService;
}

export function buildSearchKnowledgeGlobalTool(
  opts: BuildSearchKnowledgeGlobalToolOptions = {},
): ToolDefinition<typeof argsSchema> {
  return {
    name: "search-knowledge-global",
    description:
      "Search across multiple projects' knowledge bases simultaneously. Returns ranked document chunks with project provenance. Use when the user wants information that may span multiple projects.",
    risk: "low",
    schema: argsSchema,
    async exec(args, ctx) {
      if (!ctx.userId) {
        return {
          text: "ERROR: authentication required for cross-project search",
          isError: true,
        };
      }

      const service = opts.service ?? getFederatedSearchService();
      const result = await service.searchAcrossProjects({
        userId: ctx.userId,
        projectIds: args.projectIds,
        query: args.query,
        k: args.k ?? DEFAULT_RETRIEVE_K,
      });

      if (result.hits.length === 0) {
        const failNote =
          result.projectsFailed.length > 0
            ? ` (${result.projectsFailed.length} project(s) failed to respond)`
            : "";
        return {
          text: `(no matches across ${result.projectsSearched.length} project(s)${failNote})`,
        };
      }

      const lines = result.hits.map(
        (h, i) =>
          `[${i + 1}] (score=${h.score.toFixed(4)}) [${h.projectName}] ${h.filename}#${h.position}\n${h.text}`,
      );

      const header =
        result.projectsFailed.length > 0
          ? `⚠️ ${result.projectsFailed.length} project(s) timed out or failed.\n\n`
          : "";

      const footer = `\n\n---\nSearched ${result.projectsSearched.length} project(s). ${result.totalHits} result(s).`;

      return {
        text: `${header}${lines.join("\n\n---\n\n")}${footer}`,
        data: result,
      };
    },
  };
}

let registered = false;

/** Idempotent registration. Safe to call from both runtime and tests. */
export function registerSearchKnowledgeGlobalTool(
  opts: BuildSearchKnowledgeGlobalToolOptions = {},
): void {
  const registry = getToolRegistry();
  if (registry.has("search-knowledge-global")) registered = true;
  if (registered) return;
  registry.register(buildSearchKnowledgeGlobalTool(opts));
  registered = true;
}

/** Test seam — re-registration without leaking state across specs. */
export function __resetSearchKnowledgeGlobalRegistration(): void {
  const registry = getToolRegistry();
  registry.unregister("search-knowledge-global");
  registered = false;
}

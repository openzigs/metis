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
import { formatDerivedLabel } from "./derived-label.js";

const argsSchema = z.object({
  // #736 — optional: a project-scoped chat session is already bound to its
  // project, and the model cannot know the project's cuid (it passed the
  // project's NAME and every call failed). Only an unbound caller needs it.
  projectId: z.string().min(1).max(120).optional(),
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
      "Retrieve the top-k most relevant document chunks from a project's knowledge base. Returns ranked snippets with source attribution. " +
      "In a project-scoped session, omit projectId: the session's own project is always searched.",
    risk: "low",
    schema: argsSchema,
    async exec(args, ctx) {
      const service = opts.service ?? getKnowledgeService();
      // Per-project isolation (#43): a session bound to a project searches THAT
      // project and nothing else. #736 — the argument is never used to pick
      // another project; a mismatched one (typically the project's display
      // name) is ignored with a note, rather than failing the call and burning
      // one of the model's steps on an id it has no way to know.
      const projectId = ctx.projectId || args.projectId;
      if (!projectId) {
        return {
          text: "ERROR: projectId is required outside a project-scoped session",
          isError: true,
        };
      }
      const ignoredArg =
        Boolean(ctx.projectId) && args.projectId !== undefined && args.projectId !== ctx.projectId;
      const { hits, coverageWarning } = await service.search(projectId, args.query, {
        k: args.k ?? DEFAULT_RETRIEVE_K,
        documentIds: args.documentIds,
      });
      const lines = hits.map(
        (h, i) =>
          `[${i + 1}] (score=${h.score.toFixed(4)}) ${h.filename}#${h.position}${formatDerivedLabel(h.derived)}\n${h.text}`,
      );
      const note = ignoredArg
        ? "Note: this session is bound to its project, which was searched; the projectId argument was ignored (omit it).\n\n"
        : "";
      const warning = coverageWarning
        ? `⚠️ Partial coverage: ${coverageWarning.matchingChunks}/${coverageWarning.totalChunks} chunks match the current model '${coverageWarning.currentModel}'. Other models present: ${coverageWarning.mismatchedModels.join(", ")}.\n\n`
        : "";
      const header = `${note}${warning}`;
      return {
        text: hits.length === 0 ? `${header}(no matches)` : `${header}${lines.join("\n\n---\n\n")}`,
        data: { hits, coverageWarning },
        resultCount: hits.length,
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

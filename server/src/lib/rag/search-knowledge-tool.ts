/**
 * `search-knowledge` AI tool (Phase 5 / issue #43).
 *
 * Wires the `KnowledgeService` into the existing AI tool registry so chat
 * sessions can retrieve project-scoped chunks at inference time. Risk is set
 * to `low`: the tool is read-only and per-project scoped (the service rejects
 * cross-project lookups by construction — see `vector-store.ts`).
 *
 * #2225 — every search runs for the session's user (`ctx.userId`) as the ACL
 * actor, so a chunk whose ACL excludes them never reaches the model. #2248 — a
 * call that grounds a shared reply (`ctx.aclAudience: "shared"`, a discussion
 * thread) sees unrestricted chunks only.
 *
 * #2325 — a hit from a repository's source (a `repo` document) carries the
 * citation contract: its path at the repository's indexed commit, with the
 * retrievers that matched it. An excerpt has no line numbers, so its lines are
 * `null`. Documents that are not code carry none.
 */
import { z } from "zod";
import { DEFAULT_RETRIEVE_K, MAX_RETRIEVE_K } from "@metis/shared";
import type { ToolDefinition } from "../ai/types.js";
import { getToolRegistry } from "../ai/tool-registry.js";
import { getKnowledgeService, type KnowledgeService } from "./knowledge-service.js";
import { formatDerivedLabel } from "./derived-label.js";
import { formatHitLocator, formatHitScore } from "./hit-locator.js";
import { resolveAclActor, sharedAudienceActor } from "./acl.js";
import { repoDocumentPath } from "../analysis/tools/code-access.js";
import {
  codeCitationRef,
  formatCodeVersionLine,
  loadCodeVersions,
  type CodeVersionIndex,
} from "../code-graph/code-version.js";
import type { CodeCitationRef, RetrievedChunk } from "@metis/shared";

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
  /** #2325 — the project's indexed versions (read only when a hit is code). */
  loadVersions?: (projectId: string) => Promise<CodeVersionIndex>;
}

/** #2325 — the citation contract of the hits that are repository code. */
async function codeCitations(
  hits: readonly RetrievedChunk[],
  projectId: string,
  loadVersions: (projectId: string) => Promise<CodeVersionIndex>,
): Promise<CodeCitationRef[]> {
  const code = hits.flatMap((h) => {
    if (h.source !== "repo") return [];
    const named = repoDocumentPath(h.filename);
    return named ? [{ hit: h, ...named }] : [];
  });
  if (code.length === 0) return [];
  const versions = await loadVersions(projectId);
  return code.map(({ hit, connectorId, path }) =>
    codeCitationRef({
      path,
      startLine: null,
      endLine: null,
      version: versions.forRepo(connectorId),
      ...(hit.matchedBy ? { matchedBy: hit.matchedBy } : {}),
    }),
  );
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
      // #2225 — a failed role read rejects, and the call fails as a tool
      // error: it never searches without the caller's ACLs. #2248 — a shared
      // reply (a discussion thread) searches for a shared audience instead.
      const actor =
        ctx.aclAudience === "shared"
          ? sharedAudienceActor(ctx.userId)
          : await resolveAclActor(ctx.userId);
      const { hits, coverageWarning } = await service.search(projectId, args.query, {
        k: args.k ?? DEFAULT_RETRIEVE_K,
        documentIds: args.documentIds,
        actor,
      });
      const citations = await codeCitations(hits, projectId, opts.loadVersions ?? loadCodeVersions);
      const lines = hits.map(
        (h, i) =>
          `[${i + 1}] (${formatHitScore(h, 4)}) ${formatHitLocator(h)}${formatDerivedLabel(h.derived)}\n${h.text}`,
      );
      const note = ignoredArg
        ? "Note: this session is bound to its project, which was searched; the projectId argument was ignored (omit it).\n\n"
        : "";
      const warning = coverageWarning
        ? `⚠️ Partial coverage: ${coverageWarning.matchingChunks}/${coverageWarning.totalChunks} chunks match the current model '${coverageWarning.currentModel}'. Other models present: ${coverageWarning.mismatchedModels.join(", ")}.\n\n`
        : "";
      const header = `${note}${warning}`;
      const version = formatCodeVersionLine(citations);
      return {
        text:
          hits.length === 0
            ? `${header}(no matches)`
            : `${header}${lines.join("\n\n---\n\n")}${version ? `\n\n${version}` : ""}`,
        data: { hits, coverageWarning },
        resultCount: hits.length,
        ...(citations.length > 0 ? { citations } : {}),
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

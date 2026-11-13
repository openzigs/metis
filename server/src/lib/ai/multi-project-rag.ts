/**
 * #2238 — automatic retrieval for a chat scoped to several products.
 *
 * Before, a chat over two or more projects silently became unscoped and ran no
 * retrieval at all, so it answered from the model's general knowledge. A
 * session now keeps that scope (`AISession.scopeProjectIds`, or
 * `scopeWorkspaceId` for a whole workspace) and every turn searches each
 * project in it through {@link FederatedSearchService}:
 *
 * - access is checked again on every turn, per project: the federated search
 *   narrows the scope to the projects the caller can reach now, and a
 *   workspace scope is resolved to the projects of it they can open now;
 * - each per-project search runs with the caller as the chunk-ACL actor (#2225);
 * - projects are merged on relevance, so one that has nothing to do with the
 *   question contributes nothing (`fuseByRelevance`);
 * - every excerpt is labelled with its product, and the model is told to
 *   attribute each claim to one;
 * - a project that timed out or failed is NAMED in the block, so the answer can
 *   say so, and on the grounding badge — never silently dropped.
 *
 * Single-project chat keeps `buildAutoRagContext` (routes/ai.ts) unchanged.
 *
 * #2279 — and, as single-project chat does since #2240, a turn's retrieval
 * reads the conversation: the searches are planned once
 * (`planRetrievalQueries`) and every project runs all of them, merged as
 * single-project chat merges them; the excerpts the previous answer cited are
 * read back (scoped to the projects in scope now, ACL-checked for the caller)
 * and kept; and documents attached to the question limit every search.
 */
import type { ChatGrounding, ChatGroundingProject, ChatGroundingUnsearched } from "@metis/shared";
import type { RoleKey } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";
import { resolveDurableRole } from "../auth/durable-roles.js";
import { listMemberProjectsInWorkspace } from "../cross-project/cross-project-access.js";
import type { SchedulerActor } from "../scheduler/project-access.js";
import {
  DEFAULT_RELEVANCE_FLOOR,
  getFederatedSearchService,
  type FederatedSearchOptions,
  type FederatedSearchResult,
} from "../rag/federated-search-service.js";
import { formatHitLocator, formatHitScore } from "../rag/hit-locator.js";
import { formatDerivedLabel } from "../rag/derived-label.js";
import type { ChatSearchScope } from "./chat-search-scope.js";
import type { ChatMessage } from "./types.js";
import {
  planRetrievalQueries,
  planSearches,
  type CitableExcerpt,
} from "./conversation/retrieval-query.js";
import { loadChunksById } from "../rag/chunk-lookup.js";
import { resolveAclActor, type AclActor } from "../rag/acl.js";

export { readChatSearchScope, type ChatSearchScope } from "./chat-search-scope.js";

const log = createChildLogger("multi-project-rag");

/** The excerpts one multi-product turn puts in the prompt (single-project chat: 8). */
export const MULTI_PROJECT_K = 8;

/** A chunk read back by id, as `loadChunksById` returns it. */
type CarriedChunk = Awaited<ReturnType<typeof loadChunksById>>[number];

export interface MultiProjectRagDeps {
  search?: (opts: FederatedSearchOptions) => Promise<FederatedSearchResult>;
  /** The project ids of `workspaceId` the actor may open; throws (404) for a non-member. */
  workspaceProjects?: (actor: SchedulerActor, workspaceId: string) => Promise<string[]>;
  role?: (userId: string) => Promise<RoleKey>;
  /** 0..1; defaults to `CHAT_MULTI_PROJECT_RELEVANCE_FLOOR_PCT` / 100. */
  relevanceFloor?: number;
  /** #2279 — the caller as the chunk-ACL actor of a carried excerpt's read. */
  aclActor?: (userId: string) => Promise<AclActor>;
  /** #2279 — read chunks of one project back by id (`loadChunksById`). */
  loadChunks?: (
    projectId: string,
    chunkIds: readonly string[],
    actor: AclActor,
  ) => Promise<CarriedChunk[]>;
}

export interface MultiProjectRagInput {
  userId: string;
  scope: ChatSearchScope;
  /** The user's message; the retrieval query is its first 2,048 characters. */
  query: string;
  /**
   * #2279 — the session's earlier user and assistant messages, oldest first
   * (`retrievalConversation`), so a follow-up is searched with the turn before.
   */
  history?: readonly ChatMessage[];
  /** #2279 — the chunk ids the previous answer cited, kept in this turn's block. */
  carryForward?: readonly string[];
  /** #2279 — the documents the user attached to the question: the search covers only these. */
  documentIds?: readonly string[];
  /**
   * As `buildAutoRagContext`'s: the contexts the model saw, and how many; and
   * (#2279) the numbered excerpts, so the reply records which it cited.
   */
  capture?: { contexts: string[]; sources: number; excerpts?: CitableExcerpt[] };
  deps?: MultiProjectRagDeps;
}

export interface MultiProjectRagResult {
  /** The system block for the prompt; `""` only for an empty query. */
  block: string;
  grounding: ChatGrounding;
}

const HEADER = "## Retrieved Knowledge (multi-product RAG)";

function quoteList(names: readonly string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

function configuredFloor(): number {
  const pct = getConfigService().getNumber(
    "CHAT_MULTI_PROJECT_RELEVANCE_FLOOR_PCT",
    DEFAULT_RELEVANCE_FLOOR * 100,
  );
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) / 100 : DEFAULT_RELEVANCE_FLOOR;
}

/** The project ids a scope names this turn, re-checked against the caller's access now. */
async function scopeProjectIds(
  userId: string,
  scope: ChatSearchScope,
  deps: MultiProjectRagDeps,
): Promise<string[]> {
  if (scope.kind === "projects") return scope.projectIds;
  const role = await (deps.role ?? resolveDurableRole)(userId);
  return (deps.workspaceProjects ?? listMemberProjectsInWorkspace)(
    { id: userId, role },
    scope.workspaceId,
  );
}

/** A block that says nothing could be searched, so the answer does not pretend otherwise. */
function nothingSearchedBlock(reason: string): string {
  return (
    `${HEADER}\n` +
    `This chat session is scoped to several products, but ${reason}. No excerpt from their ` +
    `sources is included. Say so in your answer: do not present background knowledge as what ` +
    `their documents or code say.`
  );
}

/**
 * #2279 — the excerpts the previous answer cited, read back as each project in
 * scope holds them now: only from a project searched this turn, for the caller
 * as the chunk-ACL actor, and not one this turn's search already found. A
 * project whose search failed or timed out carries nothing: the block tells the
 * model its sources could not be searched, so an excerpt from it there would
 * contradict that, and its grounding would count sources it does not list. Losing them costs the turn its carry-over,
 * never its fresh retrieval.
 */
async function carriedExcerpts(
  input: MultiProjectRagInput,
  result: FederatedSearchResult,
  documentIds: readonly string[] | undefined,
  deps: MultiProjectRagDeps,
): Promise<Array<CarriedChunk & { projectId: string }>> {
  const ids = input.carryForward ?? [];
  const reachable = result.projectsSearched;
  if (ids.length === 0 || reachable.length === 0) return [];
  const found = new Set(result.hits.map((h) => h.chunkId));
  try {
    const actor = await (deps.aclActor ?? resolveAclActor)(input.userId);
    const read = deps.loadChunks ?? loadChunksById;
    const perProject = await Promise.all(
      reachable.map(async (projectId) =>
        (await read(projectId, ids, actor)).map((c) => ({ ...c, projectId })),
      ),
    );
    const byId = new Map(perProject.flat().map((c) => [c.chunkId, c]));
    return [...new Set(ids)]
      .map((id) => byId.get(id))
      .filter(
        (c): c is CarriedChunk & { projectId: string } =>
          c !== undefined &&
          !found.has(c.chunkId) &&
          // Attached documents limit the whole block, carried excerpts included.
          (!documentIds || documentIds.includes(c.documentId)),
      );
  } catch (err) {
    log.debug("Cited excerpts could not be carried forward", {
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * #2238 — retrieve for one turn of a multi-product chat: the prompt block and
 * the turn's grounding. Never throws: a failure is reported in both, so the
 * answer cannot read as grounded in sources that were never searched.
 */
export async function buildMultiProjectRagContext(
  input: MultiProjectRagInput,
): Promise<MultiProjectRagResult> {
  const deps = input.deps ?? {};
  // #2279 — the searches come from the conversation, as single-project chat's do.
  const plan = planRetrievalQueries([
    ...(input.history ?? []),
    { role: "user", content: input.query },
  ]);
  if (!plan) return { block: "", grounding: { status: "multi", projects: [] } };
  const searches = planSearches(plan);
  const documentIds =
    input.documentIds && input.documentIds.length > 0 ? [...input.documentIds] : undefined;

  let ids: string[];
  try {
    ids = await scopeProjectIds(input.userId, input.scope, deps);
  } catch (err) {
    // A workspace the caller has left (or that was deleted) reads 404 here.
    log.debug("Multi-product scope could not be resolved", {
      scope: input.scope.kind,
      error: (err as Error).message,
    });
    return {
      block: nothingSearchedBlock("its workspace is no longer available to you"),
      grounding: { status: "multi", projects: [] },
    };
  }
  if (ids.length === 0) {
    return {
      block: nothingSearchedBlock("none of its projects is available to you"),
      grounding: { status: "multi", projects: [] },
    };
  }

  let result: FederatedSearchResult;
  try {
    result = await (deps.search ?? ((o) => getFederatedSearchService().searchAcrossProjects(o)))({
      userId: input.userId,
      projectIds: ids,
      query: searches.user[0] ?? plan.primary,
      k: MULTI_PROJECT_K,
      // Attached documents are the source the user chose: every product holding
      // one contributes, however its relevance compares with the others'.
      relevanceFloor: documentIds ? 0 : (deps.relevanceFloor ?? configuredFloor()),
      ...(searches.user.length > 1 ? { moreQueries: searches.user.slice(1) } : {}),
      ...(searches.contextual ? { contextualQuery: searches.contextual } : {}),
      ...(documentIds ? { documentIds } : {}),
    });
  } catch (err) {
    log.debug("Multi-product retrieval failed, continuing without context", {
      error: (err as Error).message,
    });
    return {
      block: nothingSearchedBlock("their sources could not be searched this turn"),
      grounding: { status: "multi", projects: [] },
    };
  }

  const nameOf = (id: string) => result.projectNames[id] ?? id;
  const carried = await carriedExcerpts(input, result, documentIds, deps);
  const sourcesBy = new Map<string, number>();
  for (const h of [...result.hits, ...carried]) {
    sourcesBy.set(h.projectId, (sourcesBy.get(h.projectId) ?? 0) + 1);
  }
  const projects: ChatGroundingProject[] = result.projectsSearched.map((id) => ({
    projectId: id,
    projectName: nameOf(id),
    sources: sourcesBy.get(id) ?? 0,
  }));
  const unsearched: ChatGroundingUnsearched[] = result.failures.map((f) => ({
    projectId: f.projectId,
    projectName: f.projectName,
    reason: f.reason,
  }));
  const grounding: ChatGrounding = {
    status: "multi",
    projects,
    ...(unsearched.length > 0 ? { unsearched } : {}),
    ...(result.projectsRejected > 0 ? { unavailable: result.projectsRejected } : {}),
  };

  const inScope = [...projects.map((p) => p.projectName), ...unsearched.map((u) => u.projectName)];
  if (inScope.length === 0) {
    return {
      block: nothingSearchedBlock("none of its projects is available to you"),
      grounding,
    };
  }

  const chunkList = [
    ...result.hits.map(
      (h, i) =>
        `[${i + 1}] [${h.projectName}] ${formatHitLocator(h)}${formatDerivedLabel(h.derived)} ` +
        `(${formatHitScore({ score: h.score, matchedBy: h.matchedBy }, 3)})\n${h.text}`,
    ),
    ...carried.map(
      (h, j) =>
        `[${result.hits.length + j + 1}] [${nameOf(h.projectId)}] ${formatHitLocator(h)}` +
        `${formatDerivedLabel(h.derived)} (cited in your previous answer)\n${h.text}`,
    ),
  ];
  if (input.capture) {
    input.capture.contexts.push(...chunkList);
    input.capture.sources += chunkList.length;
    // #2279 — numbered as the block numbers them, so the reply records what it cited.
    input.capture.excerpts = [...result.hits, ...carried].map((h, i) => ({
      n: i + 1,
      chunkId: h.chunkId,
      name: h.path ?? h.filename,
      locator: formatHitLocator(h),
      ...(h.source ? { source: h.source } : {}),
    }));
  }

  const lines: string[] = [
    HEADER,
    `This chat session is scoped to ${inScope.length} product${inScope.length === 1 ? "" : "s"}: ${quoteList(inScope)}. ` +
      `"The project", "this project" or "these products" means them — never METIS (the platform ` +
      `this chat runs on) and never any other topic raised earlier in this conversation.`,
  ];
  if (chunkList.length > 0) {
    lines.push(
      `Each excerpt below is labelled with the product it was retrieved from, in square brackets. ` +
        `Answer from these excerpts, and attribute every claim to its product by name ` +
        `(for example "In ${projects.find((p) => p.sources > 0)?.projectName ?? inScope[0]}, …"). ` +
        `When the products differ, say which product does what. Never carry a fact from one ` +
        `product's excerpt over to another product. Prefer these excerpts over your own ` +
        `background knowledge or earlier chat history. An excerpt marked DERIVED is generated ` +
        `documentation about the product, not a primary source: use it as a pointer, prefer an ` +
        `unmarked excerpt when they disagree, and say so when you rely on one` +
        // #2279 — said only when it applies, so an ordinary turn's block is unchanged.
        (documentIds
          ? ". The user attached documents to this question, so every excerpt below comes from them"
          : "") +
        (carried.length > 0
          ? '. An excerpt marked "cited in your previous answer" is one your last answer drew on, ' +
            "kept so you can build on it"
          : "") +
        ":",
      chunkList.join("\n\n---\n\n"),
    );
  } else {
    lines.push(
      `No excerpt from their sources matched this question. Say so: do not present background ` +
        `knowledge as what their documents or code say.`,
    );
  }
  const without = projects.filter((p) => p.sources === 0).map((p) => p.projectName);
  if (chunkList.length > 0 && without.length > 0) {
    lines.push(
      documentIds
        ? // #2279 — only the attached documents were searched, so a product with no
          // excerpt here is one they do not cover, not one whose sources matched nothing.
          `Only the attached documents were searched, and none of them from ` +
            `${quoteList(without)} is included above. If the question concerns it, say that ` +
            `the attached documents do not cover it; do not describe it from another ` +
            `product's excerpts.`
        : `Searched, but no excerpt from it is included above: ${quoteList(without)}. If the ` +
            `question concerns it, say that its sources showed nothing relevant; do not ` +
            `describe it from another product's excerpts.`,
    );
  }
  if (unsearched.length > 0) {
    const named = unsearched.map(
      (u) => `"${u.projectName}" (${u.reason === "timeout" ? "timed out" : "search failed"})`,
    );
    lines.push(
      `Could not be searched this turn: ${named.join(", ")}. Name ${
        unsearched.length === 1 ? "it" : "each of them"
      } in your answer and say its sources could not be searched, rather than answering for it.`,
    );
  }
  if (result.projectsRejected > 0) {
    lines.push(
      `${result.projectsRejected} more project(s) in this chat's scope are no longer available ` +
        `to the user and were not searched; say so if the answer may depend on them.`,
    );
  }
  return { block: lines.join("\n\n"), grounding };
}

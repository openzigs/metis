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

export { readChatSearchScope, type ChatSearchScope } from "./chat-search-scope.js";

const log = createChildLogger("multi-project-rag");

/** The excerpts one multi-product turn puts in the prompt (single-project chat: 8). */
const MULTI_PROJECT_K = 8;
const MAX_QUERY_CHARS = 2048;

export interface MultiProjectRagDeps {
  search?: (opts: FederatedSearchOptions) => Promise<FederatedSearchResult>;
  /** The project ids of `workspaceId` the actor may open; throws (404) for a non-member. */
  workspaceProjects?: (actor: SchedulerActor, workspaceId: string) => Promise<string[]>;
  role?: (userId: string) => Promise<RoleKey>;
  /** 0..1; defaults to `CHAT_MULTI_PROJECT_RELEVANCE_FLOOR_PCT` / 100. */
  relevanceFloor?: number;
}

export interface MultiProjectRagInput {
  userId: string;
  scope: ChatSearchScope;
  /** The user's message; the retrieval query is its first 2,048 characters. */
  query: string;
  /** As `buildAutoRagContext`'s: the contexts the model saw, and how many. */
  capture?: { contexts: string[]; sources: number };
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
 * #2238 — retrieve for one turn of a multi-product chat: the prompt block and
 * the turn's grounding. Never throws: a failure is reported in both, so the
 * answer cannot read as grounded in sources that were never searched.
 */
export async function buildMultiProjectRagContext(
  input: MultiProjectRagInput,
): Promise<MultiProjectRagResult> {
  const deps = input.deps ?? {};
  const query = input.query.slice(0, MAX_QUERY_CHARS);
  if (!query.trim()) return { block: "", grounding: { status: "multi", projects: [] } };

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
      query,
      k: MULTI_PROJECT_K,
      relevanceFloor: deps.relevanceFloor ?? configuredFloor(),
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
  const sourcesBy = new Map<string, number>();
  for (const h of result.hits) sourcesBy.set(h.projectId, (sourcesBy.get(h.projectId) ?? 0) + 1);
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

  const chunkList = result.hits.map(
    (h, i) =>
      `[${i + 1}] [${h.projectName}] ${formatHitLocator(h)}${formatDerivedLabel(h.derived)} ` +
      `(${formatHitScore({ score: h.score, matchedBy: h.matchedBy }, 3)})\n${h.text}`,
  );
  if (input.capture) {
    input.capture.contexts.push(...chunkList);
    input.capture.sources += chunkList.length;
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
        `unmarked excerpt when they disagree, and say so when you rely on one:`,
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
      `Searched, but no excerpt from it is included above: ${quoteList(without)}. If the ` +
        `question concerns it, say that its sources showed nothing relevant; do not describe it ` +
        `from another product's excerpts.`,
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

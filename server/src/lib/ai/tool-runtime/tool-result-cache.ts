/**
 * #1843 — an exact-key cache for chat's read tools, keyed on the project's
 * content version.
 *
 * A chat turn often repeats a search an earlier turn (or another session on
 * the same project) already ran. For the read tools below, the result is fully
 * determined by the tool, its arguments, the project, the caller and the
 * project's content. The key covers all five, with the content as the version
 * key from `projects/content-version.ts`. A re-ingest therefore makes every
 * older entry unreachable: there is no invalidation to forget. #2314 — on a
 * project with a restricted document the caller is their user id, durable role
 * and groups (groups are not resolved yet: `resolveAclActor` sets none, so that
 * part is always empty), read once per chat turn, so a role change reaches the
 * next turn without an invalidation to forget either.
 *
 * In-process only: an LRU bounded by entry count and by bytes, and every entry
 * expires after a TTL. Not cached:
 *   - a code tool's call on a project whose content version is incomplete (a
 *     code graph with no commit SHA), counted as a `bypass`. `search-knowledge`
 *     reads no code graph, so it is still cached there (#1864);
 *   - an error result (it may be transient);
 *   - a call with no project.
 * A failure to read the version also bypasses the cache, and the tool runs as
 * if it did not exist.
 *
 * Hits, misses and bypasses are counted on the Prometheus registry
 * (`metis_chat_tool_result_cache_total{tool,outcome}`) and in
 * {@link ToolResultCache.stats}.
 *
 * Config: `CHAT_TOOL_RESULT_CACHE_ENABLED` — `0` turns the cache off (default
 * on). Persisting the cache is out of scope; #1845 decides.
 */
import crypto from "node:crypto";
import { createChildLogger } from "../../logger.js";
import { recordToolResultCache } from "../../metrics/index.js";
import { prisma } from "../../prisma.js";
import { parseAclSubjects, resolveAclActor, type AclActor } from "../../rag/acl.js";
import {
  getProjectContentVersion,
  type ProjectContentVersion,
} from "../../projects/content-version.js";
import type { RuntimeTool, RuntimeToolContext, RuntimeToolResult } from "./types.js";

const log = createChildLogger("tool-result-cache");

/**
 * #1864 — the cacheable tools that read the code graph, and so cannot be
 * cached under an incomplete content version. `search-knowledge` searches the
 * document chunks only.
 */
const CODE_GRAPH_TOOLS: ReadonlySet<string> = new Set([
  "search_code_graph",
  "search_code_symbols",
  "read_file_slice",
  "search_code_context",
]);

/** The read tools whose results are cached (canonical names). */
export const CACHEABLE_TOOLS: ReadonlySet<string> = new Set([
  "search_code_graph",
  "search_code_symbols",
  "read_file_slice",
  "search_code_context",
  "search-knowledge",
]);

/**
 * #2248 — the cache scope of a shared-audience call. A NUL byte cannot occur in
 * a user id, so no user's scope can equal it.
 */
const SHARED_AUDIENCE_SCOPE = "\u0000shared-audience";

export const TOOL_RESULT_CACHE_DEFAULTS = {
  maxEntries: 500,
  maxBytes: 32 * 1024 * 1024,
  ttlMs: 30 * 60_000,
} as const;

export interface ToolResultCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

export type ToolResultCacheOutcome = "hit" | "miss" | "bypass";

interface Entry {
  value: RuntimeToolResult;
  bytes: number;
  expiresAt: number;
}

/** JSON with every object's keys sorted, so equal arguments give one string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** The cache key: tool + canonical arguments + project + content version + caller scope. */
export function toolResultCacheKey(input: {
  tool: string;
  args: unknown;
  projectId: string;
  versionKey: string;
  scope: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        input.tool,
        canonicalJson(input.args ?? null),
        input.projectId,
        input.versionKey,
        input.scope,
      ]),
    )
    .digest("hex");
}

const sizeOf = (key: string, v: RuntimeToolResult): number =>
  Buffer.byteLength(key) +
  Buffer.byteLength(v.text) +
  // #2325 — a cached result keeps its citation contract, which counts too.
  (v.citations ? Buffer.byteLength(JSON.stringify(v.citations)) : 0) +
  64;

export class ToolResultCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly counts: Record<ToolResultCacheOutcome, number> = {
    hit: 0,
    miss: 0,
    bypass: 0,
  };

  constructor(opts: ToolResultCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? TOOL_RESULT_CACHE_DEFAULTS.maxEntries;
    this.maxBytes = opts.maxBytes ?? TOOL_RESULT_CACHE_DEFAULTS.maxBytes;
    this.ttlMs = opts.ttlMs ?? TOOL_RESULT_CACHE_DEFAULTS.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): RuntimeToolResult | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.remove(key, e);
      return undefined;
    }
    // Most recently used goes to the back of the insertion order.
    this.entries.delete(key);
    this.entries.set(key, e);
    return { ...e.value };
  }

  set(key: string, value: RuntimeToolResult): void {
    const bytes = sizeOf(key, value);
    if (bytes > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) this.remove(key, old);
    this.entries.set(key, { value: { ...value }, bytes, expiresAt: this.now() + this.ttlMs });
    this.bytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.remove(k, e);
    }
  }

  /** Count one lookup's outcome, here and on the metrics registry. */
  count(tool: string, outcome: ToolResultCacheOutcome): void {
    this.counts[outcome] += 1;
    recordToolResultCache(tool, outcome);
  }

  stats(): { entries: number; bytes: number } & Record<ToolResultCacheOutcome, number> {
    return { entries: this.entries.size, bytes: this.bytes, ...this.counts };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
    this.counts.hit = 0;
    this.counts.miss = 0;
    this.counts.bypass = 0;
  }

  private remove(key: string, e: Entry): void {
    this.entries.delete(key);
    this.bytes -= e.bytes;
  }
}

let singleton: ToolResultCache | null = null;

export function getToolResultCache(): ToolResultCache {
  if (!singleton) singleton = new ToolResultCache();
  return singleton;
}

export function __resetToolResultCacheForTests(): void {
  singleton = null;
  restrictedByVersion.clear();
}

export function toolResultCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHAT_TOOL_RESULT_CACHE_ENABLED !== "0";
}

export interface ToolResultCacheDeps {
  cache?: () => ToolResultCache;
  version?: (projectId: string) => Promise<ProjectContentVersion>;
  enabled?: () => boolean;
  /**
   * #2314 — the caller's ACL actor. Defaults to `resolveAclActor`; read once
   * per chat turn (`RuntimeToolContext.aclActorMemo`), and only on a project
   * with a restricted document.
   */
  actor?: (userId: string) => Promise<AclActor>;
  /**
   * #2314 — whether the project has any document with ACL subjects. Defaults
   * to {@link projectHasRestrictedDocument}; read once per content version.
   */
  restricted?: (projectId: string) => Promise<boolean>;
}

/**
 * #2314 — a user's cache scope: the user AND what their document access is
 * decided on (`isVisibleTo`: their durable role and their groups). A role
 * change does not move the project's content version, so with the user id
 * alone a result filtered under the old role was served under the new one
 * until the entry expired (up to the TTL, 30 minutes). Groups are part of the
 * key for when they are resolved; `resolveAclActor` sets none today.
 */
export function userCacheScope(actor: AclActor): string {
  return JSON.stringify([actor.userId, actor.role, [...(actor.groups ?? [])].sort()]);
}

/**
 * #2314 — the scope of a user on a project with no restricted document: every
 * result is the same whatever their role, so their role is not read. Its form
 * (one element) differs from {@link userCacheScope}'s (three), so the two
 * never collide.
 */
function unrestrictedUserScope(userId: string): string {
  return JSON.stringify([userId]);
}

/** Rows read before a project counts as restricted without parsing more. */
const RESTRICTED_SCAN_LIMIT = 100;

/**
 * #2314 — whether `projectId` has a document with ACL subjects (soft-deleted
 * ones included: erring towards "restricted" only costs a role read).
 */
export async function projectHasRestrictedDocument(projectId: string): Promise<boolean> {
  const rows = await prisma.document.findMany({
    where: { projectId, aclSubjects: { notIn: ["[]", ""] } },
    select: { aclSubjects: true },
    take: RESTRICTED_SCAN_LIMIT,
  });
  return (
    rows.length >= RESTRICTED_SCAN_LIMIT ||
    rows.some((r) => parseAclSubjects(r.aclSubjects).length > 0)
  );
}

/**
 * #2314 — {@link projectHasRestrictedDocument} per (project, content version).
 * An ACL edit moves the content version (`projects/content-version.ts` hashes
 * every document's `aclSubjects` and its latest write), so the answer for one
 * version never changes. Bounded; a failed read is not kept.
 */
const restrictedByVersion = new Map<string, Promise<boolean>>();
const RESTRICTED_MEMO_MAX = 1000;

function restrictedAt(
  projectId: string,
  versionKey: string,
  read: (projectId: string) => Promise<boolean>,
): Promise<boolean> {
  const key = `${projectId}\u0000${versionKey}`;
  let hit = restrictedByVersion.get(key);
  if (!hit) {
    if (restrictedByVersion.size >= RESTRICTED_MEMO_MAX) {
      restrictedByVersion.delete(restrictedByVersion.keys().next().value as string);
    }
    hit = read(projectId);
    restrictedByVersion.set(key, hit);
    hit.catch(() => restrictedByVersion.delete(key));
  }
  return hit;
}

/**
 * `tool`, with its results served from and stored in the cache. A tool not in
 * {@link CACHEABLE_TOOLS} is returned unchanged.
 */
export function withToolResultCache(
  tool: RuntimeTool,
  deps: ToolResultCacheDeps = {},
): RuntimeTool {
  if (!CACHEABLE_TOOLS.has(tool.name)) return tool;
  const cacheOf = deps.cache ?? getToolResultCache;
  const versionOf = deps.version ?? ((id: string) => getProjectContentVersion(id));
  const enabled = deps.enabled ?? (() => toolResultCacheEnabled());
  const actorOf = deps.actor ?? resolveAclActor;
  const restrictedOf = deps.restricted ?? projectHasRestrictedDocument;
  const run = tool.execute.bind(tool);
  /**
   * #2314 — a scope read at the start of the turn may be stale by the time a
   * miss has run: the tool reads the role afresh, so a result computed under
   * a newer role must not be stored under the old role's key. Only on a miss
   * under a turn's memo, so a hit still reads no role.
   */
  const scopeStillHolds = async (
    roleScoped: boolean,
    ctx: RuntimeToolContext,
    scope: string,
  ): Promise<boolean> => {
    if (!roleScoped || !ctx.aclActorMemo) return true;
    try {
      return userCacheScope(await actorOf(ctx.userId)) === scope;
    } catch {
      return false;
    }
  };
  return {
    ...tool,
    async execute(args: unknown, ctx: RuntimeToolContext): Promise<RuntimeToolResult> {
      if (!ctx.projectId || !enabled()) return run(args, ctx);
      const cache = cacheOf();
      let version: ProjectContentVersion;
      try {
        version = await versionOf(ctx.projectId);
      } catch (err) {
        log.debug("Content version unavailable; tool result not cached", {
          tool: tool.name,
          error: err instanceof Error ? err.message : String(err),
        });
        cache.count(tool.name, "bypass");
        return run(args, ctx);
      }
      if (!version.complete && CODE_GRAPH_TOOLS.has(tool.name)) {
        cache.count(tool.name, "bypass");
        return run(args, ctx);
      }
      // The caller's access scope: per user, so no entry crosses users. #2248 —
      // a shared audience is a scope of its own: a user's own result (which may
      // hold chunks restricted to them) never answers a shared reply's call.
      // #2314 — on a project with a restricted document, also per role and
      // groups, read once per turn, so a role change reaches the next turn.
      // Without one, every role reads the same results and no role is read.
      // An actor that cannot be read (an inactive user) is not served from the
      // cache: the tool runs, and refuses them itself. A failed restriction
      // read counts as restricted.
      let scope = SHARED_AUDIENCE_SCOPE;
      let roleScoped = false;
      if (ctx.aclAudience !== "shared") {
        try {
          const restricted = await restrictedAt(ctx.projectId, version.key, restrictedOf).catch(
            () => true,
          );
          if (restricted) {
            const memo = ctx.aclActorMemo;
            const actor = memo ? (memo.actor ??= actorOf(ctx.userId)) : actorOf(ctx.userId);
            scope = userCacheScope(await actor);
            roleScoped = true;
          } else {
            scope = unrestrictedUserScope(ctx.userId);
          }
        } catch (err) {
          log.debug("ACL actor unavailable; tool result not cached", {
            tool: tool.name,
            error: err instanceof Error ? err.message : String(err),
          });
          cache.count(tool.name, "bypass");
          return run(args, ctx);
        }
      }
      const key = toolResultCacheKey({
        tool: tool.name,
        args,
        projectId: ctx.projectId,
        versionKey: version.key,
        scope,
      });
      const hit = cache.get(key);
      if (hit) {
        cache.count(tool.name, "hit");
        return hit;
      }
      cache.count(tool.name, "miss");
      const result = await run(args, ctx);
      if (!result.isError && (await scopeStillHolds(roleScoped, ctx, scope))) {
        cache.set(key, result);
      }
      return result;
    },
  };
}

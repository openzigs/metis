/**
 * #1843 — an exact-key cache for chat's read tools, keyed on the project's
 * content version.
 *
 * A chat turn often repeats a search an earlier turn (or another session on
 * the same project) already ran. For the read tools below, the result is fully
 * determined by the tool, its arguments, the project, the caller and the
 * project's content. The key covers all five, with the content as the version
 * key from `projects/content-version.ts`. A re-ingest therefore makes every
 * older entry unreachable: there is no invalidation to forget.
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
]);

/** The read tools whose results are cached (canonical names). */
export const CACHEABLE_TOOLS: ReadonlySet<string> = new Set([
  "search_code_graph",
  "search_code_symbols",
  "read_file_slice",
  "search-knowledge",
]);

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
  Buffer.byteLength(key) + Buffer.byteLength(v.text) + 64;

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
}

export function toolResultCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHAT_TOOL_RESULT_CACHE_ENABLED !== "0";
}

export interface ToolResultCacheDeps {
  cache?: () => ToolResultCache;
  version?: (projectId: string) => Promise<ProjectContentVersion>;
  enabled?: () => boolean;
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
  const run = tool.execute.bind(tool);
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
      const key = toolResultCacheKey({
        tool: tool.name,
        args,
        projectId: ctx.projectId,
        versionKey: version.key,
        // The caller's access scope: per user, so no entry crosses users even
        // if a read tool starts filtering on the caller.
        scope: ctx.userId,
      });
      const hit = cache.get(key);
      if (hit) {
        cache.count(tool.name, "hit");
        return hit;
      }
      cache.count(tool.name, "miss");
      const result = await run(args, ctx);
      if (!result.isError) cache.set(key, result);
      return result;
    },
  };
}

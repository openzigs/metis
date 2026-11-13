/**
 * #1843 — the chat read-tool result cache: its key, its bounds, and what it
 * refuses to cache. The content version is a stub here; the sqlite suite
 * (`tests/tool-result-cache-1843.sqlite.test.ts`) drives the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * #2314 — the durable role `resolveAclActor` reads, per user (default
 * `analyst`); a user in `inactive` is refused, as a deactivated one is.
 */
const acl = vi.hoisted(() => ({
  roles: new Map<string, string>(),
  inactive: new Set<string>(),
}));
vi.mock("../../rag/acl.js", () => ({
  resolveAclActor: async (userId: string) => {
    if (acl.inactive.has(userId)) throw new Error("ACL actor unavailable");
    return { userId, role: acl.roles.get(userId) ?? "analyst" };
  },
}));

import {
  CACHEABLE_TOOLS,
  ToolResultCache,
  __resetToolResultCacheForTests,
  canonicalJson,
  getToolResultCache,
  toolResultCacheEnabled,
  toolResultCacheKey,
  userCacheScope,
  withToolResultCache,
} from "./tool-result-cache.js";
import { getMetricsRegistry, resetMetricsForTests } from "../../metrics/index.js";
import type { ProjectContentVersion } from "../../projects/content-version.js";
import type { RuntimeTool, RuntimeToolContext, RuntimeToolResult } from "./types.js";

const version = (key: string, complete = true): ProjectContentVersion => ({
  codeShas: {},
  docsVersion: "d",
  key,
  complete,
});
const ctx = (projectId: string | null = "p1", userId = "u1"): RuntimeToolContext => ({
  sessionId: "s1",
  userId,
  projectId,
});

/** A read tool whose answer is whatever `answer` returns now; counts its runs. */
function tool(
  name = "search_code_symbols",
  answer: () => RuntimeToolResult = () => ({ text: "x" }),
) {
  const execute = vi.fn(
    async (_args: unknown, _ctx: RuntimeToolContext): Promise<RuntimeToolResult> => answer(),
  );
  const t: RuntimeTool = {
    name,
    wireName: name,
    description: "d",
    parameters: {},
    risk: "low",
    source: "code",
    validate: (args) => ({ ok: true, args }),
    execute,
  };
  return { t, execute };
}

beforeEach(() => {
  resetMetricsForTests();
  __resetToolResultCacheForTests();
  acl.roles.clear();
  acl.inactive.clear();
});
afterEach(() => {
  delete process.env.CHAT_TOOL_RESULT_CACHE_ENABLED;
});

describe("toolResultCacheKey", () => {
  const base = {
    tool: "search_code_symbols",
    args: { q: "refund", k: 5 },
    projectId: "p1",
    versionKey: "v1",
    scope: "user:u1",
  };

  it("is the same for the same arguments in any key order", () => {
    expect(toolResultCacheKey(base)).toBe(
      toolResultCacheKey({ ...base, args: { k: 5, q: "refund" } }),
    );
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });

  it.each([
    ["tool", { tool: "read_file_slice" }],
    ["arguments", { args: { q: "refunds", k: 5 } }],
    ["project", { projectId: "p2" }],
    ["content version", { versionKey: "v2" }],
    ["caller scope", { scope: "user:u2" }],
  ])("changes with the %s", (_label, change) => {
    expect(toolResultCacheKey({ ...base, ...change })).not.toBe(toolResultCacheKey(base));
  });
});

describe("withToolResultCache", () => {
  it("serves a repeated call from the cache, counting a miss then a hit", async () => {
    const { t, execute } = tool("search_code_symbols", () => ({ text: "hits", resultCount: 2 }));
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1"),
    });

    expect(await cached.execute({ q: "a" }, ctx())).toEqual({ text: "hits", resultCount: 2 });
    expect(await cached.execute({ q: "a" }, ctx())).toEqual({ text: "hits", resultCount: 2 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ entries: 1, hit: 1, miss: 1, bypass: 0 });
  });

  it("two projects with identical arguments never share an entry", async () => {
    const { t, execute } = tool("search_code_graph");
    execute.mockImplementation(async (_args: unknown, c: RuntimeToolContext) => ({
      text: `results of ${c.projectId}`,
    }));
    const cache = new ToolResultCache();
    // The same version key for both: only the project tells them apart.
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("same"),
    });

    expect((await cached.execute({ query: "Refund" }, ctx("p1"))).text).toBe("results of p1");
    expect((await cached.execute({ query: "Refund" }, ctx("p2"))).text).toBe("results of p2");
    expect((await cached.execute({ query: "Refund" }, ctx("p1"))).text).toBe("results of p1");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("a new content version misses and returns the new result", async () => {
    let current = "v1";
    let answer = "old";
    const { t, execute } = tool("search_code_symbols", () => ({ text: answer }));
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version(current),
    });

    expect((await cached.execute({ q: "a" }, ctx())).text).toBe("old");
    answer = "new";
    current = "v2"; // the re-ingest
    expect((await cached.execute({ q: "a" }, ctx())).text).toBe("new");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not share an entry between two callers", async () => {
    const { t, execute } = tool();
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1"),
    });
    await cached.execute({ q: "a" }, ctx("p1", "alice"));
    await cached.execute({ q: "a" }, ctx("p1", "bob"));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  // #2314 — a role change moves no content version: the entry filtered under
  // the old role must not answer the first call under the new one.
  it("does not serve a result cached under a user's old role after their role changes", async () => {
    let n = 0;
    const { t, execute } = tool("search-knowledge", () => ({ text: `run-${++n}` }));
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1"),
    });
    acl.roles.set("alice", "analyst");
    expect((await cached.execute({ q: "a" }, ctx("p1", "alice"))).text).toBe("run-1");
    expect((await cached.execute({ q: "a" }, ctx("p1", "alice"))).text).toBe("run-1");
    acl.roles.set("alice", "viewer");
    expect((await cached.execute({ q: "a" }, ctx("p1", "alice"))).text).toBe("run-2");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("scopes on the actor's groups in any order", () => {
    const scope = (groups?: string[]) =>
      userCacheScope({ userId: "u1", role: "analyst", ...(groups ? { groups } : {}) });
    expect(scope(["b", "a"])).toBe(scope(["a", "b"]));
    expect(scope(["a"])).not.toBe(scope(["b"]));
    expect(scope([])).toBe(scope());
    expect(userCacheScope({ userId: "u1", role: "admin" })).not.toBe(scope());
  });

  // #2314 — an actor that cannot be read is never answered from the cache:
  // the tool runs, and its own access check refuses them.
  it("bypasses the cache for a caller whose ACL actor cannot be read", async () => {
    const { t, execute } = tool("search_code_symbols", () => ({ text: "x" }));
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1"),
    });
    await cached.execute({ q: "a" }, ctx("p1", "gone"));
    acl.inactive.add("gone");
    await cached.execute({ q: "a" }, ctx("p1", "gone"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ entries: 1, hit: 0, miss: 1, bypass: 1 });
  });

  // #2248 — a user's own search may hold chunks restricted to them; it must
  // never answer the same call made for a reply the whole thread reads.
  it("never serves a user's own result to a shared-audience call, nor the reverse", async () => {
    let n = 0;
    const { t, execute } = tool("search-knowledge", () => ({ text: `run-${++n}` }));
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1"),
    });
    const shared = (userId: string): RuntimeToolContext => ({
      ...ctx("p1", userId),
      aclAudience: "shared",
    });
    expect((await cached.execute({ q: "a" }, ctx("p1", "alice"))).text).toBe("run-1");
    expect((await cached.execute({ q: "a" }, shared("alice"))).text).toBe("run-2");
    expect((await cached.execute({ q: "a" }, ctx("p1", "alice"))).text).toBe("run-1");
    // One shared audience, whoever triggered it: the second trigger is a hit.
    expect((await cached.execute({ q: "a" }, shared("bob"))).text).toBe("run-2");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("an incomplete content version bypasses the cache", async () => {
    const { t, execute } = tool();
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1", false),
    });
    await cached.execute({ q: "a" }, ctx());
    await cached.execute({ q: "a" }, ctx());
    expect(execute).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ entries: 0, hit: 0, miss: 0, bypass: 2 });
  });

  // #1864 — completeness is about the code graph, which search-knowledge never reads.
  it.each(["search_code_graph", "search_code_symbols", "read_file_slice"])(
    "an incomplete version bypasses %s, a code tool",
    async (name) => {
      const { t, execute } = tool(name);
      const cache = new ToolResultCache();
      const cached = withToolResultCache(t, {
        cache: () => cache,
        version: async () => version("v1", false),
      });
      await cached.execute({ q: "a" }, ctx());
      await cached.execute({ q: "a" }, ctx());
      expect(execute).toHaveBeenCalledTimes(2);
      expect(cache.stats()).toMatchObject({ entries: 0, bypass: 2 });
    },
  );

  it("an incomplete version still caches search-knowledge", async () => {
    const { t, execute } = tool("search-knowledge");
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1", false),
    });
    await cached.execute({ q: "a" }, ctx());
    await cached.execute({ q: "a" }, ctx());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ entries: 1, hit: 1, miss: 1, bypass: 0 });
  });

  it("a version that cannot be read bypasses the cache and still runs the tool", async () => {
    const { t, execute } = tool();
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => {
        throw new Error("db down");
      },
    });
    expect((await cached.execute({ q: "a" }, ctx())).text).toBe("x");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(cache.stats().bypass).toBe(1);
  });

  it("never caches an error result", async () => {
    const { t, execute } = tool("read_file_slice", () => ({ text: "boom", isError: true }));
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1"),
    });
    await cached.execute({ path: "a" }, ctx());
    await cached.execute({ path: "a" }, ctx());
    expect(execute).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(0);
  });

  it("does not touch a call with no project, nor run when switched off", async () => {
    const versionOf = vi.fn(async () => version("v1"));
    const { t, execute } = tool();
    const cached = withToolResultCache(t, { version: versionOf });
    await cached.execute({ q: "a" }, ctx(null));
    await cached.execute({ q: "a" }, ctx(null));
    process.env.CHAT_TOOL_RESULT_CACHE_ENABLED = "0";
    await cached.execute({ q: "a" }, ctx());
    await cached.execute({ q: "a" }, ctx());
    expect(execute).toHaveBeenCalledTimes(4);
    expect(versionOf).not.toHaveBeenCalled();
  });

  it("leaves a tool outside the read set unwrapped", () => {
    const { t } = tool("apply_diff");
    expect(withToolResultCache(t)).toBe(t);
    expect([...CACHEABLE_TOOLS].sort()).toEqual([
      "read_file_slice",
      "search-knowledge",
      "search_code_context",
      "search_code_graph",
      "search_code_symbols",
    ]);
  });

  it("returns a copy, so a caller mutating a hit cannot change the entry", async () => {
    const { t } = tool("search_code_symbols", () => ({ text: "orig" }));
    const cache = new ToolResultCache();
    const cached = withToolResultCache(t, {
      cache: () => cache,
      version: async () => version("v1"),
    });
    const first = await cached.execute({ q: "a" }, ctx());
    first.text = "mutated";
    const hit = await cached.execute({ q: "a" }, ctx());
    hit.text = "mutated again";
    expect((await cached.execute({ q: "a" }, ctx())).text).toBe("orig");
  });

  it("exposes hit, miss and bypass counts on the Prometheus registry", async () => {
    const { t } = tool("search_code_graph");
    let complete = true;
    const cached = withToolResultCache(t, { version: async () => version("v1", complete) });
    await cached.execute({ query: "a" }, ctx()); // miss
    await cached.execute({ query: "a" }, ctx()); // hit
    complete = false;
    await cached.execute({ query: "a" }, ctx()); // bypass
    const text = await getMetricsRegistry().metrics();
    for (const outcome of ["hit", "miss", "bypass"]) {
      expect(text).toMatch(
        new RegExp(
          `metis_chat_tool_result_cache_total\\{[^}]*tool="search_code_graph"[^}]*outcome="${outcome}"[^}]*\\} 1`,
        ),
      );
    }
    expect(getToolResultCache().stats()).toMatchObject({ hit: 1, miss: 1, bypass: 1 });
  });
});

describe("ToolResultCache bounds", () => {
  const r = (text: string): RuntimeToolResult => ({ text });

  it("evicts the least recently used entry past the entry cap", () => {
    const cache = new ToolResultCache({ maxEntries: 2 });
    cache.set("a", r("A"));
    cache.set("b", r("B"));
    expect(cache.get("a")?.text).toBe("A"); // a is now the most recent
    cache.set("c", r("C"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.text).toBe("A");
    expect(cache.get("c")?.text).toBe("C");
    expect(cache.stats().entries).toBe(2);
  });

  it("evicts past the byte cap and never holds more bytes than it allows", () => {
    const cache = new ToolResultCache({ maxEntries: 100, maxBytes: 600 });
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, r("x".repeat(200)));
    const { bytes, entries } = cache.stats();
    expect(bytes).toBeLessThanOrEqual(600);
    expect(entries).toBe(2);
    expect(cache.get("k9")).toBeDefined();
    expect(cache.get("k0")).toBeUndefined();
  });

  it("does not store a single result larger than the byte cap", () => {
    const cache = new ToolResultCache({ maxBytes: 100 });
    cache.set("big", r("y".repeat(500)));
    expect(cache.get("big")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("replacing a key does not double-count its bytes", () => {
    const cache = new ToolResultCache();
    cache.set("a", r("1234"));
    const once = cache.stats().bytes;
    cache.set("a", r("1234"));
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: once });
  });

  it("expires an entry after its TTL", () => {
    let now = 1_000;
    const cache = new ToolResultCache({ ttlMs: 30 * 60_000, now: () => now });
    cache.set("a", r("A"));
    now += 30 * 60_000 - 1;
    expect(cache.get("a")?.text).toBe("A");
    now += 1;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("clear() empties the cache and its counts", () => {
    const cache = new ToolResultCache();
    cache.set("a", r("A"));
    cache.count("search_code_graph", "miss");
    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, hit: 0, miss: 0, bypass: 0 });
  });

  it("is on unless CHAT_TOOL_RESULT_CACHE_ENABLED is 0", () => {
    expect(toolResultCacheEnabled({})).toBe(true);
    expect(toolResultCacheEnabled({ CHAT_TOOL_RESULT_CACHE_ENABLED: "1" })).toBe(true);
    expect(toolResultCacheEnabled({ CHAT_TOOL_RESULT_CACHE_ENABLED: "0" })).toBe(false);
  });
});

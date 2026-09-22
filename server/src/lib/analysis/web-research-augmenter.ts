/**
 * Web Research Augmenter (Epic #597 / Issue #623; firewall support #929).
 *
 * Generates search queries from evidence needs, fetches results via a
 * pluggable WebSearchProvider, and produces evidence digests with domain
 * trust scoring.
 *
 * The search provider is pluggable and selected by `createSearchProvider()`:
 * - `WEB_SEARCH_PROVIDER=tavily|brave|google|stub` chooses the backend.
 * - Backward compatible: if `WEB_SEARCH_PROVIDER` is unset but
 *   `WEB_SEARCH_API_KEY` is set, Tavily is used (legacy behavior).
 * - When nothing is configured, a required key is missing, or `AI_OFFLINE=1`,
 *   the stub no-op provider is returned (keeps e2e/offline deterministic).
 *
 * All real providers honor corporate egress proxies via undici's `ProxyAgent`,
 * driven by `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.
 *
 * Future work (NOT implemented here): an AWS-native Bedrock Knowledge Base
 * web-crawler data source would let web research egress from AWS rather than
 * the corporate network — a firewall-friendly alternative tracked separately.
 */
import { randomUUID } from "node:crypto";
import { ProxyAgent, type Dispatcher } from "undici";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import type {
  DomainTrust,
  EvidenceDigest,
  EvidenceNeed,
  StructuredRequirement,
  WebResearchResult,
  WebSearchProvider,
  WebSearchHit,
  WebSource,
} from "./types/requirements.js";

const log = createChildLogger("web-research-augmenter");

// ── Domain trust heuristics ────────────────────────────────────────────

const HIGH_TRUST_DOMAINS = new Set([
  "gov",
  "edu",
  "ieee.org",
  "acm.org",
  "nist.gov",
  "iso.org",
  "w3.org",
  "rfc-editor.org",
  "ietf.org",
  "owasp.org",
]);

const LOW_TRUST_DOMAINS = new Set(["reddit.com", "quora.com", "yahoo.com", "answers.com"]);

export function scoreDomainTrust(url: string): DomainTrust {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const d of HIGH_TRUST_DOMAINS) {
      if (hostname.endsWith(d)) return "high";
    }
    for (const d of LOW_TRUST_DOMAINS) {
      if (hostname.endsWith(d)) return "low";
    }
    return "medium";
  } catch {
    return "low";
  }
}

// ── Corporate proxy support (#929) ─────────────────────────────────────

/**
 * Return true when `hostname` should bypass the proxy per the `NO_PROXY`
 * rules. Supports comma/space separated entries, a literal `*` (bypass all),
 * leading-dot/suffix matches (`.example.com`, `example.com`) and exact hosts.
 */
export function shouldBypassProxy(hostname: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  const entries = noProxy
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry === "*") return true;
    const bare = entry.replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * Build an undici `ProxyAgent` dispatcher for the given target URL when an
 * `HTTPS_PROXY` / `HTTP_PROXY` env var is set and the host is not excluded by
 * `NO_PROXY`. Returns `undefined` when no proxy applies (direct connection).
 *
 * Env vars are read in both upper- and lower-case forms (the de-facto
 * convention) to play nicely with various corporate setups.
 */
export function getProxyDispatcher(targetUrl: string): Dispatcher | undefined {
  let hostname: string;
  let isHttps: boolean;
  try {
    const parsed = new URL(targetUrl);
    hostname = parsed.hostname;
    isHttps = parsed.protocol === "https:";
  } catch {
    return undefined;
  }

  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  if (shouldBypassProxy(hostname, noProxy)) return undefined;

  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  const proxyUrl = (isHttps ? httpsProxy : httpProxy) ?? httpsProxy ?? httpProxy;
  if (!proxyUrl) return undefined;

  try {
    return new ProxyAgent(proxyUrl);
  } catch (err) {
    // The URL itself is deliberately not logged: a proxy URL can carry
    // `user:password@` credentials.
    log.warn("Invalid proxy URL", { error: (err as Error).message });
    return undefined;
  }
}

/**
 * Proxy-aware fetch wrapper. Applies a `ProxyAgent` dispatcher when the
 * environment requests one; otherwise behaves like a plain `fetch`.
 */
export async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher(url);
  if (dispatcher) {
    // `dispatcher` is an undici-specific RequestInit extension not present in
    // the DOM lib types; cast through `unknown` rather than widening the init
    // (the workspace pulls multiple undici versions whose Dispatcher types are
    // structurally distinct, so a direct cast is rejected).
    return fetch(url, { ...init, dispatcher } as unknown as RequestInit);
  }
  return fetch(url, init);
}

// ── Query generation prompt ────────────────────────────────────────────

const QUERY_SYSTEM_PROMPT = `You are a search query generator. Given a requirement and an evidence need, produce 1-3 search queries that would find authoritative sources to validate or clarify the need.

Respond ONLY with a JSON array of strings. No markdown fences or commentary.`;

// ── Digest generation prompt ───────────────────────────────────────────

const DIGEST_SYSTEM_PROMPT = `You are a research analyst. Given search results for a requirement evidence need, produce a concise digest summarising the key findings. Note any conflicting information.

Respond ONLY with a plain text digest (2-4 sentences). No JSON wrapping.`;

// ── Stub search provider ───────────────────────────────────────────────

export class StubWebSearchProvider implements WebSearchProvider {
  async search(_query: string, _maxResults?: number): Promise<WebSearchHit[]> {
    return [];
  }
}

// ── Tavily search provider ─────────────────────────────────────────────

export class TavilySearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.tavily.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async search(query: string, maxResults = 5): Promise<WebSearchHit[]> {
    try {
      const response = await proxyFetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: maxResults,
          search_depth: "basic",
        }),
      });

      if (!response.ok) {
        log.warn("Tavily search failed", {
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      const data = (await response.json()) as {
        results?: Array<{ url: string; title: string; content: string; score?: number }>;
      };

      return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content,
        score: r.score,
      }));
    } catch (err) {
      log.warn("Tavily search error", { error: (err as Error).message });
      return [];
    }
  }
}

// ── Brave Search provider (#929) ───────────────────────────────────────

export class BraveSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.search.brave.com/res/v1/web/search") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async search(query: string, maxResults = 5): Promise<WebSearchHit[]> {
    try {
      const url = `${this.baseUrl}?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const response = await proxyFetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
      });

      if (!response.ok) {
        log.warn("Brave search failed", {
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      const data = (await response.json()) as {
        web?: {
          results?: Array<{ url: string; title: string; description?: string }>;
        };
      };

      return (data.web?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.description ?? "",
      }));
    } catch (err) {
      log.warn("Brave search error", { error: (err as Error).message });
      return [];
    }
  }
}

// ── Google Programmable Search (CSE) provider (#929) ───────────────────

export class GoogleCseProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly cseId: string;
  private readonly baseUrl: string;

  constructor(
    apiKey: string,
    cseId: string,
    baseUrl = "https://www.googleapis.com/customsearch/v1",
  ) {
    this.apiKey = apiKey;
    this.cseId = cseId;
    this.baseUrl = baseUrl;
  }

  async search(query: string, maxResults = 5): Promise<WebSearchHit[]> {
    try {
      // Google CSE caps `num` at 10 per request.
      const num = Math.min(Math.max(maxResults, 1), 10);
      const url =
        `${this.baseUrl}?key=${encodeURIComponent(this.apiKey)}` +
        `&cx=${encodeURIComponent(this.cseId)}` +
        `&q=${encodeURIComponent(query)}&num=${num}`;
      const response = await proxyFetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        log.warn("Google CSE search failed", {
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      const data = (await response.json()) as {
        items?: Array<{ link: string; title: string; snippet?: string }>;
      };

      return (data.items ?? []).map((r) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet ?? "",
      }));
    } catch (err) {
      log.warn("Google CSE search error", { error: (err as Error).message });
      return [];
    }
  }
}

// ── Main augmenter class ───────────────────────────────────────────────

export interface WebResearchAugmenterDeps {
  provider: AIProvider;
  searchProvider?: WebSearchProvider;
  model?: string;
  /** Max concurrent searches. Default 3. */
  concurrency?: number;
}

/**
 * Create the appropriate search provider based on environment.
 *
 * Selection order:
 *  1. `AI_OFFLINE=1` → always the stub no-op (preserves offline determinism).
 *  2. `WEB_SEARCH_PROVIDER` (tavily|brave|google|stub) → explicit selection.
 *  3. Legacy fallback: `WEB_SEARCH_API_KEY` set (and no provider chosen) → Tavily.
 *  4. Nothing configured → stub no-op.
 *
 * A selected provider with a missing required key/id logs a warning and falls
 * back to the stub — it never throws.
 */
export function createSearchProvider(): WebSearchProvider {
  if (process.env.AI_OFFLINE === "1") {
    log.info("AI_OFFLINE=1 — using stub search provider");
    return new StubWebSearchProvider();
  }

  const selected = process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();

  switch (selected) {
    case "stub":
      log.info("WEB_SEARCH_PROVIDER=stub — using stub search provider");
      return new StubWebSearchProvider();

    case "tavily": {
      const apiKey = process.env.WEB_SEARCH_API_KEY;
      if (!apiKey) {
        log.warn("WEB_SEARCH_PROVIDER=tavily but WEB_SEARCH_API_KEY is unset — using stub");
        return new StubWebSearchProvider();
      }
      log.info("Using Tavily web search provider");
      return new TavilySearchProvider(apiKey);
    }

    case "brave": {
      const apiKey = process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) {
        log.warn("WEB_SEARCH_PROVIDER=brave but BRAVE_SEARCH_API_KEY is unset — using stub");
        return new StubWebSearchProvider();
      }
      log.info("Using Brave web search provider");
      return new BraveSearchProvider(apiKey);
    }

    case "google": {
      const apiKey = process.env.GOOGLE_CSE_API_KEY;
      const cseId = process.env.GOOGLE_CSE_ID;
      if (!apiKey || !cseId) {
        log.warn(
          "WEB_SEARCH_PROVIDER=google but GOOGLE_CSE_API_KEY/GOOGLE_CSE_ID is unset — using stub",
        );
        return new StubWebSearchProvider();
      }
      log.info("Using Google CSE web search provider");
      return new GoogleCseProvider(apiKey, cseId);
    }

    default: {
      if (selected) {
        log.warn("Unknown WEB_SEARCH_PROVIDER — using stub", { provider: selected });
        return new StubWebSearchProvider();
      }
      // Backward compatible: no explicit provider but legacy Tavily key present.
      const apiKey = process.env.WEB_SEARCH_API_KEY;
      if (apiKey) {
        log.info("Using Tavily web search provider (legacy WEB_SEARCH_API_KEY)");
        return new TavilySearchProvider(apiKey);
      }
      log.info("No web search provider configured — using stub search provider");
      return new StubWebSearchProvider();
    }
  }
}

export class WebResearchAugmenter {
  private readonly provider: AIProvider;
  private readonly searchProvider: WebSearchProvider;
  private readonly model: string | undefined;
  private readonly concurrency: number;

  constructor(deps: WebResearchAugmenterDeps) {
    this.provider = deps.provider;
    this.searchProvider = deps.searchProvider ?? new StubWebSearchProvider();
    this.model = deps.model;
    this.concurrency = deps.concurrency ?? 3;
  }

  /**
   * Augment requirements with web research evidence.
   */
  async augment(
    requirements: StructuredRequirement[],
    signal?: AbortSignal,
  ): Promise<WebResearchResult> {
    const allNeeds = requirements.flatMap((r) =>
      r.evidenceNeeds.map((need) => ({ requirement: r, need })),
    );

    if (allNeeds.length === 0) {
      return { digests: [], totalSources: 0, reviewRequired: 0 };
    }

    log.info("Augmenting evidence needs", {
      evidenceNeeds: allNeeds.length,
      requirements: requirements.length,
    });

    const digests: EvidenceDigest[] = [];
    // Process in batches to respect rate limits
    for (let i = 0; i < allNeeds.length; i += this.concurrency) {
      if (signal?.aborted) break;
      const batch = allNeeds.slice(i, i + this.concurrency);
      const results = await Promise.all(
        batch.map((item) => this.processEvidenceNeed(item.requirement, item.need, signal)),
      );
      digests.push(...results.filter((d): d is EvidenceDigest => d !== null));
    }

    const totalSources = digests.reduce((sum, d) => sum + d.sources.length, 0);
    const reviewRequired = digests.filter((d) => d.needsHumanReview).length;

    log.info("Web research complete", {
      digests: digests.length,
      sources: totalSources,
      reviewRequired,
    });

    return { digests, totalSources, reviewRequired };
  }

  /**
   * Process a single evidence need: generate queries, search, digest.
   */
  private async processEvidenceNeed(
    requirement: StructuredRequirement,
    need: EvidenceNeed,
    signal?: AbortSignal,
  ): Promise<EvidenceDigest | null> {
    try {
      const queries = await this.generateQueries(requirement, need, signal);
      if (queries.length === 0) return null;

      const allResults: WebSearchHit[] = [];
      for (const query of queries) {
        if (signal?.aborted) break;
        const results = await this.searchProvider.search(query, 5);
        allResults.push(...results);
      }

      if (allResults.length === 0) {
        return {
          id: randomUUID(),
          requirementId: requirement.id,
          evidenceNeedId: need.id,
          query: queries.join(" | "),
          sources: [],
          digest: "No web sources found for this evidence need.",
          needsHumanReview: true,
        };
      }

      // Deduplicate by URL
      const uniqueResults = this.deduplicateResults(allResults);

      const sources: WebSource[] = uniqueResults.slice(0, 5).map((r) => ({
        url: r.url,
        title: r.title,
        excerpt: r.snippet,
        relevanceScore: r.score ?? 0.5,
        domainTrust: scoreDomainTrust(r.url),
      }));

      const digest = await this.generateDigest(requirement, need, sources, signal);
      const needsHumanReview = sources.some((s) => s.domainTrust === "low") || sources.length < 2;

      return {
        id: randomUUID(),
        requirementId: requirement.id,
        evidenceNeedId: need.id,
        query: queries.join(" | "),
        sources,
        digest,
        needsHumanReview,
      };
    } catch (err) {
      log.warn("Failed to process evidence need", {
        evidenceNeedId: need.id,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Use the LLM to generate 1-3 search queries from an evidence need.
   */
  async generateQueries(
    requirement: StructuredRequirement,
    need: EvidenceNeed,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const messages: ChatMessage[] = [
      { role: "system", content: QUERY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Requirement: ${requirement.title}\nDescription: ${requirement.description}\n\nEvidence need: ${need.description}\nDomain: ${need.domain}\nHints: ${need.searchHints.join(", ")}`,
      },
    ];

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal,
      disableTools: true,
    });

    try {
      const cleaned = response.content
        .replace(/^```(?:json)?\s*\n?/m, "")
        .replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed.filter((q): q is string => typeof q === "string").slice(0, 3);
      }
    } catch {
      log.warn("Failed to parse query generation response");
    }

    // Fallback: use the evidence need description itself
    return [need.description];
  }

  /**
   * Generate a digest summarising search results.
   */
  private async generateDigest(
    requirement: StructuredRequirement,
    need: EvidenceNeed,
    sources: WebSource[],
    signal?: AbortSignal,
  ): Promise<string> {
    const sourceSummary = sources
      .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.excerpt}`)
      .join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: DIGEST_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Requirement: ${requirement.title}\nEvidence need: ${need.description}\n\nSearch results:\n${sourceSummary}`,
      },
    ];

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal,
      disableTools: true,
    });

    return response.content.trim();
  }

  private deduplicateResults(results: WebSearchHit[]): WebSearchHit[] {
    const seen = new Set<string>();
    return results.filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
  }
}

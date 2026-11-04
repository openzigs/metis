/**
 * #1763 — each repo's own share of the search hits in portfolio gap analysis,
 * on a real SQLite database built by the migration chain, over the synthetic
 * portfolio in `fixtures/portfolio-gap-1622.ts`.
 *
 * The scenario the flag exists for: a product's repo whose sibling dominates
 * one shared ranking reads `no-evidence-retrieved` with the flag off, and gets
 * its own excerpts and a verdict with it on. `implemented` still needs a
 * citation either way. Every assessment is read back from the database.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type PortfolioAssessment } from "@metis/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import {
  P1,
  PROJECTS,
  RC_P1_API,
  RC_P1_WEB,
  RC_P2,
  RESET_CRITERIA,
  RESET_STATEMENT,
  WS_A,
  WS_B,
  fixtureKnowledgeService,
  scriptedProvider,
  seedPortfolio,
} from "./fixtures/portfolio-gap-1622.js";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";
import type {
  FederatedHit,
  FederatedSearchOptions,
  FederatedSearchResult,
} from "../src/lib/rag/federated-search-service.js";
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { runPortfolioGapAnalysis, perRepoHitQuota, readPortfolioGapLimits } =
  await import("../src/lib/portfolio/gap-engine.js");
const { getPortfolioAssessment } = await import("../src/lib/portfolio/assessment-store.js");
const { FederatedSearchService } = await import("../src/lib/rag/federated-search-service.js");

const MIA: AuthPayload = {
  userId: "mia",
  username: "mia",
  role: "coordinator",
  permissions: getPermissionsForRole("coordinator"),
  workspaces: [WS_A, WS_B],
};

/** A product with one repo in each of two projects (P1's two repos share one). */
const P4 = "prod-p4-1763";
const RC_P4_CORE = "rc-p4-core-1763";
const RC_P4_MAIL = "rc-p4-mail-1763";
const ACCOUNTS = PROJECTS[0].id;
const SUPPORT = PROJECTS[1].id;

const unlimited = { runCostCapUsd: 100, productCostCapUsd: 100, concurrency: 4 };
const perRepo = { ...unlimited, perRepoSearch: true };

/** A repository source chunk of `repo`, as the knowledge index returns one. */
function chunk(repo: string, i: number, path: string, text: string) {
  return {
    chunkId: `${repo}:${i}`,
    documentId: `doc-${repo}-${i}`,
    filename: `connector:repo:${repo}:src/${path}`,
    path,
    position: i,
    text,
    score: 1,
  };
}

/** `n` excerpts of `repo` that match no criterion, ranked above anything after them. */
const filler = (repo: string, n: number) =>
  Array.from({ length: n }, (_, i) => chunk(repo, 100 + i, `src/util/u${i}.ts`, `util${i}()`));

/**
 * The accounts project's ranking: `accounts-api` dominates it with 30 excerpts
 * that match nothing, and `accounts-web`'s one excerpt, which emails the reset
 * link, ranks 31st.
 */
function dominatedKnowledge(): KnowledgeService {
  return {
    async search(projectId: string) {
      const hits =
        projectId === ACCOUNTS
          ? [
              ...filler(RC_P1_API, 30),
              chunk(RC_P1_WEB, 0, "src/mail.ts", "export const go = () => sendResetEmail(user);"),
            ]
          : [];
      return { hits, mode: "hybrid" };
    },
  } as unknown as KnowledgeService;
}

const federated = new FederatedSearchService({ knowledgeService: dominatedKnowledge() });
const dominatedSearch = federated.searchAcrossProjects.bind(federated);

async function run(
  input: Parameters<typeof runPortfolioGapAnalysis>[1],
  deps: Parameters<typeof runPortfolioGapAnalysis>[2] = {},
): Promise<PortfolioAssessment> {
  const { assessmentId } = await runPortfolioGapAnalysis(MIA, input, {
    provider: scriptedProvider(),
    search: dominatedSearch,
    limits: unlimited,
    costOf: () => 0.01,
    ...deps,
  });
  const read = await getPortfolioAssessment(assessmentId);
  if (!read) throw new Error("assessment did not persist");
  return read;
}

const reset = (productId: string) => ({
  statement: RESET_STATEMENT,
  criteria: RESET_CRITERIA,
  scope: "product" as const,
  productIds: [productId],
});

const repoDetail = (a: PortfolioAssessment, productId: string) =>
  a.products.find((p) => p.productId === productId)!.technicalDetail.repos as Array<{
    repoConnectionId: string;
    verdict: string;
    criteria: string[];
    reason: string | null;
  }>;
const reasonOf = (a: PortfolioAssessment, productId: string, repo: string) =>
  repoDetail(a, productId).find((r) => r.repoConnectionId === repo)!.reason;

/** The code excerpts the verdict prompt naming `label` carried. */
function excerptsShown(prompts: readonly string[], label: string): number {
  const prompt = prompts.find((p) => p.includes(`<<<REPOSITORY>>>\n${label}\n`));
  if (!prompt) return 0;
  const code = prompt.slice(prompt.indexOf("<<<CODE>>>"), prompt.indexOf("<<<END CODE>>>"));
  return code.split("\n").filter((line) => /^\[\d+\] /.test(line)).length;
}

/** A search that answers each project's call from `byProject`, recording every call. */
function recordingSearch(byProject: Record<string, FederatedHit[]>, failing: string[] = []) {
  const calls: FederatedSearchOptions[] = [];
  const search = async (opts: FederatedSearchOptions): Promise<FederatedSearchResult> => {
    calls.push(opts);
    const ids = opts.projectIds ?? [];
    if (ids.some((id) => failing.includes(id))) throw new Error("index offline");
    // One shared ranking: the first project's excerpts fill every slot.
    const hits = ids.flatMap((id) => byProject[id] ?? []).slice(0, opts.k);
    return { hits, projectsSearched: ids, projectsFailed: [], totalHits: hits.length };
  };
  return { search, calls };
}

const federatedHit = (projectId: string, c: ReturnType<typeof chunk>): FederatedHit => ({
  ...c,
  projectId,
  projectName: projectId,
});

/** P4's two projects: `core` dominates the shared ranking; `mail` resets by email. */
const P4_HITS: Record<string, FederatedHit[]> = {
  [ACCOUNTS]: filler(RC_P4_CORE, 30).map((c) => federatedHit(ACCOUNTS, c)),
  [SUPPORT]: [
    federatedHit(
      SUPPORT,
      chunk(RC_P4_MAIL, 0, "src/reset.ts", "resetPassword(t); sendResetEmail(u);"),
    ),
  ],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1763 — each repo's own share of the portfolio gap search",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1763-portfolio-gap-per-repo");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedPortfolio(db, { mia: [WS_A, WS_B] });
      await db.product.create({
        data: { id: P4, name: "Messaging", workspaceId: WS_A, slug: P4, createdById: "mia" },
      });
      for (const [id, projectId, name] of [
        [RC_P4_CORE, ACCOUNTS, "core"],
        [RC_P4_MAIL, SUPPORT, "mail"],
      ] as const) {
        await db.repoConnection.create({
          data: { id, projectId, label: name, ownerOrOrg: "acme", repoName: name },
        });
        await db.productRepo.create({ data: { productId: P4, repoConnectionId: id } });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("flag off: a repo a sibling crowds out of the shared search reads no-evidence-retrieved", async () => {
      const provider = scriptedProvider();
      const a = await run(reset(P1), { provider });
      expect(reasonOf(a, P1, RC_P1_WEB)).toBe("no-evidence-retrieved");
      expect(reasonOf(a, P1, RC_P1_API)).toBeNull();
      // Today's shared search: 24 excerpts, all of them the dominant repo's.
      expect(excerptsShown(provider.prompts, "acme/accounts-api")).toBe(24);
      expect(a.products[0].coverage).toBe("not-checked");
    });

    it("flag on: the crowded-out repo of the same project gets its own excerpts and a cited verdict", async () => {
      const provider = scriptedProvider();
      const a = await run(reset(P1), { provider, limits: perRepo });
      expect(reasonOf(a, P1, RC_P1_WEB)).toBeNull();
      const web = repoDetail(a, P1).find((r) => r.repoConnectionId === RC_P1_WEB)!;
      expect(web.criteria).toEqual(["gap-confirmed", "implemented"]);
      expect(a.repos.find((r) => r.repoConnectionId === RC_P1_WEB)!.citations).toEqual([
        expect.objectContaining({ filePath: "src/mail.ts", repoConnectionId: RC_P1_WEB }),
      ]);
      // Each repo keeps at most its share: 24 split over two repos.
      expect(excerptsShown(provider.prompts, "acme/accounts-api")).toBe(12);
      expect(excerptsShown(provider.prompts, "acme/accounts-web")).toBe(1);
      expect(a.products[0].coverage).toBe("partial");
    });

    it("flag on: one search per project, each sized to its repos' share; the second repo gets a verdict", async () => {
      const off = recordingSearch(P4_HITS);
      const before = await run(reset(P4), { search: off.search });
      expect(off.calls).toHaveLength(1);
      expect(reasonOf(before, P4, RC_P4_MAIL)).toBe("no-evidence-retrieved");

      const on = recordingSearch(P4_HITS);
      const provider = scriptedProvider();
      const after = await run(reset(P4), { search: on.search, provider, limits: perRepo });
      expect(on.calls.map((c) => [c.projectIds, c.k])).toEqual([
        [[ACCOUNTS], 24],
        [[SUPPORT], 24],
      ]);
      expect(reasonOf(after, P4, RC_P4_MAIL)).toBeNull();
      expect(repoDetail(after, P4).find((r) => r.repoConnectionId === RC_P4_MAIL)!.verdict).toBe(
        "implemented",
      );
      expect(after.products[0].coverage).toBe("covers");
      expect(excerptsShown(provider.prompts, "acme/core")).toBe(12);
    });

    it("flag on: the per-repo and per-product bounds hold", async () => {
      const on = recordingSearch(P4_HITS);
      const provider = scriptedProvider();
      await run(reset(P4), {
        search: on.search,
        provider,
        limits: { ...perRepo, hitsPerRepo: 3 },
      });
      expect(excerptsShown(provider.prompts, "acme/core")).toBe(3);
      expect(on.calls.map((c) => c.k)).toEqual([6, 6]);

      const tight = recordingSearch(P4_HITS);
      const shown = scriptedProvider();
      await run(reset(P4), {
        search: tight.search,
        provider: shown,
        limits: { ...perRepo, hitsPerProduct: 10 },
      });
      // 10 across two repos: five each, under the per-repo 12.
      expect(excerptsShown(shown.prompts, "acme/core")).toBe(5);
    });

    it("flag on: a failed project search leaves only that project's repos retrieval-failed", async () => {
      const { search } = recordingSearch(P4_HITS, [ACCOUNTS]);
      const a = await run(reset(P4), { search, limits: perRepo });
      expect(reasonOf(a, P4, RC_P4_CORE)).toBe("retrieval-failed");
      expect(reasonOf(a, P4, RC_P4_MAIL)).toBeNull();
    });

    it("flag on: a project the search did not reach is retrieval-failed", async () => {
      const search = async (opts: FederatedSearchOptions): Promise<FederatedSearchResult> => ({
        hits: [],
        projectsSearched: [],
        projectsFailed: opts.projectIds ?? [],
        totalHits: 0,
      });
      const a = await run(reset(P4), { search, limits: perRepo });
      expect(reasonOf(a, P4, RC_P4_CORE)).toBe("retrieval-failed");
      expect(reasonOf(a, P4, RC_P4_MAIL)).toBe("retrieval-failed");
    });

    it("flag on: an aborted run starts no further project search and rejects", async () => {
      const controller = new AbortController();
      let calls = 0;
      const search = async (): Promise<FederatedSearchResult> => {
        calls += 1;
        controller.abort(new Error("cancelled"));
        throw new Error("index offline");
      };
      await expect(
        runPortfolioGapAnalysis(MIA, reset(P4), {
          provider: scriptedProvider(),
          search,
          limits: perRepo,
          signal: controller.signal,
        }),
      ).rejects.toThrow("cancelled");
      // P4's second project is never searched once the run is aborted.
      expect(calls).toBe(1);
    });

    it("flag on: no implemented verdict without a citation", async () => {
      // A model that claims every criterion implemented and cites nothing.
      const claimsEverything: AIProvider = {
        ...scriptedProvider(),
        async chat(): Promise<ChatResponse> {
          return {
            content: JSON.stringify({
              criteria: RESET_CRITERIA.map((_, i) => ({
                index: i + 1,
                verdict: "implemented",
                excerpts: [],
                reason: "Trust me.",
              })),
            }),
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "scripted-1622",
            provider: "openai",
          };
        },
      } as AIProvider;
      const a = await run(reset(P1), { provider: claimsEverything, limits: perRepo });
      for (const r of repoDetail(a, P1)) expect(r.criteria).not.toContain("implemented");
      expect(a.repos.flatMap((r) => r.citations)).toEqual([]);

      // And over the whole portfolio, every criterion found implemented is cited.
      const fixture = new FederatedSearchService({ knowledgeService: fixtureKnowledgeService() });
      const all = await run(
        { ...reset(P1), scope: "all-accessible", productIds: [] },
        { search: fixture.searchAcrossProjects.bind(fixture), limits: perRepo },
      );
      const implemented = all.products.flatMap((p) =>
        p.coverage === "restricted"
          ? []
          : repoDetail(all, p.productId).filter((r) => r.criteria.includes("implemented")),
      );
      expect(implemented.map((r) => r.repoConnectionId).sort()).toEqual([RC_P1_API, RC_P2]);
      for (const r of implemented) {
        const stored = all.repos.find((s) => s.repoConnectionId === r.repoConnectionId)!;
        expect(stored.citations.length).toBeGreaterThan(0);
      }
    });

    it("reads the hit bounds and the flag from config, off by default", () => {
      expect(readPortfolioGapLimits()).toMatchObject({
        hitsPerProduct: 24,
        hitsPerRepo: 12,
        perRepoSearch: false,
      });
      vi.stubEnv("PORTFOLIO_GAP_PER_REPO_SEARCH", "true");
      vi.stubEnv("PORTFOLIO_GAP_HITS_PER_REPO", "5");
      vi.stubEnv("PORTFOLIO_GAP_HITS_PER_PRODUCT", "40");
      expect(readPortfolioGapLimits()).toMatchObject({
        hitsPerProduct: 40,
        hitsPerRepo: 5,
        perRepoSearch: true,
      });
    });

    it("splits the product's hits evenly, at most hitsPerRepo and at least one each", () => {
      const limits = { hitsPerProduct: 24, hitsPerRepo: 12 };
      expect(perRepoHitQuota(limits, 1)).toBe(12);
      expect(perRepoHitQuota(limits, 2)).toBe(12);
      expect(perRepoHitQuota(limits, 3)).toBe(8);
      expect(perRepoHitQuota(limits, 100)).toBe(1);
      expect(perRepoHitQuota(limits, 0)).toBe(12);
    });
  },
);

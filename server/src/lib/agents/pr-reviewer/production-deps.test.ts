/**
 * #1471 — the production PR-review judge and GitHub client resolvers.
 *
 * No model and no GitHub: the provider is a stub `AIProvider`, and the GitHub
 * client comes from the real `acquirePublishOctokit` with its factory replaced
 * by a recorder (`__setPublishOctokitFactory`), so the resolver's real target
 * validation (`resolvePublishTarget`) and client cache run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../../ai/types.js";

const resolveProjectProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../../ai/project-provider.js", () => ({
  resolveProjectProvider: resolveProjectProviderMock,
}));
const findFirstMock = vi.hoisted(() => vi.fn());
vi.mock("../../prisma.js", () => ({ prisma: { repoConnection: { findFirst: findFirstMock } } }));
const readBoundSecretMock = vi.hoisted(() => vi.fn());
vi.mock("../../connectors/vault-resolver.js", () => ({ readBoundSecret: readBoundSecretMock }));
vi.mock("../../vault/vault-service.js", () => ({ getVaultService: () => ({}) }));
const logged = vi.hoisted(() => [] as Array<{ msg: string; meta: unknown }>);
vi.mock("../../logger.js", () => {
  const rec = (msg: string, meta?: unknown) => logged.push({ msg, meta });
  return {
    createChildLogger: () => ({ warn: rec, info: rec, error: rec, debug: rec }),
  };
});

const { judgeFromProvider, resolvePrReviewJudge, resolvePrReviewOctokit, prReviewOctokitFrom } =
  await import("./production-deps.js");
const { __setPublishOctokitFactory, __resetPublishOctokitCache } =
  await import("../../publishing/octokit-factory.js");
const { fetchPullRequest } = await import("./pull-request-fetcher.js");

const TOKEN = "ghp_SECRET_TOKEN_1471_value";
const JOB = {
  deliveryId: "d1",
  projectId: "p1",
  owner: "acme",
  repo: "site",
  prNumber: 7,
  context: {},
  attempt: 1,
  enqueuedAt: 0,
};

function stubProvider(over: Partial<AIProvider> = {}, reply?: Partial<ChatResponse>): AIProvider {
  return {
    key: "anthropic",
    model: "claude-sonnet-4-6",
    offline: false,
    chat: vi.fn(async () => ({
      content: '{"verdicts":[]}',
      usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      ...reply,
    })),
    stream: vi.fn() as never,
    embed: vi.fn() as never,
    models: vi.fn() as never,
    ping: vi.fn() as never,
    ...over,
  } as AIProvider;
}

const factoryCalls: Array<Record<string, unknown>> = [];
const requests: Array<Record<string, unknown>> = [];

beforeEach(() => {
  logged.length = 0;
  factoryCalls.length = 0;
  requests.length = 0;
  resolveProjectProviderMock.mockReset();
  findFirstMock.mockReset();
  readBoundSecretMock.mockReset();
  readBoundSecretMock.mockResolvedValue(TOKEN);
  __resetPublishOctokitCache();
  __setPublishOctokitFactory(async (args) => {
    factoryCalls.push({ ...args });
    return {
      request: async (a: Record<string, unknown>) => {
        requests.push(a);
        return { status: 200, headers: {}, data: { id: 1, html_url: "https://x" } as never };
      },
    } as never;
  });
});
afterEach(() => {
  __setPublishOctokitFactory(null);
});

describe("judgeFromProvider", () => {
  it("sends system + user, and reports the tokens, model and priced cost", async () => {
    const provider = stubProvider();
    const out = await judgeFromProvider(provider).evaluate({ system: "S", user: "U" });
    expect(provider.chat).toHaveBeenCalledWith(
      [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      { disableTools: true },
    );
    expect(out).toMatchObject({
      raw: '{"verdicts":[]}',
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      inputTokens: 1000,
      outputTokens: 200,
    });
    expect(typeof out === "object" && out.costUsd).toBeGreaterThan(0);
    expect(Number.isFinite(typeof out === "object" ? out.costUsd : NaN)).toBe(true);
  });

  it("an unpriced model reports a non-finite cost (recorded unpriced, never $0)", async () => {
    const provider = stubProvider({}, { model: "no-such-model-1471", provider: "local" as never });
    const out = await judgeFromProvider(provider).evaluate({ system: "S", user: "U" });
    expect(typeof out === "object" && Number.isNaN(out.costUsd)).toBe(true);
  });
});

describe("resolvePrReviewJudge", () => {
  it("builds the judge from the project's provider", async () => {
    const provider = stubProvider();
    resolveProjectProviderMock.mockResolvedValue(provider);
    const judge = await resolvePrReviewJudge(JOB);
    expect(resolveProjectProviderMock).toHaveBeenCalledWith("p1");
    await judge!.evaluate({ system: "s", user: "u" });
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("is null when the project's provider is not configured on this server", async () => {
    resolveProjectProviderMock.mockRejectedValue(
      Object.assign(new Error("key sk-123 missing at https://host"), { code: "AI_PROVIDER" }),
    );
    expect(await resolvePrReviewJudge(JOB)).toBeNull();
    expect(JSON.stringify(logged)).not.toContain("sk-123");
  });

  it("is null for the offline stub, which would review with canned text", async () => {
    const provider = stubProvider({ offline: true });
    resolveProjectProviderMock.mockResolvedValue(provider);
    expect(await resolvePrReviewJudge(JOB)).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });
});

describe("resolvePrReviewOctokit", () => {
  const conn = (over: Record<string, unknown> = {}) => ({
    provider: "github",
    apiBaseUrl: null,
    secretId: "sec-1",
    ...over,
  });

  it("looks up the project's live connector for the job's repo, and authenticates with its secret", async () => {
    findFirstMock.mockResolvedValue(conn());
    const client = await resolvePrReviewOctokit(JOB);
    expect(client).not.toBeNull();
    const where = findFirstMock.mock.calls[0][0].where;
    expect(where).toMatchObject({
      projectId: "p1",
      ownerOrOrg: "acme",
      repoName: "site",
      deletedAt: null,
    });
    expect(readBoundSecretMock).toHaveBeenCalledWith("sec-1", expect.anything());
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]).toMatchObject({ baseUrl: "https://api.github.com", token: TOKEN });
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  it("uses a GitHub Enterprise connector's API base URL, pinned", async () => {
    findFirstMock.mockResolvedValue(
      conn({ provider: "github_enterprise", apiBaseUrl: "https://140.82.112.6/api/v3/" }),
    );
    expect(await resolvePrReviewOctokit(JOB)).not.toBeNull();
    expect(factoryCalls[0]).toMatchObject({
      baseUrl: "https://140.82.112.6/api/v3",
      pinnedAddress: "140.82.112.6",
    });
  });

  it.each([
    ["no connector for the repo", null],
    ["a connector with no secret", { provider: "github", apiBaseUrl: null, secretId: null }],
    ["a non-GitHub connector", { provider: "gitlab", apiBaseUrl: null, secretId: "sec-1" }],
    [
      "a plain-HTTP base URL",
      { provider: "github_enterprise", apiBaseUrl: "http://ghe.example", secretId: "sec-1" },
    ],
    [
      "a private host off the allow-list",
      { provider: "github_enterprise", apiBaseUrl: "https://10.0.0.5/api/v3", secretId: "sec-1" },
    ],
  ])("is null for %s, and reads no secret", async (_label, row) => {
    findFirstMock.mockResolvedValue(row);
    expect(await resolvePrReviewOctokit(JOB)).toBeNull();
    expect(readBoundSecretMock).not.toHaveBeenCalled();
    expect(factoryCalls).toHaveLength(0);
  });

  it("is null when the bound secret was deleted, and logs no secret material", async () => {
    findFirstMock.mockResolvedValue(conn());
    readBoundSecretMock.mockRejectedValue(
      Object.assign(new Error(`stale ${TOKEN}`), { code: "VAULT_BINDING_STALE" }),
    );
    expect(await resolvePrReviewOctokit(JOB)).toBeNull();
    expect(factoryCalls).toHaveLength(0);
    expect(JSON.stringify(logged)).toContain("VAULT_BINDING_STALE");
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  it("is null for an empty secret", async () => {
    findFirstMock.mockResolvedValue(conn());
    readBoundSecretMock.mockResolvedValue("");
    expect(await resolvePrReviewOctokit(JOB)).toBeNull();
    expect(factoryCalls).toHaveLength(0);
  });
});

describe("prReviewOctokitFrom", () => {
  const client = () =>
    prReviewOctokitFrom({
      request: async (a) => {
        requests.push(a as never);
        return { status: 200, headers: {}, data: { id: 42, html_url: "https://gh/r/42" } as never };
      },
    });

  it("reads a PR's diff with the diff media type", async () => {
    await client().pulls.get({
      owner: "ac me",
      repo: "si/te",
      pull_number: 7,
      mediaType: { format: "diff" },
    });
    expect(requests[0]).toEqual({
      method: "GET",
      url: "/repos/ac%20me/si%2Fte/pulls/7",
      headers: { accept: "application/vnd.github.diff" },
    });
  });

  it("reads a PR as JSON when no media type is asked for", async () => {
    await client().pulls.get({ owner: "acme", repo: "site", pull_number: 7 });
    expect(requests[0]).toEqual({ method: "GET", url: "/repos/acme/site/pulls/7" });
  });

  it("posts a review, returning its id and URL", async () => {
    const out = await client().pulls.createReview({
      owner: "acme",
      repo: "site",
      pull_number: 7,
      event: "COMMENT",
      body: "b",
      comments: [{ path: "a.ts", line: 1, body: "c" }],
    });
    expect(requests[0]).toEqual({
      method: "POST",
      url: "/repos/acme/site/pulls/7/reviews",
      data: { event: "COMMENT", body: "b", comments: [{ path: "a.ts", line: 1, body: "c" }] },
    });
    expect(out.data).toEqual({ id: 42, html_url: "https://gh/r/42" });
  });

  it("omits comments when there are none", async () => {
    await client().pulls.createReview({
      owner: "acme",
      repo: "site",
      pull_number: 7,
      event: "APPROVE",
      body: "b",
    });
    expect(requests[0].data).toEqual({ event: "APPROVE", body: "b" });
  });
});

describe("fetchPullRequest", () => {
  it("reads title, body, URL, head SHA and branch", async () => {
    const get = vi.fn(async () => ({
      data: {
        title: "T",
        body: "Closes #5",
        html_url: "https://github.com/acme/site/pull/7",
        head: { sha: "abc", ref: "feat" },
      },
    }));
    expect(await fetchPullRequest({ pulls: { get } }, JOB)).toEqual({
      title: "T",
      body: "Closes #5",
      htmlUrl: "https://github.com/acme/site/pull/7",
      headSha: "abc",
      branchName: "feat",
    });
  });

  it("falls back for a PR with no body, title or head", async () => {
    const get = vi.fn(async () => ({ data: { body: null } }));
    expect(await fetchPullRequest({ pulls: { get } }, JOB)).toEqual({
      title: "PR #7",
      body: "",
      htmlUrl: "https://github.com/acme/site/pull/7",
      headSha: null,
      branchName: null,
    });
  });
});

/**
 * GitHub Issues importer — count (GraphQL), pagination (Link header), PR
 * filtering, host guard, Enterprise base URL.
 */
import { describe, expect, it, vi } from "vitest";
import { GithubImporter } from "../src/lib/importers/github-importer.js";
import type { ExternalIssue, FetchFn } from "../src/lib/importers/types.js";

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const noGuard = () => undefined;
const fast = { sleep: async () => undefined, now: () => 0, random: () => 0 };

describe("GithubImporter", () => {
  it("count() reads search.issueCount via GraphQL", async () => {
    const fetchFn = vi.fn(async () => res(200, { data: { search: { issueCount: 42 } } }));
    const imp = new GithubImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const n = await imp.count({ owner: "o", repo: "r", state: "open" });
    expect(n).toBe(42);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fetchAll paginates via Link header and skips pull requests", async () => {
    const page1 = [
      { number: 1, title: "A", body: "b", html_url: "u1", state: "open", labels: ["bug"] },
      {
        number: 2,
        title: "PR",
        body: "",
        html_url: "u2",
        state: "open",
        labels: [],
        pull_request: {},
      },
    ];
    const page2 = [
      { number: 3, title: "C", body: null, html_url: "u3", state: "open", labels: [{ name: "x" }] },
    ];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, page1, { link: '<https://api.github.com/next>; rel="next"' }))
      .mockResolvedValueOnce(res(200, page2, {}));
    const imp = new GithubImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const out: ExternalIssue[] = [];
    const progress: number[] = [];
    for await (const i of imp.fetchAll(
      { owner: "o", repo: "r", state: "open" },
      {
        onProgress: (p) => progress.push(p.fetched),
      },
    )) {
      out.push(i);
    }
    expect(out.map((i) => i.externalId)).toEqual(["1", "3"]);
    expect(out[1].labels).toEqual(["x"]);
    expect(progress.length).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("uses the GitHub Enterprise base URL when configured", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => res(200, []));
    const imp = new GithubImporter({
      token: "t",
      baseUrl: "https://ghe.corp.local/",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const it = imp.fetchAll({ owner: "o", repo: "r", state: "open" });
    await it.next();
    expect(String(fetchFn.mock.calls[0][0])).toContain(
      "https://ghe.corp.local/api/v3/repos/o/r/issues",
    );
  });

  it("invokes the host guard before fetching", async () => {
    const guard = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => res(200, { data: { search: { issueCount: 0 } } }));
    const imp = new GithubImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: guard,
      backoff: fast,
    });
    await imp.count({ owner: "o", repo: "r", state: "open" });
    expect(guard).toHaveBeenCalledWith("api.github.com");
  });

  it("map() derives type from labels", () => {
    const imp = new GithubImporter({ token: "t" });
    const mapped = imp.map({
      externalId: "1",
      externalSource: "github",
      url: "u",
      title: "T",
      body: "b",
      labels: ["bug"],
    });
    expect(mapped.type).toBe("bug");
  });

  // Issue #979 — the walkthrough's import typed 12 issues titled "[Bug]: …" as
  // `feature`, because GitHub has no type field and no label said "bug".
  describe("map() type and title (#979)", () => {
    const imp = new GithubImporter({ token: "t" });
    const issue = (title: string, labels: string[] = []): ExternalIssue => ({
      externalId: "1",
      externalSource: "github",
      url: "u",
      title,
      body: "b",
      labels,
    });

    it("derives the type from a leading [Bug]: tag and strips it from the title", () => {
      const mapped = imp.map(issue("[Bug]: Feed refresh hangs"));
      expect(mapped.type).toBe("bug");
      expect(mapped.title).toBe("Feed refresh hangs");
    });

    it.each([
      ["[Feature Request] Dark mode", "feature", "Dark mode"],
      ["[Epic] - Billing", "epic", "Billing"],
      ["[Chore]: bump deps", "task", "bump deps"],
      ["[Docs] Fix typo", "task", "Fix typo"],
    ])("reads %s as %s", (title, type, clean) => {
      const mapped = imp.map(issue(title));
      expect(mapped.type).toBe(type);
      expect(mapped.title).toBe(clean);
    });

    it("leaves an unrecognised tag in the title and defaults to feature", () => {
      const mapped = imp.map(issue("[WIP] Something"));
      expect(mapped.type).toBe("feature");
      expect(mapped.title).toBe("[WIP] Something");
    });

    it("keeps a title that is nothing but a tag", () => {
      expect(imp.map(issue("[Bug]")).title).toBe("[Bug]");
    });

    it("prefers a label over the title tag", () => {
      const mapped = imp.map(issue("[Feature] Retry", ["type: bug"]));
      expect(mapped.type).toBe("bug");
      expect(mapped.title).toBe("Retry");
    });

    it.each([
      [["kind/bug"], "bug"],
      [["enhancement"], "feature"],
      [["Type: Epic"], "epic"],
      [["good first issue", "chore"], "task"],
      [["enhancement", "bug"], "bug"],
    ])("reads labels %j as %s", (labels, type) => {
      expect(imp.map(issue("Plain title", labels)).type).toBe(type);
    });

    it("defaults to feature when neither labels nor title name a type", () => {
      expect(imp.map(issue("Plain title", ["good first issue"])).type).toBe("feature");
    });
  });

  it("validates the host guard on every paginated URL including Link: next", async () => {
    const guard = vi.fn(async () => undefined);
    const page1 = [{ number: 1, title: "A", body: "", html_url: "u1", state: "open", labels: [] }];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, page1, { link: '<https://api.github.com/next>; rel="next"' }))
      .mockResolvedValueOnce(res(200, []));
    const imp = new GithubImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: guard,
      backoff: fast,
    });
    const issues: ExternalIssue[] = [];
    for await (const i of imp.fetchAll({ owner: "o", repo: "r", state: "open" })) {
      issues.push(i);
    }
    // Guard must be called for the initial URL AND the Link: next URL.
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenNthCalledWith(1, "api.github.com");
    expect(guard).toHaveBeenNthCalledWith(2, "api.github.com");
    expect(issues).toHaveLength(1);
  });
});

/**
 * Linear importer — cursor pagination, state-type filtering, priority mapping.
 */
import { describe, expect, it, vi } from "vitest";
import { LinearImporter } from "../src/lib/importers/linear-importer.js";
import type { ExternalIssue } from "../src/lib/importers/types.js";

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function node(id: string, over: Record<string, unknown> = {}) {
  return {
    identifier: id,
    title: `Issue ${id}`,
    description: "desc",
    url: `https://linear.app/${id}`,
    priority: 2,
    labels: { nodes: [{ name: "frontend" }] },
    state: { name: "Todo", type: "unstarted" },
    ...over,
  };
}

function page(nodes: unknown[], hasNextPage = false, endCursor = "", totalCount?: number) {
  return {
    data: {
      issues: {
        totalCount: totalCount ?? nodes.length,
        nodes,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

const noGuard = () => undefined;
const fast = { sleep: async () => undefined, now: () => 0, random: () => 0 };

describe("LinearImporter", () => {
  it("authorises with the raw token (no Bearer prefix)", async () => {
    const fetchFn = vi.fn(async () => res(200, page([node("A-1")])));
    const imp = new LinearImporter({
      token: "lin_tok",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const it = imp.fetchAll({ teamId: "team", includeArchived: false });
    await it.next();
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_tok");
  });

  it("follows cursor pagination", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, page([node("A-1")], true, "cur1")))
      .mockResolvedValueOnce(res(200, page([node("A-2")], false)));
    const imp = new LinearImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const out: ExternalIssue[] = [];
    for await (const i of imp.fetchAll({ teamId: "team", includeArchived: false })) out.push(i);
    expect(out.map((i) => i.externalId)).toEqual(["A-1", "A-2"]);
    const secondVars = JSON.parse(String((fetchFn.mock.calls[1][1] as RequestInit).body)).variables;
    expect(secondVars.after).toBe("cur1");
  });

  it("filters by workflow state type", async () => {
    const fetchFn = vi.fn(async () =>
      res(
        200,
        page([
          node("A-1", { state: { name: "Done", type: "completed" } }),
          node("A-2", { state: { name: "Todo", type: "unstarted" } }),
        ]),
      ),
    );
    const imp = new LinearImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const out: ExternalIssue[] = [];
    for await (const i of imp.fetchAll({
      teamId: "team",
      includeArchived: false,
      stateTypes: ["unstarted"],
    })) {
      out.push(i);
    }
    expect(out.map((i) => i.externalId)).toEqual(["A-2"]);
  });

  it("count() returns totalCount from the first page without streaming all issues", async () => {
    // GraphQL response for first: 1 — totalCount reflects server-side total.
    const fetchFn = vi.fn(async () =>
      res(200, {
        data: {
          issues: {
            totalCount: 57,
            nodes: [node("A-1")],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
      }),
    );
    const imp = new LinearImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    expect(await imp.count({ teamId: "team", includeArchived: false })).toBe(57);
    // Only a single network request — no streaming.
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("maps Linear numeric priority and labels", async () => {
    const fetchFn = vi.fn(async () => res(200, page([node("A-1", { priority: 1 })])));
    const imp = new LinearImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const out: ExternalIssue[] = [];
    for await (const i of imp.fetchAll({ teamId: "team", includeArchived: false })) out.push(i);
    expect(out[0].priority).toBe("critical");
    expect(out[0].labels).toEqual(["frontend"]);
  });

  it("throws on GraphQL errors", async () => {
    const fetchFn = vi.fn(async () => res(200, { errors: [{ message: "bad query" }] }));
    const imp = new LinearImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const it = imp.fetchAll({ teamId: "team", includeArchived: false });
    await expect(it.next()).rejects.toThrow(/bad query/);
  });

  it("maps every priority bucket and an absent priority", async () => {
    const fetchFn = vi.fn(async () =>
      res(
        200,
        page([
          node("A-1", { priority: 3 }),
          node("A-2", { priority: 4 }),
          node("A-3", { priority: null, labels: { nodes: [] }, state: undefined }),
        ]),
      ),
    );
    const imp = new LinearImporter({
      token: "t",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const out: ExternalIssue[] = [];
    for await (const i of imp.fetchAll({ teamId: "team", includeArchived: false })) out.push(i);
    expect(out.map((i) => i.priority)).toEqual(["medium", "low", undefined]);
    expect(out[2].labels).toEqual([]);
  });
});

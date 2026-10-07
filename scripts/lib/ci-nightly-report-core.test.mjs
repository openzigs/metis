import { describe, expect, it, vi } from "vitest";

import {
  NIGHTLY_ISSUE_TITLE,
  NIGHTLY_LABEL,
  createGitHubClient,
  failedJobs,
  failingJobNames,
  failureBody,
  recoveryBody,
  reportNightly,
} from "./ci-nightly-report-core.mjs";

/**
 * #848 — the nightly tracking-issue reporter. The client is injected, so nothing
 * here touches the network.
 */

const RUN = "https://github.com/o/r/actions/runs/42";

/** @param {{ number: number } | null} open */
function fakeClient(open) {
  return {
    ensureLabel: vi.fn(async () => {}),
    findOpenIssue: vi.fn(async () => open),
    createIssue: vi.fn(async () => ({ number: 900 })),
    comment: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
  };
}

const GREEN = { changes: { result: "success" }, "postgres-adapter": { result: "skipped" } };
const RED = {
  changes: { result: "success" },
  api: { result: "failure" },
  e2e: { result: "cancelled" },
  ui: { result: "skipped" },
};

describe("failedJobs", () => {
  it("treats success and skipped as passing, failure and cancelled as failed", () => {
    expect(failedJobs(GREEN)).toEqual([]);
    expect(failedJobs(RED)).toEqual(["api", "e2e"]);
  });

  it("fails closed on an unknown or missing result", () => {
    expect(failedJobs({ a: { result: "weird" }, b: {}, c: undefined })).toEqual(["a", "b", "c"]);
  });

  it("rejects a non-object needs context", () => {
    // @ts-expect-error deliberate bad input
    expect(() => failedJobs(null)).toThrow(TypeError);
    // @ts-expect-error deliberate bad input
    expect(() => failedJobs([])).toThrow(TypeError);
  });
});

describe("failingJobNames", () => {
  it("keeps failing conclusions only, by display name", () => {
    expect(
      failingJobNames([
        { name: "e2e (2/3)", conclusion: "failure" },
        { name: "e2e (1/3)", conclusion: "success" },
        { name: "api", conclusion: "timed_out" },
        { name: "nightly-report", conclusion: null },
        { conclusion: "failure" },
      ]),
    ).toEqual(["api", "e2e (2/3)"]);
  });
});

describe("bodies", () => {
  it("failure body carries the run URL, commit and each failing job", () => {
    const body = failureBody({ runUrl: RUN, sha: "abc123", jobs: ["api", "e2e (2/3)"] });
    expect(body).toContain(RUN);
    expect(body).toContain("Commit: abc123");
    expect(body).toContain("- `api`");
    expect(body).toContain("- `e2e (2/3)`");
  });

  it("failure body copes with no job list and neutralises backticks", () => {
    expect(failureBody({ runUrl: RUN, jobs: [] })).toContain("(none reported");
    expect(failureBody({ runUrl: RUN, jobs: ["a`b"] })).toContain("- `a'b`");
  });

  it("recovery body carries the green run URL", () => {
    expect(recoveryBody({ runUrl: RUN, sha: "def" })).toContain(RUN);
    expect(recoveryBody({ runUrl: RUN })).not.toContain("Commit:");
  });
});

describe("reportNightly", () => {
  it("failure with no open issue: ensures the label and opens one", async () => {
    const client = fakeClient(null);
    const res = await reportNightly({ needs: RED, runUrl: RUN, sha: "s", client });
    expect(res).toEqual({ action: "created", issue: 900, failed: ["api", "e2e"] });
    expect(client.ensureLabel).toHaveBeenCalledTimes(1);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const arg = client.createIssue.mock.calls[0][0];
    expect(arg.title).toBe(NIGHTLY_ISSUE_TITLE);
    expect(arg.labels).toEqual([NIGHTLY_LABEL]);
    expect(arg.body).toContain(RUN);
    expect(arg.body).toContain("- `api`");
    expect(client.comment).not.toHaveBeenCalled();
    expect(client.closeIssue).not.toHaveBeenCalled();
  });

  it("failure with an open issue: comments on it and opens nothing", async () => {
    const client = fakeClient({ number: 7 });
    const res = await reportNightly({
      needs: RED,
      runUrl: RUN,
      detailedJobs: ["api", "e2e (3/3)"],
      client,
    });
    expect(res).toEqual({ action: "commented", issue: 7, failed: ["api", "e2e"] });
    expect(client.comment).toHaveBeenCalledTimes(1);
    expect(client.comment.mock.calls[0][0]).toBe(7);
    expect(client.comment.mock.calls[0][1]).toContain("- `e2e (3/3)`");
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.closeIssue).not.toHaveBeenCalled();
  });

  it("falls back to needs ids when the detailed list is empty", async () => {
    const client = fakeClient({ number: 7 });
    await reportNightly({ needs: RED, runUrl: RUN, detailedJobs: [], client });
    expect(client.comment.mock.calls[0][1]).toContain("- `e2e`");
  });

  it("success with an open issue: comments with the green run and closes it", async () => {
    const client = fakeClient({ number: 7 });
    const res = await reportNightly({ needs: GREEN, runUrl: RUN, client });
    expect(res).toEqual({ action: "closed", issue: 7, failed: [] });
    expect(client.comment).toHaveBeenCalledWith(7, expect.stringContaining(RUN));
    expect(client.closeIssue).toHaveBeenCalledWith(7);
    expect(client.comment.mock.invocationCallOrder[0]).toBeLessThan(
      client.closeIssue.mock.invocationCallOrder[0],
    );
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("success with no open issue: does nothing", async () => {
    const client = fakeClient(null);
    const res = await reportNightly({ needs: GREEN, runUrl: RUN, client });
    expect(res).toEqual({ action: "none", issue: null, failed: [] });
    expect(client.comment).not.toHaveBeenCalled();
    expect(client.closeIssue).not.toHaveBeenCalled();
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.ensureLabel).not.toHaveBeenCalled();
  });
});

/**
 * A fetch double that answers from a route table and records every call.
 * @param {Record<string, { status: number, body?: unknown }>} routes "METHOD path" -> response
 */
function fakeFetch(routes) {
  /** @type {Array<{ method: string, url: string, headers: any, body: any }>} */
  const calls = [];
  const impl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({
          method: init.method,
          url,
          headers: init.headers,
          body: init.body ? JSON.parse(init.body) : undefined,
        });
        const path = url.replace("https://api.example/repos/o/r", "");
        const hit = routes[`${init.method} ${path}`] ?? { status: 500, body: "no route" };
        return new Response(hit.status === 204 ? null : JSON.stringify(hit.body ?? {}), {
          status: hit.status,
        });
      }
    )
  );
  return { impl, calls };
}

describe("createGitHubClient", () => {
  const make = (/** @type {Record<string, { status: number, body?: unknown }>} */ routes) => {
    const f = fakeFetch(routes);
    const client = createGitHubClient({
      token: "t0k",
      repository: "o/r",
      apiUrl: "https://api.example/",
      fetchImpl: f.impl,
    });
    return { client, calls: f.calls };
  };

  it("validates its inputs", () => {
    expect(() => createGitHubClient({ token: "", repository: "o/r" })).toThrow(/token/);
    expect(() => createGitHubClient({ token: "t", repository: "o/r/../x" })).toThrow(/owner\/name/);
  });

  it("ensureLabel creates the label only when it is missing", async () => {
    const missing = make({
      "GET /labels/ci-nightly": { status: 404 },
      "POST /labels": { status: 201, body: {} },
    });
    await missing.client.ensureLabel();
    expect(missing.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(missing.calls[1].body.name).toBe(NIGHTLY_LABEL);
    expect(missing.calls[0].headers.Authorization).toBe("Bearer t0k");

    const present = make({
      "GET /labels/ci-nightly": { status: 200, body: { name: "ci-nightly" } },
    });
    await present.client.ensureLabel();
    expect(present.calls).toHaveLength(1);
  });

  it("findOpenIssue skips pull requests and returns null on none", async () => {
    const q = "GET /issues?state=open&labels=ci-nightly&sort=created&direction=desc&per_page=100";
    const some = make({
      [q]: { status: 200, body: [{ number: 3, pull_request: {} }, { number: 5 }] },
    });
    expect(await some.client.findOpenIssue()).toEqual({ number: 5 });
    const none = make({ [q]: { status: 200, body: [] } });
    expect(await none.client.findOpenIssue()).toBeNull();
  });

  it("creates, comments on and closes issues", async () => {
    const { client, calls } = make({
      "POST /issues": { status: 201, body: { number: 11 } },
      "POST /issues/11/comments": { status: 201, body: {} },
      "PATCH /issues/11": { status: 200, body: {} },
    });
    expect(await client.createIssue({ title: "t", body: "b", labels: ["ci-nightly"] })).toEqual({
      number: 11,
    });
    await client.comment(11, "hello");
    await client.closeIssue(11);
    expect(calls[1].body).toEqual({ body: "hello" });
    expect(calls[2].body).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("lists run jobs and rejects a non-numeric run id", async () => {
    const { client } = make({
      "GET /actions/runs/42/jobs?filter=latest&per_page=100": {
        status: 200,
        body: { jobs: [{ name: "api", conclusion: "failure" }] },
      },
    });
    expect(await client.listRunJobs(42)).toEqual([{ name: "api", conclusion: "failure" }]);
    await expect(client.listRunJobs("1;rm")).rejects.toThrow(/numeric/);
  });

  it("surfaces a non-2xx response as an error with its status", async () => {
    const { client } = make({
      "POST /issues/1/comments": { status: 403, body: { message: "no" } },
    });
    await expect(client.comment(1, "x")).rejects.toThrow(/403/);
  });

  it("treats 204 as an empty success", async () => {
    const { client } = make({ "PATCH /issues/2": { status: 204 } });
    await expect(client.closeIssue(2)).resolves.toBeUndefined();
  });
});

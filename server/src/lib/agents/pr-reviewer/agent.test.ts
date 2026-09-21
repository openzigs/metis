/**
 * Epic #192 (A.4) — PR-reviewer agent tests.
 */
import { describe, expect, it, vi } from "vitest";
import { buildPrReviewUserPrompt, parseJudgeResponse } from "./prompts.js";
import { postPrReview, type OctokitLike } from "./github-review-poster.js";
import { runPrReview } from "./agent.js";

function judgeJSON(
  over: Partial<{
    verdicts: Array<{ acId: string; verdict: string; reasoning: string }>;
    overallVerdict: string;
    summary: string;
    comments: Array<{ filePath: string; line: number; body: string; severity: string }>;
  }> = {},
): string {
  return JSON.stringify({
    verdicts: over.verdicts ?? [
      { acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["a.ts"] },
    ],
    comments: over.comments ?? [],
    overallVerdict: over.overallVerdict ?? "approve",
    summary: over.summary ?? "all good",
  });
}

describe("buildPrReviewUserPrompt", () => {
  it("includes title, body, criteria, and diff fences", () => {
    const out = buildPrReviewUserPrompt({
      prTitle: "feat: thing",
      prBody: "Closes #1",
      diff: "@@ -1 +1 @@",
      criteria: [
        { id: "AC1", text: "Given x, When y" },
        { id: "AC2", text: "Then z" },
      ],
    });
    expect(out).toContain("Title: feat: thing");
    expect(out).toContain("[AC1] Given x, When y");
    expect(out).toContain("[AC2] Then z");
    expect(out).toContain("```diff");
    expect(out).toContain("Output JSON Schema");
  });
});

describe("parseJudgeResponse", () => {
  it("parses a clean JSON object", () => {
    const r = parseJudgeResponse(judgeJSON());
    expect(r.verdicts).toHaveLength(1);
    expect(r.overallVerdict).toBe("approve");
  });

  it("extracts JSON from markdown fences and trailing prose", () => {
    const wrapped = "```json\n" + judgeJSON({ overallVerdict: "comment" }) + "\n```\nthanks!";
    const r = parseJudgeResponse(wrapped);
    expect(r.overallVerdict).toBe("comment");
  });

  it("normalises bad enums to defaults", () => {
    const r = parseJudgeResponse(
      JSON.stringify({
        verdicts: [{ acId: "AC1", verdict: "maybe", reasoning: "" }],
        comments: [{ filePath: "a", line: 1, body: "x", severity: "ohno" }],
        overallVerdict: "skip",
      }),
    );
    expect(r.verdicts[0].verdict).toBe("uncertain");
    expect(r.comments[0].severity).toBe("info");
    expect(r.overallVerdict).toBe("comment");
  });

  it("throws on missing braces or missing verdicts array", () => {
    expect(() => parseJudgeResponse("no json here")).toThrow();
    expect(() => parseJudgeResponse(JSON.stringify({}))).toThrow();
  });
});

describe("postPrReview", () => {
  function mkOctokit(): { octokit: OctokitLike; createReview: ReturnType<typeof vi.fn> } {
    const createReview = vi.fn(async () => ({
      data: { id: 99, html_url: "https://github.com/acme/proj/pull/1#review" },
    }));
    return {
      octokit: { pulls: { createReview } } as OctokitLike,
      createReview,
    };
  }

  it("posts a review with the mapped event", async () => {
    const { octokit, createReview } = mkOctokit();
    const out = await postPrReview({
      octokit,
      owner: "acme",
      repo: "proj",
      prNumber: 1,
      verdict: "request_changes",
      summary: "fix things",
      inlineComments: [{ filePath: "a.ts", line: 5, body: "issue" }],
    });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "proj",
        pull_number: 1,
        event: "REQUEST_CHANGES",
        body: "fix things",
      }),
    );
    expect(out.reviewUrl).toContain("review");
  });

  it("filters out comments with non-positive lines and caps at 50", async () => {
    const { octokit, createReview } = mkOctokit();
    const comments = Array.from({ length: 60 }, (_, i) => ({
      filePath: "a.ts",
      line: i,
      body: `c${i}`,
    }));
    await postPrReview({
      octokit,
      owner: "acme",
      repo: "proj",
      prNumber: 1,
      verdict: "comment",
      summary: "",
      inlineComments: comments,
    });
    const params = createReview.mock.calls[0][0];
    expect(params.event).toBe("COMMENT");
    expect(params.body).toBe("METIS PR-Reviewer review"); // default
    expect(params.comments?.length).toBe(50);
    // line 0 should not be present
    expect(params.comments?.every((c: { line: number }) => c.line > 0)).toBe(true);
  });

  it("omits comments array when none survive filtering", async () => {
    const { octokit, createReview } = mkOctokit();
    await postPrReview({
      octokit,
      owner: "acme",
      repo: "proj",
      prNumber: 1,
      verdict: "approve",
      summary: "lgtm",
      inlineComments: [{ filePath: "", line: 0, body: "" }],
    });
    const params = createReview.mock.calls[0][0];
    expect(params.comments).toBeUndefined();
  });
});

describe("runPrReview", () => {
  function mkOctokit(): OctokitLike {
    return {
      pulls: {
        createReview: vi.fn(async () => ({
          data: { id: 11, html_url: "https://github.com/acme/proj/pull/1#review" },
        })),
      },
    };
  }

  it("returns early when there are no ACs", async () => {
    const judge = { evaluate: vi.fn(async () => "{}") };
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 1,
        prTitle: "t",
        prBody: "",
        diff: "",
        criteria: [],
        octokit: mkOctokit(),
      },
      { judge },
    );
    expect(judge.evaluate).not.toHaveBeenCalled();
    expect(out.reviewId).toBeNull();
    expect(out.judge.summary).toContain("No acceptance criteria");
  });

  it("runs judge + posts review for the happy path", async () => {
    const judge = { evaluate: vi.fn(async () => judgeJSON()) };
    const octokit = mkOctokit();
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 1,
        prTitle: "feat",
        prBody: "Closes #5",
        diff: "@@ -1 +1 @@",
        criteria: [{ id: "AC1", text: "thing" }],
        octokit,
      },
      { judge },
    );
    expect(judge.evaluate).toHaveBeenCalledTimes(1);
    expect(out.reviewId).toBe(11);
    expect(out.judge.overallVerdict).toBe("approve");
  });

  it("downgrades approve to request_changes when sandbox tests fail", async () => {
    const judge = { evaluate: vi.fn(async () => judgeJSON({ overallVerdict: "approve" })) };
    const sandbox = {
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "test failed",
        exitCode: 1,
        durationMs: 5,
        truncated: false,
      })),
    };
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 1,
        prTitle: "feat",
        prBody: "",
        diff: "",
        criteria: [{ id: "AC1", text: "thing" }],
        testCommands: [{ acId: "AC1", language: "bash", code: "exit 1" }],
        octokit: mkOctokit(),
      },
      { judge, sandbox },
    );
    expect(out.judge.overallVerdict).toBe("request_changes");
    expect(out.judge.summary).toContain("Sandbox tests failed");
    expect(out.sandboxResults[0].exitCode).toBe(1);
  });

  it("captures sandbox exec exceptions as exitCode 1 results", async () => {
    const judge = { evaluate: vi.fn(async () => judgeJSON()) };
    const sandbox = {
      exec: vi.fn(async () => {
        throw new Error("e2b down");
      }),
    };
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 1,
        prTitle: "feat",
        prBody: "",
        diff: "",
        criteria: [{ id: "AC1", text: "thing" }],
        testCommands: [{ acId: "AC1", language: "python", code: "print(1)" }],
        octokit: mkOctokit(),
      },
      { judge, sandbox },
    );
    expect(out.sandboxResults[0].stderr).toContain("e2b down");
    expect(out.sandboxResults[0].exitCode).toBe(1);
  });

  it("short-circuits with skipped='budget_exceeded' when budget.check denies", async () => {
    const judge = { evaluate: vi.fn(async () => judgeJSON()) };
    const budget = {
      check: vi.fn(async () => ({
        allowed: false,
        capCents: 100,
        spentCents: 100,
        resetAt: "2026-05-01T00:00:00Z",
      })),
      record: vi.fn(),
    };
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 1,
        prTitle: "feat",
        prBody: "",
        diff: "",
        criteria: [{ id: "AC1", text: "thing" }],
        octokit: mkOctokit(),
        projectId: "proj-1",
      },
      { judge, budget },
    );
    expect(out.skipped).toBe("budget_exceeded");
    expect(out.reviewId).toBeNull();
    expect(judge.evaluate).not.toHaveBeenCalled();
    expect(budget.check).toHaveBeenCalledWith("proj-1");
  });

  it("records spend and returns telemetry on the happy path with envelope", async () => {
    const judge = {
      evaluate: vi.fn(async () => ({
        raw: judgeJSON(),
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        inputTokens: 1000,
        outputTokens: 250,
        costUsd: 0.0123,
      })),
    };
    const budget = {
      check: vi.fn(async () => ({
        allowed: true,
        capCents: 10_000,
        spentCents: 0,
        resetAt: "2026-05-01T00:00:00Z",
      })),
      record: vi.fn(async () => undefined),
    };
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 7,
        prTitle: "feat",
        prBody: "Closes #5",
        diff: "@@",
        criteria: [{ id: "AC1", text: "thing" }],
        octokit: mkOctokit(),
        projectId: "proj-1",
        linkedIssueNumbers: [5],
      },
      { judge, budget },
    );
    expect(out.skipped).toBeNull();
    expect(out.telemetry.model).toBe("claude-sonnet-4-5");
    expect(out.telemetry.acPassRate).toBe(1);
    expect(budget.record).toHaveBeenCalledTimes(1);
    expect(budget.record.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 1000,
      outputTokens: 250,
    });
  });

  it("does not call budget.record when no spend was reported", async () => {
    const judge = { evaluate: vi.fn(async () => judgeJSON()) };
    const budget = {
      check: vi.fn(async () => ({
        allowed: true,
        capCents: null,
        spentCents: 0,
        resetAt: "2026-05-01T00:00:00Z",
      })),
      record: vi.fn(),
    };
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 1,
        prTitle: "t",
        prBody: "",
        diff: "",
        criteria: [{ id: "AC1", text: "thing" }],
        octokit: mkOctokit(),
        projectId: "proj-1",
      },
      { judge, budget },
    );
    expect(out.skipped).toBeNull();
    expect(budget.record).not.toHaveBeenCalled();
  });

  it("propagates judge errors and emits an errored audit", async () => {
    const judge = {
      evaluate: vi.fn(async () => {
        throw new Error("LLM unavailable");
      }),
    };
    await expect(
      runPrReview(
        {
          owner: "acme",
          repo: "proj",
          prNumber: 1,
          prTitle: "t",
          prBody: "",
          diff: "",
          criteria: [{ id: "AC1", text: "thing" }],
          octokit: mkOctokit(),
          projectId: "proj-1",
        },
        { judge },
      ),
    ).rejects.toThrow("LLM unavailable");
  });

  it("propagates parse errors as errored audit", async () => {
    const judge = { evaluate: vi.fn(async () => "not JSON at all") };
    await expect(
      runPrReview(
        {
          owner: "acme",
          repo: "proj",
          prNumber: 1,
          prTitle: "t",
          prBody: "",
          diff: "",
          criteria: [{ id: "AC1", text: "thing" }],
          octokit: mkOctokit(),
          projectId: "proj-1",
        },
        { judge },
      ),
    ).rejects.toThrow();
  });

  it("survives budget.record throwing — review still posted, returns telemetry", async () => {
    const judge = {
      evaluate: vi.fn(async () => ({
        raw: judgeJSON(),
        model: "m",
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.001,
      })),
    };
    const budget = {
      check: vi.fn(async () => ({
        allowed: true,
        capCents: null,
        spentCents: 0,
        resetAt: "2026-05-01T00:00:00Z",
      })),
      record: vi.fn(async () => {
        throw new Error("DB down");
      }),
    };
    const out = await runPrReview(
      {
        owner: "acme",
        repo: "proj",
        prNumber: 1,
        prTitle: "t",
        prBody: "",
        diff: "",
        criteria: [{ id: "AC1", text: "thing" }],
        octokit: mkOctokit(),
        projectId: "proj-1",
      },
      { judge, budget },
    );
    expect(out.reviewId).toBe(11);
    expect(out.skipped).toBeNull();
  });
});

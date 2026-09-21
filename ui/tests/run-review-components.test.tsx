/**
 * Epic #192 (A.6) — review-panel component tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  AcMatrix,
  CommentList,
  ReviewPanel,
  SandboxResults,
} from "@/components/run-review/review-panel";
import type { PrReviewRecord } from "@/lib/runs-api";

function mkReview(over: Partial<PrReviewRecord> = {}): PrReviewRecord {
  return {
    judge: {
      verdicts: [
        { acId: "AC1", verdict: "satisfied", reasoning: "good", evidenceFiles: ["a.ts"] },
        { acId: "AC2", verdict: "not_satisfied", reasoning: "missing", evidenceFiles: [] },
      ],
      comments: [
        { filePath: "a.ts", line: 5, body: "issue", severity: "risk" },
        { filePath: "b.ts", line: 9, body: "nit", severity: "info" },
      ],
      overallVerdict: "request_changes",
      summary: "Some issues",
    },
    sandboxResults: [],
    reviewId: 7,
    reviewUrl: "https://github.com/x/y/pull/1#review",
    postedAt: "2026-04-26T00:00:00Z",
    ...over,
  };
}

describe("ReviewPanel", () => {
  it("renders summary, verdict, GitHub link, AC matrix, and comment list", () => {
    render(<ReviewPanel review={mkReview()} />);
    expect(screen.getByText(/Request changes/i)).toBeTruthy();
    expect(screen.getByTestId("run-review-summary-text").textContent).toContain("Some issues");
    expect((screen.getByTestId("run-review-github-link") as HTMLAnchorElement).href).toContain(
      "/pull/1#review",
    );
    expect(screen.getByTestId("run-review-ac-AC1").getAttribute("data-verdict")).toBe("satisfied");
    expect(screen.getByTestId("run-review-ac-AC2").getAttribute("data-verdict")).toBe(
      "not_satisfied",
    );
    expect(screen.getByTestId("run-review-comment-0").getAttribute("data-severity")).toBe("risk");
  });

  it("hides the GitHub link when reviewUrl is null", () => {
    render(<ReviewPanel review={mkReview({ reviewUrl: null })} />);
    expect(screen.queryByTestId("run-review-github-link")).toBeNull();
  });

  it("renders sandbox results when present", () => {
    render(
      <ReviewPanel
        review={mkReview({
          sandboxResults: [
            {
              acId: "AC1",
              exitCode: 1,
              durationMs: 12,
              truncated: false,
              stdout: "out",
              stderr: "err",
            },
          ],
        })}
      />,
    );
    const card = screen.getByTestId("run-review-sandbox-AC1");
    expect(card.getAttribute("data-exit-code")).toBe("1");
    expect(card.textContent).toContain("err");
  });

  it("uses the approve tone for approve verdict", () => {
    render(
      <ReviewPanel
        review={mkReview({ judge: { ...mkReview().judge, overallVerdict: "approve" } })}
      />,
    );
    expect(screen.getByText(/^Approve$/)).toBeTruthy();
  });
});

describe("AcMatrix", () => {
  it("shows empty state when no verdicts", () => {
    render(<AcMatrix verdicts={[]} />);
    expect(screen.getByText(/No criteria evaluated/i)).toBeTruthy();
  });

  it("shows uncertain badge", () => {
    render(
      <AcMatrix
        verdicts={[{ acId: "AC9", verdict: "uncertain", reasoning: "hmm", evidenceFiles: [] }]}
      />,
    );
    expect(screen.getByText("uncertain")).toBeTruthy();
  });
});

describe("CommentList", () => {
  it("shows empty state when no comments", () => {
    render(<CommentList comments={[]} />);
    expect(screen.getByText(/No inline comments/i)).toBeTruthy();
  });

  it("renders each severity tone", () => {
    render(
      <CommentList
        comments={[
          { filePath: "a", line: 1, body: "i", severity: "info" },
          { filePath: "b", line: 2, body: "w", severity: "warning" },
          { filePath: "c", line: 3, body: "r", severity: "risk" },
        ]}
      />,
    );
    expect(screen.getByTestId("run-review-comment-0").getAttribute("data-severity")).toBe("info");
    expect(screen.getByTestId("run-review-comment-1").getAttribute("data-severity")).toBe(
      "warning",
    );
    expect(screen.getByTestId("run-review-comment-2").getAttribute("data-severity")).toBe("risk");
  });
});

describe("SandboxResults", () => {
  it("renders zero exit code with green tone and no stderr block when empty", () => {
    render(
      <SandboxResults
        results={[
          {
            acId: "AC1",
            exitCode: 0,
            durationMs: 5,
            truncated: false,
            stdout: "",
            stderr: "",
          },
        ]}
      />,
    );
    const card = screen.getByTestId("run-review-sandbox-AC1");
    expect(card.getAttribute("data-exit-code")).toBe("0");
    expect(card.querySelector("pre")).toBeNull();
  });

  it("flags truncated output", () => {
    render(
      <SandboxResults
        results={[
          {
            acId: "AC2",
            exitCode: 0,
            durationMs: 5,
            truncated: true,
            stdout: "x",
            stderr: "",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("run-review-sandbox-AC2").textContent).toContain("truncated");
  });
});

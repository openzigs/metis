/**
 * Epic #192 (A.4) — PR-reviewer prompts.
 *
 * Single-shot judge prompt: given a PR diff and a list of acceptance
 * criteria, return one verdict per AC plus a list of inline comment
 * suggestions. The prompt is deliberately strict about JSON output so the
 * agent can be wrapped by the existing judge-LLM infra.
 */

export interface AcceptanceCriterionInput {
  id: string;
  text: string;
}

export interface JudgeVerdict {
  acId: string;
  verdict: "satisfied" | "not_satisfied" | "uncertain";
  reasoning: string;
  evidenceFiles: string[];
}

export interface InlineCommentSuggestion {
  filePath: string;
  line: number;
  body: string;
  severity: "info" | "warning" | "risk";
}

export interface JudgeResponse {
  verdicts: JudgeVerdict[];
  comments: InlineCommentSuggestion[];
  overallVerdict: "approve" | "request_changes" | "comment";
  summary: string;
}

export function buildPrReviewSystemPrompt(): string {
  return `You are METIS's PR-Reviewer agent. Your job is to validate that a pull request implements its originating issue's acceptance criteria. Output STRICT JSON matching the schema. Be terse but precise. Cite file paths.`;
}

export function buildPrReviewUserPrompt(input: {
  prTitle: string;
  prBody: string;
  diff: string;
  criteria: AcceptanceCriterionInput[];
}): string {
  const criteriaList = input.criteria.map((c, i) => `${i + 1}. [${c.id}] ${c.text}`).join("\n");
  // The diff is intentionally truncated here — callers should pre-trim
  // when the diff exceeds the model's context budget.
  return `## PR
Title: ${input.prTitle}
Body:
${input.prBody}

## Acceptance Criteria
${criteriaList}

## Diff
\`\`\`diff
${input.diff}
\`\`\`

## Output JSON Schema
{
  "verdicts": [{ "acId": string, "verdict": "satisfied"|"not_satisfied"|"uncertain", "reasoning": string, "evidenceFiles": string[] }],
  "comments": [{ "filePath": string, "line": number, "body": string, "severity": "info"|"warning"|"risk" }],
  "overallVerdict": "approve"|"request_changes"|"comment",
  "summary": string
}

Rules:
- One verdict object per AC.
- "comments" must reference files that appear in the diff.
- "overallVerdict" = "approve" only when EVERY AC verdict is "satisfied" AND no "risk" comment is emitted.
- "overallVerdict" = "request_changes" when ANY AC verdict is "not_satisfied" OR ANY comment has severity "risk".
- Otherwise "comment".

Respond with ONLY the JSON object — no prose, no markdown fences.`;
}

/**
 * Parse the judge LLM's JSON response into a typed object. Accepts a few
 * common shape mistakes (markdown fences, trailing prose) by extracting
 * the first balanced `{...}` block.
 */
export function parseJudgeResponse(raw: string): JudgeResponse {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("judge response did not contain a JSON object");
  }
  const json = trimmed.slice(start, end + 1);
  const obj = JSON.parse(json) as Partial<JudgeResponse>;
  if (!Array.isArray(obj.verdicts)) {
    throw new Error("judge response missing `verdicts` array");
  }
  return {
    verdicts: obj.verdicts.map((v) => ({
      acId: String(v.acId ?? ""),
      verdict:
        v.verdict === "satisfied" || v.verdict === "not_satisfied" || v.verdict === "uncertain"
          ? v.verdict
          : "uncertain",
      reasoning: String(v.reasoning ?? ""),
      evidenceFiles: Array.isArray(v.evidenceFiles) ? v.evidenceFiles.map(String) : [],
    })),
    comments: Array.isArray(obj.comments)
      ? obj.comments.map((c) => ({
          filePath: String(c.filePath ?? ""),
          line: Number(c.line ?? 0),
          body: String(c.body ?? ""),
          severity:
            c.severity === "info" || c.severity === "warning" || c.severity === "risk"
              ? c.severity
              : "info",
        }))
      : [],
    overallVerdict:
      obj.overallVerdict === "approve" ||
      obj.overallVerdict === "request_changes" ||
      obj.overallVerdict === "comment"
        ? obj.overallVerdict
        : "comment",
    summary: String(obj.summary ?? ""),
  };
}

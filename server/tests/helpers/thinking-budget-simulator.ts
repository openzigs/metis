/**
 * #751 — a deterministic stand-in for a model that THINKS BY DEFAULT and draws
 * its reasoning from the same `max_tokens` budget as its answer (DeepSeek
 * `deepseek-flash` / `deepseek-v4-pro`, https://api-docs.deepseek.com/guides/thinking_mode).
 *
 * The stub providers used elsewhere in the suite have no output cap, so a
 * synthesis that cannot fit its answer passes every test written against them.
 * This simulator enforces the cap the way the real endpoint does:
 *
 *   1. it reads the findings table out of the synthesis prompt it is sent;
 *   2. it spends `reasoningTokens(n)` on thinking for an n-row table;
 *   3. it writes the ideal JSON answer (one TYPED requirement, with acceptance
 *      criteria, per pair of findings — so merging is visible), and
 *   4. it cuts that answer off where `maxTokens` runs out, reporting
 *      `max_tokens` and a completion count equal to the cap.
 *
 * Tokens are `ceil(chars / CHARS_PER_TOKEN)` — crude, deterministic, and the
 * same rule for every call, which is all a budget test needs.
 */

export const CHARS_PER_TOKEN = 4;

/** Category → requirement type, so "every requirement is `feature`" is detectable. */
const TYPE_BY_CATEGORY: Record<string, string> = {
  security: "bug",
  performance: "chore",
  compliance: "task",
};

export interface SimulatedRow {
  index: number;
  category: string;
  title: string;
}

/** Parse the `[N] … (agent / severity / category) title :: …` rows of a synthesis prompt. */
export function parseFindingRows(userMessage: string): SimulatedRow[] {
  const rows: SimulatedRow[] = [];
  const re = /^\[(\d+)\] (?:\[[A-Z-]+\] )*\(([^/]+) \/ ([^/]+) \/ ([^)]+)\) (.+?) :: /gm;
  for (const m of userMessage.matchAll(re)) {
    rows.push({ index: Number(m[1]), category: m[4]!.trim(), title: m[5]!.trim() });
  }
  return rows;
}

/** The answer a model with no cap would give for these rows. */
export function idealAnswer(rows: SimulatedRow[], bodyChars = 2400): string {
  const requirements = [];
  for (let i = 0; i < rows.length; i += 2) {
    const group = rows.slice(i, i + 2);
    const lead = group[0]!;
    requirements.push({
      type: TYPE_BY_CATEGORY[lead.category] ?? "feature",
      title: `Resolve ${lead.title}`,
      body: `Requirement derived from ${group.map((r) => r.title).join(" and ")}. `
        .padEnd(bodyChars, "Detail. ")
        .slice(0, bodyChars),
      priority: lead.category === "security" ? "high" : "medium",
      labels: [lead.category],
      evidenceFindingIndexes: group.map((r) => r.index),
      acceptanceCriteria: [
        `GET /api/${lead.category}/${lead.index} returns 200 with the corrected payload`,
        `The ${lead.category} audit table records one row per change to finding ${lead.index}`,
        `A regression test covering ${lead.title} fails before the fix and passes after it`,
      ],
    });
  }
  return JSON.stringify({ summary: `Synthesised ${rows.length} findings.`, requirements }, null, 1);
}

export interface SimulatedReply {
  content: string;
  finishReason: "max_tokens" | "end_turn";
  reasoningTokens: number;
  outputTokens: number;
  inputTokens: number;
}

export interface SimulatorOptions {
  /** Reasoning spent for an n-row table. Default: 2,000 + 200 per row. */
  reasoningTokens?: (rows: number) => number;
  /** Characters of `body` per requirement. Default 2,400. */
  bodyChars?: number;
}

/** Answer one synthesis request the way a thinking model under `maxTokens` would. */
export function simulateThinkingReply(
  system: string,
  userMessage: string,
  maxTokens: number,
  opts: SimulatorOptions = {},
): SimulatedReply {
  const rows = parseFindingRows(userMessage);
  const reasoning = Math.min(
    maxTokens,
    (opts.reasoningTokens ?? ((n: number) => 2_000 + 200 * n))(rows.length),
  );
  const answer = idealAnswer(rows, opts.bodyChars);
  const answerBudgetChars = (maxTokens - reasoning) * CHARS_PER_TOKEN;
  const inputTokens = Math.ceil((system.length + userMessage.length) / CHARS_PER_TOKEN);
  if (answer.length <= answerBudgetChars) {
    return {
      content: answer,
      finishReason: "end_turn",
      reasoningTokens: reasoning,
      outputTokens: reasoning + Math.ceil(answer.length / CHARS_PER_TOKEN),
      inputTokens,
    };
  }
  return {
    content: answer.slice(0, Math.max(0, answerBudgetChars)),
    finishReason: "max_tokens",
    reasoningTokens: reasoning,
    outputTokens: maxTokens,
    inputTokens,
  };
}

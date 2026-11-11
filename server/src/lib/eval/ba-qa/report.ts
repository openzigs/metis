/**
 * #2237 — the run's Markdown report: one column per arm, then each question.
 */
import type { ArmSummary, QuestionScore, Rate } from "./metrics.js";

export interface ReportSession {
  arm: string;
  score: QuestionScore;
  costUsd: number | null;
  /** The project the session was bound to; null when chat dropped the scope. */
  projectId: string | null;
  ragChars: number;
  toolCalls: number;
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
const r = (x: Rate): string => (x.rate === null ? "n/a" : `${pct(x.rate)} (${x.n}/${x.of})`);
const usd = (x: number | null): string => (x === null ? "unpriced" : `$${x.toFixed(4)}`);

export function formatBaQaReport(input: {
  title: string;
  provider: string;
  model: string;
  judgeModel: string;
  arms: readonly ArmSummary[];
  armFlags: Readonly<Record<string, Readonly<Record<string, string>>>>;
  sessions: readonly ReportSession[];
  spentUsd: number;
  stoppedEarly: string | null;
}): string {
  const { arms } = input;
  const head = `| Metric | ${arms.map((a) => a.arm).join(" | ")} |`;
  const sep = `|---|${arms.map(() => "---").join("|")}|`;
  const row = (label: string, f: (a: ArmSummary) => string): string =>
    `| ${label} | ${arms.map(f).join(" | ")} |`;
  const lines = [
    `# ${input.title}`,
    "",
    `Answers: ${input.provider}/${input.model}. Judge: ${input.judgeModel}.`,
    "",
    ...arms.map(
      (a) =>
        `- **${a.arm}**: ${
          Object.entries(input.armFlags[a.arm] ?? {})
            .map(([k, v]) => `\`${k}=${v}\``)
            .join(", ") || "defaults"
        }`,
    ),
    "",
    head,
    sep,
    row("Questions (unscored)", (a) => `${a.questions} (${a.unscored})`),
    // A multi-product question reaches chat as an unscoped session with no
    // retrieval, so its follow-up or abstention can come from having nothing.
    row("Sessions chat left unscoped (no retrieval)", (a) => {
      const own = input.sessions.filter((s) => s.arm === a.arm);
      return `${own.filter((s) => s.projectId === null).length}/${own.length}`;
    }),
    row("Correctness: mean facts stated", (a) => pct(a.correctness)),
    row("Fully correct answers", (a) => r(a.fullyCorrect)),
    row("Citation precision", (a) => r(a.citationPrecision)),
    row("… of which checked against the span", (a) => r(a.spanChecked)),
    row("Citation recall (expected files cited)", (a) => r(a.citationRecall)),
    row("Abstention on unanswerable", (a) => r(a.abstention)),
    row("Confident guess on unanswerable", (a) => r(a.confidentGuess)),
    row("Follow-up on ambiguous", (a) => r(a.followUp)),
    row("False abstention on answerable", (a) => r(a.falseAbstention)),
    row("Unneeded follow-up on answerable", (a) => r(a.unneededFollowUp)),
    row("Right behaviour: single-product", (a) => r(a.byCategory["single-product"].behaviourOk)),
    row("Right behaviour: multi-product", (a) => r(a.byCategory["multi-product"].behaviourOk)),
    row("Answer spend", (a) => usd(a.cost.answerUsd)),
    row("Answer spend per question", (a) => usd(a.cost.perQuestionUsd)),
    row("Judge spend", (a) => usd(a.cost.judgeUsd)),
    row("Total spend", (a) => usd(a.cost.totalUsd)),
    "",
    `Run total, every model call: $${input.spentUsd.toFixed(6)}.`,
    ...(input.stoppedEarly ? ["", `**Stopped early:** ${input.stoppedEarly}.`] : []),
    "",
    "## Per question",
    "",
    "| Arm | Question | Expect | Got | Facts | Cites (support) | Expected cited | Scope bound | RAG chars | Tools | Cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...input.sessions.map(({ arm, score: s, costUsd, projectId, ragChars, toolCalls }) => {
      const facts = s.facts ? `${s.facts.stated}/${s.facts.total}` : "-";
      const support = `${s.citations.length} (${s.citations.filter((c) => c.supports).length})`;
      const expected = s.expectedFiles.length
        ? `${s.citedExpectedFiles.length}/${s.expectedFiles.length}`
        : "-";
      return `| ${arm} | ${s.questionId} | ${s.expect} | ${s.behaviour ?? "unscored"} | ${facts} | ${support} | ${expected} | ${projectId ? "yes" : "no"} | ${ragChars} | ${toolCalls} | ${usd(costUsd)} |`;
    }),
  ];
  return lines.join("\n");
}

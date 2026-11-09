/**
 * #2060 (Epic #1866) — seed a workspace governing document with extracted
 * rules, and a completed analysis with governing findings, into the e2e SQLite
 * database.
 *
 * Why this exists: the e2e stack runs the `offline-stub` provider, whose
 * hash-derived prose no rule extraction (#1870), applicability screen (#1872)
 * or findings check (#1874) can read, so a live offline run never stores a
 * rule or a finding. This writes what a real run with `GOVERNING_DOCS_ENABLED`
 * on leaves behind, so `e2e/tests/analysis-governing-findings.spec.ts` can
 * assert the analysis view's Governing rules panel (#1876) without a model:
 *
 *   - the document, its current revision (extraction done) and its rules, each
 *     cited by offsets into the revision's extracted text. The revision reads
 *     `indexed`, but no chunk is embedded: no analysis runs in the spec's
 *     workspace, so nothing retrieves from it;
 *   - a completed analysis whose `metadata.governingApplicability` holds the
 *     verdict of every rule for its one requirement (one `uncertain`);
 *   - one governing finding per rule that applies or is uncertain
 *     (Compliant, Gap, Needs BA input);
 *   - the open clarification round whose question settles the uncertain rule,
 *     linked to it (#1873), for the finding's "Answer the clarifying question".
 *
 * Every value comes from `e2e/fixtures/governing-fixture.ts`, which the spec
 * asserts against; `e2e-seed-governing.test.ts` parses what this stores with
 * the shared schemas the server reads it with. The project must already belong
 * to a workspace.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-governing.ts <projectId> <startedById>
 * Prints `{ "analysisId": …, "documentId": …, "workspaceId": … }`.
 */
/* eslint-disable no-console -- CLI script: writes JSON to stdout, errors to stderr */
import { createHash } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  GOVERNING_FIXTURE,
  GOVERNING_RULES,
  POLICY_TEXT,
  type GoverningFixtureRule,
} from "../../e2e/fixtures/governing-fixture.js";

/** `GOVERNING_QUESTION_FIELD` in `src/lib/governing/applicability-questions.ts`. */
export const GOVERNING_QUESTION_FIELD = "governing-applicability";

/** Rule key → the seeded rule's id. */
export type SeededRuleIds = ReadonlyMap<GoverningFixtureRule["key"], string>;

/** A clause's offsets into the revision's extracted text, as rule extraction stores them. */
export function clauseOffsets(excerpt: string): { clauseStart: number; clauseEnd: number } {
  const clauseStart = POLICY_TEXT.indexOf(excerpt);
  if (clauseStart < 0) throw new Error(`clause excerpt not in the policy text: ${excerpt}`);
  return { clauseStart, clauseEnd: clauseStart + excerpt.length };
}

function idOf(ruleIds: SeededRuleIds, key: GoverningFixtureRule["key"]): string {
  const found = ruleIds.get(key);
  if (!found) throw new Error(`rule ${key} was not seeded`);
  return found;
}

function uncertainRule(): GoverningFixtureRule {
  const rule = GOVERNING_RULES.find((r) => r.verdict === "uncertain");
  if (!rule) throw new Error("the fixture has no uncertain rule");
  return rule;
}

/** `Analysis.metadata.governingApplicability`: every rule's verdict for the one requirement. */
export function buildGoverningApplicability(ruleIds: SeededRuleIds, decidedAt: Date) {
  return {
    decidedAt: decidedAt.toISOString(),
    requirements: [
      {
        requirementId: GOVERNING_FIXTURE.requirementId,
        text: GOVERNING_FIXTURE.requirementText,
        decisions: GOVERNING_RULES.map((rule) => ({
          ruleId: idOf(ruleIds, rule.key),
          controlId: rule.controlId,
          verdict: rule.verdict,
          reason: rule.summary,
          ...(rule.verdict === "uncertain" ? { businessFact: GOVERNING_FIXTURE.businessFact } : {}),
          foundBy: ["top-k" as const],
        })),
      },
    ],
  };
}

/**
 * The clarification dialog: one open round, already generated, whose one
 * question is linked to the uncertain rule (#1873). Its round is the current
 * one, so the Questions tab renders it as is and starts nothing (no model call).
 */
export function buildGoverningClarificationState(analysisId: string, ruleIds: SeededRuleIds) {
  return {
    analysisId,
    currentRound: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: GOVERNING_FIXTURE.questionId,
            requirementId: `governing:${GOVERNING_FIXTURE.requirementId}`,
            ambiguityField: GOVERNING_QUESTION_FIELD,
            question: GOVERNING_FIXTURE.question,
            context: `Asked to check this requirement against company policy: "${GOVERNING_FIXTURE.requirementText}"`,
            governing: {
              kind: "governing" as const,
              ruleIds: [idOf(ruleIds, uncertainRule().key)],
              requirementId: GOVERNING_FIXTURE.requirementId,
            },
          },
        ],
        answers: [],
      },
    ],
    resolvedAmbiguities: [],
    answeredAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
  };
}

export async function main(): Promise<void> {
  const [projectId, startedById] = process.argv.slice(2);
  if (!projectId || !startedById) {
    console.error("usage: e2e-seed-governing.ts <projectId> <startedById>");
    process.exit(2);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project?.workspaceId) {
      throw new Error(`project ${projectId} not found, or in no workspace`);
    }
    const workspaceId = project.workspaceId;
    const now = new Date();

    // ── The workspace's governing document, its revision and rules ──────────
    const document = await prisma.governingDocument.create({
      data: {
        workspaceId,
        title: GOVERNING_FIXTURE.documentTitle,
        framework: GOVERNING_FIXTURE.framework,
        createdById: startedById,
      },
    });
    const revision = await prisma.governingDocumentRevision.create({
      data: {
        documentId: document.id,
        revisionLabel: GOVERNING_FIXTURE.revisionLabel,
        effectiveDate: now,
        storagePath: `e2e-seed/governing/${document.id}.md`,
        contentHash: createHash("sha256").update(POLICY_TEXT).digest("hex"),
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(POLICY_TEXT, "utf8"),
        extractedText: POLICY_TEXT,
        indexState: "indexed",
        extractionState: "done",
        extractionStartedAt: now,
        uploadedById: startedById,
      },
    });
    await prisma.governingDocument.update({
      where: { id: document.id },
      data: { currentRevisionId: revision.id },
    });
    const ruleIds = new Map<GoverningFixtureRule["key"], string>();
    for (const rule of GOVERNING_RULES) {
      const created = await prisma.governingRule.create({
        data: {
          revisionId: revision.id,
          controlId: rule.controlId,
          summary: rule.summary,
          clauseRef: rule.clauseRef,
          ...clauseOffsets(rule.clauseExcerpt),
          clauseExcerpt: rule.clauseExcerpt,
          category: rule.category,
        },
      });
      ruleIds.set(rule.key, created.id);
    }

    // ── The completed analysis and its stored applicability (#1872) ─────────
    const analysis = await prisma.analysis.create({
      data: {
        projectId,
        startedById,
        status: "completed",
        startedAt: now,
        completedAt: now,
        totalTokens: 0,
        metadata: JSON.stringify({
          source: "e2e-seed-governing",
          // The Questions tab renders the clarification dialog only for a run
          // that asked for clarification.
          enhancement: { enableClarification: true, enableWebResearch: false },
          governingApplicability: buildGoverningApplicability(ruleIds, now),
        }),
      },
    });

    // ── One finding per rule that applies or is uncertain (#1874) ───────────
    for (const rule of GOVERNING_RULES) {
      if (!rule.finding) continue;
      await prisma.governingFinding.create({
        data: {
          analysisId: analysis.id,
          requirementId: GOVERNING_FIXTURE.requirementId,
          ruleId: idOf(ruleIds, rule.key),
          revisionId: revision.id,
          revisionLabel: GOVERNING_FIXTURE.revisionLabel,
          documentTitle: GOVERNING_FIXTURE.documentTitle,
          controlId: rule.controlId,
          clauseRef: rule.clauseRef,
          status: rule.finding.status,
          reasoning: rule.finding.reasoning,
          ...clauseOffsets(rule.clauseExcerpt),
          clauseExcerpt: rule.clauseExcerpt,
          businessQuestion: rule.finding.businessQuestion ?? null,
        },
      });
    }

    // ── The open round whose question settles the uncertain rule (#1873) ────
    const state = buildGoverningClarificationState(analysis.id, ruleIds);
    await prisma.clarificationDialogState.create({
      data: { analysisId: analysis.id, state: JSON.stringify(state) },
    });

    process.stdout.write(
      JSON.stringify({ analysisId: analysis.id, documentId: document.id, workspaceId }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed as a script: the unit test imports the builders.
const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].includes("e2e-seed-governing");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

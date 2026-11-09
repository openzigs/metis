/**
 * Epic #1866 (#1874) — an analysis's cited governing findings, stored in
 * `governing_findings` (one row per analysis, requirement and rule), read
 * back, and decided by a BA with an `AuditLog` row per decision.
 *
 * Findings are produced from the analysis's stored applicability (#1872,
 * #1873): every pair that `applies` or is still `uncertain`. The rule's
 * revision, label, title, control id and clause are copied onto the row, so a
 * later revision of the policy never rewrites what a finding cited.
 *
 * Every read and write is scoped on the analysis id; the routes bind that
 * analysis to its project (`ensureAnalysisVisible`), and a finding id is only
 * ever looked up WITH its analysis id, so another analysis's finding is never
 * found by its id alone.
 */
import {
  GOVERNING_FINDING_DECISIONS,
  GOVERNING_FINDING_STATUSES,
  type GoverningAnalysisApplicability,
  type GoverningFinding,
  type GoverningFindingDecision,
  type GoverningFindingStatus,
} from "@metis/shared";
import type { Prisma } from "@prisma/client";
import type { AIProvider } from "../ai/types.js";
import { buildAuditLogData, SYSTEM_ACTOR_ID } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { readGoverningApplicability } from "./applicability-store.js";
import { citableWorkspaceRules } from "./governing-store.js";
import {
  evaluateRequirementFindings,
  type EvaluatedFinding,
  type FindingAnswer,
  type FindingPair,
  type FindingRule,
} from "./findings.js";

const log = createChildLogger("governing-findings-store");

/** How many requirements are evaluated at once. */
const FINDINGS_CONCURRENCY = 4;

/**
 * #2010 — the findings write's interactive-transaction timeout. One read per
 * requirement plus one upsert per (requirement, rule) outgrows Prisma's 5 s
 * default on Postgres for a large analysis, and a timed-out write rolls back
 * whole and is only logged, so the run silently had no findings. 60 s, as
 * `persistRequirements` (`REPLACE_REQUIREMENTS_TIMEOUT_MS`) sets for the same
 * shape of work.
 */
export const GOVERNING_FINDINGS_WRITE_TIMEOUT_MS = 60_000;

/** What one production run did. */
export interface GoverningFindingsRun {
  requirements: number;
  written: number;
  removed: number;
  /** #2010 — BA decisions cleared because the finding they were made on changed. */
  decisionsCleared: number;
  unverifiedCitations: number;
  noEvidenceDemoted: number;
  /** Requirements whose evaluation failed; their earlier findings are left as they were. */
  failed: number;
}

export interface ProduceGoverningFindingsInput {
  analysisId: string;
  projectId: string;
  provider: AIProvider;
  model?: string;
  signal?: AbortSignal;
  /** Only these requirements (a BA answer settled pairs of them); default every one. */
  requirementIds?: readonly string[];
  /** The stored applicability, when the caller already has it. */
  applicability?: GoverningAnalysisApplicability | null;
}

/**
 * The pairs of one requirement a finding is produced for, with the BA's
 * answers. #2010 — and `ruleGone`: rules the pair still applies to that are no
 * longer citable (soft-deleted, or their document deleted). No finding is
 * produced for those, and their earlier rows are left as they were: "a deleted
 * rule leaves its findings", BA decision included.
 *
 * #1878 — exported so the eval's shipped arm (`eval/governing/arms.ts`, A5)
 * builds a requirement's pairs and answers with this code, not a copy of it.
 */
export function findingPairsOf(
  requirement: GoverningAnalysisApplicability["requirements"][number],
  rules: ReadonlyMap<string, FindingRule>,
): { pairs: FindingPair[]; answers: FindingAnswer[]; ruleGone: Set<string> } {
  const pairs: FindingPair[] = [];
  const answers: FindingAnswer[] = [];
  const ruleGone = new Set<string>();
  for (const d of requirement.decisions) {
    if (d.verdict === "does-not-apply") continue;
    const rule = rules.get(d.ruleId);
    if (!rule) {
      ruleGone.add(d.ruleId);
      continue;
    }
    pairs.push({
      rule,
      applicability: d.verdict,
      ...(d.businessFact ? { businessFact: d.businessFact } : {}),
    });
    if (d.settled?.answer.trim()) {
      const a = {
        answer: d.settled.answer,
        ...(d.settled.question ? { question: d.settled.question } : {}),
      };
      if (!answers.some((x) => x.answer === a.answer && x.question === a.question)) answers.push(a);
    }
  }
  return { pairs, answers, ruleGone };
}

async function workspaceOf(projectId: string): Promise<string | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  return project?.workspaceId ?? null;
}

function rowData(f: EvaluatedFinding) {
  return {
    revisionId: f.rule.revisionId,
    revisionLabel: f.rule.revisionLabel,
    documentTitle: f.rule.documentTitle,
    controlId: f.rule.controlId,
    clauseRef: f.rule.clauseRef,
    status: f.status,
    reasoning: f.reasoning,
    clauseStart: f.citation?.clauseStart ?? null,
    clauseEnd: f.citation?.clauseEnd ?? null,
    clauseExcerpt: f.citation?.clauseExcerpt ?? null,
    citationDropped: f.citationDropped,
    modelStatus: f.modelStatus,
    businessQuestion: f.businessQuestion,
  };
}

/**
 * #2010 / #2017 — the `AuditLog` row for a BA decision the system erased: by
 * the system, carrying everything the row held about the decision (who, what,
 * when, and the note), since the row no longer does. `status` is the finding's
 * new status, or null when the row itself was removed.
 */
function decisionClearedAudit(
  analysisId: string,
  prior: Row,
  change: { status: string | null; reason: string },
) {
  return buildAuditLogData({
    actorId: SYSTEM_ACTOR_ID,
    action: "governing.finding.decision-cleared",
    targetType: "governing_finding",
    targetId: prior.id,
    metadata: {
      analysisId,
      requirementId: prior.requirementId,
      controlId: prior.controlId,
      previousDecision: prior.decision,
      previousDecisionNote: prior.decisionNote,
      previousDecidedById: prior.decidedById,
      previousDecidedAt: prior.decidedAt?.toISOString() ?? null,
      previousStatus: prior.status,
      status: change.status,
      reason: change.reason,
    },
  });
}

/**
 * #2017 — the findings run of each analysis still in flight (or queued), as
 * the tail of its chain. Runs of one analysis go one after another, in the
 * order they were asked for, so a refresh started earlier can never commit
 * over a newer one, and two first creates never race on the unique key. The
 * entry is dropped when its last run settles. In-process only: it orders the
 * runs of one server.
 */
const findingsRuns = new Map<string, Promise<void>>();

/**
 * True while a findings run of `analysisId` is in flight or queued, so a
 * reader (the findings route) can say the findings are about to change and a
 * client can fetch them again once it reads false.
 */
export function governingFindingsRefreshing(analysisId: string): boolean {
  return findingsRuns.has(analysisId);
}

/**
 * #2022 — resolves when `previous` settles; rejects with the abort reason as
 * soon as `signal` aborts, so a run cancelled while it waits in the queue
 * stops then rather than after every run ahead of it.
 */
function turnOf(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return previous;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Evaluate and store the analysis's governing findings. Rows of the
 * requirements evaluated are upserted, and those of pairs that no longer apply
 * are removed. A BA decision is kept when the finding it was made on is
 * unchanged (status and citation), and cleared when the finding changed.
 * #2017 — queued behind any earlier run of the same analysis (see
 * {@link findingsRuns}). A run given no `applicability` reads the stored one
 * when it starts, not when it was asked for, so it sees every settlement
 * committed before it; a run given one (the orchestrator's join passes the
 * snapshot it just stored) evaluates that snapshot. #2022 — a run whose
 * `signal` aborts while it is queued rejects at once and evaluates nothing;
 * the runs queued behind it still wait for the ones ahead of it.
 */
export function produceGoverningFindingsForAnalysis(
  input: ProduceGoverningFindingsInput,
): Promise<GoverningFindingsRun> {
  const previous = findingsRuns.get(input.analysisId) ?? Promise.resolve();
  const result = turnOf(previous, input.signal).then(() => produceNow(input));
  const tail = Promise.allSettled([previous, result]).then(() => undefined);
  findingsRuns.set(input.analysisId, tail);
  void tail.then(() => {
    if (findingsRuns.get(input.analysisId) === tail) findingsRuns.delete(input.analysisId);
  });
  return result;
}

async function produceNow(input: ProduceGoverningFindingsInput): Promise<GoverningFindingsRun> {
  const run: GoverningFindingsRun = {
    requirements: 0,
    written: 0,
    removed: 0,
    decisionsCleared: 0,
    unverifiedCitations: 0,
    noEvidenceDemoted: 0,
    failed: 0,
  };
  const stored =
    input.applicability === undefined
      ? await readGoverningApplicability(input.analysisId)
      : input.applicability;
  if (!stored) return run;
  const wanted = input.requirementIds ? new Set(input.requirementIds) : null;
  const requirements = stored.requirements.filter(
    (r) => !r.error && (!wanted || wanted.has(r.requirementId)),
  );
  if (requirements.length === 0) return run;
  const workspaceId = await workspaceOf(input.projectId);
  if (!workspaceId) return run;
  const ids = requirements.flatMap((r) =>
    r.decisions.filter((d) => d.verdict !== "does-not-apply").map((d) => d.ruleId),
  );
  const { rules, revisionText } = await citableWorkspaceRules(workspaceId, [...new Set(ids)]);
  const byId = new Map<string, FindingRule>(rules.map((r) => [r.id, r]));

  const evaluated = new Map<string, { findings: EvaluatedFinding[]; ruleGone: Set<string> }>();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const r = requirements[cursor++];
      if (!r) return;
      const { pairs, answers, ruleGone } = findingPairsOf(r, byId);
      try {
        const report = await evaluateRequirementFindings({
          requirement: { id: r.requirementId, text: r.text },
          answers,
          pairs,
          revisionText: (id) => revisionText.get(id),
          provider: input.provider,
          ...(input.model ? { model: input.model } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        evaluated.set(r.requirementId, { findings: report.findings, ruleGone });
        run.unverifiedCitations += report.unverifiedCitations;
        run.noEvidenceDemoted += report.noEvidenceDemoted;
      } catch (err) {
        if (input.signal?.aborted) throw err;
        run.failed++;
        log.warn("governing findings could not be evaluated for a requirement", {
          analysisId: input.analysisId,
          requirementId: r.requirementId,
          error: (err as Error).message,
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FINDINGS_CONCURRENCY, requirements.length) }, () => worker()),
  );
  run.requirements = evaluated.size;

  await prisma.$transaction(
    async (tx) => {
      for (const [requirementId, { findings, ruleGone }] of evaluated) {
        const existing = await tx.governingFinding.findMany({
          where: { analysisId: input.analysisId, requirementId },
        });
        const keep = new Set([...findings.map((f) => f.rule.id), ...ruleGone]);
        const stale = existing.filter((e) => !keep.has(e.ruleId));
        if (stale.length > 0) {
          // #2017 — A09: a stale row's BA decision goes with the row, so it is
          // audited like one cleared on a changed finding.
          for (const e of stale.filter((x) => x.decision)) {
            await tx.auditLog.create({
              data: decisionClearedAudit(input.analysisId, e, {
                status: null,
                reason: "the rule no longer applies to the requirement",
              }),
            });
            run.decisionsCleared++;
          }
          await tx.governingFinding.deleteMany({
            where: { analysisId: input.analysisId, id: { in: stale.map((e) => e.id) } },
          });
          run.removed += stale.length;
        }
        for (const f of findings) {
          const data = rowData(f);
          const prior = existing.find((e) => e.ruleId === f.rule.id);
          const unchanged =
            prior !== undefined &&
            prior.status === data.status &&
            prior.clauseExcerpt === data.clauseExcerpt &&
            prior.revisionId === data.revisionId;
          const clearDecision = unchanged
            ? {}
            : { decision: null, decisionNote: null, decidedById: null, decidedAt: null };
          // #2010 — A09: erasing a BA's decision is recorded like making one, by
          // the system, in the same transaction, so the trail never says
          // "accepted" over a row that reads null with nothing saying why.
          if (!unchanged && prior?.decision) {
            await tx.auditLog.create({
              data: decisionClearedAudit(input.analysisId, prior, {
                status: data.status,
                reason: "the finding changed when it was produced again",
              }),
            });
            run.decisionsCleared++;
          }
          await tx.governingFinding.upsert({
            where: {
              analysisId_requirementId_ruleId: {
                analysisId: input.analysisId,
                requirementId,
                ruleId: f.rule.id,
              },
            },
            create: { analysisId: input.analysisId, requirementId, ruleId: f.rule.id, ...data },
            update: { ...data, ...clearDecision },
          });
          run.written++;
        }
      }
    },
    { timeout: GOVERNING_FINDINGS_WRITE_TIMEOUT_MS },
  );
  log.info("governing findings stored", { analysisId: input.analysisId, ...run });
  return run;
}

type Row = Awaited<ReturnType<typeof prisma.governingFinding.findMany>>[number];

function oneOf<T extends string>(list: readonly T[], v: string | null): T | null {
  return v !== null && (list as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * #1876 — the display names of the users who decided `rows`, by id: the
 * analysis view shows who rejected a finding. The display name, or the
 * username when it is blank; a user who no longer exists is left out, so the
 * finding reads `decidedByName: null` and keeps its `decidedById`.
 *
 * #2032 — inside a transaction, pass its client as `db`. The global client
 * would ask the pool for a second connection while the transaction holds one,
 * and concurrent decisions on Postgres then wait on each other until the pool
 * is exhausted and the transactions time out (P2028). See `rag/reindex-lease.ts`,
 * "NEVER touch the pool from inside someone else's transaction".
 */
async function deciderNames(
  rows: readonly Row[],
  db: Pick<Prisma.TransactionClient, "user"> = prisma,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.decidedById ? [r.decidedById] : [])))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, username: true },
  });
  return new Map(users.map((u) => [u.id, u.displayName.trim() || u.username]));
}

function toWire(row: Row, names: ReadonlyMap<string, string>): GoverningFinding {
  return {
    id: row.id,
    analysisId: row.analysisId,
    requirementId: row.requirementId,
    ruleId: row.ruleId,
    revisionId: row.revisionId,
    revisionLabel: row.revisionLabel,
    documentTitle: row.documentTitle,
    controlId: row.controlId,
    clauseRef: row.clauseRef,
    status: oneOf(GOVERNING_FINDING_STATUSES, row.status) ?? "needs-ba-input",
    reasoning: row.reasoning,
    clauseStart: row.clauseStart,
    clauseEnd: row.clauseEnd,
    clauseExcerpt: row.clauseExcerpt,
    citationDropped: row.citationDropped,
    modelStatus: oneOf(GOVERNING_FINDING_STATUSES, row.modelStatus),
    businessQuestion: row.businessQuestion,
    decision: oneOf(GOVERNING_FINDING_DECISIONS, row.decision),
    decisionNote: row.decisionNote,
    decidedById: row.decidedById,
    decidedByName: row.decidedById ? (names.get(row.decidedById) ?? null) : null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The counts the findings response carries. */
export interface GoverningFindingsSummary {
  total: number;
  compliant: number;
  gap: number;
  needsBaInput: number;
  unverifiedCitations: number;
  noEvidenceDemoted: number;
}

export function summariseFindings(findings: readonly GoverningFinding[]): GoverningFindingsSummary {
  const count = (s: GoverningFindingStatus) => findings.filter((f) => f.status === s).length;
  return {
    total: findings.length,
    compliant: count("compliant"),
    gap: count("gap"),
    needsBaInput: count("needs-ba-input"),
    unverifiedCitations: findings.filter((f) => f.citationDropped).length,
    noEvidenceDemoted: findings.filter(
      (f) => f.modelStatus === "compliant" && f.status !== "compliant" && !f.citationDropped,
    ).length,
  };
}

/** The analysis's findings, in requirement then control order. */
export async function listGoverningFindings(analysisId: string): Promise<GoverningFinding[]> {
  const rows = await prisma.governingFinding.findMany({
    where: { analysisId },
    orderBy: [{ requirementId: "asc" }, { controlId: "asc" }, { id: "asc" }],
  });
  const names = await deciderNames(rows);
  return rows.map((row) => toWire(row, names));
}

/** #1876 — one policy revision the findings cite, and how many rules it has. */
export interface GoverningFindingRevision {
  revisionId: string;
  documentTitle: string;
  revisionLabel: string;
  /** The revision's live rules, plus any rule a finding cites that was deleted since. */
  rules: number;
}

/**
 * #1876 — every revision `findings` cite, in first-cited order, with its rule
 * count: the "M" of the analysis view's "N of M applicable rules in <title>
 * <label>" (`governingSummarySentence`). Counted on the cited revision, not
 * the document's current one, as the findings themselves are (#1874).
 */
export async function governingFindingRevisions(
  findings: readonly GoverningFinding[],
): Promise<GoverningFindingRevision[]> {
  const byRevision = new Map<string, { first: GoverningFinding; ruleIds: Set<string> }>();
  for (const f of findings) {
    const entry = byRevision.get(f.revisionId) ?? { first: f, ruleIds: new Set<string>() };
    entry.ruleIds.add(f.ruleId);
    byRevision.set(f.revisionId, entry);
  }
  return Promise.all(
    [...byRevision].map(async ([revisionId, { first, ruleIds }]) => ({
      revisionId,
      documentTitle: first.documentTitle,
      revisionLabel: first.revisionLabel,
      rules: await prisma.governingRule.count({
        where: { revisionId, OR: [{ deletedAt: null }, { id: { in: [...ruleIds] } }] },
      }),
    })),
  );
}

/**
 * Record a BA's decision on one finding of `analysisId`, with an `AuditLog`
 * row in the same transaction. `null` when the analysis has no such finding —
 * the finding id is only ever looked up with its analysis id.
 */
export async function decideGoverningFinding(input: {
  analysisId: string;
  findingId: string;
  decision: GoverningFindingDecision;
  note?: string;
  decidedById: string;
  now?: Date;
}): Promise<GoverningFinding | null> {
  const at = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const found = await tx.governingFinding.findFirst({
      where: { id: input.findingId, analysisId: input.analysisId },
    });
    if (!found) return null;
    const note = input.note?.trim() ? input.note.trim() : null;
    const updated = await tx.governingFinding.update({
      where: { id: found.id },
      data: {
        decision: input.decision,
        decisionNote: note,
        decidedById: input.decidedById,
        decidedAt: at,
      },
    });
    await tx.auditLog.create({
      data: buildAuditLogData({
        actorId: input.decidedById,
        action: "governing.finding.decision",
        targetType: "governing_finding",
        targetId: found.id,
        metadata: {
          analysisId: input.analysisId,
          requirementId: found.requirementId,
          controlId: found.controlId,
          decision: input.decision,
          previousDecision: found.decision,
          hasNote: note !== null,
        },
      }),
    });
    return toWire(updated, await deciderNames([updated], tx));
  });
}

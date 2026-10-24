/**
 * Epic #394 P2 (#404, #405) — Persistence layer for `PrReviewState`.
 *
 * One row per (`projectId`, `repoOwner`, `repoName`, `prNumber`). The row
 * tracks the SHA of the HEAD commit at the time of the last completed
 * review (used by the incremental re-review path), the JSON-encoded
 * per-AC verdicts at that SHA (so the incremental path can carry forward
 * verdicts whose evidence files are unchanged), and a pointer to the
 * `AgentRun` that produced the review (for the UI deep-link).
 *
 * `acVerdictsJson` is stored as `String` for sqlite/postgres twin
 * portability — the schema-parity contract requires every JSON-shaped
 * column to be `String` so the same Prisma client compiles against both
 * providers.
 */
import { prisma } from "../../prisma.js";
import type { JudgeVerdict } from "./prompts.js";
import type { PrReviewSkipReason } from "./pr-audit.js";

/** #1470 — the latest job's outcome for a PR. */
export type PrReviewStatus = "reviewed" | "skipped" | "failed";

/**
 * #1470 — why a job was skipped. The audit vocabulary plus the reasons only
 * the job path knows: review switched off after the job was queued, a diff
 * GitHub would not return, and a server with no review model or GitHub client.
 */
export type PrReviewStateSkipReason =
  PrReviewSkipReason | "auto_review_disabled" | "diff_unavailable" | "review_not_configured";

export interface PrReviewStateKey {
  projectId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
}

export interface PrReviewStateRow extends PrReviewStateKey {
  id: string;
  lastReviewedSha: string | null;
  acVerdicts: JudgeVerdict[];
  lastRunId: string | null;
  lastVerdict: string | null;
  lastStatus: PrReviewStatus | null;
  lastSkipReason: string | null;
  lastReviewUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPrReviewStateInput extends PrReviewStateKey {
  lastReviewedSha: string | null;
  acVerdicts: JudgeVerdict[];
  lastRunId: string | null;
  lastVerdict: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function table(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).prReviewState;
}

function parseVerdicts(raw: string | null | undefined): JudgeVerdict[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
      .map((v) => ({
        acId: String(v.acId ?? ""),
        verdict:
          v.verdict === "satisfied" || v.verdict === "not_satisfied" || v.verdict === "uncertain"
            ? v.verdict
            : "uncertain",
        reasoning: String(v.reasoning ?? ""),
        evidenceFiles: Array.isArray(v.evidenceFiles)
          ? (v.evidenceFiles as unknown[]).map(String)
          : [],
      }));
  } catch {
    return [];
  }
}

function parseStatus(raw: string | null | undefined): PrReviewStatus | null {
  return raw === "reviewed" || raw === "skipped" || raw === "failed" ? raw : null;
}

function rowToState(row: {
  id: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  lastReviewedSha: string | null;
  acVerdictsJson: string | null;
  lastRunId: string | null;
  lastVerdict: string | null;
  lastStatus?: string | null;
  lastSkipReason?: string | null;
  lastReviewUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PrReviewStateRow {
  return {
    id: row.id,
    projectId: row.projectId,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    prNumber: row.prNumber,
    lastReviewedSha: row.lastReviewedSha,
    acVerdicts: parseVerdicts(row.acVerdictsJson),
    lastRunId: row.lastRunId,
    lastVerdict: row.lastVerdict,
    lastStatus: parseStatus(row.lastStatus),
    lastSkipReason: row.lastSkipReason ?? null,
    lastReviewUrl: row.lastReviewUrl ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Read the persisted PR-review state for a (project, repo, PR) tuple. */
export async function getPrReviewState(key: PrReviewStateKey): Promise<PrReviewStateRow | null> {
  const row = await table().findUnique({
    where: {
      projectId_repoOwner_repoName_prNumber: {
        projectId: key.projectId,
        repoOwner: key.repoOwner,
        repoName: key.repoName,
        prNumber: key.prNumber,
      },
    },
  });
  return row ? rowToState(row) : null;
}

/** Insert or update the PR-review state row. Idempotent on the unique key. */
export async function upsertPrReviewState(
  input: UpsertPrReviewStateInput,
): Promise<PrReviewStateRow> {
  const acVerdictsJson = JSON.stringify(input.acVerdicts ?? []);
  const data = {
    lastReviewedSha: input.lastReviewedSha,
    acVerdictsJson,
    lastRunId: input.lastRunId,
    lastVerdict: input.lastVerdict,
  };
  const row = await table().upsert({
    where: {
      projectId_repoOwner_repoName_prNumber: {
        projectId: input.projectId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        prNumber: input.prNumber,
      },
    },
    create: {
      projectId: input.projectId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      prNumber: input.prNumber,
      ...data,
    },
    update: data,
  });
  return rowToState(row);
}

/** #1470 — the outcome of one PR-review job, as the job path reports it. */
export type PrReviewOutcome =
  | {
      status: "reviewed";
      headSha: string | null;
      acVerdicts: JudgeVerdict[];
      runId: string;
      verdict: "approve" | "request_changes" | "comment";
      reviewUrl: string | null;
    }
  | { status: "skipped"; reason: PrReviewStateSkipReason }
  | { status: "failed"; runId: string };

/**
 * #1470 — write one job's outcome to the PR's row, creating it on first sight.
 *
 * A completed review replaces everything the incremental path reads (head SHA,
 * per-AC verdicts) along with the verdict, run and GitHub link. A skip or a
 * failure records only the status (and the skip's reason, or the failed run):
 * the review last posted to GitHub is still the PR's review, so its verdict,
 * link and SHA stay.
 */
export async function recordPrReviewOutcome(
  key: PrReviewStateKey,
  outcome: PrReviewOutcome,
): Promise<PrReviewStateRow> {
  let data: Record<string, unknown>;
  if (outcome.status === "reviewed") {
    data = {
      lastStatus: "reviewed",
      lastSkipReason: null,
      lastReviewedSha: outcome.headSha,
      acVerdictsJson: JSON.stringify(outcome.acVerdicts),
      lastRunId: outcome.runId,
      lastVerdict: outcome.verdict,
      lastReviewUrl: outcome.reviewUrl,
    };
  } else if (outcome.status === "skipped") {
    data = { lastStatus: "skipped", lastSkipReason: outcome.reason };
  } else {
    data = { lastStatus: "failed", lastSkipReason: null, lastRunId: outcome.runId };
  }
  const write = () => upsertOutcome(key, data);
  try {
    return await write();
  } catch (err) {
    // #1471 — two first writes for one PR (another replica, or a review racing
    // a manual re-run) can both take the upsert's create branch; the loser
    // fails on the unique key. The row now exists, so one retry updates it.
    if (!isUniqueViolation(err)) throw err;
    return write();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}

async function upsertOutcome(
  key: PrReviewStateKey,
  data: Record<string, unknown>,
): Promise<PrReviewStateRow> {
  const row = await table().upsert({
    where: {
      projectId_repoOwner_repoName_prNumber: {
        projectId: key.projectId,
        repoOwner: key.repoOwner,
        repoName: key.repoName,
        prNumber: key.prNumber,
      },
    },
    create: {
      projectId: key.projectId,
      repoOwner: key.repoOwner,
      repoName: key.repoName,
      prNumber: key.prNumber,
      ...data,
    },
    update: data,
  });
  return rowToState(row);
}

/** List most-recent PR-review states for a project (UI surface, #404). */
export async function listPrReviewStatesForProject(
  projectId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ items: PrReviewStateRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = { projectId };
  const [items, total] = await Promise.all([
    table().findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    table().count({ where }),
  ]);
  return {
    items: (items as Array<Parameters<typeof rowToState>[0]>).map(rowToState),
    total: total as number,
  };
}

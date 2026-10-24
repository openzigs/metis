/**
 * #1488 — one pass after boot that records the repository permission of the
 * connectors that would otherwise lose shared-secret pull request reviews on
 * upgrade.
 *
 * The #1488 migration leaves every existing connector's `repoPermission` NULL,
 * which is ineligible for shared-secret routing: no earlier Test recorded
 * which credential it used, so nothing could be backfilled without
 * re-admitting a connector that read a public repository with no token. The
 * scheduled refresh that would re-test them is opt-in, so without this pass
 * every shared-secret deployment lost its automatic reviews until someone
 * clicked Test on each card.
 *
 * This is not a backfill: each candidate is re-tested through
 * `testRepoConnector`, with its own bound token, and the result is written
 * only while the connector still names the repository, server and secret the
 * check read (the binding-guarded write). Candidates are the connectors that
 * are live, in a live project, `connected`, on GitHub (or GitHub Enterprise),
 * bound to a secret, without an own webhook secret that still verifies, and
 * with no recorded permission. A tokenless connector is skipped: a Test could
 * only record `none`.
 *
 * Serial, one check every `REPO_PERMISSION_RECHECK_INTERVAL_MS` (default 2 s),
 * so it never bursts the GitHub quota; fire-and-forget from boot, so it never
 * delays readiness. `REPO_PERMISSION_RECHECK=off` turns it off. A check that
 * fails is logged and counted; a 401/404 marks the connector `error` exactly
 * as a manual Test would, and a rate limit or 5xx leaves it as it was. #1499 —
 * so does a DNS or connection failure before any HTTP answer, for this
 * unattended pass only. Each candidate is re-read just before its check and
 * skipped when it no longer qualifies (another replica recorded it), so a
 * multi-replica deployment does not repeat every check per replica.
 */
import { prisma } from "../../prisma.js";
import { createChildLogger } from "../../logger.js";
import { connectorSecretState } from "./webhook-secret.js";
import { testRepoConnector } from "./repo-service.js";

const log = createChildLogger("repo-permission-recheck");

const DEFAULT_INTERVAL_MS = 2_000;

/** A connector that would lose shared-secret reviews for want of a recorded permission. */
const CANDIDATE_WHERE = {
  deletedAt: null,
  status: "connected",
  provider: { in: ["github", "github_enterprise"] },
  secretId: { not: null },
  repoPermission: null,
  project: { deletedAt: null },
};

const CANDIDATE_SELECT = {
  id: true,
  projectId: true,
  webhookSecretNonce: true,
  webhookSecretCheck: true,
} as const;

interface CandidateRow {
  id: string;
  projectId: string;
  webhookSecretNonce: string | null;
  webhookSecretCheck: string | null;
}

/**
 * A connector whose own secret still verifies takes no shared-secret
 * deliveries, so its permission does not matter here.
 */
function isCandidate(r: CandidateRow): boolean {
  return connectorSecretState(r) !== "active";
}

export interface PermissionRecheckDeps {
  test?: typeof testRepoConnector;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface PermissionRecheckSummary {
  skipped: boolean;
  candidates: number;
  recorded: number;
  failed: number;
  /** #1499 — candidates that no longer qualified when their turn came. */
  alreadyRecorded: number;
}

function intervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.REPO_PERMISSION_RECHECK_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
}

function disabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.REPO_PERMISSION_RECHECK ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "disabled";
}

export async function recheckUnrecordedRepoPermissions(
  deps: PermissionRecheckDeps = {},
): Promise<PermissionRecheckSummary> {
  const env = deps.env ?? process.env;
  if (disabled(env)) {
    log.info("repo_permission_recheck.disabled", { env: "REPO_PERMISSION_RECHECK" });
    return { skipped: true, candidates: 0, recorded: 0, failed: 0, alreadyRecorded: 0 };
  }
  const test = deps.test ?? testRepoConnector;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const wait = intervalMs(env);

  const rows = await prisma.repoConnection.findMany({
    where: CANDIDATE_WHERE,
    select: CANDIDATE_SELECT,
    orderBy: { id: "asc" },
  });
  const candidates = rows.filter(isCandidate);
  log.info("repo_permission_recheck.start", {
    candidates: candidates.length,
    intervalMs: wait,
  });

  let recorded = 0;
  let failed = 0;
  let alreadyRecorded = 0;
  // Spacing is between GitHub calls: a skipped candidate costs no wait.
  let calledGithub = false;
  for (const c of candidates) {
    if (calledGithub && wait > 0) await sleep(wait);
    calledGithub = false;
    // #1499 — every replica runs this pass at boot, from a list read once. A
    // candidate another replica (or a clicked Test) has recorded since is
    // skipped without a GitHub call, so N replicas do not cost N checks each.
    // Read after the wait, as close to the check as it can be.
    const current = await prisma.repoConnection.findFirst({
      where: { ...CANDIDATE_WHERE, id: c.id },
      select: CANDIDATE_SELECT,
    });
    if (!current || !isCandidate(current)) {
      alreadyRecorded += 1;
      continue;
    }
    calledGithub = true;
    try {
      // #1499 — unattended: a DNS or connection failure at boot leaves the
      // connector as it was rather than marking it `error`.
      await test(current.projectId, current.id, "system", { unattended: true });
      recorded += 1;
    } catch (err) {
      failed += 1;
      log.warn("repo_permission_recheck.failed", {
        connectorId: c.id,
        projectId: c.projectId,
        code: (err as { code?: unknown }).code ?? null,
      });
    }
  }
  log.info("repo_permission_recheck.done", {
    candidates: candidates.length,
    recorded,
    failed,
    alreadyRecorded,
  });
  return { skipped: false, candidates: candidates.length, recorded, failed, alreadyRecorded };
}

/** Boot hook: never awaited by boot, never throws. */
export function startRepoPermissionRecheck(deps: PermissionRecheckDeps = {}): void {
  void recheckUnrecordedRepoPermissions(deps).catch((err: unknown) => {
    log.error("repo_permission_recheck.crashed", { error: (err as Error).message });
  });
}

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
 * as a manual Test would, and a rate limit or 5xx leaves it as it was.
 */
import { prisma } from "../../prisma.js";
import { createChildLogger } from "../../logger.js";
import { connectorSecretState } from "./webhook-secret.js";
import { testRepoConnector } from "./repo-service.js";

const log = createChildLogger("repo-permission-recheck");

const DEFAULT_INTERVAL_MS = 2_000;

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
    return { skipped: true, candidates: 0, recorded: 0, failed: 0 };
  }
  const test = deps.test ?? testRepoConnector;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const wait = intervalMs(env);

  const rows = await prisma.repoConnection.findMany({
    where: {
      deletedAt: null,
      status: "connected",
      provider: { in: ["github", "github_enterprise"] },
      secretId: { not: null },
      repoPermission: null,
      project: { deletedAt: null },
    },
    select: {
      id: true,
      projectId: true,
      webhookSecretNonce: true,
      webhookSecretCheck: true,
    },
    orderBy: { id: "asc" },
  });
  // A connector whose own secret still verifies takes no shared-secret
  // deliveries, so its permission does not matter here.
  const candidates = rows.filter((r) => connectorSecretState(r) !== "active");
  log.info("repo_permission_recheck.start", {
    candidates: candidates.length,
    intervalMs: wait,
  });

  let recorded = 0;
  let failed = 0;
  for (const [i, c] of candidates.entries()) {
    if (i > 0 && wait > 0) await sleep(wait);
    try {
      await test(c.projectId, c.id, "system");
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
  log.info("repo_permission_recheck.done", { candidates: candidates.length, recorded, failed });
  return { skipped: false, candidates: candidates.length, recorded, failed };
}

/** Boot hook: never awaited by boot, never throws. */
export function startRepoPermissionRecheck(deps: PermissionRecheckDeps = {}): void {
  void recheckUnrecordedRepoPermissions(deps).catch((err: unknown) => {
    log.error("repo_permission_recheck.crashed", { error: (err as Error).message });
  });
}

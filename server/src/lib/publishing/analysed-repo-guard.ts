/**
 * #776 / #953 — "never write to the analysed repository" and the vault
 * credential handling shared by every publish path that writes to the
 * project's saved GitHub target: the draft pull request
 * (`./draft-pull-request.ts`) and Spec Kit's `/speckit.taskstoissues` live
 * export (`../spec-kit/commands/taskstoissues-github.ts`).
 *
 * One copy, so the two paths cannot drift on what counts as the analysed
 * repository, its upstream, or a usable credential. The rules and the
 * incidents behind them are documented on `draft-pull-request.ts`.
 */
import type { AuthPayload, CredentialCheckResult } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { authorizeAndBindSecretRefs, bindSecretRef } from "../vault/bound-secret.js";
import { refBodyOf } from "../vault/secret-binding.js";
import { VAULT_REF_FORMAT_MESSAGE } from "./publishing-service.js";
import { PublishError, type PublishOctokitLike } from "./types.js";

export interface AnalysedRepos {
  /** Every analysed repository, as lower-cased `owner/repo`. */
  names: Set<string>;
  /** The public-GitHub ones, whose upstream a live run looks up. */
  github: Array<{ owner: string; repo: string }>;
}

/**
 * The repositories this project analyses.
 *
 * Soft-deleted connections are included on purpose: deleting a connector does
 * not delete the analysis, code graph and findings built from that repository,
 * so it is still the analysed repo.
 *
 * `local` and `upload` connections have no owner or repo (only git providers
 * require them, `packages/shared/src/connectors.ts`), so they contribute
 * nothing here: the code they analyse is not identified as any GitHub
 * repository, and METIS cannot tell which one (if any) it was cloned from, so
 * it cannot equal the target. That is a known limit, stated in the user guide:
 * a project analysing an uploaded clone must not save that clone's origin as
 * its publish target.
 *
 * Only `github` connections have their upstream looked up: the target is on
 * the public API, and a GitHub Enterprise or GitLab repository's fork network
 * lives on its own host, so its parent cannot be a github.com repository.
 *
 * And only connections that were actually analysed ({@link wasAnalysed}): a
 * connection row is inserted before any connectivity test, so a typo'd
 * owner/repo that never connected would 404 and — since the lookup fails
 * closed — block every live run, with no way to clear it once soft-deleted.
 * The name-equality check needs no network call and keeps every row.
 */
export async function analysedRepos(projectId: string): Promise<AnalysedRepos> {
  const rows = await prisma.repoConnection.findMany({
    where: { projectId },
    select: {
      ownerOrOrg: true,
      repoName: true,
      provider: true,
      status: true,
      lastIngestAt: true,
      lastCommitSha: true,
      deletedAt: true,
    },
  });
  const names = new Set<string>();
  const github = new Map<string, { owner: string; repo: string }>();
  for (const r of rows) {
    if (!r.ownerOrOrg || !r.repoName) continue;
    const key = `${r.ownerOrOrg}/${r.repoName}`.toLowerCase();
    names.add(key);
    const lookUp = r.provider === "github" && wasAnalysed(r);
    if (lookUp) github.set(key, { owner: r.ownerOrOrg, repo: r.repoName });
  }
  return { names, github: [...github.values()] };
}

/**
 * A connection that reached GitHub: it connected, was ingested, or recorded a
 * commit. A row still `pending` with none of those never resolved to a real
 * repository. Soft-deleted rows qualify on the same terms.
 */
function wasAnalysed(r: {
  status: string;
  lastIngestAt: Date | null;
  lastCommitSha: string | null;
}): boolean {
  return r.status === "connected" || r.lastIngestAt !== null || r.lastCommitSha !== null;
}

/**
 * Builds the error for an analysed repository whose fork network could not be
 * read. It must never quote the upstream response, which could echo request
 * material.
 */
export type UpstreamLookupFailure = (
  repo: { owner: string; repo: string },
  status: number,
  cause: unknown,
) => Error;

/**
 * Lower-cased fork `parent`/`source` of every analysed GitHub repository.
 *
 * Any lookup failure — 404, private, rate limit — throws `onFailure`'s error:
 * the caller must refuse rather than treat an unknown upstream as none.
 */
export async function upstreamsOfAnalysed(
  client: PublishOctokitLike,
  repos: Array<{ owner: string; repo: string }>,
  onFailure: UpstreamLookupFailure,
): Promise<Set<string>> {
  const upstreams = new Set<string>();
  for (const r of repos) {
    let res: { parent?: { full_name?: unknown }; source?: { full_name?: unknown } };
    try {
      const out = await client.request<typeof res>({
        method: "GET",
        url: `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`,
      });
      res = out.data ?? {};
    } catch (err) {
      throw onFailure(r, statusOf(err), err);
    }
    for (const name of [res.parent?.full_name, res.source?.full_name]) {
      if (typeof name === "string" && name.length > 0) upstreams.add(name.toLowerCase());
    }
  }
  return upstreams;
}

/**
 * Refuse (409 PUBLISH_TARGET_IS_ANALYSED_REPO) when any candidate
 * `owner/repo` is in `refused` (lower-cased `owner/repo`). `what` names the
 * thing being written, so the message tells the user which feature refused.
 */
export function refuseIfAnalysed(refused: Set<string>, candidates: string[], what: string): void {
  if (candidates.some((c) => refused.has(c.toLowerCase()))) {
    throw new PublishError(
      409,
      "PUBLISH_TARGET_IS_ANALYSED_REPO",
      `the saved publish target is the repository this project analyses, or that repository's upstream; save a separate target (for example a sandbox fork) for ${what}`,
    );
  }
}

/** Dry run: does the reference bind to a live secret? Never reads the plaintext. */
export async function checkCredential(
  secretRef: string | undefined,
): Promise<CredentialCheckResult> {
  if (!secretRef) return "missing";
  const body = refBodyOf(secretRef);
  if (!body) return "unresolved";
  try {
    await bindSecretRef(body);
    return "resolved";
  } catch (err) {
    if (err instanceof AppError) return "unresolved";
    throw err;
  }
}

/** Bind failures whose vault-layer text quotes the reference back. */
const UNBOUND_CODES = new Set(["VAULT_REF_UNRESOLVED", "VAULT_REF_AMBIGUOUS"]);

/**
 * Live run: authorize and bind the reference to ONE secret id (#577), with
 * fixed (never echoing) errors. The write is judged as a new destination
 * (#344, as an import source is, #763): the caller must own the secret unless
 * they hold `vault.reveal`; a refusal is the vault layer's audited 403
 * SECRET_BINDING_FORBIDDEN, whose text quotes nothing from the request.
 */
export async function bindPublishCredential(input: {
  actorId: string;
  actorRole: AuthPayload["role"];
  secretRef: string;
  projectId: string;
  /** The audited object the credential is bound for. */
  target: { type: string; id: string };
}): Promise<{ secretId: string; until: Date | null }> {
  const body = refBodyOf(input.secretRef);
  if (!body) throw new PublishError(400, "VAULT_REF_INVALID", VAULT_REF_FORMAT_MESSAGE);
  try {
    const { bindings, until } = await authorizeAndBindSecretRefs(
      { userId: input.actorId, role: input.actorRole },
      { before: [], after: [body], destinationChanged: true },
      { target: input.target, metadata: { projectId: input.projectId } },
    );
    return { secretId: bindings[body], until };
  } catch (err) {
    if (err instanceof AppError && UNBOUND_CODES.has(err.code)) {
      throw new PublishError(
        err.statusCode,
        err.code,
        "That vault secret ref does not name exactly one vault secret. Check the label.",
      );
    }
    throw err;
  }
}

/** The HTTP status on an Octokit-style error, or 0. */
export function statusOf(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : 0;
}

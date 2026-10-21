/**
 * F6 / #1171 — the cross-project publish guard.
 *
 * A live publish into a repository another project has connected needs the
 * caller's explicit confirmation. Two concerns live here, kept apart on
 * purpose:
 *
 *  - **Finding** the conflict is authorisation-free and runs in the service
 *    layer (`createBatch`), so no caller can skip it.
 *  - **Describing** it to a user is presentation and needs the user: the
 *    other project is named only when the caller may open it
 *    (`assertProjectAccess`, the same seam every `/projects/:id` route uses).
 *    A project the caller cannot reach is "another project" — its name is
 *    never sent, and neither is its id.
 *
 * #1171 — the refusal used to tell a UI user to "pass confirmCrossProject=true",
 * an API flag the page offered no way to set. The messages below name no API
 * parameter; the page offers a confirm and sets the flag itself.
 */
import type { AuthPayload } from "@metis/shared";
import { assertProjectAccess } from "../custom-agents/authz.js";
import { AppError } from "../../middleware/error-handler.js";
import { prisma } from "../prisma.js";
import { PublishError } from "./types.js";

/** Projects looked up and described at most — the answer is "one" in practice. */
const MAX_CONFLICTS = 5;

/**
 * Thrown by `assertNotCrossProject`. The conflicting project ids are kept OFF `details`
 * (which `asAppError` forwards to the client verbatim) so that only
 * `describeCrossProjectRefusal`, which checks access, decides what is shown.
 */
export class CrossProjectRepoError extends PublishError {
  readonly repo: string;
  readonly conflictingProjectIds: readonly string[];
  constructor(repo: string, conflictingProjectIds: readonly string[]) {
    super(409, "REPO_CROSS_PROJECT", crossProjectMessage(repo, []), false, {
      repo,
      projects: [],
    });
    this.name = "CrossProjectRepoError";
    this.repo = repo;
    this.conflictingProjectIds = conflictingProjectIds;
  }
}

/**
 * The ids of other projects that have `owner/repo` connected (live connectors
 * only), at most {@link MAX_CONFLICTS}.
 *
 * #1180 — matched case-insensitively. GitHub owner and repository names are
 * case-insensitive, so `MiniFlux/V2` is the repository another project
 * connected as `miniflux/v2`; Prisma's `equals` is case-sensitive on SQLite,
 * and its `mode: "insensitive"` exists only in the Postgres-generated client.
 * Both sides are folded with `LOWER()` instead, which SQLite and Postgres both
 * provide, in a tagged `$queryRaw`: every value is a bound parameter.
 * (`LOWER` folds ASCII on SQLite; GitHub names are ASCII.)
 */
export async function findCrossProjectOwners(input: {
  projectId: string;
  targetOwner: string;
  targetRepo: string;
}): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ projectId: string }>>`
    SELECT DISTINCT "projectId" FROM "repo_connections"
    WHERE LOWER("ownerOrOrg") = LOWER(${input.targetOwner})
      AND LOWER("repoName") = LOWER(${input.targetRepo})
      AND "projectId" <> ${input.projectId}
      AND "deletedAt" IS NULL
    ORDER BY "projectId" ASC`;
  return rows.slice(0, MAX_CONFLICTS).map((r) => r.projectId);
}

/**
 * The service-layer cross-project check. Called by batch publish
 * (`createBatch`), finding publish (`publishAnalysisFinding`), the draft
 * pull request (`openDraftPullRequest`, #1180) and the Spec Kit tasks-to-issues
 * export (`exportTasksToGitHub`, #1211); docs/ARCHITECTURE.md lists the paths
 * that deliberately do not. Throws
 * `CrossProjectRepoError` when another project has `owner/repo` connected,
 * unless the caller confirmed — and only a literal `true` confirms.
 */
export async function assertNotCrossProject(input: {
  projectId: string;
  targetOwner: string;
  targetRepo: string;
  confirmed?: boolean;
}): Promise<void> {
  if (input.confirmed === true) return;
  const conflicting = await findCrossProjectOwners(input);
  if (conflicting.length > 0) {
    throw new CrossProjectRepoError(`${input.targetOwner}/${input.targetRepo}`, conflicting);
  }
}

/**
 * The user-facing text. `names` holds only projects the caller may open; when
 * it is empty the project is "another project", whatever exists.
 */
export function crossProjectMessage(repo: string, names: readonly string[]): string {
  const who =
    names.length === 0
      ? "another project"
      : names.length === 1
        ? `the project "${names[0]}"`
        : `the projects ${names.map((n) => `"${n}"`).join(", ")}`;
  return `${repo} is already connected to ${who}. Confirm to publish to it anyway.`;
}

/** What a caller may be told about the other projects connecting a repo. */
export interface CrossProjectNotice {
  /** `owner/repo`. */
  repo: string;
  /** Names of the other projects the caller may open; empty = name none. */
  projects: string[];
}

/**
 * The names of `projectIds` that `user` may open, per `assertProjectAccess`.
 * Fails closed — any access or lookup error leaves a project unnamed.
 */
export async function nameableProjects(
  projectIds: readonly string[],
  user: AuthPayload,
): Promise<string[]> {
  const visible: string[] = [];
  for (const id of projectIds) {
    try {
      await assertProjectAccess(user, id);
      visible.push(id);
    } catch {
      // Not reachable by this caller (or the lookup failed): stays unnamed.
    }
  }
  if (visible.length === 0) return [];
  try {
    const rows = await prisma.project.findMany({
      where: { id: { in: visible } },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => r.name).filter((n): n is string => typeof n === "string" && !!n);
  } catch {
    return [];
  }
}

/**
 * Turn the service's refusal into the client error for `user`: the other
 * projects are named only where `assertProjectAccess` admits the caller.
 */
export async function describeCrossProjectRefusal(
  err: CrossProjectRepoError,
  user: AuthPayload,
): Promise<AppError> {
  const names = await nameableProjects(err.conflictingProjectIds, user);
  return new AppError(409, "REPO_CROSS_PROJECT", crossProjectMessage(err.repo, names), {
    repo: err.repo,
    projects: names,
  });
}

/**
 * #1171 — the notice a DRY RUN carries when its target is connected to another
 * project: the live publish will ask for confirmation. Same naming rule as the
 * refusal. Null when nothing conflicts, and null on any failure — a dry run
 * must never fail because its advisory notice could not be built.
 *
 * Computed per response, never persisted in the batch's plan: the plan is read
 * back by anyone who can see the batch, who may not be able to open the other
 * project.
 */
export async function crossProjectDryRunNotice(
  input: { projectId: string; targetOwner: string; targetRepo: string },
  user: AuthPayload,
): Promise<CrossProjectNotice | null> {
  try {
    const ids = await findCrossProjectOwners(input);
    if (ids.length === 0) return null;
    return {
      repo: `${input.targetOwner}/${input.targetRepo}`,
      projects: await nameableProjects(ids, user),
    };
  } catch {
    return null;
  }
}

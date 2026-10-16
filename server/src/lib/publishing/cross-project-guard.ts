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
 * Thrown by `createBatch`. The conflicting project ids are kept OFF `details`
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

/** The ids of other projects that have `owner/repo` connected (live connectors only). */
export async function findCrossProjectOwners(input: {
  projectId: string;
  targetOwner: string;
  targetRepo: string;
}): Promise<string[]> {
  const rows = await prisma.repoConnection.findMany({
    where: {
      ownerOrOrg: input.targetOwner,
      repoName: input.targetRepo,
      projectId: { not: input.projectId },
      deletedAt: null,
    },
    select: { projectId: true },
    distinct: ["projectId"],
    orderBy: { projectId: "asc" },
    take: MAX_CONFLICTS,
  });
  return rows.map((r) => r.projectId);
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

/**
 * Turn the service's refusal into the client error for `user`: the other
 * projects are named only where `assertProjectAccess` admits the caller.
 * Fails closed — any lookup error leaves the project unnamed.
 */
export async function describeCrossProjectRefusal(
  err: CrossProjectRepoError,
  user: AuthPayload,
): Promise<AppError> {
  const visible: string[] = [];
  for (const id of err.conflictingProjectIds) {
    try {
      await assertProjectAccess(user, id);
      visible.push(id);
    } catch {
      // Not reachable by this caller (or the lookup failed): stays unnamed.
    }
  }
  let names: string[] = [];
  if (visible.length > 0) {
    try {
      const rows = await prisma.project.findMany({
        where: { id: { in: visible } },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      names = rows.map((r) => r.name).filter((n): n is string => typeof n === "string" && !!n);
    } catch {
      names = [];
    }
  }
  return new AppError(409, "REPO_CROSS_PROJECT", crossProjectMessage(err.repo, names), {
    repo: err.repo,
    projects: names,
  });
}

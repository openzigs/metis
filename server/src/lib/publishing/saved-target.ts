/**
 * #733 / #784 — the project's saved GitHub publish target.
 *
 * The one place both publish paths read it from: the Deep Dive finding
 * publisher (`./analysis-finding-publish.ts`) and Spec Kit's
 * `/speckit.taskstoissues`. Keeping a single reader means the two cannot drift
 * on what counts as "configured".
 *
 * Deliberately NOT the project's `RepoConnection`: that is the analysed
 * repository, which for an open-source project is someone else's upstream.
 */
import { prisma } from "../prisma.js";
import type { GitHubIssueTarget } from "./finding-publisher.js";

/** The saved `owner/repo`, or null. A half-set pair counts as none. */
export async function findSavedGitHubTarget(projectId: string): Promise<GitHubIssueTarget | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { publishGithubOwner: true, publishGithubRepo: true },
  });
  if (project?.publishGithubOwner && project.publishGithubRepo) {
    return { owner: project.publishGithubOwner, repo: project.publishGithubRepo };
  }
  return null;
}

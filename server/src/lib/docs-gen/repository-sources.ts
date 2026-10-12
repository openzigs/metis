/** Repository-qualified source identity shared by synthesis, caches and evidence (#1354). */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../prisma.js";
import { resolveRepoClonePath } from "../connectors/repo/clone-path.js";
import type { RepositoryIdentity } from "./repository-identity.js";
export { repositoryPathIdentity, type RepositoryIdentity } from "./repository-identity.js";

export interface RepositorySource extends RepositoryIdentity {
  /** Null means unavailable; never resolve source against cwd or another connector. */
  root: string | null;
  commitSha: string | null;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Reject absolute/traversing paths and symlink escapes before reading source or SQL. */
export async function resolveSourcePath(
  root: string | null,
  relativePath: string,
): Promise<string> {
  if (
    !root ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw new Error("Repository source path unavailable");
  }
  const candidate = path.resolve(root, relativePath);
  if (!contained(path.resolve(root), candidate))
    throw new Error("Repository source path escapes root");
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!contained(canonicalRoot, canonicalFile))
    throw new Error("Repository source symlink escapes root");
  return canonicalFile;
}

/** Keep the historical same-connector locations; never substitute a different repository. */
async function resolveConnectorRoot(connectorId: string): Promise<string | null> {
  // Connector IDs are database identities, not filesystem paths.
  if (!/^[A-Za-z0-9_-]+$/.test(connectorId)) return null;
  const candidates = new Set([
    resolveRepoClonePath(connectorId),
    path.resolve(process.env.REPO_CLONE_DIR || "./data/repo-clones", connectorId),
    path.resolve("server/data/repo-clones", connectorId),
    path.resolve("./data/repos", connectorId),
  ]);
  for (const candidate of candidates) {
    try {
      // A connector directory itself must not alias a sibling clone.
      const [parent, actual] = await Promise.all([
        realpath(path.dirname(candidate)),
        realpath(candidate),
      ]);
      if (actual !== path.join(parent, connectorId)) continue;
      await readFile(await resolveSourcePath(actual, ".git/HEAD"), "utf-8");
      return actual;
    } catch {
      // Missing/unreadable checkout: try only this connector's legacy locations.
    }
  }
  return null;
}

export async function loadRepositorySources(scope: {
  projectId: string;
  codeGraphId?: string;
}): Promise<Map<string, RepositorySource>> {
  const graphs = await prisma.codeGraph.findMany({
    where: { projectId: scope.projectId, ...(scope.codeGraphId ? { id: scope.codeGraphId } : {}) },
    select: {
      id: true,
      commitSha: true,
      repoConnection: { select: { id: true, projectId: true, deletedAt: true } },
    },
  });
  const sources = new Map<string, RepositorySource>();
  for (const graph of graphs) {
    const connector = graph.repoConnection;
    const active = connector?.projectId === scope.projectId && connector.deletedAt === null;
    sources.set(graph.id, {
      codeGraphId: graph.id,
      repoConnectorId: connector?.id ?? null,
      root: active ? await resolveConnectorRoot(connector.id) : null,
      commitSha: graph.commitSha ?? null,
    });
  }
  return sources;
}

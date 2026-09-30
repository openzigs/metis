/**
 * Issue #32 — the Workbench Documents panel's model: uploads in their own
 * group, repository files as a folder tree per repository, and a filter over
 * name and path.
 *
 * Every step is pure and linear in the number of documents, so a project with
 * thousands of ingested files costs one pass to parse (memoised on the list),
 * one pass per keystroke to filter, and one pass to group what is left.
 *
 * Labels never carry an internal id: a repository is named from `repoNames`
 * (or "Unnamed repository" when its connector is unknown), and a generated
 * document is told apart by its date rather than by a cuid fragment.
 */
import type { DocumentRow } from "@/lib/projects-api";
import { formatSourceLabel } from "@/lib/format-source-label";
import { formatDocLabel } from "@/lib/doc-label";

export const UNNAMED_REPOSITORY = "Unnamed repository";

export interface PanelEntry {
  doc: DocumentRow;
  kind: "upload" | "repo";
  /** What the row shows: an upload's name, or a repository file's basename. */
  name: string;
  /** Optional second line for an upload (a generated document's date). */
  secondary?: string;
  /** Hover text: the repository name plus the file's path, or the upload's name. */
  title: string;
  /** Repository files only: the path inside the repository. */
  path?: string;
  /** Repository files only: groups the file under its repository. */
  connectorId?: string;
  repoName?: string;
  /** Lower-cased name and path, matched by the filter. */
  searchText: string;
}

export interface FolderNode {
  /** Unique within the panel; used for React keys and expand state only. */
  key: string;
  name: string;
  folders: FolderNode[];
  files: PanelEntry[];
  /** Files anywhere below this folder. */
  fileCount: number;
}

export interface RepoNode extends FolderNode {
  connectorId: string;
}

export interface DocumentGroups {
  uploads: PanelEntry[];
  repos: RepoNode[];
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString();
}

/** Parse every document once into what the panel renders and searches. */
export function toPanelEntries(
  docs: readonly DocumentRow[],
  repoNames?: Readonly<Record<string, string>>,
): PanelEntry[] {
  return docs.map((doc) => {
    const source = formatSourceLabel(doc.filename, repoNames);
    const connectorId = source.isConnector ? connectorIdOf(source.rawId) : undefined;
    if (source.isConnector && source.path && connectorId) {
      const known =
        repoNames && Object.prototype.hasOwnProperty.call(repoNames, connectorId)
          ? repoNames[connectorId]?.trim()
          : undefined;
      const repoName = known || UNNAMED_REPOSITORY;
      return {
        doc,
        kind: "repo",
        name: source.basename,
        title: `${repoName}/${source.path}`,
        path: source.path,
        connectorId,
        repoName,
        searchText: source.path.toLowerCase(),
      };
    }
    const label = formatDocLabel(doc.filename);
    // A generated document's secondary is a cuid fragment: show its date instead.
    const secondary = label.kind === "generated" ? formatDate(doc.uploadedAt) : label.secondary;
    return {
      doc,
      kind: "upload",
      name: label.primary,
      ...(secondary ? { secondary } : {}),
      title: label.primary,
      searchText: label.primary.toLowerCase(),
    };
  });
}

/** `connector:repo:<connectorId>:<path>` → `<connectorId>`. */
function connectorIdOf(rawId: string): string | undefined {
  return /^connector:repo:([^:]+):/.exec(rawId)?.[1];
}

/** Case-insensitive substring match on name or path; a blank query keeps all. */
export function filterEntries(entries: readonly PanelEntry[], query: string): PanelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.searchText.includes(q));
}

function newFolder(key: string, name: string): FolderNode {
  return { key, name, folders: [], files: [], fileCount: 0 };
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

function sortFolder(folder: FolderNode): void {
  folder.folders.sort(byName);
  folder.files.sort(byName);
  for (const child of folder.folders) sortFolder(child);
}

/** Uploads first (as listed), then one folder tree per repository, by name. */
export function groupEntries(entries: readonly PanelEntry[]): DocumentGroups {
  const uploads: PanelEntry[] = [];
  const repos = new Map<string, RepoNode>();
  // Folder lookup by key, so each file walks its path in O(depth).
  const folders = new Map<string, FolderNode>();

  for (const entry of entries) {
    if (entry.kind === "upload" || !entry.connectorId || !entry.path) {
      uploads.push(entry);
      continue;
    }
    let repo = repos.get(entry.connectorId);
    if (!repo) {
      repo = {
        ...newFolder(`repo:${entry.connectorId}`, entry.repoName ?? UNNAMED_REPOSITORY),
        connectorId: entry.connectorId,
      };
      repos.set(entry.connectorId, repo);
    }
    repo.fileCount += 1;
    const dirs = entry.path.split("/").filter(Boolean).slice(0, -1);
    let parent: FolderNode = repo;
    let key = repo.key;
    for (const dir of dirs) {
      key = `${key}/${dir}`;
      let child = folders.get(key);
      if (!child) {
        child = newFolder(key, dir);
        folders.set(key, child);
        parent.folders.push(child);
      }
      child.fileCount += 1;
      parent = child;
    }
    parent.files.push(entry);
  }

  const repoList = [...repos.values()].sort(byName);
  for (const repo of repoList) sortFolder(repo);
  return { uploads, repos: repoList };
}

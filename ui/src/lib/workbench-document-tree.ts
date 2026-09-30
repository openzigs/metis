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
 * (or "Unnamed repository", numbered when there are several), a generated
 * document is told apart by its date rather than by a cuid fragment, and a
 * document another connector wrote (a database schema, a Confluence page, a
 * Jira issue) goes under "Other sources" rather than under "Uploaded".
 */
import type { DocumentRow } from "@/lib/projects-api";
import { formatSourceLabel } from "@/lib/format-source-label";
import { formatDocLabel } from "@/lib/doc-label";

export const UNNAMED_REPOSITORY = "Unnamed repository";
export const UNNAMED_DATABASE = "Database schema";

export interface PanelEntry {
  doc: DocumentRow;
  kind: "upload" | "repo" | "source";
  /** What the row shows: an upload's name, or a repository file's basename. */
  name: string;
  /** Optional second line for an upload (a generated document's date). */
  secondary?: string;
  /** Hover text: the repository name plus the file's path, or the upload's name. */
  title: string;
  /** Repository files only: the path inside the repository. */
  path?: string;
  /** Repository files and other sources: groups the file under its source. */
  connectorId?: string;
  /** The group's label. Repository files: the repository name. */
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
  /** Documents another connector wrote: database schemas, Confluence, Jira. */
  sources: RepoNode[];
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString();
}

/** A name from `repoNames`, own properties only (never `constructor`). */
function knownName(
  id: string,
  repoNames: Readonly<Record<string, string>> | undefined,
): string | undefined {
  return repoNames && Object.prototype.hasOwnProperty.call(repoNames, id)
    ? repoNames[id]?.trim() || undefined
    : undefined;
}

/** `connector:db:<connectorId>:<table>.md` (connector-ingest.ts). */
const DB_RE = /^connector:db:([^:]+):(.+)$/;
/** `confluence:<spaceKey>:<pageId>` (atlassian.ts). */
const CONFLUENCE_RE = /^confluence:([^:]+):(.+)$/;
/** `jira:<issueKey>` (atlassian.ts). */
const JIRA_RE = /^jira:(.+)$/;

function sourceEntry(
  doc: DocumentRow,
  groupKey: string,
  groupName: string,
  name: string,
): PanelEntry {
  return {
    doc,
    kind: "source",
    name,
    title: `${groupName}: ${name}`,
    path: name,
    connectorId: groupKey,
    repoName: groupName,
    searchText: `${groupName} ${name}`.toLowerCase(),
  };
}

/** A document another connector wrote, or undefined when it is not one. */
function toSourceEntry(
  doc: DocumentRow,
  repoNames: Readonly<Record<string, string>> | undefined,
): PanelEntry | undefined {
  const raw = (doc.filename ?? "").trim();
  const db = DB_RE.exec(raw);
  if (db) {
    const table = db[2].replace(/\.md$/i, "");
    return sourceEntry(
      doc,
      `db:${db[1]}`,
      knownName(db[1], repoNames) ?? UNNAMED_DATABASE,
      table === "OVERVIEW" ? "Overview" : table,
    );
  }
  const page = CONFLUENCE_RE.exec(raw);
  if (page) {
    return sourceEntry(doc, `confluence:${page[1]}`, `Confluence ${page[1]}`, `Page ${page[2]}`);
  }
  const issue = JIRA_RE.exec(raw);
  if (issue) return sourceEntry(doc, "jira", "Jira", issue[1]);
  return undefined;
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
      const repoName = knownName(connectorId, repoNames) || UNNAMED_REPOSITORY;
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
    const other = toSourceEntry(doc, repoNames);
    if (other) return other;
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

/**
 * #440 — one line naming an entry outside the tree (the attached-document chips
 * above the chat): a repository file as `<basename> — <repository>`, another
 * source as `<source>: <name>`, an upload by its name. Built from the panel's
 * entry, so it never carries an internal id fragment either.
 */
export function entryLabel(entry: PanelEntry): string {
  if (entry.kind === "repo") return `${entry.name} — ${entry.repoName}`;
  if (entry.kind === "source") return entry.title;
  return entry.name;
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

/**
 * Give groups that share a fallback name ("Unnamed repository") an ordinal —
 * "Unnamed repository 2" — so two unknown connectors can be told apart without
 * showing either one's id. Ordinals follow the connector id, so they are stable.
 */
function numberDuplicateNames(groups: RepoNode[]): void {
  const sameName = new Map<string, RepoNode[]>();
  for (const g of groups) {
    const list = sameName.get(g.name);
    if (list) list.push(g);
    else sameName.set(g.name, [g]);
  }
  for (const [name, same] of sameName) {
    if (same.length < 2) continue;
    same.sort((a, b) => (a.connectorId < b.connectorId ? -1 : 1));
    same.forEach((g, i) => {
      if (i > 0) g.name = `${name} ${i + 1}`;
    });
  }
}

/** Uploads first (as listed), then one folder tree per repository and per other source, by name. */
export function groupEntries(entries: readonly PanelEntry[]): DocumentGroups {
  const uploads: PanelEntry[] = [];
  const repos = new Map<string, RepoNode>();
  const sources = new Map<string, RepoNode>();
  // Folder lookup by key, so each file walks its path in O(depth).
  const folders = new Map<string, FolderNode>();

  for (const entry of entries) {
    if (entry.kind === "upload" || !entry.connectorId || !entry.path) {
      uploads.push(entry);
      continue;
    }
    const isSource = entry.kind === "source";
    const groups = isSource ? sources : repos;
    let repo = groups.get(entry.connectorId);
    if (!repo) {
      repo = {
        ...newFolder(
          `${isSource ? "source" : "repo"}:${entry.connectorId}`,
          entry.repoName ?? UNNAMED_REPOSITORY,
        ),
        connectorId: entry.connectorId,
      };
      groups.set(entry.connectorId, repo);
    }
    repo.fileCount += 1;
    if (isSource) {
      repo.files.push(entry);
      continue;
    }
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

  const repoList = [...repos.values()];
  const sourceList = [...sources.values()];
  numberDuplicateNames(repoList);
  numberDuplicateNames(sourceList);
  repoList.sort(byName);
  sourceList.sort(byName);
  for (const group of [...repoList, ...sourceList]) sortFolder(group);
  return { uploads, repos: repoList, sources: sourceList };
}

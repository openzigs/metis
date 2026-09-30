/**
 * Issue #32 — the Workbench Documents panel's model: uploads in their own
 * group, repository files as a folder tree per repository, and a filter over
 * name and path. #526 — {@link flattenGroups} turns the tree into the flat row
 * list the panel virtualises.
 *
 * Every step is pure and linear in the number of documents, so a project with
 * thousands of ingested files costs one pass to parse (memoised on the list),
 * one pass per keystroke to filter, and one pass to group what is left.
 *
 * Labels never carry an internal id: a repository is named from `repoNames`
 * (or "Unnamed repository", numbered when there are several), a generated
 * document is told apart by its date rather than by a cuid fragment, and a
 * document another connector wrote (a database schema, a Confluence page, a
 * Jira issue) goes under "Other sources" rather than under "Uploaded" — decided
 * by the document's stored `source`, never by its filename (#474).
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

function repoEntry(
  doc: DocumentRow,
  connectorId: string,
  repoName: string,
  basename: string,
  path: string,
): PanelEntry {
  return {
    doc,
    kind: "repo",
    name: basename,
    title: `${repoName}/${path}`,
    path,
    connectorId,
    repoName,
    searchText: path.toLowerCase(),
  };
}

/**
 * #474 — a document the source column says a connector wrote, parsed for its
 * group and name. The filename pattern is read only for a row whose `source`
 * already names that connector, so an upload named `jira:ABC-1` stays an upload.
 */
function toConnectorEntry(
  doc: DocumentRow,
  repoNames: Readonly<Record<string, string>> | undefined,
): PanelEntry | undefined {
  const raw = (doc.filename ?? "").trim();
  switch (doc.source) {
    case "repo": {
      const source = formatSourceLabel(raw, repoNames);
      const connectorId = source.isConnector ? connectorIdOf(source.rawId) : undefined;
      if (!source.path || !connectorId) return undefined;
      const repoName = knownName(connectorId, repoNames) || UNNAMED_REPOSITORY;
      return repoEntry(doc, connectorId, repoName, source.basename, source.path);
    }
    case "db": {
      const db = DB_RE.exec(raw);
      if (!db) return undefined;
      const table = db[2].replace(/\.md$/i, "");
      return sourceEntry(
        doc,
        `db:${db[1]}`,
        knownName(db[1], repoNames) ?? UNNAMED_DATABASE,
        table === "OVERVIEW" ? "Overview" : table,
      );
    }
    case "confluence": {
      const page = CONFLUENCE_RE.exec(raw);
      if (!page) return undefined;
      const name = doc.title?.trim() || `Page ${page[2]}`;
      return sourceEntry(doc, `confluence:${page[1]}`, `Confluence ${page[1]}`, name);
    }
    case "jira": {
      const issue = JIRA_RE.exec(raw);
      return issue ? sourceEntry(doc, "jira", "Jira", issue[1]) : undefined;
    }
    default:
      return undefined;
  }
}

function toUploadEntry(doc: DocumentRow): PanelEntry {
  const label = formatDocLabel(doc.filename, doc.source);
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
}

/**
 * Give groups that share a fallback name ("Unnamed repository") an ordinal —
 * "Unnamed repository 2" — so two unknown connectors can be told apart without
 * showing either one's id. Ordinals follow the connector id, so they are stable.
 *
 * #474 — numbered here, on every entry, rather than on the panel's groups: the
 * attached-document chips are built from the same entries, so a chip reads
 * "README.md — Unnamed repository 2" exactly when its file sits in the panel
 * group of that name. Callers pass the whole document list, never a subset, so
 * an ordinal does not change with what else is attached or filtered.
 */
function numberDuplicateGroups(entries: PanelEntry[]): void {
  const idsByName = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.kind === "upload" || !e.connectorId || !e.repoName) continue;
    const key = `${e.kind}\0${e.repoName}`;
    const ids = idsByName.get(key);
    if (ids) ids.add(e.connectorId);
    else idsByName.set(key, new Set([e.connectorId]));
  }
  const renamed = new Map<string, string>();
  for (const [key, ids] of idsByName) {
    if (ids.size < 2) continue;
    const [kind, name] = key.split("\0");
    [...ids].sort().forEach((id, i) => {
      if (i > 0) renamed.set(`${kind}\0${id}`, `${name} ${i + 1}`);
    });
  }
  if (renamed.size === 0) return;
  entries.forEach((e, i) => {
    const name = renamed.get(`${e.kind}\0${e.connectorId}`);
    if (!name || !e.connectorId || !e.path) return;
    entries[i] =
      e.kind === "repo"
        ? repoEntry(e.doc, e.connectorId, name, e.name, e.path)
        : sourceEntry(e.doc, e.connectorId, name, e.name);
  });
}

/**
 * Parse every document once into what the panel renders and searches. Pass
 * the project's whole document list: group ordinals are numbered across it.
 */
export function toPanelEntries(
  docs: readonly DocumentRow[],
  repoNames?: Readonly<Record<string, string>>,
): PanelEntry[] {
  const entries = docs.map((doc) => toConnectorEntry(doc, repoNames) ?? toUploadEntry(doc));
  numberDuplicateGroups(entries);
  return entries;
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
  repoList.sort(byName);
  sourceList.sort(byName);
  for (const group of [...repoList, ...sourceList]) sortFolder(group);
  return { uploads, repos: repoList, sources: sourceList };
}

export type PanelGroup = "uploads" | "repos" | "sources";

/**
 * #526 — where a row sits in the tree, for `aria-level`, `aria-setsize` and
 * `aria-posinset`. The panel mounts only the rows in view, so a screen reader
 * learns the hierarchy and each level's full size from these, not from the DOM.
 */
export interface TreePosition {
  /** 1 for a group heading; 2 for a group's documents and root folders; +1 per folder. */
  level: number;
  /** How many siblings the row has, itself included, mounted or not. */
  setSize: number;
  /** The row's 1-based place among those siblings. */
  posInSet: number;
}

/** #526 — one row of the virtualised panel: a group heading, a folder, or a file. */
export type PanelRow = TreePosition &
  (
    | { type: "heading"; key: string; group: PanelGroup; label: string }
    | { type: "folder"; key: string; group: PanelGroup; depth: number; folder: FolderNode }
    | { type: "file"; key: string; group: PanelGroup; depth: number; entry: PanelEntry }
  );

const GROUP_ORDER: readonly PanelGroup[] = ["uploads", "repos", "sources"];

const GROUP_LABELS: Record<PanelGroup, string> = {
  uploads: "Uploaded",
  repos: "Repositories",
  sources: "Other sources",
};

/**
 * #526 — the rows the panel shows, in order: each non-empty group's heading,
 * then its rows. A folder's children follow it only when `isOpen(folder.key)`,
 * so a collapsed repository of thousands of files is one row. Linear in the
 * rows returned plus the folders walked. Each row carries its {@link TreePosition}.
 */
export function flattenGroups(
  groups: DocumentGroups,
  isOpen: (key: string) => boolean,
): PanelRow[] {
  const rows: PanelRow[] = [];
  // Depth 0 (a group's document or root folder) is tree level 2, under its heading.
  const at = (depth: number, setSize: number, posInSet: number): TreePosition => ({
    level: depth + 2,
    setSize,
    posInSet,
  });
  const file = (group: PanelGroup, entry: PanelEntry, depth: number, pos: TreePosition) =>
    rows.push({ type: "file", key: `file:${entry.doc.id}`, group, depth, entry, ...pos });
  const walk = (group: PanelGroup, folder: FolderNode, depth: number, pos: TreePosition) => {
    rows.push({ type: "folder", key: folder.key, group, depth, folder, ...pos });
    if (!isOpen(folder.key)) return;
    // Sub-folders, then files: one set of siblings.
    const size = folder.folders.length + folder.files.length;
    const inner = depth + 1;
    folder.folders.forEach((child, i) => walk(group, child, inner, at(inner, size, i + 1)));
    const offset = folder.folders.length;
    folder.files.forEach((entry, i) => file(group, entry, inner, at(inner, size, offset + i + 1)));
  };

  const present = GROUP_ORDER.filter((group) => groups[group].length > 0);
  present.forEach((group, i) => {
    rows.push({
      type: "heading",
      key: `heading:${group}`,
      group,
      label: GROUP_LABELS[group],
      level: 1,
      setSize: present.length,
      posInSet: i + 1,
    });
    if (group === "uploads") {
      const size = groups.uploads.length;
      groups.uploads.forEach((entry, j) => file(group, entry, 0, at(0, size, j + 1)));
    } else {
      const roots = groups[group];
      roots.forEach((root, j) => walk(group, root, 0, at(0, roots.length, j + 1)));
    }
  });
  return rows;
}

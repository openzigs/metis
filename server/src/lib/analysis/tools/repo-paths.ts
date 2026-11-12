/**
 * #2327 — validation of the globs and path fragments a model hands the code
 * tools (`list_files`'s `pattern`, `search_code_symbols`'s `fileGlob`,
 * `grep_files`'s `pathContains`).
 *
 * Every one of them is matched against repository-relative paths, so none can
 * reach a file outside the clone by itself. They are still refused when they
 * name a way out — an absolute path, a `..` segment, a backslash — so a model
 * that tries is told so rather than handed an empty result it might read as
 * "absent", and they are bounded in length and segment count so a match costs
 * a bounded amount of work.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** Longest glob or path fragment accepted. */
export const MAX_REPO_GLOB_CHARS = 256;
/** Most `/`-separated segments accepted. */
export const MAX_REPO_GLOB_SEGMENTS = 32;

export type RepoPathCheck = { ok: true; value: string } | { ok: false; reason: string };

/**
 * A repository-relative glob or path fragment, trimmed and with any leading
 * `./` removed; or why it is refused.
 */
export function checkRepoGlob(raw: string): RepoPathCheck {
  let value = raw.trim();
  if (value === "") return { ok: false, reason: "it is empty" };
  if (value.length > MAX_REPO_GLOB_CHARS) {
    return { ok: false, reason: `it is longer than ${MAX_REPO_GLOB_CHARS} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, reason: "it contains a control character" };
  }
  if (value.includes("\\")) {
    return { ok: false, reason: "it contains a backslash; use / between directories" };
  }
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) {
    return { ok: false, reason: "it is absolute; give a path relative to the repository root" };
  }
  while (value.startsWith("./")) value = value.slice(2);
  if (value === "" || value === ".") return { ok: false, reason: "it is empty" };
  const segments = value.split("/");
  if (segments.length > MAX_REPO_GLOB_SEGMENTS) {
    return { ok: false, reason: `it has more than ${MAX_REPO_GLOB_SEGMENTS} path segments` };
  }
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "it contains '..'; paths cannot leave the repository" };
  }
  return { ok: true, value };
}

/** The error a tool returns for a refused glob or path fragment. */
export function repoPathError(tool: string, param: string, reason: string): string {
  return `Error: ${tool} refused "${param}" because ${reason}.`;
}

/**
 * #2327 — what `pathContains` may be: a SUBSTRING of a repository-relative
 * path, so a leading `/` is allowed (`/handlers/` scopes to a directory named
 * `handlers`). A `..` segment, a backslash, `~` or a drive letter is still
 * refused, as is anything past the length and segment bounds.
 */
export function checkRepoPathFragment(raw: string): RepoPathCheck {
  const value = raw.trim();
  if (!value.startsWith("/")) return checkRepoGlob(value);
  const rest = checkRepoGlob(value.replace(/^\/+/, ""));
  if (!rest.ok) return rest;
  // Keep the slash: `/handlers/` must not match `subhandlers/`.
  return { ok: true, value: `/${rest.value}` };
}

/**
 * #2327 — directories never read from chat, matched case-insensitively as any
 * component of a path: git internals and the usual homes of credentials.
 */
const SECRET_DIRS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);
/** Basenames never returned to chat, matched case-insensitively. */
const SECRET_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".htpasswd",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
/** Private keys and keystores, by extension. */
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
/** `.env` templates carry no values, so they stay readable. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/;

/**
 * True when `filePath` names git internals or a credential file: a path
 * component in {@link SECRET_DIRS}; a basename in {@link SECRET_FILES} or
 * with an extension in {@link SECRET_EXTENSIONS}; or `.env` / `.env.*`
 * other than a template. Every chat file tool (`read_file_slice`,
 * `grep_files`, `list_files`) checks it on the path as asked or listed AND
 * on the path it really resolves to ({@link isSensitiveInClone}).
 */
export function isSensitiveRepoPath(filePath: string): boolean {
  const segments = path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .split("/")
    .map((s) => s.toLowerCase());
  if (segments.some((s) => SECRET_DIRS.has(s))) return true;
  const base = segments[segments.length - 1] ?? "";
  if (SECRET_FILES.has(base)) return true;
  if (SECRET_EXTENSIONS.has(path.posix.extname(base))) return true;
  return (base === ".env" || base.startsWith(".env.")) && !ENV_TEMPLATE.test(base);
}

/**
 * #2327 — `relPath` inside `cloneDir` as it really resolves (every symlink
 * followed, directories included), relative to the clone's real root; `null`
 * when it does not exist. A path resolving outside the clone starts `..`.
 */
export async function realRepoPath(cloneDir: string, relPath: string): Promise<string | null> {
  try {
    const [real, root] = await Promise.all([
      fs.realpath(path.resolve(cloneDir, relPath)),
      fs.realpath(cloneDir),
    ]);
    return path.relative(root, real).split(path.sep).join("/");
  } catch {
    return null;
  }
}

/**
 * #2327 — whether a chat tool must refuse `relPath` in `cloneDir`: sensitive
 * as asked, or sensitive where it really resolves (`key.txt -> .ssh/id_rsa`).
 */
export async function isSensitiveInClone(cloneDir: string, relPath: string): Promise<boolean> {
  if (isSensitiveRepoPath(relPath)) return true;
  const real = await realRepoPath(cloneDir, relPath);
  return real !== null && isSensitiveRepoPath(real);
}

/** The reply a chat file tool gives a refused or hidden path (#2243's wording). */
export function notAccessible(filePath: string): string {
  return `Error: File not found or not accessible: ${filePath}`;
}

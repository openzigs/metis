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

/** Basenames never returned to chat, matched case-insensitively. */
const SECRET_FILES = new Set([".netrc", ".npmrc", ".pypirc", ".git-credentials"]);
/** `.env` templates carry no values, so they stay readable. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/;

/** True when `filePath` names git internals or a credential file. */
export function isSensitiveRepoPath(filePath: string): boolean {
  const segments = path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .split("/")
    .map((s) => s.toLowerCase());
  if (segments.includes(".git")) return true;
  const base = segments[segments.length - 1] ?? "";
  if (SECRET_FILES.has(base)) return true;
  return (base === ".env" || base.startsWith(".env.")) && !ENV_TEMPLATE.test(base);
}

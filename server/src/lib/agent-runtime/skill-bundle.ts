/**
 * Epic #129 (#146) — importing an Agent Skills directory.
 *
 * An Agent Skills skill is a DIRECTORY: `SKILL.md` plus supporting files
 * (`references/`, `assets/`, `scripts/`, …) the instructions point at by
 * relative path. METIS stores the supporting files as text in `skill_files`
 * and serves them to the model through `load_skill` by exact path.
 *
 * Supporting files are user-authored input, so every one is bounded and
 * checked here before anything is stored:
 *   • the path must be relative, normalised and at most four levels deep
 *     (`normalizeSkillFilePath`) — no `..`, no absolute paths, no backslashes;
 *   • text only (no NUL bytes), at most {@link MAX_SKILL_FILE_BYTES} each,
 *     {@link MAX_SKILL_FILES} files and {@link MAX_SKILL_BUNDLE_BYTES} in total;
 *   • no credential shapes (`secret-scan.ts`).
 * On IMPORT, a file failing any check but the credential scan is left out and
 * reported instead of failing the skill ({@link triageSkillFiles}).
 * Nothing is ever executed: a `scripts/` file is stored and served as text.
 */
import crypto from "node:crypto";
import { normalizeSkillFilePath } from "./skills.js";
import { findSecretKinds } from "./secret-scan.js";

export const MAX_SKILL_FILE_BYTES = 64 * 1024;
export const MAX_SKILL_FILES = 32;
export const MAX_SKILL_BUNDLE_BYTES = 512 * 1024;

/** A loader's stand-in for a supporting file too large to read (reported, never dropped). */
export const OVERSIZE_FILE_SENTINEL = "\u0000metis:oversize";

export class SkillBundleError extends Error {
  readonly code = "SKILL_BUNDLE_INVALID";
}

export interface SkillFileInput {
  path: string;
  content: string;
}

export interface ValidatedSkillFile {
  path: string;
  content: string;
  sizeBytes: number;
  sha256: string;
}

/** Validate a skill's supporting files; throws {@link SkillBundleError} with a clear reason. */
export function validateSkillFiles(files: readonly SkillFileInput[]): ValidatedSkillFile[] {
  if (files.length > MAX_SKILL_FILES) {
    throw new SkillBundleError(
      `A skill may carry at most ${MAX_SKILL_FILES} supporting files (got ${files.length}).`,
    );
  }
  const out: ValidatedSkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const label = typeof f.path === "string" ? f.path.slice(0, 120) : "(missing path)";
    const path = normalizeSkillFilePath(f.path);
    if (!path) {
      throw new SkillBundleError(
        `Supporting file '${label}': the path must be relative, at most four levels deep, with no '..', '.', backslashes or absolute prefixes.`,
      );
    }
    if (seen.has(path)) throw new SkillBundleError(`Supporting file '${path}' appears twice.`);
    seen.add(path);
    if (f.content === OVERSIZE_FILE_SENTINEL) {
      throw new SkillBundleError(
        `Supporting file '${path}' is larger than ${MAX_SKILL_FILE_BYTES} bytes.`,
      );
    }
    if (typeof f.content !== "string" || f.content.includes("\0")) {
      throw new SkillBundleError(`Supporting file '${path}' is not a text file.`);
    }
    const sizeBytes = Buffer.byteLength(f.content, "utf8");
    if (sizeBytes > MAX_SKILL_FILE_BYTES) {
      throw new SkillBundleError(
        `Supporting file '${path}' is ${sizeBytes} bytes; the limit is ${MAX_SKILL_FILE_BYTES}.`,
      );
    }
    total += sizeBytes;
    if (total > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillBundleError(
        `The skill's supporting files exceed ${MAX_SKILL_BUNDLE_BYTES} bytes in total.`,
      );
    }
    const kinds = findSecretKinds(f.content);
    if (kinds.length > 0) {
      throw new SkillBundleError(
        `Supporting file '${path}' appears to contain a credential (${kinds.join(", ")}). Remove it.`,
      );
    }
    out.push({
      path,
      content: f.content,
      sizeBytes,
      sha256: crypto.createHash("sha256").update(f.content).digest("hex"),
    });
  }
  return out;
}

/** One supporting file an IMPORT left out, and why (reported in the import result). */
export interface SkippedSkillFile {
  path: string;
  reason: string;
}

/** Operating-system metadata that rides along in copied/zipped folders. */
function isOsJunk(path: string): boolean {
  return path
    .split("/")
    .some(
      (seg) =>
        seg === ".DS_Store" ||
        seg === "__MACOSX" ||
        seg === "Thumbs.db" ||
        seg === "desktop.ini" ||
        seg.startsWith("._"),
    );
}

/**
 * Import-time triage of a skill directory's supporting files. An imported
 * folder routinely carries files METIS does not store — an `assets/logo.png`,
 * a `.DS_Store`, an oddly named file, more files than the limit — and none of
 * them makes the skill's `SKILL.md` unusable. So instead of failing the whole
 * skill, each such file is LEFT OUT and reported with its reason, and the rest
 * go through {@link validateSkillFiles} unchanged. Every guard still holds for
 * what is stored: a file that fails the path, text, size, total-size or count
 * check is simply never stored — and a file carrying a CREDENTIAL still fails
 * the whole skill, as before. (Authoring a skill directly through the API stays
 * strict: there, a bad file is the author's error to fix.)
 */
export function triageSkillFiles(files: readonly SkillFileInput[]): {
  accepted: SkillFileInput[];
  skipped: SkippedSkillFile[];
} {
  const accepted: SkillFileInput[] = [];
  const skipped: SkippedSkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const label = typeof f.path === "string" ? f.path.slice(0, 200) : "(missing path)";
    const skip = (reason: string): void => {
      skipped.push({ path: label, reason });
    };
    if (typeof f.path === "string" && isOsJunk(f.path.replace(/\\/g, "/"))) {
      skip("operating-system metadata file");
      continue;
    }
    const path = normalizeSkillFilePath(f.path);
    if (!path) {
      skip(
        "invalid path: it must be relative, at most four levels deep, and use only letters, digits, '.', '_', '-' and spaces",
      );
      continue;
    }
    if (seen.has(path)) {
      skip("duplicate path");
      continue;
    }
    if (f.content === OVERSIZE_FILE_SENTINEL) {
      skip(`larger than ${MAX_SKILL_FILE_BYTES} bytes`);
      continue;
    }
    if (typeof f.content !== "string" || f.content.includes("\0")) {
      skip("not a text file");
      continue;
    }
    const sizeBytes = Buffer.byteLength(f.content, "utf8");
    if (sizeBytes > MAX_SKILL_FILE_BYTES) {
      skip(`larger than ${MAX_SKILL_FILE_BYTES} bytes`);
      continue;
    }
    if (findSecretKinds(f.content).length > 0) {
      // A credential is NOT triaged away: it is passed on so the strict
      // validation refuses the whole skill, loudly — a leaked secret in a
      // skill folder must be noticed and removed, not quietly left behind.
      seen.add(path);
      accepted.push({ path, content: f.content });
      continue;
    }
    if (accepted.length >= MAX_SKILL_FILES) {
      skip(`past the ${MAX_SKILL_FILES}-file limit`);
      continue;
    }
    if (total + sizeBytes > MAX_SKILL_BUNDLE_BYTES) {
      skip(`past the ${MAX_SKILL_BUNDLE_BYTES}-byte total limit`);
      continue;
    }
    seen.add(path);
    total += sizeBytes;
    accepted.push({ path, content: f.content });
  }
  return { accepted, skipped };
}

export interface SkillImportEntry {
  /** The skill source's import path (for error reporting). */
  path: string;
  source: string;
  /** Supporting files, relative to the skill's directory (SKILL.md bundles only). */
  files: SkillFileInput[];
}

const posix = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const isSkillMd = (p: string): boolean => /(^|\/)skill\.md$/i.test(p);
const isSingleSkill = (p: string): boolean => /\.skill\.md$/i.test(p);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Turn a flat list of imported files into skills, in input order:
 *   • each `SKILL.md` is one skill, and claims every other file beneath its
 *     directory as a supporting file (the deepest `SKILL.md` wins, so a nested
 *     skill keeps its own files);
 *   • a `*.skill.md` file is always a single-file skill;
 *   • any other file no `SKILL.md` claims is imported on its own, exactly as
 *     before #146 (a pasted `notes.md` is still a skill source).
 */
export function groupSkillImport(
  files: ReadonlyArray<{ path: string; contents: string }>,
): SkillImportEntry[] {
  const norm = files.map((f) => ({ path: posix(f.path), contents: f.contents }));
  const dirs = norm
    .filter((f) => isSkillMd(f.path))
    .map((f) => dirOf(f.path))
    .sort((a, b) => b.length - a.length);
  const ownerOf = (p: string): string | undefined =>
    dirs.find((d) => d === "" || p.startsWith(`${d}/`));
  const bundles = new Map<string, SkillImportEntry>();
  for (const f of norm) {
    if (isSkillMd(f.path)) {
      const entry: SkillImportEntry = { path: f.path, source: f.contents, files: [] };
      bundles.set(dirOf(f.path), entry);
    }
  }
  const ordered: SkillImportEntry[] = [];
  for (const f of norm) {
    if (isSkillMd(f.path)) {
      ordered.push(bundles.get(dirOf(f.path))!);
      continue;
    }
    const owner = isSingleSkill(f.path) ? undefined : ownerOf(f.path);
    if (owner === undefined) {
      ordered.push({ path: f.path, source: f.contents, files: [] });
      continue;
    }
    bundles.get(owner)!.files.push({
      path: owner === "" ? f.path : f.path.slice(owner.length + 1),
      content: f.contents,
    });
  }
  return ordered;
}

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

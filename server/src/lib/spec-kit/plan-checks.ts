/**
 * #1135 — two checks on a generated plan.md that the result card reports.
 *
 * 1. A plan that calls code it was given "not visible". In #706 run 8 the plan
 *    for Miniflux #4479 had `entry_query_builder.go` in its context and still
 *    wrote that `WithLimit`'s semantics were "not visible", then blamed a
 *    parse-time default. The claim is checked against the files the plan was
 *    given (`plan-context.md`): a named file on that list is flagged, and a
 *    named function only when its SOURCE was shown — a code snippet of it, or
 *    a retrieved source excerpt that declares it. A function the context named
 *    only by a locator or as a caller may honestly be called not visible
 *    (PR #1164 panel): its file is listed, its body is not.
 *
 * 2. A plan that renames a parameter the request states. The J2.4 plan for
 *    #4336 turned the requested `read_at_after` / `read_at_before` into
 *    `read_after` / `read_before` and said nothing. A snake_case name the spec
 *    uses that plan.md never mentions, where plan.md uses a name with the same
 *    first and last part instead, is flagged. A plan that lists the rename
 *    mentions the original name, so it is not flagged.
 *
 * Both read model output and spec text: untrusted, read by linear scans with
 * bounded patterns.
 */
import { prisma } from "../prisma.js";
import { extractReferencedPaths } from "./grounding.js";

/** Longest plan or spec text read. */
const MAX_SCANNED_CHARS = 200_000;

/**
 * A sentence that says the plan could not see something: the phrase is tied to
 * the context or source it was given ("not visible in the retrieved context",
 * "not in the context", "cannot see X in the provided source"). Bare "not
 * shown", "invisible" or "cannot see" are how a UI bug describes its symptom,
 * so they do not count. Bounded alternation, no nested quantifier.
 */
const NOT_VISIBLE_RE =
  /\bnot (?:visible|shown|seen|provided|included|available|present) in the (?:retrieved |provided |given )?(?:context|source)\b|\bnot in the (?:retrieved |provided |given )?context\b|\b(?:cannot|can't|could not) (?:see|find)\b[^.\n]{0,80}\bin the (?:retrieved |provided |given )?(?:context|source)\b/i;

/** Sentences of `text`, split on `.`/`!`/`?` followed by space, or on a line break. */
function sentences(text: string): string[] {
  return text
    .slice(0, MAX_SCANNED_CHARS)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => s.trim().length > 0);
}

/** A backticked code name: `WithLimit`, `store.WithLimit`, `WithLimit()`. */
const CODE_NAME_RE = /^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)(?:\(\))?$/;

/** What the plan was given, as far as the check needs it. */
export interface PlanContextShown {
  /** Every repository file the context names (`plan-context.md`). */
  files: readonly string[];
  /** Functions whose code-graph snippet the context shows. */
  bodies?: ReadonlyArray<{ name: string; filePath: string }>;
  /** Retrieved repository source text, by file. */
  excerpts?: ReadonlyArray<{ filePath: string; text: string }>;
}

/** Longest line of an excerpt read when looking for a declaration. */
const MAX_DECLARATION_LINE = 500;

/** Words that open a statement, never a declared return type. */
const NOT_A_TYPE =
  "(?!(?:return|new|await|throw|else|yield|case|typeof|delete|do|in|of|if|while|for|switch)\\b)";
/** Modifiers that may precede a method in Java, C#, TypeScript or Kotlin. */
const MODIFIERS =
  "(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|sealed|synchronized|async|readonly|open|suspend|inline|get|set)\\s+)*";

/**
 * The declaration shapes of `name`, one pattern per language family. In each,
 * `name` is the identifier being DECLARED: the first one after the keyword
 * (`func`, `def`, `function`, `fn`, `fun`), the one after a single return type
 * (`public List<Entry> name(`, no `=` before it and no `;` after), a method head
 * that ends in `{` (`name(…) {`, `name(…): T {`), or a function bound with
 * `const`. Every pattern is anchored at the line start and holds at most one
 * unbounded class per position, so it is linear in the line.
 */
function declarationPatterns(name: string): RegExp[] {
  const sources = [
    // Go: `func Name(`, `func (r *T) Name(`, `func Name[T any](`.
    `^\\s*func\\s+(?:\\([^()\\n]*\\)\\s*)?${name}\\s*[([]`,
    // Python.
    `^\\s*(?:async\\s+)?def\\s+${name}\\s*\\(`,
    // JavaScript / TypeScript.
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*[(<]`,
    // Rust.
    `^\\s*(?:pub(?:\\([^()\\n]*\\))?\\s+)?(?:(?:async|const|unsafe)\\s+)*fn\\s+${name}\\s*[(<]`,
    // Kotlin.
    `^\\s*${MODIFIERS}fun\\s+(?:<[^<>\\n]*>\\s*)?(?:\\w+\\.)?${name}\\s*[(<]`,
    // Java / C#: modifiers, one return type, the name; no `;` after it.
    `^\\s*${MODIFIERS}(?:<[^<>\\n]*>\\s+)?${NOT_A_TYPE}[\\w.\\[\\]?]+(?:<[^\\n=;]*>)?\\s+${name}\\s*\\([^;\\n]*$`,
    // A TypeScript / JavaScript method head: `name(…) {` or `name(…): T {`.
    `^\\s*${MODIFIERS}${name}\\s*(?:<[^<>\\n]*>)?\\s*\\([^()\\n]*\\)\\s*(?::[^{};=\\n]*)?\\{\\s*$`,
    // A function bound to a name.
    `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]*)?=\\s*(?:async\\s+)?(?:function\\b|\\(|\\w+\\s*=>)`,
  ];
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `name` is a bare identifier (checked by the caller: word characters only), so it adds no metacharacter; each pattern is anchored at the line start and runs on one line of at most MAX_DECLARATION_LINE characters.
  return sources.map((src) => new RegExp(src));
}

/**
 * True when a line of `text` declares the function `name`. A line that only
 * calls it — `name(() => {`, `function h() { return name(1) }`,
 * `private X x = name(3);`, `void name(x);` — never counts (PR #1164 re-review).
 */
export function declaresFunction(text: string, name: string): boolean {
  if (!/^\w{1,120}$/.test(name)) return false;
  const patterns = declarationPatterns(name);
  for (const raw of text.slice(0, MAX_SCANNED_CHARS).split("\n")) {
    if (!raw.includes(name)) continue;
    const line = raw.slice(0, MAX_DECLARATION_LINE);
    if (patterns.some((re) => re.test(line))) return true;
  }
  return false;
}

export interface NotVisibleClaim {
  /** The name or path the plan called not visible. */
  named: string;
  /** The file in the plan's context it is (in). */
  file: string;
}

/** Function names → the files that declare them. Injectable for tests. */
export type SymbolFileLookup = (names: string[]) => Promise<Map<string, string[]>>;

/** The production lookup: the project's code graph, production functions and methods only. */
export function createDefaultSymbolFileLookup(projectId: string): SymbolFileLookup {
  return async (names) => {
    const rows = await prisma.codeSymbol.findMany({
      where: {
        projectId,
        name: { in: names.slice(0, MAX_LOOKED_UP_NAMES) },
        kind: { in: ["function", "method"] },
      },
      select: { name: true, filePath: true },
    });
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.name, [...(out.get(r.name) ?? []), r.filePath]);
    return out;
  };
}

/** Names looked up per plan, at most: a plan names a handful in such sentences. */
export const MAX_LOOKED_UP_NAMES = 50;

/**
 * Every name or path a "not visible" sentence of `plan` backticks that the
 * plan was in fact shown: a path on `context.files`, or a function whose
 * source the context included — a snippet in `context.bodies`, or a source
 * excerpt of a file `lookup` places it in that declares it. A function known
 * only by its locator or as a caller is not flagged.
 */
export async function findNotVisibleClaims(
  plan: string,
  context: PlanContextShown,
  lookup: SymbolFileLookup,
): Promise<NotVisibleClaim[]> {
  const { files: contextFiles, bodies = [], excerpts = [] } = context;
  if (contextFiles.length === 0) return [];
  const inContext = new Set(contextFiles);
  const claimedPaths: string[] = [];
  const claimedNames: string[] = [];
  for (const sentence of sentences(plan)) {
    if (!NOT_VISIBLE_RE.test(sentence)) continue;
    claimedPaths.push(...extractReferencedPaths(sentence));
    for (const m of sentence.matchAll(/`([^`\n]{1,120})`/g)) {
      const id = CODE_NAME_RE.exec(m[1]!.trim());
      if (id) claimedNames.push(id[1]!);
    }
  }
  const out: NotVisibleClaim[] = [];
  const seen = new Set<string>();
  for (const p of claimedPaths) {
    if (inContext.has(p) && !seen.has(p)) {
      seen.add(p);
      out.push({ named: p, file: p });
    }
  }
  const names = [...new Set(claimedNames)].filter((n) => !seen.has(n));
  if (names.length === 0) return out;
  const shownBody = new Map<string, string>();
  for (const b of bodies) if (!shownBody.has(b.name)) shownBody.set(b.name, b.filePath);
  const unresolved = names.filter((n) => !shownBody.has(n));
  const files = unresolved.length > 0 && excerpts.length > 0 ? await lookup(unresolved) : new Map();
  for (const name of names) {
    const file =
      shownBody.get(name) ??
      (files.get(name) ?? []).find((f: string) =>
        excerpts.some((e) => e.filePath === f && declaresFunction(e.text, name)),
      );
    if (file) {
      seen.add(name);
      out.push({ named: name, file });
    }
  }
  return out;
}

/** `recordedIn`: the artifact the context is recorded in, or null when none is kept. */
export function describeNotVisibleClaims(
  claims: readonly NotVisibleClaim[],
  recordedIn: string | null,
): string {
  if (claims.length === 0) return "";
  const list = claims
    .map((c) => (c.named === c.file ? `\`${c.file}\`` : `\`${c.named}\` (in \`${c.file}\`)`))
    .join(", ");
  return ` Check: plan.md says it could not see ${list}, but ${claims.length === 1 ? "that file was" : "those files were"} in the plan's context${recordedIn ? ` (\`${recordedIn}\`)` : ""} — read ${claims.length === 1 ? "it" : "them"} before trusting what the plan says about ${claims.length === 1 ? "it" : "them"}.`;
}

/** snake_case with at least two parts: `read_at_after`. Never a whole path. */
const SNAKE_RE = /(?<![\w./-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w/-]|\.[A-Za-z])/g;

function snakeNames(text: string): Set<string> {
  return new Set(text.slice(0, MAX_SCANNED_CHARS).match(SNAKE_RE) ?? []);
}

export interface ParameterRename {
  /** The name the request states. */
  stated: string;
  /** The names plan.md uses in its place. */
  usedInstead: string[];
}

/**
 * snake_case names `spec` states that `plan` never mentions, each with the
 * names `plan` uses that share its first and last part and drop a part
 * (`read_at_after` → `read_after`; `user_id` → `user_feed_id` is not a rename). A stated name with no such stand-in is not reported: the plan
 * may simply not need it.
 */
export function findParameterRenames(spec: string, plan: string): ParameterRename[] {
  const stated = snakeNames(spec);
  const used = snakeNames(plan);
  const out: ParameterRename[] = [];
  for (const name of stated) {
    if (used.has(name)) continue;
    const parts = name.split("_");
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    const instead = [...used].filter((u) => {
      if (stated.has(u)) return false;
      const p = u.split("_");
      return p.length < parts.length && p[0] === first && p[p.length - 1] === last;
    });
    if (instead.length > 0) out.push({ stated: name, usedInstead: instead.sort() });
  }
  return out.sort((a, b) => a.stated.localeCompare(b.stated));
}

export function describeParameterRenames(renames: readonly ParameterRename[]): string {
  if (renames.length === 0) return "";
  const list = renames
    .map((r) => `\`${r.stated}\` → ${r.usedInstead.map((u) => `\`${u}\``).join(" / ")}`)
    .join(", ");
  return ` Check: plan.md renames ${renames.length === 1 ? "a name" : "names"} the spec states (${list}) without saying why — keep the spec's name or record the rename and its reason.`;
}

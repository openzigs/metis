/**
 * #1135 — two checks on a generated plan.md that the result card reports.
 *
 * 1. A plan that calls code it was given "not visible". In #706 run 8 the plan
 *    for Miniflux #4479 had `entry_query_builder.go` in its context and still
 *    wrote that `WithLimit`'s semantics were "not visible", then blamed a
 *    parse-time default. The claim is checked against the files the plan was
 *    given (`plan-context.md`): a named file on that list, or a named function
 *    declared in one, is flagged.
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
 * A sentence that says the plan could not see something: "not visible",
 * "not shown", "not in the retrieved context", "not provided/included in the
 * context", "cannot see". Bounded alternation, no nested quantifier.
 */
const NOT_VISIBLE_RE =
  /\bnot (?:visible|shown|in the (?:retrieved )?context|(?:provided|included|available|present) in the (?:retrieved )?context)\b|\bcannot (?:see|be seen)\b|\binvisible\b/i;

/** Sentences of `text`, split on `.`/`!`/`?` followed by space, or on a line break. */
function sentences(text: string): string[] {
  return text
    .slice(0, MAX_SCANNED_CHARS)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => s.trim().length > 0);
}

/** A backticked code name: `WithLimit`, `store.WithLimit`, `WithLimit()`. */
const CODE_NAME_RE = /^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)(?:\(\))?$/;

export interface NotVisibleClaim {
  /** The name or path the plan called not visible. */
  named: string;
  /** The file in the plan's context it is (in). */
  file: string;
}

/** Function names → the files that declare them. Injectable for tests. */
export type SymbolFileLookup = (names: string[]) => Promise<Map<string, string[]>>;

/**
 * Every name or path a "not visible" sentence of `plan` backticks that was in
 * fact in `contextFiles`: the path itself, or a function `lookup` places in
 * one of them.
 */
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

export async function findNotVisibleClaims(
  plan: string,
  contextFiles: readonly string[],
  lookup: SymbolFileLookup,
): Promise<NotVisibleClaim[]> {
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
  const names = [...new Set(claimedNames)];
  if (names.length === 0) return out;
  const files = await lookup(names);
  for (const name of names) {
    const file = (files.get(name) ?? []).find((f) => inContext.has(f));
    if (file && !seen.has(name)) {
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
 * names `plan` uses that share its first and last part (`read_at_after` →
 * `read_after`). A stated name with no such stand-in is not reported: the plan
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
      return p[0] === first && p[p.length - 1] === last;
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

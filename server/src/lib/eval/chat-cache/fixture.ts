/**
 * #1845 — the chat-cache replay set: analyst questions over a materialized eval
 * project (#1799), the pairs that label how two of them relate, and the
 * synthetic patch the second pass is run after.
 *
 * Pair labels:
 *   - `paraphrase` — two wordings of one question; they should share an answer.
 *   - `near-miss`  — close wording, a different question; a cache must not
 *                    serve one's answer for the other.
 *   - `repeat`     — the same question after normalisation (case, spacing):
 *                    what the semantic cache's exact path catches.
 *
 * The patch is a list of Go function MOVES applied by code to the clone, so the
 * fixture stores the names of what moves rather than the third-party source.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeQuery } from "../../ai/semantic-cache.js";

export const PAIR_LABELS = ["paraphrase", "near-miss", "repeat"] as const;
export type PairLabel = (typeof PAIR_LABELS)[number];

export interface ChatCacheQuestion {
  id: string;
  text: string;
}

export interface ChatCachePair {
  a: string;
  b: string;
  label: PairLabel;
}

export interface ChatCacheFixture {
  id: string;
  project: { corpus: string; repo: string };
  questions: ChatCacheQuestion[];
  pairs: ChatCachePair[];
}

export interface FunctionMove {
  from: string;
  to: string;
  /** The new file's text before the moved functions (package clause, imports). */
  header: string;
  functions: string[];
}

export interface ChatCachePatch {
  id: string;
  commit: { message: string; authorName: string; authorEmail: string; date: string };
  moves: FunctionMove[];
}

const REPO_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/;
const GO_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(msg: string): never {
  throw new Error(`chat-cache fixture: ${msg}`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown, where: string): string => {
  if (typeof v !== "string" || v.trim() === "") fail(`${where} must be a non-empty string`);
  return v;
};

/** Parse and check a questions file. Every rule here is one a bad edit could break. */
export function parseChatCacheFixture(raw: unknown): ChatCacheFixture {
  if (!isObject(raw)) fail("not an object");
  const id = str(raw.id, "id");
  if (!isObject(raw.project)) fail("project missing");
  const project = {
    corpus: str(raw.project.corpus, "project.corpus"),
    repo: str(raw.project.repo, "project.repo"),
  };
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) fail("no questions");
  const questions: ChatCacheQuestion[] = raw.questions.map((q, i) => {
    if (!isObject(q)) fail(`questions[${i}] is not an object`);
    return { id: str(q.id, `questions[${i}].id`), text: str(q.text, `questions[${i}].text`) };
  });
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) fail(`duplicate question id ${q.id}`);
    ids.add(q.id);
  }
  const byId = new Map(questions.map((q) => [q.id, q]));
  if (!Array.isArray(raw.pairs)) fail("pairs missing");
  const seen = new Set<string>();
  const pairs: ChatCachePair[] = raw.pairs.map((p, i) => {
    if (!isObject(p)) fail(`pairs[${i}] is not an object`);
    const a = str(p.a, `pairs[${i}].a`);
    const b = str(p.b, `pairs[${i}].b`);
    const label = p.label as PairLabel;
    if (!PAIR_LABELS.includes(label)) fail(`pairs[${i}] has unknown label ${String(p.label)}`);
    if (!byId.has(a) || !byId.has(b)) fail(`pairs[${i}] names an unknown question`);
    if (a === b) fail(`pairs[${i}] pairs ${a} with itself`);
    const key = [a, b].sort().join("|");
    if (seen.has(key)) fail(`pairs[${i}] repeats the pair ${key}`);
    seen.add(key);
    const same = normalizeQuery(byId.get(a)!.text) === normalizeQuery(byId.get(b)!.text);
    // A repeat must reach the exact path; anything else must not, or it is a repeat.
    if (label === "repeat" && !same) fail(`pairs[${i}] is labelled repeat but normalises apart`);
    if (label !== "repeat" && same) fail(`pairs[${i}] normalises equal but is labelled ${label}`);
    return { a, b, label };
  });
  for (const label of PAIR_LABELS) {
    if (!pairs.some((p) => p.label === label)) fail(`no ${label} pair`);
  }
  return { id, project, questions, pairs };
}

/** Parse and check a patch file. */
export function parseChatCachePatch(raw: unknown): ChatCachePatch {
  if (!isObject(raw)) fail("patch is not an object");
  if (!isObject(raw.commit)) fail("patch.commit missing");
  const date = str(raw.commit.date, "patch.commit.date");
  if (Number.isNaN(Date.parse(date))) fail("patch.commit.date is not a date");
  if (!Array.isArray(raw.moves) || raw.moves.length === 0) fail("patch has no moves");
  const moves = raw.moves.map((m, i): FunctionMove => {
    if (!isObject(m)) fail(`moves[${i}] is not an object`);
    const from = str(m.from, `moves[${i}].from`);
    const to = str(m.to, `moves[${i}].to`);
    // The paths are joined onto the clone directory: never absolute, never `..`.
    for (const p of [from, to]) {
      if (!REPO_PATH.test(p)) fail(`moves[${i}] path ${p} is not a plain repository path`);
    }
    if (!Array.isArray(m.functions) || m.functions.length === 0) {
      fail(`moves[${i}] moves no functions`);
    }
    const functions = m.functions.map((f, j) => {
      const name = str(f, `moves[${i}].functions[${j}]`);
      if (!GO_IDENT.test(name)) fail(`moves[${i}].functions[${j}] is not a Go identifier`);
      return name;
    });
    return { from, to, header: str(m.header, `moves[${i}].header`), functions };
  });
  return {
    id: str(raw.id, "patch.id"),
    commit: {
      message: str(raw.commit.message, "patch.commit.message"),
      authorName: str(raw.commit.authorName, "patch.commit.authorName"),
      authorEmail: str(raw.commit.authorEmail, "patch.commit.authorEmail"),
      date,
    },
    moves,
  };
}

/** The committed fixture directory for `id` (`eval-data/corpus/<id>`). */
export function chatCacheCorpusDir(repoRoot: string, id: string): string {
  return path.join(repoRoot, "eval-data", "corpus", id);
}

export async function loadChatCacheFixture(
  dir: string,
): Promise<{ fixture: ChatCacheFixture; patch: ChatCachePatch }> {
  const read = async (name: string): Promise<unknown> =>
    JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as unknown;
  return {
    fixture: parseChatCacheFixture(await read("questions.json")),
    patch: parseChatCachePatch(await read("patch.json")),
  };
}

/** The label of the pair `a`–`b` (either order), if they are paired. */
export function pairLabel(
  pairs: readonly ChatCachePair[],
  a: string,
  b: string,
): PairLabel | undefined {
  return pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.label;
}

/**
 * Cut the named top-level Go functions out of `source`, each with the comment
 * lines directly above it. A function runs from its `func name(` line to the
 * first line that is exactly `}` (or is that one line, for a one-line body).
 * Every name must occur exactly once.
 */
export function extractGoFunctions(
  source: string,
  names: readonly string[],
): { remaining: string; extracted: string[] } {
  let lines = source.split("\n");
  const extracted: string[] = [];
  for (const name of names) {
    const starts = lines.flatMap((l, i) =>
      l.startsWith(`func ${name}(`) || l.startsWith(`func ${name}[`) ? [i] : [],
    );
    if (starts.length !== 1) {
      fail(`function ${name} found ${starts.length} times, expected exactly once`);
    }
    let start = starts[0];
    // gofmt closes a top-level function with `}` alone at column 0, or on its
    // own line for a one-line body (`func f() {}`).
    const end = lines[start].endsWith("}")
      ? start
      : lines.findIndex((l, i) => i > start && l === "}");
    if (end < 0) fail(`function ${name} has no closing brace`);
    while (start > 0 && lines[start - 1].startsWith("//")) start--;
    extracted.push(lines.slice(start, end + 1).join("\n"));
    // Drop the function and one blank line that separated it from the next.
    const after = lines[end + 1] === "" ? end + 2 : end + 1;
    lines = [...lines.slice(0, start), ...lines.slice(after)];
  }
  return { remaining: lines.join("\n"), extracted };
}

/**
 * File contents after the patch: every touched path and its new text. `read`
 * returns `null` for a file that does not exist; a move never overwrites one
 * that does.
 */
export function applyFunctionMoves(
  moves: readonly FunctionMove[],
  read: (repoPath: string) => string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  const current = (p: string): string => {
    const text = out.get(p) ?? read(p);
    if (text === null) fail(`${p} does not exist`);
    return text;
  };
  for (const move of moves) {
    if (out.has(move.to) || read(move.to) !== null) fail(`${move.to} already exists`);
    const { remaining, extracted } = extractGoFunctions(current(move.from), move.functions);
    out.set(move.from, remaining);
    out.set(move.to, `${move.header}\n${extracted.join("\n\n")}\n`);
  }
  return out;
}

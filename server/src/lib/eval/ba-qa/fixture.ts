/**
 * #2237 — the business-analyst question set (Phase 0 of #2228): questions over
 * a two-product sample, each with what a good answer does.
 *
 *   - `single-product` / `multi-product` questions expect an ANSWER: they carry
 *     the facts a correct answer states and the sources (code and documents)
 *     that support them, per product;
 *   - `ambiguous` questions expect a FOLLOW-UP question back;
 *   - `unanswerable` questions expect an ABSTENTION ("the sources don't show this").
 *
 * The category fixes the expected behaviour, and the loader refuses a file in
 * which they disagree: a question filed as ambiguous but scored as an answer
 * would measure nothing.
 *
 * #2269 — a MULTI-TURN question carries `before`, the analyst's earlier turns in
 * the same chat, asked and answered live before `text`, which is the turn
 * scored. `refersBack` labels whether `text` leans on those turns ("How often
 * does that run?") or is a self-contained control asked mid-conversation; the
 * follow-up heuristic of #2240 is measured against it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertCommitSha, parseGithubRepoUrl } from "../localization/materialize.js";

/** The committed question set (`eval-data/corpus/baqa-01-acme-reader/`). */
export const BAQA_CORPUS = "baqa-01-acme-reader";

export const QUESTION_CATEGORIES = [
  "single-product",
  "multi-product",
  "ambiguous",
  "unanswerable",
] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export const BEHAVIOURS = ["answer", "follow-up", "abstain"] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/** What each category's questions must expect. */
export const EXPECTED_BEHAVIOUR: Record<QuestionCategory, Behaviour> = {
  "single-product": "answer",
  "multi-product": "answer",
  ambiguous: "follow-up",
  unanswerable: "abstain",
};

/** A repository- or corpus-relative path: no absolute path, no `..`. */
const RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

const documentSchema = z.strictObject({
  /** The repository path, or with `fromCorpus` the file beside `questions.json`. */
  file: z.string().regex(RELATIVE_PATH),
  /** The filename the document is uploaded to the product's project under. */
  uploadAs: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  fromCorpus: z.boolean().optional(),
});

const productSchema = z.strictObject({
  name: z.string().regex(NAME),
  title: z.string().min(1),
  url: z.string().min(1),
  ref: z.string().min(1),
  sha: z.string(),
  documents: z.array(documentSchema),
});

const sourceSchema = z.strictObject({
  product: z.string(),
  path: z.string().regex(RELATIVE_PATH),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  kind: z.enum(["code", "doc"]).optional(),
});

const factSchema = z.strictObject({ id: z.string().min(1), text: z.string().min(1) });

const questionSchema = z.strictObject({
  id: z.string().regex(/^[A-Z][0-9]+$/),
  category: z.enum(QUESTION_CATEGORIES),
  scope: z.array(z.string()).min(1),
  text: z.string().min(1),
  expect: z.enum(BEHAVIOURS),
  facts: z.array(factSchema).optional(),
  sources: z.array(sourceSchema).optional(),
  why: z.string().min(1).optional(),
  before: z.array(z.string().min(1)).min(1).max(3).optional(),
  refersBack: z.boolean().optional(),
});

const fixtureSchema = z.strictObject({
  id: z.string().regex(NAME),
  version: z.literal(1),
  issue: z.number().int(),
  description: z.string().min(1),
  license: z.string().min(1),
  authoredBy: z.string().min(1),
  products: z.array(productSchema).min(1),
  questions: z.array(questionSchema).min(1),
});

export type BaQaFixture = z.infer<typeof fixtureSchema>;
export type BaQaProduct = BaQaFixture["products"][number];
export type BaQaQuestion = BaQaFixture["questions"][number];
export type BaQaSource = NonNullable<BaQaQuestion["sources"]>[number];
export type BaQaFact = NonNullable<BaQaQuestion["facts"]>[number];

function fail(msg: string): never {
  throw new Error(`ba-qa fixture: ${msg}`);
}

/** Parse and check a questions file: the schema, then every cross-reference in it. */
export function parseBaQaFixture(raw: unknown): BaQaFixture {
  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) fail(z.prettifyError(parsed.error));
  const fixture = parsed.data;

  const products = new Set<string>();
  for (const p of fixture.products) {
    if (products.has(p.name)) fail(`product ${p.name} is listed twice`);
    products.add(p.name);
    parseGithubRepoUrl(p.url);
    assertCommitSha(p.sha);
    const uploads = new Set<string>();
    for (const d of p.documents) {
      if (uploads.has(d.uploadAs)) fail(`${p.name} uploads two documents as ${d.uploadAs}`);
      uploads.add(d.uploadAs);
    }
  }

  const ids = new Set<string>();
  for (const q of fixture.questions) {
    if (ids.has(q.id)) fail(`question ${q.id} is listed twice`);
    ids.add(q.id);
    for (const s of q.scope) {
      if (!products.has(s)) fail(`${q.id} is scoped to unknown product ${s}`);
    }
    if (new Set(q.scope).size !== q.scope.length) fail(`${q.id} names a product twice`);
    if (q.before && q.refersBack === undefined) {
      fail(`${q.id} has earlier turns but no refersBack`);
    }
    if (!q.before && q.refersBack !== undefined) {
      fail(`${q.id} has refersBack but no earlier turns`);
    }
    if (q.expect !== EXPECTED_BEHAVIOUR[q.category]) {
      fail(`${q.id} is ${q.category} but expects ${q.expect}`);
    }
    if (q.category === "single-product" && q.scope.length !== 1) {
      fail(`${q.id} is single-product but scoped to ${q.scope.length} products`);
    }
    if (q.category === "multi-product" && q.scope.length < 2) {
      fail(`${q.id} is multi-product but scoped to one product`);
    }
    if (q.expect === "answer") {
      if (!q.facts?.length) fail(`${q.id} expects an answer but lists no facts`);
      if (!q.sources?.length) fail(`${q.id} expects an answer but lists no sources`);
      const factIds = new Set<string>();
      for (const f of q.facts) {
        if (!f.id.startsWith(`${q.id}.`)) fail(`fact ${f.id} does not belong to ${q.id}`);
        if (factIds.has(f.id)) fail(`fact ${f.id} is listed twice`);
        factIds.add(f.id);
      }
      for (const s of q.sources) {
        if (!q.scope.includes(s.product)) {
          fail(`${q.id} cites ${s.product}, which is outside its scope`);
        }
        if (s.lines && s.lines[0] > s.lines[1]) fail(`${q.id} cites ${s.path} backwards`);
      }
    } else {
      if (q.facts?.length || q.sources?.length) {
        fail(`${q.id} expects ${q.expect}: it carries no facts or sources`);
      }
      if (!q.why) fail(`${q.id} expects ${q.expect} but does not say why`);
    }
  }
  return fixture;
}

/** #2269 — a question asked after earlier turns in the same chat. */
export function isMultiTurn(q: BaQaQuestion): boolean {
  return (q.before?.length ?? 0) > 0;
}

/** `<repo root>/eval-data/corpus/<id>`. */
export function baQaCorpusDir(repoRoot: string, id: string): string {
  if (!NAME.test(id)) fail(`bad corpus id ${id}`);
  return path.join(repoRoot, "eval-data", "corpus", id);
}

export async function loadBaQaFixture(dir: string): Promise<BaQaFixture> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, "questions.json"), "utf8")) as unknown;
  return parseBaQaFixture(raw);
}

/** `<product>:<path>`, the key a source and a citation are compared by. */
export function sourceKey(product: string, file: string): string {
  return `${product}:${file}`;
}

/**
 * The code files the materialized graph must hold (`<product>:<path>`): every
 * expected source that is not a document. `eval:materialize` checks these.
 */
export function requiredCodeFiles(fixture: BaQaFixture): string[] {
  const out = new Set<string>();
  for (const q of fixture.questions) {
    for (const s of q.sources ?? []) {
      if (s.kind !== "doc") out.add(sourceKey(s.product, s.path));
    }
  }
  return [...out].sort();
}

/** The distinct expected source files of one question, as `<product>:<path>`. */
export function expectedSourceFiles(q: BaQaQuestion): string[] {
  return [...new Set((q.sources ?? []).map((s) => sourceKey(s.product, s.path)))].sort();
}

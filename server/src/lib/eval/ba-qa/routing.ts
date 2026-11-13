/**
 * #2336 Part A — should multi-product chat route a question to the likely
 * projects before searching? Measured before anything is built.
 *
 * Multi-product chat (#2238) searches every project in scope on every turn.
 * This module holds the testable half of the measurement:
 *
 *   - the routing set (`routing.json` beside `questions.json`): a pool of
 *     products, each with the curated description, tags and names a project
 *     admin would write, and questions labelled with the products that hold
 *     the answer ({@link parseRoutingFixture});
 *   - an OFFLINE router ({@link routeProjects}) that ranks projects from
 *     profile signals (names, description, tags) and evidence signals (a probe
 *     search's hits), counting only KEYWORD-backed hits as evidence: a dense
 *     search returns neighbours even for gibberish, so a floor on vector scores
 *     never trips;
 *   - the scores: is the right project in the router's top k (k = 1, 2, 3), and
 *     what search-all, the router and an oracle that searches exactly the
 *     answer's projects put in the prompt, at each scope size.
 *
 * Nothing here is wired into chat. The router is the candidate Part B would
 * build, scored on the routing set; whether Part B is built at all is decided
 * on these numbers (`eval-data/README.md`, "Routing multi-product chat").
 */
import { z } from "zod";
import { expectedSourceFiles, type BaQaFixture } from "./fixture.js";

// ─── The routing set ───────────────────────────────────────────────────────

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A repository-relative path: no absolute path, no `..`. */
const RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/;

const sourceSchema = z.discriminatedUnion("kind", [
  /** A product of `questions.json`: materialized by `eval:materialize baqa-01-acme-reader`. */
  z.strictObject({ kind: z.literal("baqa") }),
  /** A repository of another materialized corpus. */
  z.strictObject({
    kind: z.literal("materialized"),
    corpus: z.string().regex(NAME),
    repo: z.string().regex(NAME),
  }),
  /** A documents-only project: these files, uploaded. */
  z.strictObject({
    kind: z.literal("documents"),
    files: z
      .array(
        z.strictObject({
          file: z.string().regex(RELATIVE_PATH),
          uploadAs: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
        }),
      )
      .min(1),
  }),
]);

const productSchema = z.strictObject({
  name: z.string().regex(NAME),
  title: z.string().min(1).max(120),
  /** Names an analyst calls the product by; an occurrence in a question is a mention. */
  aliases: z.array(z.string().min(2).max(80)).max(10),
  /** The curated one-liner; may be empty, and then contributes no profile signal. */
  description: z.string().max(240),
  tags: z.array(z.string().min(1).max(40)).max(12),
  source: sourceSchema,
});

const questionSchema = z.strictObject({
  id: z.string().regex(/^R[0-9]+$/),
  /** An answerable question of `questions.json`: its text and answer products come from there. */
  from: z.string().optional(),
  text: z.string().min(1).optional(),
  /** The products that hold the answer; empty for a question no product answers. */
  answerIn: z.array(z.string()).optional(),
});

const fixtureSchema = z.strictObject({
  id: z.string().regex(NAME),
  version: z.literal(1),
  issue: z.number().int(),
  description: z.string().min(1),
  license: z.string().min(1),
  authoredBy: z.string().min(1),
  products: z.array(productSchema).min(2),
  /** Scopes measured: the first `n` products of the pool, for each `n`. */
  scopeSizes: z.array(z.number().int().min(2)).min(1),
  questions: z.array(questionSchema).min(1),
});

export type RoutingProduct = z.infer<typeof productSchema>;

/** A routing question with its text and answer products resolved. */
export interface RoutingQuestion {
  id: string;
  text: string;
  /** Products that hold the answer, in pool order; empty: none does. */
  answerIn: string[];
  /** The `questions.json` question it was taken from. */
  from?: string;
  /** `<product>:<path>` files a correct answer cites; empty for a routing-only question. */
  expectedFiles: string[];
}

export interface RoutingFixture {
  id: string;
  version: 1;
  products: RoutingProduct[];
  scopeSizes: number[];
  questions: RoutingQuestion[];
}

function fail(msg: string): never {
  throw new Error(`routing fixture: ${msg}`);
}

/**
 * Parse `routing.json` against the question set it extends. A `from` question
 * must be an answerable one of `baqa`, and its answer products are those its
 * expected sources name; every other question carries its own `text` and
 * `answerIn`. The pool must start with `baqa`'s products, so every scope holds
 * them and a `from` question is always answerable in it.
 */
export function parseRoutingFixture(raw: unknown, baqa: BaQaFixture): RoutingFixture {
  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) fail(z.prettifyError(parsed.error));
  const f = parsed.data;

  const order = new Map<string, number>();
  for (const [i, p] of f.products.entries()) {
    if (order.has(p.name)) fail(`product ${p.name} is listed twice`);
    order.set(p.name, i);
  }
  const baqaNames = baqa.products.map((p) => p.name);
  for (const [i, name] of baqaNames.entries()) {
    const p = f.products[i];
    if (p?.name !== name || p.source.kind !== "baqa") {
      fail(`the pool must start with the question set's products (${baqaNames.join(", ")})`);
    }
  }
  for (const p of f.products.slice(baqaNames.length)) {
    if (p.source.kind === "baqa") fail(`${p.name} is not a product of the question set`);
  }
  let last = 0;
  for (const n of f.scopeSizes) {
    if (n <= last) fail("scopeSizes must increase");
    if (n > f.products.length) fail(`scope size ${n} is larger than the pool`);
    last = n;
  }

  const ids = new Set<string>();
  const questions: RoutingQuestion[] = f.questions.map((q) => {
    if (ids.has(q.id)) fail(`question ${q.id} is listed twice`);
    ids.add(q.id);
    if (q.from !== undefined) {
      if (q.text !== undefined || q.answerIn !== undefined) {
        fail(`${q.id} is taken from ${q.from}: it carries no text or answerIn of its own`);
      }
      const src = baqa.questions.find((x) => x.id === q.from);
      if (!src) fail(`${q.id} is taken from unknown question ${q.from}`);
      if (src.expect !== "answer") fail(`${q.id} is taken from ${q.from}, which expects no answer`);
      const answerIn = [...new Set((src.sources ?? []).map((s) => s.product))];
      return {
        id: q.id,
        from: q.from,
        text: src.text,
        answerIn: answerIn.sort((a, b) => order.get(a)! - order.get(b)!),
        expectedFiles: expectedSourceFiles(src),
      };
    }
    if (q.text === undefined || q.answerIn === undefined) {
      fail(`${q.id} needs either from, or text and answerIn`);
    }
    for (const name of q.answerIn) {
      if (!order.has(name)) fail(`${q.id} is answered in unknown product ${name}`);
    }
    if (new Set(q.answerIn).size !== q.answerIn.length) fail(`${q.id} names a product twice`);
    return {
      id: q.id,
      text: q.text,
      answerIn: [...q.answerIn].sort((a, b) => order.get(a)! - order.get(b)!),
      expectedFiles: [],
    };
  });
  return {
    id: f.id,
    version: f.version,
    products: f.products,
    scopeSizes: f.scopeSizes,
    questions,
  };
}

/** The products of a scope of `size`: the first `size` of the pool. */
export function scopeOf(fixture: RoutingFixture, size: number): RoutingProduct[] {
  return fixture.products.slice(0, size);
}

/** Whether every product holding `q`'s answer is in `scope` (a no-answer question always is). */
export function answerableIn(q: RoutingQuestion, scope: readonly { name: string }[]): boolean {
  const names = new Set(scope.map((p) => p.name));
  return q.answerIn.every((n) => names.has(n));
}

// ─── The offline router ────────────────────────────────────────────────────

/**
 * Question words and filler that say nothing about which product a question is
 * about. Kept beside the router: the knowledge search's own list
 * (`bm25-index.ts`) is shorter on purpose, for code identifiers.
 */
const STOP_WORDS = new Set(
  (
    "a an and any are as at be by can could did do does each for from get gets has have how " +
    "i if in into is it its may me might must my not of on once or our should so than that " +
    "the their them then there these they this those to two us was we what when where which " +
    "who whom why will with would you your about after again all also before both does doing " +
    "just make only other over same some such too very"
  ).split(" "),
);

/** Lower-cased content words of `text`, a plural `s` dropped. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    let t = raw;
    if (t.length > 4 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
    else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    out.add(t);
  }
  return out;
}

function phrase(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/** Whether `query` names the product: its name, title or an alias, as whole words. */
export function mentions(
  query: string,
  p: Pick<RoutingProduct, "name" | "title" | "aliases">,
): boolean {
  const q = phrase(query);
  return [p.name, p.title, ...p.aliases].some((n) => {
    const needle = phrase(n);
    return needle.trim().length > 0 && q.includes(needle);
  });
}

/** What a cheap probe search over one project found. */
export interface ProbeEvidence {
  /** Hits returned. */
  hits: number;
  /** Of them, hits the keyword (BM25) retriever matched: the only ones counted as evidence. */
  keyword: number;
  /** The question's content words ({@link contentTokens}) found in those keyword-backed hits. */
  terms: readonly string[];
}

/**
 * One project's probe evidence from its search hits: only a hit the keyword
 * (BM25) retriever matched counts, and only the question's content words it
 * holds. A dense-only hit counts nothing, however close its vector.
 */
export function evidenceFromHits(
  question: string,
  hits: readonly { text: string; matchedBy?: readonly string[] }[],
): ProbeEvidence {
  const words = contentTokens(question);
  const keyword = hits.filter((h) => h.matchedBy?.includes("lexical"));
  const found = new Set<string>();
  for (const h of keyword) {
    for (const t of contentTokens(h.text)) if (words.has(t)) found.add(t);
  }
  return { hits: hits.length, keyword: keyword.length, terms: [...found].sort() };
}

/**
 * Each project's evidence, 0..1: the share of the question's content words its
 * keyword-backed probe hits hold, each word weighted by how few projects in
 * scope hold it (`ln(1 + projects / projects holding it)`). Words no project
 * holds are left out, so the best project can reach 1. A word every project
 * holds (a large document matches most words) counts least. Dense-only hits
 * never count: a vector search returns neighbours for any text, gibberish too.
 */
export function evidenceScores(
  names: readonly string[],
  evidence: ReadonlyMap<string, ProbeEvidence>,
): Map<string, number> {
  const df = new Map<string, number>();
  for (const n of names) {
    for (const t of new Set(evidence.get(n)?.terms ?? [])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const weight = (t: string) => Math.log(1 + names.length / df.get(t)!);
  let total = 0;
  for (const t of df.keys()) total += weight(t);
  const out = new Map<string, number>();
  for (const n of names) {
    let got = 0;
    for (const t of new Set(evidence.get(n)?.terms ?? [])) got += weight(t);
    out.set(n, total > 0 ? got / total : 0);
  }
  return out;
}

export interface RoutingOptions {
  /** Hits each probe search asks for. */
  probeK: number;
  /** Below this best score, with no product named, the router falls back. */
  floor: number;
  /** A project is chosen when its score is at least this share of the best. */
  keepRatio: number;
}

/** First cuts, measured on the routing set (`eval-data/README.md`). */
export const DEFAULT_ROUTING_OPTIONS: RoutingOptions = { probeK: 8, floor: 0.25, keepRatio: 0.5 };

export interface RankedProject {
  name: string;
  /** Share of the question's content words found in the profile, 0..1. */
  profile: number;
  /** {@link evidenceScores}: the question's words its keyword-backed probe hits hold, 0..1. */
  evidence: number;
  score: number;
  mentioned: boolean;
}

export type FallbackReason = "no-evidence" | "low-confidence" | "signals-disagree";

export interface RouteDecision {
  /** Every project in scope: named ones first, then by score, ties in scope order. */
  ranked: RankedProject[];
  route: "routed" | "fallback";
  /** Why the router fell back; absent when it routed. */
  reason?: FallbackReason;
  /** The projects to search: the routed subset, or the whole scope on a fallback. */
  chosen: string[];
}

function argmaxNames(ranked: readonly RankedProject[], f: (r: RankedProject) => number): string[] {
  const best = Math.max(...ranked.map(f));
  return best > 0 ? ranked.filter((r) => f(r) === best).map((r) => r.name) : [];
}

/**
 * Rank the projects in scope for `query` and pick the ones to search.
 *
 * A project's score is the mean of its profile signal (the share of the
 * question's content words its title, names, description and tags hold) and
 * its evidence signal ({@link evidenceScores}: keyword-backed hits only).
 * A product the question names is always chosen. The router falls back to the
 * whole scope when no project has keyword evidence and none is named
 * (`no-evidence`: a gibberish question), when the best score is below the
 * floor (`low-confidence`), or when the profile and the evidence each point at
 * a different project (`signals-disagree`). It only narrows: `chosen` is a
 * subset of `profiles`, in scope order.
 */
export function routeProjects(
  query: string,
  profiles: readonly RoutingProduct[],
  evidence: ReadonlyMap<string, ProbeEvidence>,
  opts: RoutingOptions = DEFAULT_ROUTING_OPTIONS,
): RouteDecision {
  const q = contentTokens(query);
  const evidenceOf = evidenceScores(
    profiles.map((p) => p.name),
    evidence,
  );
  const scored: RankedProject[] = profiles.map((p) => {
    const profileTokens = contentTokens(
      [p.name.replace(/-/g, " "), p.title, ...p.aliases, p.description, ...p.tags].join(" "),
    );
    let shared = 0;
    for (const t of q) if (profileTokens.has(t)) shared += 1;
    const profile = q.size > 0 ? shared / q.size : 0;
    const ev = evidenceOf.get(p.name) ?? 0;
    return {
      name: p.name,
      profile,
      evidence: ev,
      score: (profile + ev) / 2,
      mentioned: mentions(query, p),
    };
  });
  const ranked = scored
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) => Number(b.r.mentioned) - Number(a.r.mentioned) || b.r.score - a.r.score || a.i - b.i,
    )
    .map(({ r }) => r);
  const all = profiles.map((p) => p.name);
  const named = scored.filter((r) => r.mentioned).map((r) => r.name);
  const fallback = (reason: FallbackReason): RouteDecision => ({
    ranked,
    route: "fallback",
    reason,
    chosen: all,
  });

  if (named.length === 0) {
    if (scored.every((r) => r.evidence === 0)) return fallback("no-evidence");
    const best = Math.max(...scored.map((r) => r.score));
    if (best < opts.floor) return fallback("low-confidence");
    const byProfile = argmaxNames(scored, (r) => r.profile);
    const byEvidence = argmaxNames(scored, (r) => r.evidence);
    if (
      byProfile.length > 0 &&
      byEvidence.length > 0 &&
      !byProfile.some((n) => byEvidence.includes(n))
    ) {
      return fallback("signals-disagree");
    }
  }
  const best = Math.max(0, ...scored.filter((r) => !r.mentioned).map((r) => r.score));
  const keep = new Set(named);
  for (const r of scored) {
    if (!r.mentioned && r.score > 0 && r.score >= opts.keepRatio * best) keep.add(r.name);
  }
  return { ranked, route: "routed", chosen: all.filter((n) => keep.has(n)) };
}

// ─── Scores ────────────────────────────────────────────────────────────────

/** Whether every answer product is among the first `k` ranked. */
export function inTopK(ranked: readonly RankedProject[], answerIn: readonly string[], k: number) {
  const top = new Set(ranked.slice(0, k).map((r) => r.name));
  return answerIn.every((n) => top.has(n));
}

/** `ranked` re-ordered on score alone, as if no product were named. */
export function bySignals(ranked: readonly RankedProject[]): RankedProject[] {
  return [...ranked].sort((a, b) => b.score - a.score);
}

/** One hit of a project's probe search, as a cross-project ranking reads it. */
export interface ProbeHit {
  product: string;
  /** `<product>:<file>`. */
  key: string;
  /** The dense cosine; `null` for a hit only the keyword search found. */
  cosine: number | null;
  /** The excerpt's length in characters. */
  chars: number;
}

/**
 * A counterfactual for the go/no-go, not a proposal (ranking belongs to #2264):
 * every project's probe hits merged on their dense cosine alone, the best `k`
 * kept. A keyword-only hit, which has no cosine, sorts after every dense one,
 * in its project's own order. Answers "would ranking alone, without routing,
 * keep the answer's excerpts?"
 */
export function rankAcrossProjects(hits: readonly ProbeHit[], k: number): ProbeHit[] {
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (b.h.cosine ?? -1) - (a.h.cosine ?? -1) || a.i - b.i)
    .slice(0, k)
    .map(({ h }) => h);
}

/** One question routed over one scope. */
export interface RoutingSample {
  questionId: string;
  scopeSize: number;
  answerIn: string[];
  decision: RouteDecision;
}

export interface Rate {
  n: number;
  of: number;
}

export interface RoutingRow {
  scopeSize: number;
  /** Questions with an answer, answerable in this scope. */
  answerable: number;
  /**
   * #2397 — over the answerable questions answered in at most k products: the
   * ones whose every answer product is in the router's top k.
   */
  top1: Rate;
  top2: Rate;
  top3: Rate;
  /** The same with a product mention ignored: the profile and evidence signals alone. */
  signalsTop1: Rate;
  signalsTop2: Rate;
  signalsTop3: Rate;
  /** Answerable questions the router routed, and of them the ones whose choice holds every answer product. */
  routed: Rate;
  routedRight: Rate;
  /** Mean projects searched per answerable question (a fallback searches the scope). */
  meanSearched: number;
  /** No-answer questions the router fell back on. */
  noAnswerFallback: Rate;
}

/** Top-k and the router's own choice, per scope size. */
export function summarizeRouting(samples: readonly RoutingSample[]): RoutingRow[] {
  const sizes = [...new Set(samples.map((s) => s.scopeSize))].sort((a, b) => a - b);
  return sizes.map((scopeSize) => {
    const own = samples.filter((s) => s.scopeSize === scopeSize);
    const ans = own.filter((s) => s.answerIn.length > 0);
    const none = own.filter((s) => s.answerIn.length === 0);
    const rate = (xs: readonly RoutingSample[], f: (s: RoutingSample) => boolean): Rate => ({
      n: xs.filter(f).length,
      of: xs.length,
    });
    const routed = ans.filter((s) => s.decision.route === "routed");
    // #2397 — a question answered in more than k products cannot be in the top k,
    // so top k is read over the questions it can reach.
    const topK = (k: number, order: (r: readonly RankedProject[]) => readonly RankedProject[]) =>
      rate(
        ans.filter((s) => s.answerIn.length <= k),
        (s) => inTopK(order(s.decision.ranked), s.answerIn, k),
      );
    return {
      scopeSize,
      answerable: ans.length,
      top1: topK(1, (r) => r),
      top2: topK(2, (r) => r),
      top3: topK(3, (r) => r),
      signalsTop1: topK(1, bySignals),
      signalsTop2: topK(2, bySignals),
      signalsTop3: topK(3, bySignals),
      routed: { n: routed.length, of: ans.length },
      routedRight: rate(routed, (s) => s.answerIn.every((n) => s.decision.chosen.includes(n))),
      meanSearched:
        ans.length > 0 ? ans.reduce((a, s) => a + s.decision.chosen.length, 0) / ans.length : 0,
      noAnswerFallback: rate(none, (s) => s.decision.route === "fallback"),
    };
  });
}

/** What one way of choosing projects put in the prompt for one question. */
export interface RetrievalRun {
  questionId: string;
  scopeSize: number;
  /**
   * `all`: today's search-all; `routed`: the router's choice; `oracle`: exactly
   * the answer's products; `ranked`: every project's probe hits merged on
   * cosine ({@link rankAcrossProjects}), whose block length is its excerpts' text only.
   */
  mode: "all" | "routed" | "oracle" | "ranked";
  answerIn: string[];
  expectedFiles: string[];
  projectsSearched: number;
  /** Projects whose search timed out or failed (federated search's 3 s per-project timeout). */
  failed: number;
  /** The excerpts the prompt carries, as `<product>:<file>`. */
  hits: string[];
  /** The router's probe plus the search, in ms (the search alone for `all` and `oracle`). */
  ms: number;
  /** The multi-product RAG block's length in characters. */
  blockChars: number;
}

export interface RetrievalRow {
  scopeSize: number;
  mode: RetrievalRun["mode"];
  questions: number;
  meanSearched: number;
  /** Project searches that timed out or failed, over all asked for. */
  failed: Rate;
  /** Excerpts from an answer product, over all excerpts. */
  answerShare: Rate;
  /** Questions with no excerpt from some answer product. */
  missingProduct: Rate;
  /** Expected source files among the excerpts (`from` questions only). */
  expectedRecall: Rate;
  meanMs: number;
  maxMs: number;
  meanBlockChars: number;
}

const productOf = (key: string) => key.slice(0, key.indexOf(":"));

/** Per scope size and mode, over the questions with an answer. */
export function summarizeRetrieval(runs: readonly RetrievalRun[]): RetrievalRow[] {
  const modes: RetrievalRun["mode"][] = ["all", "ranked", "routed", "oracle"];
  const sizes = [...new Set(runs.map((r) => r.scopeSize))].sort((a, b) => a - b);
  const rows: RetrievalRow[] = [];
  for (const scopeSize of sizes) {
    for (const mode of modes) {
      const own = runs.filter(
        (r) => r.scopeSize === scopeSize && r.mode === mode && r.answerIn.length > 0,
      );
      if (own.length === 0) continue;
      let fromAnswer = 0;
      let hits = 0;
      let expectedHit = 0;
      let expected = 0;
      for (const r of own) {
        hits += r.hits.length;
        fromAnswer += r.hits.filter((h) => r.answerIn.includes(productOf(h))).length;
        const got = new Set(r.hits);
        expected += r.expectedFiles.length;
        expectedHit += r.expectedFiles.filter((f) => got.has(f)).length;
      }
      const mean = (f: (r: RetrievalRun) => number) =>
        own.reduce((a, r) => a + f(r), 0) / own.length;
      rows.push({
        scopeSize,
        mode,
        questions: own.length,
        meanSearched: mean((r) => r.projectsSearched),
        failed: {
          n: own.reduce((a, r) => a + r.failed, 0),
          of: own.reduce((a, r) => a + r.failed + r.projectsSearched, 0),
        },
        answerShare: { n: fromAnswer, of: hits },
        missingProduct: {
          n: own.filter((r) => r.answerIn.some((p) => !r.hits.some((h) => productOf(h) === p)))
            .length,
          of: own.length,
        },
        expectedRecall: { n: expectedHit, of: expected },
        meanMs: mean((r) => r.ms),
        maxMs: Math.max(...own.map((r) => r.ms)),
        meanBlockChars: mean((r) => r.blockChars),
      });
    }
  }
  return rows;
}

// ─── The report ────────────────────────────────────────────────────────────

const pct = (r: Rate) =>
  r.of === 0 ? "n/a" : `${Math.round((r.n / r.of) * 100)}% (${r.n}/${r.of})`;

export function formatRoutingReport(input: {
  routing: readonly RoutingRow[];
  retrieval: readonly RetrievalRow[];
  samples: readonly RoutingSample[];
  options: RoutingOptions;
}): string {
  const { options: o } = input;
  const lines = [
    "# Routing multi-product chat (#2336), offline",
    "",
    `Router: probe k ${o.probeK}, floor ${o.floor}, keep ratio ${o.keepRatio}. No model is called.`,
    "",
    "## Is the right project in the router's top k",
    "",
    "Top k counts only the questions answered in at most k products: one answered in two cannot be in the top 1.",
    "",
    "| Scope | Answerable | Top 1 | Top 2 | Top 3 | Top 1, 2, 3 on signals alone (mentions ignored) | Routed (not fallen back) | Routed choice holds the answer | Mean projects searched | No-answer questions fallen back |",
    "|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|",
    ...input.routing.map(
      (r) =>
        `| ${r.scopeSize} | ${r.answerable} | ${pct(r.top1)} | ${pct(r.top2)} | ${pct(r.top3)} | ${pct(r.signalsTop1)}, ${pct(r.signalsTop2)}, ${pct(r.signalsTop3)} | ${pct(r.routed)} | ${pct(r.routedRight)} | ${r.meanSearched.toFixed(1)} | ${pct(r.noAnswerFallback)} |`,
    ),
    "",
    "## What reaches the prompt: search-all, ranked, routed, oracle",
    "",
    "`ranked` merges every project's probe hits on cosine (a ranking counterfactual, #2264's ground); its time is the probe's and its block length counts excerpt text only.",
    "",
    "| Scope | Mode | Questions | Projects searched | Searches failed | Excerpts from an answer product | Questions missing an answer product | Expected files retrieved | Mean ms | Max ms | Mean block chars |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...input.retrieval.map(
      (r) =>
        `| ${r.scopeSize} | ${r.mode} | ${r.questions} | ${r.meanSearched.toFixed(1)} | ${pct(r.failed)} | ${pct(r.answerShare)} | ${pct(r.missingProduct)} | ${pct(r.expectedRecall)} | ${Math.round(r.meanMs)} | ${Math.round(r.maxMs)} | ${Math.round(r.meanBlockChars)} |`,
    ),
    "",
    "## Per question",
    "",
    "| Scope | Question | Answer in | Ranked (profile/evidence) | Route | Chosen |",
    "|---:|---|---|---|---|---|",
    ...input.samples.map((s) => {
      const ranked = s.decision.ranked
        .slice(0, 4)
        .map(
          (r) =>
            `${r.mentioned ? "*" : ""}${r.name} ${r.profile.toFixed(2)}/${r.evidence.toFixed(2)}`,
        )
        .join(", ");
      const route = s.decision.reason ? `fallback: ${s.decision.reason}` : "routed";
      return `| ${s.scopeSize} | ${s.questionId} | ${s.answerIn.join(", ") || "-"} | ${ranked} | ${route} | ${s.decision.chosen.length} |`;
    }),
  ];
  return lines.join("\n");
}

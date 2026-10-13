/**
 * Epic #1068 / Issue #1072 — the contextual-document A/B: do a symbol's search
 * documents retrieve better when they carry its signature, doc comment,
 * receiver, package, callers and tables?
 *
 * ## This file is the PRE-REGISTRATION
 *
 * Everything in the first half of this file — the bars, the arms, and the rule
 * that turns measured comparisons into a ship decision — was committed before
 * any arm was scored. `docs/decisions/0020-contextual-symbol-documents.md`
 * states the same in prose and names the commit. The rule is a function
 * ({@link decideContextualShip}) rather than a paragraph so that it is applied
 * mechanically to whatever comes out.
 *
 * ## The decision rule is IMPORTED, not re-derived
 *
 * `classifyDelta` and `testsAgree` are #1157's rule as `rerank-sweep.ts`
 * implements it and `interval-report.ts` prints it: the paired bootstrap CI and
 * the exact sign test, three classes. Nothing here changes it. One thing is
 * added on top, because `classifyDelta` is direction-blind: a delta whose CI
 * lies wholly BELOW zero also classifies `DIRECTION-ESTABLISHED-MAGNITUDE-NOT`.
 * {@link isEstablishedGain} therefore also requires the mean delta to be
 * positive.
 */
import path from "node:path";
import {
  createResolutionIndex,
  indexSymbol,
  resolveEdgeTarget,
} from "../../code-graph/call-resolution.js";
import {
  DEFAULT_WEIGHTS,
  tokenizeCode,
  type LexicalConfig,
  type SearchableSymbol,
  type SearchWeights,
} from "../../code-graph/hybrid-search.js";
import { buildFileImportIndex, buildImportResolutionContext } from "../../code-graph/ingest.js";
import { detectLanguage, parseSource, type ParsedFile } from "../../code-graph/parsers.js";
import {
  composeEmbeddingText,
  contextLines,
  contextualDocumentText,
  deriveCrossFileContext,
  extractOwnFileContext,
  packageOfFile,
  type ContextEdgeRef,
  type ContextSymbolRef,
  type CrossFileContext,
  type OwnFileContext,
} from "../../code-graph/symbol-context.js";
import type { EmbedService } from "../../code-graph/symbol-embeddings.js";
import { readRepoFiles, type EmbedRetrievalCorpus } from "./corpus.js";
import {
  compareLexicalArm,
  createLexicalArmSearch,
  MIN_IMPORTANT_BM25_DELTA,
  MIN_IMPORTANT_FUSED_DELTA,
  renderLexicalArms,
  renderLexicalDecision,
  scoreLexicalArm,
  type LexicalArmResult,
  type LexicalComparison,
} from "./lexical-ab.js";
import type { RerankVerdict as DeltaVerdict } from "./rerank-sweep.js";
import { createEmptyVectorStore, LEXICAL_ONLY_WEIGHTS, type EmbedFn } from "./runner.js";
import { corpusSymbolIndex, withWiredCorpus } from "./wired-runner.js";

/** Rank depth every arm is scored at — the `@10` in nDCG@10. */
export const CONTEXTUAL_K = 10;

/**
 * PRE-REGISTERED bar for the DECISION channel: fused at `DEFAULT_WEIGHTS`
 * (`0.05 / 0.95`), rerank off, the production embedder.
 *
 * It is #1159's fused bar, reused unchanged: `0.02` is the bottom of the band
 * epic #1156 says a retrieval sub-issue moves nDCG@10 by, and below it that
 * epic treats a move as noise. The baseline it is measured against is 0.276
 * (ADR 0005, `embedretrieval-02-nl-to-code`, n = 127).
 */
export const MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA = MIN_IMPORTANT_FUSED_DELTA;

/**
 * PRE-REGISTERED bar for the pure-BM25 channel (`1.00 / 0.00`). Reported for
 * attribution; it does not decide. #1159's BM25 bar, reused unchanged.
 */
export const MIN_IMPORTANT_CONTEXTUAL_BM25_DELTA = MIN_IMPORTANT_BM25_DELTA;

/**
 * Which fields one document of an arm carries.
 *
 *  - `base` — the document `main` builds today: BM25 `name + qualifiedName`;
 *    embedding text `{kind} {name} in {filePath}` plus the first ten body lines.
 *  - `own`  — `base` plus the OWN-FILE fields: signature, doc comment, receiver,
 *    package.
 *  - `full` — `own` plus the CROSS-FILE fields: caller names and tables.
 */
export type DocumentVariant = "base" | "own" | "full";

/** One arm: which variant its BM25 document is, and which its embedding text is. */
export interface ContextualArmSpec {
  id: ContextualArmId;
  label: string;
  lexical: DocumentVariant;
  embedding: DocumentVariant;
}

export type ContextualArmId =
  "baseline" | "contextual" | "lexical-cross" | "own-file" | "lexical-only" | "vector-only";

/**
 * The six arms. Same corpus, same queries, same embedder, same weights, rerank
 * off — the documents are the only free variable.
 *
 * `contextual` is the PRIMARY treatment and the only arm that can open the
 * gate. `lexical-cross` and `own-file` are cheaper documents that may be
 * shipped INSTEAD of it (see {@link decideContextualShip}). `lexical-only` and
 * `vector-only` exist to attribute an effect to one channel and decide nothing.
 */
export const CONTEXTUAL_ARMS: readonly ContextualArmSpec[] = [
  {
    id: "baseline",
    label: "baseline — the documents main builds",
    lexical: "base",
    embedding: "base",
  },
  {
    id: "contextual",
    label: "PRIMARY — every field in both documents",
    lexical: "full",
    embedding: "full",
  },
  {
    id: "lexical-cross",
    label: "cross-file fields in the BM25 document only",
    lexical: "full",
    embedding: "own",
  },
  {
    id: "own-file",
    label: "own-file fields only, in both documents",
    lexical: "own",
    embedding: "own",
  },
  {
    id: "lexical-only",
    label: "attribution — BM25 document changed, embedding text as main",
    lexical: "full",
    embedding: "base",
  },
  {
    id: "vector-only",
    label: "attribution — embedding text changed, BM25 document as main",
    lexical: "base",
    embedding: "full",
  },
];

/**
 * The arms that may ship, CHEAPEST FIRST.
 *
 * Cost is what the documents oblige the index to do, not how long they are:
 *
 *  - `own-file` — a symbol's documents change only when its own file does.
 *  - `lexical-cross` — the BM25 document also reads call and lineage edges. It
 *    is rebuilt in memory when the symbol set is loaded, so nothing is stored
 *    that could go stale and nothing is re-embedded.
 *  - `contextual` — the EMBEDDING TEXT reads those edges too, so a symbol is
 *    re-embedded when a file that does not declare it gains or loses a caller.
 */
export const SHIPPABLE_ARMS_CHEAPEST_FIRST: readonly ContextualArmId[] = [
  "own-file",
  "lexical-cross",
  "contextual",
];

/** The minimum a comparison has to say for the rule below to read it. */
export interface DecisionInput {
  verdict: DeltaVerdict;
  meanDelta: number;
}

/**
 * `SHIP` or `DIRECTION-ESTABLISHED-MAGNITUDE-NOT`, AND pointing up.
 *
 * `classifyDelta` returns `DIRECTION-ESTABLISHED-MAGNITUDE-NOT` for a CI that
 * excludes zero on either side, so the sign is checked here.
 */
export function isEstablishedGain(c: DecisionInput): boolean {
  return c.verdict !== "NOT-ESTABLISHED" && c.meanDelta > 0;
}

/** What {@link decideContextualShip} reads, all on the fused decision channel. */
export interface ShipDecisionInput {
  /** Each shippable arm against `baseline`. */
  vsBaseline: Readonly<Record<"own-file" | "lexical-cross" | "contextual", DecisionInput>>;
  /**
   * Each costlier arm against each cheaper one, keyed `"<costlier> vs <cheaper>"`
   * ({@link incrementKey}). The arm that is named first is the one whose delta
   * is positive when it scores higher.
   */
  increments: Readonly<Record<string, DecisionInput>>;
}

export interface ShipDecision {
  /** The documents that ship, or `none`. */
  ship: ContextualArmId | "none";
  /** One sentence per step taken, in order — printed into the artifact. */
  reasons: string[];
}

/** The key of one "costlier vs cheaper" comparison in {@link ShipDecisionInput.increments}. */
export function incrementKey(costlier: ContextualArmId, cheaper: ContextualArmId): string {
  return `${costlier} vs ${cheaper}`;
}

/**
 * THE PRE-REGISTERED RULE.
 *
 * 1. **The gate is the primary treatment.** If `contextual` against `baseline`
 *    is not an established gain on the fused channel, NOTHING ships — also when
 *    a cheaper arm happens to classify as one. Three shippable arms are three
 *    chances at a false positive; only the arm named in advance may open the
 *    gate. A cheaper arm that looks good behind a closed gate is a finding for
 *    a follow-up with its own pre-registration.
 * 2. **Past the gate, the cheapest sufficient documents ship.** Walk the
 *    shippable arms cheapest first and take the first one that (a) is itself an
 *    established gain against `baseline` and (b) is not beaten, as an
 *    established gain, by any costlier shippable arm. `contextual` always
 *    satisfies both once the gate is open, so the walk ends there at the
 *    latest. This is what stops cross-file fields — which cost re-embedding and
 *    a staleness hazard — from shipping on the strength of own-file fields.
 *
 * Not inputs, on purpose: the pure-BM25 and pure-vector channels, the
 * `lexical-only` and `vector-only` arms, and the exact-name miss sets. They are
 * reported, the miss sets by name, and the reviewer reads them.
 */
export function decideContextualShip(input: ShipDecisionInput): ShipDecision {
  const reasons: string[] = [];
  if (!isEstablishedGain(input.vsBaseline.contextual)) {
    reasons.push(
      `contextual vs baseline is ${input.vsBaseline.contextual.verdict} ` +
        `(mean delta ${signed(input.vsBaseline.contextual.meanDelta)}): the gate is closed, nothing ships.`,
    );
    return { ship: "none", reasons };
  }
  reasons.push(
    `contextual vs baseline is ${input.vsBaseline.contextual.verdict} ` +
      `(mean delta ${signed(input.vsBaseline.contextual.meanDelta)}): the gate is open.`,
  );

  const arms = SHIPPABLE_ARMS_CHEAPEST_FIRST;
  for (const [i, arm] of arms.entries()) {
    const own = input.vsBaseline[arm as keyof ShipDecisionInput["vsBaseline"]];
    if (!isEstablishedGain(own)) {
      reasons.push(`${arm} vs baseline is ${own.verdict}: not sufficient on its own.`);
      continue;
    }
    const beatenBy = arms.slice(i + 1).find((costlier) => {
      const inc = input.increments[incrementKey(costlier, arm)];
      return inc !== undefined && isEstablishedGain(inc);
    });
    if (beatenBy) {
      reasons.push(`${arm} is an established gain, but ${beatenBy} is established better.`);
      continue;
    }
    reasons.push(
      `${arm} is an established gain and no costlier arm is established better: it ships.`,
    );
    return { ship: arm, reasons };
  }
  // Unreachable while `contextual` is the last shippable arm: it passed the gate
  // above and has no costlier arm to be beaten by. Kept so a reordering of
  // SHIPPABLE_ARMS_CHEAPEST_FIRST fails closed.
  reasons.push("no shippable arm qualified.");
  return { ship: "none", reasons };
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}

// =============================================================================
// Everything below was written AFTER the pre-registration commit. It builds the
// documents the arms above name and scores them; it changes no bar and no rule.
// =============================================================================

/** The context of every corpus symbol, built with production's own functions. */
export interface CorpusContext {
  /** Own-file fields, by corpus symbol id. Schema symbols have none, as in production. */
  own: ReadonlyMap<string, OwnFileContext>;
  /** Cross-file fields, by corpus symbol id; absent when a symbol has neither. */
  cross: ReadonlyMap<string, CrossFileContext>;
}

/** The context fields, in the order the reach table prints them. */
export const CONTEXT_FIELDS = [
  "signature",
  "docComment",
  "receiver",
  "package",
  "callers",
  "tables",
] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];

/**
 * Build the corpus's context the way an ingest would.
 *
 * Own-file fields come from {@link extractOwnFileContext}, the function ingest
 * calls. Callers come from the parser's `calls` edges, bound by the same
 * resolution index and the same {@link resolveEdgeTarget} ingest's pass 2
 * uses, then reduced by {@link deriveCrossFileContext}.
 *
 * Two things differ from a real ingest and both are stated in the artifact:
 * the corpus is parsed by the regex parser (as `corpus.ts` already does, so
 * the run needs no grammar), and there is no SQL-lineage pass, so no symbol
 * has a `reads` or `writes` edge and the tables field is empty.
 */
export function buildCorpusContext(
  files: ReadonlyArray<{ relPath: string; content: string }>,
): CorpusContext {
  const parsed: ParsedFile[] = [];
  const own = new Map<string, OwnFileContext>();
  const refs: ContextSymbolRef[] = [];
  const index = createResolutionIndex();
  const qnameToId = new Map<string, string>();
  const symbolId = (relPath: string, qualifiedName: string): string =>
    `${relPath}::${qualifiedName}`;

  for (const { relPath, content } of files) {
    const language = detectLanguage(relPath);
    if (!language) continue;
    const file = parseSource(relPath, content, language);
    parsed.push(file);
    const lines = content.split("\n");
    const pkg = packageOfFile(relPath, language, lines);
    for (const sym of file.symbols) {
      const id = symbolId(relPath, sym.qualifiedName);
      // Ingest indexes every symbol, the file's `module` symbol included.
      indexSymbol(index, {
        id,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        filePath: relPath,
        kind: sym.kind,
        language,
      });
      if (!qnameToId.has(sym.qualifiedName)) qnameToId.set(sym.qualifiedName, id);
      refs.push({ id, name: sym.name, kind: sym.kind, qualifiedName: sym.qualifiedName });
      if (sym.kind === "module") continue;
      own.set(id, extractOwnFileContext(sym, { filePath: relPath, language, package: pkg }, lines));
    }
  }

  const importCtx = buildImportResolutionContext(parsed.map((f) => f.filePath));
  const { importTargets, runtimeImports } = buildFileImportIndex(parsed, importCtx);
  const edges: ContextEdgeRef[] = [];
  for (const file of parsed) {
    const site = {
      filePath: file.filePath,
      language: file.language,
      importedFiles: importTargets.get(file.filePath) ?? [],
      runtimeImports: runtimeImports.get(file.filePath),
    };
    for (const edge of file.edges) {
      if (edge.kind !== "calls") continue;
      const fromSymbolId = qnameToId.get(edge.fromQualifiedName);
      if (!fromSymbolId) continue;
      const toSymbolId =
        qnameToId.get(edge.toQualifiedName) ??
        resolveEdgeTarget(edge.toQualifiedName, edge.receiver, site, index);
      edges.push({ kind: "calls", fromSymbolId, toSymbolId });
    }
  }

  return { own, cross: deriveCrossFileContext(refs, edges) };
}

/** Read a corpus's source files and build its context. */
export async function loadCorpusContext(dir: string): Promise<CorpusContext> {
  return buildCorpusContext(await readRepoFiles(path.join(dir, "repo")));
}

/**
 * How many corpus symbols carry each field — the ceiling on what the field can
 * do here, and the input to the pre-registered rule that a field with no reach
 * does not ship in a document.
 */
export function contextReach(
  corpus: Pick<EmbedRetrievalCorpus, "symbols">,
  context: CorpusContext,
): Record<ContextField, number> & { symbols: number } {
  const reach = {
    symbols: corpus.symbols.length,
    signature: 0,
    docComment: 0,
    receiver: 0,
    package: 0,
    callers: 0,
    tables: 0,
  };
  for (const s of corpus.symbols) {
    const own = context.own.get(s.id);
    if (own?.signature) reach.signature += 1;
    if (own?.docComment) reach.docComment += 1;
    if (own?.receiver) reach.receiver += 1;
    if (own?.package) reach.package += 1;
    const cross = context.cross.get(s.id);
    if (cross && cross.callers.length > 0) reach.callers += 1;
    if (cross && cross.tables.length > 0) reach.tables += 1;
  }
  return reach;
}

/** The fields no corpus symbol carries: unmeasured, so excluded from shipped documents. */
export function unmeasuredFields(reach: Record<ContextField, number>): ContextField[] {
  return CONTEXT_FIELDS.filter((f) => reach[f] === 0);
}

/** The corpus's lexical view with every context field attached. */
export function contextualSearchable(
  corpus: Pick<EmbedRetrievalCorpus, "searchable">,
  context: CorpusContext,
): SearchableSymbol[] {
  return corpus.searchable.map((s) => {
    const own = context.own.get(s.symbolId);
    const cross = context.cross.get(s.symbolId);
    return {
      ...s,
      ...(own?.signature ? { signature: own.signature } : {}),
      ...(own?.docComment ? { docstring: own.docComment } : {}),
      ...(own?.receiver ? { receiver: own.receiver } : {}),
      ...(own?.package ? { package: own.package } : {}),
      ...(cross && cross.callers.length > 0 ? { callers: cross.callers } : {}),
      ...(cross && cross.tables.length > 0 ? { tables: cross.tables } : {}),
    };
  });
}

/**
 * The BM25 document `main` builds, frozen: `name + " " + qualifiedName`.
 *
 * Not `buildSymbolDocumentText`: that function appends `signature` and
 * `docstring` when a symbol has them, and every arm here shares one symbol set
 * that does. The baseline must not see them, and must not move if production's
 * builder does.
 */
export function baselineDocumentText(
  sym: Pick<SearchableSymbol, "name" | "qualifiedName">,
): string {
  return `${sym.name} ${sym.qualifiedName}`;
}

/** The lexical configuration of one document variant. Every arm uses production's tokenizer. */
export function lexicalConfigFor(variant: DocumentVariant): LexicalConfig {
  return {
    tokenizer: tokenizeCode,
    buildDocumentText:
      variant === "base" ? baselineDocumentText : (sym) => contextualDocumentText(sym, variant),
  };
}

/** One symbol's embedding text under a variant, from the text `main` embeds. */
export function embeddingTextFor(
  baseText: string,
  symbolId: string,
  context: CorpusContext,
  variant: DocumentVariant,
): string {
  if (variant === "base") return baseText;
  const own = context.own.get(symbolId) ?? { receiver: null, package: null, docComment: null };
  const cross = variant === "full" ? context.cross.get(symbolId) : undefined;
  return composeEmbeddingText(baseText, contextLines(own, cross));
}

/** The corpus with every doc's text rebuilt for one embedding variant. */
export function corpusForEmbeddingVariant(
  corpus: EmbedRetrievalCorpus,
  context: CorpusContext,
  variant: DocumentVariant,
): EmbedRetrievalCorpus {
  if (variant === "base") return corpus;
  return {
    ...corpus,
    docs: corpus.docs.map((d) => ({
      ...d,
      text: embeddingTextFor(d.text, d.id, context, variant),
    })),
  };
}

/** What embedding one variant of the corpus cost. */
export interface EmbedCost {
  variant: DocumentVariant;
  /** Symbol texts embedded (queries are not counted). */
  texts: number;
  /** Characters across those texts. */
  chars: number;
  /** Wall time spent inside the embedder for them, in milliseconds. */
  ms: number;
}

/** One channel's arms and their comparisons against that channel's first arm. */
export interface ContextualChannel {
  arms: LexicalArmResult[];
  comparisons: LexicalComparison[];
}

export interface ContextualAbReport {
  reach: Record<ContextField, number> & { symbols: number };
  unmeasured: ContextField[];
  /** Pure BM25, one arm per document variant (`base`, `own`, `full`). */
  bm25: ContextualChannel;
  /** Pure vector, one arm per embedding variant. Null without weights. */
  vector: ContextualChannel | null;
  /** The decision channel: the six pre-registered arms. Null without weights. */
  fused: ContextualChannel | null;
  /** Costlier shippable arm against cheaper, keyed by {@link incrementKey}. */
  increments: Record<string, LexicalComparison>;
  decision: ShipDecision | null;
  embedCost: EmbedCost[];
}

const VARIANTS: readonly DocumentVariant[] = ["base", "own", "full"];
const VECTOR_ONLY_WEIGHTS: SearchWeights = { bm25Weight: 0, vectorWeight: 1 };

/** The embedder and its model id; absent for a BM25-only run. */
export interface ContextualEmbedder {
  embed: EmbedFn;
  model: string;
  /** Test seam for the cost clock. */
  now?: () => number;
}

/**
 * Score every pre-registered arm and apply the pre-registered rule.
 *
 * The corpus is embedded once per embedding variant (three times), through the
 * production write path, and each store is read through the production
 * searcher with the arm's lexical configuration. Query embeddings are not
 * counted in {@link EmbedCost}: a call with one text is a query.
 */
export async function runContextualAb(
  corpus: EmbedRetrievalCorpus,
  context: CorpusContext,
  embedder: ContextualEmbedder | null,
  log: (line: string) => void = () => {},
): Promise<ContextualAbReport> {
  const reach = contextReach(corpus, context);
  const searchable = contextualSearchable(corpus, context);
  const symbolIndex = corpusSymbolIndex(searchable);

  // --- pure BM25: no embedder reachable at all ---
  const refusing: EmbedService = {
    async embed() {
      throw new Error("the pure-BM25 arms must reach no embedder");
    },
  };
  const bm25Arms: LexicalArmResult[] = [];
  for (const variant of VARIANTS) {
    const search = createLexicalArmSearch(
      {
        vectorStore: createEmptyVectorStore(),
        symbolIndex,
        embedService: refusing,
        projectId: corpus.projectId,
        weights: LEXICAL_ONLY_WEIGHTS,
      },
      lexicalConfigFor(variant),
    );
    bm25Arms.push(await scoreLexicalArm(corpus, search, { id: variant, label: `BM25 ${variant}` }));
    log(`  bm25  ${variant.padEnd(14)} nDCG@10=${bm25Arms[bm25Arms.length - 1].ndcg10.toFixed(3)}`);
  }
  const bm25: ContextualChannel = {
    arms: bm25Arms,
    comparisons: bm25Arms
      .slice(1)
      .map((arm) => compareLexicalArm(bm25Arms[0], arm, MIN_IMPORTANT_CONTEXTUAL_BM25_DELTA)),
  };

  const report: ContextualAbReport = {
    reach,
    unmeasured: unmeasuredFields(reach),
    bm25,
    vector: null,
    fused: null,
    increments: {},
    decision: null,
    embedCost: [],
  };
  if (!embedder) return report;

  const now = embedder.now ?? ((): number => performance.now());
  const fusedById = new Map<ContextualArmId, LexicalArmResult>();
  const vectorArms: LexicalArmResult[] = [];

  for (const variant of VARIANTS) {
    const cost: EmbedCost = { variant, texts: 0, chars: 0, ms: 0 };
    const counting: EmbedFn = async (texts) => {
      // The pipeline embeds symbols in batches; a single text is a query.
      if (texts.length === 1) return embedder.embed(texts);
      const t0 = now();
      const vectors = await embedder.embed(texts);
      cost.ms += now() - t0;
      cost.texts += texts.length;
      cost.chars += texts.reduce((n, t) => n + t.length, 0);
      return vectors;
    };
    await withWiredCorpus(
      corpusForEmbeddingVariant(corpus, context, variant),
      counting,
      embedder.model,
      async (wired) => {
        const deps = {
          vectorStore: wired.vectorStore,
          symbolIndex,
          embedService: wired.embedService,
          projectId: corpus.projectId,
        };
        const vector = await scoreLexicalArm(
          corpus,
          createLexicalArmSearch(
            { ...deps, weights: VECTOR_ONLY_WEIGHTS },
            lexicalConfigFor("base"),
          ),
          { id: variant, label: `vector ${variant}` },
        );
        vectorArms.push(vector);
        log(`  vector ${variant.padEnd(13)} nDCG@10=${vector.ndcg10.toFixed(3)}`);
        for (const spec of CONTEXTUAL_ARMS.filter((a) => a.embedding === variant)) {
          const arm = await scoreLexicalArm(
            corpus,
            createLexicalArmSearch(
              { ...deps, weights: DEFAULT_WEIGHTS },
              lexicalConfigFor(spec.lexical),
            ),
            spec,
          );
          fusedById.set(spec.id, arm);
          log(`  fused ${spec.id.padEnd(14)} nDCG@10=${arm.ndcg10.toFixed(3)}`);
        }
      },
    );
    report.embedCost.push(cost);
  }

  const fusedArm = (id: ContextualArmId): LexicalArmResult => {
    const arm = fusedById.get(id);
    if (!arm) throw new Error(`contextual A/B: arm "${id}" was not scored`);
    return arm;
  };
  const baseline = fusedArm("baseline");
  const bar = MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA;
  const fusedArms = CONTEXTUAL_ARMS.map((a) => fusedArm(a.id));
  report.fused = {
    arms: fusedArms,
    comparisons: fusedArms.slice(1).map((arm) => compareLexicalArm(baseline, arm, bar)),
  };
  report.vector = {
    arms: vectorArms,
    comparisons: vectorArms.slice(1).map((arm) => compareLexicalArm(vectorArms[0], arm, bar)),
  };

  const shippable = SHIPPABLE_ARMS_CHEAPEST_FIRST;
  for (const [i, cheaper] of shippable.entries()) {
    for (const costlier of shippable.slice(i + 1)) {
      report.increments[incrementKey(costlier, cheaper)] = compareLexicalArm(
        fusedArm(cheaper),
        fusedArm(costlier),
        bar,
      );
    }
  }

  const input = (c: LexicalComparison): DecisionInput => ({
    verdict: c.verdict,
    meanDelta: c.paired.meanDelta,
  });
  const vsBaseline = (id: ContextualArmId): DecisionInput => {
    const c = report.fused?.comparisons.find((x) => x.armId === id);
    if (!c) throw new Error(`contextual A/B: no comparison for "${id}"`);
    return input(c);
  };
  report.decision = decideContextualShip({
    vsBaseline: {
      "own-file": vsBaseline("own-file"),
      "lexical-cross": vsBaseline("lexical-cross"),
      contextual: vsBaseline("contextual"),
    },
    increments: Object.fromEntries(
      Object.entries(report.increments).map(([k, c]) => [k, input(c)]),
    ),
  });
  return report;
}

const f3 = (n: number): string => n.toFixed(3);

/** The reach table: how many corpus symbols carry each field. */
export function renderReach(report: Pick<ContextualAbReport, "reach" | "unmeasured">): string {
  const lines = [`| field | symbols carrying it | of | note |`, `| --- | --- | --- | --- |`];
  for (const f of CONTEXT_FIELDS) {
    const note = report.unmeasured.includes(f)
      ? "**no reach — unmeasured, excluded from shipped documents**"
      : "";
    lines.push(`| ${f} | ${report.reach[f]} | ${report.reach.symbols} | ${note} |`);
  }
  return lines.join("\n");
}

/** The "costlier vs cheaper" table the second step of the rule reads. */
export function renderIncrements(increments: Readonly<Record<string, LexicalComparison>>): string {
  const lines = [
    `| comparison | Δ nDCG@10 | paired 95% CI | wins/losses/ties | sign p | verdict |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const [key, c] of Object.entries(increments)) {
    lines.push(
      `| \`${key}\` | ${c.paired.meanDelta >= 0 ? "+" : ""}${f3(c.paired.meanDelta)} | ` +
        `[${f3(c.paired.ciLow)}, ${f3(c.paired.ciHigh)}] | ` +
        `${c.paired.wins}/${c.paired.losses}/${c.paired.ties} | ${c.paired.signTestP.toFixed(3)} | ` +
        `**${c.verdict}** |`,
    );
  }
  return lines.join("\n");
}

/** What embedding each variant cost. */
export function renderEmbedCost(costs: readonly EmbedCost[]): string {
  const lines = [
    `| embedding text | symbols embedded | characters | mean chars/symbol | wall time in the embedder |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const c of costs) {
    lines.push(
      `| ${c.variant} | ${c.texts} | ${c.chars} | ` +
        `${c.texts === 0 ? "—" : (c.chars / c.texts).toFixed(0)} | ${(c.ms / 1000).toFixed(1)} s |`,
    );
  }
  return lines.join("\n");
}

function renderChannel(title: string, bar: number, channel: ContextualChannel): string {
  const names = channel.arms
    .map(
      (a) =>
        `${a.armId} (${a.exactNameMisses.length}/${a.exactNameCount}): ` +
        `${[...a.exactNameMisses].sort().join(", ") || "none"}`,
    )
    .join("\n");
  return (
    `## ${title}\n\n` +
    `Pre-registered bar: +${f3(bar)} nDCG@10.\n\n` +
    `${renderLexicalArms(channel.arms[0], channel.arms.slice(1), channel.comparisons)}\n\n` +
    `${renderLexicalDecision(channel.comparisons)}\n\n` +
    `Exact-name misses, by name:\n\n\`\`\`\n${names}\n\`\`\`\n`
  );
}

/** The whole artifact. */
export function renderContextualAb(
  report: ContextualAbReport,
  meta: { corpusId: string; snapshotCommit: string; queries: number; ranAt: string },
): string {
  const head =
    `# Contextual symbol documents (#1072)\n\n` +
    `Corpus: \`${meta.corpusId}\` (\`snapshotCommit\` ${meta.snapshotCommit}) — ` +
    `${report.reach.symbols} symbols, ${meta.queries} requirements. Run: ${meta.ranAt}\n\n` +
    `Bars, arms and rule were pre-registered: ` +
    `\`docs/decisions/0020-contextual-symbol-documents.md\`.\n\n` +
    `## Reach\n\n${renderReach(report)}\n\n` +
    `The corpus is parsed by the regex parser and has no SQL-lineage pass.\n\n`;
  const fused = report.fused
    ? renderChannel(
        "Fused at `DEFAULT_WEIGHTS` — the decision channel",
        MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA,
        report.fused,
      ) +
      `\n### Costlier arm against cheaper\n\n${renderIncrements(report.increments)}\n\n` +
      `### Decision\n\n**Ships: ${report.decision?.ship ?? "none"}**\n\n` +
      `${(report.decision?.reasons ?? []).map((r) => `- ${r}`).join("\n")}\n\n`
    : `## Fused\n\nNOT MEASURED — no model weights in this run. No decision.\n\n`;
  const vector = report.vector
    ? renderChannel(
        "Pure vector (`0.00 / 1.00`) — attribution only",
        MIN_IMPORTANT_CONTEXTUAL_FUSED_DELTA,
        report.vector,
      )
    : "";
  return (
    head +
    fused +
    renderChannel(
      "Pure BM25 (`1.00 / 0.00`) — attribution only",
      MIN_IMPORTANT_CONTEXTUAL_BM25_DELTA,
      report.bm25,
    ) +
    `\n${vector}` +
    (report.embedCost.length > 0
      ? `\n## Embedding cost on this corpus\n\n${renderEmbedCost(report.embedCost)}\n`
      : "")
  );
}

/**
 * Epic #1068 / Issue #1072 — the measurement half of the contextual-document
 * A/B: the corpus context, the document variants, and the run itself.
 *
 * No weights and no network: the embedder is a deterministic bag-of-words
 * stand-in, which is enough to prove each arm is handed the documents it names.
 */
import { describe, it, expect } from "vitest";
import { buildSymbolsFromRepo } from "../codegraph/fixture.js";
import {
  buildSymbolDocumentText,
  tokenizeCode,
  type SearchableSymbol,
} from "../../code-graph/hybrid-search.js";
import { composeEmbeddingText, shippedContextLines } from "../../code-graph/symbol-context.js";
import {
  buildDocText,
  corpusDir,
  loadEmbedRetrievalCorpus,
  type EmbedRetrievalCorpus,
} from "./corpus.js";
import {
  baselineDocumentText,
  buildCorpusContext,
  loadCorpusContext,
  CONTEXT_FIELDS,
  CONTEXTUAL_ARMS,
  contextReach,
  contextualSearchable,
  corpusForEmbeddingVariant,
  decideContextualShip,
  embeddingTextFor,
  incrementKey,
  lexicalConfigFor,
  renderContextualAb,
  renderEmbedCost,
  renderIncrements,
  renderReach,
  runContextualAb,
  unmeasuredFields,
  type ContextualAbReport,
} from "./contextual-ab.js";

const FILES = [
  {
    relPath: "store/users.ts",
    content: [
      "/**",
      " * Persists a member so that later logins find the account.",
      " */",
      "export function saveUser(user: User): void {",
      "  write(user);",
      "}",
      "",
      "export function write(row: unknown): void {",
      "  write(row);",
      "}",
      "",
    ].join("\n"),
  },
  {
    relPath: "api/handlers.ts",
    content: [
      'import { saveUser } from "../store/users";',
      "",
      "// Registers a newcomer.",
      "export function signUp(input: Input): void {",
      "  saveUser(input);",
      "}",
      "",
      "export function importUsers(rows: Input[]): void {",
      "  for (const r of rows) saveUser(r);",
      "}",
      "",
      "saveUser(bootstrap);",
      "",
    ].join("\n"),
  },
];

const PROJECT = "p-1072";

function corpusFrom(files: typeof FILES): EmbedRetrievalCorpus {
  const symbols = buildSymbolsFromRepo(files, PROJECT);
  const byPath = new Map(files.map((f) => [f.relPath, f.content]));
  const id = (name: string): string => {
    const hit = symbols.find((s) => s.name === name);
    if (!hit) throw new Error(`fixture has no symbol ${name}`);
    return hit.id;
  };
  return {
    spec: { id: "t", title: "t", snapshotCommit: "0".repeat(40), groundTruth: "g", queries: [] },
    projectId: PROJECT,
    symbols,
    docs: symbols.map((s) => ({
      id: s.id,
      filePath: s.filePath,
      name: s.name,
      kind: s.kind,
      text: buildDocText(s, byPath.get(s.filePath) ?? ""),
    })),
    queries: [
      // Only the doc comment of `saveUser` shares a word with this requirement.
      {
        id: "Q1",
        requirement: "persists a member for later logins",
        relevant: [id("saveUser")],
        strata: null,
      },
      { id: "Q2", requirement: "sign up", relevant: [id("signUp")], strata: null },
      { id: "Q3", requirement: "import users", relevant: [id("importUsers")], strata: null },
      // Only the CALLERS of `saveUser` (`signUp`, `importUsers`) share a word with
      // this one: a document without cross-file fields cannot answer it.
      {
        id: "Q4",
        requirement: "sign up then import",
        relevant: [id("saveUser")],
        strata: null,
      },
    ],
    searchable: symbols.map((s) => ({
      symbolId: s.id,
      name: s.name,
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      filePath: s.filePath,
      language: s.language,
    })),
  };
}

/** A deterministic bag-of-words embedding: same tokens, same direction. */
function bagOfWords(text: string): number[] {
  const v = new Array<number>(48).fill(0);
  for (const tok of tokenizeCode(text)) {
    let h = 0;
    for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) % 48;
    v[h] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe("buildCorpusContext", () => {
  const corpus = corpusFrom(FILES);
  const context = buildCorpusContext(FILES);
  const idOf = (name: string): string => corpus.symbols.find((s) => s.name === name)?.id ?? "";

  it("extracts the own-file fields with the production extractor", () => {
    expect(context.own.get(idOf("saveUser"))).toEqual({
      signature: "export function saveUser(user: User): void",
      docComment: "Persists a member so that later logins find the account.",
      receiver: null,
      package: "store",
    });
    expect(context.own.get(idOf("signUp"))?.docComment).toBe("Registers a newcomer.");
    expect(context.own.get(idOf("importUsers"))?.docComment).toBeNull();
  });

  it("gives every corpus symbol own-file context, keyed by the corpus's ids", () => {
    for (const s of corpus.symbols) expect(context.own.has(s.id)).toBe(true);
    expect(context.own.size).toBe(corpus.symbols.length);
  });

  it("binds a cross-file call through the import, as ingest does", () => {
    expect(context.cross.get(idOf("saveUser"))).toEqual({
      // Sorted by code unit; the module-level call and the self-call are not callers.
      callers: ["importUsers", "signUp"],
      tables: [],
    });
  });

  it("does not count a symbol's call to itself", () => {
    // `write` is called by `saveUser` and by itself.
    expect(context.cross.get(idOf("write"))?.callers).toEqual(["saveUser"]);
  });

  it("leaves a symbol nobody calls out of the cross-file map", () => {
    expect(context.cross.has(idOf("signUp"))).toBe(false);
  });

  it("skips a file whose language it does not parse", () => {
    const ctx = buildCorpusContext([{ relPath: "README.md", content: "# hi" }]);
    expect(ctx.own.size).toBe(0);
    expect(ctx.cross.size).toBe(0);
  });
});

describe("reach", () => {
  const corpus = corpusFrom(FILES);
  const context = buildCorpusContext(FILES);

  it("counts the corpus symbols that carry each field", () => {
    expect(contextReach(corpus, context)).toEqual({
      symbols: 4,
      signature: 4,
      docComment: 2,
      receiver: 0,
      package: 4,
      callers: 2,
      tables: 0,
    });
  });

  it("names the fields with no reach as unmeasured", () => {
    expect(unmeasuredFields(contextReach(corpus, context))).toEqual(["receiver", "tables"]);
    expect(
      unmeasuredFields({
        signature: 1,
        docComment: 1,
        receiver: 1,
        package: 1,
        callers: 1,
        tables: 1,
      }),
    ).toEqual([]);
  });

  it("counts a symbol the context does not know as carrying nothing", () => {
    const reach = contextReach(corpus, { own: new Map(), cross: new Map() });
    for (const f of CONTEXT_FIELDS) expect(reach[f]).toBe(0);
    expect(reach.symbols).toBe(4);
  });
});

describe("document variants", () => {
  const corpus = corpusFrom(FILES);
  const context = buildCorpusContext(FILES);
  const searchable = contextualSearchable(corpus, context);
  const save = searchable.find((s) => s.name === "saveUser") as SearchableSymbol;
  const signUp = searchable.find((s) => s.name === "signUp") as SearchableSymbol;

  it("attaches each field a symbol has and no key for one it lacks", () => {
    expect(save).toMatchObject({
      signature: "export function saveUser(user: User): void",
      docstring: "Persists a member so that later logins find the account.",
      package: "store",
      callers: ["importUsers", "signUp"],
    });
    expect("receiver" in save).toBe(false);
    expect("tables" in save).toBe(false);
    expect("callers" in signUp).toBe(false);
  });

  it("builds the baseline BM25 document from name and qualified name only", () => {
    const base = lexicalConfigFor("base");
    expect(base.buildDocumentText(save)).toBe(`saveUser ${save.qualifiedName}`);
    expect(base.tokenizer).toBe(tokenizeCode);
  });

  it("builds the own and full BM25 documents, differing only by cross-file fields", () => {
    const own = lexicalConfigFor("own").buildDocumentText(save);
    const full = lexicalConfigFor("full").buildDocumentText(save);
    expect(own).toBe(
      `saveUser ${save.qualifiedName} store export function saveUser(user: User): void ` +
        "Persists a member so that later logins find the account.",
    );
    expect(full).toBe(`${own} importUsers signUp`);
    expect(lexicalConfigFor("full").buildDocumentText(signUp)).toBe(
      lexicalConfigFor("own").buildDocumentText(signUp),
    );
  });

  it("leaves the base embedding text exactly as main builds it", () => {
    const doc = corpus.docs.find((d) => d.name === "saveUser");
    expect(embeddingTextFor(doc?.text ?? "", doc?.id ?? "", context, "base")).toBe(doc?.text);
    expect(corpusForEmbeddingVariant(corpus, context, "base")).toBe(corpus);
  });

  it("puts own-file lines, then cross-file lines, between the header and the body", () => {
    const doc = corpus.docs.find((d) => d.name === "saveUser");
    const [header, ...body] = (doc?.text ?? "").split("\n");
    const own = embeddingTextFor(doc?.text ?? "", doc?.id ?? "", context, "own");
    const full = embeddingTextFor(doc?.text ?? "", doc?.id ?? "", context, "full");
    expect(own).toBe(
      [
        header,
        "package: store",
        "doc: Persists a member so that later logins find the account.",
        ...body,
      ].join("\n"),
    );
    expect(full).toBe(
      [
        header,
        "package: store",
        "doc: Persists a member so that later logins find the account.",
        "callers: importUsers, signUp",
        ...body,
      ].join("\n"),
    );
  });

  it("returns the base text for a symbol the context does not know", () => {
    expect(embeddingTextFor("h\nbody", "unknown", context, "full")).toBe("h\nbody");
  });

  it("rebuilds every doc of a variant corpus and nothing else", () => {
    const full = corpusForEmbeddingVariant(corpus, context, "full");
    expect(full.searchable).toBe(corpus.searchable);
    expect(full.queries).toBe(corpus.queries);
    expect(full.docs.map((d) => d.id)).toEqual(corpus.docs.map((d) => d.id));
    expect(full.docs.every((d) => d.text.includes("\npackage: "))).toBe(true);
  });
});

describe("the arms are the documents they claim to be, on the committed corpus", () => {
  it("baseline: the pre-#1072 document, which production still builds for a symbol with no context", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    expect(corpus.searchable.length).toBeGreaterThan(700);
    for (const s of corpus.searchable) {
      // `corpus.searchable` carries no context field, as every row did before #1072.
      expect(baselineDocumentText(s)).toBe(buildSymbolDocumentText(s));
    }
  });

  it("own-file: the documents production builds, symbol for symbol", async () => {
    const dir = corpusDir();
    const corpus = await loadEmbedRetrievalCorpus(dir);
    const context = await loadCorpusContext(dir);
    const own = lexicalConfigFor("own");
    let withContext = 0;
    for (const s of contextualSearchable(corpus, context)) {
      // The BM25 document: production's builder over the same fields.
      expect(buildSymbolDocumentText(s), s.symbolId).toBe(own.buildDocumentText(s));
      if (s.docstring || s.package) withContext += 1;
    }
    // The comparison is not vacuous: most symbols do carry a field.
    expect(withContext).toBeGreaterThan(600);
    for (const d of corpus.docs) {
      // The embedding text: the lines production adds, where the measured arm put them.
      const fields = context.own.get(d.id) ?? { package: null, docComment: null };
      expect(composeEmbeddingText(d.text, shippedContextLines(fields)), d.id).toBe(
        embeddingTextFor(d.text, d.id, context, "own"),
      );
    }
  });
});

describe("runContextualAb", () => {
  const corpus = corpusFrom(FILES);
  const context = buildCorpusContext(FILES);

  it("scores the three BM25 variants and makes no decision without an embedder", async () => {
    const report = await runContextualAb(corpus, context, null);
    expect(report.bm25.arms.map((a) => a.armId)).toEqual(["base", "own", "full"]);
    expect(report.bm25.comparisons.map((c) => c.armId)).toEqual(["own", "full"]);
    expect(report.fused).toBeNull();
    expect(report.vector).toBeNull();
    expect(report.decision).toBeNull();
    expect(report.embedCost).toEqual([]);
    expect(report.increments).toEqual({});
    expect(report.unmeasured).toEqual(["receiver", "tables"]);
  });

  it("finds a doc-comment-only requirement with the contextual BM25 document, not the baseline", async () => {
    const report = await runContextualAb(corpus, context, null);
    const q1 = (armId: string): number =>
      report.bm25.arms.find((a) => a.armId === armId)?.perQuery.find((q) => q.queryId === "Q1")
        ?.ndcgAtK[10] ?? -1;
    expect(q1("base")).toBe(0);
    expect(q1("own")).toBe(1);
    expect(q1("full")).toBe(1);
    expect(report.bm25.comparisons[0].minDelta).toBe(0.05);
  });

  it("embeds each variant once, hands each arm the documents it names, and decides", async () => {
    const batches: string[][] = [];
    let clock = 0;
    const lines: string[] = [];
    const report = await runContextualAb(
      corpus,
      context,
      {
        model: "fake-bow",
        embed: async (texts) => {
          if (texts.length > 1) batches.push([...texts]);
          clock += 250;
          return texts.map(bagOfWords);
        },
        now: () => clock,
      },
      (l) => lines.push(l),
    );

    // One symbol batch per embedding variant, in base / own / full order.
    expect(batches).toHaveLength(3);
    expect(batches[0].some((t) => t.includes("\ndoc: "))).toBe(false);
    expect(batches[1].some((t) => t.includes("\ndoc: "))).toBe(true);
    expect(batches[1].some((t) => t.includes("\ncallers: "))).toBe(false);
    expect(batches[2].some((t) => t.includes("\ncallers: importUsers, signUp"))).toBe(true);

    expect(report.embedCost.map((c) => c.variant)).toEqual(["base", "own", "full"]);
    for (const [i, cost] of report.embedCost.entries()) {
      expect(cost.texts).toBe(corpus.docs.length);
      expect(cost.chars).toBe(batches[i].reduce((n, t) => n + t.length, 0));
      // Only the symbol batch is timed: one call, 250 ms on the fake clock.
      expect(cost.ms).toBe(250);
    }
    expect(report.embedCost[1].chars).toBeGreaterThan(report.embedCost[0].chars);
    expect(report.embedCost[2].chars).toBeGreaterThan(report.embedCost[1].chars);

    expect(report.fused?.arms.map((a) => a.armId)).toEqual(CONTEXTUAL_ARMS.map((a) => a.id));
    expect(report.fused?.comparisons.map((c) => c.armId)).toEqual(
      CONTEXTUAL_ARMS.slice(1).map((a) => a.id),
    );
    expect(report.fused?.comparisons.every((c) => c.minDelta === 0.02)).toBe(true);
    expect(report.vector?.arms.map((a) => a.armId)).toEqual(["base", "own", "full"]);
    expect(Object.keys(report.increments).sort()).toEqual(
      [
        incrementKey("contextual", "lexical-cross"),
        incrementKey("contextual", "own-file"),
        incrementKey("lexical-cross", "own-file"),
      ].sort(),
    );
    // An increment is the costlier arm minus the cheaper one.
    const inc = report.increments[incrementKey("contextual", "own-file")];
    const fused = (id: string): number =>
      report.fused?.arms.find((a) => a.armId === id)?.ndcg10 ?? 0;
    expect(inc.paired.meanDelta).toBeCloseTo(fused("contextual") - fused("own-file"), 10);

    // Each embedding variant's store serves exactly the arms that name it: the
    // arms are scored while that store exists, so the order says which read which.
    expect(
      lines
        .map((l) => l.trim().split(/\s+/).slice(0, 2).join(" "))
        .filter((l) => l.startsWith("vector ") || l.startsWith("fused ")),
    ).toEqual([
      "vector base",
      "fused baseline",
      "fused lexical-only",
      "vector own",
      "fused lexical-cross",
      "fused own-file",
      "vector full",
      "fused contextual",
      "fused vector-only",
    ]);

    // The decision is the pre-registered rule applied to exactly these comparisons.
    const vs = (id: string) => {
      const c = report.fused?.comparisons.find((x) => x.armId === id);
      return { verdict: c!.verdict, meanDelta: c!.paired.meanDelta };
    };
    expect(report.decision).toEqual(
      decideContextualShip({
        vsBaseline: {
          "own-file": vs("own-file"),
          "lexical-cross": vs("lexical-cross"),
          contextual: vs("contextual"),
        },
        increments: Object.fromEntries(
          Object.entries(report.increments).map(([k, c]) => [
            k,
            { verdict: c.verdict, meanDelta: c.paired.meanDelta },
          ]),
        ),
      }),
    );
    expect(lines.some((l) => l.includes("fused contextual"))).toBe(true);
    expect(lines.some((l) => l.includes("bm25  base"))).toBe(true);
    expect(lines.some((l) => l.includes("vector full"))).toBe(true);
  });

  it("reports an increment as the costlier arm minus the cheaper one", async () => {
    // One requirement that only caller names answer, and an embedder that puts
    // the symbols whose text has a `callers:` line next to every query. Only the
    // `full` documents can rank the target first, so the costlier arm is ahead
    // and the delta has a sign to get wrong.
    const callersOnly = {
      ...corpus,
      queries: corpus.queries.filter((q) => q.id === "Q4"),
    };
    const report = await runContextualAb(callersOnly, context, {
      model: "callers-aware",
      embed: async (texts) =>
        texts.map((t) => (t.includes("\ncallers: ") || !t.includes("\n") ? [1, 0] : [0, 1])),
    });
    const ndcg = (id: string): number =>
      report.fused?.arms.find((a) => a.armId === id)?.ndcg10 ?? -1;
    expect(ndcg("contextual")).toBe(1);
    expect(ndcg("own-file")).toBeLessThan(1);
    const inc = report.increments[incrementKey("contextual", "own-file")];
    expect(inc.paired.meanDelta).toBeCloseTo(ndcg("contextual") - ndcg("own-file"), 10);
    expect(inc.paired.meanDelta).toBeGreaterThan(0);
    expect(inc.paired.wins).toBe(1);
    expect(inc.paired.losses).toBe(0);
    expect(inc.armId).toBe("contextual");
  });

  it("pairs each fused arm with its own lexical variant", async () => {
    // A requirement only the doc comment answers, and an embedder that ranks
    // its target LAST whatever the text: the vector channel puts `saveUser`
    // fourth of four in every arm, so only the BM25 document can lift it.
    const biased = {
      model: "biased",
      embed: async (texts: string[]) =>
        texts.map((t) => (t.startsWith("function saveUser in ") ? [0.1, 0.995] : [1, 0])),
    };
    const report = await runContextualAb(corpus, context, biased);
    const q1 = (armId: string): number =>
      report.fused?.arms.find((a) => a.armId === armId)?.perQuery.find((q) => q.queryId === "Q1")
        ?.reciprocalRank ?? -1;
    // RRF at 0.05 / 0.95: a BM25 rank of 1 plus a vector rank of 4 beats a
    // vector rank of 1 alone, so an arm whose BM25 document carries the doc
    // comment ranks the target first and an arm whose document is `base`
    // leaves it last.
    for (const arm of ["contextual", "lexical-cross", "own-file", "lexical-only"]) {
      expect(q1(arm), arm).toBe(1);
    }
    for (const arm of ["baseline", "vector-only"]) {
      expect(q1(arm), arm).toBe(0.25);
    }
  });
});

describe("rendering", () => {
  const corpus = corpusFrom(FILES);
  const context = buildCorpusContext(FILES);
  const meta = { corpusId: "t", snapshotCommit: "abc", queries: 3, ranAt: "2026-10-12T00:00:00Z" };

  it("marks an unmeasured field in the reach table", () => {
    const md = renderReach({
      reach: contextReach(corpus, context),
      unmeasured: ["receiver", "tables"],
    });
    expect(md).toContain("| signature | 4 | 4 |  |");
    expect(md).toContain("| tables | 0 | 4 | **no reach — unmeasured");
    expect(md).toContain("| receiver | 0 | 4 | **no reach");
  });

  it("renders the embedding cost with a mean and a dash for an empty variant", () => {
    const md = renderEmbedCost([
      { variant: "base", texts: 4, chars: 400, ms: 1500 },
      { variant: "own", texts: 0, chars: 0, ms: 0 },
    ]);
    expect(md).toContain("| base | 4 | 400 | 100 | 1.5 s |");
    expect(md).toContain("| own | 0 | 0 | — | 0.0 s |");
  });

  it("says the fused channel was not measured when it was not", async () => {
    const report = await runContextualAb(corpus, context, null);
    const md = renderContextualAb(report, meta);
    expect(md).toContain("NOT MEASURED — no model weights in this run. No decision.");
    expect(md).toContain("## Pure BM25");
    expect(md).not.toContain("## Pure vector");
    expect(md).not.toContain("## Embedding cost");
    expect(md).toContain("Corpus: `t` (`snapshotCommit` abc) — 4 symbols, 3 requirements.");
  });

  it("renders every channel, the increments and the decision when measured", async () => {
    const report: ContextualAbReport = await runContextualAb(corpus, context, {
      model: "fake-bow",
      embed: async (texts) => texts.map(bagOfWords),
    });
    const md = renderContextualAb(report, meta);
    expect(md).toContain("## Fused at `DEFAULT_WEIGHTS` — the decision channel");
    expect(md).toContain("Pre-registered bar: +0.020 nDCG@10.");
    expect(md).toContain("Pre-registered bar: +0.050 nDCG@10.");
    expect(md).toContain(`**Ships: ${report.decision?.ship}**`);
    expect(md).toContain(`- ${report.decision?.reasons[0]}`);
    expect(md).toContain("## Pure vector (`0.00 / 1.00`) — attribution only");
    expect(md).toContain("## Embedding cost on this corpus");
    expect(md).toContain("Exact-name misses, by name:");
    const inc = renderIncrements(report.increments);
    expect(inc).toContain("| `contextual vs own-file` |");
    expect(inc.split("\n")).toHaveLength(2 + 3);
    expect(md).toContain(inc);
  });

  it("signs a negative increment", () => {
    const c = {
      paired: {
        meanDelta: -0.0123,
        ciLow: -0.03,
        ciHigh: 0.01,
        wins: 1,
        losses: 2,
        ties: 3,
        signTestP: 0.5,
      },
      verdict: "NOT-ESTABLISHED",
    };
    const md = renderIncrements({ "a vs b": c as never });
    expect(md).toContain(
      "| `a vs b` | -0.012 | [-0.030, 0.010] | 1/2/3 | 0.500 | **NOT-ESTABLISHED** |",
    );
    const pos = { ...c, paired: { ...c.paired, meanDelta: 0.02 } };
    expect(renderIncrements({ "a vs b": pos as never })).toContain("| +0.020 |");
  });
});

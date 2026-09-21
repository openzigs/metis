/**
 * Epic #929 / Issue #930 — fixture loader + in-memory data-source builders for
 * the Impact Analysis recall eval. Asserts the committed JPetStore-6 manifest
 * loads and assembles, the BM25 searcher ranks the real corpus, and the in-memory
 * schema data source mirrors `PrismaSchemaImpactDataSource` edge semantics.
 */
import { describe, expect, it } from "vitest";
import {
  assembleFixture,
  buildSyntheticFixture,
  computeSharedTableConsumers,
  DEFAULT_IMPACT_RECALL_CORPUS,
  defaultImpactRecallFixtureDir,
  IMPACT_RECALL_CORPORA,
  fixtureEntityVocabulary,
  loadImpactRecallFixture,
  resolveCorpusDir,
  sharedTablesOf,
  type ImpactRecallManifest,
} from "../src/lib/eval/impact-recall/fixture.js";

describe("loadImpactRecallFixture", () => {
  it("loads and assembles the committed JPetStore-6 fixture", async () => {
    const fx = await loadImpactRecallFixture();
    expect(fx.manifest.id).toBe("impact-recall-01-jpetstore");
    expect(fx.requirements.length).toBe(11);
    expect(fx.manifest.tables.length).toBeGreaterThan(0);
    // Every requirement carries the primary (tables) label.
    for (const r of fx.requirements) expect(r.expectedTables.length).toBeGreaterThan(0);
  });

  it("derives the #1002 entity-seed grounding vocabulary from the fixture's own graph", async () => {
    const fx = await loadImpactRecallFixture();
    const vocab = fixtureEntityVocabulary(fx.manifest);

    // Tables come from the schema side; code TYPES from the in-corpus symbols.
    expect(vocab.tables).toContain("account");
    expect(vocab.tables).toContain("orders");
    expect(vocab.symbols).toContain("AccountMapper");
    expect(vocab.symbols).toContain("OrderMapper");
    // Method names are NOT groundable entities — the type is the entity.
    expect(vocab.symbols).not.toContain("updateAccount");
    // #1003 — the `src/site/**` documentation rows must never be offered as a
    // groundable entity, or the union could re-seed the noise #1003 removed.
    expect(vocab.symbols.some((s) => /cancelorderpage/i.test(s))).toBe(false);
  });

  it("builds a BM25 searcher that ranks the corpus for a requirement", async () => {
    const fx = await loadImpactRecallFixture();
    const hits = await fx.searcher.search("update product", fx.projectId, { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // The top hit for "update product" should be a product/update method.
    expect(hits[0].qualifiedName.toLowerCase()).toContain("product");
  });

  it("is LAYERED (#939): domain/service/web-action corpus symbols beside the mappers", async () => {
    const fx = await loadImpactRecallFixture();
    const corpus = fx.manifest.codeSymbols.filter((s) => s.inCorpus);
    const qns = corpus.map((s) => s.qualifiedName);

    // Every application layer contributes IN-CORPUS symbols (BM25 seed pollution).
    // #1016 — the corpus carries production's `path/File.java::Type::member` shape,
    // so a layer is identified by its DIRECTORY, not by a dotted package prefix.
    expect(qns.some((q) => q.startsWith("domain/"))).toBe(true);
    expect(qns.some((q) => q.startsWith("service/"))).toBe(true);
    expect(qns.some((q) => q.startsWith("web/actions/"))).toBe(true);
    expect(qns.some((q) => q.startsWith("persistence/"))).toBe(true);
    // The mapper-only pre-#939 corpus had ~26 symbols; the layered one is far larger.
    expect(corpus.length).toBeGreaterThan(50);

    // MyBatis statement symbols stay OUT of the BM25 corpus (schema-only).
    const statements = fx.manifest.codeSymbols.filter((s) => s.language === "sql");
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((s) => s.inCorpus === false)).toBe(true);
  });

  it("wires `calls` edges ACROSS layers so the crossing fans out (web-action → service → mapper)", async () => {
    const fx = await loadImpactRecallFixture();
    const callEdges = fx.manifest.edges.filter((e) => e.kind === "calls");
    expect(callEdges.length).toBeGreaterThan(0);

    const crosses = (fromPrefix: string, toPrefix: string): boolean =>
      callEdges.some((e) => e.from.startsWith(fromPrefix) && e.to.startsWith(toPrefix));

    // web-action → service and service → mapper are both present (the fan-out path).
    expect(crosses("web/actions/", "service/")).toBe(true);
    expect(crosses("service/", "persistence/")).toBe(true);

    // The layered `calls` edges are fed into the code graph, so a mapper method has
    // real upstream callers (what makes the blast radius climb + fan out downstream).
    const insertOrderId = fx.manifest.codeSymbols.find(
      (s) => s.qualifiedName === "persistence/OrderMapper.java::OrderMapper::insertOrder",
    )!.id;
    const callers = await fx.codeDataSource.getEdgesTo(insertOrderId);
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.every((e) => e.kind === "calls")).toBe(true);
  });
});

describe("corpus registry + dir resolution (#959)", () => {
  it("resolves a registered corpus to a directory ending in its name", () => {
    const dir = resolveCorpusDir("impact-recall-02-shared-db");
    expect(dir.endsWith("/eval-data/corpus/impact-recall-02-shared-db")).toBe(true);
  });

  it("keeps the default fixture dir pointed at corpus-01 (byte-identical default)", () => {
    expect(DEFAULT_IMPACT_RECALL_CORPUS).toBe("impact-recall-01-jpetstore");
    expect(defaultImpactRecallFixtureDir()).toBe(resolveCorpusDir("impact-recall-01-jpetstore"));
  });

  it("throws with the known names on an unknown corpus (no silent default)", () => {
    expect(() => resolveCorpusDir("nope")).toThrow(/unknown impact-recall corpus/i);
    expect(() => resolveCorpusDir("nope")).toThrow(/impact-recall-01-jpetstore/);
  });

  it("registers both corpora", () => {
    expect(IMPACT_RECALL_CORPORA).toContain("impact-recall-01-jpetstore");
    expect(IMPACT_RECALL_CORPORA).toContain("impact-recall-02-shared-db");
  });
});

describe("computeSharedTableConsumers / sharedTablesOf (#959)", () => {
  const manifest: ImpactRecallManifest = {
    version: 1,
    id: "x",
    title: "t",
    note: "n",
    projectId: "pool",
    projects: [
      { id: "proj-a", title: "A", role: "storefront" },
      { id: "proj-b", title: "B", role: "reporting" },
    ],
    tables: [
      { id: "t_acct", name: "account", qualifiedName: "account", kind: "table", source: "mybatis" },
      { id: "t_cart", name: "cart", qualifiedName: "cart", kind: "table", source: "mybatis" },
    ],
    codeSymbols: [
      {
        id: "a_stmt",
        name: "readAcct.statement",
        qualifiedName: "a.AMapper.readAcct.statement",
        kind: "method",
        filePath: "a.xml",
        language: "sql",
        inCorpus: false,
        projectId: "proj-a",
      },
      {
        id: "b_stmt",
        name: "readAcct.statement",
        qualifiedName: "b.BMapper.readAcct.statement",
        kind: "method",
        filePath: "b.xml",
        language: "sql",
        inCorpus: false,
        projectId: "proj-b",
      },
      {
        id: "a_cart_stmt",
        name: "readCart.statement",
        qualifiedName: "a.CartMapper.readCart.statement",
        kind: "method",
        filePath: "a.xml",
        language: "sql",
        inCorpus: false,
        projectId: "proj-a",
      },
    ],
    edges: [
      { from: "a.AMapper.readAcct.statement", to: "account", kind: "reads" },
      { from: "b.BMapper.readAcct.statement", to: "account", kind: "reads" },
      { from: "a.CartMapper.readCart.statement", to: "cart", kind: "reads" },
    ],
    requirements: [],
  };

  it("attributes each table to the SET of projects that touch it", () => {
    const consumers = computeSharedTableConsumers(manifest);
    expect([...(consumers.get("account") ?? [])].sort()).toEqual(["proj-a", "proj-b"]);
    expect([...(consumers.get("cart") ?? [])]).toEqual(["proj-a"]);
  });

  it("reports only ≥2-project tables as SHARED", () => {
    expect(sharedTablesOf(manifest)).toEqual(["account"]); // cart is single-project
  });

  it("falls back to manifest.projectId when a symbol has no projectId", () => {
    const flat: ImpactRecallManifest = {
      ...manifest,
      codeSymbols: manifest.codeSymbols.map(({ projectId: _drop, ...rest }) => rest),
    };
    // Every statement now belongs to the pooled project ⇒ nothing is cross-project.
    expect(sharedTablesOf(flat)).toEqual([]);
  });
});

describe("cross-project corpus-02 manifest (#959)", () => {
  it("loads, declares two projects, and shares account/orders across them", async () => {
    const fx = await loadImpactRecallFixture(resolveCorpusDir("impact-recall-02-shared-db"));
    expect(fx.manifest.id).toBe("impact-recall-02-shared-db");
    expect(fx.manifest.projects?.map((p) => p.id).sort()).toEqual([
      "impact-recall-02-reporting",
      "impact-recall-02-storefront",
    ]);
    expect(sharedTablesOf(fx.manifest)).toEqual(["account", "orders"]);
  });

  it("labels the shared-table requirements with the reporting app as expected consumer", async () => {
    const fx = await loadImpactRecallFixture(resolveCorpusDir("impact-recall-02-shared-db"));
    const req01 = fx.requirements.find((r) => r.id === "REQ-01")!;
    expect(req01.expectedTables).toEqual(["account"]);
    expect(req01.expectedConsumers).toEqual(["impact-recall-02-reporting"]);
    // The private-table requirement declares NO consumer key (not consumer-scored).
    const req03 = fx.requirements.find((r) => r.id === "REQ-03")!;
    expect(req03.expectedConsumers).toBeUndefined();
  });
});

describe("buildSyntheticFixture schema data source", () => {
  const fx = buildSyntheticFixture();
  const ds = fx.schemaDataSource;

  it("returns downstream calls/executes edges for the reachability walk", async () => {
    const edges = await ds.getDownstreamCallEdgesFrom!(["m_readalpha"]);
    expect(edges).toEqual([{ fromSymbolId: "m_readalpha", toSymbolId: "s_readalpha" }]);
  });

  it("returns reads/writes schema edges from the statement symbol", async () => {
    const edges = await ds.getSchemaEdgesFrom(["s_readalpha"]);
    expect(edges).toEqual([{ fromSymbolId: "s_readalpha", toSymbolId: "t_alpha", kind: "reads" }]);
  });

  it("resolves only table/column/routine symbols (drops the statement method)", async () => {
    const syms = await ds.getSchemaSymbolsByIds(["t_alpha", "s_readalpha"]);
    expect(syms.map((s) => s.id)).toEqual(["t_alpha"]);
    expect(syms[0].kind).toBe("table");
  });

  it("exposes DAO sibling hooks: same-mapper methods, statements excluded", async () => {
    const ids = await ds.getCodeSymbolsByIds!(["m_readalpha"]);
    expect(ids[0].qualifiedName).toBe("DataMapper.java::DataMapper::readAlpha");
    // The enclosing "type" of a production-shaped name is everything up to the last
    // `.` — i.e. the path-rooted `DataMapper` — exactly as `schema-impact.ts` derives
    // it in production. This is the parity that keeps sibling expansion measurable.
    const siblings = await ds.getSiblingMethodIds!(["DataMapper"]);
    // Both mapper methods, but NOT the language=sql statement symbols.
    expect(siblings.map((s) => s.id).sort()).toEqual(["m_readalpha", "m_readbeta"]);
  });
});

describe("assembleFixture", () => {
  it("resolves edge endpoints declared by qualifiedName to symbol ids", async () => {
    const manifest: ImpactRecallManifest = {
      version: 1,
      id: "tiny",
      title: "t",
      note: "n",
      projectId: "p",
      tables: [{ id: "t_x", name: "x", qualifiedName: "x", kind: "table", source: "mybatis" }],
      codeSymbols: [
        {
          id: "m_get",
          name: "getX",
          qualifiedName: "pkg.XMapper.getX",
          kind: "method",
          filePath: "XMapper.java",
          language: "java",
          inCorpus: true,
        },
        {
          id: "s_get",
          name: "getX.statement",
          qualifiedName: "pkg.XMapper.getX.statement",
          kind: "method",
          filePath: "XMapper.xml",
          language: "sql",
          inCorpus: false,
        },
      ],
      edges: [
        { from: "pkg.XMapper.getX", to: "pkg.XMapper.getX.statement", kind: "executes" },
        { from: "pkg.XMapper.getX.statement", to: "x", kind: "reads" },
      ],
      requirements: [{ id: "R1", text: "x", expectedTables: ["x"] }],
    };
    const fx = assembleFixture(manifest);
    const downstream = await fx.schemaDataSource.getDownstreamCallEdgesFrom!(["m_get"]);
    expect(downstream).toEqual([{ fromSymbolId: "m_get", toSymbolId: "s_get" }]);
    const schemaEdges = await fx.schemaDataSource.getSchemaEdgesFrom(["s_get"]);
    expect(schemaEdges).toEqual([{ fromSymbolId: "s_get", toSymbolId: "t_x", kind: "reads" }]);
  });

  it("feeds `calls` edges into the code-graph data source for the blast radius", async () => {
    const manifest: ImpactRecallManifest = {
      version: 1,
      id: "tiny-calls",
      title: "t",
      note: "n",
      projectId: "p",
      tables: [],
      codeSymbols: [
        {
          id: "svc",
          name: "doThing",
          qualifiedName: "pkg.Service.doThing",
          kind: "method",
          filePath: "Service.java",
          language: "java",
          inCorpus: true,
        },
        {
          id: "mpr",
          name: "getThing",
          qualifiedName: "pkg.ThingMapper.getThing",
          kind: "method",
          filePath: "ThingMapper.java",
          language: "java",
          inCorpus: true,
        },
      ],
      edges: [{ from: "pkg.Service.doThing", to: "pkg.ThingMapper.getThing", kind: "calls" }],
      requirements: [{ id: "R1", text: "thing", expectedTables: [] }],
    };
    const fx = assembleFixture(manifest);
    // The caller is reachable UP the graph from the callee (blast radius walks callers).
    const callers = await fx.codeDataSource.getEdgesTo("mpr");
    expect(callers).toEqual([
      { id: "code-edge-0", fromSymbolId: "svc", toSymbolId: "mpr", kind: "calls" },
    ]);
  });
});

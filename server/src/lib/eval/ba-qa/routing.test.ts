/** #2336 Part A — the routing set, the offline router and its scores. */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baQaCorpusDir, BAQA_CORPUS, parseBaQaFixture, type BaQaFixture } from "./fixture.js";
import {
  answerableIn,
  bySignals,
  contentTokens,
  DEFAULT_ROUTING_OPTIONS,
  evidenceFromHits,
  evidenceScores,
  formatRoutingReport,
  inTopK,
  mentions,
  parseRoutingFixture,
  rankAcrossProjects,
  routeProjects,
  scopeOf,
  summarizeRetrieval,
  summarizeRouting,
  type ProbeEvidence,
  type RetrievalRun,
  type RoutingProduct,
  type RoutingSample,
} from "./routing.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const SHA = "a".repeat(40);
const baqa: BaQaFixture = parseBaQaFixture({
  id: "t",
  version: 1,
  issue: 1,
  description: "d",
  license: "l",
  authoredBy: "a",
  products: [
    {
      name: "srv",
      title: "S",
      url: "https://github.com/o/srv",
      ref: "v1",
      sha: SHA,
      documents: [],
    },
    {
      name: "cli",
      title: "C",
      url: "https://github.com/o/cli",
      ref: "v1",
      sha: SHA,
      documents: [],
    },
  ],
  questions: [
    {
      id: "S1",
      category: "single-product",
      scope: ["srv"],
      text: "How does the server refresh feeds?",
      expect: "answer",
      facts: [{ id: "S1.a", text: "f" }],
      sources: [{ product: "srv", path: "feed.go" }],
    },
    {
      id: "M1",
      category: "multi-product",
      scope: ["srv", "cli"],
      text: "What changes in both?",
      expect: "answer",
      facts: [{ id: "M1.a", text: "f" }],
      // The client's source first: answerIn follows the pool's order, not this one.
      sources: [
        { product: "cli", path: "client.py" },
        { product: "srv", path: "api.go" },
      ],
    },
    {
      id: "U1",
      category: "unanswerable",
      scope: ["srv"],
      text: "Price?",
      expect: "abstain",
      why: "w",
    },
  ],
});

const product = (name: string, extra: Partial<RoutingProduct> = {}): RoutingProduct => ({
  name,
  title: name,
  aliases: [],
  description: "",
  tags: [],
  source: { kind: "materialized", corpus: "c", repo: name },
  ...extra,
});

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r",
    version: 1,
    issue: 2336,
    description: "d",
    license: "CC0-1.0",
    authoredBy: "a",
    products: [
      { ...product("srv"), source: { kind: "baqa" } },
      { ...product("cli"), source: { kind: "baqa" } },
      {
        ...product("docs"),
        source: { kind: "documents", files: [{ file: "x/y.md", uploadAs: "y.md" }] },
      },
    ],
    scopeSizes: [2, 3],
    questions: [
      { id: "R1", from: "S1" },
      { id: "R2", from: "M1" },
      { id: "R3", text: "What does the doc say?", answerIn: ["docs"] },
      { id: "R4", text: "zzz", answerIn: [] },
    ],
    ...over,
  };
}

describe("parseRoutingFixture", () => {
  it("takes a from-question's text, answer products and expected files from the question set", () => {
    const f = parseRoutingFixture(raw(), baqa);
    expect(f.questions[0]).toEqual({
      id: "R1",
      from: "S1",
      text: "How does the server refresh feeds?",
      answerIn: ["srv"],
      expectedFiles: ["srv:feed.go"],
    });
    expect(f.questions[1].answerIn).toEqual(["srv", "cli"]);
    expect(f.questions[1].expectedFiles).toEqual(["cli:client.py", "srv:api.go"]);
    expect(f.questions[2]).toEqual({
      id: "R3",
      text: "What does the doc say?",
      answerIn: ["docs"],
      expectedFiles: [],
    });
    expect(f.questions[3].answerIn).toEqual([]);
  });

  it("accepts the committed routing set against the committed question set", () => {
    const dir = baQaCorpusDir(REPO_ROOT, BAQA_CORPUS);
    const questions = parseBaQaFixture(
      JSON.parse(readFileSync(path.join(dir, "questions.json"), "utf8")),
    );
    const f = parseRoutingFixture(
      JSON.parse(readFileSync(path.join(dir, "routing.json"), "utf8")),
      questions,
    );
    expect(f.questions).toHaveLength(20);
    expect(f.products).toHaveLength(9);
    expect(f.scopeSizes).toEqual([2, 5, 9]);
    // The 10 answerable questions the routing measurement ran on. Questions added to
    // the set since (S7 to S11, #2198) are not taken: the recorded numbers stay comparable.
    expect(f.questions.flatMap((q) => (q.from ? [q.from] : []))).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "M1",
      "M2",
      "M3",
      "M4",
    ]);
    // Every question is answerable in the widest scope.
    const widest = scopeOf(f, 9);
    expect(f.questions.every((q) => answerableIn(q, widest))).toBe(true);
  });

  it.each([
    [
      "a pool that does not start with the question set's products",
      { products: [] },
      /Too small|must start/,
    ],
    [
      "a pool in another order",
      {
        products: [
          { ...product("cli"), source: { kind: "baqa" } },
          { ...product("srv"), source: { kind: "baqa" } },
        ],
      },
      /must start/,
    ],
    [
      "a distractor claiming to be a question-set product",
      {
        products: [
          { ...product("srv"), source: { kind: "baqa" } },
          { ...product("cli"), source: { kind: "baqa" } },
          { ...product("x"), source: { kind: "baqa" } },
        ],
        scopeSizes: [2],
      },
      /x is not a product of the question set/,
    ],
    [
      "a product listed twice",
      {
        products: [
          { ...product("srv"), source: { kind: "baqa" } },
          { ...product("cli"), source: { kind: "baqa" } },
          product("cli"),
        ],
        scopeSizes: [2],
      },
      /cli is listed twice/,
    ],
    ["scope sizes that do not increase", { scopeSizes: [3, 2] }, /must increase/],
    ["a scope wider than the pool", { scopeSizes: [2, 4] }, /larger than the pool/],
    [
      "a question listed twice",
      {
        questions: [
          { id: "R1", from: "S1" },
          { id: "R1", from: "M1" },
        ],
      },
      /R1 is listed twice/,
    ],
    [
      "a from-question with its own text",
      { questions: [{ id: "R1", from: "S1", text: "t" }] },
      /carries no text/,
    ],
    ["an unknown from-question", { questions: [{ id: "R1", from: "S9" }] }, /unknown question S9/],
    [
      "a from-question that expects no answer",
      { questions: [{ id: "R1", from: "U1" }] },
      /expects no answer/,
    ],
    [
      "a question with neither from nor answerIn",
      { questions: [{ id: "R1", text: "t" }] },
      /needs either from/,
    ],
    [
      "an unknown answer product",
      { questions: [{ id: "R1", text: "t", answerIn: ["nope"] }] },
      /unknown product nope/,
    ],
    [
      "an answer product named twice",
      { questions: [{ id: "R1", text: "t", answerIn: ["srv", "srv"] }] },
      /names a product twice/,
    ],
    [
      "a description past its bound",
      {
        products: [
          { ...product("srv", { description: "x".repeat(241) }), source: { kind: "baqa" } },
          { ...product("cli"), source: { kind: "baqa" } },
        ],
        scopeSizes: [2],
      },
      /description/,
    ],
  ])("refuses %s", (_label, over, error) => {
    expect(() => parseRoutingFixture(raw(over), baqa)).toThrow(error);
  });
});

describe("contentTokens and mentions", () => {
  it("drops question words and short words, and a plural ending", () => {
    expect([...contentTokens("How does the server check feeds and categories, or a key?")]).toEqual(
      ["server", "check", "feed", "category", "key"],
    );
    expect([...contentTokens("class access")]).toEqual(["class", "access"]);
  });

  it("finds a product named by its name, title or an alias, as whole words only", () => {
    const p = product("python-client", {
      title: "Acme Python client",
      aliases: ["miniflux-python"],
    });
    expect(mentions("In the python client, what fails?", p)).toBe(true);
    expect(mentions("What does python-client raise?", p)).toBe(true);
    expect(mentions("Does ACME PYTHON CLIENT retry?", p)).toBe(true);
    expect(mentions("Is miniflux-python on PyPI?", p)).toBe(true);
    expect(mentions("Is the python clientele happy?", p)).toBe(false);
    expect(mentions("What does the server do?", p)).toBe(false);
  });
});

const ev = (terms: string[], keyword = terms.length): ProbeEvidence => ({
  hits: 8,
  keyword,
  terms,
});

describe("evidenceFromHits", () => {
  it("counts only keyword-backed hits, and only the question's words they hold", () => {
    const e = evidenceFromHits("When are invoices emailed to customers?", [
      { text: "Invoices are emailed nightly.", matchedBy: ["dense", "lexical"] },
      { text: "Customers and invoices tables.", matchedBy: ["lexical"] },
      // A dense neighbour holds a question word, but a vector match is no evidence.
      { text: "When a feed is refreshed.", matchedBy: ["dense"] },
      { text: "No matcher recorded: refreshed." },
    ]);
    expect(e).toEqual({ hits: 4, keyword: 2, terms: ["customer", "emailed", "invoice"] });
  });

  it("gives a gibberish question nothing, whatever the dense search returned", () => {
    const e = evidenceFromHits("xqzv blorf wibble", [
      { text: "anything at all", matchedBy: ["dense"] },
      { text: "more of it", matchedBy: ["dense"] },
    ]);
    expect(e).toEqual({ hits: 2, keyword: 0, terms: [] });
  });
});

describe("evidenceScores", () => {
  it("weights a word by how few projects hold it, and ignores words none holds", () => {
    const s = evidenceScores(
      ["a", "b", "c"],
      new Map([
        ["a", ev(["invoice", "email"])],
        ["b", ev(["email"])],
        ["c", ev([])],
      ]),
    );
    // "invoice" (one project) outweighs "email" (two): a holds both, so all of it.
    expect(s.get("a")).toBe(1);
    const wInvoice = Math.log(1 + 3 / 1);
    const wEmail = Math.log(1 + 3 / 2);
    expect(s.get("b")).toBeCloseTo(wEmail / (wInvoice + wEmail), 10);
    expect(s.get("c")).toBe(0);
  });

  it("is zero everywhere when no keyword hit holds a question word", () => {
    const s = evidenceScores(["a", "b"], new Map([["a", ev([], 0)]]));
    expect([...s.values()]).toEqual([0, 0]);
  });
});

describe("routeProjects", () => {
  const scope = [
    product("srv", {
      description: "The feed server: refresh, entries and users.",
      tags: ["feeds"],
    }),
    product("cli", { aliases: ["Python client"], description: "A Python library for the API." }),
    product("billing", { description: "Issues invoices for orders.", tags: ["invoices"] }),
  ];

  it("falls back to every project for a gibberish question: no keyword evidence anywhere", () => {
    // Dense hits exist for anything, but they carry no keyword evidence.
    const d = routeProjects(
      "xqzv blorf wibble",
      scope,
      new Map(scope.map((p) => [p.name, ev([], 0)])),
    );
    expect(d.route).toBe("fallback");
    expect(d.reason).toBe("no-evidence");
    expect(d.chosen).toEqual(["srv", "cli", "billing"]);
  });

  it("routes to the projects whose profile and evidence agree, in scope order", () => {
    const d = routeProjects(
      "When are invoices issued for an order?",
      scope,
      new Map([
        ["srv", ev([])],
        ["cli", ev([])],
        ["billing", ev(["invoice", "issued", "order"])],
      ]),
    );
    expect(d.route).toBe("routed");
    expect(d.chosen).toEqual(["billing"]);
    expect(d.ranked[0]).toMatchObject({ name: "billing", mentioned: false });
    expect(d.ranked[0].evidence).toBe(1);
    expect(d.ranked[0].profile).toBeCloseTo(2 / 3, 10);
  });

  it("always includes a product the question names, however weak its signals", () => {
    const d = routeProjects(
      "In the Python client, when are invoices issued?",
      scope,
      new Map([
        ["srv", ev([])],
        ["cli", ev([])],
        ["billing", ev(["invoice", "issued"])],
      ]),
    );
    expect(d.route).toBe("routed");
    expect(d.chosen).toEqual(["cli", "billing"]);
    expect(d.ranked[0]).toMatchObject({ name: "cli", mentioned: true });
    // Named: it is chosen even with no evidence; the floor does not apply to it.
    const only = routeProjects(
      "Python client?",
      scope,
      new Map(scope.map((p) => [p.name, ev([], 0)])),
    );
    expect(only).toMatchObject({ route: "routed", chosen: ["cli"] });
    // A named product later in the scope than a chosen one: the choice keeps scope order.
    const later = routeProjects(
      "Does billing see a feed refresh?",
      scope,
      new Map([
        ["srv", ev(["feed", "refresh"])],
        ["cli", ev([])],
        ["billing", ev([])],
      ]),
    );
    expect(later.ranked[0].name).toBe("billing");
    expect(later.chosen).toEqual(["srv", "billing"]);
  });

  it("falls back below the floor when no product is named", () => {
    const d = routeProjects(
      "What colour are the totally unrelated widgets everywhere?",
      scope,
      new Map([
        ["srv", ev(["widget"])],
        ["cli", ev(["widget"])],
        ["billing", ev(["widget"])],
      ]),
      { ...DEFAULT_ROUTING_OPTIONS, floor: 0.75 },
    );
    expect(d).toMatchObject({ route: "fallback", reason: "low-confidence" });
    expect(d.chosen).toHaveLength(3);
  });

  it("falls back when the profile and the evidence point at different projects", () => {
    const d = routeProjects(
      "How are feeds refreshed?",
      scope,
      new Map([
        ["srv", ev([])],
        ["cli", ev([])],
        ["billing", ev(["refreshed"])],
      ]),
    );
    expect(d).toMatchObject({ route: "fallback", reason: "signals-disagree" });
    expect(d.chosen).toEqual(["srv", "cli", "billing"]);
  });

  it("keeps a project at the keep ratio of the best score and drops one below it", () => {
    const evidence = new Map([
      ["srv", ev(["feed", "refresh", "user"])],
      ["cli", ev(["user"])],
      ["billing", ev([])],
    ]);
    const q = "How does the feed refresh treat a user?";
    expect(routeProjects(q, scope, evidence).chosen).toEqual(["srv"]);
    expect(
      routeProjects(q, scope, evidence, { ...DEFAULT_ROUTING_OPTIONS, keepRatio: 0.1 }).chosen,
    ).toEqual(["srv", "cli"]);
  });

  it("only narrows: it never chooses a project outside the scope, and an empty profile adds nothing", () => {
    const bare = [product("a"), product("b")];
    const d = routeProjects(
      "invoice totals",
      bare,
      new Map([
        ["a", ev(["invoice", "total"])],
        ["outside", ev(["invoice", "total"])],
      ]),
    );
    expect(d.chosen).toEqual(["a"]);
    expect(d.ranked.map((r) => r.name)).toEqual(["a", "b"]);
    expect(d.ranked.every((r) => r.profile === 0)).toBe(true);
  });
});

describe("scores", () => {
  const ranked = [
    { name: "x", profile: 0, evidence: 0, score: 0.1, mentioned: true },
    { name: "y", profile: 0, evidence: 0, score: 0.9, mentioned: false },
    { name: "z", profile: 0, evidence: 0, score: 0.5, mentioned: false },
  ];

  it("inTopK needs every answer product among the first k; bySignals ignores a mention", () => {
    expect(inTopK(ranked, ["x"], 1)).toBe(true);
    expect(inTopK(ranked, ["x", "z"], 2)).toBe(false);
    expect(inTopK(ranked, ["x", "z"], 3)).toBe(true);
    expect(bySignals(ranked).map((r) => r.name)).toEqual(["y", "z", "x"]);
    expect(ranked.map((r) => r.name)).toEqual(["x", "y", "z"]);
  });

  it("summarizeRouting counts top k, the router's own choice and fallbacks per scope", () => {
    const routed = { ranked, route: "routed" as const, chosen: ["x", "y"] };
    const samples: RoutingSample[] = [
      { questionId: "R1", scopeSize: 3, answerIn: ["x"], decision: routed },
      { questionId: "R2", scopeSize: 3, answerIn: ["z"], decision: routed },
      {
        questionId: "R3",
        scopeSize: 3,
        answerIn: ["y"],
        decision: {
          ranked,
          route: "fallback",
          reason: "signals-disagree",
          chosen: ["x", "y", "z"],
        },
      },
      {
        questionId: "R4",
        scopeSize: 3,
        answerIn: [],
        decision: { ranked, route: "fallback", reason: "no-evidence", chosen: ["x", "y", "z"] },
      },
      { questionId: "R5", scopeSize: 3, answerIn: [], decision: routed },
      { questionId: "R1", scopeSize: 2, answerIn: ["x"], decision: routed },
    ];
    const [two, three] = summarizeRouting(samples);
    expect(two).toMatchObject({ scopeSize: 2, answerable: 1, top1: { n: 1, of: 1 } });
    expect(three).toMatchObject({
      scopeSize: 3,
      answerable: 3,
      top1: { n: 1, of: 3 },
      top2: { n: 2, of: 3 },
      top3: { n: 3, of: 3 },
      signalsTop1: { n: 1, of: 3 },
      signalsTop2: { n: 2, of: 3 },
      routed: { n: 2, of: 3 },
      routedRight: { n: 1, of: 2 },
      noAnswerFallback: { n: 1, of: 2 },
    });
    expect(three.meanSearched).toBeCloseTo((2 + 2 + 3) / 3, 10);
  });

  it("rankAcrossProjects merges on cosine, a keyword-only hit last, and keeps k", () => {
    const h = (product: string, cosine: number | null) => ({
      product,
      key: `${product}:${cosine}`,
      cosine,
      chars: 10,
    });
    const out = rankAcrossProjects([h("a", 0.6), h("a", null), h("b", 0.8), h("c", 0.6)], 3);
    expect(out.map((x) => x.key)).toEqual(["b:0.8", "a:0.6", "c:0.6"]);
    expect(rankAcrossProjects([h("a", null), h("b", 0.1)], 5).map((x) => x.product)).toEqual([
      "b",
      "a",
    ]);
  });

  it("summarizeRetrieval reads answer share, missing products, recall, failures and time", () => {
    const run = (over: Partial<RetrievalRun>): RetrievalRun => ({
      questionId: "R1",
      scopeSize: 3,
      mode: "all",
      answerIn: ["a", "b"],
      expectedFiles: ["a:x.go", "b:y.py"],
      projectsSearched: 3,
      failed: 0,
      hits: [],
      ms: 100,
      blockChars: 1000,
      ...over,
    });
    const rows = summarizeRetrieval([
      run({
        hits: ["a:x.go", "c:z.md", "c:w.md", "a:q.go"],
        failed: 1,
        projectsSearched: 2,
        ms: 300,
      }),
      run({ questionId: "R2", answerIn: ["c"], expectedFiles: [], hits: ["c:w.md"], ms: 100 }),
      // A no-answer question never enters a retrieval row.
      run({ questionId: "R3", answerIn: [], hits: ["a:x.go"] }),
      run({ mode: "oracle", hits: ["a:x.go", "b:y.py"], projectsSearched: 2 }),
    ]);
    expect(rows.map((r) => r.mode)).toEqual(["all", "oracle"]);
    expect(rows[0]).toMatchObject({
      questions: 2,
      answerShare: { n: 3, of: 5 },
      missingProduct: { n: 1, of: 2 },
      expectedRecall: { n: 1, of: 2 },
      failed: { n: 1, of: 6 },
      meanMs: 200,
      maxMs: 300,
      meanBlockChars: 1000,
    });
    expect(rows[0].meanSearched).toBe(2.5);
    expect(rows[1]).toMatchObject({
      expectedRecall: { n: 2, of: 2 },
      missingProduct: { n: 0, of: 1 },
    });
  });

  it("formatRoutingReport prints both tables and one row per routed question", () => {
    const decision = routeProjects(
      "xqzv",
      [product("a"), product("b")],
      new Map([["a", ev([], 0)]]),
    );
    const samples: RoutingSample[] = [{ questionId: "R9", scopeSize: 2, answerIn: [], decision }];
    const md = formatRoutingReport({
      routing: summarizeRouting(samples),
      retrieval: summarizeRetrieval([
        {
          questionId: "R1",
          scopeSize: 2,
          mode: "ranked",
          answerIn: ["a"],
          expectedFiles: [],
          projectsSearched: 2,
          failed: 0,
          hits: ["a:f"],
          ms: 12.4,
          blockChars: 50,
        },
      ]),
      samples,
      options: DEFAULT_ROUTING_OPTIONS,
    });
    expect(md).toContain("Router: probe k 8, floor 0.25, keep ratio 0.5.");
    expect(md).toContain(
      "| 2 | 0 | n/a | n/a | n/a | n/a, n/a, n/a | n/a | n/a | 0.0 | 100% (1/1) |",
    );
    expect(md).toContain(
      "| 2 | ranked | 1 | 2.0 | 0% (0/2) | 100% (1/1) | 0% (0/1) | n/a | 12 | 12 | 50 |",
    );
    expect(md).toContain("| 2 | R9 | - | a 0.00/0.00, b 0.00/0.00 | fallback: no-evidence | 2 |");
  });
});

/**
 * Docs-gen prompt hygiene, asserted on the wire: the REAL
 * `OpenAICompatibleProvider` (the local-runtime path) talks to a loopback
 * HTTP server, and every request body the synthesis loop sends is inspected.
 *
 *  - #168 — a section prompt carries each module's facts ONCE: the grounding
 *    block lists a `facts:` source already in EXTRACTED MODULE FACTS by id,
 *    and every facts id stays citable and resolves.
 *  - #171 — the faithfulness judge is shown the evidence its claims cite, not
 *    the whole section's: a large facts entry no claim cites never reaches the
 *    judge prompt, and the judge prompt is the same size at a 100k and a 200k
 *    facts cap.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../ai/providers/bedrock-direct-provider.js";
import { DEFAULT_JUDGE_CHAR_BUDGET } from "./grounding/faithfulness-judge.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  synthesizeFinalDocument,
  type DocsGenTuning,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../finops/index.js", () => ({ recordUsage: vi.fn() }));

const JUDGE_MARKER = "strict faithfulness judge";
const CLAIM_MARKER = "decompose generated documentation";
/** The claim every section makes; it cites the `orders` module's facts. */
const CLAIM = "Orders over the limit are held for review.";
/** A line only the large, never-cited module's facts carry. */
const BIG_MARKER = "BULK-LEDGER-FILLER";

function moduleFacts(name: string, body: string): ModuleFacts {
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 2,
    facts: body,
    formulas: [],
    topClasses: [name],
  };
}

// ~155k chars of ENTITIES: inside a 200k facts cap, outside a 100k one.
const bigBody = [
  "PURPOSE: Archives the ledger.",
  "ENTITIES:",
  ...Array.from({ length: 3_200 }, (_, i) => `- ${BIG_MARKER} ${i}: archive batch ${i} nightly.`),
].join("\n");

const facts: ModuleFacts[] = [
  moduleFacts(
    "orders",
    "PURPOSE: FACT-ORDERS places orders.\nRULES:\n- FACT-ORDERS-RULE orders over the limit are held for review.",
  ),
  moduleFacts(
    "billing",
    "PURPOSE: FACT-BILLING issues invoices.\nRULES:\n- FACT-BILLING-RULE invoices are due in 30 days.",
  ),
  moduleFacts(
    "shipping",
    "PURPOSE: FACT-SHIPPING ships parcels.\nRULES:\n- FACT-SHIPPING-RULE parcels ship within 2 days.",
  ),
  moduleFacts("archive", bigBody),
];

const meta = { name: "Project", language: "typescript", totalFiles: 4, totalSymbols: 8 };
const context: GroundingContext = {
  sources: [
    {
      sourceId: "rag:reference:1",
      kind: "rag",
      label: "Reference",
      text: "Reference text about the order limit.",
      documentId: "reference",
      chunkId: "1",
    },
  ],
  sourceIds: new Set(["rag:reference:1"]),
  isEmpty: false,
};

interface Body {
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
}
const kindOf = (b: Body): "claims" | "verdicts" | "section" => {
  const sys = b.messages[0]?.content ?? "";
  if (sys.includes(JUDGE_MARKER)) return "verdicts";
  if (sys.includes(CLAIM_MARKER)) return "claims";
  return "section";
};
const userOf = (b: Body) => b.messages.find((m) => m.role === "user")?.content ?? "";
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("prompt hygiene on the real OpenAI-compatible provider (#168, #171)", () => {
  let server: Server;
  let base = "";
  const bodies: Body[] = [];
  /** The module whose facts id the claim extractor cites. */
  let citeModule = "orders";
  /** The claim every section's claim list holds. */
  let claimText = CLAIM;
  /** Claim calls whose passage holds this text answer in prose, once each (#165). */
  let proseOnceFor: string | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = JSON.parse(raw) as Body;
        bodies.push(body);
        const kind = kindOf(body);
        const user = userOf(body);
        if (body.stream) {
          const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "Section";
          const frames = [
            { choices: [{ index: 0, delta: { content: `## ${label}\n\n${CLAIM}` } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n",
          );
          return;
        }
        let content: string;
        if (kind === "claims" && proseOnceFor && user.includes(proseOnceFor)) {
          proseOnceFor = null;
          content = "I could not produce a claim list for this passage.";
        } else if (kind === "claims") {
          // Cite the orders module's facts id, as a model would from the list.
          const id = new RegExp(`- (facts:\\S+) \\(facts\\): ${citeModule}`).exec(user)?.[1];
          content = JSON.stringify({
            claims: [{ claim: claimText, sourceIds: id ? [id] : [] }],
          });
        } else {
          // A claim naming a threshold is supported only by evidence stating it.
          const evidence = user.slice(0, user.indexOf("=== CLAIMS TO JUDGE"));
          const threshold = /\b(\d{3,})\b/.exec(claimText)?.[1];
          const supported = threshold === undefined || evidence.includes(threshold);
          content = JSON.stringify({
            verdicts: [{ claim: claimText, supported, sourceIds: [] }],
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    bodies.length = 0;
    citeModule = "orders";
    claimText = CLAIM;
    proseOnceFor = null;
    vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
    vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
    vi.stubEnv("DOCS_GEN_LOCAL_REFINE", "0");
    vi.stubEnv("DOCS_GEN_GROUNDING", "on");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const synth = (factsCharCap: number, moduleFacts: ModuleFacts[] = facts) => {
    const tuning: DocsGenTuning = { ...docsGenTuning("local", "test-model"), factsCharCap };
    const provider = new OpenAICompatibleProvider({
      baseUrl: base,
      apiKey: "test",
      model: "test-model",
      providerKey: "local-gemma",
      maxAttempts: 1,
      sleepFn: async () => undefined,
    });
    const router: Phase2Router = {
      primary: { kind: "local", provider, tuning, factsCharCap, supportsCaching: false },
      hybrid: null,
    };
    return synthesizeFinalDocument(
      moduleFacts,
      meta,
      "business-requirements",
      "Requirements",
      router,
      "p",
      undefined,
      undefined,
      async () => context,
    );
  };

  it("#168 — each module's facts reach a section prompt exactly once, and stay citable", async () => {
    const result = await synth(200_000);
    const sections = bodies.filter((b) => kindOf(b) === "section");
    expect(sections.length).toBeGreaterThan(0);
    let referenced = 0;
    for (const b of sections) {
      const prompt = userOf(b);
      const blob = prompt.slice(
        prompt.indexOf("=== EXTRACTED MODULE FACTS ==="),
        prompt.indexOf("=== END MODULE FACTS ==="),
      );
      // Each facts source is in the grounding block by id, pointing at its
      // entry — and that entry is in the prompt exactly ONCE, in the facts blob
      // (before #168 the grounding block repeated it in full).
      const listed = [...prompt.matchAll(/\(text: the "(### MODULE: [^"]+)" entry in EXTRACTED/g)];
      for (const [, entry] of listed) {
        expect(count(prompt, `${entry}\n(`)).toBe(1);
        expect(count(blob, `${entry}\n(`)).toBe(1);
        referenced++;
      }
      // No fact line is sent twice.
      const bulk = [...prompt.matchAll(/- BULK-LEDGER-FILLER \d+:/g)].map((m) => m[0]);
      expect(new Set(bulk).size).toBe(bulk.length);
      // PURPOSE is read by every section; before #168 it appeared twice.
      for (const marker of ["FACT-ORDERS ", "FACT-BILLING ", "FACT-SHIPPING "]) {
        expect(count(prompt, marker)).toBeLessThanOrEqual(1);
      }
      if (listed.length > 0) expect(prompt).toContain("in EXTRACTED MODULE FACTS above");
    }
    expect(referenced).toBeGreaterThan(0);
    // No fact dropped: the paged Data Model batches still carry every line of
    // the large module between them (no-drop paging is intact).
    const paged = new Set(
      sections
        .filter((b) => userOf(b).includes("Section group: **Data & Domain Model**"))
        .flatMap((b) => [...userOf(b).matchAll(/- BULK-LEDGER-FILLER (\d+):/g)].map((m) => m[1])),
    );
    expect(paged.size).toBe(3_200);
    // Claims citing a facts id resolve and are scored: no grounding warning.
    expect(result.warnings.filter((w) => w.kind !== "facts-truncated")).toEqual([]);
  });

  /** Judge calls whose claim cites the orders module (every section but the archive-only batches). */
  const citedJudgeCalls = () =>
    bodies
      .filter((b) => kindOf(b) === "verdicts")
      .filter((b) => /\[id=facts:src_orders:\d+ /.test(userOf(b)));

  it("#171 — a large facts entry no claim cites never reaches the judge", async () => {
    await synth(200_000);
    const sections = bodies.filter((b) => kindOf(b) === "section");
    // The big module is in the sections' facts (it is part of the context) ...
    expect(sections.some((b) => userOf(b).includes(BIG_MARKER))).toBe(true);
    // ... but the claim cites the orders module, so the judge never sees it.
    const judge = citedJudgeCalls();
    expect(judge.length).toBeGreaterThanOrEqual(5);
    for (const b of judge) {
      expect(userOf(b)).toContain("FACT-ORDERS places orders.");
      expect(userOf(b)).not.toContain(BIG_MARKER);
    }
    // Every judge prompt, cited or not, is bounded by the judge's own budget.
    for (const b of bodies.filter((x) => kindOf(x) === "verdicts")) {
      expect(userOf(b).length).toBeLessThan(DEFAULT_JUDGE_CHAR_BUDGET + 2_000);
    }
  });

  it("#171 — the judge prompt is the same size at a 100k and a 200k facts cap", async () => {
    const judgeSizes = async (cap: number) => {
      bodies.length = 0;
      await synth(cap);
      return citedJudgeCalls().map((b) => userOf(b).length);
    };
    const at100k = await judgeSizes(100_000);
    const at200k = await judgeSizes(200_000);
    expect(at100k.length).toBeGreaterThanOrEqual(5);
    expect(at200k).toEqual(at100k);
    for (const n of at200k) expect(n).toBeLessThan(2_000);
  });

  it("#171 — a claim citing a large facts entry is judged on its lines, within the judge's budget", async () => {
    citeModule = "archive";
    await synth(200_000);
    const judge = bodies
      .filter((b) => kindOf(b) === "verdicts")
      .filter((b) => /\[id=facts:src_archive:0 /.test(userOf(b)));
    expect(judge.length).toBeGreaterThan(0);
    for (const b of judge) {
      // The whole ~155k entry fits a 200k facts cap; the judge gets a bounded cut.
      expect(userOf(b)).toContain(BIG_MARKER);
      expect(userOf(b).length).toBeLessThan(DEFAULT_JUDGE_CHAR_BUDGET + 2_000);
    }
  });

  describe("#166 — a claim naming a mined rule's file:line is judged on that line", () => {
    const rule = {
      language: "ts" as const,
      kind: "guard",
      expression: "amount > 1000",
      summary: "Orders over 1000 need approval",
      file: "src/approvals/approve.ts",
      line: 3,
      context: null,
    };
    const approvals = (codeLine: string): ModuleFacts => ({
      ...moduleFacts(
        "approvals",
        "PURPOSE: Approves orders over 1000.\nRULES:\n- Orders over 1000 need approval.",
      ),
      minedRules: [rule],
      minedRuleSources: [{ file: rule.file, line: 3, code: codeLine, fileHash: "0123456789ab" }],
    });

    const run = async (codeLine: string) => {
      claimText = "Orders over 1000 need manager approval (src/approvals/approve.ts:3).";
      citeModule = "approvals";
      const result = await synth(200_000, [approvals(codeLine)]);
      const judge = bodies.filter((b) => kindOf(b) === "verdicts");
      return { result, judge };
    };

    it("the judge is sent the code line, and the claim is supported by it", async () => {
      const { result, judge } = await run("  if (amount > 1000) requireManager(order);");
      expect(judge.length).toBeGreaterThan(0);
      for (const b of judge) {
        expect(userOf(b)).toContain("[id=mined:0123456789ab:3 kind=mined");
        expect(userOf(b)).toContain("if (amount > 1000) requireManager(order);");
        // Not the facts text that summarises the rule.
        expect(userOf(b)).not.toContain("Approves orders over 1000.");
      }
      expect(result.warnings.filter((w) => w.ratio !== undefined)).toEqual([]);
    });

    it("altering the line makes the claim unsupported, though the facts still agree", async () => {
      const { result } = await run("  if (amount > 5000) requireManager(order);");
      const scored = result.warnings.filter((w) => w.ratio !== undefined);
      expect(scored.length).toBeGreaterThan(0);
      for (const w of scored) expect(w.ratio).toBe(0);
    });
  });

  it("#165 — a batched section whose one batch's claim list failed says only part went unchecked", async () => {
    proseOnceFor = "## Data & Domain Model";
    const result = await synth(200_000);
    const w = result.warnings.find(
      (x) => x.section === "Data & Domain Model" && x.kind === "section-ungrounded",
    );
    expect(w).toBeDefined();
    expect(w!.message).toContain("for part of the section");
    expect(w!.message).toContain("the rest were");
    expect(w!.message).not.toContain("none of its statements were checked");
  });
});

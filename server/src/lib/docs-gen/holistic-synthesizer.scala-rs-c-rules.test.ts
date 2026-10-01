/**
 * #161 — the Scala, Rust, C and C++ rule miners are wired into Phase 1.
 *
 * Drives the production entry point (`synthesizeHolisticDocument`) over a real
 * clone directory and asserts (a) the Phase-1 prompt the provider receives
 * carries each language's mined inventory, (b) the rules are persisted in
 * `minedRulesJson` and read back, and (c) no mined rule is dropped: a file whose
 * inventory exceeds the per-inventory render cap is paged across Phase-1 calls
 * and every rule reaches a prompt untruncated, and each renderer fits the
 * rules the planner budgeted for it. Fixtures are synthetic.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";
import { projectLanguageLabel, synthesizeHolisticDocument } from "./holistic-synthesizer.js";
import {
  parsePersistedMinedRules,
  toPersistedMinedRules,
  type PersistedMinedRule,
} from "./fact-slices.js";
import { minedRuleRenderChars, PHASE1_MINED_RENDER_CAP } from "./phase1-chunking.js";
import { mineScalaRules, renderMinedScalaRules } from "../code-graph/scala-rule-miner.js";
import { mineRsRules, renderMinedRsRules } from "../code-graph/rs-rule-miner.js";
import { mineCRules, renderMinedCRules } from "../code-graph/c-rule-miner.js";

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

const phase1Prompts: string[] = [];
// Partial double: implements only the methods the synthesizer calls (no embed/models/ping,
// chat returns content only), so it cannot overlap AIProvider without an unknown hop.
const provider = {
  key: "bedrock-gateway",
  model: "fixture",
  offline: false,
  chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
  async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
    const prompt = String(messages.at(-1)?.content);
    if (prompt.includes("section group now")) {
      const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)![1];
      yield { type: "delta", content: `## ${label}\n\nSource facts.` };
    } else {
      phase1Prompts.push(prompt);
      yield { type: "delta", content: "PURPOSE\n- Orders.\n\nRULES\n- Validate orders." };
    }
    yield { type: "done", finishReason: "stop" };
  },
} as unknown as AIProvider; // see the partial-double note above
vi.mock("../ai/index.js", () => ({
  loadAIConfig: () => ({
    provider: "bedrock-gateway",
    model: "fixture",
    sdkProvider: { type: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "x" },
  }),
  buildProvider: () => provider,
}));

const SCALA_SOURCE = [
  "object OrderService {",
  "  def place(order: Order): Order = {",
  '    require(order.total > 0, "order total must be positive")',
  "    order",
  "  }",
  "}",
].join("\n");

const RUST_SOURCE = [
  "impl OrderService {",
  "    pub fn place(&self, order: &Order) -> Result<(), OrderError> {",
  "        if order.items.len() > MAX_ITEMS {",
  "            return Err(OrderError::TooManyItems);",
  "        }",
  "        Ok(())",
  "    }",
  "}",
].join("\n");

const C_SOURCE = [
  "int place_order(struct order *o)",
  "{",
  "    if (o->total <= 0) return -EINVAL;",
  "    return 0;",
  "}",
].join("\n");

const CPP_SOURCE = [
  "void Pricing::check(const Order& order) {",
  "    if (order.total() < 0) {",
  '        throw std::invalid_argument("negative total");',
  "    }",
  "}",
].join("\n");

let root: string;

type Sym = [id: string, name: string, kind: string, file: string, lang: string, end: number];

async function setUp(files: Record<string, string>, symbols: Sym[]): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, "a", rel)), { recursive: true });
    await writeFile(path.join(root, "a", rel), text);
  }
  db.codeSymbol.findMany.mockResolvedValue(
    symbols.map(([id, name, kind, filePath, language, end]) => ({
      id,
      codeGraphId: "g",
      qualifiedName: `${filePath}::${name}`,
      kind,
      filePath,
      language,
      startLine: 1,
      endLine: end,
      contentHash: `hash-${id}`,
    })),
  );
  const perFile = new Map<string, number>();
  for (const s of symbols) perFile.set(s[3], (perFile.get(s[3]) ?? 0) + 1);
  db.codeSymbol.groupBy.mockResolvedValue(
    [...perFile].map(([filePath, n]) => ({ codeGraphId: "g", filePath, _count: { _all: n } })),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  phase1Prompts.length = 0;
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("BEDROCK_GATEWAY_URL", "");
  vi.stubEnv("BEDROCK_GATEWAY_BASE_URL", "");
  root = await mkdtemp(path.join(os.tmpdir(), "metis-n2-langs-rules-"));
  await mkdir(path.join(root, "a", ".git"), { recursive: true });
  await writeFile(path.join(root, "a", ".git", "HEAD"), "ref: refs/heads/main");
  vi.stubEnv("REPO_CLONE_DIR", root);
  db.project.findUnique.mockResolvedValue({ name: "Project" });
  db.codeGraph.findMany.mockResolvedValue([
    { id: "g", repoConnection: { id: "a", projectId: "p", deletedAt: null } },
  ]);
  db.codeEdge.findMany.mockResolvedValue([]);
  db.finding.findMany.mockResolvedValue([]);
  db.docsGenFactCache.findUnique.mockResolvedValue(null);
  db.docsGenFactCache.upsert.mockResolvedValue({});
  db.docsGenFactCache.update.mockResolvedValue({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const persisted = (): PersistedMinedRule[] =>
  db.docsGenFactCache.upsert.mock.calls.flatMap(
    (c: Array<{ create: { minedRulesJson: string } }>) =>
      JSON.parse(c[0].create.minedRulesJson) as PersistedMinedRule[],
  );

describe("Phase 1 Scala / Rust / C / C++ rule inventories (#161)", () => {
  beforeEach(async () => {
    await setUp(
      {
        "src/OrderService.scala": SCALA_SOURCE,
        "src/service.rs": RUST_SOURCE,
        "src/orders.c": C_SOURCE,
        "src/pricing.cpp": CPP_SOURCE,
      },
      [
        ["s1", "OrderService", "class", "src/OrderService.scala", "scala", 6],
        ["s2", "OrderService::place", "method", "src/OrderService.scala", "scala", 5],
        ["r1", "OrderService::place", "method", "src/service.rs", "rs", 8],
        ["c1", "place_order", "function", "src/orders.c", "c", 5],
        ["p1", "Pricing::check", "method", "src/pricing.cpp", "cpp", 5],
      ],
    );
  });

  it("feeds each language's mined rules into the Phase-1 prompt, cited by file:line", async () => {
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const p1 = phase1Prompts.join("\n====\n");
    expect(p1).toContain("DETERMINISTICALLY-MINED SCALA RULE INVENTORY (1 rules)");
    expect(p1).toContain(
      "- src/OrderService.scala:3: require(order.total > 0): order total must be positive",
    );
    expect(p1).toContain("DETERMINISTICALLY-MINED RUST RULE INVENTORY (2 rules)");
    expect(p1).toContain("- src/service.rs:3: Rejects/exits when order.items.len() > MAX_ITEMS");
    expect(p1).toContain("- src/service.rs:4: Returns error OrderError::TooManyItems");
    expect(p1).toContain("DETERMINISTICALLY-MINED C RULE INVENTORY (1 rules)");
    expect(p1).toContain("- src/orders.c:3: Rejects when o->total <= 0");
    expect(p1).toContain("DETERMINISTICALLY-MINED C++ RULE INVENTORY (2 rules)");
    expect(p1).toContain("- src/pricing.cpp:3: Throws std::invalid_argument: negative total");
  });

  it("persists every language's rules in minedRulesJson and reads them back (#155)", async () => {
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const written = persisted();
    expect(
      ["scala", "rs", "c", "cpp"].map((l) => written.filter((r) => r.language === l).length),
    ).toEqual([1, 2, 1, 2]);
    expect(written.find((r) => r.language === "cpp")!.file).toBe("src/pricing.cpp");
    // A cache row holding them must be readable, or every hit silently re-mines.
    expect(parsePersistedMinedRules(JSON.stringify(written))).toEqual(written);
  });
});

describe("Phase 1 pages a large inventory with no rule dropped (#161, no-drop paging)", () => {
  // Each guard's summary is ~160 characters, so 110 of them are about 1.5x the
  // per-inventory render cap: one call cannot carry them, so the planner must
  // page the file across calls, and every page must render whole.
  const guards = (n: number): string[] =>
    Array.from(
      { length: n },
      (_, k) =>
        `    if (order_${k}->total_amount_in_minor_units > MAXIMUM_ALLOWED_TOTAL_FOR_CHANNEL_${k} && order_${k}->channel == CHANNEL_${k}) return REJECT;`,
    );

  it.each([
    ["c", "src/check.c"],
    ["cpp", "src/check.cpp"],
    ["rs", "src/check.rs"],
    ["scala", "src/Check.scala"],
  ])("%s: every rule reaches a prompt, none truncated", async (lang, filePath) => {
    // A reply budget large enough that the render cap, not the output
    // estimate, is what forces the paging.
    vi.stubEnv("DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS", "32768");
    const n = 110;
    const body = guards(n).map((l) =>
      lang === "rs"
        ? l.replace("if (", "if ").replace(") return REJECT;", " { return Err(Reject); }")
        : lang === "scala"
          ? l.replace("return REJECT;", "throw Reject()").replace(/->/g, ".")
          : l,
    );
    const text = ["fn_check(void)", "{", ...body, "}"].join("\n");
    await setUp({ [filePath]: text }, [["f1", "check", "function", filePath, lang, n + 3]]);
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const rules = persisted().filter((r) => r.language === lang && r.kind === "guard");
    expect(rules).toHaveLength(n);
    // Premise: the inventory is larger than one prompt may render.
    const chars = rules.reduce((sum, r) => sum + `- L${r.line}: ${r.summary}`.length, 0);
    expect(chars).toBeGreaterThan(PHASE1_MINED_RENDER_CAP);
    expect(phase1Prompts.length).toBeGreaterThan(1);

    const p1 = phase1Prompts.join("\n====\n");
    expect(p1).not.toContain("rules truncated for prompt budget");
    for (const r of rules) expect(p1).toContain(`- ${r.file}:${r.line}: ${r.summary}`);
  });
});

describe("renderers stay inside the planner's per-inventory budget (#161, no-drop)", () => {
  // The planner sizes a chunk so that the sum of `minedRuleRenderChars` over a
  // language's rules is at most the render cap; each renderer must then fit
  // those rules in that many characters, or the last ones are cut.
  it.each([
    ["scala", "src/A.scala", SCALA_SOURCE, mineScalaRules, renderMinedScalaRules],
    ["rs", "src/a.rs", RUST_SOURCE, mineRsRules, renderMinedRsRules],
    ["c", "src/a.c", C_SOURCE, mineCRules, renderMinedCRules],
    ["cpp", "src/a.cpp", CPP_SOURCE, mineCRules, renderMinedCRules],
  ] as const)("%s", (lang, file, source, mine, render) => {
    const rules = mine(source.repeat(20), file, 1, null, Infinity);
    const budget = toPersistedMinedRules(lang, rules).reduce(
      (n, r) => n + minedRuleRenderChars(r),
      0,
    );
    const out = (render as (r: typeof rules, max: number) => string)(rules, budget);
    expect(out).not.toContain("truncated");
    expect(out.match(/^- L\d+:/gm)).toHaveLength(rules.length);
  });
});

// PR #319 review — a C/C++ project dominated by headers or `.cc` files is still named as one.
describe("projectLanguageLabel (#161)", () => {
  it("names every C/C++ source and header extension the ingest reads", () => {
    expect(projectLanguageLabel("c")).toBe("C");
    expect(projectLanguageLabel("h")).toBe("C/C++");
    for (const ext of ["cpp", "cc", "cxx", "hpp", "hh", "hxx"]) {
      expect(projectLanguageLabel(ext)).toBe("C++");
    }
    expect(projectLanguageLabel("scala")).toBe("Scala");
    expect(projectLanguageLabel("rs")).toBe("Rust");
  });

  it("falls back to the extension, or unknown", () => {
    expect(projectLanguageLabel("zig")).toBe("zig");
    expect(projectLanguageLabel("")).toBe("unknown");
  });
});

/**
 * #160 — the COBOL rule miner is wired into Phase 1, persisted with the other
 * languages' mined rules, and paged without loss.
 *
 * Drives the production entry point (`synthesizeHolisticDocument`) over a real
 * clone directory holding synthetic COBOL, and asserts on what the provider
 * receives and what the fact cache is asked to store — the read paths a real
 * run uses.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";
import { synthesizeHolisticDocument } from "./holistic-synthesizer.js";
import { parsePersistedMinedRules, type PersistedMinedRule } from "./fact-slices.js";

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

/** Fixed format: sequence number, indicator, text from column 8. */
const fixed = (lines: string[]): string =>
  lines.map((l, i) => `${String(i + 1).padStart(6, "0")}${l}`).join("\n");

const ORDERS = fixed([
  " IDENTIFICATION DIVISION.",
  " PROGRAM-ID. ORDERS.",
  " DATA DIVISION.",
  " WORKING-STORAGE SECTION.",
  " 01  WS-ORDER.",
  "     05 WS-TYPE   PIC X.",
  "        88 RUSH-ORDER VALUE 'R'.",
  " PROCEDURE DIVISION.",
  " CHECK-PARA.",
  "     IF WS-AMOUNT > 10000",
  "        AND RUSH-ORDER",
  "        PERFORM HOLD-PARA",
  "     END-IF",
  "     COMPUTE WS-TOTAL = WS-AMOUNT * 1.08.",
  " HOLD-PARA.",
  "     DISPLAY 'HELD'.",
]);

let root: string;

function sym(
  id: string,
  name: string,
  kind: string,
  filePath: string,
  start: number,
  end: number,
  qualifiedName = `${filePath}::${name}`,
) {
  return {
    id,
    codeGraphId: "g",
    qualifiedName,
    kind,
    filePath,
    language: "cbl",
    startLine: start,
    endLine: end,
    contentHash: `hash-${id}`,
  };
}

async function setup(files: Record<string, string>, symbols: ReturnType<typeof sym>[]) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, "a", rel)), { recursive: true });
    await writeFile(path.join(root, "a", rel), content);
  }
  db.codeSymbol.findMany.mockResolvedValue(symbols);
  const counts = new Map<string, number>();
  for (const s of symbols) counts.set(s.filePath, (counts.get(s.filePath) ?? 0) + 1);
  db.codeSymbol.groupBy.mockResolvedValue(
    [...counts].map(([filePath, n]) => ({ codeGraphId: "g", filePath, _count: { _all: n } })),
  );
}

function persisted(): PersistedMinedRule[] {
  return db.docsGenFactCache.upsert.mock.calls.flatMap(
    (c: Array<{ create: { minedRulesJson: string } }>) =>
      JSON.parse(c[0].create.minedRulesJson) as PersistedMinedRule[],
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  phase1Prompts.length = 0;
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("BEDROCK_GATEWAY_URL", "");
  vi.stubEnv("BEDROCK_GATEWAY_BASE_URL", "");
  root = await mkdtemp(path.join(os.tmpdir(), "metis-cobol-rules-"));
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

describe("Phase 1 COBOL rule inventory (#160)", () => {
  const F = "src/ORDERS.cbl";
  const symbols = [
    sym("p", "ORDERS", "class", F, 1, 16),
    sym("c", "CHECK-PARA", "function", F, 9, 14, `${F}::ORDERS::CHECK-PARA`),
    sym("h", "HOLD-PARA", "function", F, 15, 16, `${F}::ORDERS::HOLD-PARA`),
  ];

  it("feeds the COBOL mined rules into the Phase-1 prompt", async () => {
    await setup({ [F]: ORDERS }, symbols);
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const p1 = phase1Prompts.join("\n====\n");
    expect(p1).toContain("DETERMINISTICALLY-MINED COBOL RULE INVENTORY (3 rules)");
    expect(p1).toContain(`- ${F}:7: \`RUSH-ORDER\` (of \`WS-TYPE\`) holds when the value is 'R'`);
    expect(p1).toContain(`- ${F}:10: Branches when WS-AMOUNT > 10000 AND RUSH-ORDER`);
    expect(p1).toContain(`- ${F}:14: Calculates WS-TOTAL = WS-AMOUNT * 1.08`);
  });

  it("persists the COBOL rules with their paragraph context and reads them back (#155)", async () => {
    await setup({ [F]: ORDERS }, symbols);
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const written = persisted();
    const cbl = written.filter((r) => r.language === "cbl");
    expect(cbl.map((r) => [r.kind, r.line, r.context])).toEqual([
      ["condition-name", 7, null],
      ["condition", 10, `${F}::ORDERS::CHECK-PARA`],
      ["compute", 14, `${F}::ORDERS::CHECK-PARA`],
    ]);
    // A cache row holding them must be readable, or every hit silently re-mines.
    expect(parsePersistedMinedRules(JSON.stringify(written))).toEqual(written);
  });

  it("mines a free-format file's paragraphs as free format (#160 review)", async () => {
    // A short paragraph name and bodies with a valid fixed-format indicator in
    // column 7: read on its own, the paragraph would look fixed-format.
    const P = "src/PAY.cbl";
    const tail = "WS-AMOUNT-PAYABLE-TO-VENDOR-ACCOUNT > WS-CREDIT-LIMIT-FOR-VENDOR-ACCOUNT";
    const source = [
      ">>SOURCE FREE",
      "IDENTIFICATION DIVISION.",
      "PROGRAM-ID. PAY.",
      "PROCEDURE DIVISION.",
      "MAIN.",
      "    IF WS-AMT > 100",
      "       GO TO ERR",
      "    END-IF",
      `    IF WS-CODE = 'A' AND ${tail}`,
      "       DISPLAY 'OVER'",
      "    END-IF.",
      "ERR.",
      "    DISPLAY 'E'.",
    ].join("\n");
    await setup({ [P]: source }, [
      sym("p", "PAY", "class", P, 2, 13),
      sym("m", "MAIN", "function", P, 5, 11, `${P}::PAY::MAIN`),
      sym("e", "ERR", "function", P, 12, 13, `${P}::PAY::ERR`),
    ]);
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const p1 = phase1Prompts.join("\n====\n");
    expect(p1).toContain("DETERMINISTICALLY-MINED COBOL RULE INVENTORY (2 rules)");
    expect(p1).toContain(`- ${P}:6: Rejects/transfers control to ERR when WS-AMT > 100`);
    expect(p1).toContain(`- ${P}:9: Branches when WS-CODE = 'A' AND ${tail}`);
    expect(
      persisted()
        .filter((r) => r.language === "cbl")
        .map((r) => [r.kind, r.line, r.context]),
    ).toEqual([
      ["guard", 6, `${P}::PAY::MAIN`],
      ["condition", 9, `${P}::PAY::MAIN`],
    ]);
  });

  it("pages a rule-dense copybook across Phase-1 calls without dropping a rule", async () => {
    const n = 600;
    const lines = [" 01  WS-CODES.", "     05 WS-CODE PIC 9(4)."];
    for (let i = 0; i < n; i++) lines.push(`        88 CODE-${i}-IS-VALID VALUE ${i}.`);
    const C = "src/CODES.cpy";
    await setup({ [C]: fixed(lines) }, [
      sym("m", "CODES.cpy", "module", C, 1, lines.length, C),
      sym("t", "WS-CODES", "type", C, 1, lines.length),
    ]);
    await synthesizeHolisticDocument("p", "architecture", "Architecture");

    // More than one Phase-1 call: one prompt's inventory cannot hold 600 rules.
    const withInventory = phase1Prompts.filter((p) => p.includes("COBOL RULE INVENTORY"));
    expect(withInventory.length).toBeGreaterThan(1);
    const all = withInventory.join("\n");
    expect(all).not.toContain("truncated for prompt budget");
    for (let i = 0; i < n; i++) {
      expect(all).toContain(`- ${C}:${i + 3}: \`CODE-${i}-IS-VALID\``);
    }
    const cbl = persisted().filter((r) => r.language === "cbl");
    expect(cbl).toHaveLength(n);
  });
});

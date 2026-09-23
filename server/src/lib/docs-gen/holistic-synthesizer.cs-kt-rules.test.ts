/**
 * #158 / #159 — the C# and Kotlin rule miners are wired into Phase 1.
 *
 * Drives the production entry point (`synthesizeHolisticDocument`) over a real
 * clone directory holding one `.cs` and one `.kt` file, and asserts the
 * Phase-1 prompt the provider receives carries each language's mined rule
 * inventory — read back through the same prompt a real model would see.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";
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
const provider = {
  key: "bedrock-gateway",
  model: "fixture",
  offline: false,
  chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
  async *stream(messages): AsyncGenerator<ChatChunk> {
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
} as AIProvider;
vi.mock("../ai/index.js", () => ({
  loadAIConfig: () => ({
    provider: "bedrock-gateway",
    model: "fixture",
    sdkProvider: { type: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "x" },
  }),
  buildProvider: () => provider,
}));

const CS_SOURCE = [
  "public class OrderValidator",
  "{",
  "    public void Validate(Order order)",
  "    {",
  "        if (order.Quantity > MaxQuantity)",
  "        {",
  '            throw new ValidationException("Quantity exceeds the maximum");',
  "        }",
  "    }",
  "}",
].join("\n");

const KT_SOURCE = [
  "class OrderService {",
  "    fun place(order: Order) {",
  '        require(order.total > 0) { "Order total must be positive" }',
  "    }",
  "}",
].join("\n");

let root: string;

beforeEach(async () => {
  vi.clearAllMocks();
  phase1Prompts.length = 0;
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("BEDROCK_GATEWAY_URL", "");
  vi.stubEnv("BEDROCK_GATEWAY_BASE_URL", "");
  root = await mkdtemp(path.join(os.tmpdir(), "metis-cs-kt-rules-"));
  await mkdir(path.join(root, "a", ".git"), { recursive: true });
  await mkdir(path.join(root, "a", "src"), { recursive: true });
  await writeFile(path.join(root, "a", ".git", "HEAD"), "ref: refs/heads/main");
  await writeFile(path.join(root, "a", "src", "OrderValidator.cs"), CS_SOURCE);
  await writeFile(path.join(root, "a", "src", "OrderService.kt"), KT_SOURCE);
  vi.stubEnv("REPO_CLONE_DIR", root);

  const sym = (
    id: string,
    name: string,
    kind: string,
    filePath: string,
    language: string,
    end: number,
  ) => ({
    id,
    codeGraphId: "g",
    qualifiedName: `${filePath}::${name}`,
    kind,
    filePath,
    language,
    startLine: 1,
    endLine: end,
    contentHash: `hash-${id}`,
  });
  db.project.findUnique.mockResolvedValue({ name: "Project" });
  db.codeGraph.findMany.mockResolvedValue([
    { id: "g", repoConnection: { id: "a", projectId: "p", deletedAt: null } },
  ]);
  db.codeSymbol.findMany.mockResolvedValue([
    sym("c1", "OrderValidator", "class", "src/OrderValidator.cs", "cs", 10),
    sym("c2", "Validate", "method", "src/OrderValidator.cs", "cs", 10),
    sym("k1", "OrderService", "class", "src/OrderService.kt", "kt", 5),
    sym("k2", "place", "method", "src/OrderService.kt", "kt", 5),
  ]);
  db.codeSymbol.groupBy.mockResolvedValue([
    { codeGraphId: "g", filePath: "src/OrderValidator.cs", _count: { _all: 2 } },
    { codeGraphId: "g", filePath: "src/OrderService.kt", _count: { _all: 2 } },
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

describe("Phase 1 C# / Kotlin rule inventories (#158, #159)", () => {
  it("feeds the C# mined rules into the Phase-1 prompt", async () => {
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const p1 = phase1Prompts.join("\n====\n");
    expect(p1).toContain("DETERMINISTICALLY-MINED C# RULE INVENTORY");
    expect(p1).toContain("Rejects/exits when order.Quantity > MaxQuantity");
    expect(p1).toContain("Throws ValidationException: Quantity exceeds the maximum");
  });

  it("feeds the Kotlin mined rules into the Phase-1 prompt", async () => {
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const p1 = phase1Prompts.join("\n====\n");
    expect(p1).toContain("DETERMINISTICALLY-MINED KOTLIN RULE INVENTORY");
    expect(p1).toContain("require(order.total > 0): Order total must be positive");
  });

  it("persists the C# and Kotlin rules in minedRulesJson and reads them back (#155)", async () => {
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const written: PersistedMinedRule[] = db.docsGenFactCache.upsert.mock.calls.flatMap(
      (c: Array<{ create: { minedRulesJson: string } }>) =>
        JSON.parse(c[0].create.minedRulesJson) as PersistedMinedRule[],
    );
    const cs = written.filter((r) => r.language === "cs");
    const kt = written.filter((r) => r.language === "kt");
    expect(cs.map((r) => r.summary)).toContain("Rejects/exits when order.Quantity > MaxQuantity");
    expect(cs.every((r) => r.file === "src/OrderValidator.cs")).toBe(true);
    expect(kt.map((r) => r.file)).toContain("src/OrderService.kt");
    // A cache row holding them must be readable, or every hit silently re-mines.
    expect(parsePersistedMinedRules(JSON.stringify(written))).toEqual(written);
  });
});

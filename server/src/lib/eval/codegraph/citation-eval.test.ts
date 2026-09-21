/**
 * Epic #712 / Issue #717 — code-graph citation verification (CI-gating).
 *
 * Proves, end-to-end and MOCK-ONLY (no live LLM / gateway / embedder / DB), that
 * a project-scoped question about a KNOWN symbol returns a citable
 * `filePath:startLine-endLine` answer sourced from the code graph:
 *
 *   - #714 fused merge + dedupe        — the passive symbol block + RAG dedupe,
 *   - #713 chat tool exposure + loop   — the code tools are offered AND the loop
 *                                        actually executes `search_code_symbols`,
 *   - #715 citation rendering          — the answer cites the derived locator and
 *                                        carries NO reconstruction disclaimer.
 *
 * The expected locator is DERIVED from the real parsed `CodeSymbol` record (never
 * hardcoded), so a citation regression cannot pass. With the flags OFF the run
 * degrades to the legacy uncited answer, exercising the gated code path.
 */
import { describe, expect, it } from "vitest";
import {
  buildSearchSeams,
  buildSymbolsFromRepo,
  defaultFixtureDir,
  FIXTURE_PROJECT_ID,
  loadCodegraphFixture,
  type CodegraphFixture,
} from "./fixture.js";
import { createCitationEvalProvider } from "./offline-provider.js";
import { runCodegraphCitationEval } from "./runner.js";
import {
  citesLocator,
  expectedLocator,
  extractFirstLocator,
  findForbiddenDisclaimer,
} from "./assertions.js";

async function fixture(): Promise<CodegraphFixture> {
  return loadCodegraphFixture();
}

describe("codegraph citation eval — fixture", () => {
  it("loads a self-contained fixture whose known target resolves to a real CodeSymbol", async () => {
    const f = await fixture();
    expect(f.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(f.symbols.length).toBeGreaterThan(0);
    // The target is a genuine parsed symbol with authoritative line spans.
    expect(f.targetSymbol.name).toBe("calculateProcessingFee");
    expect(f.targetSymbol.filePath).toBe("payments/fee-calculator.ts");
    expect(f.targetSymbol.startLine).toBeGreaterThan(0);
    expect(f.targetSymbol.endLine).toBeGreaterThanOrEqual(f.targetSymbol.startLine);
    // No module pseudo-symbols leak into the index.
    expect(f.symbols.some((s) => s.kind === "module")).toBe(false);
  });

  it("defaultFixtureDir points at the committed fixture", () => {
    expect(defaultFixtureDir()).toMatch(/eval-data\/corpus\/codegraph-01-citation$/);
  });

  it("buildSymbolsFromRepo skips module symbols and non-source files", () => {
    const symbols = buildSymbolsFromRepo(
      [
        { relPath: "a.ts", content: "export function foo() {\n  return 1;\n}\n" },
        { relPath: "README.md", content: "# not source" },
      ],
      "p1",
    );
    expect(symbols.map((s) => s.name)).toContain("foo");
    expect(symbols.every((s) => s.kind !== "module")).toBe(true);
    // The markdown file has no detectable language ⇒ contributes no symbols.
    expect(symbols.every((s) => s.filePath === "a.ts")).toBe(true);
  });

  it("buildSearchSeams line lookup ignores unknown symbol ids", async () => {
    const symbols = buildSymbolsFromRepo(
      [{ relPath: "a.ts", content: "export function foo() {\n  return 1;\n}\n" }],
      "p1",
    );
    const { lineLookup } = buildSearchSeams(symbols);
    const resolved = await lineLookup.resolve(["does-not-exist"], "p1");
    expect(resolved.size).toBe(0);
  });
});

describe("codegraph citation eval — flag ON (grounded, cited)", () => {
  it("executes the tool loop and cites the derived CodeSymbol locator with no disclaimer", async () => {
    const f = await fixture();
    const provider = createCitationEvalProvider();
    const result = await runCodegraphCitationEval({ fixture: f, provider, enabled: true });

    // #713 — the loop actually EXECUTED the code-search tool (not just exposed it).
    expect(result.toolCalls.map((c) => c.tool)).toContain("search_code_symbols");

    // #715 — the citation matches the REAL CodeSymbol record (derived, not literal).
    const derived = expectedLocator(f.targetSymbol);
    expect(result.expectedLocator).toBe(derived);
    expect(result.cited).toBe(true);
    expect(result.answer).toContain(derived);

    // No "reconstructed from the knowledge base"-style disclaimer.
    expect(result.disclaimer).toBeNull();

    // #714 — the passive fused block was built and carries the same locator.
    expect(result.fusedBlock).toContain(derived);
    expect(result.fusedStats.usedSymbols).toBeGreaterThanOrEqual(1);

    // #713 + #715 ride the byte-stable, cacheable prompt lead.
    expect(result.stableLead).toContain("search_code_symbols");
    expect(result.stableLead).toContain("Source citation policy");
  });

  it("#714 dedupe: a RAG chunk covering the symbol's file drops it from the passive block, yet the tool-driven citation still lands", async () => {
    const f = await fixture();
    const provider = createCitationEvalProvider();
    const result = await runCodegraphCitationEval({
      fixture: f,
      provider,
      enabled: true,
      ragChunks: [{ filename: "connector:repo:c1:src/payments/fee-calculator.ts" }],
    });

    const derived = expectedLocator(f.targetSymbol);
    // The passive block dropped the already-covered file (no double-injection)...
    expect(result.fusedStats.droppedDuplicate).toBeGreaterThanOrEqual(1);
    expect(result.fusedBlock).not.toContain(derived);
    // ...but the executed search tool still returns + cites the locator.
    expect(result.cited).toBe(true);
    expect(result.answer).toContain(derived);
  });
});

describe("codegraph citation eval — flag OFF (legacy, uncited)", () => {
  it("runs no tool loop, cites nothing, and degrades to the legacy disclaimer", async () => {
    const f = await fixture();
    const provider = createCitationEvalProvider();
    const result = await runCodegraphCitationEval({ fixture: f, provider, enabled: false });

    // The gated path: no fused query, no tools, no citation policy in the lead.
    expect(result.toolCalls).toEqual([]);
    expect(result.fusedBlock).toBe("");
    expect(result.stableLead).not.toContain("search_code_symbols");
    expect(result.stableLead).not.toContain("Source citation policy");

    // Legacy behaviour: no real citation, and the reconstruction disclaimer is
    // present — proving the flag gates the whole feature cleanly.
    expect(result.cited).toBe(false);
    expect(result.answer).not.toContain(expectedLocator(f.targetSymbol));
    expect(result.disclaimer).not.toBeNull();
  });
});

describe("codegraph citation eval — offline provider + assertion helpers", () => {
  it("offline provider stubs are inert no-ops", async () => {
    const provider = createCitationEvalProvider();
    expect(provider.offline).toBe(true);
    expect(await provider.embed(["x"])).toEqual({ vectors: [], model: "none", dimension: 0 });
    expect(await provider.models()).toEqual([]);
    expect(await provider.ping()).toBe(true);
    const chunks: unknown[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }], {})) chunks.push(c);
    expect(chunks).toEqual([]);
  });

  it("assertion helpers derive, match, and screen correctly", () => {
    const sym = { filePath: "a/b.ts", startLine: 3, endLine: 9 };
    expect(expectedLocator(sym)).toBe("a/b.ts:3-9");
    expect(citesLocator("see a/b.ts:3-9 now", "a/b.ts:3-9")).toBe(true);
    expect(citesLocator("nope", "a/b.ts:3-9")).toBe(false);
    expect(findForbiddenDisclaimer("all good", ["bad phrase"])).toBeNull();
    expect(findForbiddenDisclaimer("this is a BAD Phrase", ["bad phrase"])).toBe("bad phrase");
    expect(extractFirstLocator("x foo.ts:1-2 y")).toBe("foo.ts:1-2");
    expect(extractFirstLocator("no locator here")).toBeNull();
  });
});

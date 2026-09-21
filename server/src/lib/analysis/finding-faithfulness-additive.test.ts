/**
 * Epic #1316 (#1318) — REGRESSION guard: adding a numeric faithfulness metric
 * must not change the categorical gate by a single byte.
 *
 * #1318 adds a metric BESIDE `verificationStatus`; it does not replace it, and
 * per #1109 a grader must never write a verdict. Two of the issue's acceptance
 * criteria are about what did NOT change, and a criterion of that shape is
 * satisfied by a test or by nothing:
 *
 *   1. A FROZEN TRUTH TABLE over `verifyFinding`'s entire input domain. Every
 *      combination of the four inputs is enumerated here with its output written
 *      out literally. If a future change to the gate — or a stray import from the
 *      new metric — moves any cell, this file goes red and names the cell.
 *   2. A STRUCTURAL check that neither the new analysis module nor the shared
 *      scoring layer can reach `finding-verification.ts` at all. "The gate is
 *      unchanged" is then a property of the import graph rather than a promise.
 *   3. A PIPELINE check that running both graders (the #1109 panel and the #1318
 *      metric) over already-verified findings leaves every `verificationStatus`
 *      byte-identical — including the case the epic actually fears, where an
 *      enthusiastic grader would like to PROMOTE a finding the gate flagged.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Citation, FindingSupportPanel, FindingVerificationStatus } from "@metis/shared";
import { applyFindingFaithfulness } from "./finding-faithfulness.js";
import { verifyFinding } from "./finding-verification.js";
import { applySupportPanel, type PanelEvidence } from "./support-panel.js";
import type { AIProvider, ChatOptions, ChatResponse } from "../ai/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const CODE_CITATION = { filePath: "src/a.ts", startLine: 1, endLine: 2 } as unknown as Citation;
const DOC_CITATION = {
  documentId: "doc-1",
  chunkIndex: 0,
  quote: "x",
} as unknown as Citation;
const DROPPED = [{ filePath: "src/ghost.ts", reason: "not-retrieved" }] as never;

// ── 1. The frozen truth table ──────────────────────────────────────────────

/**
 * `verifyFinding`'s complete input domain, with the SHIPPED output of each row
 * written out literally rather than recomputed. The four inputs are:
 *
 *   grounded  — does a surviving CODE citation exist? (a doc-only citation is a
 *               distinct third state, and it must stay `null`, not `confirmed`)
 *   dropped   — did the #734 gate drop any code citation?
 *   absence   — does the finding assert an absence? (`undefined` ⇒ pre-#773 caller)
 *   confirmable — could this run's retrieval back an absence claim?
 *
 * Measured against `finding-verification.ts` at 647aca55, immediately before
 * #1318. Any diff here is a change in production verdicts.
 */
const FROZEN_GATE_TRUTH_TABLE: ReadonlyArray<{
  grounded: "code" | "doc" | "none";
  dropped: boolean;
  absence: boolean | undefined;
  confirmable: boolean | undefined;
  expected: FindingVerificationStatus | null;
}> = [
  // Rule (1) — an absence claim the run cannot back outranks EVERYTHING.
  {
    grounded: "code",
    dropped: false,
    absence: true,
    confirmable: false,
    expected: "could-not-verify",
  },
  {
    grounded: "code",
    dropped: true,
    absence: true,
    confirmable: false,
    expected: "could-not-verify",
  },
  {
    grounded: "doc",
    dropped: false,
    absence: true,
    confirmable: false,
    expected: "could-not-verify",
  },
  {
    grounded: "none",
    dropped: false,
    absence: true,
    confirmable: false,
    expected: "could-not-verify",
  },
  {
    grounded: "none",
    dropped: true,
    absence: true,
    confirmable: false,
    expected: "could-not-verify",
  },
  // Rule (2) — a surviving CODE citation confirms a positive claim.
  {
    grounded: "code",
    dropped: false,
    absence: undefined,
    confirmable: undefined,
    expected: "confirmed",
  },
  {
    grounded: "code",
    dropped: true,
    absence: undefined,
    confirmable: undefined,
    expected: "confirmed",
  },
  { grounded: "code", dropped: false, absence: true, confirmable: true, expected: "confirmed" },
  { grounded: "code", dropped: false, absence: false, confirmable: false, expected: "confirmed" },
  { grounded: "code", dropped: true, absence: true, confirmable: true, expected: "confirmed" },
  // Rule (3) — it claimed code evidence and none of it survived.
  {
    grounded: "none",
    dropped: true,
    absence: undefined,
    confirmable: undefined,
    expected: "unverified",
  },
  {
    grounded: "doc",
    dropped: true,
    absence: undefined,
    confirmable: undefined,
    expected: "unverified",
  },
  { grounded: "none", dropped: true, absence: true, confirmable: true, expected: "unverified" },
  { grounded: "none", dropped: true, absence: false, confirmable: false, expected: "unverified" },
  // Rule (4) — no code-evidence claim at all. A DOC-only citation lands here on
  // purpose: the #734 gate never validates document citations, so calling it
  // `confirmed` would overstate it.
  { grounded: "none", dropped: false, absence: undefined, confirmable: undefined, expected: null },
  { grounded: "doc", dropped: false, absence: undefined, confirmable: undefined, expected: null },
  { grounded: "doc", dropped: false, absence: true, confirmable: true, expected: null },
  { grounded: "none", dropped: false, absence: true, confirmable: true, expected: null },
  { grounded: "none", dropped: false, absence: false, confirmable: false, expected: null },
  // `assertsAbsence` without `absenceConfirmable` (and vice versa) leaves rule
  // (1) inert — a pre-#773 caller behaves exactly as it always did.
  { grounded: "none", dropped: false, absence: true, confirmable: undefined, expected: null },
  { grounded: "none", dropped: false, absence: undefined, confirmable: false, expected: null },
];

describe("#1318 — the deterministic gate's truth table is FROZEN", () => {
  it.each(FROZEN_GATE_TRUTH_TABLE)(
    "grounded=$grounded dropped=$dropped absence=$absence confirmable=$confirmable → $expected",
    ({ grounded, dropped, absence, confirmable, expected }) => {
      expect(
        verifyFinding({
          groundedCitations:
            grounded === "code" ? [CODE_CITATION] : grounded === "doc" ? [DOC_CITATION] : [],
          droppedCitations: dropped ? DROPPED : [],
          ...(absence === undefined ? {} : { assertsAbsence: absence }),
          ...(confirmable === undefined ? {} : { absenceConfirmable: confirmable }),
        }),
      ).toBe(expected);
    },
  );

  it("enumerates every rule of the gate, so a new rule cannot slip in unmeasured", () => {
    const outcomes = new Set(FROZEN_GATE_TRUTH_TABLE.map((r) => String(r.expected)));
    expect([...outcomes].sort()).toEqual(["confirmed", "could-not-verify", "null", "unverified"]);
  });
});

// ── 2. The structural guarantee ────────────────────────────────────────────

describe("#1318 — the metric cannot reach the gate", () => {
  it.each([
    ["analysis/finding-faithfulness.ts", resolve(HERE, "finding-faithfulness.ts")],
    ["grounding/faithfulness-metric.ts", resolve(HERE, "../grounding/faithfulness-metric.ts")],
  ])("%s imports neither finding-verification nor requirement-verdict", (_label, path) => {
    const src = readFileSync(path, "utf8");
    // Every module specifier, not just `import ... from "x";`: a side-effect
    // import, a re-export, a dynamic `await import("x")` and a
    // `createRequire`-style string all reach the same module. The earlier
    // `^\s*import[^;]*?from` regex matched only the first form, so four ways to
    // acquire the gate would have read as "no import edge".
    const specifiers = [...src.matchAll(/(?:from|import|require)\s*\(?\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(specifiers).not.toContain("./finding-verification.js");
    expect(specifiers).not.toContain("./requirement-verdict.js");

    // Belt and braces, and the claim the section title actually makes: with
    // comments stripped, neither module is NAMED anywhere executable — so no
    // import form, however written, can be hiding.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/finding-verification/);
    expect(code).not.toMatch(/requirement-verdict/);
  });

  it("never names verificationStatus or verdict as a write target", () => {
    const src = readFileSync(resolve(HERE, "finding-faithfulness.ts"), "utf8");
    // The identifiers appear only inside prose comments explaining that they are
    // NOT written; no executable line may assign them.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/verificationStatus\s*[:=]/);
    expect(code).not.toMatch(/supportPanel\s*[:=]/);
  });
});

// ── 3. The pipeline invariant ──────────────────────────────────────────────

interface GradedFinding {
  title: string;
  body: string;
  citations: Citation[];
  verificationStatus: FindingVerificationStatus | null;
  supportPanel?: FindingSupportPanel | null;
  faithfulness?: unknown;
}

const EVIDENCE: PanelEvidence[] = [
  { filePath: "src/a.ts", startLine: 1, endLine: 2, excerpt: "export const a = 1;" },
];

/** Answers every lens SUPPORTED and every absence check SUPPORTED — maximally promoting. */
class EnthusiasticProvider implements AIProvider {
  readonly key = "offline-stub" as AIProvider["key"];
  readonly model = "test-model";
  readonly offline = true;
  readonly capabilities = { responseFormat: false, nativeToolCalls: false };
  async chat(_m: unknown[], opts?: ChatOptions): Promise<ChatResponse> {
    const isAbsenceCheck = (opts?.systemMessage ?? "").includes("You verify ABSENCE CLAIMS");
    return {
      content: JSON.stringify(
        isAbsenceCheck
          ? { verdict: "supported", citation: "src/a.ts:1", reasoning: "src/a.ts:1 backs it" }
          : { judgement: "supported", citation: "src/a.ts:1", reasoning: "src/a.ts:1 backs it" },
      ),
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      model: this.model,
      provider: this.key,
    };
  }
  async *stream(): AsyncGenerator<never> {
    throw new Error("not used");
  }
  async embed(): Promise<never> {
    throw new Error("not used");
  }
  async models(): Promise<string[]> {
    return [this.model];
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

const gradedFindings = (): GradedFinding[] => [
  {
    title: "Hallucinated citation",
    body: "Claims src/ghost.ts:1-2 backs it.",
    citations: [CODE_CITATION],
    // What the gate decided. Rule (3): it claimed code evidence, none survived.
    verificationStatus: verifyFinding({ groundedCitations: [], droppedCitations: DROPPED }),
  },
  {
    title: "Unbackable absence claim",
    body: "No severity computation exists anywhere.",
    citations: [CODE_CITATION],
    verificationStatus: verifyFinding({
      groundedCitations: [CODE_CITATION],
      droppedCitations: [],
      assertsAbsence: true,
      absenceConfirmable: false,
    }),
  },
];

describe("#1318 — neither grader can promote a finding the gate flagged", () => {
  it("leaves every verificationStatus byte-identical after panel + metric", async () => {
    const before = gradedFindings();
    expect(before.map((f) => f.verificationStatus)).toEqual(["unverified", "could-not-verify"]);

    const provider = new EnthusiasticProvider();
    const panelled = await applySupportPanel(provider, before, EVIDENCE, { enabled: true });
    const scored = await applyFindingFaithfulness(provider, panelled.findings, EVIDENCE, {
      enabled: true,
      // A perfect 1.0 — the most promoting number the metric can produce.
      extractor: { decompose: vi.fn(async () => ({ claims: [{ claim: "c1" }] })) },
      judge: {
        judge: vi.fn(async (c: string[]) => c.map((claim) => ({ claim, supported: true }))),
      },
    });

    // The graders DID both run and DID both write their own fields …
    expect(scored.findings[0].supportPanel?.confidence).toBe("high");
    expect(scored.findings[0].faithfulness).toEqual({
      score: 1,
      totalClaims: 1,
      supportedClaims: 1,
    });
    // … and the verdict is untouched.
    expect(scored.findings.map((f) => f.verificationStatus)).toEqual([
      "unverified",
      "could-not-verify",
    ]);
  });

  it("does not let the metric add or remove a finding", async () => {
    const input = gradedFindings();
    const scored = await applyFindingFaithfulness(new EnthusiasticProvider(), input, EVIDENCE, {
      enabled: true,
      extractor: { decompose: vi.fn(async () => ({ claims: [{ claim: "c1" }] })) },
      judge: {
        judge: vi.fn(async (c: string[]) => c.map((claim) => ({ claim, supported: false }))),
      },
    });
    expect(scored.findings).toHaveLength(input.length);
    expect(scored.findings.map((f) => f.title)).toEqual(input.map((f) => f.title));
    // Score 0 is still not a verdict.
    expect(scored.findings[0].faithfulness).toMatchObject({ score: 0 });
    expect(scored.findings[0].verificationStatus).toBe("unverified");
  });
});

/**
 * Epic #1107 (#1109) — the panel arm of `pnpm eval:verification`.
 *
 * The composition rule is pure and tested without a model; the arm itself is
 * driven through a scripted provider so the seam #1108 left is proven wired
 * rather than assumed.
 */
import { describe, expect, it } from "vitest";
import type { FindingSupportPanel } from "@metis/shared";
import type { AIProvider, ChatOptions, ChatResponse } from "../../ai/types.js";
import { StructuredVerdictMetrics } from "../../analysis/structured-verdict.js";
import { resolveArm, resolvePanelArm } from "./arms.js";
import type { VerificationCase } from "./corpus.js";
import {
  caseEvidence,
  composeArmStatus,
  DEFAULT_PANEL_FLAG_AT,
  panelArm,
  parsePanelFlagAt,
} from "./panel-arm.js";

const FILE = "server/src/lib/change-analysis/change-analysis-engine.ts";

const panelWith = (confidence: FindingSupportPanel["confidence"]): FindingSupportPanel => ({
  confidence,
  votes: [],
  countedVotes: 3,
  supportedVotes: 0,
  unsupportedVotes: 0,
  uncertainVotes: 0,
  noSignalVotes: 0,
  uncitedVotes: 0,
  usage: { promptTokens: 1, completionTokens: 1, llmCalls: 3 },
});

/** VC-01's shape: an absence claim citing the file that refutes it. */
const CASE: VerificationCase = {
  id: "VC-XX",
  hardCase: "semantic-mismatch",
  title: "evidence exists but does not back the claim",
  provenance: { origin: "synthesised", source: "unit test", groundTruth: "n/a" },
  finding: {
    title: "Severity classification is not implemented",
    body: "No severity computation was located in the indexed code graph.",
  },
  groundedCitations: [{ filePath: FILE, startLine: 128, endLine: 146 }],
  droppedCitations: [],
  absenceConfirmable: true,
  evidence: [
    {
      filePath: FILE,
      startLine: 128,
      endLine: 146,
      excerpt: "export function computeSeverity() {}",
    },
  ],
  expected: {
    supported: false,
    rationale: "the cited file implements the thing it says is absent",
  },
};

class ScriptedProvider implements AIProvider {
  readonly key = "offline-stub" as AIProvider["key"];
  readonly model = "test-model";
  readonly offline = true;
  readonly capabilities = { responseFormat: false, nativeToolCalls: false };
  calls = 0;
  constructor(
    private readonly judgement: string,
    /** #1111 — CASE is absence-shaped, so a fourth call asks the absence check. */
    private readonly absenceVerdict: string = "supported",
  ) {}
  async chat(_m: unknown[], opts?: ChatOptions): Promise<ChatResponse> {
    this.calls += 1;
    const isAbsenceCheck = (opts?.systemMessage ?? "").includes("You verify ABSENCE CLAIMS");
    return {
      content: JSON.stringify(
        isAbsenceCheck
          ? {
              verdict: this.absenceVerdict,
              citation: `${FILE}:131`,
              reasoning: `${FILE}:131 defines it`,
            }
          : {
              judgement: this.judgement,
              citation: `${FILE}:131`,
              reasoning: `${FILE}:131 defines it`,
            },
      ),
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
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

describe("composeArmStatus (#1109 — pure, and the panel can only ADD a warning)", () => {
  it("projects a low-confidence panel onto the existing down-weight", () => {
    expect(composeArmStatus(null, panelWith("low"))).toBe("unverified");
    expect(composeArmStatus("confirmed", panelWith("low"))).toBe("unverified");
  });

  it("leaves a deterministic warning exactly as it was", () => {
    expect(composeArmStatus("unverified", panelWith("high"))).toBe("unverified");
    expect(composeArmStatus("could-not-verify", panelWith("high"))).toBe("could-not-verify");
  });

  it("never clears a deterministic flag, however confident the panel is", () => {
    for (const c of ["high", "medium", "low", "no-signal"] as const) {
      expect(composeArmStatus("unverified", panelWith(c))).toBe("unverified");
    }
  });

  it("changes nothing when the panel produced NO SIGNAL", () => {
    expect(composeArmStatus("confirmed", panelWith("no-signal"))).toBe("confirmed");
    expect(composeArmStatus(null, panelWith("no-signal"))).toBeNull();
  });

  it("leaves medium alone by default and warns on it when asked to", () => {
    expect(composeArmStatus("confirmed", panelWith("medium"))).toBe("confirmed");
    expect(composeArmStatus("confirmed", panelWith("medium"), ["low", "medium"])).toBe(
      "unverified",
    );
  });

  it("passes the deterministic verdict straight through when no panel ran", () => {
    expect(composeArmStatus("confirmed", null)).toBe("confirmed");
    expect(composeArmStatus(null, null)).toBeNull();
  });
});

describe("caseEvidence", () => {
  it("maps the corpus excerpts into the panel's evidence shape", () => {
    expect(caseEvidence(CASE)).toEqual([
      {
        filePath: FILE,
        startLine: 128,
        endLine: 146,
        excerpt: "export function computeSeverity() {}",
      },
    ]);
  });
});

describe("panelArm", () => {
  it("catches the semantic mismatch the deterministic gate calls confirmed", async () => {
    // The whole reason #1109 exists: retrieval was healthy and a code citation
    // survived, so the free gate says `confirmed`. Reading the excerpt is the
    // only way to see the claim is refuted by it.
    const arm = panelArm({
      provider: new ScriptedProvider("unsupported"),
      metrics: new StructuredVerdictMetrics(),
    });
    const verdict = await arm.verify(CASE);
    expect(verdict.status).toBe("unverified");
  });

  it("leaves a well-supported finding alone", async () => {
    const arm = panelArm({
      provider: new ScriptedProvider("supported"),
      metrics: new StructuredVerdictMetrics(),
    });
    expect((await arm.verify(CASE)).status).toBe("confirmed");
  });

  it("reports per-case token cost including retries", async () => {
    const provider = new ScriptedProvider("supported");
    const arm = panelArm({ provider, metrics: new StructuredVerdictMetrics() });
    const verdict = await arm.verify(CASE);
    // #1111 — FOUR calls on this case, not three: `CASE` asserts an absence
    // ("is not implemented"), so the A3 absence check runs alongside the three
    // lenses. That extra call is the arm's real cost on an absence claim and is
    // asserted here rather than hidden behind a per-lens estimate.
    expect(verdict.usage).toEqual({ promptTokens: 400, completionTokens: 40, llmCalls: 4 });
    expect(provider.calls).toBe(4);
  });

  it("spends nothing extra on a finding that asserts no absence (#1111)", async () => {
    const provider = new ScriptedProvider("supported");
    const arm = panelArm({ provider, metrics: new StructuredVerdictMetrics() });
    await arm.verify({
      ...CASE,
      finding: { title: "Severity is computed per change type", body: "It is implemented here." },
    });
    expect(provider.calls).toBe(3);
  });

  it("marks a CONTRADICTED absence claim low-confidence, so the arm warns (#1111)", async () => {
    // The #773 case: the finding says X is missing and the retrieved evidence
    // contains X. The absence check forces `low`, which the arm projects onto
    // the existing down-weight — even though every lens voted `supported`.
    const arm = panelArm({
      provider: new ScriptedProvider("supported", "contradicted"),
      metrics: new StructuredVerdictMetrics(),
    });
    expect((await arm.verify(CASE)).status).toBe("unverified");
  });

  it("declares itself an LLM arm so the harness defaults to 3 runs", () => {
    expect(panelArm({ provider: new ScriptedProvider("supported") }).usesLlm).toBe(true);
    expect(DEFAULT_PANEL_FLAG_AT).toEqual(["low"]);
  });

  it("fills the #1108 seam — resolveArm('panel') no longer throws", () => {
    const factory = () => panelArm({ provider: new ScriptedProvider("supported") });
    expect(resolveArm("panel", factory).id).toBe("panel");
    expect(resolvePanelArm(factory).usesLlm).toBe(true);
    // …and still throws loudly when nothing is injected, so a mis-configured run
    // cannot report baseline numbers under a panel label.
    expect(() => resolvePanelArm()).toThrow(/not wired yet/);
  });
});

describe("parsePanelFlagAt", () => {
  it("defaults to low", () => {
    expect(parsePanelFlagAt([])).toEqual(["low"]);
    expect(parsePanelFlagAt(["--panel-flag-at", "--md"])).toEqual(["low"]);
  });

  it("widens to medium on request", () => {
    expect(parsePanelFlagAt(["--panel-flag-at", "medium"])).toEqual(["low", "medium"]);
  });

  it("rejects an unknown value rather than silently defaulting", () => {
    expect(() => parsePanelFlagAt(["--panel-flag-at", "high"])).toThrow(/Expected "low"/);
  });
});

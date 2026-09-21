/**
 * Epic #1107 (#1111 / A3) — the absence check WIRED INTO the #1109 panel.
 *
 * `absence-verification.test.ts` proves the verifier's rules in isolation. This
 * file proves the composition: that the check fires on exactly the findings the
 * #773 classifier calls absence claims, that it reads the same evidence the
 * lenses read, that its verdict reaches `FindingSupportPanel.confidence`, and
 * that a non-absence finding's panel is byte-identical to a pre-#1111 one.
 */
import { describe, expect, it } from "vitest";
import type { Citation } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import { StructuredVerdictMetrics } from "./structured-verdict.js";
import { applySupportPanel, runSupportPanel, type PanelEvidence } from "./support-panel.js";

const FILE = "server/src/lib/change-analysis/change-analysis-engine.ts";

const EVIDENCE: PanelEvidence[] = [
  {
    filePath: FILE,
    startLine: 128,
    endLine: 146,
    excerpt: "export function computeSeverity(changeType, bodyDelta) { return 'low'; }",
  },
];

const CITATIONS: Citation[] = [{ filePath: FILE, startLine: 128, endLine: 146 }];

/** #773's own example: told a user to build `computeSeverity`, which existed. */
const ABSENCE_FINDING = {
  title: "No evidence found for drift severity classification",
  body: "No implementation of a severity computation was located, so this is a confirmed gap.",
};

const POSITIVE_FINDING = {
  title: "Severity is computed per change type",
  body: "computeSeverity maps the change type onto a severity band.",
};

/**
 * Answers lens calls and absence calls independently, keyed off the system
 * prompt — the same discrimination a real provider sees.
 */
class PanelProvider implements AIProvider {
  readonly key = "offline-stub" as AIProvider["key"];
  readonly model = "test-model";
  readonly offline = true;
  readonly capabilities = { responseFormat: false, nativeToolCalls: false };
  readonly calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];

  constructor(
    private readonly lensJudgement: string,
    private readonly absence: { verdict: string; citation?: string | null } | Error,
  ) {}

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    this.calls.push({ messages, opts });
    const system = opts?.systemMessage ?? "";
    if (system.includes("You verify ABSENCE CLAIMS")) {
      if (this.absence instanceof Error) throw this.absence;
      return this.reply(
        JSON.stringify({
          verdict: this.absence.verdict,
          citation: this.absence.citation === undefined ? `${FILE}:131` : this.absence.citation,
          reasoning: "the excerpt decided it",
        }),
      );
    }
    return this.reply(
      JSON.stringify({
        judgement: this.lensJudgement,
        citation: `${FILE}:131`,
        reasoning: `decided at ${FILE}:131`,
      }),
    );
  }

  private reply(content: string): ChatResponse {
    return {
      content,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
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

const run = (
  provider: AIProvider,
  finding = ABSENCE_FINDING,
  over: Parameters<typeof runSupportPanel>[2] = {},
) =>
  runSupportPanel(
    provider,
    { finding, citations: CITATIONS, evidencePool: EVIDENCE },
    { enabled: true, metrics: new StructuredVerdictMetrics(), ...over },
  );

describe("runSupportPanel + absence check (#1111 — detection)", () => {
  it("fires on an absence-shaped finding: three lenses PLUS the absence check", async () => {
    const provider = new PanelProvider("supported", { verdict: "supported" });
    const panel = await run(provider);
    expect(provider.calls).toHaveLength(4);
    expect(panel?.absenceCheck).toMatchObject({ verdict: "supported" });
  });

  it("does NOT fire on a positive finding, and adds no key to its panel", async () => {
    const provider = new PanelProvider("supported", { verdict: "supported" });
    const panel = await run(provider, POSITIVE_FINDING);
    expect(provider.calls).toHaveLength(3);
    // Absent, not `null`: a non-absence finding's persisted panel is
    // byte-identical to a pre-#1111 one.
    expect(Object.keys(panel ?? {})).not.toContain("absenceCheck");
  });

  it("honours an explicit override in both directions", async () => {
    const on = new PanelProvider("supported", { verdict: "unexamined", citation: null });
    await run(on, POSITIVE_FINDING, { absenceClaim: true });
    expect(on.calls).toHaveLength(4);

    const off = new PanelProvider("supported", { verdict: "supported" });
    await run(off, ABSENCE_FINDING, { absenceClaim: false });
    expect(off.calls).toHaveLength(3);
  });

  it("uses the SAME classifier as the #773 deterministic gate", async () => {
    // `assertsAbsence` matched here, or the panel would have made three calls.
    const provider = new PanelProvider("supported", { verdict: "supported" });
    await run(provider, {
      title: "There is no authorization check on the export endpoint",
      body: "The handler returns the export straight from params.",
    });
    expect(provider.calls).toHaveLength(4);
  });
});

describe("runSupportPanel + absence check (#1111 — the verdict reaches confidence)", () => {
  it("forces LOW on a contradicted claim even when every lens supported it", async () => {
    // The acceptance criterion, end to end: the thing said to be missing WAS
    // retrieved, so the finding is low-confidence with the file:line cited.
    const panel = await run(new PanelProvider("supported", { verdict: "contradicted" }));
    expect(panel?.confidence).toBe("low");
    expect(panel?.absenceCheck?.citation).toBe(`${FILE}:131`);
    // The tally is untouched — the counts still say what the LENSES said, so
    // the label and its evidence stay independently auditable.
    expect(panel?.supportedVotes).toBe(3);
    expect(panel?.countedVotes).toBe(3);
  });

  it("caps an UNEXAMINED claim at medium instead of advertising high", async () => {
    const panel = await run(
      new PanelProvider("supported", { verdict: "unexamined", citation: null }),
    );
    expect(panel?.confidence).toBe("medium");
    expect(panel?.absenceCheck?.verdict).toBe("unexamined");
  });

  it("leaves a SUPPORTED absence claim at whatever the lenses decided", async () => {
    const panel = await run(new PanelProvider("supported", { verdict: "supported" }));
    expect(panel?.confidence).toBe("high");
  });

  it("records an ungrounded `supported` as `unexamined`, never as supported", async () => {
    // End-to-end form of the crux: the verifier claimed it looked, could not say
    // where, and the panel therefore does not advertise confidence.
    const panel = await run(
      new PanelProvider("supported", { verdict: "supported", citation: null }),
    );
    expect(panel?.absenceCheck).toMatchObject({
      verdict: "unexamined",
      downgradedFrom: "supported",
    });
    expect(panel?.confidence).toBe("medium");
  });

  it("degrades the absence check without touching the lens tally", async () => {
    const panel = await run(new PanelProvider("supported", new Error("upstream 503")));
    expect(panel?.confidence).toBe("high");
    expect(panel?.absenceCheck?.verdict).toBeNull();
    expect(panel?.absenceCheck?.noSignalReason).toContain("provider-error");
  });
});

describe("runSupportPanel + absence check (#1111 — cost and evidence bounds)", () => {
  it("bills the absence call into the panel's own usage", async () => {
    const panel = await run(new PanelProvider("supported", { verdict: "supported" }));
    expect(panel?.usage).toEqual({ promptTokens: 400, completionTokens: 80, llmCalls: 4 });
  });

  it("shows the absence check the SAME evidence block the lenses saw", async () => {
    // If they saw different evidence, "the panel says X but the absence check
    // says Y" would be unresolvable.
    const provider = new PanelProvider("supported", { verdict: "supported" });
    await run(provider);
    const absenceCall = provider.calls.find((c) =>
      (c.opts?.systemMessage ?? "").includes("You verify ABSENCE CLAIMS"),
    );
    const lensCall = provider.calls.find((c) =>
      (c.opts?.systemMessage ?? "").includes("YOUR LENS: SUPPORT"),
    );
    const excerpt = EVIDENCE[0].excerpt;
    expect(String(absenceCall?.messages[0]?.content)).toContain(excerpt);
    expect(String(lensCall?.messages[0]?.content)).toContain(excerpt);
  });

  it("never reaches beyond the retrieved set — no evidence means no panel at all", async () => {
    const provider = new PanelProvider("supported", { verdict: "supported" });
    const panel = await runSupportPanel(
      provider,
      { finding: ABSENCE_FINDING, citations: CITATIONS, evidencePool: [] },
      { enabled: true },
    );
    expect(panel).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("makes no call at all when the flag is off", async () => {
    const provider = new PanelProvider("supported", { verdict: "contradicted" });
    expect(await run(provider, ABSENCE_FINDING, { enabled: false })).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });
});

describe("applySupportPanel + absence check (#1111 — still never drops a finding)", () => {
  it("keeps a contradicted absence finding, marked low", async () => {
    const findings = [{ ...ABSENCE_FINDING, citations: CITATIONS }];
    const out = await applySupportPanel(
      new PanelProvider("supported", { verdict: "contradicted" }),
      findings,
      EVIDENCE,
      { enabled: true, metrics: new StructuredVerdictMetrics() },
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].supportPanel?.confidence).toBe("low");
    expect(out.findings[0].supportPanel?.absenceCheck?.verdict).toBe("contradicted");
  });

  it("folds the absence call's tokens into the agent's usage", async () => {
    const findings = [{ ...ABSENCE_FINDING, citations: CITATIONS }];
    const out = await applySupportPanel(
      new PanelProvider("supported", { verdict: "supported" }),
      findings,
      EVIDENCE,
      { enabled: true, metrics: new StructuredVerdictMetrics() },
    );
    expect(out.usage.totalTokens).toBe(480);
  });
});

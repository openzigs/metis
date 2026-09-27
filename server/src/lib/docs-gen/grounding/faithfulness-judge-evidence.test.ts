/**
 * #171 — the faithfulness judge sees the evidence its claims need, not the
 * whole section's: the union of the sources a batch's claims cite, a bounded
 * top-k retrieval for a claim that cites none, and the relevant lines of a
 * source too large for its share of the budget.
 */
import { describe, expect, it, vi } from "vitest";

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock("../../logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../logger.js")>();
  return {
    ...real,
    createChildLogger: (name: string) => {
      const child = real.createChildLogger(name);
      return name === "docs-gen:faithfulness-judge"
        ? Object.assign(Object.create(child), { warn: warnSpy })
        : child;
    },
  };
});
import type { AIProvider, ChatMessage } from "../../ai/types.js";
import {
  DEFAULT_JUDGE_CHAR_BUDGET,
  FaithfulnessJudge,
  JUDGE_UNCITED_TOP_K,
} from "./faithfulness-judge.js";
import { scoreFaithfulness } from "./citation-validator.js";
import { buildGroundingContext, factsSourceId } from "./grounding-context.js";

/** A provider that supports every claim it is shown and records each prompt. */
function recordingProvider() {
  const prompts: string[] = [];
  const provider = {
    key: "local-test",
    model: "judge",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      const user = String(messages[1].content);
      prompts.push(user);
      const block = user.slice(user.indexOf("=== CLAIMS TO JUDGE"));
      const claims = [...block.matchAll(/^\d+\.\s+(.*)$/gm)].map((m) => m[1].trim());
      return {
        content: JSON.stringify({
          verdicts: claims.map((claim) => ({ claim, supported: true, sourceIds: [] })),
        }),
        finishReason: "stop",
      };
    }),
  } as unknown as AIProvider;
  return { provider, prompts };
}

const evidenceOf = (prompt: string) =>
  prompt.slice(
    prompt.indexOf("=== SOURCE EVIDENCE"),
    prompt.indexOf("=== END SOURCE EVIDENCE ==="),
  );

/** `n` modules, each a distinct topic, each `size` characters of facts. */
function modules(n: number, size: number) {
  return Array.from({ length: n }, (_, i) => {
    const head = `### MODULE: mod${i}\n- The topic${i} ledger posts entries for region${i}.`;
    const filler = `\n- Detail line for module ${i} padding the facts entry.`;
    let text = head;
    while (text.length < size) text += filler;
    return { moduleDir: `src/mod${i}`, idx: i, label: `mod${i}`, text };
  });
}

describe("FaithfulnessJudge — evidence per batch (#171)", () => {
  it("shows a batch the sources its claims cite, and no other", async () => {
    const facts = modules(6, 400);
    const ctx = buildGroundingContext({ factsSources: facts });
    const { provider, prompts } = recordingProvider();
    const judge = new FaithfulnessJudge({ provider });
    const ids = facts.map((f) => factsSourceId(f.moduleDir, f.idx));
    const out = await judge.judge(
      ["The topic2 ledger posts entries.", "Region4 is posted."],
      ctx,
      undefined,
      undefined,
      [[ids[2]], [ids[4]]],
    );
    expect(out).toHaveLength(2);
    const evidence = evidenceOf(prompts[0]);
    expect(evidence).toContain(`id=${ids[2]}`);
    expect(evidence).toContain(`id=${ids[4]}`);
    for (const i of [0, 1, 3, 5]) expect(evidence).not.toContain(`id=${ids[i]}`);
  });

  it("gives a claim that cites nothing a bounded top-k retrieval, not the whole context", async () => {
    const facts = modules(12, 300);
    const ctx = buildGroundingContext({ factsSources: facts });
    const { provider, prompts } = recordingProvider();
    const judge = new FaithfulnessJudge({ provider });
    // An id the context does not hold counts as citing nothing.
    await judge.judge(["The topic7 ledger serves region7."], ctx, undefined, undefined, [
      ["facts:nowhere:99"],
    ]);
    const evidence = evidenceOf(prompts[0]);
    const shown = [...evidence.matchAll(/\[id=([^\s\]]+)/g)].map((m) => m[1]);
    expect(shown.length).toBeLessThanOrEqual(JUDGE_UNCITED_TOP_K);
    expect(shown).toContain(factsSourceId("src/mod7", 7));
  });

  // PR #281 review — a source whose budget share ran out vanished silently.
  it("logs the sources a batch selected but its budget could not show", () => {
    warnSpy.mockClear();
    const facts = Array.from({ length: 40 }, (_, i) => ({
      moduleDir: `src/mod${i}`,
      idx: i,
      label: `mod${i}`,
      text: `- Module ${i} posts ledger entries nightly.`.repeat(5),
    }));
    const ctx = buildGroundingContext({ factsSources: facts, charBudget: 1_000_000 });
    const judge = new FaithfulnessJudge({
      provider: recordingProvider().provider,
      charBudget: 1_500,
    });
    const cites = facts.map((f) => factsSourceId(f.moduleDir, f.idx));
    const evidence = judge.renderEvidenceForClaims(
      [{ claim: "Modules post ledger entries.", cites }],
      ctx,
    );
    const shown = cites.filter((id) => evidence.includes(id)).length;
    expect(shown).toBeLessThan(40);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("some selected sources were not shown"),
      expect.objectContaining({ selected: 40, omitted: 40 - shown }),
    );
  });

  it("logs nothing when every selected source fits", () => {
    warnSpy.mockClear();
    const ctx = buildGroundingContext({
      factsSources: [{ moduleDir: "src/a", idx: 0, label: "a", text: "- A posts entries." }],
      charBudget: 1_000_000,
    });
    new FaithfulnessJudge({ provider: recordingProvider().provider }).renderEvidenceForClaims(
      [{ claim: "A posts entries.", cites: [factsSourceId("src/a", 0)] }],
      ctx,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("cuts an over-budget source to the lines its claims need, deep lines included", () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `- filler fact number ${i}.`);
    lines[3_700] = "- Premiums above the ceiling are capped by the reinsurance treaty.";
    const ctx = buildGroundingContext({
      factsSources: [{ moduleDir: "src/big", idx: 0, label: "big", text: lines.join("\n") }],
      charBudget: 1_000_000,
    });
    const judge = new FaithfulnessJudge({ provider: recordingProvider().provider });
    const evidence = judge.renderEvidenceForClaims(
      [{ claim: "The reinsurance treaty caps premiums above the ceiling.", cites: [] }],
      ctx,
    );
    expect(evidence.length).toBeLessThanOrEqual(DEFAULT_JUDGE_CHAR_BUDGET);
    expect(evidence).toContain("capped by the reinsurance treaty");
    // A neighbouring line of context either side.
    expect(evidence).toContain("filler fact number 3699.");
    expect(evidence).toContain("filler fact number 3701.");
  });

  it("the judge prompt is the same size whatever the facts cap let into the context", async () => {
    // A larger facts cap admits more modules; the claims and what they cite do
    // not change, so neither may the judge's prompt.
    const claims = ["The topic1 ledger posts entries for region1."];
    const sizes: number[] = [];
    for (const moduleCount of [8, 40]) {
      const facts = modules(moduleCount, 5_000);
      const ctx = buildGroundingContext({ factsSources: facts, charBudget: 10_000_000 });
      const { provider, prompts } = recordingProvider();
      await new FaithfulnessJudge({ provider }).judge(claims, ctx, undefined, undefined, [
        [factsSourceId("src/mod1", 1)],
      ]);
      sizes.push(prompts[0].length);
    }
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[1]).toBeLessThan(8_000);
  });

  it("a batch re-run as halves shows each half only its own claims' sources", async () => {
    const facts = modules(4, 300);
    const ids = facts.map((f) => factsSourceId(f.moduleDir, f.idx));
    const ctx = buildGroundingContext({ factsSources: facts });
    const prompts: string[] = [];
    let call = 0;
    const provider = {
      key: "local-test",
      model: "judge",
      offline: false,
      chat: vi.fn(async (messages: ChatMessage[]) => {
        prompts.push(String(messages[1].content));
        // First call: no verdicts (a lost judge); the halves answer.
        const user = String(messages[1].content);
        const block = user.slice(user.indexOf("=== CLAIMS TO JUDGE"));
        const cs = [...block.matchAll(/^\d+\.\s+(.*)$/gm)].map((m) => m[1].trim());
        const verdicts =
          call++ === 0 ? [] : cs.map((claim) => ({ claim, supported: true, sourceIds: [] }));
        return { content: JSON.stringify({ verdicts }), finishReason: "stop" };
      }),
    } as unknown as AIProvider;
    const out = await new FaithfulnessJudge({ provider }).judge(
      ["topic0 claim", "topic1 claim", "topic2 claim", "topic3 claim"],
      ctx,
      undefined,
      undefined,
      ids.map((id) => [id]),
    );
    expect(out).toHaveLength(4);
    expect(prompts).toHaveLength(3);
    expect(evidenceOf(prompts[1])).toContain(`id=${ids[0]}`);
    expect(evidenceOf(prompts[1])).not.toContain(`id=${ids[2]}`);
    expect(evidenceOf(prompts[2])).toContain(`id=${ids[3]}`);
    expect(evidenceOf(prompts[2])).not.toContain(`id=${ids[1]}`);
  });

  it("scoreFaithfulness hands the judge each claim's citations", async () => {
    const facts = modules(6, 400);
    const ids = facts.map((f) => factsSourceId(f.moduleDir, f.idx));
    const ctx = buildGroundingContext({ factsSources: facts });
    const { provider, prompts } = recordingProvider();
    const result = await scoreFaithfulness("Rules", "text", ctx, {
      extractor: {
        decompose: async () => ({ claims: [{ claim: "Region5 is posted.", sourceIds: [ids[3]] }] }),
      },
      judge: new FaithfulnessJudge({ provider }),
    });
    expect(result.verified).toBe(true);
    const evidence = evidenceOf(prompts[0]);
    // Cited mod3, though the claim's words point at mod5.
    expect(evidence).toContain(`id=${ids[3]}`);
    expect(evidence).not.toContain(`id=${ids[5]}`);
  });
});

/**
 * Issue #1117 (findings B + C) — synthesis must say when it degraded.
 *
 * ROOT CAUSE, established from the run that filed the issue
 * (analysis `cms4l0n7p00016b9kho2zs4bb`): its persisted synthesis output began
 * `{"summary":"Auto-synthesized 16 requirement(s) from 26 finding(s)."` — the
 * verbatim template of `fallbackSynthesize`. So B ("0/16 acceptance criteria")
 * and C ("16/16 typed feature") were never two bugs and the classifier never
 * regressed: the LLM synthesis step produced nothing usable and the
 * deterministic clusterer ran, which hardcodes BOTH fields.
 *
 * The defect these tests pin is that this was silent. The run reported
 * `completed` and nothing downstream could tell a degraded run from a good one.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import { fallbackSynthesize, runSynthesis, type FlatFinding } from "./synthesis.js";

const finding = (over: Partial<FlatFinding> = {}): FlatFinding =>
  ({
    agentKey: "database",
    category: "security",
    severity: "critical",
    title: "Plaintext passwords stored in SIGNON table",
    body: "SIGNON.PASSWORD holds the credential in cleartext.",
    tags: ["security", "credentials"],
    citations: [],
    ...over,
  }) as FlatFinding;

const FINDINGS = [
  finding(),
  finding({
    title: "Full credit card number and expiry persisted in ORDERS",
    tags: ["compliance", "pci"],
  }),
];

const response = (content: string): ChatResponse =>
  ({
    content,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  }) as ChatResponse;

const providerReturning = (
  ...contents: string[]
): { provider: AIProvider; calls: () => number } => {
  let i = 0;
  const seq = vi.fn(async () => {
    const content = contents[Math.min(i, contents.length - 1)]!;
    i += 1;
    return response(content);
  });
  return { provider: { chat: seq } as unknown as AIProvider, calls: () => seq.mock.calls.length };
};

const GOOD_JSON = JSON.stringify({
  summary: "Two security defects.",
  requirements: [
    {
      type: "bug",
      title: "Hash stored passwords",
      body: "Replace cleartext SIGNON.PASSWORD with a salted hash.",
      priority: "critical",
      labels: ["security"],
      evidenceFindingIndexes: [0],
      acceptanceCriteria: ["SIGNON.PASSWORD stores no recoverable plaintext."],
    },
  ],
});

describe("runSynthesis degradation reporting (#1117 B + C)", () => {
  it("reports no degradation on a healthy run", async () => {
    const { provider, calls } = providerReturning(GOOD_JSON);
    const result = await runSynthesis(provider, { projectName: "JPetStore", findings: FINDINGS });

    expect(result.degraded).toBeUndefined();
    expect(calls()).toBe(1);
    expect(result.output.requirements[0]?.type).toBe("bug");
  });

  it("retries once when the model returns unparseable JSON, and succeeds", async () => {
    const { provider, calls } = providerReturning("Here are the requirements: {oops", GOOD_JSON);
    const result = await runSynthesis(provider, { projectName: "JPetStore", findings: FINDINGS });

    expect(calls()).toBe(2);
    expect(result.degraded).toBeUndefined();
    // The retry is the whole point: a single bad completion no longer costs the
    // run its typing and acceptance criteria.
    expect(result.output.requirements[0]?.type).toBe("bug");
    expect(result.output.requirements[0]?.acceptanceCriteria).toHaveLength(1);
  });

  it("bills the tokens the failed attempt actually spent", async () => {
    const { provider } = providerReturning("not json", GOOD_JSON);
    const result = await runSynthesis(provider, { projectName: "JPetStore", findings: FINDINGS });

    expect(result.usage.totalTokens).toBe(240);
  });

  it("degrades with reason non-json after both attempts fail to parse", async () => {
    const { provider, calls } = providerReturning("still prose", "prose again");
    const result = await runSynthesis(provider, { projectName: "JPetStore", findings: FINDINGS });

    expect(calls()).toBe(2);
    expect(result.degraded?.reason).toBe("non-json");
    expect(result.degraded?.attempts).toBe(2);
    expect(result.degraded?.requirementCount).toBe(result.output.requirements.length);
    expect(result.degraded?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("tolerates a provider that reports no usage at all", async () => {
    const chat = vi.fn(async () => ({ content: GOOD_JSON }));
    const result = await runSynthesis({ chat } as unknown as AIProvider, {
      projectName: "JPetStore",
      findings: FINDINGS,
    });

    expect(result.usage.totalTokens).toBe(0);
    expect(result.degraded).toBeUndefined();
  });

  it("degrades with reason schema-invalid when the JSON has the wrong shape", async () => {
    const bad = JSON.stringify({ summary: "x", requirements: [{ title: "" }] });
    const { provider } = providerReturning(bad, bad);
    const result = await runSynthesis(provider, { projectName: "JPetStore", findings: FINDINGS });

    expect(result.degraded?.reason).toBe("schema-invalid");
    expect(result.degraded?.detail).toBeTruthy();
  });

  it("degrades with reason provider-error and does NOT retry a thrown call", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("cost cap exceeded"));
    const result = await runSynthesis({ chat } as unknown as AIProvider, {
      projectName: "JPetStore",
      findings: FINDINGS,
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.degraded?.reason).toBe("provider-error");
    expect(result.degraded?.detail).toContain("cost cap exceeded");
    expect(result.degraded?.attempts).toBe(1);
  });

  it("degrades with reason empty-requirements without a second call", async () => {
    const empty = JSON.stringify({ summary: "Nothing to do.", requirements: [] });
    const { provider, calls } = providerReturning(empty, GOOD_JSON);
    const result = await runSynthesis(provider, { projectName: "JPetStore", findings: FINDINGS });

    // Re-asking a model that produced zero requirements tends to produce zero
    // again; the fallback is the better spend.
    expect(calls()).toBe(1);
    expect(result.degraded?.reason).toBe("empty-requirements");
  });

  it("still rethrows an abort rather than degrading", async () => {
    const chat = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(
      runSynthesis({ chat } as unknown as AIProvider, {
        projectName: "JPetStore",
        findings: FINDINGS,
      }),
    ).rejects.toThrow(/aborted/);
  });

  it("truncates a very long provider message before it is persisted", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("x".repeat(1000)));
    const result = await runSynthesis({ chat } as unknown as AIProvider, {
      projectName: "JPetStore",
      findings: FINDINGS,
    });

    expect(result.degraded?.detail).toHaveLength(301);
    expect(result.degraded?.detail?.endsWith("…")).toBe(true);
  });

  it("an empty finding list is not a degradation", async () => {
    const chat = vi.fn();
    const result = await runSynthesis({ chat } as unknown as AIProvider, {
      projectName: "JPetStore",
      findings: [],
    });

    expect(chat).not.toHaveBeenCalled();
    expect(result.degraded).toBeUndefined();
  });
});

describe("fallbackSynthesize is the source of both #1117 symptoms", () => {
  it("cannot classify: every requirement is a feature with no acceptance criteria", () => {
    const output = fallbackSynthesize(FINDINGS);

    expect(output.requirements.length).toBeGreaterThan(0);
    for (const r of output.requirements) {
      expect(r.type).toBe("feature");
      expect(r.acceptanceCriteria).toEqual([]);
    }
    // The exact string the live run persisted, which is how the fallback was
    // identified after the fact.
    expect(output.summary).toMatch(
      /^Auto-synthesized \d+ requirement\(s\) from \d+ finding\(s\)\.$/,
    );
  });
});

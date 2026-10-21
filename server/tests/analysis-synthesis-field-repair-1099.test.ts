/**
 * Issue #1099 — one malformed optional field used to discard the whole
 * synthesis reply: `synthesisOutputSchema` failed, a second billed call, then
 * every requirement replaced by the keyword fallback. Each shape below goes
 * through the REAL `runSynthesis` with a stub provider (no model spend), beside
 * a well-formed requirement that must survive with it, in ONE call.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import { runSynthesis, type FlatFinding } from "../src/lib/analysis/synthesis.js";
import {
  repairSynthesisReply,
  repairSynthesizedRequirement,
} from "../src/lib/analysis/synthesis-reply-repair.js";
import type { SynthesisFieldRepair } from "@metis/shared";

const finding = (title: string): FlatFinding => ({
  agentKey: "document",
  category: "other",
  severity: "info",
  title,
  body: "body",
  tags: [],
  citations: [],
});

const FINDINGS = [finding("Login has no audit trail"), finding("Export lacks a size limit")];

function providerReturning(...replies: unknown[]) {
  let n = 0;
  const provider = {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (_m: ChatMessage[]) => {
      const reply = replies[Math.min(n++, replies.length - 1)];
      return {
        content: typeof reply === "string" ? reply : JSON.stringify(reply),
        usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
        model: "stub",
        provider: "offline-stub",
      } as ChatResponse;
    }),
  } as unknown as AIProvider;
  return provider;
}

const good = {
  type: "feature",
  title: "Audit every login",
  body: "Record each login attempt with its outcome.",
  priority: "high",
  labels: ["security"],
  storyPoints: 3,
  evidenceFindingIndexes: [0],
  acceptanceCriteria: ["A failed login is recorded with its time and user."],
};

const other = (extra: Record<string, unknown>) => ({
  type: "chore",
  title: "Limit export size",
  body: "Cap a single export.",
  priority: "medium",
  labels: [],
  evidenceFindingIndexes: [1],
  acceptanceCriteria: ["An export over the cap is refused with a message."],
  ...extra,
});

async function synthesize(extra: Record<string, unknown>) {
  const provider = providerReturning({
    summary: "Two requirements.",
    requirements: [good, other(extra)],
  });
  const result = await runSynthesis(provider, { projectName: "P", findings: FINDINGS });
  return { provider, result, repaired: result.output.requirements[1]! };
}

describe("runSynthesis — one malformed field never costs the reply (#1099)", () => {
  const CASES: Array<
    [string, Record<string, unknown>, (r: Record<string, unknown>) => void, SynthesisFieldRepair[]]
  > = [
    [
      "storyPoints: null (read as absent)",
      { storyPoints: null },
      (r) => expect(r.storyPoints).toBeUndefined(),
      [],
    ],
    [
      "storyPoints: 3.5",
      { storyPoints: 3.5 },
      (r) => expect(r.storyPoints).toBeUndefined(),
      [rep("storyPoints", "dropped")],
    ],
    [
      'storyPoints: "5"',
      { storyPoints: "5" },
      (r) => expect(r.storyPoints).toBeUndefined(),
      [rep("storyPoints", "dropped")],
    ],
    [
      "storyPoints: 200",
      { storyPoints: 200 },
      (r) => expect(r.storyPoints).toBeUndefined(),
      [rep("storyPoints", "dropped")],
    ],
    ["labels: null", { labels: null }, (r) => expect(r.labels).toEqual([]), []],
    [
      "labels: a string",
      { labels: "ops" },
      (r) => expect(r.labels).toEqual([]),
      [rep("labels", "dropped")],
    ],
    [
      "labels: 17 entries",
      { labels: Array.from({ length: 17 }, (_, i) => `l${i}`) },
      (r) => expect(r.labels).toHaveLength(16),
      [rep("labels", "truncated")],
    ],
    [
      "labels: an empty and an over-long entry",
      { labels: ["ops", "", "x".repeat(65)] },
      (r) => expect(r.labels).toEqual(["ops"]),
      [rep("labels", "entries-dropped")],
    ],
    [
      "acceptanceCriteria: null",
      { acceptanceCriteria: null },
      (r) => expect(r.acceptanceCriteria).toEqual([]),
      [],
    ],
    [
      "acceptanceCriteria: 21 entries",
      { acceptanceCriteria: Array.from({ length: 21 }, (_, i) => `criterion ${i}`) },
      (r) => expect(r.acceptanceCriteria).toHaveLength(20),
      [rep("acceptanceCriteria", "truncated")],
    ],
    [
      "acceptanceCriteria: an empty and an over-long entry",
      { acceptanceCriteria: ["kept", "", "y".repeat(1025)] },
      (r) => expect(r.acceptanceCriteria).toEqual(["kept"]),
      [rep("acceptanceCriteria", "entries-dropped")],
    ],
    [
      "evidenceFindingIndexes: null",
      { evidenceFindingIndexes: null },
      (r) => expect(r.evidenceFindingIndexes).toEqual([]),
      [],
    ],
    [
      "evidenceFindingIndexes: a string",
      { evidenceFindingIndexes: "1" },
      (r) => expect(r.evidenceFindingIndexes).toEqual([]),
      [rep("evidenceFindingIndexes", "dropped")],
    ],
    [
      "evidenceFindingIndexes: fraction and negative entries",
      { evidenceFindingIndexes: [1, 0.5, -1] },
      (r) => expect(r.evidenceFindingIndexes).toEqual([1]),
      [rep("evidenceFindingIndexes", "entries-dropped")],
    ],
    [
      "type: unknown",
      { type: "story" },
      (r) => expect(r.type).toBe("feature"),
      [rep("type", "defaulted")],
    ],
    [
      "type: null",
      { type: null },
      (r) => expect(r.type).toBe("feature"),
      [rep("type", "defaulted")],
    ],
    ['type: "Bug " (read losslessly)', { type: "Bug " }, (r) => expect(r.type).toBe("bug"), []],
    [
      "priority: unknown",
      { priority: "urgent" },
      (r) => expect(r.priority).toBe("medium"),
      [rep("priority", "defaulted")],
    ],
    [
      "priority: null",
      { priority: null },
      (r) => expect(r.priority).toBe("medium"),
      [rep("priority", "defaulted")],
    ],
    [
      "title over 255 characters",
      { title: "T".repeat(300) },
      (r) => expect((r.title as string).length).toBe(255),
      [
        {
          field: "title",
          action: "truncated",
          requirementNumber: 2,
          requirementTitle: `${"T".repeat(254)}…`,
        },
      ],
    ],
    [
      "body over 4,096 characters",
      { body: "B".repeat(5000) },
      (r) => expect((r.body as string).length).toBe(4096),
      [rep("body", "truncated")],
    ],
  ];

  it.each(CASES)(
    "%s: one call, both requirements kept, the repair recorded",
    async (_label, extra, check, repairs) => {
      const { provider, result, repaired } = await synthesize(extra);
      expect(provider.chat).toHaveBeenCalledTimes(1);
      expect(result.degraded).toBeUndefined();
      expect(result.output.requirements.map((r) => r.title.slice(0, 20))).toEqual([
        "Audit every login",
        String(extra.title ?? "Limit export size").slice(0, 20),
      ]);
      // The well-formed neighbour is untouched.
      expect(result.output.requirements[0]).toMatchObject({ storyPoints: 3, labels: ["security"] });
      check(repaired as unknown as Record<string, unknown>);
      expect(result.fieldRepairs ?? []).toEqual(repairs);
    },
  );

  it("drops only a requirement with no usable title, and records it", async () => {
    const { provider, result } = await synthesize({ title: "   " });
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(result.output.requirements.map((r) => r.title)).toEqual(["Audit every login"]);
    expect(result.fieldRepairs).toEqual([
      {
        field: "requirement",
        action: "requirement-dropped",
        requirementNumber: 2,
        requirementTitle: null,
      },
    ]);
  });

  it("re-asks when EVERY requirement was unusable, as the schema failure it was", async () => {
    const provider = providerReturning(
      { summary: "s", requirements: [{ title: "", body: "" }] },
      { summary: "Two.", requirements: [good] },
    );
    const result = await runSynthesis(provider, { projectName: "P", findings: FINDINGS });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.output.requirements.map((r) => r.title)).toEqual(["Audit every login"]);
  });

  it("records nothing for a clean reply", async () => {
    const provider = providerReturning({ summary: "One.", requirements: [good] });
    const result = await runSynthesis(provider, { projectName: "P", findings: FINDINGS });
    expect(result.fieldRepairs).toBeUndefined();
  });

  it("still re-asks a reply whose requirements are not a list", async () => {
    const provider = providerReturning(
      { summary: "s", requirements: "none" },
      { summary: "One.", requirements: [good] },
    );
    const result = await runSynthesis(provider, { projectName: "P", findings: FINDINGS });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.output.requirements).toHaveLength(1);
  });
});

describe("repairSynthesisReply (#1099)", () => {
  it("generates a missing summary and records it, without shadowing a real one", () => {
    const { reply, repairs } = repairSynthesisReply({ summary: null, requirements: [good] });
    expect((reply as { summary: string }).summary).toBe("Synthesized 1 requirement(s).");
    expect(repairs).toEqual([
      { field: "summary", action: "defaulted", requirementNumber: null, requirementTitle: null },
    ]);
  });

  it("keeps the first 100 requirements and says so", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...good, title: `R${i}` }));
    const { reply, repairs } = repairSynthesisReply({ summary: "s", requirements: many });
    expect((reply as { requirements: unknown[] }).requirements).toHaveLength(100);
    expect(repairs[0]).toMatchObject({ field: "requirements", action: "truncated" });
  });

  it("drops a requirement that is not an object", () => {
    const out: SynthesisFieldRepair[] = [];
    expect(repairSynthesizedRequirement("text", 3, out)).toBeNull();
    expect(out).toEqual([
      {
        field: "requirement",
        action: "requirement-dropped",
        requirementNumber: 3,
        requirementTitle: null,
      },
    ]);
  });

  it("leaves a non-object reply for the schema to reject", () => {
    expect(repairSynthesisReply("x")).toEqual({ reply: "x", repairs: [] });
  });
});

function rep(
  field: SynthesisFieldRepair["field"],
  action: SynthesisFieldRepair["action"],
): SynthesisFieldRepair {
  return { field, action, requirementNumber: 2, requirementTitle: "Limit export size" };
}

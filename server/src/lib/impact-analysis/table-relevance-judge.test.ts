import { describe, expect, it } from "vitest";
import type { AIProvider } from "../ai/types.js";
import {
  buildJudgeMessages,
  impactLlmTableJudgeEnabled,
  judgeRelevantTables,
  type JudgeCandidate,
} from "./table-relevance-judge.js";

const CANDS: JudgeCandidate[] = [
  { tableName: "account", columns: ["addr1", "city", "state", "zip", "country", "phone"] },
  { tableName: "profile", columns: ["favcategory", "langpref", "mylistopt"] },
  { tableName: "product", columns: ["productid", "name", "descn"] },
];

/** Mock provider returning the given contents in sequence (one per chat call). */
function mockProvider(replies: string[], opts: { offline?: boolean } = {}): AIProvider {
  let i = 0;
  return {
    offline: opts.offline ?? false,
    chat: async () => ({ content: replies[Math.min(i++, replies.length - 1)] }),
  } as unknown as AIProvider;
}

const REQ =
  "Show the running points balance alongside the shopper's saved billing and delivery details.";

describe("judgeRelevantTables (#1029)", () => {
  it("selects a table voted in by the majority of samples", async () => {
    // account (idx 0) in all 3 samples; profile (idx 1) in only 1 -> below threshold 2.
    const p = mockProvider([
      '{"tables":[{"index":0,"rationale":"addr columns"}]}',
      '{"tables":[{"index":0},{"index":1}]}',
      '{"tables":[{"index":0}]}',
    ]);
    const r = await judgeRelevantTables(REQ, CANDS, p, { enabled: true, samples: 3 });
    expect(r.applied).toBe(true);
    expect(r.selected.map((s) => s.tableName)).toEqual(["account"]);
  });

  it("drops an index outside the candidate range (grounding, OWASP LLM01)", async () => {
    const p = mockProvider(['{"tables":[{"index":99},{"index":0}]}']);
    const r = await judgeRelevantTables(REQ, CANDS, p, {
      enabled: true,
      samples: 1,
      voteThreshold: 1,
    });
    expect(r.selected.map((s) => s.tableName)).toEqual(["account"]);
  });

  it("is a deterministic passthrough when disabled", async () => {
    const p = mockProvider(['{"tables":[{"index":0}]}']);
    const r = await judgeRelevantTables(REQ, CANDS, p, { enabled: false });
    expect(r).toEqual({ selected: [], applied: false });
  });

  it("passes through when the provider is offline or missing", async () => {
    const off = mockProvider(['{"tables":[{"index":0}]}'], { offline: true });
    expect(await judgeRelevantTables(REQ, CANDS, off, { enabled: true })).toEqual({
      selected: [],
      applied: false,
    });
    expect(await judgeRelevantTables(REQ, CANDS, null, { enabled: true })).toEqual({
      selected: [],
      applied: false,
    });
  });

  it("passes through with no candidates or an empty requirement", async () => {
    const p = mockProvider(['{"tables":[{"index":0}]}']);
    expect((await judgeRelevantTables(REQ, [], p, { enabled: true })).applied).toBe(false);
    expect((await judgeRelevantTables("   ", CANDS, p, { enabled: true })).applied).toBe(false);
  });

  it("degrades to empty (applied false) when every sample is malformed", async () => {
    const p = mockProvider(["not json", "also not json", "{bad"]);
    const r = await judgeRelevantTables(REQ, CANDS, p, { enabled: true, samples: 3 });
    expect(r).toEqual({ selected: [], applied: false });
  });

  it("never throws when the provider throws", async () => {
    const throwing = {
      offline: false,
      chat: async () => {
        throw new Error("boom");
      },
    } as unknown as AIProvider;
    const r = await judgeRelevantTables(REQ, CANDS, throwing, { enabled: true, samples: 2 });
    expect(r).toEqual({ selected: [], applied: false });
  });

  it("fences the requirement and shows columns in the built messages", () => {
    const msgs = buildJudgeMessages(REQ, CANDS);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("account (columns: addr1, city");
    expect(msgs[1].content).toContain("<<<REQUIREMENT");
  });

  it("flag defaults ON and honours 0/false to disable", () => {
    expect(impactLlmTableJudgeEnabled({})).toBe(true);
    expect(impactLlmTableJudgeEnabled({ IMPACT_LLM_TABLE_JUDGE: "1" })).toBe(true);
    expect(impactLlmTableJudgeEnabled({ IMPACT_LLM_TABLE_JUDGE: "0" })).toBe(false);
    expect(impactLlmTableJudgeEnabled({ IMPACT_LLM_TABLE_JUDGE: "false" })).toBe(false);
  });
});

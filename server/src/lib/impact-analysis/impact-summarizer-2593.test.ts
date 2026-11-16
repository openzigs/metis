/**
 * #2593 — a run that did not read the database never says the change needs none.
 *
 * The 2026-11-16 walkthrough's summary read "No database tables were identified
 * as affected, so the impact is confined to code" over a project with no
 * database connector, beside findings that need a migration. The run now tells
 * the model the database was not checked, and a draft that still claims no
 * database impact is repaired, then dropped — the same gate shape as grounding.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import {
  buildItemSummaryMessages,
  buildRunSummaryRequest,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  noDatabaseImpactClaims,
  summarizeImpactItem,
  summarizeImpactRun,
  type ImpactItemFacts,
  type ImpactRunFacts,
  type RunItemFact,
} from "./impact-summarizer.js";

function itemFacts(over: Partial<ImpactItemFacts> = {}): ImpactItemFacts {
  return {
    requirementTitle: "API keys expire",
    requirementBody: "",
    changeType: "added",
    severity: "high",
    impactScore: 0.7,
    confidence: 1,
    affectedFileCount: 1,
    affectedSymbolCount: 1,
    affectedSymbols: [
      {
        qualifiedName: "storage.CreateAPIKey",
        filePath: "internal/storage/api_key.go",
        relation: "direct",
        depth: 0,
      },
    ],
    affectedTablesPrimary: [],
    affectedTablesSecondary: [],
    ...over,
  };
}

function runItem(over: Partial<RunItemFact> = {}): RunItemFact {
  return {
    requirementTitle: "API keys expire",
    severity: "high",
    changeType: "added",
    affectedSymbolCount: 3,
    primaryTables: [],
    ...over,
  };
}

function runFacts(items: RunItemFact[]): ImpactRunFacts {
  return { projectCount: 1, changeCount: items.length, totalImpactedSymbols: 3, items };
}

/** A deterministic provider: `reply(messages, callIndex)` is the summary text. */
function provider(reply: (messages: ChatMessage[], call: number) => string): AIProvider {
  let call = 0;
  return {
    key: "anthropic",
    model: "mock",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      const summary = reply(messages, call);
      call += 1;
      return {
        content: JSON.stringify({ summary }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "mock",
        provider: "anthropic",
      };
    }),
  } as unknown as AIProvider;
}

const WALKTHROUGH =
  "No database tables were identified as affected, so the impact is confined to code.";
const CLEAN = "The change edits `storage.CreateAPIKey`; its database impact was not checked.";

const userText = (messages: ChatMessage[]) => messages.find((m) => m.role === "user")!.content;

describe("noDatabaseImpactClaims (#2593)", () => {
  it("finds the walkthrough's sentence and its near relatives", () => {
    expect(noDatabaseImpactClaims(WALKTHROUGH).length).toBeGreaterThan(0);
    for (const claim of [
      "The impact is confined to the code.",
      "This is a code-only change.",
      "No schema changes are needed.",
      "No database migration is required.",
      "The change does not touch the database.",
      "The database remains unaffected.",
      "No affected tables were found.",
    ]) {
      expect(noDatabaseImpactClaims(claim), claim).not.toEqual([]);
    }
  });

  it("finds nothing in a summary that makes no such claim", () => {
    expect(noDatabaseImpactClaims(CLEAN)).toEqual([]);
    expect(
      noDatabaseImpactClaims("It adds a column to `api_keys`; the migration needs review."),
    ).toEqual([]);
  });
});

describe("the prompts say the database was not checked (#2593)", () => {
  it("in the item prompt, only when it was not", () => {
    expect(userText(buildItemSummaryMessages(itemFacts({ databaseConnected: false })))).toContain(
      "DATABASE: NOT CHECKED",
    );
    expect(
      userText(buildItemSummaryMessages(itemFacts({ databaseConnected: true }))),
    ).not.toContain("DATABASE: NOT CHECKED");
    expect(userText(buildItemSummaryMessages(itemFacts()))).not.toContain("DATABASE: NOT CHECKED");
  });

  it("in the run prompt, when any item's database was not read", () => {
    const shown = (items: RunItemFact[]) =>
      userText(buildRunSummaryRequest(runFacts(items)).messages);
    expect(
      shown([runItem({ databaseConnected: true }), runItem({ databaseConnected: false })]),
    ).toContain("DATABASE: NOT CHECKED");
    expect(shown([runItem({ databaseConnected: true }), runItem()])).not.toContain(
      "DATABASE: NOT CHECKED",
    );
  });
});

describe("the no-database-claim gate (#2593)", () => {
  it("repairs, then drops, an item summary that keeps claiming no database impact", async () => {
    const p = provider(() => WALKTHROUGH);
    const res = await summarizeImpactItem(itemFacts({ databaseConnected: false }), p, {
      enabled: true,
    });
    expect(res.summary).toBeNull();
    expect(res.grounded).toBe(false);
    const calls = (p.chat as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1 + DEFAULT_MAX_REPAIR_ATTEMPTS);
    const repair = (calls[1]![0] as ChatMessage[]).at(-1)!.content;
    expect(repair).toMatch(/database was NOT checked/);
    expect(repair).toContain("confined to code");
  });

  it("keeps the repaired draft once it stops claiming", async () => {
    const res = await summarizeImpactItem(
      itemFacts({ databaseConnected: false }),
      provider((_m, call) => (call === 0 ? WALKTHROUGH : CLEAN)),
      { enabled: true },
    );
    expect(res.summary).toBe(CLEAN);
  });

  it("lets a run that read the database say it found nothing", async () => {
    const res = await summarizeImpactItem(
      itemFacts({ databaseConnected: true }),
      provider(() => WALKTHROUGH),
      { enabled: true },
    );
    expect(res.summary).toBe(WALKTHROUGH);
  });

  it("drops a run overview that claims no database impact over an unread database", async () => {
    const res = await summarizeImpactRun(
      runFacts([runItem({ databaseConnected: false })]),
      provider(() => "One change in 1 project; the impact is confined to code."),
      { enabled: true },
    );
    expect(res.summary).toBeNull();
  });

  it("keeps a run overview when every database was read", async () => {
    const res = await summarizeImpactRun(
      runFacts([runItem({ databaseConnected: true })]),
      provider(() => "One change in 1 project; the impact is confined to code."),
      { enabled: true },
    );
    expect(res.summary).toBe("One change in 1 project; the impact is confined to code.");
  });
});

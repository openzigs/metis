/**
 * #1873 (epic #1866) — governing questions in the REAL clarification dialog,
 * with the real governing question source (`governingQuestionSourceFor`) over
 * an in-memory database: the stored applicability, the project's workspace and
 * its rules.
 *
 *   - a requirement with one `uncertain` pair gets exactly one governing
 *     question in the next round, in plain words;
 *   - the self-resolve pass reads only the project's index: with the policy
 *     text held solely by the workspace's governing index, the question stays
 *     `open`, and the governing index is never searched;
 *   - an answer is judged back onto the stored applicability, never folded into
 *     a requirement description;
 *   - with the flag off, question generation is byte-identical to the dialog
 *     before #1873 (a snapshot taken from that code).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoverningAnalysisApplicability } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatOptions } from "../src/lib/ai/types.js";

const fakeStore = new Map<string, unknown>();
vi.mock("../src/lib/analysis/clarification-dialog-store.js", () => ({
  readDialogState: vi.fn(async (id: string) => {
    const v = fakeStore.get(id);
    return v ? (JSON.parse(JSON.stringify(v)) as unknown) : undefined;
  }),
  writeDialogState: vi.fn(async (id: string, state: unknown) => {
    fakeStore.set(id, JSON.parse(JSON.stringify(state)));
  }),
  deleteDialogState: vi.fn(async (id: string) => {
    fakeStore.delete(id);
  }),
}));

const mem = vi.hoisted(() => ({
  metadata: "{}" as string,
  rules: [] as Array<Record<string, unknown>>,
  workspaceId: "ws_1873" as string | null,
  // #2059 — the analysis's stored Needs BA input findings.
  findings: [] as Array<Record<string, unknown>>,
}));
vi.mock("../src/lib/prisma.js", () => {
  const analysis = {
    findFirst: vi.fn(async () => ({ metadata: mem.metadata })),
    update: vi.fn(async ({ data }: { data: { metadata: string } }) => {
      mem.metadata = data.metadata;
      return {};
    }),
  };
  const prisma = {
    analysis,
    project: { findFirst: vi.fn(async () => ({ workspaceId: mem.workspaceId })) },
    governingRule: { findMany: vi.fn(async () => mem.rules) },
    governingFinding: { findMany: vi.fn(async () => mem.findings) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ analysis })),
  };
  return { prisma, resolveDatabaseProvider: () => "sqlite" };
});

// #2010 — the findings refresh an answer triggers: held open until a test releases it.
const refresh = vi.hoisted(() => ({ release: () => {} }));
vi.mock("../src/lib/governing/findings-store.js", () => ({
  produceGoverningFindingsForAnalysis: vi.fn(
    () =>
      new Promise((resolve) => {
        refresh.release = () => resolve({ requirements: 0, written: 0 });
      }),
  ),
}));

const { ClarificationDialog, ORPHAN_RETRY_BASE_MS, ORPHAN_RETRY_MAX_ENTRIES } =
  await import("../src/lib/analysis/clarification-dialog.js");
const findingsStore = await import("../src/lib/governing/findings-store.js");
const { governingQuestionSourceFor } =
  await import("../src/lib/governing/applicability-questions.js");
const { readGoverningApplicability } = await import("../src/lib/governing/applicability-store.js");
const { createInMemoryBM25 } = await import("../src/lib/rag/bm25-index.js");
const { prisma } = await import("../src/lib/prisma.js");
const dialogStore = await import("../src/lib/analysis/clarification-dialog-store.js");

const ANALYSIS = "an_1873";
const PROJECT = "pr_1873";
const CLAUSE =
  "The company never stores a full payment card number in any system; only the last four digits may be kept.";
const RULE_ROW = {
  id: "rule_card",
  revisionId: "rev_1",
  controlId: "EN-03",
  summary: "Full card numbers are never stored; only the last four digits.",
  clauseRef: "§4.3",
  clauseExcerpt: CLAUSE,
  revision: { revisionLabel: "v1", document: { title: "Information Handling Policy" } },
};
const REQUIREMENT_TEXT = "Let returning customers check out with a saved card.";

function stored(
  decisions: GoverningAnalysisApplicability["requirements"][number]["decisions"],
): GoverningAnalysisApplicability {
  return {
    decidedAt: "2026-11-08T00:00:00.000Z",
    requirements: [{ requirementId: "REQ-001", text: REQUIREMENT_TEXT, decisions }],
  };
}
const ONE_UNCERTAIN = stored([
  {
    ruleId: "rule_card",
    controlId: "EN-03",
    verdict: "uncertain",
    reason: "Depends on what the saved card keeps.",
    businessFact: "Will the saved card keep the customer's whole card number?",
    foundBy: ["screen"],
  },
]);

/** The dialog's requirement list: one requirement, no ambiguity of its own. */
const REQS = {
  requirements: [
    {
      id: "REQ-001",
      title: "Saved card checkout",
      description: REQUIREMENT_TEXT,
      type: "functional" as const,
      stakeholders: [],
      priority: "must-have" as const,
      ambiguities: [],
      evidenceNeeds: [],
      rawSource: "",
    },
  ],
  totalAmbiguities: 0,
  totalEvidenceNeeds: 0,
};

interface Sent {
  system: string;
  user: string;
}

/**
 * A model: grounding answers `grounded` only when a retrieved snippet holds the
 * clause; judging marks the card rule `applies`; anything else is a recorded,
 * unexpected call answered with nothing usable.
 */
function model() {
  const sent: Sent[] = [];
  const chat = vi.fn(async (messages: ChatMessage[], o: ChatOptions = {}) => {
    const system = String(
      o.systemMessage ?? messages.find((m) => m.role === "system")?.content ?? "",
    );
    const user = messages
      .filter((m) => m.role !== "system")
      .map((m) => String(m.content))
      .join("\n");
    sent.push({ system, user });
    const reply = (content: string) => ({ content, model: "m", provider: "anthropic" as const });
    if (user.includes("Retrieved snippets")) {
      return reply(
        user.includes("never stores a full payment card number")
          ? JSON.stringify({
              status: "grounded",
              answer: "No, only the last four digits.",
              citationIndexes: [1],
            })
          : JSON.stringify({ status: "open" }),
      );
    }
    if (system.includes("You decide which of a company's governing rules")) {
      return reply(
        JSON.stringify({
          decisions: [{ rule: "R1", verdict: "applies", reason: "The whole number is kept." }],
        }),
      );
    }
    return reply("{}");
  });
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-4-5",
    offline: false,
    chat,
  } as unknown as AIProvider;
  return { provider, sent, chat };
}

/** A project index over the project's own documents only, by BM25. */
function projectIndex(docs: Array<{ id: string; text: string }>) {
  const index = createInMemoryBM25(
    docs.map((d, i) => ({
      id: `${d.id}#0`,
      documentId: d.id,
      position: i,
      text: d.text,
      filename: `${d.id}.md`,
    })),
  );
  const byId = new Map(docs.map((d) => [`${d.id}#0`, d]));
  const search = vi.fn(async (_projectId: string, query: string) => ({
    hits: index.search(query, 5).map((h) => {
      const d = byId.get(h.chunkId)!;
      return {
        chunkId: h.chunkId,
        documentId: d.id,
        filename: `${d.id}.md`,
        position: 0,
        text: d.text,
        score: h.score,
        embeddingModel: "none",
        source: "upload",
      };
    }),
  }));
  return { search };
}

function dialogWith(provider: AIProvider, retriever?: ReturnType<typeof projectIndex>) {
  return new ClarificationDialog({
    provider,
    ...(retriever ? { retriever: retriever as never, projectId: PROJECT } : {}),
    governingQuestions: governingQuestionSourceFor({
      analysisId: ANALYSIS,
      projectId: PROJECT,
      provider,
    }),
  });
}

beforeEach(() => {
  fakeStore.clear();
  mem.metadata = JSON.stringify({ governingApplicability: ONE_UNCERTAIN });
  mem.rules = [RULE_ROW];
  mem.workspaceId = "ws_1873";
  mem.findings = [];
  process.env.GOVERNING_DOCS_ENABLED = "1";
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.GOVERNING_DOCS_ENABLED;
});

describe("#1873 — governing questions in the clarification dialog", () => {
  it("one uncertain pair: exactly one question in the next round, tagged governing with that rule, naming no rule and quoting no clause", async () => {
    const { provider } = model();
    const state = await dialogWith(provider).startOrContinue(ANALYSIS, REQS);
    expect(state.completed).toBe(false);
    const questions = state.rounds[0]!.questions;
    expect(questions).toHaveLength(1);
    const q = questions[0]!;
    expect(q.governing).toEqual({
      kind: "governing",
      ruleIds: ["rule_card"],
      requirementId: "REQ-001",
    });
    expect(q.question).not.toMatch(/EN-03/i);
    const words = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
    const clause = words(CLAUSE);
    const asked = ` ${words(q.question).join(" ")} `;
    for (let i = 0; i + 8 <= clause.length; i++) {
      expect(asked).not.toContain(` ${clause.slice(i, i + 8).join(" ")} `);
    }
    // The workspace's rules were read by the project's workspace, from the project row.
    expect(vi.mocked(prisma.project.findFirst)).toHaveBeenCalledWith({
      where: { id: PROJECT },
      select: { workspaceId: true },
    });
    const where = vi.mocked(prisma.governingRule.findMany).mock.calls[0]![0] as {
      where: { revision: { document: { workspaceId: string } } };
    };
    expect(where.where.revision.document.workspaceId).toBe("ws_1873");
  });

  it("self-resolve searches only the project index: the policy text, held solely by the governing index, never answers the question", async () => {
    const { provider } = model();
    // The project knows about checkout, not about what is stored.
    const retriever = projectIndex([
      { id: "brief", text: "Saved card checkout brief: returning customers pick a saved card." },
    ]);
    // The workspace's governing index holds the clause that would answer it.
    const governingIndex = { search: vi.fn(async () => [{ revisionId: "rev_1", text: CLAUSE }]) };
    const state = await dialogWith(provider, retriever).startOrContinue(ANALYSIS, REQS);
    const q = state.rounds[0]!.questions[0]!;
    expect(q.governing?.ruleIds).toEqual(["rule_card"]);
    expect(q.groundingStatus).toBe("open");
    expect(q.groundedAnswer).toBeUndefined();
    expect(retriever.search).toHaveBeenCalledWith(PROJECT, q.question, expect.anything());
    expect(governingIndex.search).not.toHaveBeenCalled();

    // Control: had the policy been in the project index, the same pass would
    // have answered it — so "open" above is the index's doing, not the stub's.
    fakeStore.clear();
    const leaky = projectIndex([{ id: "policy", text: CLAUSE }]);
    const control = await dialogWith(provider, leaky).startOrContinue(ANALYSIS, REQS);
    expect(control.rounds[0]!.questions[0]!.groundingStatus).toBe("grounded");
  });

  it("an answer settles the pair on the stored applicability, read back fresh; no requirement description is rewritten", async () => {
    const { provider, sent } = model();
    const dialog = dialogWith(provider);
    const state = await dialog.startOrContinue(ANALYSIS, REQS);
    const q = state.rounds[0]!.questions[0]!;
    const { updatedRequirements, state: after } = await dialog.submitAnswers(
      ANALYSIS,
      [{ questionId: q.id, answer: "Yes — the whole number, so it can be reused." }],
      REQS,
    );
    expect(updatedRequirements.requirements[0]!.description).toBe(REQUIREMENT_TEXT);
    // No resolution call: only the judging call ran.
    expect(sent.filter((s) => s.system.includes("update the requirement"))).toHaveLength(0);
    const judging = sent.filter((s) => s.system.includes("You decide which"));
    expect(judging).toHaveLength(1);
    expect(judging[0]!.user).toContain("Their answer: Yes — the whole number");
    expect(after.completed).toBe(true);

    const read = await readGoverningApplicability(ANALYSIS);
    expect(read!.requirements[0]!.decisions[0]).toMatchObject({
      ruleId: "rule_card",
      verdict: "applies",
      settled: { questionId: q.id, previousVerdict: "uncertain" },
    });
    // Settled: the next round asks nothing more about it.
    const next = await dialog.startOrContinue(ANALYSIS, REQS);
    expect(next.completed).toBe(true);
  });

  it("an unanswered governing question keeps the dialog open and is asked again next round", async () => {
    const { provider } = model();
    const dialog = dialogWith(provider);
    const started = await dialog.startOrContinue(ANALYSIS, REQS);
    // #2085 — a submit names its round's own questions; this one leaves the answer blank.
    const q = started.rounds[0]!.questions[0]!;
    const after = await dialog.submitAnswers(ANALYSIS, [{ questionId: q.id, answer: " " }], REQS);
    expect(after.state.completed).toBe(false);
    const next = await dialog.startOrContinue(ANALYSIS, REQS);
    expect(next.rounds).toHaveLength(2);
    expect(next.rounds[1]!.questions.map((q) => q.governing?.ruleIds)).toEqual([["rule_card"]]);
  });

  it("#2009 — a refused submit (beforeCommit throws, the 409 path) settles nothing", async () => {
    const { provider, sent } = model();
    const dialog = dialogWith(provider);
    const state = await dialog.startOrContinue(ANALYSIS, REQS);
    const q = state.rounds[0]!.questions[0]!;
    await expect(
      dialog.submitAnswers(
        ANALYSIS,
        [{ questionId: q.id, answer: "Yes — the whole number." }],
        REQS,
        undefined,
        async () => {
          throw new Error("REQUIREMENTS_REPLACED");
        },
      ),
    ).rejects.toThrow("REQUIREMENTS_REPLACED");
    expect(sent.filter((s) => s.system.includes("You decide which"))).toHaveLength(0);
    const read = await readGoverningApplicability(ANALYSIS);
    expect(read!.requirements[0]!.decisions[0]).toMatchObject({ verdict: "uncertain" });
    expect(read!.requirements[0]!.decisions[0]!.settled).toBeUndefined();
  });

  it("#2009 — an answer whose settle failed is judged again on the next start, even once the dialog is complete", async () => {
    const { provider, sent, chat } = model();
    const dialog = dialogWith(provider);
    const state = await dialog.startOrContinue(ANALYSIS, REQS);
    const q = state.rounds[0]!.questions[0]!;
    // The judging call fails on submit: the answer is committed, the pair is not settled.
    const judging = () => sent.filter((s) => s.system.includes("You decide which"));
    const real = chat.getMockImplementation()!;
    chat.mockImplementationOnce(async () => {
      throw new Error("provider unavailable");
    });
    const { state: after } = await dialog.submitAnswers(
      ANALYSIS,
      [{ questionId: q.id, answer: "Yes — the whole number, so it can be reused." }],
      REQS,
    );
    expect(after.completed).toBe(true);
    const orphan = await readGoverningApplicability(ANALYSIS);
    expect(orphan!.requirements[0]!.decisions[0]!.settled).toBeUndefined();
    expect(judging()).toHaveLength(0);
    chat.mockImplementation(real);

    // The next start retries it with the BA's answer, without asking again.
    const next = await dialog.startOrContinue(ANALYSIS, REQS);
    expect(next.completed).toBe(true);
    expect(judging()).toHaveLength(1);
    expect(judging()[0]!.user).toContain("Their answer: Yes — the whole number");
    const read = await readGoverningApplicability(ANALYSIS);
    expect(read!.requirements[0]!.decisions[0]).toMatchObject({
      verdict: "applies",
      settled: { questionId: q.id, previousVerdict: "uncertain" },
    });
    // Settled now: a further start judges nothing more.
    await dialog.startOrContinue(ANALYSIS, REQS);
    expect(judging()).toHaveLength(1);
  });

  it("#2016 — with the provider down, the start-path retry is backed off per analysis, doubling, and a submit resets it", async () => {
    // Fake only the clock, in the past, so the backoff left behind has expired for later tests.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-01-01T00:00:00.000Z"));
    try {
      const { provider, sent, chat } = model();
      const dialog = dialogWith(provider);
      const state = await dialog.startOrContinue(ANALYSIS, REQS);
      const q = state.rounds[0]!.questions[0]!;
      const judging = () => sent.filter((s) => s.system.includes("You decide which")).length;
      const real = chat.getMockImplementation()!;
      chat.mockImplementation(async (messages, o) => {
        if (String(o?.systemMessage ?? "").includes("You decide which")) {
          sent.push({ system: String(o?.systemMessage), user: "" });
          throw new Error("provider unavailable");
        }
        return real(messages, o);
      });
      await dialog.submitAnswers(
        ANALYSIS,
        [{ questionId: q.id, answer: "Yes, the whole number." }],
        REQS,
      );
      expect(judging()).toBe(1);

      const start = () => dialog.startOrContinue(ANALYSIS, REQS);
      const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
      await start(); // the first retry runs at once
      expect(judging()).toBe(2);
      await start(); // inside the first backoff: no judging call
      await start();
      expect(judging()).toBe(2);
      later(ORPHAN_RETRY_BASE_MS + 1);
      await start(); // the backoff has passed: one more attempt
      expect(judging()).toBe(3);
      later(ORPHAN_RETRY_BASE_MS + 1);
      await start(); // the backoff doubled: still waiting
      expect(judging()).toBe(3);
      later(ORPHAN_RETRY_BASE_MS);
      await start();
      expect(judging()).toBe(4);

      // A submit settles itself and resets the backoff: the next start retries at once.
      // #2085 — a submit goes only to an open round, so round 1 is open again
      // (as a re-open for the governing question would leave it).
      await dialogStore.writeDialogState(ANALYSIS, state);
      await dialog.submitAnswers(
        ANALYSIS,
        [{ questionId: q.id, answer: "Yes, the whole number." }],
        REQS,
      );
      expect(judging()).toBe(5);
      chat.mockImplementation(real);
      await start();
      expect(judging()).toBe(6);
      const read = await readGoverningApplicability(ANALYSIS);
      expect(read!.requirements[0]!.decisions[0]).toMatchObject({ verdict: "applies" });
    } finally {
      vi.useRealTimers();
    }
  });

  /** #2022 — a dialog with one answered governing question whose settle failed. */
  async function orphaned() {
    const { provider, sent, chat } = model();
    const dialog = dialogWith(provider);
    const state = await dialog.startOrContinue(ANALYSIS, REQS);
    const q = state.rounds[0]!.questions[0]!;
    const judging = () => sent.filter((s) => s.system.includes("You decide which")).length;
    const real = chat.getMockImplementation()!;
    const failJudging = () =>
      chat.mockImplementation(async (messages, o) => {
        if (String(o?.systemMessage ?? "").includes("You decide which")) {
          sent.push({ system: String(o?.systemMessage), user: "" });
          throw new Error("provider unavailable");
        }
        return real(messages, o);
      });
    failJudging();
    // A submit clears any backoff an earlier test left for the analysis.
    await dialog.submitAnswers(
      ANALYSIS,
      [{ questionId: q.id, answer: "Yes, the whole number." }],
      REQS,
    );
    expect(judging()).toBe(1);
    const unsettled = mem.metadata;
    return {
      dialog,
      chat,
      judging,
      failJudging,
      restore: () => chat.mockImplementation(real),
      /** The pair open again, as a new orphan of the same analysis would leave it. */
      reopen: () => {
        mem.metadata = unsettled;
      },
      start: (signal?: AbortSignal) => dialog.startOrContinue(ANALYSIS, REQS, signal),
      later: (ms: number) => vi.setSystemTime(new Date(Date.now() + ms)),
    };
  }

  it("#2022 — a retry that settles its answer clears the backoff: the next orphan is retried at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-02-01T00:00:00.000Z"));
    try {
      const o = await orphaned();
      await o.start(); // the first retry fails: backed off
      expect(o.judging()).toBe(2);
      o.restore();
      o.later(ORPHAN_RETRY_BASE_MS + 1);
      await o.start(); // past the backoff, and the provider is back: settled
      expect(o.judging()).toBe(3);
      const read = await readGoverningApplicability(ANALYSIS);
      expect(read!.requirements[0]!.decisions[0]).toMatchObject({ verdict: "applies" });
      // Nothing is backed off any more: an answer left open again is retried now.
      o.reopen();
      await o.start();
      expect(o.judging()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#2022 — a retry the client aborted is no failed attempt: the next start retries at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-03-01T00:00:00.000Z"));
    try {
      const o = await orphaned();
      const controller = new AbortController();
      const real = o.chat.getMockImplementation()!;
      o.chat.mockImplementation(async (messages, opts) => {
        if (String(opts?.systemMessage ?? "").includes("You decide which")) {
          // The client goes away while the judging call is in flight.
          controller.abort();
          await real(messages, opts);
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return real(messages, opts);
      });
      await o.start(controller.signal).catch(() => undefined);
      expect(o.judging()).toBe(2);
      o.restore();
      await o.start();
      expect(o.judging()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#2029 — a retry the client aborted keeps an existing backoff: the next failure doubles it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-05-01T00:00:00.000Z"));
    try {
      const o = await orphaned();
      await o.start(); // the first retry fails: backed off once
      expect(o.judging()).toBe(2);
      o.later(ORPHAN_RETRY_BASE_MS + 1);
      // Past that backoff, the client goes away while the next retry's judging call fails.
      const controller = new AbortController();
      const failing = o.chat.getMockImplementation()!;
      o.chat.mockImplementation(async (messages, opts) => {
        if (String(opts?.systemMessage ?? "").includes("You decide which")) controller.abort();
        return failing(messages, opts);
      });
      await o.start(controller.signal).catch(() => undefined);
      expect(o.judging()).toBe(3);
      o.failJudging();
      await o.start(); // the kept backoff has expired: retried at once, and it fails again
      expect(o.judging()).toBe(4);
      o.later(ORPHAN_RETRY_BASE_MS + 1);
      // Second failed attempt: the backoff doubled. Had the abort cleared the first,
      // this would be a first attempt again, and its one-step wait would have passed.
      await o.start();
      expect(o.judging()).toBe(4);
      o.later(ORPHAN_RETRY_BASE_MS);
      await o.start();
      expect(o.judging()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#2022 — the backoff map is bounded: past ORPHAN_RETRY_MAX_ENTRIES analyses, the oldest is evicted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-04-01T00:00:00.000Z"));
    try {
      const o = await orphaned();
      await o.start(); // ANALYSIS backed off first, so evicted first
      expect(o.judging()).toBe(2);
      await o.start();
      expect(o.judging()).toBe(2);
      // As many other analyses again, each with the same orphaned answer, each backed off.
      const dialogState = fakeStore.get(ANALYSIS);
      for (let i = 0; i < ORPHAN_RETRY_MAX_ENTRIES; i++) {
        fakeStore.set(`an_2022_${i}`, dialogState);
        await o.dialog.startOrContinue(`an_2022_${i}`, REQS);
      }
      expect(o.judging()).toBe(2 + ORPHAN_RETRY_MAX_ENTRIES);
      // The newest is still backed off; ANALYSIS's entry went, so it retries at once.
      await o.dialog.startOrContinue(`an_2022_${ORPHAN_RETRY_MAX_ENTRIES - 1}`, REQS);
      expect(o.judging()).toBe(2 + ORPHAN_RETRY_MAX_ENTRIES);
      await o.start();
      expect(o.judging()).toBe(3 + ORPHAN_RETRY_MAX_ENTRIES);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing governing source asks no governing question and never stops the round", async () => {
    const { provider } = model();
    vi.mocked(prisma.analysis.findFirst).mockRejectedValueOnce(new Error("database is locked"));
    const state = await dialogWith(provider).startOrContinue(ANALYSIS, REQS);
    expect(state.completed).toBe(true);
    expect(state.rounds).toEqual([]);
  });
});

describe("#1873 — flag off: question generation is unchanged", () => {
  const AMBIGUOUS = {
    ...REQS,
    requirements: [
      {
        ...REQS.requirements[0]!,
        ambiguities: [
          { field: "scope", description: "Which cards?", suggestedQuestion: "Which cards?" },
        ],
      },
    ],
    totalAmbiguities: 1,
  };

  it("no source, no read, and the round and its model calls match the pre-#1873 snapshot", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "0";
    const chat = vi.fn(async () => ({
      content: JSON.stringify({
        questions: [
          {
            requirementId: "REQ-001",
            ambiguityField: "scope",
            question: "Which cards can be saved?",
            context: "The card types are not given.",
          },
        ],
      }),
      model: "m",
      provider: "anthropic" as const,
    }));
    const provider = {
      key: "anthropic",
      model: "claude-sonnet-4-5",
      offline: false,
      chat,
    } as unknown as AIProvider;
    const retriever = projectIndex([{ id: "brief", text: "Saved card checkout brief." }]);
    const dialog = dialogWith(provider, retriever);
    const state = await dialog.startOrContinue(ANALYSIS, AMBIGUOUS);
    expect(vi.mocked(prisma.analysis.findFirst)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.governingRule.findMany)).not.toHaveBeenCalled();
    const round = state.rounds.map((r) => ({
      ...r,
      questions: r.questions.map(({ id: _id, ...q }) => q),
    }));
    expect(JSON.stringify({ round, calls: chat.mock.calls }, null, 2)).toMatchSnapshot();
  });
});

describe("#2010 — the findings refresh after an answer is off the request path", () => {
  it("the submit returns while the refresh is still running, and the refresh is not under the request's signal", async () => {
    const { provider } = model();
    const dialog = dialogWith(provider);
    const state = await dialog.startOrContinue(ANALYSIS, REQS);
    const q = state.rounds[0]!.questions[0]!;
    const request = new AbortController();
    // The refresh never finishes unless released: a submit that awaited it would hang.
    const submitted = await Promise.race([
      dialog
        .submitAnswers(
          ANALYSIS,
          [{ questionId: q.id, answer: "Yes — the whole number." }],
          REQS,
          request.signal,
        )
        .then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("waited for the refresh"), 1_000)),
    ]);
    expect(submitted).toBe("returned");
    const produce = vi.mocked(findingsStore.produceGoverningFindingsForAnalysis);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(produce.mock.calls[0]![0]).toMatchObject({
      analysisId: ANALYSIS,
      projectId: PROJECT,
      requirementIds: ["REQ-001"],
    });
    expect(produce.mock.calls[0]![0]).not.toHaveProperty("signal");
    // The settlement itself was committed before the submit returned.
    const read = await readGoverningApplicability(ANALYSIS);
    expect(read!.requirements[0]!.decisions[0]).toMatchObject({ verdict: "applies" });
    refresh.release();
  });
});

describe("#2059 — a Needs BA input finding on a rule that applies is asked, and its answer reaches the findings", () => {
  const FINDING_QUESTION = "Will the saved card keep the customer's whole card number?";
  beforeEach(() => {
    mem.metadata = JSON.stringify({
      governingApplicability: stored([
        {
          ruleId: "rule_card",
          controlId: "EN-03",
          verdict: "applies",
          reason: "A saved card is card data.",
          foundBy: ["screen"],
        },
      ]),
    });
    mem.findings = [
      { requirementId: "REQ-001", ruleId: "rule_card", businessQuestion: FINDING_QUESTION },
    ];
  });

  it("the finding's question is asked, linked to its rule; the answer is recorded with no judging call; the refresh is asked for", async () => {
    const { provider, sent } = model();
    const dialog = dialogWith(provider);
    const state = await dialog.startOrContinue(ANALYSIS, REQS);
    expect(vi.mocked(prisma.governingFinding.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { analysisId: ANALYSIS, status: "needs-ba-input" } }),
    );
    const questions = state.rounds[0]!.questions;
    expect(questions).toHaveLength(1);
    const q = questions[0]!;
    expect(q.question).toBe(FINDING_QUESTION);
    // The link the analysis view's "Answer the clarifying question" reads:
    // the finding's own requirement id and rule (clarifyingQuestionHref).
    expect(q.governing).toEqual({
      kind: "governing",
      ruleIds: ["rule_card"],
      requirementId: "REQ-001",
    });
    expect(state.completed).toBe(false);

    const { state: after } = await dialog.submitAnswers(
      ANALYSIS,
      [{ questionId: q.id, answer: "No." }],
      REQS,
    );
    expect(sent.filter((s) => s.system.includes("You decide which"))).toHaveLength(0);
    expect(after.completed).toBe(true);
    const read = await readGoverningApplicability(ANALYSIS);
    expect(read!.requirements[0]!.decisions[0]).toMatchObject({
      verdict: "applies",
      reason: "A saved card is card data.",
      settled: {
        questionId: q.id,
        question: FINDING_QUESTION,
        answer: "No.",
        previousVerdict: "applies",
      },
    });
    const produce = vi.mocked(findingsStore.produceGoverningFindingsForAnalysis);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(produce.mock.calls[0]![0]).toMatchObject({ requirementIds: ["REQ-001"] });
    refresh.release();

    // Recorded: the finding's question is not asked again, even while it still
    // reads Needs BA input until the refresh lands.
    const next = await dialog.startOrContinue(ANALYSIS, REQS);
    expect(next.completed).toBe(true);
  });

  it("a finding's question that names the control is re-asked in plain words before it is shown", async () => {
    mem.findings = [
      {
        requirementId: "REQ-001",
        ruleId: "rule_card",
        businessQuestion: "Does the saved card meet EN-03?",
      },
    ];
    const { provider, sent } = model();
    const state = await dialogWith(provider).startOrContinue(ANALYSIS, REQS);
    const q = state.rounds[0]!.questions[0]!;
    expect(q.question).not.toMatch(/EN-03/i);
    expect(sent.some((x) => x.system.startsWith("Rewrite the question"))).toBe(true);
    expect(q.governing?.ruleIds).toEqual(["rule_card"]);
  });
});

describe("#2068 — a finding still Needs BA input after its answer reaches the dialog again", () => {
  const FIRST = "Will the saved card keep the customer's whole card number?";
  const SECOND = "Who can see the stored card details once they are saved?";
  const APPLIES = stored([
    {
      ruleId: "rule_card",
      controlId: "EN-03",
      verdict: "applies",
      reason: "A saved card is card data.",
      foundBy: ["screen"],
    },
  ]);
  const finding = (businessQuestion: string, updatedAt?: Date) => ({
    requirementId: "REQ-001",
    ruleId: "rule_card",
    businessQuestion,
    citationDropped: false,
    decision: null,
    ...(updatedAt ? { updatedAt } : {}),
  });
  beforeEach(() => {
    mem.metadata = JSON.stringify({ governingApplicability: APPLIES });
    mem.findings = [finding(FIRST)];
  });

  it("a completed dialog re-opens with the refresh's new question; the answer is recorded with the first; the same question again asks nothing", async () => {
    const { provider } = model();
    const dialog = dialogWith(provider);
    const first = (await dialog.startOrContinue(ANALYSIS, REQS)).rounds[0]!.questions[0]!;
    const { state: done } = await dialog.submitAnswers(
      ANALYSIS,
      [{ questionId: first.id, answer: "Yes, the whole number." }],
      REQS,
    );
    expect(done.completed).toBe(true);
    refresh.release();

    // The refresh landed after the answer and still needs input, with a new question.
    mem.findings = [finding(SECOND, new Date(Date.now() + 60_000))];
    const reopened = await dialog.startOrContinue(ANALYSIS, REQS);
    expect(reopened.completed).toBe(false);
    expect(reopened.rounds).toHaveLength(2);
    const second = reopened.rounds[1]!.questions;
    expect(second.map((q) => [q.question, q.governing?.ruleIds])).toEqual([
      [SECOND, ["rule_card"]],
    ]);
    // Asked once: a second start returns the open round as it is.
    expect((await dialog.startOrContinue(ANALYSIS, REQS)).rounds).toHaveLength(2);

    const { state: again } = await dialog.submitAnswers(
      ANALYSIS,
      [{ questionId: second[0]!.id, answer: "Only the payments team." }],
      REQS,
    );
    expect(again.completed).toBe(true);
    const read = await readGoverningApplicability(ANALYSIS);
    expect(read!.requirements[0]!.decisions[0]!.settled).toMatchObject({
      questionId: second[0]!.id,
      answer: "Only the payments team.",
      earlier: [{ questionId: first.id, answer: "Yes, the whole number." }],
    });
    refresh.release();

    // A refresh that asks the question just answered asks nothing more.
    mem.findings = [finding(SECOND, new Date(Date.now() + 120_000))];
    const settled = await dialog.startOrContinue(ANALYSIS, REQS);
    expect(settled.completed).toBe(true);
    expect(settled.rounds).toHaveLength(2);
  });

  it("a dialog completed before #2059 asks the finding's question on its next start", async () => {
    fakeStore.set(ANALYSIS, {
      analysisId: ANALYSIS,
      currentRound: 2,
      maxRounds: 3,
      rounds: [{ round: 1, questions: [], answers: [] }],
      resolvedAmbiguities: [],
      escalatedToSonnet: false,
      completed: true,
    });
    const { provider } = model();
    const state = await dialogWith(provider).startOrContinue(ANALYSIS, REQS);
    expect(state.completed).toBe(false);
    expect(state.rounds.at(-1)).toMatchObject({ round: 2, questions: [{ question: FIRST }] });
  });

  it("#2077 — a completed dialog with nothing to ask is returned without a write, each time it is viewed", async () => {
    const completed = {
      analysisId: ANALYSIS,
      currentRound: 2,
      maxRounds: 3,
      rounds: [{ round: 1, questions: [], answers: [] }],
      resolvedAmbiguities: [],
      escalatedToSonnet: false,
      completed: true,
    };
    // No finding needs input, and the only pair applies: nothing to re-open for.
    mem.findings = [];
    fakeStore.set(ANALYSIS, completed);
    const { provider } = model();
    const dialog = dialogWith(provider);
    for (let view = 0; view < 2; view++) {
      expect(await dialog.startOrContinue(ANALYSIS, REQS)).toEqual(completed);
    }
    // Every round used, and already recorded as complete: no write either.
    fakeStore.set(ANALYSIS, { ...completed, currentRound: 4 });
    expect((await dialog.startOrContinue(ANALYSIS, REQS)).completed).toBe(true);
    expect(vi.mocked(dialogStore.writeDialogState)).not.toHaveBeenCalled();
    // One that used every round and is not marked complete yet is written once.
    fakeStore.set(ANALYSIS, { ...completed, currentRound: 4, completed: false });
    expect((await dialog.startOrContinue(ANALYSIS, REQS)).completed).toBe(true);
    expect(vi.mocked(dialogStore.writeDialogState)).toHaveBeenCalledTimes(1);
  });

  it("a dialog that used every round stays complete, and reads no finding", async () => {
    fakeStore.set(ANALYSIS, {
      analysisId: ANALYSIS,
      currentRound: 4,
      maxRounds: 3,
      rounds: [],
      resolvedAmbiguities: [],
      escalatedToSonnet: false,
      completed: true,
    });
    const { provider } = model();
    const state = await dialogWith(provider).startOrContinue(ANALYSIS, REQS);
    expect(state.completed).toBe(true);
    expect(state.rounds).toHaveLength(0);
    expect(vi.mocked(prisma.governingFinding.findMany)).not.toHaveBeenCalled();
  });
});

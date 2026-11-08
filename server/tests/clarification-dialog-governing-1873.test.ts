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
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ analysis })),
  };
  return { prisma, resolveDatabaseProvider: () => "sqlite" };
});

const { ClarificationDialog } = await import("../src/lib/analysis/clarification-dialog.js");
const { governingQuestionSourceFor } =
  await import("../src/lib/governing/applicability-questions.js");
const { readGoverningApplicability } = await import("../src/lib/governing/applicability-store.js");
const { createInMemoryBM25 } = await import("../src/lib/rag/bm25-index.js");
const { prisma } = await import("../src/lib/prisma.js");

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
    await dialog.startOrContinue(ANALYSIS, REQS);
    const after = await dialog.submitAnswers(ANALYSIS, [{ questionId: "x", answer: "n/a" }], REQS);
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
    delete process.env.GOVERNING_DOCS_ENABLED;
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

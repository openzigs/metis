/**
 * Tests for the clarification dialog's self-resolution wiring.
 *
 * The durable dialog store is mocked with an in-memory map so we avoid a real
 * Prisma/DB dependency. The provider + retriever are mocked. We assert that:
 *   - WITH retriever + projectId, generated questions carry grounding fields
 *     and these persist in the written dialog state.
 *   - WITHOUT a retriever, questions skip retrieval but still always carry a
 *     defined groundingStatus (degrades to "open").
 *   - When the provider is offline, no grounding/retrieval occurs but every
 *     surfaced question still carries groundingStatus === "open".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── in-memory dialog store mock ───────────────────────────────────────────
// #2156 — hoisted: the mock factory below hands it to the shared fake.
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./clarification-dialog-store.js", async () => {
  const { dialogStoreCasFakes } = await import("../../../tests/helpers/dialog-store-cas-fake.js");
  return {
    readDialogState: vi.fn(async (id: string) => store.get(id)),
    writeDialogState: vi.fn(async (id: string, state: unknown) => {
      store.set(id, state);
    }),
    deleteDialogState: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    // #2101 / #2142 — the compare-and-set writes over the same map.
    readDialogStateRevision: vi.fn(async (id: string) => {
      const v = store.get(id);
      return v ? { state: structuredClone(v) as unknown, revision: JSON.stringify(v) } : undefined;
    }),
    // #2101 / #2142 / #2156 — the compare-and-set writers, shared.
    ...dialogStoreCasFakes(store),
  };
});

import { ClarificationDialog } from "./clarification-dialog.js";
import type { GroundingRetriever } from "./ambiguity-grounding.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { ClarificationState, StructuredRequirements } from "./types/requirements.js";

const REQUIREMENTS: StructuredRequirements = {
  requirements: [
    {
      id: "r1",
      title: "API auth",
      description: "The API needs authentication.",
      type: "functional",
      priority: "high",
      ambiguities: [{ field: "authMethod", description: "auth scheme unspecified" }],
    } as unknown as StructuredRequirements["requirements"][number],
  ],
  totalAmbiguities: 1,
  totalEvidenceNeeds: 0,
} as unknown as StructuredRequirements;

/** Provider that returns one question, then a grounding decision. */
function makeProvider(opts: { offline?: boolean; groundingContent?: string }): {
  provider: AIProvider;
  chat: ReturnType<typeof vi.fn>;
} {
  // First chat() call = question generation; subsequent = grounding decisions.
  let call = 0;
  const chat = vi.fn(async (): Promise<ChatResponse> => {
    call += 1;
    if (call === 1) {
      return {
        content: JSON.stringify({
          questions: [
            {
              requirementId: "r1",
              ambiguityField: "authMethod",
              question: "Which auth method?",
              context: "unspecified",
            },
          ],
        }),
      } as ChatResponse;
    }
    return { content: opts.groundingContent ?? "" } as ChatResponse;
  });
  const provider = {
    key: "offline-stub",
    model: "test-model",
    offline: opts.offline ?? false,
    chat,
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
  return { provider, chat };
}

function makeRetriever(): {
  retriever: GroundingRetriever;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => ({
    hits: [
      {
        chunkId: "c1",
        documentId: "d1",
        filename: "auth.ts",
        text: "OAuth2 bearer tokens are used.",
        score: 0.95,
      },
    ],
  }));
  return { retriever: { search } as unknown as GroundingRetriever, search };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("ClarificationDialog self-resolution wiring", () => {
  it("enriches questions with grounding fields and persists them", async () => {
    const { provider } = makeProvider({
      groundingContent: JSON.stringify({
        status: "grounded",
        answer: "Use OAuth2 bearer tokens.",
        citationIndexes: [1],
      }),
    });
    const { retriever, search } = makeRetriever();

    const dialog = new ClarificationDialog({ provider, retriever, projectId: "proj-1" });
    const state = await dialog.startOrContinue("ana-1", REQUIREMENTS);

    const q = state.rounds[0]?.questions[0];
    expect(q?.groundingStatus).toBe("grounded");
    expect(q?.groundedAnswer).toContain("OAuth2");
    expect(q?.groundingCitations?.[0]?.source).toBe("auth.ts");
    expect(search).toHaveBeenCalledTimes(1);

    // Persisted state carries the enriched question (store mock holds it).
    const persisted = store.get("ana-1") as ClarificationState;
    expect(persisted.rounds[0]?.questions[0]?.groundingStatus).toBe("grounded");
    expect(persisted.rounds[0]?.questions[0]?.groundedAnswer).toContain("OAuth2");
  });

  it("skips retrieval but still stamps groundingStatus 'open' when no retriever", async () => {
    const { provider } = makeProvider({});
    const dialog = new ClarificationDialog({ provider });

    const state = await dialog.startOrContinue("ana-2", REQUIREMENTS);
    const q = state.rounds[0]?.questions[0];

    expect(q?.question).toBe("Which auth method?");
    // Bypass path (no retriever) must still guarantee a defined status.
    expect(q?.groundingStatus).toBe("open");
    expect(q?.groundedAnswer).toBeUndefined();
    // Only the question-generation chat() call happened, no grounding call.
    expect(provider.chat as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("does not ground when the provider is offline but stamps 'open'", async () => {
    const { provider } = makeProvider({ offline: true });
    const { retriever, search } = makeRetriever();

    const dialog = new ClarificationDialog({ provider, retriever, projectId: "proj-1" });
    const state = await dialog.startOrContinue("ana-3", REQUIREMENTS);

    const q = state.rounds[0]?.questions[0];
    // Offline bypass: no retrieval, but the question must not surface "cold".
    expect(q?.groundingStatus).toBe("open");
    expect(search).not.toHaveBeenCalled();
  });

  it("stamps every question 'open' when the grounding pass throws", async () => {
    // Question generation succeeds, but the retriever throws inside the
    // grounding pass — the catch-block bypass must still stamp 'open'.
    let call = 0;
    const chat = vi.fn(async (): Promise<ChatResponse> => {
      call += 1;
      if (call === 1) {
        return {
          content: JSON.stringify({
            questions: [
              { requirementId: "r1", ambiguityField: "authMethod", question: "Q1?", context: "x" },
              { requirementId: "r1", ambiguityField: "authMethod", question: "Q2?", context: "x" },
            ],
          }),
        } as ChatResponse;
      }
      return { content: "" } as ChatResponse;
    });
    const provider = {
      key: "offline-stub",
      model: "test-model",
      offline: false,
      chat,
      stream: vi.fn(),
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    } as unknown as AIProvider;

    // A retriever that throws synchronously at construction-time use would not
    // reach the per-question path; instead make AmbiguityGrounding's batch path
    // throw by giving a retriever whose .search rejects. groundQuestion swallows
    // that to "open", so to exercise the dialog-level catch we make the whole
    // batch throw by handing a retriever that is missing .search.
    const brokenRetriever = {} as unknown as GroundingRetriever;

    const dialog = new ClarificationDialog({
      provider,
      retriever: brokenRetriever,
      projectId: "proj-1",
    });
    const state = await dialog.startOrContinue("ana-4", REQUIREMENTS);

    const questions = state.rounds[0]?.questions ?? [];
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.groundingStatus).toBe("open");
    }
  });
});

// Issue #937 — a remounted Questions tab fired a second start while the first
// was still in flight, and the second round replaced the first one's
// questions (and billed the whole question generation again).
describe("ClarificationDialog start is idempotent per analysis + round (#937)", () => {
  it("returns the already-generated round on a repeat start instead of regenerating", async () => {
    const { provider, chat } = makeProvider({});
    const dialog = new ClarificationDialog({ provider });

    const first = await dialog.startOrContinue("ana-937-seq", REQUIREMENTS);
    const callsAfterFirst = chat.mock.calls.length;
    const second = await new ClarificationDialog({ provider }).startOrContinue(
      "ana-937-seq",
      REQUIREMENTS,
    );

    expect(chat.mock.calls.length).toBe(callsAfterFirst);
    expect(second.rounds).toHaveLength(1);
    expect(second.rounds[0]?.questions.map((q) => q.id)).toEqual(
      first.rounds[0]?.questions.map((q) => q.id),
    );
    const persisted = store.get("ana-937-seq") as ClarificationState;
    expect(persisted.rounds).toHaveLength(1);
  });

  it("joins a concurrent start for the same analysis rather than generating twice", async () => {
    const { provider, chat } = makeProvider({});

    const [a, b] = await Promise.all([
      new ClarificationDialog({ provider }).startOrContinue("ana-937-par", REQUIREMENTS),
      new ClarificationDialog({ provider }).startOrContinue("ana-937-par", REQUIREMENTS),
    ]);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(a.rounds).toHaveLength(1);
    expect(b.rounds[0]?.questions.map((q) => q.id)).toEqual(
      a.rounds[0]?.questions.map((q) => q.id),
    );
    expect((store.get("ana-937-par") as ClarificationState).rounds).toHaveLength(1);
  });

  it("does not join starts for different analyses", async () => {
    const { provider, chat } = makeProvider({});
    // makeProvider answers only its FIRST call with questions; give each its own.
    const other = makeProvider({});

    await Promise.all([
      new ClarificationDialog({ provider }).startOrContinue("ana-937-x", REQUIREMENTS),
      new ClarificationDialog({ provider: other.provider }).startOrContinue(
        "ana-937-y",
        REQUIREMENTS,
      ),
    ]);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(other.chat).toHaveBeenCalledTimes(1);
    expect((store.get("ana-937-y") as ClarificationState).rounds).toHaveLength(1);
  });

  it("releases the in-flight slot when a start fails, so a retry can run", async () => {
    const failing = {
      ...makeProvider({}).provider,
      chat: vi.fn(async () => {
        throw new Error("provider down");
      }),
    } as unknown as AIProvider;
    await expect(
      new ClarificationDialog({ provider: failing }).startOrContinue("ana-937-err", REQUIREMENTS),
    ).rejects.toThrow();

    const { provider, chat } = makeProvider({});
    const state = await new ClarificationDialog({ provider }).startOrContinue(
      "ana-937-err",
      REQUIREMENTS,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(state.rounds).toHaveLength(1);
  });
});

describe("ClarificationDialog askFirst — #1129", () => {
  const TWO: StructuredRequirements = {
    requirements: ["added-1", "ticked-1"].map((id) => ({
      id,
      title: id,
      description: id,
      type: "functional",
      priority: "high",
      ambiguities: [{ field: "scope", description: "unclear" }],
    })),
    totalAmbiguities: 2,
    totalEvidenceNeeds: 0,
  } as unknown as StructuredRequirements;

  const twoQuestionProvider = (): AIProvider =>
    ({
      offline: true,
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          questions: ["added-1", "ticked-1"].map((requirementId) => ({
            requirementId,
            ambiguityField: "scope",
            question: `About ${requirementId}?`,
            context: "",
          })),
        }),
      })),
    }) as unknown as AIProvider;

  it("asks the ticked items' questions first", async () => {
    const dialog = new ClarificationDialog({
      provider: twoQuestionProvider(),
      askFirst: new Set(["ticked-1"]),
    });
    const state = await dialog.startOrContinue("ana-ask-first", TWO);
    expect(state.rounds[0]!.questions.map((q) => q.requirementId)).toEqual(["ticked-1", "added-1"]);
  });

  it("keeps the generated order without askFirst", async () => {
    const dialog = new ClarificationDialog({ provider: twoQuestionProvider() });
    const state = await dialog.startOrContinue("ana-no-ask-first", TWO);
    expect(state.rounds[0]!.questions.map((q) => q.requirementId)).toEqual(["added-1", "ticked-1"]);
  });
});

describe("#2128 — a clarifying question never shows a requirement's internal id", () => {
  const LENGTH_ID = "6280ae21-b83d-4cef-adcc-10dba3e4443f";
  const OLD_ID = "a67493fc-1123-460b-a3e7-1024773280c6";
  const req = (id: string, title: string) =>
    ({
      id,
      title,
      description: title,
      type: "functional",
      priority: "high",
      ambiguities: [{ field: "references", description: "unclear" }],
    }) as unknown as StructuredRequirements["requirements"][number];
  const TWO_REQS = {
    requirements: [req(LENGTH_ID, "Minimum password length"), req(OLD_ID, "Old 6-character rule")],
    totalAmbiguities: 2,
    totalEvidenceNeeds: 0,
  } as unknown as StructuredRequirements;

  it("drops an '(id: …)' aside and names a bare id by its requirement's title", async () => {
    const provider = {
      offline: true,
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          questions: [
            {
              requirementId: OLD_ID,
              ambiguityField: "references",
              question: `How does this rule relate to the new password length requirement (id: ${LENGTH_ID})?`,
              context: `Requirement ${LENGTH_ID.toUpperCase()} supersedes it; see [ID: ${OLD_ID}].`,
            },
          ],
        }),
      })),
    } as unknown as AIProvider;
    const state = await new ClarificationDialog({ provider }).startOrContinue("ana-2128", TWO_REQS);
    const q = state.rounds[0]!.questions[0]!;
    // The id the question is stored against is untouched; only the words change.
    expect(q.requirementId).toBe(OLD_ID);
    expect(q.question).toBe("How does this rule relate to the new password length requirement?");
    expect(q.context).toBe(
      'Requirement "Minimum password length" supersedes it; see "Old 6-character rule".',
    );
  });

  it("leaves a short, readable id and an id the prompt did not show as written", async () => {
    const { nameRequirementIds } = await import("./clarification-dialog.js");
    const reqs = [req("REQ-001", "Login"), req(LENGTH_ID, "Minimum password length")];
    expect(nameRequirementIds("What does REQ-001 say?", reqs)).toBe("What does REQ-001 say?");
    const other = "11111111-2222-4333-8444-555555555555";
    expect(nameRequirementIds(`Is ${other} related?`, reqs)).toBe(`Is ${other} related?`);
    expect(nameRequirementIds("", reqs)).toBe("");
  });

  it("#2132 — an aside after a bare 'requirement' gives way to the title, so the referent is kept", async () => {
    const { nameRequirementIds } = await import("./clarification-dialog.js");
    const reqs = [req(LENGTH_ID, "Minimum password length")];
    expect(nameRequirementIds(`Requirement (id: ${LENGTH_ID}) is unclear.`, reqs)).toBe(
      'Requirement "Minimum password length" is unclear.',
    );
    expect(nameRequirementIds(`Is the requirement (id: ${LENGTH_ID}) met?`, reqs)).toBe(
      'Is the requirement "Minimum password length" met?',
    );
    // Words that already name the requirement keep the aside dropped.
    expect(
      nameRequirementIds(`How does the password length requirement (id: ${LENGTH_ID}) fit?`, reqs),
    ).toBe("How does the password length requirement fit?");
  });

  // #2143 — a label or a quoted name before "requirement" already names it: only
  // punctuation, an article or a preposition leaves it bare.
  it("#2143 — 'requirement' after a label, a number or a quoted name is not bare", async () => {
    const { nameRequirementIds } = await import("./clarification-dialog.js");
    const reqs = [req(LENGTH_ID, "Minimum password length")];
    expect(nameRequirementIds(`The REQ-001 requirement (id: ${LENGTH_ID}) is unclear.`, reqs)).toBe(
      "The REQ-001 requirement is unclear.",
    );
    expect(
      nameRequirementIds(`Is the "Password length" requirement (id: ${LENGTH_ID}) met?`, reqs),
    ).toBe('Is the "Password length" requirement met?');
    expect(
      nameRequirementIds(`Is the “Password length” requirement (id: ${LENGTH_ID}) met?`, reqs),
    ).toBe("Is the “Password length” requirement met?");
    // Punctuation still leaves it bare.
    expect(nameRequirementIds(`Unclear: requirement (id: ${LENGTH_ID}).`, reqs)).toBe(
      'Unclear: requirement "Minimum password length".',
    );
  });

  // #2143 — whether "requirement" is bare is read over the label window before the
  // aside, not over the whole question built so far.
  it("#2143 — a long question before the aside reads the same as a short one", async () => {
    const { nameRequirementIds } = await import("./clarification-dialog.js");
    const reqs = [req(LENGTH_ID, "Minimum password length")];
    const lead = "Before anything else, and with the export rules in mind, ".repeat(40);
    expect(nameRequirementIds(`${lead}is the requirement (id: ${LENGTH_ID}) met?`, reqs)).toBe(
      `${lead}is the requirement "Minimum password length" met?`,
    );
    expect(
      nameRequirementIds(`${lead}is the length requirement (id: ${LENGTH_ID}) met?`, reqs),
    ).toBe(`${lead}is the length requirement met?`);
  });

  it("#2132 — a bracket is taken only with the bracket that closes it", async () => {
    const { nameRequirementIds } = await import("./clarification-dialog.js");
    const reqs = [req(LENGTH_ID, "Minimum password length")];
    expect(nameRequirementIds(`See [${LENGTH_ID}, REQ-002].`, reqs)).toBe(
      'See ["Minimum password length", REQ-002].',
    );
    expect(nameRequirementIds(`See [id: ${LENGTH_ID} ] now.`, reqs)).toBe(
      'See "Minimum password length" now.',
    );
    expect(nameRequirementIds(`See [ID: ${LENGTH_ID}].`, reqs)).toBe(
      'See "Minimum password length".',
    );
    // A `]` no `[` opened is not the label's to take.
    expect(nameRequirementIds(`See ${LENGTH_ID}] now.`, reqs)).toBe(
      'See "Minimum password length"] now.',
    );
  });

  it("text whose lower case is longer than itself is not corrupted", async () => {
    const { nameRequirementIds } = await import("./clarification-dialog.js");
    const reqs = [req(LENGTH_ID, "Minimum password length")];
    // "İ".toLowerCase() is two code units, which once shifted every index after it.
    expect(nameRequirementIds(`İİ office: see ${LENGTH_ID} now.`, reqs)).toBe(
      'İİ office: see "Minimum password length" now.',
    );
  });
});

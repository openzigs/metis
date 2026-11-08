import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentOutput } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../../ai/types.js";
import {
  GOVERNING_ARM_IDS,
  buildGoverningArms,
  buildJudgePrompt,
  corpusApplicabilityRules,
  corpusFindingRules,
  readFindings,
  readApplicabilitySet,
  buildScreenPrompt,
  measureScreenPromptSizes,
  parseGoverningArmIds,
  parseJudgeReply,
  parseScreenReply,
  policyDocumentId,
  policyKnowledge,
  projectNameOf,
  readWebFindings,
  replayAnswers,
  topKRules,
} from "./arms.js";
import { resolveFinalAnswerMaxOutputTokens } from "../../analysis/agent-runner.js";
import { loadGoverningCorpus, type GoverningCorpus, type GoverningItem } from "./corpus.js";

let corpus: GoverningCorpus;
beforeAll(async () => {
  corpus = await loadGoverningCorpus("governing-01-sample-policy");
});

const itemById = (id: string): GoverningItem => corpus.manifest.items.find((i) => i.id === id)!;

interface Call {
  messages: ChatMessage[];
  opts?: ChatOptions;
}

/** A provider whose `chat` answers with `replies` in turn and records each call. */
function stubProvider(replies: string[]): { provider: AIProvider; calls: Call[] } {
  const calls: Call[] = [];
  const provider = {
    key: "anthropic",
    model: "stub-model",
    offline: false,
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      calls.push({ messages, opts });
      const content = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return {
        content,
        model: "stub-model",
        provider: "anthropic",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

const finding = (over: Partial<AgentOutput["findings"][number]>): AgentOutput["findings"][number] =>
  ({
    category: "compliance",
    severity: "high",
    title: "t",
    body: "b",
    tags: [],
    citations: [],
    ...over,
  }) as AgentOutput["findings"][number];

const agentOutput = (...findings: AgentOutput["findings"]): AgentOutput => ({
  agentKey: "web",
  summary: "s",
  findings,
  notes: [],
});

describe("parseGoverningArmIds", () => {
  it("defaults to A0, upper-cases, deduplicates and orders", () => {
    expect(parseGoverningArmIds(undefined)).toEqual(["A0"]);
    expect(parseGoverningArmIds("a2, a0,A2")).toEqual(["A0", "A2"]);
    expect(GOVERNING_ARM_IDS).toEqual(["A0", "A1", "A2", "A3", "A4"]);
  });

  it("refuses an unknown or empty arm list", () => {
    expect(() => parseGoverningArmIds("A0,A9")).toThrow(
      /unknown arm\(s\) A9; known: A0, A1, A2, A3, A4/,
    );
    expect(() => parseGoverningArmIds(" , ")).toThrow(/needs an arm id/);
  });
});

describe("readWebFindings — today's findings read as judgements", () => {
  it("applies a rule a finding names, judged gap, citing the snippet that quotes its clause", () => {
    const out = readWebFindings(
      agentOutput(
        finding({
          body: "Under AL-02 the download must be logged.",
          citations: [
            { documentId: policyDocumentId(corpus), chunkIndex: 0, snippet: "unrelated text here" },
            {
              documentId: policyDocumentId(corpus),
              chunkIndex: 1,
              snippet: "**AL-02** Every bulk extraction of customer or financial records",
            },
          ],
        }),
      ),
      corpus,
    );
    expect(out.judgements).toEqual([
      {
        ruleId: "AL-02",
        verdict: "gap",
        citation: {
          ruleId: "AL-02",
          excerpt: "**AL-02** Every bulk extraction of customer or financial records",
        },
      },
    ]);
  });

  it("applies a rule whose clause a snippet quotes even when no id is named", () => {
    const out = readWebFindings(
      agentOutput(
        finding({
          citations: [
            {
              documentId: policyDocumentId(corpus),
              chunkIndex: 0,
              snippet: "Full card numbers are never stored",
            },
          ],
        }),
      ),
      corpus,
    );
    expect(out.judgements.map((j) => j.ruleId)).toEqual(["EN-03"]);
  });

  it("attaches no citation when no snippet verifies against the rule, or nothing is cited", () => {
    const out = readWebFindings(
      agentOutput(
        finding({
          title: "PR-04 location consent",
          citations: [
            {
              documentId: policyDocumentId(corpus),
              chunkIndex: 0,
              snippet: "ask before using GPS",
            },
          ],
        }),
        finding({ tags: ["DR-06"] }),
      ),
      corpus,
    );
    expect(out.judgements).toEqual([
      { ruleId: "PR-04", verdict: "gap" },
      { ruleId: "DR-06", verdict: "gap" },
    ]);
  });

  it("never hands one rule's verbatim clause to another rule the finding names (#1900)", () => {
    // The finding names AL-02 and EN-03 but quotes only EN-03's clause: the old
    // reader gave AL-02 that snippet too, a failed citation made by the reader.
    const out = readWebFindings(
      agentOutput(
        finding({
          body: "AL-02 and EN-03 both bear on the export.",
          citations: [
            {
              documentId: policyDocumentId(corpus),
              chunkIndex: 0,
              snippet: "Full card numbers are never stored",
            },
          ],
        }),
      ),
      corpus,
    );
    expect(out.judgements).toEqual([
      { ruleId: "AL-02", verdict: "gap" },
      {
        ruleId: "EN-03",
        verdict: "gap",
        citation: { ruleId: "EN-03", excerpt: "Full card numbers are never stored" },
      },
    ]);
  });

  it("replaces an unverified citation with a later finding's verified one", () => {
    const doc = policyDocumentId(corpus);
    const out = readWebFindings(
      agentOutput(
        finding({
          body: "EN-03",
          citations: [{ documentId: doc, chunkIndex: 0, snippet: "cards" }],
        }),
        finding({
          body: "EN-03 again",
          citations: [{ documentId: doc, chunkIndex: 0, snippet: "at most the last four digits" }],
        }),
      ),
      corpus,
    );
    expect(out.judgements).toEqual([
      {
        ruleId: "EN-03",
        verdict: "gap",
        citation: { ruleId: "EN-03", excerpt: "at most the last four digits" },
      },
    ]);
  });
});

describe("A0 — the web specialist over chunk retrieval", () => {
  it("serves the policy's chunks through production retrieval, and reads the web agent's reply", async () => {
    const reply = JSON.stringify({
      summary: "Audit logging applies.",
      findings: [
        {
          category: "compliance",
          severity: "high",
          title: "Invoice downloads must be logged (AL-02)",
          body: "The download is a bulk extraction of financial records.",
          confidence: 0.8,
          derivation: "inferred",
          tags: ["audit"],
          citations: [
            {
              documentId: policyDocumentId(corpus),
              chunkIndex: 0,
              snippet: "naming the person, the time and the scope of what was taken",
            },
          ],
        },
      ],
      notes: [],
    });
    const { provider, calls } = stubProvider([reply]);
    const [a0] = buildGoverningArms(["A0"], { model: "anthropic/stub-model" });
    expect(a0!.configuration.model).toBe("anthropic/stub-model");
    const out = await a0!.assess(itemById("GR-01"), corpus, { provider });
    expect(calls).toHaveLength(1);
    const prompt = String(calls[0]!.messages[0]!.content);
    // The policy reached the web specialist's context, and so did the requirement (as the operator note).
    expect(prompt).toContain(`documentId=${policyDocumentId(corpus)}`);
    expect(prompt).toContain("**AL-02**");
    expect(prompt).toContain("downloads all of last month's invoices");
    expect(out.judgements).toEqual([
      {
        ruleId: "AL-02",
        verdict: "gap",
        citation: {
          ruleId: "AL-02",
          excerpt: "naming the person, the time and the scope of what was taken",
        },
      },
    ]);
    expect(out.diagnostics!.retrievedChunks).toBeGreaterThan(0);
    expect(out.diagnostics!.policyChunks).toBeGreaterThan(0);
    expect(out.diagnostics!.findings).toBe(1);
  });

  it("declares the metrics its reading fixes, so their bars cannot print as passes (#1900)", () => {
    const [a0, a1, a2] = buildGoverningArms(["A0", "A1", "A2"], { model: "anthropic/stub-model" });
    expect(Object.keys(a0!.byConstruction ?? {}).sort()).toEqual([
      "askRate",
      "citationAccuracy",
      "hardErrors",
    ]);
    expect(a1!.byConstruction).toBeUndefined();
    expect(a2!.byConstruction).toBeUndefined();
  });

  it("policyKnowledge ranks chunks lexically, as uploads with a positive score", async () => {
    const { source, chunks } = policyKnowledge(corpus);
    expect(chunks).toBeGreaterThan(1);
    const { hits } = await source.search("p", "card numbers stored", {});
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("Full card numbers");
    expect(hits.every((h) => h.source === "upload" && h.score > 0)).toBe(true);
    expect((await source.search("p", "   ", { k: 3 })).hits).toEqual([]);
    expect(projectNameOf(corpus)).toBe("Harbor Lane Outfitters");
  });
});

describe("A1 and A2", () => {
  const judged = JSON.stringify({
    judgements: [
      {
        ruleId: "AL-02",
        verdict: "needs-ba-input",
        excerpt: "naming the person, the time",
        businessFact: "Is each download attributed?",
      },
    ],
  });

  it("A1 judges only the top-k rule summaries, in one call", async () => {
    const { provider, calls } = stubProvider([judged]);
    const [a1] = buildGoverningArms(["A1"], { model: "m", topK: 3 });
    const item = itemById("GR-19");
    const out = await a1!.assess(item, corpus, { provider });
    expect(calls).toHaveLength(1);
    // runAgent's output cap, not a smaller fixed one: thinking spends from it too.
    expect(calls[0]!.opts?.maxTokens).toBe(
      resolveFinalAnswerMaxOutputTokens(provider.model, provider.key),
    );
    expect(calls[0]!.opts!.maxTokens!).toBeGreaterThan(4096);
    const top = topKRules(corpus, `${item.title}\n\n${item.text}`, 3).map((r) => r.id);
    expect(top).toContain("EN-03");
    const prompt = String(calls[0]!.messages[0]!.content);
    for (const id of top) expect(prompt).toContain(`[${id}] clause:`);
    expect(prompt.match(/\] clause:/g)).toHaveLength(top.length);
    expect(out.judgements[0]).toEqual({
      ruleId: "AL-02",
      verdict: "needs-ba-input",
      citation: { ruleId: "AL-02", excerpt: "naming the person, the time" },
      businessFact: "Is each download attributed?",
    });
    expect(out.diagnostics).toEqual({ candidates: top.length, dropped: 0 });
  });

  it("A2 adds what the full-summary screen flags to the rules it judges, and only known ids", async () => {
    const { provider, calls } = stubProvider([
      JSON.stringify({ ruleIds: ["AL-02", "ZZ-99", "AL-02"] }),
      judged,
    ]);
    const [a2] = buildGoverningArms(["A2"], { model: "m", topK: 2 });
    const item = itemById("GR-01");
    const top = topKRules(corpus, `${item.title}\n\n${item.text}`, 2).map((r) => r.id);
    expect(top).not.toContain("AL-02"); // top-k alone misses the non-resembling rule
    const out = await a2!.assess(item, corpus, { provider });
    expect(calls).toHaveLength(2);
    const screen = String(calls[0]!.messages[0]!.content);
    for (const r of corpus.rules) expect(screen).toContain(`${r.id}: ${r.summary}`);
    const judge = String(calls[1]!.messages[0]!.content);
    expect(judge).toContain("[AL-02] clause:");
    expect(out.diagnostics).toEqual({
      candidates: top.length + 1,
      dropped: 0,
      screened: 1,
      screenUnknown: 1,
    });
  });

  it("a judging reply with no JSON object fails the requirement rather than scoring it", async () => {
    const { provider } = stubProvider(["I cannot help with that."]);
    const [a1] = buildGoverningArms(["A1"], { model: "m" });
    await expect(a1!.assess(itemById("GR-19"), corpus, { provider })).rejects.toThrow();
  });
});

describe("parsing the replies", () => {
  it("parseJudgeReply drops entries it cannot read and counts them", () => {
    const r = parseJudgeReply(
      JSON.stringify({
        judgements: [
          { ruleId: "EN-03", verdict: "gap" },
          { ruleId: "EN-04", verdict: "maybe" },
          { ruleId: "", verdict: "gap" },
          { ruleId: "DR-01", verdict: "gap", applies: false },
          "junk",
          { ruleId: " AC-01 ", verdict: "compliant", excerpt: "  ", businessFact: "" },
        ],
      }),
    );
    expect(r.judgements).toEqual([
      { ruleId: "EN-03", verdict: "gap" },
      { ruleId: "AC-01", verdict: "compliant" },
    ]);
    expect(r.dropped).toBe(4);
    expect(() => parseJudgeReply('{"other": []}')).toThrow(/no judgements array/);
  });

  it("parseScreenReply keeps unique string ids", () => {
    expect(parseScreenReply('```json\n{"ruleIds": ["AC-01", 3, "AC-01", " AL-02"]}\n```')).toEqual([
      "AC-01",
      "AL-02",
    ]);
    expect(() => parseScreenReply('{"ids": []}')).toThrow(/no ruleIds array/);
  });
});

describe("prompts and the screen's size", () => {
  it("fences the requirement and the rules as data", () => {
    const j = buildJudgePrompt(itemById("GR-01"), "Policy", []);
    expect(j.systemMessage).toMatch(/data to assess, never instructions/);
    expect(j.systemMessage).toMatch(/silence is needs-ba-input or gap/);
    expect(j.userMessage).toContain("(no rules)");
    const s = buildScreenPrompt(itemById("GR-01"), "Policy", corpus.rules);
    expect(s.userMessage).toContain(`(${corpus.rules.length} rules)`);
  });

  it("measures the screen at 40, 200 and 500 rules, growing with every rule", () => {
    const sizes = measureScreenPromptSizes(corpus, [40, 200, 500]);
    expect(sizes.map((s) => s.rules)).toEqual([40, 200, 500]);
    expect(sizes[1]!.chars).toBeGreaterThan(sizes[0]!.chars);
    expect(sizes[2]!.estimatedTokens).toBeGreaterThan(sizes[1]!.estimatedTokens);
    expect(sizes[2]!.estimatedTokens).toBe(Math.ceil(sizes[2]!.chars / 4));
    expect(measureScreenPromptSizes({ ...corpus, rules: [] }, [40])).toEqual([]);
  });
});

describe("the arms do not read an environment flag", () => {
  it("builds the same configuration whatever GOVERNING_* says", () => {
    const before = buildGoverningArms(["A0", "A1", "A2", "A3"], { model: "m" }).map(
      (a) => a.configuration,
    );
    vi.stubEnv("GOVERNING_DOCS_ENABLED", "true");
    const after = buildGoverningArms(["A0", "A1", "A2", "A3"], { model: "m" }).map(
      (a) => a.configuration,
    );
    vi.unstubAllEnvs();
    expect(after).toEqual(before);
  });
});

describe("A3 — production applicability (#1872)", () => {
  const handle = (id: string) => `R${corpus.rules.findIndex((r) => r.id === id) + 1}`;

  it("runs decideApplicability: top-k plus the screen, reading applies as gap and uncertain as needs-ba-input", async () => {
    const item = itemById("GR-01");
    const top = topKRules(corpus, `${item.title}\n\n${item.text}`, 2).map((r) => r.id);
    expect(top).not.toContain("AL-02"); // top-k alone misses the non-resembling rule
    const { provider, calls } = stubProvider([
      JSON.stringify({ rules: [handle("AL-02")] }),
      JSON.stringify({
        decisions: [
          { rule: handle(top[0]!), verdict: "applies", reason: "Reads it." },
          { rule: handle(top[1]!), verdict: "does-not-apply", reason: "Unrelated." },
          {
            rule: handle("AL-02"),
            verdict: "uncertain",
            reason: "Depends.",
            businessFact: "Is each download attributed?",
          },
        ],
      }),
    ]);
    const [a3] = buildGoverningArms(["A3"], { model: "m", topK: 2 });
    const out = await a3!.assess(item, corpus, { provider });
    expect(calls).toHaveLength(2);
    const screen = String(calls[0]!.messages[0]!.content);
    for (const r of corpus.rules) expect(screen).toContain(`[${r.id}]: ${r.summary}`);
    expect(new Set(out.judgements.map((j) => j.ruleId))).toEqual(new Set([top[0]!, "AL-02"]));
    expect(out.judgements.find((j) => j.ruleId === top[0])).toEqual({
      ruleId: top[0],
      verdict: "gap",
    });
    expect(out.judgements.find((j) => j.ruleId === "AL-02")).toEqual({
      ruleId: "AL-02",
      verdict: "needs-ba-input",
      businessFact: "Is each download attributed?",
    });
    expect(out.diagnostics).toEqual({
      candidates: 3,
      screened: corpus.rules.length,
      screenBatches: 1,
      reasked: 0,
      screenReasked: 0,
      screenOnly: 1,
    });
  });

  it("declares the metrics an applicability-only reading fixes", () => {
    const [a3] = buildGoverningArms(["A3"], { model: "anthropic/stub-model" });
    expect(Object.keys(a3!.byConstruction ?? {}).sort()).toEqual([
      "citationAccuracy",
      "hardErrors",
    ]);
    expect(a3!.configuration.model).toBe("anthropic/stub-model");
  });

  it("readApplicabilitySet drops does-not-apply; corpus rules map one to one", () => {
    expect(
      readApplicabilitySet({
        decisions: [
          {
            ruleId: "A",
            controlId: "A",
            verdict: "does-not-apply",
            reason: "",
            foundBy: ["top-k"],
          },
          { ruleId: "B", controlId: "B", verdict: "uncertain", reason: "", foundBy: ["screen"] },
        ],
      }).judgements,
    ).toEqual([{ ruleId: "B", verdict: "needs-ba-input" }]);
    expect(corpusApplicabilityRules(corpus)[0]).toEqual({
      id: corpus.rules[0]!.id,
      revisionId: corpus.name,
      controlId: corpus.rules[0]!.id,
      summary: corpus.rules[0]!.summary,
      clauseExcerpt: corpus.rules[0]!.clause,
    });
  });
});

describe("A4 — production findings (#1874)", () => {
  const handle = (id: string) => `R${corpus.rules.findIndex((r) => r.id === id) + 1}`;

  it("every corpus rule's clause is located in the scored policy text", () => {
    const rules = corpusFindingRules(corpus);
    expect(rules.size).toBe(corpus.rules.length);
    for (const r of rules.values()) {
      expect(corpus.policyText.slice(r.clauseStart, r.clauseEnd)).toBe(r.clauseExcerpt);
    }
  });

  it("applies A3, then a finding per applying rule: a verified clause is cited, an uncertain one asks", async () => {
    const item = itemById("GR-01");
    const top = topKRules(corpus, `${item.title}\n\n${item.text}`, 2).map((r) => r.id);
    const clause = corpus.ruleById.get(top[0]!)!.clause;
    const excerpt = clause.split(/\s+/).slice(0, 8).join(" ");
    const { provider, calls } = stubProvider([
      JSON.stringify({ rules: [handle("AL-02")] }),
      JSON.stringify({
        decisions: [
          { rule: handle(top[0]!), verdict: "applies", reason: "Reads it." },
          { rule: handle(top[1]!), verdict: "does-not-apply", reason: "No." },
          {
            rule: handle("AL-02"),
            verdict: "uncertain",
            reason: "Depends.",
            businessFact: "Is each download attributed?",
          },
        ],
      }),
      // The findings call: the one applying rule (R1 in its own prompt) is a gap.
      JSON.stringify({ findings: [{ rule: "R1", status: "gap", reasoning: "Missing.", excerpt }] }),
    ]);
    const [a4] = buildGoverningArms(["A4"], { model: "m", topK: 2 });
    const out = await a4!.assess(item, corpus, { provider });
    expect(calls).toHaveLength(3);
    expect(out.judgements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: top[0],
          verdict: "gap",
          citation: { ruleId: top[0], excerpt: expect.stringContaining(excerpt.split(" ")[0]!) },
        }),
        expect.objectContaining({
          ruleId: "AL-02",
          verdict: "needs-ba-input",
          businessFact: "Is each download attributed?",
        }),
      ]),
    );
    expect(out.judgements.find((j) => j.ruleId === top[1])).toBeUndefined();
    expect(out.diagnostics).toMatchObject({ applicable: 2, unverifiedCitations: 0 });
    // GR-01 has no short-answer pair: nothing is replayed (#2033).
    expect(out.answered).toBeUndefined();
    expect(out.diagnostics).not.toHaveProperty("answersReplayed");
  });

  describe("replaying a short BA answer (#2033)", () => {
    // GR-11: "Are any of those emails part of a dispute or lawsuit the legal
    // team has asked us to preserve?" — "No.", which MEETS DR-06.
    const item = () => itemById("GR-11");
    const QUESTION =
      "Are any of those emails part of a dispute or lawsuit the legal team has asked us to preserve?";
    const excerpt = () => corpus.ruleById.get("DR-06")!.clause.split(/\s+/).slice(0, 8).join(" ");
    /** A3 for GR-11: the screen flags DR-06, the judge says it is uncertain, every top-k rule does not apply. */
    const applicability = () => {
      const i = item();
      const top = topKRules(corpus, `${i.title}\n\n${i.text}`, 2)
        .map((r) => r.id)
        .filter((id) => id !== "DR-06");
      return [
        JSON.stringify({ rules: [handle("DR-06")] }),
        JSON.stringify({
          decisions: [
            ...top.map((id) => ({ rule: handle(id), verdict: "does-not-apply", reason: "No." })),
            {
              rule: handle("DR-06"),
              verdict: "uncertain",
              reason: "Depends on a hold.",
              businessFact: "Is any of it under a legal hold?",
            },
          ],
        }),
      ];
    };
    const compliantReply = (satisfiedBy: string) =>
      JSON.stringify({
        findings: [
          {
            rule: "R1",
            status: "compliant",
            reasoning: "None is held.",
            excerpt: excerpt(),
            satisfiedBy,
          },
        ],
      });

    it("settles the uncertain rule with the answer, then judges its finding on the question and answer", async () => {
      const { provider, calls } = stubProvider([
        ...applicability(),
        // Production's settle: the answered rule re-judged with the question and answer.
        JSON.stringify({
          decisions: [{ rule: "R1", verdict: "applies", reason: "Purges records." }],
        }),
        compliantReply("the legal team has asked us to preserve? No."),
      ]);
      const [a4] = buildGoverningArms(["A4"], { model: "m", topK: 2 });
      expect(a4!.replaysAnswers).toBe(true);
      expect(a4!.configuration.answerReplay).toMatch(/rejudgeAnswered/);
      const out = await a4!.assess(item(), corpus, { provider });
      // Screen, judge, settle, findings: no findings call before the answer (DR-06 is uncertain).
      expect(calls).toHaveLength(4);
      const settle = String(calls[2]!.messages[0]!.content);
      expect(settle).toContain(`A business analyst was asked: ${QUESTION}\nTheir answer: No.`);
      const findings = String(calls[3]!.messages[0]!.content);
      expect(findings).toContain(`A business analyst was asked: ${QUESTION}\nTheir answer: No.`);
      // The reading before the answer is unchanged: DR-06 still asks.
      expect(out.judgements).toEqual([
        expect.objectContaining({ ruleId: "DR-06", verdict: "needs-ba-input" }),
      ]);
      // After it, the short answer quoted with its question is evidence, so compliant stands.
      expect(out.answered).toEqual({
        judgements: [
          {
            ruleId: "DR-06",
            verdict: "compliant",
            citation: { ruleId: "DR-06", excerpt: expect.stringContaining("legal hold") },
          },
        ],
      });
      expect(out.diagnostics).toMatchObject({
        answersReplayed: 1,
        answersSettled: 1,
        answeredNoEvidenceDemoted: 0,
      });
    });

    it("lets the evidence rule demote a compliant that quotes only the question", async () => {
      const { provider } = stubProvider([
        ...applicability(),
        JSON.stringify({
          decisions: [{ rule: "R1", verdict: "applies", reason: "Purges records." }],
        }),
        compliantReply("the legal team has asked us to preserve"),
      ]);
      const [a4] = buildGoverningArms(["A4"], { model: "m", topK: 2 });
      const out = await a4!.assess(item(), corpus, { provider });
      expect(out.answered!.judgements.map((j) => j.verdict)).toEqual(["gap"]);
      expect(out.diagnostics).toMatchObject({ answeredNoEvidenceDemoted: 1 });
    });

    it("gives no finding when the answer settles the rule as not applying", async () => {
      const { provider, calls } = stubProvider([
        ...applicability(),
        JSON.stringify({
          decisions: [{ rule: "R1", verdict: "does-not-apply", reason: "No hold." }],
        }),
      ]);
      const [a4] = buildGoverningArms(["A4"], { model: "m", topK: 2 });
      const out = await a4!.assess(item(), corpus, { provider });
      expect(calls).toHaveLength(3);
      expect(out.answered).toEqual({ judgements: [] });
      expect(out.diagnostics).toMatchObject({ answersReplayed: 1, answersSettled: 1 });
    });

    it("keeps the reading before the answer when the replay throws, and says why", async () => {
      const replies = [...applicability(), "{}"];
      let n = 0;
      const provider = {
        key: "anthropic",
        model: "stub-model",
        offline: false,
        async chat(): Promise<ChatResponse> {
          n++;
          // The settle swallows a failed call; the findings call after it does not.
          if (n === 4) throw new Error("provider down\n  at the findings call");
          const content =
            n === 3
              ? JSON.stringify({ decisions: [{ rule: "R1", verdict: "applies", reason: "r" }] })
              : replies[n - 1]!;
          return {
            content,
            model: "stub-model",
            provider: "anthropic",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      } as unknown as AIProvider;
      const [a4] = buildGoverningArms(["A4"], { model: "m", topK: 2 });
      const out = await a4!.assess(item(), corpus, { provider });
      expect(out.judgements.map((j) => j.ruleId)).toEqual(["DR-06"]);
      expect(out.answered).toEqual({ judgements: [], error: "provider down at the findings call" });
    });

    it("judges an answered rule applicability already applies with the answer, without a settle", async () => {
      const { provider, calls } = stubProvider([
        compliantReply("the legal team has asked us to preserve? No."),
      ]);
      const applicabilityRules = corpusApplicabilityRules(corpus);
      const res = await replayAnswers({
        item: item(),
        corpus,
        decisions: [
          {
            ruleId: "DR-06",
            controlId: "DR-06",
            verdict: "applies",
            reason: "r",
            foundBy: ["screen"],
          },
          {
            ruleId: "DR-01",
            controlId: "DR-01",
            verdict: "applies",
            reason: "r",
            foundBy: ["top-k"],
          },
        ],
        applicabilityRules,
        findingRules: corpusFindingRules(corpus),
        provider,
      });
      // One findings call, over the answered rule only: DR-01 has no answer to replay.
      expect(calls).toHaveLength(1);
      const prompt = String(calls[0]!.messages[0]!.content);
      expect(prompt).toContain("Their answer: No.");
      expect(prompt).toContain("[DR-06]");
      expect(prompt).not.toContain("[DR-01]");
      expect(res.answered.judgements.map((j) => [j.ruleId, j.verdict])).toEqual([
        ["DR-06", "compliant"],
      ]);
      expect(res.diagnostics).toEqual({
        answersReplayed: 1,
        answersSettled: 0,
        answeredNoEvidenceDemoted: 0,
      });
    });

    it("replays nothing an arm did not find: a rule applicability dropped is a miss", async () => {
      const { provider, calls } = stubProvider(["{}"]);
      const res = await replayAnswers({
        item: item(),
        corpus,
        decisions: [
          {
            ruleId: "DR-06",
            controlId: "DR-06",
            verdict: "does-not-apply",
            reason: "r",
            foundBy: ["top-k"],
          },
        ],
        applicabilityRules: corpusApplicabilityRules(corpus),
        findingRules: corpusFindingRules(corpus),
        provider,
      });
      expect(calls).toHaveLength(0);
      expect(res.answered).toEqual({ judgements: [] });
    });
  });

  it("readFindings: a dropped citation is no citation", () => {
    const rule = [...corpusFindingRules(corpus).values()][0]!;
    expect(
      readFindings({
        findings: [
          {
            requirementId: "GR-01",
            rule,
            status: "needs-ba-input",
            reasoning: "r",
            citation: null,
            citationDropped: true,
            modelStatus: "gap",
            businessQuestion: "q?",
          },
        ],
      }).judgements,
    ).toEqual([{ ruleId: rule.id, verdict: "needs-ba-input", businessFact: "q?" }]);
  });
});

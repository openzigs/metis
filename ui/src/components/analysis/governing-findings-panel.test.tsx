/**
 * #1876 — the analysis view's governing findings panel.
 *
 * `fetch` is replaced by an in-memory fake of the #1874 routes, with the
 * server's envelopes and status codes: a decision is stored, with the session
 * user as the decider, and read back by the next GET. A "reload" unmounts the
 * panel and mounts it again over a fresh QueryClient, so what it then shows
 * came from the fake server's store, never from the first mount's cache or an
 * optimistic update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  findForbiddenComplianceClaims,
  governingSummarySentence,
  type GoverningAnalysisApplicability,
  type GoverningFinding,
} from "@metis/shared";
import { createQueryClient } from "@/lib/query-client";
import type { ClarificationStatePayload, ClarifyingQuestion } from "@/lib/analysis-api";
import type { GoverningFindingRevision } from "@/lib/governing-findings-api";
import {
  CLARIFYING_QUESTIONS_ANCHOR,
  GOVERNING_REFRESH_POLL_MS,
  GoverningFindingsPanel,
  clarifyQuestionAnchor,
  clarifyingQuestionHref,
  governingSummarySentences,
  groupFindingsByRequirement,
} from "./governing-findings-panel";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PROJECT = "proj-1";
const ANALYSIS = "ana-1";
const SESSION_USER = { id: "u-ada", name: "Ada Lovelace" };
const REQ_TEXT = "Saved cards keep only the last four digits of the card number.";

const AT = "2026-11-08T00:00:00.000Z";

function finding(over: Partial<GoverningFinding>): GoverningFinding {
  return {
    id: "gf-x",
    analysisId: ANALYSIS,
    requirementId: "REQ-001",
    ruleId: "rule-x",
    revisionId: "rev-1",
    revisionLabel: "v3",
    documentTitle: "Information Handling Policy",
    controlId: "X-1",
    clauseRef: "§1",
    status: "gap",
    reasoning: "Not covered.",
    clauseStart: 0,
    clauseEnd: 10,
    clauseExcerpt: "Some clause.",
    citationDropped: false,
    modelStatus: null,
    businessQuestion: null,
    decision: null,
    decisionNote: null,
    decidedById: null,
    decidedByName: null,
    decidedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

/** One finding of each status, all on one requirement. */
function fixtureFindings(): GoverningFinding[] {
  return [
    finding({
      id: "gf-card",
      ruleId: "rule-card",
      controlId: "EN-03",
      clauseRef: "§4.3",
      status: "compliant",
      // Model prose that slipped a claim past the server's own pass.
      reasoning: "Only the last four digits are kept, so this is SOC 2 compliant.",
      clauseExcerpt: "never stores a full payment card number in any system",
    }),
    finding({
      id: "gf-retain",
      ruleId: "rule-retain",
      controlId: "RT-01",
      clauseRef: "§6.1",
      status: "gap",
      reasoning: "The requirement keeps card data with no retention limit.",
      clauseExcerpt: "Card data is deleted within 90 days of the last transaction.",
    }),
    finding({
      id: "gf-audit",
      ruleId: "rule-audit",
      controlId: "AL-02",
      clauseRef: "§5.1",
      status: "needs-ba-input",
      reasoning: "Whether exports happen decides this.",
      clauseExcerpt: "Every bulk export of customer records is written to the audit log.",
      businessQuestion: "Will anyone export the saved cards in bulk?",
    }),
  ];
}

const APPLICABILITY: GoverningAnalysisApplicability = {
  decidedAt: AT,
  requirements: [{ requirementId: "REQ-001", text: REQ_TEXT, decisions: [] }],
};

function question(over: Partial<ClarifyingQuestion>): ClarifyingQuestion {
  return {
    id: "q-x",
    requirementId: "REQ-001",
    ambiguityField: "description",
    question: "?",
    context: "",
    ...over,
  };
}

/** The #1874 routes, the applicability route and the clarify read, kept across "reloads". */
class FakeServer {
  flagOn = true;
  failWith: number | null = null;
  findings: GoverningFinding[] = fixtureFindings();
  revisions: GoverningFindingRevision[] = [
    {
      revisionId: "rev-1",
      documentTitle: "Information Handling Policy",
      revisionLabel: "v3",
      rules: 40,
    },
  ];
  refreshing = false;
  clarification: ClarificationStatePayload | null = null;
  requests: { method: string; path: string; body: unknown }[] = [];

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify({ success: true, data }), { status });
    const err = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ success: false, error: { code, message } }), { status });

    const prefix = `/api/projects/${PROJECT}/analyses/${ANALYSIS}/`;
    if (!url.pathname.startsWith(prefix)) return err(404, "NOT_FOUND", "Not found");
    const rest = url.pathname.slice(prefix.length).split("/");
    if (rest[0] === "clarify" && method === "GET") {
      return json(200, { state: this.clarification });
    }
    if (!this.flagOn) return err(404, "NOT_FOUND", "Not found");
    if (this.failWith) return err(this.failWith, "INTERNAL", "Boom");
    if (rest[0] === "governing-applicability" && method === "GET") {
      return json(200, { applicability: APPLICABILITY });
    }
    if (rest[0] !== "governing-findings") return err(404, "NOT_FOUND", "Not found");
    if (rest.length === 1 && method === "GET") {
      return json(200, {
        findings: this.findings,
        summary: {},
        revisions: this.revisions,
        refreshing: this.refreshing,
      });
    }
    if (rest.length === 3 && rest[2] === "decision" && method === "POST") {
      const f = this.findings.find((x) => x.id === rest[1]);
      if (!f) return err(404, "NOT_FOUND", "Governing finding not found");
      const { decision, note } = body as { decision: "accepted" | "rejected"; note?: string };
      Object.assign(f, {
        decision,
        decisionNote: note ?? null,
        decidedById: SESSION_USER.id,
        decidedByName: SESSION_USER.name,
        decidedAt: AT,
      });
      return json(200, { finding: f });
    }
    return err(404, "NOT_FOUND", "Not found");
  };
}

let server: FakeServer;

function mount(canDecide = true): QueryClient {
  const qc = createQueryClient();
  const defaults = qc.getDefaultOptions();
  qc.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
  render(
    <QueryClientProvider client={qc}>
      <GoverningFindingsPanel projectId={PROJECT} analysisId={ANALYSIS} canDecide={canDecide} />
    </QueryClientProvider>,
  );
  return qc;
}

/** A page reload: nothing survives but the server's store. */
function reload(canDecide = true) {
  cleanup();
  return mount(canDecide);
}

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal("fetch", vi.fn(server.handle));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GoverningFindingsPanel (#1876)", () => {
  it("renders one finding of each status with a distinct accessible label, its control id, clause excerpt and revision", async () => {
    mount();
    const compliant = await screen.findByRole("article", { name: "EN-03: Compliant" });
    const gap = screen.getByRole("article", { name: "RT-01: Gap" });
    const needs = screen.getByRole("article", { name: "AL-02: Needs BA input" });

    for (const [article, control, status, clause] of [
      [compliant, "EN-03", "Status: Compliant", "never stores a full payment card number"],
      [gap, "RT-01", "Status: Gap", "Card data is deleted within 90 days"],
      [needs, "AL-02", "Status: Needs BA input", "Every bulk export of customer records"],
    ] as const) {
      const scope = within(article);
      expect(scope.getByText(control)).toBeInTheDocument();
      expect(article).toHaveTextContent(status);
      expect(scope.getByRole("blockquote")).toHaveTextContent(clause);
      expect(scope.getByText("Information Handling Policy v3")).toBeInTheDocument();
    }
    // Grouped under the requirement, which is named by its id and its text.
    const group = screen.getByRole("group", { name: "Governing rules for REQ-001" });
    expect(within(group).getAllByRole("article")).toHaveLength(3);
    expect(await within(group).findByText(REQ_TEXT)).toBeInTheDocument();
  });

  it("rejecting with a note shows the decision, note and decider after a reload — read back from the server", async () => {
    const user = userEvent.setup();
    mount();
    const gap = await screen.findByRole("article", { name: "RT-01: Gap" });
    await user.type(
      within(gap).getByLabelText("Note for RT-01 (optional)"),
      "Retention is handled by the vault.",
    );
    await user.click(within(gap).getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(server.requests).toContainEqual({
        method: "POST",
        path: `/api/projects/${PROJECT}/analyses/${ANALYSIS}/governing-findings/gf-retain/decision`,
        // The decider is the session user on the server: the body never names one.
        body: { decision: "rejected", note: "Retention is handled by the vault." },
      }),
    );

    reload();
    const after = await screen.findByRole("article", { name: "RT-01: Gap" });
    const decision = within(after).getByTestId("governing-finding-decision");
    expect(decision).toHaveTextContent("Rejected by Ada Lovelace");
    expect(within(decision).getByRole("blockquote", { name: "Decision note" })).toHaveTextContent(
      "Retention is handled by the vault.",
    );
    // The other findings were not decided.
    expect(
      within(screen.getByRole("article", { name: "EN-03: Compliant" })).queryByTestId(
        "governing-finding-decision",
      ),
    ).toBeNull();
  });

  it("#2032 — another BA's decision, read on a refetch, replaces an untouched note", async () => {
    const user = userEvent.setup();
    server.findings[1] = {
      ...server.findings[1]!,
      decision: "accepted",
      decisionNote: "Grace's first note.",
      decidedByName: "Grace",
    };
    const qc = mount();
    const gap = await screen.findByRole("article", { name: "RT-01: Gap" });
    const note = within(gap).getByLabelText("Note for RT-01 (optional)");
    expect(note).toHaveValue("Grace's first note.");

    // Grace decides again from her own session; this panel refetches.
    server.findings[1] = {
      ...server.findings[1]!,
      decision: "rejected",
      decisionNote: "Grace's second note.",
    };
    await act(async () => {
      await qc.invalidateQueries();
    });
    await waitFor(() => expect(note).toHaveValue("Grace's second note."));

    // Rejecting now sends her current note, not the copy seeded at mount.
    await user.click(within(gap).getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(server.requests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
        { decision: "rejected", note: "Grace's second note." },
      ]),
    );
  });

  it("#2032 — a note the BA is typing survives a refetch, and after their decision the server's copy shows", async () => {
    const user = userEvent.setup();
    const qc = mount();
    const gap = await screen.findByRole("article", { name: "RT-01: Gap" });
    const note = within(gap).getByLabelText("Note for RT-01 (optional)");
    await user.type(note, "Mine.");

    server.findings[1] = {
      ...server.findings[1]!,
      decision: "accepted",
      decisionNote: "Theirs.",
      decidedByName: "Grace",
    };
    await act(async () => {
      await qc.invalidateQueries();
    });
    await within(gap).findByText(/by Grace/);
    expect(note).toHaveValue("Mine.");

    await user.click(within(gap).getByRole("button", { name: "Reject" }));
    await within(gap).findByText(/by Ada Lovelace/);
    expect(note).toHaveValue("Mine.");
    // No longer typed over: the next decision from elsewhere shows again.
    server.findings[1] = { ...server.findings[1]!, decisionNote: "Theirs again." };
    await act(async () => {
      await qc.invalidateQueries();
    });
    await waitFor(() => expect(note).toHaveValue("Theirs again."));
  });

  it("#2032 — two revisions whose sentences read the same are both shown, keyed by revision", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    server.findings = [
      finding({ id: "gf-a", ruleId: "rule-a", revisionId: "rev-1", status: "compliant" }),
      finding({ id: "gf-b", ruleId: "rule-b", revisionId: "rev-2", status: "compliant" }),
    ];
    server.revisions = [
      {
        revisionId: "rev-1",
        documentTitle: "Information Handling Policy",
        revisionLabel: "v3",
        rules: 5,
      },
      {
        revisionId: "rev-2",
        documentTitle: "Information Handling Policy",
        revisionLabel: "v3",
        rules: 5,
      },
    ];
    mount();
    expect(await screen.findAllByRole("article", { name: "X-1: Compliant" })).toHaveLength(2);
    const sentences = screen.getAllByTestId("governing-summary-sentence");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.textContent).toBe(sentences[1]!.textContent);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("an accept with no note sends no note, and the panel shows the server's state once it answers", async () => {
    const user = userEvent.setup();
    mount();
    const card = await screen.findByRole("article", { name: "EN-03: Compliant" });
    await user.click(within(card).getByRole("button", { name: "Accept" }));
    expect(await within(card).findByText(/by Ada Lovelace/)).toBeInTheDocument();
    expect(server.requests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      { decision: "accepted" },
    ]);
    expect(within(card).queryByRole("blockquote", { name: "Decision note" })).toBeNull();
  });

  it("a decision by a user who is gone still shows, without a name", async () => {
    server.findings[1] = {
      ...server.findings[1]!,
      decision: "accepted",
      decidedById: "u-gone",
      decidedByName: null,
      decidedAt: AT,
    };
    mount();
    const gap = await screen.findByRole("article", { name: "RT-01: Gap" });
    expect(within(gap).getByTestId("governing-finding-decision")).toHaveTextContent(
      "Accepted by a former user",
    );
  });

  it("without analysis.run the decisions are shown but no decision controls are", async () => {
    server.findings[0] = { ...server.findings[0]!, decision: "accepted", decidedByName: "Grace" };
    mount(false);
    const card = await screen.findByRole("article", { name: "EN-03: Compliant" });
    expect(within(card).getByTestId("governing-finding-decision")).toHaveTextContent(
      "Accepted by Grace",
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("a Needs BA input finding links to the clarifying question that settles its rule", async () => {
    server.clarification = {
      analysisId: ANALYSIS,
      currentRound: 2,
      maxRounds: 3,
      completed: false,
      escalatedToSonnet: false,
      resolvedAmbiguities: [],
      rounds: [
        {
          round: 1,
          answers: [],
          questions: [question({ id: "q-plain" })],
        },
        {
          round: 2,
          answers: [],
          questions: [
            question({
              id: "q-other-req",
              governing: { kind: "governing", ruleIds: ["rule-audit"], requirementId: "REQ-009" },
            }),
            question({
              id: "q-gov",
              requirementId: "governing:REQ-001",
              question: "Will anyone export the saved cards in bulk?",
              governing: {
                kind: "governing",
                ruleIds: ["rule-x", "rule-audit"],
                requirementId: "REQ-001",
              },
            }),
          ],
        },
      ],
    };
    mount();
    const needs = await screen.findByRole("article", { name: "AL-02: Needs BA input" });
    expect(within(needs).getByText(/Will anyone export the saved cards in bulk\?/)).toBeVisible();
    const link = within(needs).getByRole("link", { name: "Answer the clarifying question" });
    await waitFor(() => expect(link).toHaveAttribute("href", "#clarify-question-q-gov"));
    // Compliant and Gap findings wait on nobody.
    expect(
      within(screen.getByRole("article", { name: "RT-01: Gap" })).queryByRole("link"),
    ).toBeNull();
  });

  it("a Needs BA input finding with no matching question links to the Questions tab", async () => {
    mount();
    const needs = await screen.findByRole("article", { name: "AL-02: Needs BA input" });
    await waitFor(() =>
      expect(server.requests.some((r) => r.path.endsWith("/clarify"))).toBe(true),
    );
    expect(
      within(needs).getByRole("link", { name: "Answer the clarifying question" }),
    ).toHaveAttribute("href", CLARIFYING_QUESTIONS_ANCHOR);
  });

  it("the header is governingSummarySentence, and no rendered text claims compliance", async () => {
    mount();
    const panel = await screen.findByTestId("governing-findings");
    await screen.findByText(REQ_TEXT);
    expect(screen.getByTestId("governing-summary-sentence")).toHaveTextContent(
      governingSummarySentence({
        applicable: 3,
        total: 40,
        gaps: 1,
        needsInput: 1,
        documentTitle: "Information Handling Policy",
        revisionLabel: "v3",
      }),
    );
    expect(screen.getByTestId("governing-summary-sentence").textContent).toBe(
      "1 gap found against 3 of 40 applicable rules in Information Handling Policy v3; 1 rule needs BA input. Not an audit opinion.",
    );
    // innerText is not in jsdom; read each text node on its own so adjacent
    // elements cannot join into, or split, a phrase.
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.textContent ?? "");
    expect(texts.join(" ")).toContain("Only the last four digits are kept");
    expect(findForbiddenComplianceClaims(texts.join(" "))).toEqual([]);
    expect(findForbiddenComplianceClaims(panel.textContent ?? "")).toEqual([]);
  });

  it("renders nothing, and no error, when the route reports the feature off", async () => {
    server.flagOn = false;
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GoverningFindingsPanel projectId={PROJECT} analysisId={ANALYSIS} canDecide />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(server.requests.some((r) => r.path.endsWith("/governing-findings"))).toBe(true),
    );
    // Let the 404 settle into the query before asserting the panel stayed empty.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
    // With the flag off nothing else is asked for.
    expect(server.requests.map((r) => r.path)).toEqual([
      `/api/projects/${PROJECT}/analyses/${ANALYSIS}/governing-findings`,
    ]);
  });

  it("renders nothing when the analysis has no governing findings", async () => {
    server.findings = [];
    mount();
    await waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId("governing-findings")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failure other than the flag being off is said", async () => {
    server.failWith = 500;
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Governing findings could not be loaded.",
    );
  });

  it("a dropped citation is said in place of an excerpt", async () => {
    server.findings = [
      finding({
        id: "gf-drop",
        controlId: "AL-09",
        status: "needs-ba-input",
        clauseStart: null,
        clauseEnd: null,
        clauseExcerpt: null,
        citationDropped: true,
      }),
    ];
    mount();
    const article = await screen.findByRole("article", { name: "AL-09: Needs BA input" });
    expect(within(article).queryByRole("blockquote")).toBeNull();
    expect(article).toHaveTextContent("the citation was dropped");
  });

  it("while a BA answer's re-check runs it says so and reads again until it settles", async () => {
    server.refreshing = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("Re-checking after a BA answer");
    const reads = () =>
      server.requests.filter((r) => r.path.endsWith("/governing-findings")).length;
    const before = reads();
    server.refreshing = false;
    server.findings[1] = { ...server.findings[1]!, status: "compliant" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GOVERNING_REFRESH_POLL_MS);
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(reads()).toBeGreaterThan(before);
    expect(screen.getByRole("article", { name: "RT-01: Compliant" })).toBeInTheDocument();
  });
});

describe("governingSummarySentences", () => {
  it("one sentence per cited revision; a revision missing from the counts uses its cited rules", () => {
    const findings = [
      finding({ ruleId: "a", status: "compliant" }),
      finding({ ruleId: "a", requirementId: "REQ-002", status: "gap" }),
      finding({ ruleId: "b", status: "needs-ba-input" }),
      finding({ ruleId: "b", requirementId: "REQ-002", status: "needs-ba-input" }),
      finding({
        revisionId: "rev-9",
        documentTitle: "Retention Standard",
        revisionLabel: "v1",
        ruleId: "c",
        status: "compliant",
      }),
    ];
    expect(
      governingSummarySentences(findings, [
        {
          revisionId: "rev-1",
          documentTitle: "Information Handling Policy",
          revisionLabel: "v3",
          rules: 12,
        },
      ]),
    ).toEqual([
      {
        revisionId: "rev-1",
        sentence:
          "1 gap found against 2 of 12 applicable rules in Information Handling Policy v3; 1 rule needs BA input. Not an audit opinion.",
      },
      {
        revisionId: "rev-9",
        sentence:
          "No gaps found against 1 of 1 applicable rule in Retention Standard v1. Not an audit opinion.",
      },
    ]);
  });

  it("the rule count is never below the rules the findings cite", () => {
    expect(
      governingSummarySentences(
        [
          finding({ ruleId: "a", status: "compliant" }),
          finding({ ruleId: "b", status: "compliant" }),
        ],
        [{ revisionId: "rev-1", documentTitle: "P", revisionLabel: "v3", rules: 1 }],
      ),
    ).toEqual([
      {
        revisionId: "rev-1",
        sentence: "No gaps found against 2 of 2 applicable rules in P v3. Not an audit opinion.",
      },
    ]);
  });
});

describe("groupFindingsByRequirement", () => {
  it("groups in route order and names each requirement by its stored text when there is one", () => {
    const groups = groupFindingsByRequirement(
      [
        finding({ id: "1", requirementId: "REQ-001" }),
        finding({ id: "2", requirementId: "REQ-002" }),
        finding({ id: "3", requirementId: "REQ-001" }),
      ],
      APPLICABILITY,
    );
    expect(groups.map((g) => [g.requirementId, g.text, g.findings.map((f) => f.id)])).toEqual([
      ["REQ-001", REQ_TEXT, ["1", "3"]],
      ["REQ-002", null, ["2"]],
    ]);
    expect(groupFindingsByRequirement([finding({})], null)[0]!.text).toBeNull();
  });
});

describe("clarifyingQuestionHref", () => {
  const state = (rounds: ClarifyingQuestion[][]): ClarificationStatePayload => ({
    analysisId: ANALYSIS,
    currentRound: rounds.length,
    maxRounds: 3,
    completed: false,
    escalatedToSonnet: false,
    resolvedAmbiguities: [],
    rounds: rounds.map((questions, i) => ({ round: i + 1, answers: [], questions })),
  });
  const link = (id: string, ruleIds: string[], requirementId = "REQ-001") =>
    question({ id, governing: { kind: "governing", ruleIds, requirementId } });

  it("the latest round's question for this requirement and rule", () => {
    const s = state([[link("q-old", ["r1"])], [link("q-new", ["r0", "r1"])]]);
    expect(clarifyingQuestionHref({ requirementId: "REQ-001", ruleId: "r1" }, s)).toBe(
      clarifyQuestionAnchor("q-new"),
    );
  });

  it("#2032 — an earlier round's question is not rendered while a later round is open: the Questions tab", () => {
    const s = state([[link("q-old", ["r1"])], [link("q-other", ["r9"])]]);
    expect(clarifyingQuestionHref({ requirementId: "REQ-001", ruleId: "r1" }, s)).toBe(
      CLARIFYING_QUESTIONS_ANCHOR,
    );
  });

  it("#2032 — once complete, an answered question of any round is rendered; an unanswered one is not", () => {
    const answered = { ...link("q-old", ["r1"]), answer: "Yes, monthly." };
    const done = { ...state([[answered], [link("q-new", ["r2"])]]), completed: true };
    expect(clarifyingQuestionHref({ requirementId: "REQ-001", ruleId: "r1" }, done)).toBe(
      clarifyQuestionAnchor("q-old"),
    );
    // q-new was never answered, so the complete view does not show it.
    expect(clarifyingQuestionHref({ requirementId: "REQ-001", ruleId: "r2" }, done)).toBe(
      CLARIFYING_QUESTIONS_ANCHOR,
    );
  });

  it("#2059 — a question asked from a Needs BA input finding on a rule that applies: its anchor, read on the link, not the namespaced id", () => {
    // As the server builds it: `requirementId` is namespaced (#2009) and the
    // analysis's id travels on the governing link, which the finding carries.
    const asked = {
      ...link("q-finding", ["r-applies"]),
      requirementId: "governing:REQ-001",
    };
    expect(
      clarifyingQuestionHref({ requirementId: "REQ-001", ruleId: "r-applies" }, state([[asked]])),
    ).toBe(clarifyQuestionAnchor("q-finding"));
  });

  it("not a question for another requirement or another rule; none at all is the Questions tab", () => {
    const s = state([[link("q-a", ["r1"], "REQ-002"), link("q-b", ["r2"])]]);
    expect(clarifyingQuestionHref({ requirementId: "REQ-001", ruleId: "r1" }, s)).toBe(
      CLARIFYING_QUESTIONS_ANCHOR,
    );
    expect(clarifyingQuestionHref({ requirementId: "REQ-001", ruleId: "r1" }, null)).toBe(
      CLARIFYING_QUESTIONS_ANCHOR,
    );
  });
});

/**
 * #1762 — why each edit candidate was chosen, and "not found" said plainly.
 *
 * Rendered through `ChangedRequirementGroup`, the way the impact page renders
 * it, from an `ImpactItemView` whose `seedEvidence` the server recorded.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  IMPACT_SEED_CHANNELS,
  type ImpactAffectedSymbolView,
  type ImpactItemView,
  type ImpactSeedEvidence,
} from "@metis/shared";
import { ChangedRequirementGroup } from "./changed-requirement-group";
import { ImpactSymbolRepoContext } from "./impact-symbol-repo-context";
import { SEED_CHANNEL_LABEL, orderEditFiles } from "./edit-candidate-files";

const sym = (
  id: string,
  filePath: string,
  over: Partial<ImpactAffectedSymbolView> = {},
): ImpactAffectedSymbolView => ({
  id,
  codeSymbolId: `cs-${id}`,
  filePath,
  qualifiedName: `${filePath}::${id}`,
  startLine: 10,
  endLine: 20,
  relation: "direct",
  depth: 0,
  confidence: 0.9,
  ...over,
});

const NOTIFY = "src/orders/notify-repo.ts";
const ORDERS = "src/orders/orders.ts";
const MAILER = "src/mail/mailer.ts";
const MODEL = "src/model/order.ts";

function item(
  seedEvidence: ImpactSeedEvidence | undefined,
  symbols: ImpactAffectedSymbolView[],
): ImpactItemView {
  return {
    id: "it-1",
    projectId: "p1",
    requirementId: "r1",
    requirementTitle: "Send a receipt when an order is paid",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.5,
    confidence: 0.7,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: 3,
    affectedSymbolCount: symbols.length,
    summary: null,
    ...(seedEvidence ? { seedEvidence } : {}),
    affectedSymbols: symbols,
    affectedTests: [],
    writePathGaps: [],
    editCandidateFiles: [],
    blastRadiusFiles: [],
    droppedColumnProposals: [],
    optionalColumnProposals: [],
    uncheckedColumnProposals: [],
    affectedTables: [],
    affectedTablesSecondary: [],
    feedback: [],
  };
}

const SYMBOLS = [
  // Highest confidence first in the old sort: ORDERS, then NOTIFY, then MAILER.
  sym("o1", ORDERS, { confidence: 1 }),
  sym("n1", NOTIFY, { confidence: 0.7, startLine: 5, endLine: 30 }),
  sym("m1", MAILER, { confidence: 0.5 }),
  sym("r1", "src/api/routes.ts", { relation: "caller", depth: 1, confidence: 0.4 }),
];

const EVIDENCE: ImpactSeedEvidence = {
  verifier: { promoted: 1, doubtful: 1, droppedPromotions: 0 },
  editCandidates: [
    {
      filePath: NOTIFY,
      channels: ["code-agent"],
    },
    {
      filePath: MAILER,
      channels: ["edit-verifier"],
      baseScore: 0.4,
      verdict: {
        kind: "promoted",
        reason: "Sends the receipt email when an order is paid",
        line: 11,
        verified: true,
      },
    },
    {
      filePath: ORDERS,
      channels: ["hybrid", "stored-link"],
      baseScore: 1,
      verdict: { kind: "doubtful", reason: "Lists orders; sends nothing" },
    },
  ],
};

const REPO = { origin: "https://github.com", owner: "acme", repo: "shop", ref: "abc1234" };

function renderGroup(i: ImpactItemView, projectName?: string) {
  return render(
    <ImpactSymbolRepoContext.Provider value={{ p1: REPO }}>
      <ChangedRequirementGroup item={i} projectName={projectName} />
    </ImpactSymbolRepoContext.Provider>,
  );
}

const fileGroups = () => screen.getAllByTestId("edit-candidate-file-group");
const pathOf = (el: HTMLElement) => el.querySelector("p.font-mono")?.textContent;

describe("EditCandidateFiles (#1762)", () => {
  it("lists the files in the server's edit order, not by confidence", () => {
    renderGroup(item(EVIDENCE, SYMBOLS));
    expect(fileGroups().map(pathOf)).toEqual([NOTIFY, MAILER, ORDERS]);
  });

  it("shows Found by for every file, in business wording", () => {
    renderGroup(item(EVIDENCE, SYMBOLS));
    const [notify, mailer, orders] = fileGroups();
    expect(within(notify!).getByTestId("edit-candidate-found-by").textContent).toBe(
      "Found by:Code agent",
    );
    expect(within(mailer!).getByTestId("edit-candidate-found-by").textContent).toBe(
      "Found by:AI edit check",
    );
    expect(within(orders!).getByTestId("edit-candidate-found-by").textContent).toBe(
      "Found by:Keyword and meaning search, Linked to this requirement",
    );
    // No channel id leaks into the page.
    expect(document.body.textContent).not.toMatch(/stored-link|edit-verifier|code-agent|hybrid/);
  });

  it("shows Why and a linked code line only for a verified promotion", () => {
    renderGroup(item(EVIDENCE, SYMBOLS));
    const [notify, mailer, orders] = fileGroups();
    expect(within(mailer!).getByTestId("edit-candidate-why").textContent).toBe(
      "Why:Sends the receipt email when an order is paid",
    );
    const link = within(mailer!).getByTestId("edit-candidate-code-link");
    expect(link.textContent).toBe("mailer.ts:11");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/shop/blob/abc1234/src/mail/mailer.ts#L11",
    );
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // Unverified files carry no reason shown as fact.
    expect(within(notify!).queryByTestId("edit-candidate-why")).toBeNull();
    expect(within(orders!).queryByTestId("edit-candidate-why")).toBeNull();
    expect(within(orders!).queryByTestId("edit-candidate-code")).toBeNull();
  });

  it("never shows a reason as fact when the promotion is not marked verified", () => {
    const unverified = {
      ...EVIDENCE,
      editCandidates: [
        {
          filePath: MAILER,
          channels: ["edit-verifier" as const],
          verdict: { kind: "promoted", reason: "Trust me", line: 3, verified: false },
        },
      ],
    } as unknown as ImpactSeedEvidence;
    renderGroup(item(unverified, SYMBOLS));
    expect(screen.queryByTestId("edit-candidate-why")).toBeNull();
    expect(screen.queryByText(/Trust me/)).toBeNull();
  });

  it("names the code line without a link when the project has no linkable repo", () => {
    render(<ChangedRequirementGroup item={item(EVIDENCE, SYMBOLS)} />);
    const mailer = fileGroups()[1]!;
    expect(within(mailer).getByTestId("edit-candidate-code").textContent).toBe("Code:mailer.ts:11");
    expect(within(mailer).queryByTestId("edit-candidate-code-link")).toBeNull();
  });

  it("keeps a doubtful file visible, badged, with the AI check's doubt", () => {
    renderGroup(item(EVIDENCE, SYMBOLS));
    const orders = fileGroups()[2]!;
    expect(orders.getAttribute("data-doubtful")).toBe("true");
    expect(within(orders).getByTestId("edit-candidate-doubtful").textContent).toBe("Doubtful");
    expect(within(orders).getByTestId("edit-candidate-doubt").textContent).toBe(
      "The AI check doubts it:Lists orders; sends nothing",
    );
    // Its symbols are still listed.
    expect(within(orders).getAllByTestId("affected-symbol-row")).toHaveLength(1);
    // A doubtful file is not counted as a file to edit.
    expect(screen.getByTestId("impact-headline").textContent).toMatch(/^2 files to edit/);
  });

  it('says "not found", naming the project, when every candidate is doubtful', () => {
    const allDoubtful: ImpactSeedEvidence = {
      editCandidates: [
        {
          filePath: ORDERS,
          channels: ["hybrid"],
          verdict: { kind: "doubtful", reason: "Lists orders; sends nothing" },
        },
      ],
    };
    renderGroup(item(allDoubtful, [sym("o1", ORDERS), SYMBOLS[3]!]), "Shop backend");
    const notFound = screen.getByTestId("edit-candidates-not-found");
    expect(notFound.textContent).toBe(
      "METIS could not find the code this change touches in Shop backend. The files below were considered, but the AI check doubts them.",
    );
    expect(notFound.getAttribute("role")).toBe("status");
    // The doubtful file is still shown, labelled.
    expect(fileGroups().map(pathOf)).toEqual([ORDERS]);
    expect(screen.getByTestId("edit-candidate-doubtful")).toBeInTheDocument();
    expect(screen.queryByText(/most likely has to touch/)).toBeNull();
    expect(screen.getByTestId("impact-headline").textContent).toMatch(/^0 files to edit/);
  });

  it('says "not found" when the result has no edit candidates, without listing the blast radius as one', () => {
    renderGroup(item({ editCandidates: [] }, [SYMBOLS[3]!]));
    expect(screen.getByTestId("edit-candidates-not-found").textContent).toBe(
      "METIS could not find the code this change touches in this project.",
    );
    expect(screen.queryAllByTestId("edit-candidate-file-group")).toHaveLength(0);
    // The blast radius stays under its own heading.
    expect(screen.getByTestId("blast-radius-impacts")).toBeInTheDocument();
  });

  it("puts an edit file the evidence does not list after the listed ones, named by what put it there", () => {
    const symbols = [...SYMBOLS, sym("md", MODEL, { relation: "data-model", confidence: 0.95 })];
    renderGroup(item(EVIDENCE, symbols));
    expect(fileGroups().map(pathOf)).toEqual([NOTIFY, MAILER, ORDERS, MODEL]);
    expect(within(fileGroups()[3]!).getByTestId("edit-candidate-found-by").textContent).toBe(
      "Found by:Table definition",
    );
  });
});

describe("orderEditFiles (#1762)", () => {
  it("names a lineage writer, and leaves a file with no known source unlabelled", () => {
    const rows = orderEditFiles(
      [
        { filePath: "w.go", symbols: [sym("w", "w.go", { relation: "data-writer" })] },
        { filePath: "x.go", symbols: [sym("x", "x.go")] },
      ],
      { editCandidates: [] },
    );
    expect(rows.map((r) => [r.filePath, r.foundBy])).toEqual([
      ["w.go", ["Data lineage"]],
      ["x.go", []],
    ]);
  });

  it("has business wording for every channel the server can send", () => {
    for (const channel of IMPACT_SEED_CHANNELS) {
      expect(SEED_CHANNEL_LABEL[channel]).toMatch(/^[A-Z]/);
      expect(SEED_CHANNEL_LABEL[channel]).not.toContain("-");
    }
  });
});

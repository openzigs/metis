/**
 * #1965 — multi-repo impact results.
 *
 * A project can connect several repositories, and the same path can exist in
 * more than one (the live check: `src/types/order.ts` in both orders and
 * billing). Keyed by path alone, the two files merged under one heading, were
 * counted once, and no row said which repository it was in. Rendered through
 * `ChangedRequirementGroup`, the way the impact page renders it.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ImpactAffectedSymbolView, ImpactItemView, ImpactSeedEvidence } from "@metis/shared";
import { ChangedRequirementGroup } from "./changed-requirement-group";
import { ImpactMultiRepoProjectsContext } from "./impact-symbol-repo-context";

const ORDERS = { id: "rc-orders", name: "metis-fixture-orders" };
const BILLING = { id: "rc-billing", name: "metis-fixture-billing" };
const SHARED = "src/types/order.ts";

let n = 0;
const sym = (
  filePath: string,
  repo: ImpactAffectedSymbolView["repo"],
  depth: number,
  name = `sym${++n}`,
): ImpactAffectedSymbolView => ({
  id: `s-${++n}`,
  codeSymbolId: `cs-${n}`,
  filePath,
  qualifiedName: `${filePath}::${name}`,
  startLine: 8,
  endLine: 13,
  relation: depth === 0 ? "direct" : "caller",
  depth,
  confidence: 0.8,
  repo,
});

function item(
  affectedSymbols: ImpactAffectedSymbolView[],
  over: Partial<ImpactItemView> = {},
): ImpactItemView {
  return {
    id: "it-1965",
    projectId: "p1",
    requirementId: null,
    requirementTitle: "Add a currency to the order-created event",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.5,
    confidence: 0.7,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: 0,
    affectedSymbolCount: affectedSymbols.length,
    summary: null,
    affectedSymbols,
    affectedTests: [],
    editCandidateFiles: [],
    blastRadiusFiles: [],
    writePathGaps: [],
    affectedTables: [],
    affectedTablesSecondary: [],
    droppedColumnProposals: [],
    optionalColumnProposals: [],
    uncheckedColumnProposals: [],
    feedback: [],
    ...over,
  };
}

/** Each file group's repository label (or null) and path, in render order. */
function fileRows(container: HTMLElement, testId: string) {
  return within(container)
    .getAllByTestId(testId)
    .map((g) => {
      const heading = g.querySelector("p")!.cloneNode(true) as HTMLElement;
      const repo = heading.querySelector("[data-testid=impact-file-repo]");
      repo?.remove();
      // The heading is "<repo>path · <count>" in the blast radius and tests.
      return { repo: repo?.textContent ?? null, path: heading.textContent!.replace(/ · \d+$/, "") };
    });
}

// The live check: the same two types in orders AND billing, plus a caller in each.
const twoRepos = item([
  sym(SHARED, ORDERS, 0, "OrderCreatedEvent"),
  sym(SHARED, BILLING, 0, "OrderCreatedEvent"),
  sym(SHARED, ORDERS, 0, "Order"),
  sym(SHARED, BILLING, 0, "Order"),
  sym(SHARED, ORDERS, 1, "toEvent"),
  sym(SHARED, BILLING, 1, "toEvent"),
  sym("src/api/orders.ts", ORDERS, 1),
]);

describe("ChangedRequirementGroup — files in several repositories (#1965)", () => {
  it("lists a same-path file once per repository under Files to edit, each naming its repo", () => {
    render(<ChangedRequirementGroup item={twoRepos} />);
    const edit = screen.getByTestId("edit-candidates");
    expect(fileRows(edit, "edit-candidate-file-group")).toEqual([
      { repo: "metis-fixture-orders", path: SHARED },
      { repo: "metis-fixture-billing", path: SHARED },
    ]);
    const [orders, billing] = within(edit).getAllByTestId("edit-candidate-file-group");
    expect(within(orders!).getAllByTestId("affected-symbol-row")).toHaveLength(2);
    expect(within(billing!).getAllByTestId("affected-symbol-row")).toHaveLength(2);
  });

  it("keeps them apart in the blast radius too", () => {
    render(<ChangedRequirementGroup item={twoRepos} />);
    const radius = screen.getByTestId("blast-radius-impacts");
    expect(fileRows(radius, "blast-radius-file-group")).toEqual([
      { repo: "metis-fixture-orders", path: SHARED },
      { repo: "metis-fixture-billing", path: SHARED },
      { repo: "metis-fixture-orders", path: "src/api/orders.ts" },
    ]);
  });

  it("counts same-path files in different repositories separately", () => {
    render(<ChangedRequirementGroup item={twoRepos} />);
    expect(screen.getByTestId("impact-headline").textContent).toBe(
      "2 files to edit · 1 more to review",
    );
    expect(screen.getByTestId("blast-radius-toggle").textContent).toMatch(
      /3 symbols across 3 files to review, 2 of them also files to edit/,
    );
  });

  it("names the repo when the project has several, even if this item touches one", () => {
    render(
      <ImpactMultiRepoProjectsContext.Provider value={{ p1: true }}>
        <ChangedRequirementGroup item={item([sym(SHARED, ORDERS, 0)])} />
      </ImpactMultiRepoProjectsContext.Provider>,
    );
    expect(fileRows(screen.getByTestId("edit-candidates"), "edit-candidate-file-group")).toEqual([
      { repo: "metis-fixture-orders", path: SHARED },
    ]);
  });

  it("names no repo in a single-repository project", () => {
    render(
      <ImpactMultiRepoProjectsContext.Provider value={{ p1: false }}>
        <ChangedRequirementGroup item={item([sym(SHARED, ORDERS, 0), sym("a.ts", ORDERS, 1)])} />
      </ImpactMultiRepoProjectsContext.Provider>,
    );
    expect(screen.queryByTestId("impact-file-repo")).not.toBeInTheDocument();
  });

  it("says nothing about overlap when no reviewed file is also a file to edit", () => {
    render(<ChangedRequirementGroup item={item([sym("a.ts", null, 0), sym("b.ts", null, 1)])} />);
    expect(screen.getByTestId("blast-radius-toggle").textContent).toMatch(
      /1 symbols across 1 files to review \(/,
    );
  });

  it("groups the impacted tests by repository as well", () => {
    render(
      <ChangedRequirementGroup
        item={item([sym(SHARED, ORDERS, 0)], {
          affectedTests: [
            sym("test/order.test.ts", ORDERS, 1),
            sym("test/order.test.ts", BILLING, 1),
          ],
        })}
      />,
    );
    expect(screen.getByTestId("affected-tests-toggle").textContent).toMatch(/across 2 files/);
    expect(fileRows(screen.getByTestId("affected-tests"), "affected-tests-file-group")).toEqual([
      { repo: "metis-fixture-orders", path: "test/order.test.ts" },
      { repo: "metis-fixture-billing", path: "test/order.test.ts" },
    ]);
  });

  it("with seed evidence: one row per repository, each counted, each naming its repo", () => {
    const evidence: ImpactSeedEvidence = {
      editCandidates: [{ filePath: SHARED, channels: ["hybrid"] }],
    };
    render(
      <ChangedRequirementGroup item={item(twoRepos.affectedSymbols, { seedEvidence: evidence })} />,
    );
    const edit = screen.getByTestId("edit-candidates");
    expect(fileRows(edit, "edit-candidate-file-group")).toEqual([
      { repo: "metis-fixture-orders", path: SHARED },
      { repo: "metis-fixture-billing", path: SHARED },
    ]);
    expect(screen.getByTestId("impact-headline").textContent).toBe(
      "2 files to edit · 1 more to review",
    );
  });
});

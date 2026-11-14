/**
 * #1762 — with every lever flag off the server returns no `seedEvidence`, and
 * the impact card must render exactly as it did before the "why" panel. The
 * snapshot was recorded against the component BEFORE #1762 changed it, then
 * replayed against the changed one.
 *
 * #2302 re-recorded it: the one difference is the tier badge on each symbol.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ImpactAffectedSymbolView, ImpactItemView } from "@metis/shared";
import { ChangedRequirementGroup } from "./changed-requirement-group";

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

const ITEM: ImpactItemView = {
  id: "it-1",
  projectId: "p1",
  requirementId: "r1",
  requirementTitle: "Mark entries older than X as read",
  changeType: "modified",
  severity: "medium",
  impactScore: 0.5,
  confidence: 0.7,
  matchQuality: "strong",
  matchQualityReason: null,
  affectedFileCount: 4,
  affectedSymbolCount: 5,
  summary: null,
  affectedSymbols: [
    sym("a", "internal/storage/entry.go", { confidence: 0.6 }),
    sym("b", "internal/ui/entry_mark.go", { confidence: 1 }),
    sym("c", "internal/ui/entry_mark.go", { confidence: 0.8 }),
    sym("d", "internal/api/entry.go", { relation: "caller", depth: 1, confidence: 0.5 }),
    sym("e", "internal/model/entry.go", { relation: "data-model", depth: 0, confidence: 0.4 }),
  ],
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

describe("ChangedRequirementGroup with no seed evidence (#1762)", () => {
  it("renders exactly as before the why panel", () => {
    const { container } = render(<ChangedRequirementGroup item={ITEM} />);
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("renders exactly as before when given a project name", () => {
    const { container } = render(<ChangedRequirementGroup item={ITEM} projectName="Reader" />);
    expect(container.innerHTML).toMatchSnapshot();
  });
});

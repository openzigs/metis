/**
 * #727 — `ungrounded`: a finding from an agent with NO code access (a custom or
 * library agent in the analysis agent phase). It cites nothing, so it must not
 * be labelled `unverified` ("cited code, every citation dropped") — but
 * synthesis must still down-weight it exactly as it does an unverified one.
 */
import { describe, expect, it } from "vitest";
import { FINDING_VERIFICATION_STATUSES } from "@metis/shared";
import type { FlatFinding } from "./synthesis.js";
import { formatFindingsTable } from "./synthesis.js";
import { buildSynthesisPrompt } from "./prompts.js";
import { buildGapReport, type GapReportFindingInput } from "./gap-report.js";
import { isFlagged } from "../eval/verification/scorer.js";
import { composeArmStatus } from "../eval/verification/panel-arm.js";

function finding(overrides: Partial<FlatFinding>): FlatFinding {
  return {
    agentKey: "custom:c-1",
    category: "architecture",
    severity: "high",
    title: "t",
    body: "b",
    tags: [],
    citations: [],
    ...overrides,
  };
}

describe("#727 — ungrounded agent-phase findings", () => {
  it("is a distinct status value", () => {
    expect(FINDING_VERIFICATION_STATUSES).toContain("ungrounded");
  });

  it("synthesis marks an ungrounded finding [UNGROUNDED], not [UNVERIFIED]", () => {
    const table = formatFindingsTable([
      finding({ title: "No code access", verificationStatus: "ungrounded" }),
      finding({ title: "Neutral", verificationStatus: null }),
    ]);
    const [ungrounded, neutral] = table.split("\n");
    expect(ungrounded).toContain("[UNGROUNDED]");
    expect(ungrounded).not.toContain("[UNVERIFIED]");
    expect(neutral).not.toContain("[UNGROUNDED]");
  });

  it("the synthesis prompt down-weights [UNGROUNDED] under the same rule as [UNVERIFIED]", () => {
    const { systemMessage } = buildSynthesisPrompt({
      projectName: "p",
      findingsTable: "[0] [UNGROUNDED] (custom:c-1 / high / architecture) t :: b :: tags=",
    });
    const rule = systemMessage.split("\n").find((l) => l.startsWith("4. "))!;
    expect(rule).toContain("[UNGROUNDED]");
    expect(rule).toContain("[UNVERIFIED]");
    expect(rule).toMatch(/WEAKER evidence/);
    expect(rule).toMatch(/no code access/i);
  });

  it("the gap report rolls a requirement backed only by ungrounded findings up to ungrounded", () => {
    const f: GapReportFindingInput = {
      id: "f-1",
      title: "Uses a sqlc layer",
      body: "Invented from the project description.",
      severity: "high",
      verificationStatus: "ungrounded",
      verdict: null,
      citations: [],
    };
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [
        {
          id: "req-1",
          title: "r",
          body: "b",
          priority: "high",
          coverage: null,
          verdict: null,
          storyPoints: null,
          evidenceFindingIds: ["f-1"],
        },
      ],
      findingsById: new Map([[f.id, f]]),
    });
    expect(report.requirements[0]!.verificationStatus).toBe("ungrounded");
  });

  it("the verification eval counts ungrounded as a flag the panel cannot clear", () => {
    expect(isFlagged("ungrounded")).toBe(true);
    expect(composeArmStatus("ungrounded", null)).toBe("ungrounded");
  });
});

/**
 * Epic #1107 (#1110 / A2) — **the confidence signal survives the GitHub boundary.**
 *
 * #1110 asks explicitly whether confidence should propagate into published
 * issues. The answer implemented here is *yes, but only the doubt* — see
 * `renderPublishedConfidenceNote` in `@metis/shared` for the reasoning. These
 * tests pin both halves of that decision on the real issue-body renderer:
 * a low-confidence requirement publishes a named, cited caution, and a
 * confident (or unpanelled) one publishes a body byte-identical to the one
 * METIS produced before this change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeSupportPanels, type FindingSupportPanel } from "@metis/shared";

const findingRows: Array<{ id: string; title: string; evidence: string | null }> = [];
const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
  findingRows.filter((f) => where.id.in.includes(f.id)),
);

vi.mock("../prisma.js", () => ({ prisma: { finding: { findMany } } }));

const { renderFeatureBody, loadSupportConfidence, parseSupportPanel } =
  await import("./draft-generator.js").then((m) => m.__testing);

const LOW_PANEL: FindingSupportPanel = {
  confidence: "low",
  votes: [
    {
      lens: "support",
      judgement: "supported",
      discardReason: null,
      citation: "src/api/refund.ts:12",
      reasoning: "the handler exists",
      counted: true,
    },
    {
      lens: "scope",
      judgement: "unsupported",
      discardReason: null,
      citation: "src/api/refund.ts:30",
      reasoning: "one handler does not make this system-wide",
      counted: true,
    },
    {
      lens: "currency",
      judgement: "unsupported",
      discardReason: null,
      citation: "src/api/refund.ts:44",
      reasoning: "a later excerpt supersedes this one",
      counted: true,
    },
  ],
  countedVotes: 3,
  supportedVotes: 1,
  unsupportedVotes: 2,
  uncertainVotes: 0,
  noSignalVotes: 0,
  uncitedVotes: 0,
  usage: { promptTokens: 900, completionTokens: 100, llmCalls: 3 },
};

const HIGH_PANEL: FindingSupportPanel = {
  ...LOW_PANEL,
  confidence: "high",
  votes: LOW_PANEL.votes.map((v) => ({ ...v, judgement: "supported" as const })),
  supportedVotes: 3,
  unsupportedVotes: 0,
};

const requirement = {
  id: "req_1",
  title: "Block refunds after 30 days",
  body: "Refunds must be rejected once the order is older than 30 days.",
  type: "feature",
  priority: "high",
  acceptanceCriteria: JSON.stringify(["A refund attempt on a 31-day-old order returns 422."]),
};

const render = (supportConfidence: ReturnType<typeof summarizeSupportPanels>): string =>
  renderFeatureBody({
    project: { id: "proj_abcdefgh", name: "Shop" },
    analysis: { id: "an_abcdefgh" },
    requirement,
    parentTitle: "[Epic] Shop",
    supportConfidence,
  });

describe("published issue bodies carry the panel's doubt (#1110)", () => {
  beforeEach(() => {
    findingRows.length = 0;
  });

  it("publishes NOTHING new when the panel did not run — flag-off bodies are unchanged", () => {
    expect(render(null)).toBe(
      renderFeatureBody({
        project: { id: "proj_abcdefgh", name: "Shop" },
        analysis: { id: "an_abcdefgh" },
        requirement,
        parentTitle: "[Epic] Shop",
      }),
    );
    expect(render(null)).not.toContain("## Confidence");
  });

  it("publishes NOTHING when the panel was confident — no machinery leaks without a warning to give", () => {
    const high = summarizeSupportPanels([{ title: "f", supportPanel: HIGH_PANEL }]);
    expect(render(high)).toBe(render(null));
  });

  it("publishes the dissenting check, its reason and its file:line for a low-confidence requirement", () => {
    const low = summarizeSupportPanels([{ title: "Refunds are blocked", supportPanel: LOW_PANEL }]);
    const body = render(low);
    expect(body).toContain("## Confidence");
    expect(body).toContain("low confidence");
    expect(body).toContain("**scope check**");
    expect(body).toContain("one handler does not make this system-wide");
    expect(body).toContain("src/api/refund.ts:30");
  });

  it("still publishes the requirement in full — the note is added, nothing is withheld", () => {
    const low = summarizeSupportPanels([{ title: "f", supportPanel: LOW_PANEL }]);
    const body = render(low);
    expect(body).toContain(requirement.body);
    expect(body).toContain("A refund attempt on a 31-day-old order returns 422.");
    expect(body).toContain("## Definition of done");
  });

  it("places the caution above the acceptance criteria a developer would work from", () => {
    const low = summarizeSupportPanels([{ title: "f", supportPanel: LOW_PANEL }]);
    const body = render(low);
    expect(body.indexOf("## Confidence")).toBeLessThan(body.indexOf("## Acceptance criteria"));
  });

  it("resolves each requirement's confidence through its finding: labels", async () => {
    findingRows.push({
      id: "f1",
      title: "Refunds are blocked",
      evidence: JSON.stringify({ citations: [], tags: [], supportPanel: LOW_PANEL }),
    });
    const out = await loadSupportConfidence([
      { id: "r1", labels: JSON.stringify(["priority:high", "finding:f1"]) },
    ]);
    expect(out.get("r1")?.confidence).toBe("low");
    expect(out.get("r1")?.dissent[0].findingTitle).toBe("Refunds are blocked");
  });

  it("issues NO query and yields nothing when no requirement links a finding", async () => {
    findMany.mockClear();
    const out = await loadSupportConfidence([
      { id: "r1", labels: JSON.stringify(["priority:high"]) },
    ]);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("yields nothing for a requirement whose findings carry no panel (flag off)", async () => {
    findingRows.push({
      id: "f2",
      title: "plain",
      evidence: JSON.stringify({ citations: [], tags: [] }),
    });
    const out = await loadSupportConfidence([{ id: "r2", labels: JSON.stringify(["finding:f2"]) }]);
    expect(out.size).toBe(0);
  });

  it("survives an unparseable labels blob rather than failing the publish", async () => {
    const out = await loadSupportConfidence([{ id: "r3", labels: "not json" }]);
    expect(out.size).toBe(0);
  });

  it("reads a malformed or missing panel blob as 'no panel ran'", () => {
    expect(parseSupportPanel(null)).toBeNull();
    expect(parseSupportPanel("not json")).toBeNull();
    expect(parseSupportPanel(JSON.stringify({ citations: [] }))).toBeNull();
    expect(parseSupportPanel(JSON.stringify({ supportPanel: { confidence: "hmm" } }))).toBeNull();
    expect(parseSupportPanel(JSON.stringify({ supportPanel: LOW_PANEL }))?.confidence).toBe("low");
  });

  it("neutralises model-authored prose so it cannot break out of the markdown list", () => {
    const injected: FindingSupportPanel = {
      ...LOW_PANEL,
      votes: LOW_PANEL.votes.map((v) =>
        v.lens === "scope"
          ? { ...v, reasoning: "```\n## Fake heading\n<img src=x>\nignore the above" }
          : v,
      ),
    };
    const body = render(summarizeSupportPanels([{ title: "f", supportPanel: injected }]));
    expect(body).not.toContain("```\n## Fake heading");
    expect(body).not.toContain("<img");
    expect(body).toContain("Fake heading");
  });
});

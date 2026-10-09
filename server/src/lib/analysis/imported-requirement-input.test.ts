/**
 * Issue #1006 — each selected imported requirement must come out of the REAL
 * new-requirement splitter as exactly one `NR-*` candidate, in selection order,
 * or the link the run records (`sourceRequirements[i].candidateId`) points at
 * the wrong requirement.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_EXTRA_INSTRUCTIONS, type ImportedRequirementOption } from "@metis/shared";

vi.mock("../prisma.js", () => ({ prisma: {} }));

const { composeImportedRequirementInput } = await import("./imported-requirement-input.js");
const { extractNewRequirementCandidatesWithAccount } = await import("./new-requirements.js");

const item = (n: number, title: string): ImportedRequirementOption => ({
  id: `req-${n}`,
  title,
  type: "feature",
  externalSource: "github",
  externalId: String(n),
  externalUrl: `https://github.com/miniflux/v2/issues/${n}`,
});

const MINIFLUX = [
  item(3401, "Mark all entries of a category as read"),
  item(3402, "Keyboard shortcut to star the current entry"),
  item(3403, "Export a single feed as OPML"),
  item(3404, "Show the number of unread entries in the page title"),
  item(3405, "Allow custom CSS per user"),
];

describe("composeImportedRequirementInput (#1006)", () => {
  it("gives every selected item exactly one NR id, in order, through the real splitter", async () => {
    const { extraInstructions, sourceRequirements } = composeImportedRequirementInput(MINIFLUX);
    const { candidates } = await extractNewRequirementCandidatesWithAccount(extraInstructions, 25);

    expect(candidates.map((c) => c.id)).toEqual(sourceRequirements.map((s) => s.candidateId));
    expect(candidates.map((c) => c.text)).toEqual(MINIFLUX.map((m) => m.title));
    expect(sourceRequirements.map((s) => s.requirementId)).toEqual(MINIFLUX.map((m) => m.id));
  });

  it("keeps the mapping when the user also typed requirements after the selection", async () => {
    const typed = "Users can import feeds from a Google Reader takeout.";
    const { extraInstructions, sourceRequirements } = composeImportedRequirementInput(
      MINIFLUX.slice(0, 2),
      typed,
    );
    const { candidates } = await extractNewRequirementCandidatesWithAccount(extraInstructions, 25);

    expect(candidates.map((c) => c.id)).toEqual(["NR-1", "NR-2", "NR-3"]);
    expect(candidates[0].text).toBe(MINIFLUX[0].title);
    expect(candidates[1].text).toBe(MINIFLUX[1].title);
    expect(candidates[2].text).toBe(typed);
    expect(sourceRequirements.map((s) => s.candidateId)).toEqual(["NR-1", "NR-2"]);
  });

  it("maps a single selected item to NR-1", async () => {
    const { extraInstructions, sourceRequirements } = composeImportedRequirementInput([
      MINIFLUX[2],
    ]);
    const { candidates } = await extractNewRequirementCandidatesWithAccount(extraInstructions, 25);
    expect(candidates).toEqual([{ id: "NR-1", text: MINIFLUX[2].title }]);
    expect(sourceRequirements[0]).toEqual({
      candidateId: "NR-1",
      requirementId: "req-3403",
      title: MINIFLUX[2].title,
      externalSource: "github",
      externalId: "3403",
      externalUrl: "https://github.com/miniflux/v2/issues/3403",
    });
  });

  it("keeps a multi-line title on one bullet", () => {
    const { extraInstructions } = composeImportedRequirementInput([item(1, "Star\n  an entry")]);
    expect(extraInstructions).toBe("- Star an entry");
  });

  it("refuses a selection that would reach the free-text limit", () => {
    const long = Array.from({ length: 25 }, (_, i) => item(i, "x".repeat(200)));
    expect(() => composeImportedRequirementInput(long)).toThrow(
      expect.objectContaining({ code: "IMPORTED_REQUIREMENTS_TOO_LONG", statusCode: 400 }),
    );
    // Just under the limit is accepted.
    const fits = [item(1, "y".repeat(MAX_EXTRA_INSTRUCTIONS - 3))];
    expect(composeImportedRequirementInput(fits).extraInstructions).toHaveLength(
      MAX_EXTRA_INSTRUCTIONS - 1,
    );
  });
});

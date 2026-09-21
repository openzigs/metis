/**
 * Issue #1112 (Epic #1107) — INPUT-side coverage for the operator's free-text
 * "Evaluate new requirements" box.
 *
 * `RequirementCoverage` grades outputs. Nothing graded inputs, which is exactly
 * how #1101 happened: seven pasted requirements, six mapped, R7 sliced off by the
 * candidate cap, and the run reported success. These tests lock the account —
 * every parsed requirement ends up analyzed, merged (naming the survivor), or
 * dropped (naming why) — and the #1101 case itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_EXTRA_INSTRUCTIONS,
  isRequirementInputAccountBalanced,
  requirementInputExcerpt,
} from "@metis/shared";
import {
  buildRequirementInputAccount,
  extractNewRequirementCandidates,
  extractNewRequirementCandidatesWithAccount,
  mergeRequirementSets,
  mergeRequirementSetsWithAccount,
} from "./new-requirements.js";
import { __resetConfigSingleton } from "../config/config-service.js";

beforeEach(() => {
  delete process.env.ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES;
  __resetConfigSingleton();
});
afterEach(() => {
  delete process.env.ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES;
  __resetConfigSingleton();
});

/**
 * The #1101 paste: seven numbered requirements, each carrying its own
 * acceptance-criteria bullets.
 *
 * Until #1136 the block splitter counted every bullet, so this yielded 21 blocks,
 * the tail fell off the default cap of 8, and R7 vanished. The bullets are now
 * recognised as detail of the requirement above them, so the paste parses as the
 * seven requirements the user actually typed — see the #1136 block below.
 */
const SEVEN_REQUIREMENTS = Array.from({ length: 7 }, (_, i) => {
  const n = i + 1;
  return [
    `R${n}: The system must support feature number ${n}.`,
    "",
    `- Acceptance criteria for requirement ${n} part a.`,
    `- Acceptance criteria for requirement ${n} part b.`,
  ].join("\n");
}).join("\n\n");

/**
 * A paste that genuinely exceeds the cap — twelve distinct requirements, no
 * acceptance criteria to confuse the unit being counted. #1136 corrected the
 * population; it did NOT remove the cap, so the accounting below must still fire
 * for a submission that really does hold more requirements than the cap accepts.
 */
const TWELVE_REQUIREMENTS = Array.from(
  { length: 12 },
  (_, i) => `- The system must support feature number ${i + 1}.`,
).join("\n");

describe("extractNewRequirementCandidatesWithAccount — the #1101 cap slice", () => {
  it("reproduces #1101 and analyzes all seven (#1136 corrected the unit being counted)", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(SEVEN_REQUIREMENTS);

    // The bug was never that seven requirements exceed a cap of eight — it was
    // that the splitter turned seven into twenty-one. With bullets attributed to
    // their parent, the paste fits the cap with room to spare and nothing is lost.
    expect(extraction.parsedCount).toBe(7);
    expect(extraction.candidates).toHaveLength(7);
    expect(extraction.dropped).toEqual([]);
    expect(extraction.candidates.some((c) => c.text.includes("feature number 7"))).toBe(true);
    // The criteria still reach the agent, carried by the requirement they qualify.
    expect(extraction.candidates[6].text).toContain("requirement 7 part b.");
  });

  it("REPORTS the requirements the cap removed instead of truncating in silence", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(TWELVE_REQUIREMENTS);

    expect(extraction.parsedCount).toBe(12);
    expect(extraction.dropped.length).toBe(extraction.parsedCount - 8);
    expect(extraction.dropped.every((d) => d.reason === "candidate-cap")).toBe(true);
    // Every drop names the id it would have carried and quotes the user's words.
    for (const dropped of extraction.dropped) {
      expect(dropped.id).toMatch(/^NR-\d+$/);
      expect(dropped.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("R7 is either processed or reported — never silently absent (the #1101 assertion)", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(SEVEN_REQUIREMENTS);
    const account = buildRequirementInputAccount(
      extraction,
      mergeRequirementSetsWithAccount([], extraction.candidates),
    );

    const mentionsR7 = (text: string): boolean => text.includes("feature number 7");
    const processed = extraction.candidates.some((c) => mentionsR7(c.text));
    const reported = account.dropped.some((d) => mentionsR7(d.excerpt));

    expect(processed || reported).toBe(true);
    // Post-#1136 it is the PROCESSED branch that fires: R7 is analyzed, not merely
    // reported as lost. #1112's report remains the safety net, not the outcome.
    expect(processed).toBe(true);
    expect(reported).toBe(false);
    expect(account.analyzedIds).toHaveLength(7);
  });

  it("accounts for every parsed block exactly once", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(TWELVE_REQUIREMENTS);
    const account = buildRequirementInputAccount(
      extraction,
      mergeRequirementSetsWithAccount([], extraction.candidates),
    );

    expect(isRequirementInputAccountBalanced(account)).toBe(true);
    const ids = [
      ...account.analyzedIds,
      ...account.merged.map((m) => m.id),
      ...account.dropped.map((d) => d.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not raise the cap — the fix is the account, not a bigger number", async () => {
    // Deliberate: #1112 says a raised cap with silent truncation is the same bug
    // at a different number. The cap's default must stay where it was.
    const text = Array.from({ length: 12 }, (_, i) => `- Requirement number ${i}.`).join("\n");
    expect(await extractNewRequirementCandidates(text)).toHaveLength(8);
  });
});

/**
 * Issue #1136 — the walkthrough that exposed the real defect behind #1101.
 *
 * Ten requirements, each with three acceptance-criteria bullets, reported
 * `parsedCount: 40` and "6 of 40 requirements you supplied were analyzed". The
 * accounting was honest; the population it graded was inflated fourfold. These
 * assertions are on the ACCOUNT, because that is the number the user reads.
 */
describe("#1136 — acceptance criteria do not inflate the parsed population", () => {
  /** Ten genuinely distinct requirements so the de-dupe stage has nothing to fold. */
  const TEN_REQUIREMENTS: Array<[string, string, string, string]> = [
    [
      "Workspaces can be created by any signed-in user.",
      "The name field is required.",
      "Roles: owner, editor, viewer.",
      "Creation writes an audit event.",
    ],
    [
      "Documents can be published to a shared library.",
      "Publishing requires the editor role.",
      "A published document gets a permanent URL.",
      "Unpublishing leaves the URL resolving to a tombstone.",
    ],
    [
      "Search returns results ranked by relevance.",
      "Ranking blends lexical and vector scores.",
      "Results are paginated at twenty per page.",
      "An empty query returns no results, not an error.",
    ],
    [
      "The billing page shows spend for the current month.",
      "Spend is broken down per project.",
      "Figures refresh at most once an hour.",
      "Only admins may view billing.",
    ],
    [
      "Users may export their data as CSV.",
      "Exports run in the background.",
      "The download link expires after seven days.",
      "Each export is recorded in the audit log.",
    ],
    [
      "Chat responses must cite the sources they used.",
      "Citations link to the exact document section.",
      "A response with no source says so explicitly.",
      "Citation rendering degrades gracefully offline.",
    ],
    [
      "Order history is retained for seven years.",
      "Retention is enforced by a nightly job.",
      "Deleted orders are soft-deleted, never purged early.",
      "Retention policy is configurable per tenant.",
    ],
    [
      "Sign-in supports single sign-on via OIDC.",
      "Group membership maps to application roles.",
      "An unmapped group grants no access at all.",
      "Failed sign-ins are rate limited.",
    ],
    [
      "Notifications can be delivered to Microsoft Teams.",
      "A channel link is scoped to one workspace.",
      "Delivery failures retry three times.",
      "Bot messages never loop back into the discussion.",
    ],
    [
      "Scheduled reports are emailed every Monday.",
      "The schedule uses the tenant's timezone.",
      "A report with no data is skipped, not sent empty.",
      "Recipients can unsubscribe from the footer link.",
    ],
  ];

  const TEN_BY_THREE = TEN_REQUIREMENTS.map(([statement, ...criteria]) =>
    [`${statement}`, "", "Acceptance criteria:", "", ...criteria.map((c) => `- ${c}`)].join("\n"),
  ).join("\n\n");

  it("parses the 10x3 walkthrough paste as 10 requirements, not 40", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(TEN_BY_THREE);
    expect(extraction.parsedCount).toBe(10);
  });

  it("does not promote a criterion to a standalone candidate (the NR-10 symptom)", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(TEN_BY_THREE);
    expect(
      extraction.candidates.some((c) => c.text.trim() === "Roles: owner, editor, viewer."),
    ).toBe(false);
  });

  it("reports the corrected population honestly: 8 of 10, with 2 named as capped", async () => {
    // 10 real requirements still exceed the cap of 8 — but the user is now told
    // "8 of 10", which is a statement about their submission rather than about a
    // number the parser invented. The cap itself is deliberately untouched.
    const extraction = await extractNewRequirementCandidatesWithAccount(TEN_BY_THREE);
    const account = buildRequirementInputAccount(
      extraction,
      mergeRequirementSetsWithAccount([], extraction.candidates),
    );

    expect(account.parsedCount).toBe(10);
    expect(account.analyzedIds).toHaveLength(8);
    expect(account.dropped.map((d) => [d.id, d.reason])).toEqual([
      ["NR-9", "candidate-cap"],
      ["NR-10", "candidate-cap"],
    ]);
    // #1112's invariant still holds against the corrected population.
    expect(isRequirementInputAccountBalanced(account)).toBe(true);
    // Each drop quotes the REQUIREMENT the user typed, not one of its criteria.
    expect(account.dropped[0].excerpt).toContain(
      "Notifications can be delivered to Microsoft Teams",
    );
  });

  it("fits a three-requirement paste with criteria well inside the cap", async () => {
    // The headline consequence: before #1136 this parsed to 12 blocks and already
    // overflowed a cap of 8.
    const three = Array.from({ length: 3 }, (_, i) =>
      [
        `R${i + 1}: The system must support feature number ${i + 1}.`,
        "",
        "Acceptance criteria:",
        "",
        "- One criterion.",
        "- Another criterion.",
        "- A third criterion.",
      ].join("\n"),
    ).join("\n\n");

    const extraction = await extractNewRequirementCandidatesWithAccount(three);
    expect(extraction.parsedCount).toBe(3);
    expect(extraction.candidates).toHaveLength(3);
    expect(extraction.dropped).toEqual([]);
  });

  it("still treats a bare bullet list as the requirement set (no regression)", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(
      "- The API must expose /api/status.\n- Analyses must emit an audit event.\n- Exports must support CSV.",
    );
    expect(extraction.parsedCount).toBe(3);
    expect(extraction.candidates.map((c) => c.text)).toEqual([
      "The API must expose /api/status.",
      "Analyses must emit an audit event.",
      "Exports must support CSV.",
    ]);
  });
});

describe("extractNewRequirementCandidatesWithAccount — the other drop points", () => {
  it("reports a paste that arrived at the input character limit as truncated", async () => {
    const atLimit = "- Add a health endpoint.\n".padEnd(MAX_EXTRA_INSTRUCTIONS, "x");
    expect(atLimit.length).toBe(MAX_EXTRA_INSTRUCTIONS);

    const extraction = await extractNewRequirementCandidatesWithAccount(atLimit);
    expect(extraction.inputTruncated).toBe(true);
  });

  it("does not claim truncation for a paste comfortably under the limit", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount("- Add /api/status.");
    expect(extraction.inputTruncated).toBe(false);
  });

  it("still reports truncation when the truncated paste parses to nothing", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(
      " ".repeat(MAX_EXTRA_INSTRUCTIONS),
    );
    expect(extraction.candidates).toEqual([]);
    expect(extraction.parsedCount).toBe(0);
    expect(extraction.inputTruncated).toBe(true);
  });

  it("returns an empty, untruncated account for no free text at all", async () => {
    for (const input of [undefined, null, "", "   \n\n "]) {
      const extraction = await extractNewRequirementCandidatesWithAccount(input);
      expect(extraction).toEqual({
        candidates: [],
        parsedCount: 0,
        dropped: [],
        inputTruncated: false,
      });
    }
  });

  it("keeps candidate ids indexed against the FULL parsed list, so a drop names the real id", async () => {
    const text = Array.from({ length: 5 }, (_, i) => `- Requirement number ${i}.`).join("\n");
    const extraction = await extractNewRequirementCandidatesWithAccount(text, 3);

    expect(extraction.candidates.map((c) => c.id)).toEqual(["NR-1", "NR-2", "NR-3"]);
    expect(extraction.dropped.map((d) => d.id)).toEqual(["NR-4", "NR-5"]);
  });

  it("treats a cap of zero as dropping everything, still accounted for", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(
      "- One requirement.\n- Two requirements.",
      0,
    );
    expect(extraction.candidates).toEqual([]);
    expect(extraction.dropped.map((d) => d.reason)).toEqual(["candidate-cap", "candidate-cap"]);
  });

  it("keeps the pre-#1112 candidates-only signature working", async () => {
    const candidates = await extractNewRequirementCandidates("- Add /api/status.");
    expect(candidates).toEqual([{ id: "NR-1", text: "Add /api/status." }]);
  });
});

describe("mergeRequirementSetsWithAccount — merge is not a drop", () => {
  const doc = [{ id: "REQ-001", text: "The system must log every login." }];

  it("names the survivor a de-duplicated candidate was folded into", () => {
    const result = mergeRequirementSetsWithAccount(doc, [
      { id: "NR-1", text: "the system must log every login" },
      { id: "NR-2", text: "Add /api/status." },
    ]);

    expect(result.requirements.map((r) => r.id)).toEqual(["REQ-001", "NR-2"]);
    expect(result.merged).toEqual([
      {
        id: "NR-1",
        excerpt: "the system must log every login",
        mergedIntoId: "REQ-001",
        mergedIntoExcerpt: "The system must log every login.",
      },
    ]);
    expect(result.dropped).toEqual([]);
  });

  it("names an earlier CANDIDATE as the survivor when two pasted requirements collide", () => {
    const result = mergeRequirementSetsWithAccount(
      [],
      [
        { id: "NR-1", text: "Add /api/status." },
        { id: "NR-2", text: "add /api/status" },
      ],
    );

    expect(result.requirements.map((r) => r.id)).toEqual(["NR-1"]);
    expect(result.merged[0]).toMatchObject({ id: "NR-2", mergedIntoId: "NR-1" });
  });

  it("reports a candidate with no readable requirement text as dropped, not merged", () => {
    const result = mergeRequirementSetsWithAccount(doc, [{ id: "NR-1", text: "---" }]);

    expect(result.merged).toEqual([]);
    expect(result.dropped).toEqual([{ id: "NR-1", excerpt: "---", reason: "unparseable" }]);
  });

  it("reports nothing for a candidate that merely shares a subject (the overlap bar holds)", () => {
    const result = mergeRequirementSetsWithAccount(
      [{ id: "REQ-001", text: "Add rate limiting to the AI chat endpoint." }],
      [{ id: "NR-1", text: "Add response caching to the AI chat endpoint." }],
    );

    expect(result.requirements.map((r) => r.id)).toEqual(["REQ-001", "NR-1"]);
    expect(result.merged).toEqual([]);
  });

  it("leaves mergeRequirementSets byte-identical to the accounted merge", () => {
    const candidates = [
      { id: "NR-1", text: "the system must log every login" },
      { id: "NR-2", text: "Add /api/status." },
    ];
    expect(mergeRequirementSets(doc, candidates)).toEqual(
      mergeRequirementSetsWithAccount(doc, candidates).requirements,
    );
  });
});

describe("buildRequirementInputAccount", () => {
  it("splits a paste into analyzed / merged / dropped with nothing left over", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(
      [
        "- The system must log every login.",
        "- Add /api/status.",
        "- Analyses must emit an audit event.",
      ].join("\n"),
      2,
    );
    const merge = mergeRequirementSetsWithAccount(
      [{ id: "REQ-001", text: "The system must log every login." }],
      extraction.candidates,
    );

    const account = buildRequirementInputAccount(extraction, merge);

    expect(account.parsedCount).toBe(3);
    expect(account.analyzedIds).toEqual(["NR-2"]);
    expect(account.merged.map((m) => [m.id, m.mergedIntoId])).toEqual([["NR-1", "REQ-001"]]);
    expect(account.dropped.map((d) => [d.id, d.reason])).toEqual([["NR-3", "candidate-cap"]]);
    expect(isRequirementInputAccountBalanced(account)).toBe(true);
  });

  it("carries the truncation flag through from extraction", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(
      "- Add /api/status.\n".padEnd(MAX_EXTRA_INSTRUCTIONS, "x"),
    );
    const account = buildRequirementInputAccount(
      extraction,
      mergeRequirementSetsWithAccount([], extraction.candidates),
    );
    expect(account.inputTruncated).toBe(true);
  });

  it("is an empty, balanced account when no free text was supplied", async () => {
    const extraction = await extractNewRequirementCandidatesWithAccount(undefined);
    const account = buildRequirementInputAccount(extraction, { merged: [], dropped: [] });

    expect(account).toEqual({
      parsedCount: 0,
      analyzedIds: [],
      merged: [],
      dropped: [],
      inputTruncated: false,
    });
    expect(isRequirementInputAccountBalanced(account)).toBe(true);
  });
});

describe("requirementInputExcerpt", () => {
  it("flattens whitespace so a multi-line requirement reads as one line", () => {
    expect(requirementInputExcerpt("  Add   a\n  health endpoint.  ")).toBe(
      "Add a health endpoint.",
    );
  });

  it("bounds long requirement text with an ellipsis", () => {
    const excerpt = requirementInputExcerpt("x".repeat(500));
    expect(excerpt).toHaveLength(160);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

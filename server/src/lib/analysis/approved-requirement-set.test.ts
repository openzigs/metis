/**
 * Issue #1033 — criteria and code links reach the approved requirement they
 * belong to, by its id.
 *
 * The fixtures are the #706 run-6 data (analysis `cmv1odla80uf77d9kpz6afn79`),
 * trimmed: synthesis consolidated three approved requirements into ONE item,
 * and the one-to-one title join gave that item — all three criteria and all
 * three code findings — to the best title match (REQ-001). The other two
 * confirmed requirements were promoted with no criteria and no code link.
 */
import { describe, expect, it } from "vitest";
import { parseAcceptanceCriteria, type SynthesizedRequirement } from "@metis/shared";
import {
  buildApprovedRequirementSet,
  compareReviewedWithSynthesis,
  matchSynthesized,
  planApprovedRequirementSet,
} from "./approved-requirement-set.js";
import type { StructuredRequirement } from "./types/requirements.js";

function structured(id: string, title: string, description = title): StructuredRequirement {
  return {
    id,
    title,
    description,
    type: "functional",
    stakeholders: [],
    priority: "must-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  };
}

function synth(title: string, extra: Partial<SynthesizedRequirement> = {}): SynthesizedRequirement {
  return {
    type: "feature",
    title,
    body: extra.body ?? title,
    priority: "medium",
    labels: [],
    evidenceFindingIndexes: [],
    acceptanceCriteria: [],
    ...extra,
  };
}

// ── run-6 fixture ──────────────────────────────────────────────────────

const FEED_TITLE = structured("REQ-A", "Require Non-Empty Feed Title");
const SITE_URL = structured("REQ-B", "Require Non-Empty Site URL");
const BASIC_AUTH = structured(
  "REQ-C",
  "Require HTTP Basic Authentication for Metrics Endpoint",
  "When both metrics endpoint credentials are configured (METRICS_USERNAME and METRICS_PASSWORD) a request without valid Basic credentials is refused.",
);
const EMPTY_CREDS = structured(
  "REQ-D",
  "Reject Empty Username or Password for Metrics Endpoint",
  "A request to the metrics endpoint presenting an empty username or an empty password must be rejected even if the Basic auth header is well-formed.",
);
const CONSTANT_TIME = structured(
  "REQ-E",
  "Constant-Time Credential Comparison for Metrics Endpoint",
  "Metrics endpoint credentials must be compared in constant time, using crypto/subtle.ConstantTimeCompare.",
);

const CRIT_NO_HEADER =
  "With MetricsUsername and MetricsPassword both non-empty, a GET request to the metrics endpoint carrying no Authorization header returns HTTP 404 and no metrics payload is written.";
const CRIT_EMPTY =
  "A request whose Basic auth header parses successfully but whose decoded username or password is an empty string is rejected by isAllowedToAccessMetricsEndpoint before any credential comparison.";
const CRIT_CONSTANT =
  "isAllowedToAccessMetricsEndpoint evaluates both the username and the password comparison on every request using crypto.ConstantTimeCmp rather than an early-return string equality.";

/** The one synthesized item run 6 produced for three approved requirements. */
const CONSOLIDATED = synth(
  "Require HTTP Basic auth on the metrics endpoint with constant-time credential checks",
  {
    body: "The metrics access check must require HTTP Basic authentication, reject an empty username or password, and compare credentials in constant time.",
    evidenceFindingIndexes: [7, 8, 9],
    acceptanceCriteria: [CRIT_NO_HEADER, CRIT_EMPTY, CRIT_CONSTANT],
    structuredIds: ["REQ-C", "REQ-D", "REQ-E"],
  },
);

describe("#1033 — criteria and code links are carried by requirement id", () => {
  it("gives every requirement a consolidated item names its criteria and evidence", () => {
    // The confirmed requirements are NOT the first ones, and synthesis lists
    // them in a different order from the reviewed list.
    const reviewed = [FEED_TITLE, SITE_URL, BASIC_AUTH, EMPTY_CREDS, CONSTANT_TIME];
    const out = buildApprovedRequirementSet({
      structured: reviewed,
      approvedIds: new Set(reviewed.map((r) => r.id)),
      synthesis: {
        summary: "s",
        requirements: [
          CONSOLIDATED,
          synth("Reject an explicitly empty site URL", {
            evidenceFindingIndexes: [14],
            acceptanceCriteria: ["An empty site_url is rejected by the feed validator."],
            structuredIds: ["REQ-B"],
          }),
          synth("Reject an explicitly empty feed title", {
            evidenceFindingIndexes: [13],
            acceptanceCriteria: ["An empty title is rejected by the feed validator."],
            structuredIds: ["REQ-A"],
          }),
        ],
      },
    });

    const byTitle = new Map(out.requirements.map((r) => [r.title, r]));
    const basic = byTitle.get(BASIC_AUTH.title)!;
    const empty = byTitle.get(EMPTY_CREDS.title)!;
    const constant = byTitle.get(CONSTANT_TIME.title)!;

    // Each confirmed requirement keeps the code findings the agent confirmed
    // and the criteria written for the group, its own among them — not only
    // the first requirement, as in run 6.
    for (const r of [basic, empty, constant]) {
      expect(r.evidenceFindingIndexes).toEqual([7, 8, 9]);
      expect(r.acceptanceCriteria).toEqual([CRIT_NO_HEADER, CRIT_EMPTY, CRIT_CONSTANT]);
    }

    // The unrelated requirements get their own items, matched by id not order.
    expect(byTitle.get(FEED_TITLE.title)!.evidenceFindingIndexes).toEqual([13]);
    expect(byTitle.get(SITE_URL.title)!.evidenceFindingIndexes).toEqual([14]);
  });

  it("keeps two similarly titled requirements on their own items", () => {
    // Run 9: both titles would match either item by words alone.
    const network = structured("REQ-1", "Restrict metrics endpoint access by network");
    const afterAuth = structured(
      "REQ-2",
      "Require IP in METRICS_ALLOWED_NETWORKS even after authentication",
    );
    const out = buildApprovedRequirementSet({
      structured: [network, afterAuth],
      approvedIds: new Set(["REQ-1", "REQ-2"]),
      synthesis: {
        summary: "s",
        requirements: [
          // By words this item is REQ-1's exactly; the model says it is REQ-2's.
          synth("Restrict metrics endpoint access by network even after authentication", {
            evidenceFindingIndexes: [30],
            acceptanceCriteria: ["An authenticated request from outside the networks gets 404."],
            structuredIds: ["REQ-2"],
          }),
          synth("Gate the metrics handler on the configured CIDR list", {
            body: "Only callers inside a configured CIDR reach the metrics handler.",
            evidenceFindingIndexes: [21],
            acceptanceCriteria: ["A request from outside every configured CIDR gets 404."],
            structuredIds: ["REQ-1"],
          }),
        ],
      },
    });
    expect(out.requirements.map((r) => r.evidenceFindingIndexes)).toEqual([[21], [30]]);
    expect(out.requirements.map((r) => r.acceptanceCriteria)).toEqual([
      ["A request from outside every configured CIDR gets 404."],
      ["An authenticated request from outside the networks gets 404."],
    ]);
  });

  it("leaves a requirement with no code link empty instead of lending it a neighbour's", () => {
    const auth = structured("REQ-1", "Require HTTP Basic authentication for metrics");
    // Wave B: nothing in the code can verify this one.
    const publishing = structured(
      "REQ-2",
      "Restrict artifact publishing to the sandbox repository",
      "Publish metrics artifacts only to the sandbox repository.",
    );
    const out = buildApprovedRequirementSet({
      structured: [auth, publishing],
      approvedIds: new Set(["REQ-1", "REQ-2"]),
      synthesis: {
        summary: "s",
        requirements: [
          synth("Require HTTP Basic auth for the metrics endpoint and restrict publishing", {
            body: "Restrict metrics endpoint access with HTTP Basic authentication; artifacts publishing restricted.",
            evidenceFindingIndexes: [4],
            acceptanceCriteria: ["Unauthenticated metrics requests get 404."],
            structuredIds: ["REQ-1"],
          }),
        ],
      },
    });
    const [authRow, publishingRow] = out.requirements;
    expect(authRow!.evidenceFindingIndexes).toEqual([4]);
    // The item's words overlap the publishing title, but it belongs to REQ-1.
    expect(publishingRow!.evidenceFindingIndexes).toEqual([]);
    expect(publishingRow!.acceptanceCriteria).toEqual([]);
  });

  it("joins several items naming one requirement into it", () => {
    const req = structured("REQ-7", "Health check via CLI");
    const out = buildApprovedRequirementSet({
      structured: [req],
      approvedIds: new Set(["REQ-7"]),
      synthesis: {
        summary: "s",
        requirements: [
          synth("Implement -healthcheck", {
            evidenceFindingIndexes: [13],
            acceptanceCriteria: ["-healthcheck exits 0 on a healthy server."],
            labels: ["cli"],
            storyPoints: 2,
            structuredIds: ["REQ-7"],
          }),
          synth("Guess the healthcheck endpoint", {
            evidenceFindingIndexes: [13, 14],
            acceptanceCriteria: [
              "-healthcheck exits 0 on a healthy server.",
              "-healthcheck auto guesses the listen address.",
            ],
            labels: ["cli", "healthcheck"],
            sourceIds: ["NR-2"],
            structuredIds: ["REQ-7"],
          }),
        ],
      },
    });
    const [row] = out.requirements;
    expect(row!.evidenceFindingIndexes).toEqual([13, 14]);
    expect(row!.acceptanceCriteria).toEqual([
      "-healthcheck exits 0 on a healthy server.",
      "-healthcheck auto guesses the listen address.",
    ]);
    expect(row!.labels).toEqual(["functional", "cli", "healthcheck"]);
    expect(row!.storyPoints).toBe(2);
    expect(row!.sourceIds).toEqual(["NR-2"]);
  });

  it("does not hand an item claimed for a rejected requirement to an approved one by title", () => {
    const approved = structured("REQ-1", "Export user feeds as OPML");
    const out = buildApprovedRequirementSet({
      structured: [approved, structured("REQ-2", "Export user feeds via CLI")],
      approvedIds: new Set(["REQ-1"]),
      synthesis: {
        summary: "s",
        requirements: [
          synth("Export user feeds as OPML via the CLI", {
            evidenceFindingIndexes: [3],
            structuredIds: ["REQ-2"],
          }),
        ],
      },
    });
    expect(out.requirements[0]!.evidenceFindingIndexes).toEqual([]);
  });

  it("falls back to the title join for an item that names no id of this list", () => {
    const req = structured("REQ-1", "Flush sessions via -flush-sessions option");
    const out = buildApprovedRequirementSet({
      structured: [req],
      approvedIds: new Set(["REQ-1"]),
      synthesis: {
        summary: "s",
        requirements: [
          // A stale id from an earlier extraction run, and one with none at all.
          synth("Unrelated chore", { evidenceFindingIndexes: [1], structuredIds: ["OLD-9"] }),
          synth("Implement -flush-sessions option", {
            body: "Flush sessions via the -flush-sessions CLI option.",
            evidenceFindingIndexes: [8],
            acceptanceCriteria: ["-flush-sessions deletes every session row."],
          }),
        ],
      },
    });
    expect(out.requirements[0]!.evidenceFindingIndexes).toEqual([8]);
  });

  it("an item naming an id is never also the title match of another requirement", () => {
    const matches = matchSynthesized(
      [
        { id: "REQ-1", title: "Reset password via -reset-password option" },
        { id: "REQ-2", title: "Reset password via the CLI" },
      ],
      [
        synth("Implement -reset-password option", {
          body: "Reset password via the CLI -reset-password option.",
          structuredIds: ["REQ-1"],
        }),
      ],
    );
    expect(matches.get("REQ-1")?.title).toBe("Implement -reset-password option");
    expect(matches.has("REQ-2")).toBe(false);
  });

  it("keeps a joined requirement within the schema's caps", () => {
    const req = structured("REQ-1", "Validate user settings");
    const many = (prefix: string, n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => `${prefix} ${i + from}`);
    const out = buildApprovedRequirementSet({
      structured: [req],
      approvedIds: new Set(["REQ-1"]),
      synthesis: {
        summary: "s",
        requirements: [0, 1].map((k) =>
          synth(`Part ${k}`, {
            labels: many("label", 10, k * 10),
            evidenceFindingIndexes: Array.from({ length: 30 }, (_, i) => i + k * 30),
            acceptanceCriteria: many("criterion", 15, k * 15),
            structuredIds: ["REQ-1"],
          }),
        ),
      },
    });
    const [row] = out.requirements;
    expect(row!.labels).toHaveLength(16);
    expect(row!.evidenceFindingIndexes).toHaveLength(50);
    expect(row!.acceptanceCriteria).toHaveLength(20);
  });
  it("gives an approved requirement all of an item's criteria, its rejected sibling's included", () => {
    // Pinned on purpose (PR #1187 review): the criteria are not split, so the
    // rejected requirement's criterion rides on the approved one it was named with.
    const out = buildApprovedRequirementSet({
      structured: [BASIC_AUTH, EMPTY_CREDS, CONSTANT_TIME],
      approvedIds: new Set(["REQ-C"]),
      synthesis: { summary: "s", requirements: [CONSOLIDATED] },
    });
    expect(out.requirements).toHaveLength(1);
    expect(out.requirements[0]!.acceptanceCriteria).toEqual([
      CRIT_NO_HEADER,
      CRIT_EMPTY,
      CRIT_CONSTANT,
    ]);
    expect(out.requirements[0]!.evidenceFindingIndexes).toEqual([7, 8, 9]);
  });

  it("never title-matches an item that says it restates no listed requirement", () => {
    const req = structured("REQ-1", "Export user feeds as OPML");
    const out = buildApprovedRequirementSet({
      structured: [req],
      approvedIds: new Set(["REQ-1"]),
      synthesis: {
        summary: "s",
        requirements: [
          synth("Export user feeds as OPML", {
            evidenceFindingIndexes: [3],
            acceptanceCriteria: ["The export is valid OPML."],
            structuredIds: [],
          }),
        ],
      },
    });
    expect(out.requirements[0]!.evidenceFindingIndexes).toEqual([]);
    expect(out.requirements[0]!.acceptanceCriteria).toEqual([]);
  });
});

describe("#1033 — the title fallback refuses a tie instead of breaking it by order", () => {
  // Neither title is the item's, and both are wholly contained in its title
  // and its body: level on all three #1031 tiers.
  const markRead = structured("REQ-5", "Mark entries read");
  const markOlder = structured("REQ-6", "Mark older entries read");
  const item = synth("Mark older entries as read", {
    body: "Mark every entry older than the selected one as read.",
    evidenceFindingIndexes: [4],
    acceptanceCriteria: ["Entries older than the selected one are marked read."],
  });

  it("gives an item two requirements match equally well to neither, in either order", () => {
    expect(matchSynthesized([markRead, markOlder], [item]).size).toBe(0);
    expect(matchSynthesized([markOlder, markRead], [item]).size).toBe(0);
  });

  it("lets the one requirement that matches an item take it", () => {
    const other = structured("REQ-7", "Refresh feeds via -refresh-feeds option");
    const matches = matchSynthesized([other, markOlder], [item]);
    expect(matches.get("REQ-6")).toBe(item);
    expect(matches.has("REQ-7")).toBe(false);
  });

  it("breaks a containment tie on the #1031 tiers before refusing it", () => {
    // Same containment for both; the item's title IS REQ-6's, so REQ-6 takes it.
    const exact = synth("Mark older entries read", {
      body: "Mark every entry older than the selected one as read.",
    });
    for (const reqs of [
      [markRead, markOlder],
      [markOlder, markRead],
    ]) {
      const matches = matchSynthesized(reqs, [exact]);
      expect(matches.get("REQ-6")).toBe(exact);
      expect(matches.has("REQ-5")).toBe(false);
    }
  });

  it("#1204 — reports the refused requirement and the items it was level on, in either order", () => {
    const flush = structured("REQ-1", "Flush sessions");
    const other = structured("REQ-2", "Export subscriptions as OPML");
    // Not approved, and listed first: REQ-1's approved position (1) is not its
    // position in the reviewed list (2), and the rows follow the approved one.
    const unapproved = structured("REQ-0", "Rate limit the public API");
    const a = synth("Flush sessions on logout", { acceptanceCriteria: ["Logout ends sessions."] });
    const b = synth("Flush sessions on password reset", {
      acceptanceCriteria: ["Reset ends sessions."],
    });
    for (const items of [
      [a, b],
      [b, a],
    ]) {
      const plan = planApprovedRequirementSet({
        structured: [unapproved, other, flush],
        approvedIds: new Set(["REQ-1", "REQ-2"]),
        synthesis: { summary: "s", requirements: items },
      });
      // Still refused: no criteria are put on it.
      expect(plan.output.requirements[1]?.acceptanceCriteria).toEqual([]);
      expect(plan.ambiguous).toHaveLength(1);
      expect(plan.ambiguous[0]).toMatchObject({ structuredId: "REQ-1", approvedIndex: 1 });
      expect(
        [...plan.ambiguous[0]!.candidates].sort((x, y) => x.title.localeCompare(y.title)),
      ).toEqual([
        { title: a.title, acceptanceCriteria: a.acceptanceCriteria },
        { title: b.title, acceptanceCriteria: b.acceptanceCriteria },
      ]);
    }
  });

  it("#1204 — reports nothing for a requirement matched by id or by an unambiguous title", () => {
    const plan = planApprovedRequirementSet({
      structured: [markOlder],
      approvedIds: new Set(["REQ-6"]),
      synthesis: { summary: "s", requirements: [item] },
    });
    expect(plan.ambiguous).toEqual([]);
    expect(plan.output.requirements[0]?.acceptanceCriteria).toEqual(item.acceptanceCriteria);
  });

  it("gives a requirement two items match equally well neither, in either order", () => {
    const req = structured("REQ-1", "Flush sessions");
    const a = synth("Flush sessions on logout", { evidenceFindingIndexes: [1] });
    const b = synth("Flush sessions on password reset", { evidenceFindingIndexes: [2] });
    expect(matchSynthesized([req], [a, b]).size).toBe(0);
    expect(matchSynthesized([req], [b, a]).size).toBe(0);
  });

  it("never lets a requirement refused for a tie take a weaker item later", () => {
    const other = synth("Mark selected entry as read", {
      body: "Only the selected entry.",
      evidenceFindingIndexes: [9],
    });
    // Level on `item`, so both are refused for the tie. REQ-5 would score 2/3
    // on `other`, but a wrong attribution is worse than none: no fallback.
    for (const items of [
      [item, other],
      [other, item],
    ]) {
      expect(matchSynthesized([markRead, markOlder], items).size).toBe(0);
    }
  });

  /**
   * #1187 review, run 9 (`cmva6wd6c0uov3g9k925losyd`, exported read-only). The
   * categories item is level between the two requirements and /v1/feeds also
   * reaches its own item; counting rivals once per level refused /v1/feeds and
   * let categories fall to /v1/feeds's item.
   */
  it("run 9: /v1/feeds keeps its own item and categories never takes it", () => {
    const feeds = structured(
      "f8a264a8-79e0-4beb-ac77-dc9039566824",
      "Expose GET /v1/feeds API",
      "The API must expose GET /v1/feeds, which returns the user's feeds.",
    );
    const categories = structured(
      "a0db1925-7574-4ab6-bbd1-bc9d51d2aec3",
      "Expose GET /v1/categories/{id}/feeds API",
      "The API must expose GET /v1/categories/{id}/feeds, which returns the feeds belonging to the specified category for the authenticated user.",
    );
    const item27 = synth("Expose GET /v1/feeds API route", {
      body: "The API must expose GET /v1/feeds, which returns the user's feeds. api.go maps GET /v1/feeds to handler.getFeedsHandler.",
      evidenceFindingIndexes: [33],
    });
    const item28 = synth("Expose GET /v1/categories/{id}/feeds API route", {
      body: "The API must expose GET /v1/categories/{id}/feeds, which returns the feeds belonging to the specified category. api.go maps GET /v1/categories/{categoryID}/feeds to handler.getCategoryFeedsHandler.",
      evidenceFindingIndexes: [34],
    });
    for (const reqs of [
      [feeds, categories],
      [categories, feeds],
    ]) {
      for (const items of [
        [item27, item28],
        [item28, item27],
      ]) {
        const matches = matchSynthesized(reqs, items);
        expect(matches.get(feeds.id)).toBe(item27);
        // The level's only maximum matching pairs categories with its own item.
        expect(matches.get(categories.id)).toBe(item28);
      }
    }
  });
});
describe("#1203 — which approved requirements share criteria, from the id join", () => {
  const R0 = structured("REQ-0", "Rate limit the public API");
  const R1 = structured("REQ-1", "Flush sessions on logout");
  const R2 = structured("REQ-2", "Flush sessions on reset");
  const R3 = structured("REQ-3", "Flush sessions on revoke");
  const R4 = structured("REQ-4", "Export subscriptions as OPML");
  const LIST = [R0, R1, R2, R3, R4];
  const GROUP = ["Logging out ends every session.", "A reset ends every session."];
  const plan = (approved: string[], items: SynthesizedRequirement[], list = LIST) =>
    planApprovedRequirementSet({
      structured: list,
      approvedIds: new Set(approved),
      synthesis: { summary: "s", requirements: items },
    });

  it("an item naming one requirement shares nothing", () => {
    const out = plan(
      ["REQ-4"],
      [
        synth("OPML", {
          structuredIds: ["REQ-4"],
          acceptanceCriteria: ["Exports."],
        }),
      ],
    );
    expect(out.output.requirements[0]?.acceptanceCriteria).toEqual(["Exports."]);
    expect(out.shared).toEqual([]);
  });

  it("an item naming three gives each the other two, keyed by approved position", () => {
    const out = plan(
      ["REQ-1", "REQ-2", "REQ-3", "REQ-4"],
      [
        synth("Flush", {
          structuredIds: ["REQ-1", "REQ-2", "REQ-3"],
          acceptanceCriteria: GROUP,
        }),
        synth("OPML", {
          structuredIds: ["REQ-4"],
          acceptanceCriteria: ["Exports."],
        }),
      ],
    );
    const s = (id: string, title: string, approvedIndex: number | null) => ({
      structuredId: id,
      title,
      approvedIndex,
    });
    expect(out.shared).toEqual([
      {
        structuredId: "REQ-1",
        approvedIndex: 0,
        sharedWith: [s("REQ-2", R2.title, 1), s("REQ-3", R3.title, 2)],
        sharedCriteria: GROUP,
        promotedCriteria: GROUP,
      },
      {
        structuredId: "REQ-2",
        approvedIndex: 1,
        sharedWith: [s("REQ-1", R1.title, 0), s("REQ-3", R3.title, 2)],
        sharedCriteria: GROUP,
        promotedCriteria: GROUP,
      },
      {
        structuredId: "REQ-3",
        approvedIndex: 2,
        sharedWith: [s("REQ-1", R1.title, 0), s("REQ-2", R2.title, 1)],
        sharedCriteria: GROUP,
        promotedCriteria: GROUP,
      },
    ]);
  });

  it("names a sibling that is not approved, and ignores ids no longer in the list", () => {
    const out = plan(
      ["REQ-1"],
      [
        synth("Flush", {
          structuredIds: ["REQ-1", "REQ-0", "REQ-99"],
          acceptanceCriteria: GROUP,
        }),
      ],
    );
    expect(out.shared).toEqual([
      {
        structuredId: "REQ-1",
        approvedIndex: 0,
        sharedWith: [{ structuredId: "REQ-0", title: R0.title, approvedIndex: null }],
        sharedCriteria: GROUP,
        promotedCriteria: GROUP,
      },
    ]);
    // Only stale ids beside it: nothing shared.
    expect(
      plan(
        ["REQ-1"],
        [
          synth("Flush", {
            structuredIds: ["REQ-1", "REQ-99"],
            acceptanceCriteria: GROUP,
          }),
        ],
      ).shared,
    ).toEqual([]);
  });

  it("marks only the criteria from the shared item when another names the requirement alone", () => {
    const out = plan(
      ["REQ-1", "REQ-2"],
      [
        synth("Flush", {
          structuredIds: ["REQ-1", "REQ-2"],
          acceptanceCriteria: GROUP,
        }),
        synth("Logout", {
          structuredIds: ["REQ-1"],
          acceptanceCriteria: ["Own criterion."],
        }),
      ],
    );
    expect(out.shared[0]).toMatchObject({
      structuredId: "REQ-1",
      sharedCriteria: GROUP,
      promotedCriteria: [...GROUP, "Own criterion."],
    });
  });

  // #1203 review — synthesis criteria are untrimmed; the row's are trimmed on
  // read (`parseAcceptanceCriteria`), so both lists are stored as the row reads.
  it("stores the criteria trimmed, exactly as the promoted row reads back", () => {
    const out = plan(
      ["REQ-1", "REQ-2"],
      [
        synth("Flush", {
          structuredIds: ["REQ-1", "REQ-2"],
          acceptanceCriteria: ["Logging out ends every session. ", "  A reset ends every session."],
        }),
        synth("Logout", { structuredIds: ["REQ-1"], acceptanceCriteria: ["Own criterion.\t"] }),
      ],
    );
    expect(out.shared[0]).toMatchObject({
      structuredId: "REQ-1",
      sharedCriteria: GROUP,
      promotedCriteria: [...GROUP, "Own criterion."],
    });
    // Promotion writes the plan's list as JSON; the row reads it back trimmed.
    const row = JSON.stringify(out.output.requirements[0]!.acceptanceCriteria);
    expect(parseAcceptanceCriteria(row)).toEqual(out.shared[0]!.promotedCriteria);
  });

  it("records nothing for a shared item with no criteria", () => {
    const out = plan(["REQ-1", "REQ-2"], [synth("Flush", { structuredIds: ["REQ-1", "REQ-2"] })]);
    expect(out.shared).toEqual([]);
  });

  it("the title fallback is one-to-one and never shares", () => {
    const out = plan(
      ["REQ-1", "REQ-4"],
      [synth("Flush sessions on logout", { acceptanceCriteria: GROUP })],
    );
    expect(out.output.requirements[0]?.acceptanceCriteria).toEqual(GROUP);
    expect(out.shared).toEqual([]);
  });
});

describe("#930 — the reviewed list and the synthesis compared by identity", () => {
  const reviewed = [
    structured("REQ-1", "Export subscriptions as OPML"),
    structured("REQ-2", "Rate limit the public API"),
  ];

  it("equal counts naming different requirements still differ", () => {
    const out = compareReviewedWithSynthesis(reviewed, [
      synth("OPML export", { structuredIds: ["REQ-1"] }),
      synth("Dark mode for the reader", { structuredIds: [] }),
    ]);
    expect(out).toEqual({ reviewedWithoutItem: 1, itemsWithoutReviewed: 1 });
  });

  it("the same requirements, joined by id or by title, do not differ", () => {
    const out = compareReviewedWithSynthesis(reviewed, [
      synth("OPML export", { structuredIds: ["REQ-1"] }),
      synth("Rate limit the public API"),
    ]);
    expect(out).toEqual({ reviewedWithoutItem: 0, itemsWithoutReviewed: 0 });
  });

  it("one item consolidating both reviewed requirements: nothing unmatched on either side", () => {
    const out = compareReviewedWithSynthesis(reviewed, [
      synth("Hardening", { structuredIds: ["REQ-1", "REQ-2"] }),
    ]);
    expect(out).toEqual({ reviewedWithoutItem: 0, itemsWithoutReviewed: 0 });
  });
});

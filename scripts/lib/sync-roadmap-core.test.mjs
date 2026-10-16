import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ADD_ITEM,
  CLEAR_VALUE,
  ISSUES_QUERY,
  ITEMS_QUERY,
  MAX_MUTATIONS,
  ONE_ISSUE_QUERY,
  PROJECT_QUERY,
  SET_VALUE,
  UPDATE_FIELD,
  areaOf,
  createClient,
  desiredFields,
  encodeValue,
  fieldChanges,
  inReadWindow,
  kindOf,
  labelGaps,
  main,
  missingLabels,
  missingAreaOptions,
  ownTier,
  parseArgs,
  resolveTier,
  progressOf,
  shouldAdd,
  summaryLine,
  sync,
  tierOf,
} from "./sync-roadmap-core.mjs";

const NOW = new Date("2026-10-15T12:00:00Z");
const TOKEN = "ghs_SECRET_TOKEN_VALUE";

describe("tierOf", () => {
  it("maps the priority labels and blocked, in the field's option order", () => {
    expect(tierOf(["priority: now"])).toBe("Now");
    expect(tierOf(["priority: next"])).toBe("Next");
    expect(tierOf(["priority: later"])).toBe("Later");
    expect(tierOf(["blocked"])).toBe("Blocked");
    // The first fill (2026-10-15) kept the priority over `blocked` (#376, #1074).
    expect(tierOf(["blocked", "priority: later"])).toBe("Later");
    expect(tierOf(["priority: later", "priority: now"])).toBe("Now");
  });

  it("does not treat the severity label priority: high as a tier", () => {
    expect(tierOf(["priority: high", "bug"])).toBe("Unranked");
    expect(tierOf([])).toBe("Unranked");
  });
});

describe("ownTier / resolveTier", () => {
  /** @param {Array<[number, string[], number | null]>} rows */
  const lookup = (rows) =>
    new Map(rows.map(([number, labels, parent]) => [number, { number, labels, parent }]));

  it("returns the own label's tier, or null", () => {
    expect(ownTier(["priority: next"])).toBe("Next");
    expect(ownTier(["priority: high"])).toBeNull();
  });

  it("prefers the issue's own label over any ancestor's", () => {
    const l = lookup([
      [3, ["priority: later"], 2],
      [2, ["priority: now"], null],
    ]);
    expect(resolveTier(3, l)).toBe("Later");
  });

  it("takes the nearest labelled ancestor over a farther one", () => {
    const l = lookup([
      [4, [], 3],
      [3, [], 2],
      [2, ["priority: next"], 1],
      [1, ["priority: now"], null],
    ]);
    expect(resolveTier(4, l)).toBe("Next");
    expect(resolveTier(3, l)).toBe("Next");
  });

  it("is Unranked with no label on the chain, a missing parent, a cycle, or an unknown issue", () => {
    expect(
      resolveTier(
        2,
        lookup([
          [2, ["priority: high"], 1],
          [1, ["bug"], null],
        ]),
      ),
    ).toBe("Unranked");
    expect(resolveTier(2, lookup([[2, [], 99]]))).toBe("Unranked");
    expect(resolveTier(7, lookup([]))).toBe("Unranked");
    // A cycle: the lookup throws past 10 reads, so a walk that does not stop fails here, named,
    // instead of hanging the worker.
    /** @param {ReturnType<typeof lookup>} map */
    const bounded = (map) => {
      let reads = 0;
      return /** @type {typeof map} */ ({
        get: (/** @type {number} */ n) => {
          reads += 1;
          if (reads > 10) throw new Error("resolveTier walked a cycle without stopping");
          return map.get(n);
        },
      });
    };
    const cycle = lookup([
      [3, [], 2],
      [2, [], 3],
    ]);
    expect(resolveTier(3, bounded(cycle))).toBe("Unranked");
    expect(resolveTier(5, bounded(lookup([[5, [], 5]])))).toBe("Unranked");
  });
});

describe("kindOf", () => {
  it("prefers Epic, then a Spike or Research title, then Bug, else Issue", () => {
    expect(kindOf({ title: "Spike: x", labels: ["epic", "bug"] })).toBe("Epic");
    expect(kindOf({ title: "  spike into y", labels: ["bug"] })).toBe("Spike");
    expect(kindOf({ title: "Research: METIS app layout", labels: [] })).toBe("Spike");
    expect(kindOf({ title: "Spiked metrics", labels: [] })).toBe("Issue");
    expect(kindOf({ title: "Crash", labels: ["bug"] })).toBe("Bug");
    expect(kindOf({ title: "Add x", labels: ["enhancement"] })).toBe("Issue");
  });
});

describe("progressOf / desiredFields", () => {
  it("reads the sub-issue summary, and clears for an issue with none", () => {
    expect(progressOf({ total: 7, completed: 6, percentCompleted: 85 })).toEqual([85, "6 of 7"]);
    expect(progressOf({ total: 0, completed: 0, percentCompleted: 0 })).toEqual([null, null]);
    expect(progressOf(null)).toEqual([null, null]);
  });

  it("names Area from the area: label, and never Status", () => {
    const fields = desiredFields(issue(1, { labels: ["priority: now", "bug", "area: ci"] }));
    expect(fields).toEqual({
      Tier: "Now",
      Kind: "Bug",
      Area: "ci",
      "Progress %": null,
      "Sub-issues done": null,
    });
    expect(desiredFields(issue(2)).Area).toBeNull();
  });
});

describe("areaOf / missingAreaOptions", () => {
  it("takes the area: label's name, the first by name when there are several", () => {
    expect(areaOf(["bug", "area: ci"])).toBe("ci");
    expect(areaOf(["area: ui", "area:  docs ", "area: ci"])).toBe("ci");
    expect(areaOf(["area:", "area:   ", "areas: x", "bug"])).toBeNull();
    expect(areaOf([])).toBeNull();
  });

  it("lists the area names the field has no option for, once each, sorted", () => {
    const issues = [
      { labels: ["area: zeta"] },
      { labels: ["area: ci"] },
      { labels: ["area: alpha"] },
      { labels: ["area: zeta"] },
      { labels: [] },
    ];
    expect(missingAreaOptions(issues, ["ci"])).toEqual(["alpha", "zeta"]);
    expect(missingAreaOptions(issues, ["ci", "alpha", "zeta"])).toEqual([]);
  });
});

describe("fieldChanges", () => {
  const desired = { Tier: "Now", Kind: "Epic", "Progress %": 50, "Sub-issues done": "1 of 2" };

  it("returns nothing when the board holds every value, ignoring unmanaged fields", () => {
    expect(fieldChanges(desired, { ...desired, "Progress %": 50.0, Status: "Todo" })).toEqual([]);
  });

  it("returns each differing field, a cleared one as null, in write order", () => {
    expect(
      fieldChanges(
        { ...desired, "Progress %": null, "Sub-issues done": null },
        { Kind: "Issue", Tier: "Now", "Progress %": 86, "Sub-issues done": "6 of 7" },
      ),
    ).toEqual([
      ["Kind", "Epic"],
      ["Progress %", null],
      ["Sub-issues done", null],
    ]);
    expect(fieldChanges(desired, { ...desired, "Progress %": 49 })).toEqual([["Progress %", 50]]);
  });
});

describe("shouldAdd / inReadWindow", () => {
  it("adds open issues only", () => {
    expect(shouldAdd({ state: "OPEN" })).toBe(true);
    expect(shouldAdd({ state: "CLOSED" })).toBe(false);
  });

  it("reads open issues and those closed in the last 30 days", () => {
    expect(inReadWindow({ state: "OPEN", closedAt: null }, NOW)).toBe(true);
    expect(inReadWindow({ state: "CLOSED", closedAt: "2026-09-16T12:00:00Z" }, NOW)).toBe(true);
    expect(inReadWindow({ state: "CLOSED", closedAt: "2026-09-15T11:59:59Z" }, NOW)).toBe(false);
    expect(inReadWindow({ state: "CLOSED", closedAt: null }, NOW)).toBe(false);
    expect(inReadWindow({ state: "CLOSED", closedAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("encodeValue / summaryLine", () => {
  it("encodes by the field's data type", () => {
    expect(encodeValue({ id: "f", name: "Progress %", dataType: "NUMBER" }, 85)).toEqual({
      number: 85,
    });
    expect(encodeValue({ id: "f", name: "Sub-issues done", dataType: "TEXT" }, "1 of 2")).toEqual({
      text: "1 of 2",
    });
    const select = {
      id: "f",
      name: "Tier",
      dataType: "SINGLE_SELECT",
      options: [{ id: "o1", name: "Now" }],
    };
    expect(encodeValue(select, "Now")).toEqual({ singleSelectOptionId: "o1" });
    expect(encodeValue(select, "Later")).toBeNull();
    expect(encodeValue({ id: "f", name: "Tier" }, "Now")).toBeNull();
  });

  it("summarises", () => {
    expect(summaryLine({ added: 1, changed: 2, unchanged: 3, skipped: 4, failed: 5 }, 6)).toBe(
      "summary: added 1, changed 2, unchanged 3, skipped 4, failed 5, missing labels 6",
    );
  });
});

describe("missingLabels / labelGaps", () => {
  /** @param {number} number @param {string[]} labels @param {number | null} [parent] */
  const node = (number, labels, parent = null) => ({ number, labels, parent, state: "OPEN" });

  it("names each of tier, area and type that an issue lacks, in that order", () => {
    const lookup = new Map([[1, node(1, [])]]);
    expect(missingLabels(node(1, []), lookup)).toEqual(["tier", "area", "type"]);
    const full = node(2, ["priority: later", "area: ci", "documentation"]);
    expect(missingLabels(full, new Map([[2, full]]))).toEqual([]);
  });

  it("accepts every type label, and not a severity or an unknown label as a type", () => {
    for (const type of [
      "bug",
      "enhancement",
      "feature",
      "epic",
      "documentation",
      "testing",
      "dependencies",
    ]) {
      const i = node(3, ["priority: next", "area: ui", type]);
      expect(missingLabels(i, new Map([[3, i]]))).toEqual([]);
    }
    const severity = node(4, ["priority: next", "area: ui", "priority: high", "question"]);
    expect(missingLabels(severity, new Map([[4, severity]]))).toEqual(["type"]);
  });

  it("counts a tier inherited from an ancestor as present, and priority: high as no tier", () => {
    const epic = node(10, ["priority: now", "epic", "area: ci"]);
    const mid = node(11, ["epic", "area: ci"], 10);
    const leaf = node(12, ["bug", "area: ci"], 11);
    const lookup = new Map([epic, mid, leaf].map((i) => [i.number, i]));
    expect(missingLabels(leaf, lookup)).toEqual([]);
    const orphan = node(13, ["bug", "area: ci", "priority: high"], 99);
    expect(missingLabels(orphan, new Map([[13, orphan]]))).toEqual(["tier"]);
  });

  it("counts the issue's own tier label when the issue is not in lookup", () => {
    const own = node(6, ["priority: later", "area: ci", "bug"]);
    expect(missingLabels(own, new Map())).toEqual([]);
    expect(missingLabels(node(7, ["area: ci", "bug"]), new Map())).toEqual(["tier"]);
  });

  it("does not count an empty area: label as an area", () => {
    const i = node(5, ["priority: later", "bug", "area: "]);
    expect(missingLabels(i, new Map([[5, i]]))).toEqual(["area"]);
  });

  it("lists open issues only, by number, and exempts the roadmap plan issue", () => {
    const issues = new Map([
      [7, node(7, ["bug"])],
      [3, node(3, [])],
      [1146, node(1146, ["roadmap"])],
      [8, { ...node(8, []), state: "CLOSED" }],
      [9, node(9, ["priority: next", "area: ui", "enhancement"])],
    ]);
    expect(labelGaps(issues, issues)).toEqual([
      { number: 3, missing: ["tier", "area", "type"] },
      { number: 7, missing: ["tier", "area"] },
    ]);
  });
});

describe("parseArgs", () => {
  it("parses the flags", () => {
    expect(parseArgs(["--org", "openzigs", "--project", "2", "--dry-run"])).toEqual({
      org: "openzigs",
      project: 2,
      dryRun: true,
    });
    expect(parseArgs(["--project", "2", "--org", "openzigs"]).dryRun).toBe(false);
  });

  it("refuses a missing or malformed org or project, and unknown flags", () => {
    expect(() => parseArgs(["--project", "2"])).toThrow(/--org/);
    expect(() => parseArgs(["--org", "a b", "--project", "2"])).toThrow(/--org/);
    expect(() => parseArgs(["--org", "openzigs"])).toThrow(/--project/);
    expect(() => parseArgs(["--org", "openzigs", "--project", "0"])).toThrow(/--project/);
    expect(() => parseArgs(["--org", "openzigs", "--project", "2", "--status-update"])).toThrow(
      /unknown/,
    );
    expect(() => parseArgs(["--org"])).toThrow(/--org/);
  });
});

// --- A fake GitHub GraphQL endpoint -------------------------------------------------------------

/**
 * `updatedAt` defaults to `closedAt` (a close updates the issue), else to a day before NOW.
 *
 * @param {Partial<{ number: number, title: string, state: string, closedAt: string | null,
 *   updatedAt: string, labels: string[], summary: any, parent: number | null,
 *   parentRepo: string }>} [over]
 * @param {number} number
 */
function issue(number, over = {}) {
  const base = {
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    state: "OPEN",
    closedAt: /** @type {string | null} */ (null),
    labels: /** @type {string[]} */ ([]),
    summary: /** @type {any} */ (null),
    parent: /** @type {number | null} */ (null),
    parentRepo: "openzigs/metis",
    ...over,
  };
  return { ...base, updatedAt: over.updatedAt ?? base.closedAt ?? "2026-10-14T12:00:00Z" };
}

/** @param {ReturnType<typeof issue>} i */
function issueNode(i) {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    closedAt: i.closedAt,
    labels: { nodes: i.labels.map((name) => ({ name })) },
    subIssuesSummary: i.summary ?? { total: 0, completed: 0, percentCompleted: 0 },
    parent:
      i.parent == null ? null : { number: i.parent, repository: { nameWithOwner: i.parentRepo } },
  };
}

const FIELDS = [
  {
    id: "F_status",
    name: "Status",
    dataType: "SINGLE_SELECT",
    options: [{ id: "s1", name: "Todo" }],
  },
  {
    id: "F_tier",
    name: "Tier",
    dataType: "SINGLE_SELECT",
    options: ["Now", "Next", "Later", "Blocked", "Unranked"].map((n) => ({
      id: `t_${n}`,
      name: n,
    })),
  },
  {
    id: "F_kind",
    name: "Kind",
    dataType: "SINGLE_SELECT",
    options: ["Epic", "Issue", "Spike", "Bug"].map((n) => ({ id: `k_${n}`, name: n })),
  },
  { id: "F_progress", name: "Progress %", dataType: "NUMBER" },
  { id: "F_done", name: "Sub-issues done", dataType: "TEXT" },
  {
    id: "F_area",
    name: "Area",
    dataType: "SINGLE_SELECT",
    options: [
      { id: "a1", name: "ci", color: "GRAY", description: "CI health and flaky tests" },
      { id: "a2", name: "ui", color: "BLUE", description: "UI and UX" },
    ],
  },
  {},
];

const MAX_ONE_ISSUE_READS = 20;

/**
 * An in-memory board behind a fake `fetch`: mutations change it, so a second run reads back
 * what the first one wrote — the same path a real consumer uses. Its filters and mutations follow
 * GitHub's documented semantics, not the script's assumptions: `IssueFilters.since` is on
 * updatedAt, and `updateProjectV2Field` replaces the option list, keeping an option only when its
 * id is sent back (an item holding a dropped option is emptied). `fail` makes a mutation answer
 * with a GraphQL error.
 *
 * @param {{ issues: ReturnType<typeof issue>[], items?: Array<{ number: number, archived?: boolean,
 *   values?: Record<string, any>, repo?: string }>, fields?: any[], project?: boolean, pageSize?: number,
 *   fail?: (query: string, variables: any) => boolean }} opts
 */
function fakeGitHub({
  issues,
  items = [],
  fields: initialFields = FIELDS,
  project = true,
  pageSize = 100,
  fail = () => false,
}) {
  const fields = structuredClone(initialFields);
  let optionSeq = 0;
  let oneIssueCount = 0;
  const board = items.map((it, n) => ({
    id: `PVTI_${it.number}`,
    number: it.number,
    archived: Boolean(it.archived),
    repo: it.repo ?? "openzigs/metis",
    values: { ...(it.values ?? {}) },
    order: n,
  }));
  /** @type {Array<{ query: string, variables: any }>} */
  const mutations = [];
  /** @type {Array<{ url: string, init: any }>} */
  const requests = [];
  const fieldById = (/** @type {string} */ id) => fields.find((f) => f.id === id);

  /** @param {any[]} list @param {string | null} after */
  function page(list, after) {
    const start = after ? Number(after) : 0;
    const nodes = list.slice(start, start + pageSize);
    const end = start + nodes.length;
    return { pageInfo: { hasNextPage: end < list.length, endCursor: String(end) }, nodes };
  }

  /** @param {string} url @param {any} init */
  const impl = vi.fn(async (url, init) => {
    requests.push({ url, init });
    const { query, variables } = JSON.parse(init.body);
    /** @param {any} data */
    // Cloned, as JSON off the wire would be: the script must never see the fake's own state.
    const ok = (data) => ({ ok: true, status: 200, json: async () => structuredClone({ data }) });
    if (query === PROJECT_QUERY) {
      return ok({
        organization: { projectV2: project ? { id: "PVT_1", fields: { nodes: fields } } : null },
      });
    }
    if (query === ISSUES_QUERY) {
      const f = variables.filter;
      const matching = issues.filter(
        (i) => f.states.includes(i.state) && (!f.since || i.updatedAt >= f.since),
      );
      const p = page(matching, variables.after);
      return ok({ repository: { issues: { ...p, nodes: p.nodes.map(issueNode) } } });
    }
    if (query === ONE_ISSUE_QUERY) {
      // A walk that re-reads what it has read never ends; cap it so it fails as a named test,
      // not a hung or crashed run.
      oneIssueCount += 1;
      if (oneIssueCount > MAX_ONE_ISSUE_READS) {
        throw new Error(
          `fake: over ${MAX_ONE_ISSUE_READS} single-issue reads, the walk is unbounded`,
        );
      }
      // Any issue by number, in the window or not; a number with no issue is null, as on GitHub.
      const found = issues.find((i) => i.number === variables.number);
      return ok({ repository: { issue: found ? issueNode(found) : null } });
    }
    if (query === ITEMS_QUERY) {
      const p = page(board, variables.after);
      return ok({
        organization: {
          projectV2: {
            items: {
              ...p,
              nodes: p.nodes.map((b) => ({
                id: b.id,
                isArchived: b.archived,
                content:
                  b.number < 0 ? {} : { number: b.number, repository: { nameWithOwner: b.repo } },
                fieldValues: {
                  nodes: [
                    {},
                    ...Object.entries(b.values).map(([name, v]) => {
                      const field = { name };
                      if (typeof v === "number") return { number: v, field };
                      const def = fields.find((x) => x.name === name);
                      return def?.dataType === "TEXT" ? { text: v, field } : { name: v, field };
                    }),
                  ],
                },
              })),
            },
          },
        },
      });
    }
    mutations.push({ query, variables });
    if (fail(query, variables)) {
      return { ok: true, status: 200, json: async () => ({ errors: [{ message: "boom" }] }) };
    }
    if (query === UPDATE_FIELD) {
      const f = fieldById(variables.field);
      const kept = new Set(variables.options.map((/** @type {any} */ o) => o.id).filter(Boolean));
      for (const old of f.options) {
        if (kept.has(old.id)) continue;
        for (const b of board) if (b.values[f.name] === old.name) delete b.values[f.name];
      }
      f.options = variables.options.map((/** @type {any} */ o) => ({
        ...o,
        id: o.id ?? `new_${(optionSeq += 1)}`,
      }));
      return ok({
        updateProjectV2Field: {
          projectV2Field: { id: f.id, name: f.name, dataType: f.dataType, options: f.options },
        },
      });
    }
    if (query === ADD_ITEM) {
      const i = issues.find((x) => x.id === variables.content);
      const existing = board.find((b) => b.number === i?.number);
      if (existing) return ok({ addProjectV2ItemById: { item: { id: existing.id } } });
      const created = {
        id: `PVTI_${i?.number}`,
        number: Number(i?.number),
        archived: false,
        repo: "openzigs/metis",
        values: {},
        order: board.length,
      };
      board.push(created);
      return ok({ addProjectV2ItemById: { item: { id: created.id } } });
    }
    const target = board.find((b) => b.id === variables.item);
    const field = fieldById(variables.field);
    if (query === SET_VALUE && target && field) {
      const v = variables.value;
      target.values[field.name] =
        "number" in v
          ? v.number
          : "text" in v
            ? v.text
            : field.options.find((/** @type {any} */ o) => o.id === v.singleSelectOptionId).name;
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: target.id } } });
    }
    if (query === CLEAR_VALUE && target && field) {
      delete target.values[field.name];
      return ok({ clearProjectV2ItemFieldValue: { projectV2Item: { id: target.id } } });
    }
    throw new Error(`unexpected request: ${query.slice(0, 60)}`);
  });

  const oneIssueReads = () =>
    requests.filter((r) => JSON.parse(r.init.body).query === ONE_ISSUE_QUERY).length;
  return { impl, board, mutations, requests, fields, oneIssueReads };
}

/** @param {ReturnType<typeof fakeGitHub>} gh @param {boolean} [dryRun] */
function clientFor(gh, dryRun = false) {
  const lines = /** @type {string[]} */ ([]);
  const client = createClient({
    token: TOKEN,
    dryRun,
    fetchImpl: /** @type {any} */ (gh.impl),
    sleep: async () => {},
    log: (line) => lines.push(line),
  });
  return { client, lines };
}

/** @param {ReturnType<typeof fakeGitHub>} gh @param {{ dryRun?: boolean }} [opts] */
async function run(gh, { dryRun = false } = {}) {
  const { client, lines } = clientFor(gh, dryRun);
  const counts = await sync({
    client,
    org: "openzigs",
    project: 2,
    now: NOW,
    log: (l) => lines.push(l),
  });
  return { counts, lines, client };
}

describe("sync", () => {
  it("adds a missing open issue and fills its fields, read back from the board", async () => {
    const gh = fakeGitHub({
      issues: [
        issue(10, {
          labels: ["priority: now", "epic"],
          summary: { total: 4, completed: 1, percentCompleted: 25 },
        }),
      ],
    });
    const { counts } = await run(gh);
    expect(counts).toEqual({ added: 1, changed: 1, unchanged: 0, skipped: 0, failed: 0 });
    expect(gh.board.find((b) => b.number === 10)?.values).toEqual({
      Tier: "Now",
      Kind: "Epic",
      "Progress %": 25,
      "Sub-issues done": "1 of 4",
    });
  });

  it("changes nothing on a second run", async () => {
    const gh = fakeGitHub({
      issues: [issue(10, { labels: ["blocked"] }), issue(11, { title: "Spike: y" })],
    });
    await run(gh);
    const writes = gh.mutations.length;
    const { counts } = await run(gh);
    expect(gh.mutations.length).toBe(writes);
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 2, skipped: 0, failed: 0 });
  });

  it("writes only the fields that differ, Area from the area: label, and never Status", async () => {
    const gh = fakeGitHub({
      issues: [issue(20, { labels: ["priority: later", "area: ci"] })],
      items: [
        {
          number: 20,
          values: {
            Tier: "Now",
            Kind: "Issue",
            Status: "Todo",
            Area: "docs",
            "Progress %": 86,
            "Sub-issues done": "6 of 7",
          },
        },
      ],
    });
    const { counts } = await run(gh);
    expect(counts.changed).toBe(1);
    const fieldIds = gh.mutations.map((m) => m.variables.field);
    expect(fieldIds).toEqual(["F_tier", "F_area", "F_progress", "F_done"]);
    expect(gh.board[0].values).toEqual({
      Tier: "Later",
      Kind: "Issue",
      Status: "Todo",
      Area: "ci",
    });
  });

  it("never deletes, never touches an archived item, and leaves items outside the read window alone", async () => {
    const gh = fakeGitHub({
      issues: [
        issue(30, { labels: ["priority: now"] }),
        issue(31, { state: "CLOSED", closedAt: "2026-01-01T00:00:00Z" }),
        issue(32, { state: "CLOSED", closedAt: "2026-10-10T00:00:00Z", labels: ["bug"] }),
        issue(33, { state: "CLOSED", closedAt: "2026-10-10T00:00:00Z" }),
      ],
      items: [
        { number: 30, archived: true, values: { Tier: "Later" } },
        { number: 31, values: { Tier: "Now" } },
        { number: 99, values: { Tier: "Now" } },
        { number: 40, repo: "openzigs/onyourleft", values: {} },
        { number: -1 },
      ],
    });
    const { counts } = await run(gh);
    // #32 is closed and in the window: updated if on the board, but a closed issue is never added.
    expect(gh.mutations.filter((m) => m.query === ADD_ITEM)).toEqual([]);
    expect(gh.mutations).toEqual([]);
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 0, skipped: 3, failed: 0 });
    expect(gh.board.map((b) => [b.number, b.values.Tier])).toEqual([
      [30, "Later"],
      [31, "Now"],
      [99, "Now"],
      [40, undefined],
      [-1, undefined],
    ]);
  });

  it("updates a closed issue already on the board", async () => {
    const gh = fakeGitHub({
      issues: [issue(32, { state: "CLOSED", closedAt: "2026-10-10T00:00:00Z", labels: ["bug"] })],
      items: [{ number: 32, values: {} }],
    });
    await run(gh);
    expect(gh.board[0].values).toEqual({ Tier: "Unranked", Kind: "Bug" });
  });

  it("pages through issues and items", async () => {
    const issues = [1, 2, 3, 4, 5].map((n) => issue(n));
    const gh = fakeGitHub({
      issues,
      items: issues.map((i) => ({ number: i.number, values: { Tier: "Unranked", Kind: "Issue" } })),
      pageSize: 2,
    });
    const { counts } = await run(gh);
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 5, skipped: 0, failed: 0 });
  });

  it("in a dry run prints every planned change, writes nothing, and never prints the token", async () => {
    const gh = fakeGitHub({
      issues: [issue(50, { title: "New thing", labels: ["priority: next"] })],
    });
    const { counts, lines } = await run(gh, { dryRun: true });
    expect(gh.mutations).toEqual([]);
    expect(counts.added).toBe(1);
    expect(lines).toEqual([
      "would add #50 New thing",
      "would set #50 Tier -> Next",
      "would set #50 Kind -> Issue",
      "missing labels: #50 area, type",
      "summary: added 1, changed 1, unchanged 0, skipped 0, failed 0, missing labels 1 (dry run)",
    ]);
    expect(lines.join("\n")).not.toContain(TOKEN);
    // The token travels in the Authorization header and nowhere else.
    for (const r of gh.requests) {
      expect(r.init.headers.Authorization).toBe(`bearer ${TOKEN}`);
      expect(r.init.body).not.toContain(TOKEN);
    }
  });

  it("reports each open issue missing a tier, an area or a type label, without failing", async () => {
    const gh = fakeGitHub({
      issues: [
        // An epic closed long ago, read only as an ancestor: its tier still counts.
        issue(1, { state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", labels: ["priority: next"] }),
        issue(20, { labels: ["epic", "area: ci"], parent: 1 }),
        issue(21, { labels: ["bug", "area: ui"], parent: 20 }),
        issue(22, { labels: ["bug"] }),
        issue(23, { labels: ["priority: later", "area: ci", "testing"] }),
        issue(24, { labels: ["roadmap"] }),
        issue(25, { state: "CLOSED", closedAt: "2026-10-10T00:00:00Z" }),
      ],
    });
    const { counts, lines } = await run(gh);
    expect(counts.failed).toBe(0);
    expect(lines.filter((l) => l.startsWith("missing labels:"))).toEqual([
      "missing labels: #22 tier, area",
    ]);
    expect(lines.at(-1)).toMatch(/, failed 0, missing labels 1$/);
  });

  it("skips a value the board has no option for, and says so", async () => {
    const fields = FIELDS.map((f) =>
      f.name === "Kind" ? { ...f, options: [{ id: "k_Issue", name: "Issue" }] } : f,
    );
    const gh = fakeGitHub({
      issues: [issue(60, { labels: ["bug"] })],
      items: [{ number: 60 }],
      fields,
    });
    const { lines } = await run(gh);
    expect(lines).toContain('skip #60 Kind: no option named "Bug" on the board');
    expect(gh.board[0].values).toEqual({ Tier: "Unranked" });
  });

  it("stops at the write budget and carries the rest to the next run", async () => {
    const issues = Array.from({ length: 205 }, (_, n) => issue(n + 1));
    const gh = fakeGitHub({ issues });
    const { counts, lines } = await run(gh);
    expect(gh.mutations.length).toBe(MAX_MUTATIONS);
    // 133 issues × 3 writes = 399; the 133rd is added and fully written.
    expect(counts.added).toBe(133);
    expect(counts.skipped).toBe(72);
    expect(lines).toContain(
      `write budget of ${MAX_MUTATIONS} reached: 72 issues continue on the next run`,
    );
  });

  it("defers a change, and stops part-way through an item, when the budget runs out", async () => {
    const issues = Array.from({ length: 202 }, (_, n) => issue(n + 1, { labels: ["bug"] }));
    const gh = fakeGitHub({
      issues,
      items: issues.map((i) => ({ number: i.number, values: { Kind: "Issue" } })),
    });
    const { counts } = await run(gh);
    expect(gh.mutations.length).toBe(MAX_MUTATIONS);
    // Two writes each: 199 items done, the 200th stops after its first write, two deferred.
    expect(counts.changed).toBe(200);
    expect(counts.skipped).toBe(2);
    expect(gh.board[199].values).toEqual({ Kind: "Issue", Tier: "Unranked" });
  });

  it("fails clearly when the project or a managed field is missing", async () => {
    await expect(run(fakeGitHub({ issues: [], project: false }))).rejects.toThrow(
      /project openzigs\/2 not found/,
    );
    const noKind = FIELDS.filter((f) => f.name !== "Kind");
    await expect(run(fakeGitHub({ issues: [], fields: noKind }))).rejects.toThrow(
      /no field named "Kind"/,
    );
  });

  it("ignores an issue closed long ago that GitHub returns because it was edited recently", async () => {
    // IssueFilters.since is on updatedAt: a label edit today brings back an issue closed in
    // January. inReadWindow must still drop it, so the board item stays as it is.
    const gh = fakeGitHub({
      issues: [
        issue(31, {
          state: "CLOSED",
          closedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-10-14T00:00:00Z",
          labels: ["priority: now"],
        }),
      ],
      items: [{ number: 31, values: { Tier: "Later" } }],
    });
    const { counts } = await run(gh);
    expect(gh.mutations).toEqual([]);
    expect(gh.board[0].values).toEqual({ Tier: "Later" });
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 0, skipped: 1, failed: 0 });
  });

  it("sets Area from the area: label, the first by name, and clears it when there is none", async () => {
    const gh = fakeGitHub({
      issues: [
        issue(70, { labels: ["area: ui", "area: ci"] }),
        issue(71),
        issue(72, { labels: ["area: ci"] }),
      ],
      items: [
        { number: 70, values: { Tier: "Unranked", Kind: "Issue" } },
        { number: 71, values: { Tier: "Unranked", Kind: "Issue", Area: "ui" } },
        { number: 72, values: { Tier: "Unranked", Kind: "Issue", Area: "ci" } },
      ],
    });
    const { counts } = await run(gh);
    expect(gh.board.map((b) => b.values.Area)).toEqual(["ci", undefined, "ci"]);
    expect(gh.mutations.map((m) => [m.query === CLEAR_VALUE, m.variables.item])).toEqual([
      [false, "PVTI_70"],
      [true, "PVTI_71"],
    ]);
    // No option was missing, so the field itself is never written.
    expect(gh.mutations.some((m) => m.query === UPDATE_FIELD)).toBe(false);
    expect(counts).toEqual({ added: 0, changed: 2, unchanged: 1, skipped: 0, failed: 0 });
  });

  it("adds a missing Area option, keeping every existing option by id so no item loses its Area", async () => {
    const gh = fakeGitHub({
      issues: [
        issue(80, { labels: ["area: ci"] }),
        issue(81, { labels: ["area: ui"] }),
        issue(82, { labels: ["area: security"] }),
        issue(83, { labels: ["area: docs"] }),
      ],
      items: [
        { number: 80, values: { Tier: "Unranked", Kind: "Issue", Area: "ci" } },
        { number: 81, values: { Tier: "Unranked", Kind: "Issue", Area: "ui" } },
      ],
    });
    const { counts, lines } = await run(gh);
    const update = gh.mutations.find((m) => m.query === UPDATE_FIELD);
    expect(update?.variables).toEqual({
      field: "F_area",
      options: [
        { id: "a1", name: "ci", color: "GRAY", description: "CI health and flaky tests" },
        { id: "a2", name: "ui", color: "BLUE", description: "UI and UX" },
        { name: "docs", color: "GRAY", description: "" },
        { name: "security", color: "GRAY", description: "" },
      ],
    });
    expect(lines[0]).toBe("add Area options docs, security");
    // The existing options keep their ids, so the items holding them keep their values.
    const area = gh.fields.find((f) => f.name === "Area");
    expect(area.options.slice(0, 2).map((/** @type {any} */ o) => o.id)).toEqual(["a1", "a2"]);
    expect(gh.board.map((b) => [b.number, b.values.Area])).toEqual([
      [80, "ci"],
      [81, "ui"],
      [82, "security"],
      [83, "docs"],
    ]);
    // The new items are set with the ids GitHub returned for the new options.
    const set82 = gh.mutations.find(
      (m) =>
        m.query === SET_VALUE && m.variables.item === "PVTI_82" && m.variables.field === "F_area",
    );
    const security = area.options.find((/** @type {any} */ o) => o.name === "security");
    expect(set82?.variables.value).toEqual({ singleSelectOptionId: security.id });
    expect(counts).toEqual({ added: 2, changed: 2, unchanged: 2, skipped: 0, failed: 0 });

    // And a second run changes nothing.
    const writes = gh.mutations.length;
    await run(gh);
    expect(gh.mutations.length).toBe(writes);
  });

  it("in a dry run shows the new Area option and the values it would then set", async () => {
    const gh = fakeGitHub({ issues: [issue(90, { labels: ["area: docs"] })] });
    const { lines } = await run(gh, { dryRun: true });
    expect(gh.mutations).toEqual([]);
    expect(lines).toEqual([
      "would add Area options docs",
      "would add #90 Issue 90",
      "would set #90 Tier -> Unranked",
      "would set #90 Kind -> Issue",
      "would set #90 Area -> docs",
      "missing labels: #90 tier, type",
      "summary: added 1, changed 1, unchanged 0, skipped 0, failed 0, missing labels 1 (dry run)",
    ]);
  });

  it("counts an item as changed only when a write happened", async () => {
    // #60's one change has no option on the board, so nothing is written: skipped, not changed.
    const fields = FIELDS.map((f) =>
      f.name === "Kind" ? { ...f, options: [{ id: "k_Issue", name: "Issue" }] } : f,
    );
    const gh = fakeGitHub({
      issues: [issue(60, { labels: ["bug"] })],
      items: [{ number: 60, values: { Tier: "Unranked", Kind: "Issue" } }],
      fields,
    });
    const { counts } = await run(gh);
    expect(gh.mutations).toEqual([]);
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 0, skipped: 1, failed: 0 });
  });

  it("counts an item whose add spent the last of the budget as skipped, and carries it over", async () => {
    // 398 items need one write each; the 399th issue is new, and its add is the 399th write.
    const existing = Array.from({ length: 398 }, (_, n) => issue(n + 1, { labels: ["bug"] }));
    const gh = fakeGitHub({
      issues: [...existing, issue(399)],
      items: existing.map((i) => ({
        number: i.number,
        values: { Tier: "Unranked", Kind: "Issue" },
      })),
    });
    const { counts, lines } = await run(gh);
    expect(gh.mutations.length).toBe(MAX_MUTATIONS);
    expect(counts).toEqual({ added: 1, changed: 398, unchanged: 0, skipped: 1, failed: 0 });
    expect(lines).toContain(
      `write budget of ${MAX_MUTATIONS} reached: 1 issues continue on the next run`,
    );
  });

  it("carries on past a failed write, counts the item as failed, and never logs the token", async () => {
    const gh = fakeGitHub({
      issues: [issue(1, { labels: ["bug"] }), issue(2, { labels: ["bug"] }), issue(3)],
      items: [
        { number: 1, values: { Tier: "Unranked", Kind: "Issue" } },
        { number: 2, values: { Tier: "Unranked", Kind: "Issue" } },
      ],
      // #2's write and #3's add both fail.
      fail: (query, v) => v.item === "PVTI_2" || (query === ADD_ITEM && v.content === "I_3"),
    });
    const { counts, lines } = await run(gh);
    expect(gh.board.map((b) => [b.number, b.values.Kind])).toEqual([
      [1, "Bug"],
      [2, "Issue"],
    ]);
    expect(counts).toEqual({ added: 0, changed: 1, unchanged: 0, skipped: 0, failed: 2 });
    expect(lines).toContain("failed: #2: boom");
    expect(lines).toContain("failed: #3: boom");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("carries on when adding an Area option fails, skipping the values that needed it", async () => {
    const gh = fakeGitHub({
      issues: [issue(1, { labels: ["area: docs"] }), issue(2, { labels: ["area: ci"] })],
      items: [
        { number: 1, values: { Tier: "Unranked", Kind: "Issue" } },
        { number: 2, values: { Tier: "Unranked", Kind: "Issue" } },
      ],
      fail: (query) => query === UPDATE_FIELD,
    });
    const { counts, lines } = await run(gh);
    expect(lines).toContain("failed: add Area options: boom");
    expect(lines).toContain('skip #1 Area: no option named "docs" on the board');
    expect(gh.board.map((b) => b.values.Area)).toEqual([undefined, "ci"]);
    expect(counts).toEqual({ added: 0, changed: 1, unchanged: 0, skipped: 1, failed: 1 });
  });

  it("rethrows an error that is not GitHub's, rather than counting it", async () => {
    const gh = fakeGitHub({ issues: [issue(1)], items: [{ number: 1 }] });
    const { client } = clientFor(gh);
    client.mutate = async () => {
      throw new TypeError("a bug");
    };
    await expect(
      sync({ client, org: "openzigs", project: 2, now: NOW, log: () => {} }),
    ).rejects.toThrow("a bug");
    const gh2 = fakeGitHub({ issues: [issue(1, { labels: ["area: docs"] })] });
    const { client: client2 } = clientFor(gh2);
    client2.mutate = async () => {
      throw new TypeError("another bug");
    };
    await expect(
      sync({ client: client2, org: "openzigs", project: 2, now: NOW, log: () => {} }),
    ).rejects.toThrow("another bug");
  });

  it("inherits Tier from the nearest labelled ancestor, reading ones outside the window", async () => {
    // #101 (open, no label) → #100 (closed in the window, no label) → #10 (closed in January,
    // priority: now). #102 has its own label. #103's chain carries no tier label.
    const gh = fakeGitHub({
      issues: [
        issue(10, {
          state: "CLOSED",
          closedAt: "2026-01-01T00:00:00Z",
          labels: ["priority: now", "epic"],
        }),
        issue(11, { state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", labels: ["epic"] }),
        issue(100, { state: "CLOSED", closedAt: "2026-10-10T00:00:00Z", parent: 10 }),
        issue(101, { parent: 100 }),
        issue(102, { parent: 100, labels: ["priority: later"] }),
        issue(103, { parent: 11 }),
      ],
      items: [100, 101, 102, 103].map((number) => ({ number, values: { Kind: "Issue" } })),
    });
    await run(gh);
    expect(gh.board.map((b) => [b.number, b.values.Tier])).toEqual([
      [100, "Now"],
      [101, "Now"],
      [102, "Later"],
      [103, "Unranked"],
    ]);
    // #10 and #11 are read once each, and decide Tier only: neither is added nor written.
    expect(gh.oneIssueReads()).toBe(2);
    expect(gh.mutations.every((m) => /^PVTI_10[0-3]$/.test(m.variables.item))).toBe(true);
  });

  it("stops at a cycle, a deleted parent and a parent in another repository", async () => {
    const gh = fakeGitHub({
      issues: [
        // #21 ↔ #22, both closed long ago and unlabelled: read once each, then the walk stops.
        issue(21, { state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", parent: 22 }),
        issue(22, { state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", parent: 21 }),
        // #20's own label ends resolveTier's walk at once (its cycle guard is unit-tested with a
        // bounded lookup above); readAncestors still walks the cycle, which this test guards.
        issue(20, { parent: 21, labels: ["priority: next"] }),
        issue(30, { parent: 999 }),
        // #7 here is labelled, but #40's parent #7 lives in another repository.
        issue(7, { state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", labels: ["priority: now"] }),
        issue(40, { parent: 7, parentRepo: "openzigs/onyourleft" }),
      ],
      items: [20, 30, 40].map((number) => ({ number, values: { Kind: "Issue" } })),
    });
    const result = await run(gh).catch((/** @type {Error} */ e) => e);
    // Each of #21, #22 and #999 is read exactly once: a walk that re-reads a cycle trips the
    // fake's cap and lands here as an error, not a hang.
    expect(result).not.toBeInstanceOf(Error);
    expect(gh.board.map((b) => b.values.Tier)).toEqual(["Next", "Unranked", "Unranked"]);
    // #21, #22 and the missing #999; never #7.
    expect(gh.oneIssueReads()).toBe(3);
  });

  it("requires the Area field", async () => {
    const noArea = FIELDS.filter((f) => f.name !== "Area");
    await expect(run(fakeGitHub({ issues: [], fields: noArea }))).rejects.toThrow(
      /no field named "Area"/,
    );
  });
});

describe("createClient", () => {
  /** @param {any} response */
  const respond = (response) => vi.fn(async () => response);

  it("requires a token", () => {
    expect(() => createClient({ token: "", dryRun: false })).toThrow(/GH_TOKEN/);
  });

  it("reports an HTTP error by status and GitHub's message, never the token", async () => {
    const fetchImpl = respond({
      ok: false,
      status: 401,
      json: async () => ({ message: "Bad credentials" }),
    });
    const client = createClient({ token: TOKEN, dryRun: false, fetchImpl });
    const error = await client.query("q", {}).catch((e) => e);
    expect(error.message).toBe("GitHub API HTTP 401 Bad credentials");
    expect(error.message).not.toContain(TOKEN);
  });

  it("reports an unparseable error body, GraphQL errors, no data and an unreachable host", async () => {
    const notJson = respond({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("x");
      },
    });
    await expect(
      createClient({ token: TOKEN, dryRun: false, fetchImpl: notJson }).query("q", {}),
    ).rejects.toThrow(/^GitHub API HTTP 502$/);
    const errors = respond({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "a" }, {}] }),
    });
    await expect(
      createClient({ token: TOKEN, dryRun: false, fetchImpl: errors }).query("q", {}),
    ).rejects.toThrow("a; ?");
    const empty = respond({ ok: true, status: 200, json: async () => ({}) });
    await expect(
      createClient({ token: TOKEN, dryRun: false, fetchImpl: empty }).query("q", {}),
    ).rejects.toThrow(/no data/);
    const down = vi.fn(async () => {
      throw new TypeError(`fetch failed for bearer ${"x"}`);
    });
    await expect(
      createClient({ token: TOKEN, dryRun: false, fetchImpl: down }).query("q", {}),
    ).rejects.toThrow(/unreachable: fetch failed/);
    const odd = vi.fn(async () => {
      throw "string";
    });
    await expect(
      createClient({ token: TOKEN, dryRun: false, fetchImpl: odd }).query("q", {}),
    ).rejects.toThrow(/unreachable: \?/);
  });

  it("throttles writes to one a second, counts them, and writes nothing in a dry run", async () => {
    const fetchImpl = respond({ ok: true, status: 200, json: async () => ({ data: { x: 1 } }) });
    const sleep = vi.fn(async () => {});
    let t = 0;
    const clock = () => t;
    const log = vi.fn();
    const client = createClient({ token: TOKEN, dryRun: false, fetchImpl, sleep, clock, log });
    expect(await client.mutate("first", "m", {})).toEqual({ x: 1 });
    t = 300;
    await client.mutate("second", "m", {});
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(700);
    expect(client.mutations).toBe(2);
    expect(log.mock.calls).toEqual([["first"], ["second"]]);

    const dry = createClient({ token: TOKEN, dryRun: true, fetchImpl: respond(null), log });
    expect(await dry.mutate("third", "m", {})).toBeNull();
    expect(dry.mutations).toBe(0);
    expect(log).toHaveBeenLastCalledWith("would third");
  });
});

describe("scripts/sync-roadmap.mjs", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "sync-roadmap.mjs");
  /** @param {string[]} args @param {Record<string, string>} env */
  const runScript = (args, env) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
      timeout: 15_000,
    });

  it("exits 2 on bad arguments and on a missing token", () => {
    const bad = runScript(["--org", "openzigs"], { GH_TOKEN: TOKEN });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--project");
    const noToken = runScript(["--org", "openzigs", "--project", "2", "--dry-run"], {});
    expect(noToken.status).toBe(2);
    expect(noToken.stderr).toContain("set GH_TOKEN or GITHUB_TOKEN");
  });
});

describe("main", () => {
  const argv = ["--org", "openzigs", "--project", "2"];
  /** @param {ReturnType<typeof fakeGitHub>} gh @param {Record<string, string>} env @param {string[]} [args] */
  async function cli(gh, env, args = argv) {
    const out = /** @type {string[]} */ ([]);
    const err = /** @type {string[]} */ ([]);
    const code = await main({
      argv: args,
      env,
      now: NOW,
      fetchImpl: /** @type {any} */ (gh.impl),
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    });
    return { code, out, err };
  }

  it("exits 0 when issues are missing labels: the check is a report, not a failure", async () => {
    // Already on the board with every value, so the run writes nothing and never waits.
    const values = { Tier: "Unranked", Kind: "Issue" };
    const gh = fakeGitHub({
      issues: [issue(1), issue(2, { labels: ["bug"] })],
      items: [
        { number: 1, values },
        { number: 2, values: { ...values, Kind: "Bug" } },
      ],
    });
    const { code, out, err } = await cli(gh, { GH_TOKEN: TOKEN });
    expect(gh.mutations).toEqual([]);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toContain("missing labels: #1 tier, area, type");
    expect(out).toContain("missing labels: #2 tier, area");
  });

  it("exits 0 on a clean run, reading the token from GH_TOKEN or GITHUB_TOKEN", async () => {
    const gh = fakeGitHub({ issues: [issue(1)] });
    expect((await cli(gh, { GH_TOKEN: TOKEN })).code).toBe(0);
    expect((await cli(gh, { GITHUB_TOKEN: TOKEN })).code).toBe(0);
  });

  it("exits 1 when any write failed, after the whole run, without the token", async () => {
    const gh = fakeGitHub({
      issues: [issue(1), issue(2)],
      fail: (query, v) => query === ADD_ITEM && v.content === "I_1",
    });
    const { code, out, err } = await cli(gh, { GH_TOKEN: TOKEN });
    expect(code).toBe(1);
    expect(gh.board.map((b) => b.number)).toEqual([2]);
    expect(err).toEqual(['sync-roadmap: 1 write(s) failed; see the lines starting "failed:"']);
    expect([...out, ...err].join("\n")).not.toContain(TOKEN);
  });

  it("exits 1 on a failed read, and 2 on bad arguments or no token", async () => {
    const gh = fakeGitHub({ issues: [], project: false });
    const read = await cli(gh, { GH_TOKEN: TOKEN });
    expect(read.code).toBe(1);
    expect(read.err[0]).toMatch(/^sync-roadmap: project openzigs\/2 not found/);
    expect((await cli(gh, { GH_TOKEN: TOKEN }, ["--org", "openzigs"])).code).toBe(2);
    const none = await cli(gh, {});
    expect(none.code).toBe(2);
    expect(none.err).toEqual(["sync-roadmap: set GH_TOKEN or GITHUB_TOKEN"]);
  });

  it("rethrows an error that is not GitHub's", async () => {
    const boom = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { organization: { projectV2: { id: "P", fields: null } } } }),
    }));
    await expect(
      main({
        argv,
        env: { GH_TOKEN: TOKEN },
        fetchImpl: /** @type {any} */ (boom),
        log: () => {},
        error: () => {},
      }),
    ).rejects.toThrow(TypeError);
  });
});

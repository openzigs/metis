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
  PROJECT_QUERY,
  SET_VALUE,
  createClient,
  desiredFields,
  encodeValue,
  fieldChanges,
  inReadWindow,
  kindOf,
  parseArgs,
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

  it("never names Area or Status", () => {
    const fields = desiredFields(issue(1, { labels: ["priority: now", "bug"] }));
    expect(fields).toEqual({
      Tier: "Now",
      Kind: "Bug",
      "Progress %": null,
      "Sub-issues done": null,
    });
  });
});

describe("fieldChanges", () => {
  const desired = { Tier: "Now", Kind: "Epic", "Progress %": 50, "Sub-issues done": "1 of 2" };

  it("returns nothing when the board holds every value, ignoring unmanaged fields", () => {
    expect(
      fieldChanges(desired, { ...desired, "Progress %": 50.0, Area: "ci", Status: "Todo" }),
    ).toEqual([]);
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
    expect(summaryLine({ added: 1, changed: 2, unchanged: 3, skipped: 4 })).toBe(
      "summary: added 1, changed 2, unchanged 3, skipped 4",
    );
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
 * @param {Partial<{ number: number, title: string, state: string, closedAt: string | null,
 *   labels: string[], summary: any }>} [over]
 * @param {number} number
 */
function issue(number, over = {}) {
  return {
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    state: "OPEN",
    closedAt: null,
    labels: [],
    summary: null,
    ...over,
  };
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
  { id: "F_area", name: "Area", dataType: "SINGLE_SELECT", options: [{ id: "a1", name: "ci" }] },
  {},
];

/**
 * An in-memory board behind a fake `fetch`: mutations change it, so a second run reads back
 * what the first one wrote — the same path a real consumer uses.
 *
 * @param {{ issues: ReturnType<typeof issue>[], items?: Array<{ number: number, archived?: boolean,
 *   values?: Record<string, any>, repo?: string }>, fields?: any[], project?: boolean, pageSize?: number }} opts
 */
function fakeGitHub({ issues, items = [], fields = FIELDS, project = true, pageSize = 100 }) {
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
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (query === PROJECT_QUERY) {
      return ok({
        organization: { projectV2: project ? { id: "PVT_1", fields: { nodes: fields } } : null },
      });
    }
    if (query === ISSUES_QUERY) {
      const f = variables.filter;
      const matching = issues.filter(
        (i) => f.states.includes(i.state) && (!f.since || (i.closedAt ?? "") >= f.since),
      );
      const p = page(matching, variables.after);
      return ok({ repository: { issues: { ...p, nodes: p.nodes.map(issueNode) } } });
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

  return { impl, board, mutations, requests };
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
    expect(counts).toEqual({ added: 1, changed: 1, unchanged: 0, skipped: 0 });
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
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 2, skipped: 0 });
  });

  it("writes only the fields that differ, and never Status or Area", async () => {
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
    expect(fieldIds).toEqual(["F_tier", "F_progress", "F_done"]);
    expect(gh.board[0].values).toEqual({
      Tier: "Later",
      Kind: "Issue",
      Status: "Todo",
      Area: "docs",
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
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 0, skipped: 3 });
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
    expect(counts).toEqual({ added: 0, changed: 0, unchanged: 5, skipped: 0 });
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
      "summary: added 1, changed 1, unchanged 0, skipped 0 (dry run)",
    ]);
    expect(lines.join("\n")).not.toContain(TOKEN);
    // The token travels in the Authorization header and nowhere else.
    for (const r of gh.requests) {
      expect(r.init.headers.Authorization).toBe(`bearer ${TOKEN}`);
      expect(r.init.body).not.toContain(TOKEN);
    }
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

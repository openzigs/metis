/**
 * #1147 — keep the METIS roadmap board (https://github.com/orgs/openzigs/projects/2) in step
 * with the issues. A port of On Your Left's `scripts/sync-roadmap.py` (openzigs/onyourleft#1348,
 * merged in openzigs/onyourleft#1359 at 74ab113a), written as a Node module so it runs under this
 * repository's own gate (`pnpm test`, vitest, the 80% floor) with no new dependency. The env/argv
 * glue is `scripts/sync-roadmap.mjs`; the workflow that runs it nightly is
 * `.github/workflows/roadmap.yml`; the reader's version is `docs/ops/roadmap-board.md`.
 *
 * What a run does, in order:
 *   1. Reads every issue in openzigs/metis that is open or was closed in the last 30 days — labels,
 *      state, parent, sub-issue summary — paged by 100. Pull requests are not issues and are never
 *      read. Then reads, one by one, each ancestor outside that set (an epic closed long ago), so a
 *      Tier chain resolves; ancestors decide Tier and nothing else.
 *   2. Reads every item already on the board, once, into a map.
 *   3. ADDS to the board's Area single-select any `area:` label name it has no option for, keeping
 *      every existing option by id (so no item loses its Area).
 *   4. ADDS every open issue that is not on the board. Never deletes, never archives, and leaves an
 *      archived item, and an item outside what it read, exactly as they are.
 *   5. SETS Tier, Kind, Area, Progress % and Sub-issues done, only where the value differs. NEVER
 *      touches Status (GitHub's built-in workflows own it).
 *
 * How METIS differs from On Your Left, deliberately:
 *   - Tier is the issue's own label (`priority: now|next|later`, then `blocked`), else the nearest
 *     ancestor's, else Unranked — On Your Left's `resolve_tier`, kept as merged per the owner's
 *     correction of 2026-10-15 on #1147. `priority: high` is a SEVERITY label here, not a tier, so
 *     it sets nothing and is not inherited.
 *   - Area comes from the `area:` label, as On Your Left's does (the owner's correction of
 *     2026-10-15 on #1147); the board's Area field must exist, it is never created.
 *   - Kind counts a title starting "Research" as a Spike: METIS names its spikes that way (#263).
 *   - No weekly status update: #1147 does not ask for one.
 *
 * One failed write does not end the run: the item is counted as failed and the run carries on;
 * the CLI then exits non-zero. A failed READ still ends the run, since nothing after it is sound.
 *
 * Writes are throttled to about one a second and capped below 400 a run (GitHub's secondary limit
 * is about 80 content-creating requests a minute and 500 an hour). Running it twice changes nothing
 * the second time: `addProjectV2ItemById` on an issue already on the board returns the same item
 * (measured on openzigs/onyourleft#1348), and every field write is skipped when the board already
 * holds the value.
 *
 * The token goes in one request header and nowhere else: never printed, never logged, never in an
 * error message.
 */

export const REPOSITORY = "openzigs/metis";
export const CLOSED_WINDOW_DAYS = 30;
export const MAX_MUTATIONS = 399;
export const MUTATION_INTERVAL_MS = 1000;
export const API_URL = "https://api.github.com/graphql";

/** Precedence is the field's option order: the first of these an issue carries wins. */
export const TIER_BY_LABEL = /** @type {const} */ ([
  ["priority: now", "Now"],
  ["priority: next", "Next"],
  ["priority: later", "Later"],
  ["blocked", "Blocked"],
]);
export const UNRANKED = "Unranked";

export const AREA_PREFIX = "area:";

export const TIER = "Tier";
export const KIND = "Kind";
export const AREA = "Area";
export const PROGRESS = "Progress %";
export const SUBS_DONE = "Sub-issues done";
/** The order fields are written in, and the ONLY fields this script ever writes. */
export const MANAGED_FIELDS = /** @type {const} */ ([TIER, KIND, AREA, PROGRESS, SUBS_DONE]);

/**
 * @typedef {{ total: number, completed: number, percentCompleted: number }} SubIssuesSummary
 * @typedef {{
 *   id: string, number: number, title: string, state: string, closedAt: string | null,
 *   labels: string[], summary: SubIssuesSummary | null, parent: number | null
 * }} Issue
 * @typedef {string | number | null} FieldValue
 * @typedef {{ id: string | null, archived: boolean, values: Record<string, FieldValue> }} Item
 * @typedef {{ id: string | null, name: string, color?: string, description?: string }} Option
 * @typedef {{ id: string | null, name: string, dataType?: string, options?: Option[] }} Field
 * @typedef {{ added: number, changed: number, unchanged: number, skipped: number, failed: number }} Counts
 */

// --- Decisions (pure) -------------------------------------------------------------------------

/**
 * The Tier an issue's own labels give it, or null when none applies.
 *
 * @param {string[]} labels
 * @returns {string | null}
 */
export function ownTier(labels) {
  const names = new Set(labels);
  for (const [label, tier] of TIER_BY_LABEL) {
    if (names.has(label)) return tier;
  }
  return null;
}

/**
 * Own label first, else the nearest ancestor's, else Unranked. A parent that is not in `lookup`
 * ends the walk, and so does a cycle, which GitHub should not allow but costs nothing to refuse.
 *
 * @param {number} number
 * @param {Map<number, Pick<Issue, "number" | "labels" | "parent">>} lookup
 * @returns {string}
 */
export function resolveTier(number, lookup) {
  const seen = new Set();
  let current = lookup.get(number);
  while (current && !seen.has(current.number)) {
    seen.add(current.number);
    const tier = ownTier(current.labels);
    if (tier) return tier;
    current = current.parent == null ? undefined : lookup.get(current.parent);
  }
  return UNRANKED;
}

/**
 * The Tier an issue's own labels give it; Unranked when none applies.
 *
 * @param {string[]} labels
 * @returns {string}
 */
export function tierOf(labels) {
  return ownTier(labels) ?? UNRANKED;
}

/**
 * `epic` label → Epic; title starting "Spike" or "Research" → Spike; `bug` label → Bug; else Issue.
 *
 * @param {{ title: string, labels: string[] }} issue
 * @returns {string}
 */
export function kindOf(issue) {
  const labels = new Set(issue.labels);
  if (labels.has("epic")) return "Epic";
  if (/^\s*(spike|research)\b/i.test(issue.title)) return "Spike";
  if (labels.has("bug")) return "Bug";
  return "Issue";
}

/**
 * `area: run-state` → `run-state`; null when the issue has no `area:` label. Several: the first by
 * name, so it is stable.
 *
 * @param {string[]} labels
 * @returns {string | null}
 */
export function areaOf(labels) {
  const areas = labels
    .filter((label) => label.startsWith(AREA_PREFIX))
    .map((label) => label.slice(AREA_PREFIX.length).trim())
    .filter(Boolean)
    .sort();
  return areas[0] ?? null;
}

/**
 * Area names some issue needs that the field has no option for, sorted.
 *
 * @param {Iterable<{ labels: string[] }>} issues
 * @param {string[]} optionNames
 * @returns {string[]}
 */
export function missingAreaOptions(issues, optionNames) {
  const have = new Set(optionNames);
  const missing = new Set();
  for (const issue of issues) {
    const area = areaOf(issue.labels);
    if (area && !have.has(area)) missing.add(area);
  }
  return [...missing].sort();
}

/**
 * [Progress %, Sub-issues done] from `subIssuesSummary`; [null, null] clears both.
 *
 * @param {SubIssuesSummary | null | undefined} summary
 * @returns {[number | null, string | null]}
 */
export function progressOf(summary) {
  if (!summary || !summary.total) return [null, null];
  return [summary.percentCompleted, `${summary.completed} of ${summary.total}`];
}

/**
 * @param {Issue} issue
 * @param {Map<number, Issue>} [lookup] the read issues and their ancestors, for Tier
 * @returns {Record<string, FieldValue>}
 */
export function desiredFields(issue, lookup = new Map([[issue.number, issue]])) {
  const [progress, done] = progressOf(issue.summary);
  return {
    [TIER]: resolveTier(issue.number, lookup),
    [KIND]: kindOf(issue),
    [AREA]: areaOf(issue.labels),
    [PROGRESS]: progress,
    [SUBS_DONE]: done,
  };
}

/**
 * Every managed field whose value differs, in write order; a null value clears. An absent value
 * and null are the same (an empty field); JSON numbers compare exactly (86 vs 85 differs).
 *
 * @param {Record<string, FieldValue>} desired
 * @param {Record<string, FieldValue>} current
 * @returns {Array<[string, FieldValue]>}
 */
export function fieldChanges(desired, current) {
  return MANAGED_FIELDS.filter(
    (field) => (desired[field] ?? null) !== (current[field] ?? null),
  ).map((field) => [field, desired[field]]);
}

/** @param {Pick<Issue, "state">} issue */
export function shouldAdd(issue) {
  return issue.state === "OPEN";
}

/**
 * Open, or closed within the window.
 *
 * @param {Pick<Issue, "state" | "closedAt">} issue
 * @param {Date} now
 */
export function inReadWindow(issue, now) {
  if (issue.state === "OPEN") return true;
  if (!issue.closedAt) return false;
  const closed = Date.parse(issue.closedAt);
  return !Number.isNaN(closed) && now.getTime() - closed <= CLOSED_WINDOW_DAYS * 86_400_000;
}

/**
 * The `value` argument of `updateProjectV2ItemFieldValue`, or null when a single-select field has
 * no option of that name (the board was edited by hand; the item is left alone, said so in the log).
 *
 * @param {Field} field
 * @param {string | number} value
 * @returns {Record<string, string | number | null> | null} a null option id only in a dry run,
 *   for an option the run would have added
 */
export function encodeValue(field, value) {
  if (field.dataType === "NUMBER") return { number: Number(value) };
  if (field.dataType === "TEXT") return { text: String(value) };
  const option = (field.options ?? []).find((o) => o.name === value);
  return option ? { singleSelectOptionId: option.id } : null;
}

/** @param {Counts} counts */
export function summaryLine(counts) {
  return `summary: added ${counts.added}, changed ${counts.changed}, unchanged ${counts.unchanged}, skipped ${counts.skipped}, failed ${counts.failed}`;
}

/**
 * @param {string[]} argv
 * @returns {{ org: string, project: number, dryRun: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ org: string, project: number, dryRun: boolean }} */
  const out = { org: "", project: Number.NaN, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--org") out.org = argv[++i] ?? "";
    else if (arg === "--project") out.project = Number(argv[++i]);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!/^[A-Za-z0-9-]+$/.test(out.org)) throw new Error("--org <login> is required");
  if (!Number.isInteger(out.project) || out.project < 1) {
    throw new Error("--project <number> is required");
  }
  return out;
}

// --- I/O --------------------------------------------------------------------------------------

export class GraphQLError extends Error {}

/**
 * A GraphQL client that writes at most MAX_MUTATIONS a run, one a second, and in a dry run only
 * prints what it would write.
 *
 * @param {{
 *   token: string, dryRun: boolean, fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>, clock?: () => number, log?: (line: string) => void
 * }} opts
 */
export function createClient({
  token,
  dryRun,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => performance.now(),
  log = (line) => console.log(line),
}) {
  if (!token) throw new GraphQLError("set GH_TOKEN or GITHUB_TOKEN");
  let mutations = 0;
  let last = Number.NEGATIVE_INFINITY;

  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   * @returns {Promise<any>}
   */
  async function post(query, variables) {
    let res;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: {
          Authorization: `bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "metis-sync-roadmap",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      // The cause's message only; never the request, whose headers hold the token.
      throw new GraphQLError(
        `GitHub API unreachable: ${error instanceof Error ? error.message : "?"}`,
      );
    }
    /** @type {any} */
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      throw new GraphQLError(
        `GitHub API HTTP ${res.status} ${String(payload?.message ?? "")}`.trim(),
      );
    }
    if (payload?.errors?.length) {
      throw new GraphQLError(
        payload.errors.map((/** @type {any} */ e) => e?.message ?? "?").join("; "),
      );
    }
    if (!payload?.data) throw new GraphQLError("GitHub API returned no data");
    return payload.data;
  }

  return {
    dryRun,
    get mutations() {
      return mutations;
    },
    /** @param {string} query @param {Record<string, unknown>} variables */
    query(query, variables) {
      return post(query, variables);
    },
    budgetLeft() {
      return mutations < MAX_MUTATIONS;
    },
    /**
     * Prints the change; in a dry run that is all it does.
     *
     * @param {string} description @param {string} query @param {Record<string, unknown>} variables
     */
    async mutate(description, query, variables) {
      log((dryRun ? "would " : "") + description);
      if (dryRun) return null;
      const wait = MUTATION_INTERVAL_MS - (clock() - last);
      if (wait > 0) await sleep(wait);
      mutations += 1;
      try {
        return await post(query, variables);
      } finally {
        last = clock();
      }
    },
  };
}

/** @typedef {ReturnType<typeof createClient>} Client */

const ISSUE_FIELDS = `
        id number title state closedAt
        labels(first: 50) { nodes { name } }
        parent { number repository { nameWithOwner } }
        subIssuesSummary { total completed percentCompleted }`;

export const ISSUES_QUERY = `
query($owner: String!, $name: String!, $after: String, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, filterBy: $filter, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {${ISSUE_FIELDS}
      }
    }
  }
}`;

export const ONE_ISSUE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {${ISSUE_FIELDS}
    }
  }
}`;

export const PROJECT_QUERY = `
query($org: String!, $number: Int!) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name color description } }
        }
      }
    }
  }
}`;

export const ITEMS_QUERY = `
query($org: String!, $number: Int!, $after: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      items(first: 100, after: $after, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isArchived
          content { ... on Issue { number repository { nameWithOwner } } }
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
            }
          }
        }
      }
    }
  }
}`;

export const ADD_ITEM = `
mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } }
}`;

export const SET_VALUE = `
mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: $value}) {
    projectV2Item { id }
  }
}`;

/**
 * Replaces the field's WHOLE option list: an existing option must be sent back with its id, or it
 * becomes a new option and every item that held the old one is emptied.
 */
export const UPDATE_FIELD = `
mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
  updateProjectV2Field(input: {fieldId: $field, singleSelectOptions: $options}) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name dataType options { id name color description } } }
  }
}`;

export const CLEAR_VALUE = `
mutation($project: ID!, $item: ID!, $field: ID!) {
  clearProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field}) {
    projectV2Item { id }
  }
}`;

/**
 * A parent in another repository is dropped: its number means a different issue here.
 *
 * @param {any} node
 * @param {string} repository
 * @returns {Issue}
 */
function issueFromNode(node, repository) {
  const parent = node.parent;
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    state: node.state,
    closedAt: node.closedAt ?? null,
    labels: (node.labels?.nodes ?? []).map((/** @type {{ name: string }} */ l) => l.name),
    summary: node.subIssuesSummary ?? null,
    parent:
      typeof parent?.number === "number" && parent.repository?.nameWithOwner === repository
        ? parent.number
        : null,
  };
}

/**
 * Open issues, and issues closed in the window, by number.
 *
 * @param {Client} client
 * @param {string} repository owner/name
 * @param {Date} now
 * @returns {Promise<Map<number, Issue>>}
 */
export async function readIssues(client, repository, now) {
  const [owner, name] = repository.split("/");
  const since = new Date(now.getTime() - CLOSED_WINDOW_DAYS * 86_400_000).toISOString();
  // A close updates the issue, so `since` (on updatedAt) catches every close in the window;
  // inReadWindow then drops the ones only edited in it.
  const filters = [{ states: ["OPEN"] }, { states: ["CLOSED"], since }];
  /** @type {Map<number, Issue>} */
  const issues = new Map();
  for (const filter of filters) {
    /** @type {string | null} */
    let after = null;
    for (;;) {
      const data = await client.query(ISSUES_QUERY, { owner, name, after, filter });
      const page = data.repository.issues;
      for (const node of page.nodes) {
        const issue = issueFromNode(node, repository);
        if (inReadWindow(issue, now)) issues.set(issue.number, issue);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
  }
  return issues;
}

/**
 * Ancestors outside the read set, kept apart: they decide Tier, nothing else. Each is read once;
 * a parent already read, or one that no longer exists, ends that branch, so a cycle cannot loop.
 *
 * @param {Client} client
 * @param {string} repository owner/name
 * @param {Map<number, Issue>} issues
 * @returns {Promise<Map<number, Issue>>}
 */
export async function readAncestors(client, repository, issues) {
  const [owner, name] = repository.split("/");
  /** @type {Map<number, Issue>} */
  const ancestors = new Map();
  /** @type {number[]} */
  const pending = [];
  for (const issue of issues.values()) if (issue.parent != null) pending.push(issue.parent);
  while (pending.length) {
    const number = /** @type {number} */ (pending.pop());
    if (issues.has(number) || ancestors.has(number)) continue;
    const data = await client.query(ONE_ISSUE_QUERY, { owner, name, number });
    const node = data.repository?.issue;
    if (!node) continue;
    const ancestor = issueFromNode(node, repository);
    ancestors.set(number, ancestor);
    if (ancestor.parent != null) pending.push(ancestor.parent);
  }
  return ancestors;
}

/**
 * This repository's issues on the board: number → item, with each field's value by field name.
 *
 * @param {Client} client
 * @param {string} org
 * @param {number} number
 * @param {string} repository
 * @returns {Promise<Map<number, Item>>}
 */
export async function readItems(client, org, number, repository) {
  /** @type {Map<number, Item>} */
  const items = new Map();
  /** @type {string | null} */
  let after = null;
  for (;;) {
    const data = await client.query(ITEMS_QUERY, { org, number, after });
    const page = data.organization.projectV2.items;
    for (const node of page.nodes) {
      const content = node.content ?? {};
      if (typeof content.number !== "number" || content.repository?.nameWithOwner !== repository)
        continue;
      /** @type {Record<string, FieldValue>} */
      const values = {};
      for (const value of node.fieldValues?.nodes ?? []) {
        const field = value?.field?.name;
        if (!field) continue;
        for (const key of ["name", "number", "text"]) {
          if (key in value) values[field] = value[key];
        }
      }
      items.set(content.number, { id: node.id, archived: Boolean(node.isArchived), values });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return items;
}

/**
 * Adds an Area option for every `area:` label name the board has none for. Every existing option
 * is sent back with its id, colour and description, so no item loses its value; the field is then
 * replaced in `fields` by what GitHub returns, so the new options' ids are the real ones.
 *
 * @param {Client} client
 * @param {Map<string, Field>} fields
 * @param {Iterable<Issue>} issues
 */
export async function ensureAreaOptions(client, fields, issues) {
  const field = /** @type {Field} */ (fields.get(AREA));
  const have = field.options ?? [];
  const missing = missingAreaOptions(
    issues,
    have.map((o) => o.name),
  );
  if (missing.length === 0 || !client.budgetLeft()) return;
  const options = [
    ...have.map((o) => ({
      id: o.id,
      name: o.name,
      color: o.color || "GRAY",
      description: o.description ?? "",
    })),
    ...missing.map((name) => ({ name, color: "GRAY", description: "" })),
  ];
  const data = await client.mutate(`add Area options ${missing.join(", ")}`, UPDATE_FIELD, {
    field: field.id,
    options,
  });
  const result = data?.updateProjectV2Field?.projectV2Field;
  if (result) {
    fields.set(AREA, { ...result, name: AREA, dataType: "SINGLE_SELECT" });
  } else if (client.dryRun) {
    // So a dry run shows the values it would then set.
    fields.set(AREA, {
      ...field,
      options: [...have, ...missing.map((name) => ({ id: null, name }))],
    });
  }
}

/**
 * One issue's add and writes. Returns what to count it as, and whether it was deferred by the
 * write budget. A write that throws propagates to the caller, which counts the item as failed.
 *
 * @param {{ client: Client, projectId: string, fields: Map<string, Field>, issue: Issue,
 *   lookup: Map<number, Issue>, item: Item | undefined, log: (line: string) => void, counts: Counts }} ctx
 * @returns {Promise<{ outcome: "changed" | "unchanged" | "skipped" | "ignored", deferred: boolean }>}
 */
async function syncOne({ client, projectId, fields, issue, lookup, item, log, counts }) {
  const { number } = issue;
  if (item?.archived) return { outcome: "skipped", deferred: false };
  if (!item) {
    if (!shouldAdd(issue)) return { outcome: "ignored", deferred: false };
    if (!client.budgetLeft()) return { outcome: "skipped", deferred: true };
    const data = await client.mutate(`add #${number} ${issue.title}`, ADD_ITEM, {
      project: projectId,
      content: issue.id,
    });
    item = { id: data?.addProjectV2ItemById?.item?.id ?? null, archived: false, values: {} };
    counts.added += 1;
  }
  const changes = fieldChanges(desiredFields(issue, lookup), item.values);
  if (changes.length === 0) return { outcome: "unchanged", deferred: false };
  let writes = 0;
  let deferred = false;
  for (const [fieldName, value] of changes) {
    if (!client.budgetLeft()) {
      deferred = true;
      break;
    }
    const field = /** @type {Field} */ (fields.get(fieldName));
    const label = `#${number} ${fieldName} -> ${value == null ? "(clear)" : value}`;
    if (value == null) {
      await client.mutate(`set ${label}`, CLEAR_VALUE, {
        project: projectId,
        item: item.id,
        field: field.id,
      });
      writes += 1;
      continue;
    }
    const encoded = encodeValue(field, value);
    if (!encoded) {
      log(`skip #${number} ${fieldName}: no option named ${JSON.stringify(value)} on the board`);
      continue;
    }
    await client.mutate(`set ${label}`, SET_VALUE, {
      project: projectId,
      item: item.id,
      field: field.id,
      value: encoded,
    });
    writes += 1;
  }
  // Changed only if a write happened; an item whose every change was skipped or deferred is not.
  return { outcome: writes > 0 ? "changed" : "skipped", deferred: writes === 0 && deferred };
}

/**
 * @param {{
 *   client: Client, org: string, project: number, now: Date,
 *   repository?: string, log?: (line: string) => void
 * }} opts
 * @returns {Promise<Counts>}
 */
export async function sync({
  client,
  org,
  project: projectNumber,
  now,
  repository = REPOSITORY,
  log = console.log,
}) {
  const project = (await client.query(PROJECT_QUERY, { org, number: projectNumber })).organization
    ?.projectV2;
  if (!project) {
    throw new GraphQLError(`project ${org}/${projectNumber} not found, or the token cannot see it`);
  }
  /** @type {Map<string, Field>} */
  const fields = new Map();
  for (const f of project.fields.nodes) if (f?.name) fields.set(f.name, f);
  for (const name of MANAGED_FIELDS) {
    if (!fields.has(name)) {
      throw new GraphQLError(
        `the board has no field named ${JSON.stringify(name)} (docs/ops/roadmap-board.md)`,
      );
    }
  }

  const issues = await readIssues(client, repository, now);
  /** @type {Map<number, Issue>} */
  const lookup = new Map([...(await readAncestors(client, repository, issues)), ...issues]);
  const items = await readItems(client, org, projectNumber, repository);

  /** @type {Counts} */
  const counts = { added: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0 };
  try {
    await ensureAreaOptions(client, fields, issues.values());
  } catch (error) {
    if (!(error instanceof GraphQLError)) throw error;
    // The items that needed a new option are then skipped, said so, by encodeValue.
    counts.failed += 1;
    log(`failed: add Area options: ${error.message}`);
  }

  let deferred = 0;
  for (const number of [...issues.keys()].sort((a, b) => a - b)) {
    const issue = /** @type {Issue} */ (issues.get(number));
    try {
      const result = await syncOne({
        client,
        projectId: project.id,
        fields,
        issue,
        lookup,
        item: items.get(number),
        log,
        counts,
      });
      if (result.deferred) deferred += 1;
      if (result.outcome !== "ignored") counts[result.outcome] += 1;
    } catch (error) {
      // GraphQLError messages are built from GitHub's response only, never the request's headers.
      if (!(error instanceof GraphQLError)) throw error;
      counts.failed += 1;
      log(`failed: #${number}: ${error.message}`);
    }
  }

  // On the board but outside the read window: left exactly as they are.
  for (const number of items.keys()) if (!issues.has(number)) counts.skipped += 1;

  if (deferred) {
    log(`write budget of ${MAX_MUTATIONS} reached: ${deferred} issues continue on the next run`);
  }
  log(summaryLine(counts) + (client.dryRun ? " (dry run)" : ""));
  return counts;
}

/**
 * The CLI: 2 on bad arguments or a missing token; 1 on a failed read, or when any write failed;
 * 0 otherwise. Errors go to `error`, prefixed; the token is never in one.
 *
 * @param {{ argv: string[], env: Record<string, string | undefined>, now?: Date,
 *   fetchImpl?: typeof fetch, log?: (line: string) => void, error?: (line: string) => void }} opts
 * @returns {Promise<number>}
 */
export async function main({
  argv,
  env,
  now = new Date(),
  fetchImpl,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    error(`sync-roadmap: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || "";
  if (!token) {
    error("sync-roadmap: set GH_TOKEN or GITHUB_TOKEN");
    return 2;
  }
  try {
    const client = createClient({ token, dryRun: args.dryRun, fetchImpl, log });
    const counts = await sync({ client, org: args.org, project: args.project, now, log });
    if (counts.failed > 0) {
      error(`sync-roadmap: ${counts.failed} write(s) failed; see the lines starting "failed:"`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (!(e instanceof GraphQLError)) throw e;
    error(`sync-roadmap: ${e.message}`);
    return 1;
  }
}

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
 *      every existing option by id (so no item loses its Area). APPENDS Cycle iterations when none
 *      covers today or follows it, keeping every existing iteration by id, behind three guards
 *      (see ensureCycles; #1190).
 *   4. Reads every epic's sub-issues whole, closed long ago or not, for the epic's Started (#1190).
 *   5. ADDS every open issue that is not on the board. Never deletes, never archives, and leaves an
 *      archived item, and an item outside what it read, exactly as they are.
 *   6. SETS Tier, Kind, Area, Progress %, Sub-issues done, Started, Finished and Cycle, only where
 *      the value differs. Status is GitHub's (its built-in workflows own it) with ONE exception
 *      (#1190): an open epic with a sub-issue closed as completed, or In Progress, is promoted to
 *      In Progress, only from empty or Todo, and re-read just before the write.
 *   7. REPORTS every open issue missing a tier (its own or an ancestor's), an `area:` label or a type
 *      label (#1181), one `missing labels:` line each and a count in the summary; and a missing
 *      Started, Finished or Cycle field, or a missing current or next cycle, one `board:` line each.
 *      A report only: it never fails the run and never writes a label.
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

/** #1181: every issue carries one of these; `feature` is accepted beside `enhancement`. */
export const TYPE_LABELS = /** @type {const} */ ([
  "bug",
  "enhancement",
  "feature",
  "epic",
  "documentation",
  "testing",
  "dependencies",
]);
/** The roadmap plan issue (#1146) carries this label and is exempt from the label check. */
export const EXEMPT_LABEL = "roadmap";

export const TIER = "Tier";
export const KIND = "Kind";
export const AREA = "Area";
export const PROGRESS = "Progress %";
export const SUBS_DONE = "Sub-issues done";
export const STARTED = "Started";
export const FINISHED = "Finished";
export const CYCLE = "Cycle";
export const STATUS = "Status";
export const IN_PROGRESS = "In Progress";
export const EPIC_LABEL = "epic";
/** #1190: an epic's Status is promoted only from empty or one of these, matched by name. */
export const PROMOTABLE_STATUSES = /** @type {readonly string[]} */ (["Todo"]);
/** Close reasons that are not work done, so they never promote an epic. */
export const NOT_DONE_REASONS = /** @type {readonly string[]} */ (["NOT_PLANNED", "DUPLICATE"]);
/** The run stops without these: every value in them is decided by this script. */
export const REQUIRED_FIELDS = /** @type {const} */ ([TIER, KIND, AREA, PROGRESS, SUBS_DONE]);
/**
 * #1190: synced when the board has them with this data type, and reported (not fatal) when it has
 * not. Status is GitHub's own field; the script only ever promotes an open epic's (see
 * `promotedStatus`).
 */
export const OPTIONAL_FIELDS = /** @type {const} */ ([
  [STARTED, "DATE"],
  [FINISHED, "DATE"],
  [CYCLE, "ITERATION"],
  [STATUS, "SINGLE_SELECT"],
]);
/** The order fields are written in, and the ONLY fields this script ever writes. */
export const MANAGED_FIELDS = /** @type {const} */ ([
  ...REQUIRED_FIELDS,
  STARTED,
  FINISHED,
  CYCLE,
  STATUS,
]);

/**
 * @typedef {{ total: number, completed: number, percentCompleted: number }} SubIssuesSummary
 * @typedef {{
 *   id: string, number: number, title: string, state: string, closedAt: string | null,
 *   labels: string[], summary: SubIssuesSummary | null, parent: number | null,
 *   createdAt?: string | null, firstPrAt?: string | null, stateReason?: string | null
 * }} Issue
 * @typedef {string | number | null} FieldValue
 * @typedef {{ id: string | null, archived: boolean, values: Record<string, FieldValue> }} Item
 * @typedef {{ id: string | null, name: string, color?: string, description?: string }} Option
 * @typedef {{ id: string | null, title: string, startDate: string, duration: number }} Iteration
 * @typedef {{ duration?: number, iterations?: Iteration[], completedIterations?: Iteration[] }} IterationConfig
 * @typedef {{ id: string | null, name: string, dataType?: string, options?: Option[],
 *   configuration?: IterationConfig }} Field
 * @typedef {{ current: Iteration | null, next: Iteration | null }} Cycles
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
 * #1181 — which of a tier, an area and a type label an issue lacks, in that order. Tier is resolved
 * exactly as the Tier field is, so one inherited from an ancestor counts as present.
 *
 * @param {Pick<Issue, "number" | "labels">} issue
 * @param {Map<number, Pick<Issue, "number" | "labels" | "parent">>} lookup
 * @returns {Array<"tier" | "area" | "type">}
 */
export function missingLabels(issue, lookup) {
  /** @type {Array<"tier" | "area" | "type">} */
  const missing = [];
  // An issue absent from `lookup` still counts its own tier label.
  const tier = lookup.has(issue.number) ? resolveTier(issue.number, lookup) : tierOf(issue.labels);
  if (tier === UNRANKED) missing.push("tier");
  if (areaOf(issue.labels) == null) missing.push("area");
  const labels = new Set(issue.labels);
  if (!TYPE_LABELS.some((type) => labels.has(type))) missing.push("type");
  return missing;
}

/**
 * Every open issue missing a label, by number; the `roadmap` plan issue is exempt.
 *
 * @param {Map<number, Pick<Issue, "number" | "labels" | "state">>} issues
 * @param {Map<number, Pick<Issue, "number" | "labels" | "parent">>} lookup
 * @returns {Array<{ number: number, missing: Array<"tier" | "area" | "type"> }>}
 */
export function labelGaps(issues, lookup) {
  return [...issues.values()]
    .filter((issue) => issue.state === "OPEN" && !issue.labels.includes(EXEMPT_LABEL))
    .map((issue) => ({ number: issue.number, missing: missingLabels(issue, lookup) }))
    .filter((gap) => gap.missing.length > 0)
    .sort((a, b) => a.number - b.number);
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

/** @param {string | null | undefined} iso @returns {string | null} the UTC calendar date */
export function dayOf(iso) {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/** @param {string} day YYYY-MM-DD @param {number} days @returns {string} */
export function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** @param {Pick<Issue, "labels">} issue */
export function isEpic(issue) {
  return issue.labels.includes(EPIC_LABEL);
}

/**
 * #1190 — an issue's own Started: the day its first linked pull request was opened, else the day it
 * was created.
 *
 * @param {Pick<Issue, "createdAt" | "firstPrAt">} issue
 * @returns {string | null}
 */
export function ownStarted(issue) {
  return dayOf(issue.firstPrAt) ?? dayOf(issue.createdAt);
}

/**
 * An epic's Started is the earliest Started of its sub-issues (a sub-issue that is itself an epic
 * counts by the same rule); with no sub-issues, or for any other issue, its own. A cycle is cut.
 *
 * @param {Issue} issue
 * @param {Map<number, Issue[]>} subIssues an epic's number → its sub-issues
 * @param {Set<number>} [seen]
 * @returns {string | null}
 */
export function resolveStarted(issue, subIssues, seen = new Set()) {
  const children = isEpic(issue) && !seen.has(issue.number) ? subIssues.get(issue.number) : null;
  seen.add(issue.number);
  const days = (children ?? [])
    .map((child) => resolveStarted(child, subIssues, seen))
    .filter((day) => day != null)
    .sort();
  return days[0] ?? ownStarted(issue);
}

/**
 * Finished: the day a closed issue closed; null (clears) for an open one, so a reopen clears it.
 *
 * @param {Pick<Issue, "state" | "closedAt">} issue
 * @returns {string | null}
 */
export function finishedOf(issue) {
  return issue.state === "OPEN" ? null : dayOf(issue.closedAt);
}

/** Active and completed iterations, by start date. @param {Field | undefined} field */
export function iterationsOf(field) {
  const config = field?.configuration ?? {};
  return [...(config.completedIterations ?? []), ...(config.iterations ?? [])].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );
}

/**
 * The iteration covering `today`, and the first one starting on or after its end (or after today,
 * with no current one).
 *
 * @param {Iteration[]} iterations
 * @param {string} today YYYY-MM-DD
 * @returns {Cycles}
 */
export function cyclesAt(iterations, today) {
  const sorted = [...iterations].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const current =
    sorted.find((i) => i.startDate <= today && today < addDays(i.startDate, i.duration)) ?? null;
  const after = current ? addDays(current.startDate, current.duration) : addDays(today, 1);
  const next = sorted.find((i) => i.startDate >= after) ?? null;
  return { current, next };
}

/**
 * The iterations to append so that one covers today and one follows it, each `duration` days and
 * contiguous with the last, titled on from the last one's number ("Cycle 3" → "Cycle 4"). None when
 * nothing is missing, and none when appending cannot help (the field has no iterations, today falls
 * in a gap between two, or before the first): the run reports that instead.
 *
 * @param {Iteration[]} iterations
 * @param {number | undefined} duration
 * @param {string} today
 * @returns {Array<{ title: string, startDate: string, duration: number }>}
 */
export function iterationsToAppend(iterations, duration, today) {
  const sorted = [...iterations].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const last = sorted.at(-1);
  if (!last || !duration || duration < 1) return [];
  const { current, next } = cyclesAt(sorted, today);
  if (current && next) return [];
  let start = addDays(last.startDate, last.duration);
  // No current iteration while the last one has not ended: today is in a gap, or before the first.
  if (!current && today < start) return [];
  const match = /^(.*?)(\d+)\s*$/.exec(last.title);
  const prefix = match ? match[1] : "Cycle ";
  let n = match ? Number(match[2]) : sorted.length;
  const out = [];
  let covered = Boolean(current);
  for (;;) {
    out.push({ title: `${prefix}${(n += 1)}`, startDate: start, duration });
    const end = addDays(start, duration);
    if (covered) return out;
    if (start <= today && today < end) covered = true;
    start = end;
  }
}

/**
 * #1190 — Cycle from the resolved Tier: Now → the current cycle, Next → the following one, any other
 * tier → null (clears). `undefined` when the iteration the tier needs is not on the board: the item
 * keeps what it has, and the run reports the gap.
 *
 * @param {string} tier
 * @param {Cycles} cycles
 * @returns {string | null | undefined} an iteration's id: an item is matched by id, never by title
 */
export function cycleFor(tier, cycles) {
  if (tier === "Now") return cycles.current ? cycles.current.id : undefined;
  if (tier === "Next") return cycles.next ? cycles.next.id : undefined;
  return null;
}

/**
 * #1190 — the one Status write this script makes: an open `epic` with a sub-issue closed or In
 * Progress moves to In Progress. Only ever FROM an empty Status or one named in PROMOTABLE_STATUSES
 * (Todo), by name, never by the field's option order: any other value (In Progress, Done, an option
 * added by hand) is left alone, so an epic is never demoted. `undefined` = do not touch.
 *
 * @param {Pick<Issue, "state" | "labels">} issue
 * @param {FieldValue | undefined} current the item's Status
 * @param {string[]} optionNames the Status field's options (In Progress must be one)
 * @param {boolean} subIssueStarted a sub-issue is closed as completed, or In Progress
 * @returns {string | undefined}
 */
export function promotedStatus(issue, current, optionNames, subIssueStarted) {
  if (issue.state !== "OPEN" || !isEpic(issue) || !subIssueStarted) return undefined;
  if (!optionNames.includes(IN_PROGRESS)) return undefined;
  return canPromoteFrom(current) ? IN_PROGRESS : undefined;
}

/** @param {FieldValue | undefined} status */
export function canPromoteFrom(status) {
  return status == null || PROMOTABLE_STATUSES.includes(String(status));
}

/**
 * A sub-issue counts towards promoting its epic when it is open and In Progress on the board, or
 * closed as completed. Closed as a duplicate or not planned is not work done.
 *
 * @param {Pick<Issue, "state" | "stateReason">} child
 * @param {FieldValue | undefined} status the child's Status on the board
 */
export function subIssueCounts(child, status) {
  if (child.state === "OPEN") return status === IN_PROGRESS;
  return !NOT_DONE_REASONS.includes(String(child.stateReason ?? ""));
}

/**
 * Every managed field present in `desired` whose value differs, in write order; a null value
 * clears, and a field absent from `desired` is left alone. An absent current value and null are the
 * same (an empty field); JSON numbers compare exactly (86 vs 85 differs).
 *
 * @param {Record<string, FieldValue>} desired
 * @param {Record<string, FieldValue>} current
 * @returns {Array<[string, FieldValue]>}
 */
export function fieldChanges(desired, current) {
  return MANAGED_FIELDS.filter(
    (field) => field in desired && (desired[field] ?? null) !== (current[field] ?? null),
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
 * no option of that name, or an iteration field no iteration with that id (the board was edited by
 * hand; the item is left alone, said so in the log).
 *
 * @param {Field} field
 * @param {string | number} value
 * @returns {Record<string, string | number | null> | null} a null option id only in a dry run, for
 *   an option the run would have added
 */
export function encodeValue(field, value) {
  if (field.dataType === "NUMBER") return { number: Number(value) };
  if (field.dataType === "TEXT") return { text: String(value) };
  if (field.dataType === "DATE") return { date: String(value) };
  if (field.dataType === "ITERATION") {
    // By id: two iterations may share a title; the item's value reads back as the id.
    const iteration = iterationsOf(field).find((i) => i.id != null && i.id === value);
    return iteration ? { iterationId: iteration.id } : null;
  }
  const option = (field.options ?? []).find((o) => o.name === value);
  return option ? { singleSelectOptionId: option.id } : null;
}

/**
 * @param {Counts} counts
 * @param {number} missingLabelCount open issues missing a tier, an area or a type label (#1181)
 */
export function summaryLine(counts, missingLabelCount) {
  return `summary: added ${counts.added}, changed ${counts.changed}, unchanged ${counts.unchanged}, skipped ${counts.skipped}, failed ${counts.failed}, missing labels ${missingLabelCount}`;
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
        id number title state stateReason closedAt createdAt
        labels(first: 50) { nodes { name } }
        parent { number repository { nameWithOwner } }
        subIssuesSummary { total completed percentCompleted }`;
/**
 * #1190: closed pull requests count too — one opened and abandoned still started the work. Kept
 * apart because the nightly's App token is minted with `issues: read` and no pull-request read, and
 * this connection may need one: when it cannot be read, the run reads without it and says so.
 */
const PR_FIELDS = `
        closedByPullRequestsReferences(first: 25, includeClosedPrs: true) { nodes { createdAt } }`;

/** @param {string} fields */
const issuesQuery = (fields) => `
query($owner: String!, $name: String!, $after: String, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, filterBy: $filter, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {${fields}
      }
    }
  }
}`;
export const ISSUES_QUERY = issuesQuery(ISSUE_FIELDS + PR_FIELDS);
export const ISSUES_QUERY_NO_PRS = issuesQuery(ISSUE_FIELDS);

export const ONE_ISSUE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {${ISSUE_FIELDS}
    }
  }
}`;

/** @param {string} fields */
const subIssuesQuery = (fields) => `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      subIssues(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {${fields}
          repository { nameWithOwner }
        }
      }
    }
  }
}`;
export const SUB_ISSUES_QUERY = subIssuesQuery(ISSUE_FIELDS + PR_FIELDS);
export const SUB_ISSUES_QUERY_NO_PRS = subIssuesQuery(ISSUE_FIELDS);

/**
 * #1190 — an epic's state and board Status, re-read immediately before its Status is written, so an
 * epic closed (and set Done by GitHub's workflow) during the run is not overwritten.
 */
export const RECHECK_QUERY = `
query($item: ID!) {
  node(id: $item) {
    ... on ProjectV2Item {
      fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      content { ... on Issue { state } }
    }
  }
}`;

const ITERATIONS =
  "iterations { id title startDate duration } completedIterations { id title startDate duration }";

export const PROJECT_QUERY = `
query($org: String!, $number: Int!) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name color description } }
          ... on ProjectV2IterationField { configuration { duration ${ITERATIONS} } }
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
          fieldValues(first: 50) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldIterationValue { iterationId field { ... on ProjectV2FieldCommon { name } } }
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

/**
 * #1190 — replaces the field's WHOLE iteration list. Measured on a scratch project (2026-10-16): an
 * iteration sent back with its `id`, active or completed, keeps that id and every item holding it
 * keeps its value; one sent without an id is created new. So every existing iteration goes back with
 * its id, and only the appended ones go without.
 */
export const UPDATE_ITERATIONS = `
mutation($field: ID!, $config: ProjectV2IterationFieldConfigurationInput!) {
  updateProjectV2Field(input: {fieldId: $field, iterationConfiguration: $config}) {
    projectV2Field { ... on ProjectV2IterationField { id name dataType configuration { duration ${ITERATIONS} } } }
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
    stateReason: node.stateReason ?? null,
    closedAt: node.closedAt ?? null,
    createdAt: node.createdAt ?? null,
    firstPrAt:
      (node.closedByPullRequestsReferences?.nodes ?? [])
        .map((/** @type {{ createdAt?: string }} */ pr) => pr?.createdAt)
        .filter(Boolean)
        .sort()[0] ?? null,
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
 * @param {boolean} [withPrs] read each issue's linked pull requests too (#1190)
 * @returns {Promise<Map<number, Issue>>}
 */
export async function readIssues(client, repository, now, withPrs = true) {
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
      const data = await client.query(withPrs ? ISSUES_QUERY : ISSUES_QUERY_NO_PRS, {
        owner,
        name,
        after,
        filter,
      });
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
        for (const key of ["name", "number", "text", "date", "iterationId"]) {
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
 * #1190 — every epic's sub-issues, by the epic's number, read whole (closed long ago or not) so an
 * epic's Started does not drift as its sub-issues age out of the read window. A sub-issue that is
 * itself an epic has its own read; one in another repository is dropped (its number means a
 * different issue here). Each epic is read once, so a cycle cannot loop.
 *
 * @param {Client} client
 * @param {string} repository owner/name
 * @param {Iterable<number>} epics
 * @param {boolean} [withPrs] read each sub-issue's linked pull requests too
 * @returns {Promise<Map<number, Issue[]>>}
 */
export async function readSubIssues(client, repository, epics, withPrs = true) {
  const [owner, name] = repository.split("/");
  /** @type {Map<number, Issue[]>} */
  const subIssues = new Map();
  const pending = [...epics];
  while (pending.length) {
    const number = /** @type {number} */ (pending.pop());
    if (subIssues.has(number)) continue;
    /** @type {Issue[]} */
    const children = [];
    subIssues.set(number, children);
    /** @type {string | null} */
    let after = null;
    for (;;) {
      const data = await client.query(withPrs ? SUB_ISSUES_QUERY : SUB_ISSUES_QUERY_NO_PRS, {
        owner,
        name,
        number,
        after,
      });
      const page = data.repository?.issue?.subIssues;
      if (!page) break;
      for (const node of page.nodes) {
        if (node?.repository?.nameWithOwner !== repository) continue;
        const child = issueFromNode(node, repository);
        children.push(child);
        if (isEpic(child)) pending.push(child.number);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
  }
  return subIssues;
}

/**
 * A guard in `ensureCycles` tripped. `lost` is set when the write happened and an iteration did not
 * come back: the Cycle field is then not trusted for the rest of the run.
 */
export class CycleGuardError extends GraphQLError {
  /** @param {string} message @param {boolean} lost */
  constructor(message, lost) {
    super(message);
    this.lost = lost;
  }
}

/** @param {Field | undefined} field @returns {Array<string | null>} */
const iterationIds = (field) => iterationsOf(field).map((i) => i.id);

/**
 * #1190 — appends Cycle iterations so that one covers today and one follows it. The write replaces
 * the field's WHOLE iteration list, so it is the one write that could empty every item's Cycle;
 * three guards stand around it:
 *   1. every existing iteration, active AND completed, must have an id to send back (see
 *      UPDATE_ITERATIONS), or nothing is written;
 *   2. the field is re-read immediately before the write, and nothing is written if its iteration
 *      ids differ from the first read (an iteration added or removed by hand in between would
 *      otherwise be deleted or resurrected);
 *   3. after the write, every id read before must come back, or the run stops writing Cycle.
 * A guard throws a CycleGuardError; the field is otherwise replaced in `fields` by what GitHub
 * returns.
 *
 * @param {Client} client
 * @param {Map<string, Field>} fields
 * @param {string} today YYYY-MM-DD
 * @param {() => Promise<Field | undefined>} reread the Cycle field as the board has it now
 */
export async function ensureCycles(client, fields, today, reread) {
  const field = /** @type {Field} */ (fields.get(CYCLE));
  const iterations = iterationsOf(field);
  const duration = field.configuration?.duration;
  const append = iterationsToAppend(iterations, duration, today);
  if (append.length === 0 || !client.budgetLeft()) return;
  if (iterations.some((i) => !i.id)) {
    throw new CycleGuardError("an existing iteration has no id; nothing added", false);
  }
  const before = new Set(iterations.map((i) => /** @type {string} */ (i.id)));
  const fresh = iterationIds(await reread());
  if (fresh.length !== before.size || !fresh.every((id) => id != null && before.has(id))) {
    throw new CycleGuardError("the Cycle field changed since it was read; nothing added", false);
  }
  const config = {
    startDate: iterations[0].startDate,
    duration,
    iterations: [
      ...iterations.map((i) => ({
        id: i.id,
        title: i.title,
        startDate: i.startDate,
        duration: i.duration,
      })),
      ...append,
    ],
  };
  const data = await client.mutate(
    `add Cycle iterations ${append.map((i) => `${i.title} (${i.startDate})`).join(", ")}`,
    UPDATE_ITERATIONS,
    { field: field.id, config },
  );
  if (client.dryRun) {
    // So a dry run shows the values it would then set; the ids are placeholders, never sent.
    const configuration = field.configuration ?? {};
    fields.set(CYCLE, {
      ...field,
      configuration: {
        ...configuration,
        iterations: [
          ...(configuration.iterations ?? []),
          ...append.map((i) => ({ ...i, id: `dry-run:${i.title}` })),
        ],
      },
    });
    return;
  }
  const result = data?.updateProjectV2Field?.projectV2Field;
  const after = new Set(iterationIds(result));
  const lost = [...before].filter((id) => !after.has(id));
  if (!result || lost.length) {
    throw new CycleGuardError(
      result ? `iteration(s) ${lost.join(", ")} did not come back` : "the write returned no field",
      true,
    );
  }
  fields.set(CYCLE, { ...result, name: CYCLE, dataType: "ITERATION" });
}

/**
 * One issue's add and writes. Returns what to count it as, and whether it was deferred by the
 * write budget. A write that throws propagates to the caller, which counts the item as failed.
 *
 * @param {{ client: Client, projectId: string, fields: Map<string, Field>, issue: Issue,
 *   lookup: Map<number, Issue>, item: Item | undefined, log: (line: string) => void, counts: Counts,
 *   extra: (issue: Issue, item: Item) => Record<string, FieldValue> }} ctx
 * @returns {Promise<{ outcome: "changed" | "unchanged" | "skipped" | "ignored", deferred: boolean }>}
 */
async function syncOne({ client, projectId, fields, issue, lookup, item, log, counts, extra }) {
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
  const changes = fieldChanges(
    { ...desiredFields(issue, lookup), ...extra(issue, item) },
    item.values,
  );
  if (changes.length === 0) return { outcome: "unchanged", deferred: false };
  let writes = 0;
  let deferred = false;
  for (const [fieldName, value] of changes) {
    if (!client.budgetLeft()) {
      deferred = true;
      break;
    }
    const field = /** @type {Field} */ (fields.get(fieldName));
    // A Cycle value is an iteration id; the log names its title.
    const shown =
      fieldName === CYCLE
        ? (iterationsOf(field).find((i) => i.id === value)?.title ?? value)
        : value;
    const label = `#${number} ${fieldName} -> ${value == null ? "(clear)" : shown}`;
    if (fieldName === STATUS && item.id) {
      // #1190: the epic may have closed (and GitHub set it Done) since the read. Re-read it now.
      const node = (await client.query(RECHECK_QUERY, { item: item.id }))?.node;
      const status = node?.fieldValueByName?.name ?? null;
      if (node?.content?.state !== "OPEN" || !canPromoteFrom(status)) {
        log(`skip #${number} Status: closed, or moved to ${status ?? "(empty)"}, since the read`);
        continue;
      }
    }
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
  // Deferred whenever a change waits for the next run, a part-written item included.
  return { outcome: writes > 0 ? "changed" : "skipped", deferred };
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
  for (const name of REQUIRED_FIELDS) {
    if (!fields.has(name)) {
      throw new GraphQLError(
        `the board has no field named ${JSON.stringify(name)} (docs/ops/roadmap-board.md)`,
      );
    }
  }
  // #1190: a missing optional field is reported, not fatal; its values are left alone.
  /** @type {string[]} */
  const notes = [];
  const unusable = OPTIONAL_FIELDS.filter(([name, type]) => fields.get(name)?.dataType !== type);
  for (const [name] of unusable) fields.delete(name);
  if (unusable.length) {
    notes.push(
      `board: no ${unusable.map(([name, type]) => `${name} (${type})`).join(", ")} field; not synced`,
    );
  }
  const statusOptions = (fields.get(STATUS)?.options ?? []).map((o) => o.name);
  if (fields.has(STATUS) && !statusOptions.includes(IN_PROGRESS)) {
    notes.push(`board: Status has no option "${IN_PROGRESS}"; epics' Status is not synced`);
    fields.delete(STATUS);
  }
  // The UTC date: at the nightly's 02:23 UTC, the previous evening in the Americas.
  const today = now.toISOString().slice(0, 10);

  // #1190: the linked-PR read may need a permission the App token lacks. Without it, Started falls
  // back to the creation date, and only fills an empty Started (never rewrites a PR-based one).
  let prsReadable = true;
  /** @param {unknown} error */
  const prsUnreadable = (error) => {
    if (!(error instanceof GraphQLError)) throw error;
    prsReadable = false;
    notes.push(
      `board: linked pull requests could not be read (${error.message}); Started falls back to the creation date where it is empty`,
    );
  };
  /** @type {Map<number, Issue>} */
  let issues;
  try {
    issues = await readIssues(client, repository, now);
  } catch (error) {
    prsUnreadable(error);
    issues = await readIssues(client, repository, now, false);
  }
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

  /** @type {Cycles} */
  let cycles = { current: null, next: null };
  const reread = async () =>
    (
      await client.query(PROJECT_QUERY, { org, number: projectNumber })
    ).organization?.projectV2?.fields?.nodes?.find(
      (/** @type {Field | null} */ f) => f?.name === CYCLE,
    );
  if (fields.has(CYCLE)) {
    try {
      await ensureCycles(client, fields, today, reread);
    } catch (error) {
      if (!(error instanceof GraphQLError)) throw error;
      counts.failed += 1;
      log(`failed: add Cycle iterations: ${error.message}`);
      if (error instanceof CycleGuardError && error.lost) {
        fields.delete(CYCLE);
        notes.push("board: an iteration was lost adding Cycles; no Cycle is written this run");
      }
    }
  }
  if (fields.has(CYCLE)) {
    cycles = cyclesAt(iterationsOf(fields.get(CYCLE)), today);
    if (!cycles.current) notes.push(`board: no Cycle covers ${today}; Now items keep their Cycle`);
    if (!cycles.next) {
      notes.push(
        `board: no Cycle after ${cycles.current?.title ?? today}; Next items keep their Cycle`,
      );
    }
  }

  const epics = [...issues.values()].filter(isEpic).map((i) => i.number);
  /** @type {Map<number, Issue[]>} */
  let subIssues = new Map();
  if (fields.has(STARTED) || fields.has(STATUS)) {
    try {
      subIssues = await readSubIssues(client, repository, epics, prsReadable);
    } catch (error) {
      if (!prsReadable) throw error;
      prsUnreadable(error);
      subIssues = await readSubIssues(client, repository, epics, false);
    }
  }
  /** @param {Issue} issue @param {Item} item @returns {Record<string, FieldValue>} */
  const extra = (issue, item) => {
    /** @type {Record<string, FieldValue>} */
    const out = {};
    if (fields.has(STARTED) && (prsReadable || item.values[STARTED] == null)) {
      const started = resolveStarted(issue, subIssues);
      if (started) out[STARTED] = started;
    }
    if (fields.has(FINISHED)) out[FINISHED] = finishedOf(issue);
    // A closed item keeps its Cycle, so finished work stays where it happened.
    if (fields.has(CYCLE) && issue.state === "OPEN") {
      const cycle = cycleFor(resolveTier(issue.number, lookup), cycles);
      if (cycle !== undefined) out[CYCLE] = cycle;
    }
    if (fields.has(STATUS)) {
      // A sub-issue closed as completed, or open and In Progress on the board.
      const subIssueStarted = (subIssues.get(issue.number) ?? []).some((child) =>
        subIssueCounts(child, items.get(child.number)?.values[STATUS]),
      );
      const status = promotedStatus(issue, item.values[STATUS], statusOptions, subIssueStarted);
      if (status) out[STATUS] = status;
    }
    return out;
  };

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
        extra,
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
  // #1181: a report only — it changes no count that decides the exit code.
  const gaps = labelGaps(issues, lookup);
  for (const gap of gaps) log(`missing labels: #${gap.number} ${gap.missing.join(", ")}`);
  for (const note of notes) log(note);
  log(summaryLine(counts, gaps.length) + (client.dryRun ? " (dry run)" : ""));
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

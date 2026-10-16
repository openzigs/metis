# The roadmap board

**[METIS roadmap](https://github.com/orgs/openzigs/projects/2)** is an organisation project
(number 2), public and linked to this repository. It shows where the epics and issues stand
without anyone having to read an issue. **[#1146](https://github.com/openzigs/metis/issues/1146)
stays the written plan; the board mirrors it.** Where the two disagree, #1146 and the issue's own
labels are right and the board is stale until the next run.

The board is kept up to date by [`scripts/sync-roadmap.mjs`](../../scripts/sync-roadmap.mjs)
(its rules are in [`scripts/lib/sync-roadmap-core.mjs`](../../scripts/lib/sync-roadmap-core.mjs)),
run nightly at 02:23 UTC by [`.github/workflows/roadmap.yml`](../../.github/workflows/roadmap.yml)
([#1147](https://github.com/openzigs/metis/issues/1147)). It is a port of On Your Left's sync
(openzigs/onyourleft#1348). To run it yourself:

```bash
GH_TOKEN=$(gh auth token) node scripts/sync-roadmap.mjs --org openzigs --project 2 --dry-run
```

`--dry-run` reads everything and prints each change it would make, then a summary line
(`added`, `changed` — items where a write happened — `unchanged`, `skipped`, `failed`,
`missing labels`); without
it the changes are made. Node built-ins only, nothing to install. Its tests are
`scripts/lib/sync-roadmap-core.test.mjs`, part of `pnpm test`.

## What it reads, adds and leaves alone

- **Reads** every issue in `openzigs/metis` that is open or was closed in the last 30 days, with
  its labels, parent, sub-issue summary, creation date and linked pull requests' opening dates.
  Pull requests are never added. It also reads each ancestor outside that set (an epic closed long
  ago) so a Tier chain resolves; an ancestor decides Tier and nothing else, and is never added or
  written. And it reads every epic's sub-issues whole, closed long ago or not, for the epic's
  Started.
- **Adds** every open issue that is not on the board. It never deletes and never archives, and it
  leaves an archived item, and an item outside what it read, exactly as they are.
- **Adds an Area option** when an issue carries an `area:` label the board has no option for. The
  existing options are sent back with their ids, colours and descriptions, so no item loses its
  Area; a new option is grey with no description, for the owner to colour.
- **Adds Cycle iterations** when none covers today or none follows it: each is the field's length
  (14 days), starts where the last one ends, and is titled on from it ("Cycle 3" → "Cycle 4").
  The write replaces the field's whole iteration list, so it is guarded
  ([#1190](https://github.com/openzigs/metis/issues/1190)):
  - every existing iteration, finished ones included, is sent back with its id, so no item loses
    its Cycle (measured on a scratch project before relying on it); an iteration without an id
    stops the write;
  - the field is re-read just before the write, and nothing is written if its iterations changed
    since the run read them (one added or removed by hand in between is never undone);
  - after the write, every iteration read before must come back; if one does not, the run counts a
    failure and writes no Cycle value for the rest of the run.

  A guard that trips writes nothing more and fails the run, so the workflow goes red. When adding
  cannot help (the field has no iterations, or today falls before the first or in a gap between
  two) it says so in a `board:` line instead.
- **Touches Status in one case only.** GitHub's built-in workflows own Status (item closed or pull
  request merged → Done), and an epic never gets a pull request of its own, so an epic would read
  Todo with half its work done. The exception
  ([#1190](https://github.com/openzigs/metis/issues/1190)): an **open issue labelled `epic`** with
  any sub-issue closed as completed (not as a duplicate or not planned), or open and In Progress on
  the board, is set to **In Progress**. It moves only from an empty Status or **Todo**, matched by
  name, so it is never moved back and an option added by hand is left alone. The epic is re-read
  just before the write, and skipped if it closed or its Status moved during the run. No other
  issue's Status is ever written.
- **One failed write does not stop the run.** The item is logged as `failed: #N: <GitHub's
  message>` and the run carries on; the summary counts it, and the run then exits 1 so the
  workflow goes red. A failed read still stops the run at once.
- Runs twice, changes nothing the second time: values are written only where they differ, and
  adding an issue that is already on the board returns the item that is there.
- At most 399 writes a run, about one a second; anything past that carries on the next night.
- **Reports every open issue missing a label** that [Filing an issue](#filing-an-issue) requires:
  one line per issue, `missing labels: #N tier, area, type` (whichever apply), and the count as
  `missing labels N` in the summary. A tier inherited from an ancestor counts as present, exactly
  as the Tier field resolves it, and the `roadmap` plan issue (#1146) is exempt. It is a report,
  not a failure: it never changes the exit code and never writes a label
  ([#1181](https://github.com/openzigs/metis/issues/1181)). It is lenient: `blocked` alone counts
  as a tier, and duplicate tier or `area:` labels are not reported.
- **Reports a board it cannot fully fill**, one `board:` line each, without failing: a missing (or
  wrongly typed) Started, Finished or Cycle field, a Status field with no In Progress option, no
  Cycle covering today (Now items then keep their Cycle), or no Cycle after it (Next items keep
  theirs). Tier, Kind, Area, Progress % and Sub-issues done are required: without one, the run
  stops.
- **Reports linked pull requests it cannot read** in one `board:` line, and carries on. The
  nightly's App token reads issues and writes projects; if GitHub refuses it the linked-PR
  connection, Started falls back to the creation date, and only fills an empty Started, so a date
  set from a pull request on an earlier run is never rewritten.

## The fields

| Field | Type | Filled from |
|---|---|---|
| **Tier** | single select | the issue's own label: `priority: now` → Now, `priority: next` → Next, `priority: later` → Later, `blocked` → Blocked (several: the first in that order). With none, the **nearest ancestor's** (parent, then grandparent, …); with none on the chain, **Unranked**. So a sub-issue follows its epic until it is given its own label. `priority: high` is a severity label in METIS, not a tier, and sets nothing |
| **Kind** | single select | `epic` label → Epic; title starting "Spike" or "Research" → Spike; `bug` label → Bug; else Issue, in that order |
| **Progress %** | number | the issue's sub-issues, `percentCompleted` (GitHub rounds down); cleared for an issue with none |
| **Sub-issues done** | text | the same, as "10 of 23"; cleared for an issue with none |
| **Area** | single select | the issue's `area: <name>` label → `<name>`. Several: the first by name. None: cleared. To move an issue, change its label, not the board |
| **Started** | date | the day the issue's first linked pull request was opened (closed ones count); with none, the day the issue was created. For an `epic`, the earliest Started of its sub-issues (a sub-epic by the same rule), closed long ago or not; with no sub-issues, its own |
| **Finished** | date | the day a closed issue closed (`closedAt`, UTC), an epic's included; cleared when it reopens |
| **Cycle** | iteration, 14 days | the resolved **Tier**, inherited one included: **Now** → the cycle covering today, **Next** → the one after it, **Later**, **Blocked** and **Unranked** → none (cleared). Set on open items only: a **closed item keeps the cycle it last had**. That is usually the cycle it finished in, but a Next item closed early keeps its *future* cycle. Matched by iteration id, not title. Cycle 1 started 2026-10-12 |
| Status | built in | GitHub's workflows; the script only promotes an open epic to In Progress (above) |
| Parent issue, Sub-issues progress | built in | GitHub, not the script |

Dates come from the tier and from what happened, never from a hand-typed deadline: #1146 plans in
tiers, not dates. The fields and their first three cycles were made by hand on 2026-10-16
([#1190](https://github.com/openzigs/metis/issues/1190)).

- **"Today" is the UTC date.** The nightly runs at 02:23 UTC, which is still the previous evening in
  the Americas, so on a cycle's first day items move into it some hours before it starts there.
- **Items closed more than 30 days before the first run get no Started or Finished.** They are
  outside what the sync reads, so it never writes them; a sub-issue like that still counts towards
  its epic's Started.

**The Roadmap view** (view 6) draws each item from **Started** to the end of its **Cycle**. That is
the design, the owner's setup on 2026-10-16: the roadmap shows planned work by cycle, not by a
finish date. Open Now and Next work sits in its cycle, closed work keeps its last cycle (see Cycle
above), and an item with no cycle (Later, Blocked, Unranked) has a start and no end. The setting is
the board's, made in the UI, not the script's. **Finished** is recorded for the table views.

## Filing an issue

Every issue filed in `openzigs/metis` — by a person, the main session or any subagent — gets these
at creation ([#1181](https://github.com/openzigs/metis/issues/1181), the owner's rule of
2026-10-16). Without them an issue reads Unranked, its Area is cleared every night, and it reaches
the board only when the sync next runs.

1. **Exactly one tier label:** `priority: now`, `priority: next` or `priority: later`; add
   `blocked` as well when it is blocked.
   - **Now** only on the owner's decision, recorded on #1146.
   - **Next** for walkthrough findings and defects a user would hit.
   - **Later** for review follow-ups, nits and optional work.
   - METIS is mainly for business analysts (#1146), so analyst-facing defects rank ahead of
     developer-side precision.
   - A sub-issue that should follow its epic's tier may omit the label; say so in its body. The
     sync and its label check both resolve the tier up the parent chain.
2. **Exactly one `area:` label** from the existing set: `run-state`, `analyst-flow`,
   `plan-impact`, `docs`, `review-trace-chat`, `security`, `model-json`, `walkthrough`, `ci`,
   `code-graph`, `cleanup`, `ui`. A new area only on the owner's say; the sync then creates the
   board option for it.
3. **A type label:** `bug`, `enhancement` (or `feature`), `epic`, `documentation`, `testing` or
   `dependencies`.
4. **Board membership at creation:** pass `--project "METIS roadmap"` to `gh issue create`. The
   flag needs a token with the **`project`** scope (`gh auth refresh -s project`); if it fails, file
   the issue without it and the nightly sync adds it within a day. Say which happened.
5. `priority: high` is a **severity** label, separate from the tier, and sets no tier.
6. An issue filed into Now or Next gets a line in #1146's matching section.

```bash
gh issue create --repo openzigs/metis \
  --title "Review cards lose the edited acceptance criteria" \
  --body-file /tmp/body.md \
  --label bug --label "priority: next" --label "area: review-trace-chat" \
  --project "METIS roadmap"
```

Pass the body as `--body-file`, never `--body "$(cat …)"`: command substitution runs any
backticks in it. The nightly sync lists every open issue still missing one of these (see above).

## The App behind the token

`GITHUB_TOKEN` cannot write an organisation's project, so the workflow mints a token from the
openzigs roadmap GitHub App (the one On Your Left uses) with `actions/create-github-app-token`,
scoped to **Organization → Projects: write** and **Issues: read** on `openzigs/metis`. Its client
id is the variable `ROADMAP_APP_CLIENT_ID` and its private key the secret
`ROADMAP_APP_PRIVATE_KEY`, both in the Environment **`roadmap`**, whose deployments are limited to
`main`. A private key cannot be copied between repositories, so this one is METIS's own.

The board must stay **public**: an App's token cannot see the items of a private project. And the
App's project write applies to every project in the organisation, which is why the workflow runs
only on a schedule or by hand, never on a pull request. While either the variable or the secret is
unset, the workflow skips, green, with a notice.

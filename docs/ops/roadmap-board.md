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
  its labels, parent and sub-issue summary. Pull requests are never added. It also reads each
  ancestor outside that set (an epic closed long ago) so a Tier chain resolves; an ancestor
  decides Tier and nothing else, and is never added or written.
- **Adds** every open issue that is not on the board. It never deletes and never archives, and it
  leaves an archived item, and an item outside what it read, exactly as they are.
- **Adds an Area option** when an issue carries an `area:` label the board has no option for. The
  existing options are sent back with their ids, colours and descriptions, so no item loses its
  Area; a new option is grey with no description, for the owner to colour.
- **Never touches Status** (GitHub's built-in workflows own it: item closed or pull request merged
  → Done).
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

## The fields

| Field | Type | Filled from |
|---|---|---|
| **Tier** | single select | the issue's own label: `priority: now` → Now, `priority: next` → Next, `priority: later` → Later, `blocked` → Blocked (several: the first in that order). With none, the **nearest ancestor's** (parent, then grandparent, …); with none on the chain, **Unranked**. So a sub-issue follows its epic until it is given its own label. `priority: high` is a severity label in METIS, not a tier, and sets nothing |
| **Kind** | single select | `epic` label → Epic; title starting "Spike" or "Research" → Spike; `bug` label → Bug; else Issue, in that order |
| **Progress %** | number | the issue's sub-issues, `percentCompleted` (GitHub rounds down); cleared for an issue with none |
| **Sub-issues done** | text | the same, as "10 of 23"; cleared for an issue with none |
| **Area** | single select | the issue's `area: <name>` label → `<name>`. Several: the first by name. None: cleared. To move an issue, change its label, not the board |
| Status, Parent issue, Sub-issues progress | built in | GitHub, not the script |

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

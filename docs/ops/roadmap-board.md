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
(`added`, `changed` — items where a write happened — `unchanged`, `skipped`, `failed`); without
it the changes are made. Node built-ins only, nothing to install. Its tests are
`scripts/lib/sync-roadmap-core.test.mjs`, part of `pnpm test`.

## What it reads, adds and leaves alone

- **Reads** every issue in `openzigs/metis` that is open or was closed in the last 30 days, with
  its labels and sub-issue summary. Pull requests are never added.
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

## The fields

| Field | Type | Filled from |
|---|---|---|
| **Tier** | single select | the issue's own labels: `priority: now` → Now, `priority: next` → Next, `priority: later` → Later, `blocked` → Blocked, else **Unranked**. Several: the first in that order. `priority: high` is a severity label in METIS, not a tier, and sets nothing |
| **Kind** | single select | `epic` label → Epic; title starting "Spike" or "Research" → Spike; `bug` label → Bug; else Issue, in that order |
| **Progress %** | number | the issue's sub-issues, `percentCompleted` (GitHub rounds down); cleared for an issue with none |
| **Sub-issues done** | text | the same, as "10 of 23"; cleared for an issue with none |
| **Area** | single select | the issue's `area: <name>` label → `<name>`. Several: the first by name. None: cleared. To move an issue, change its label, not the board |
| Status, Parent issue, Sub-issues progress | built in | GitHub, not the script |

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

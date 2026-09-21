# Changelog fragments

Every PR that changes source writes **one file** here instead of editing
`CHANGELOG.md`. Two PRs never touch the same path, so the append-at-one-anchor
conflict that cost three CI cycles in a single fan-out (#1187/#1188/#1189,
Issue #1191) cannot happen.

## Writing one

Create `.changes/unreleased/<issue>-<slug>.md`:

```markdown
---
issue: 1191
section: Added
---

- Changelog fragments: each PR now writes `.changes/unreleased/<issue>-<slug>.md`.
```

- **Filename** is `<issue>-<kebab-slug>.md`. The issue number leads, so two PRs
  cannot collide on a filename without being the same issue.
- **`section:`** is one of `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
  `Security` (Keep a Changelog).
- **`issue:`** is the bare number. It must match the filename. The assembler
  appends ` (#<issue>)` to every top-level bullet, so **do not write the issue
  reference yourself**.
- **Body** starts with a top-level bullet — `-`, `*` or `+`, all three
  CommonMark markers. Long entries may soft-wrap onto indented continuation
  lines, and nested sub-points are allowed. The assembler puts the issue
  reference at the end of the entry's prose, before any sub-point, and otherwise
  leaves your text byte-for-byte alone (including which bullet marker you used —
  prefer `-` for consistency with the rest of `CHANGELOG.md`).

### What the body may and may not contain

The entry grammar is deliberately narrow, because the body is spliced into a
bullet list under a `### Added`-style heading that the assembler writes.

| Accepted | Rejected |
| --- | --- |
| `- `, `* `, `+ ` bullets at any indent | `1.` ordered lists |
| soft-wrapped continuation lines (indent by two spaces) | headings — they collide with `### Added` |
| blank lines between bullets | `---` / `***` thematic breaks — they split the section |
| code fences and tables **indented** by two spaces | code fences and tables at column 0 — they end the bullet list |
| | bare paragraphs and bold lead-ins — indent them, or start a bullet |

Every rejection names the construct and the alternative, so the fix is normally
one keystroke. Note a footgun: a `- ` line **inside an indented fence** parses as
a nested sub-bullet, which moves where the assembler puts `(#N)`.

## How long is an entry?

**A few lines.** The detail belongs in the PR and the issue.

This is not a style preference. `## [Unreleased]` reached 996 entries and
1.65 MB because entries became essays duplicating the PR body — the longest was
7,786 characters on one line, which is also why nothing auto-merged. The gate
enforces a deliberately generous backstop (10 lines, 500 characters per line):
every one of those essays trips it and no reasonable entry comes near it.

## Checking and assembling

```bash
pnpm changelog:verify                  # gate: source changed => a fragment exists, and all parse
pnpm changelog:assemble 1.1.0 --dry-run  # preview the version section
pnpm changelog:assemble 1.1.0          # fold into CHANGELOG.md and delete the fragments
```

`changelog:verify` runs in CI. It compares against `origin/main` (override with
`--base <ref>` or `$CHANGELOG_BASE_REF`) and **fails** rather than skipping if it
cannot resolve a base — a gate that passes when it cannot find its comparison
point is worse than no gate.

It counts a fragment only when all three are true: your branch touched the path,
the file is on disk and parses clean, **and** it was not already on the base ref.
Fragments accumulate here until a release, so the directory is normally full of
other people's entries — editing one, deleting one, or dropping a dotfile in
here does not stand in for writing your own.

Paths exempt from needing a fragment are listed as `EXEMPT_RULES` in
`scripts/lib/changelog-fragments-core.mjs`: `docs/`, tests, `e2e/`,
`graphify-out/`, `.claude/agent-memory/`, `eval-results/`, the lockfile, and
`CHANGELOG.md` itself. Everything else requires one — the gate is fail-closed,
because this repository's norm is that essentially every merged PR earns a line.

## Dependabot (#1270)

Dependabot has no step in which it could write a fragment, so requiring one of
it did not enforce a standard — it parked every one of its PRs forever. All ten
open on 2026-08-06 failed this gate, the oldest since 2026-08-02, including
every security bump in the queue. **A rule no author in a class can satisfy is a
permanently-red check, which carries the same information as an ignored one**
(the argument #1219 made about `Semgrep` on `main`).

So the exemption is by **author**, intersected with a **dependency-manifest
path**: `DEPENDENCY_MANIFEST_RULES` covers `package.json` at any depth,
`pnpm-workspace.yaml`, `.github/workflows/*.yml` and composite `action.yml` —
the two ecosystems `.github/dependabot.yml` configures. Both halves must hold:

| | manifest path | anything else |
| --- | --- | --- |
| `dependabot[bot]` / `app/dependabot` | exempt | **still requires a fragment** |
| a human | **still requires a fragment** | **still requires a fragment** |

Exempting the manifests outright would have been simpler and lossier: #1240 and
#1241 each moved CVSS 7.0+ advisories by hand and each wrote an entry worth
having. **A hand-written dependency change still needs one.**

CI supplies the author as `CHANGELOG_PR_AUTHOR` from
`github.event.pull_request.user.login`; locally, pass `--author <login>`.
Absent or empty — a push to `main`, or any local run — is the *strict* reading,
and every waived path is printed by name in the job log. The exemption touches
only the "did this branch owe an entry" half: every fragment on disk is still
parsed, and an unreadable `.changes/unreleased/` still fails (#1215).

Assembly is a **maintainer action taken when cutting a tagged release**. It does
not bump any `package.json` version, and it leaves the legacy `[Unreleased]`
body alone: #1191 migrates forward and does not rewrite the 996 entries already
in it.

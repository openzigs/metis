# 0023 — Commit history comes from a separate blobless history repository, bounded to a year

- **Status**: Proposed (Part A of #2338: reviewed before any code is written)
- **Date**: 2026-11-12
- **Issue**: [#2338](https://github.com/openzigs/metis/issues/2338) (epic [#2322](https://github.com/openzigs/metis/issues/2322))
- **Relates to**: #2325 (the citation contract the tool's result uses), #2326 (how a tool
  says "unavailable"), #2333 (the shared redaction commit text passes), #2335 (a
  push-triggered refresh is also when history is refreshed), epic #1827

## Context

Chat (and later the MCP server) should answer "when did this change, and why": the commits
that touched a file, a line range or a symbol, with subject, date and a link.

Repository connectors keep no history. `shallowCloneRepo` clones with `--depth=1
--single-branch --filter=blob:limit=<cap> --no-tags`, `pullOrCloneRepo` fast-forwards that
clone, and `fetchCommitInto` restores a lost clone at depth 1
(`server/src/lib/connectors/repo/repo-service.ts`). The clone's size check (`dirSize`)
counts `.git` against `REPO_CLONE_MAX_BYTES`, which defaults to 100 MB
(`MAX_REPO_CLONE_BYTES`, `packages/shared/src/constants.ts`). Git connectors are `github`,
`github_enterprise` and `gitlab`; `local` and `upload` sources are folders and archives
with no history (`REPO_PROVIDERS`, `NON_GIT_REPO_PROVIDERS`).

So a history tool is first a question of how history gets onto the server.

## Options measured

All numbers were measured on 2026-11-12 with Git 2.50.1 on a home connection, against two
public repositories: **miniflux/v2** (3,122 commits on `main`, a 6.6 MB working tree, close
to a typical METIS project), and **kubernetes/kubernetes** (143,508 commits on `master`, a
359 MB working tree, merge-heavy: the "large repository"). The window is one year
(`2025-11-12`). The read-time queries were the 20 most recent commits for one file
(`internal/reader/fetcher/request_builder.go`, `pkg/kubelet/kubelet.go`), and the same for
a line range (`-L 40,80` and `-L 100,200`). The baseline is today's depth-1 clone:
`.git` 1.4 MB in 1.1 s (miniflux), 53 MB in 17 s (kubernetes).

| Option | `.git` on disk (miniflux / kubernetes) | Fetch time | 20 commits for a file | 20 commits for a line range |
|---|---|---|---|---|
| **A.** Deepen by date: `--shallow-since=<1 year>` | 2.9 MB / 142 MB (90 days: 90 MB) | 1.3 s / 43 s fresh; deepening the existing miniflux clone took 15 s | 0.04 s / 0.3 s, **wrong** (below) | 0.02 s / 1.2 s, **wrong** (below) |
| **B.** Deepen by count: `--depth=2000` | not measured / **1.32 GB** | — / 2 min 22 s | — | — |
| **C.** Blobless partial clone, full history (`--filter=blob:none`) | 4.7 MB / 303 MB | 1.4 s / 32–42 s | 0.05 s / 0.9 s, complete | **5 s / 1 min 42 s**: every old version of the file is fetched lazily, over the network, during the chat call |
| **C + prefetch.** C, then one batched fetch of the blobs that changed inside the window | **7.1 MB / 441 MB** | C, then **+1.4 s / +67 s** (3 s listing, 64 s fetching) | 0.05 s / 0.02 s, complete | **0.02 s / 0.9 s, local, correct** |
| **D.** Treeless partial clone (`--filter=tree:0`) | — / 119 MB | — / 28 s | **over 3 min** (cut off after 14 commits): trees are fetched lazily per commit | — |
| **E.** The host's commits API | none | none | 0.5 s / 1.0 s (`GET /repos/{o}/{r}/commits?path=`) | no history API; GitHub GraphQL `blame` gives the *last* commit per line (2.8 s, 65 commits for kubernetes lines 100–200) |

### What the measurements showed that the sizes do not

1. **A shallow boundary reads as a change.** The commit at a shallow boundary has no parent,
   so git reports it as adding every file. On miniflux, `git log -- request_builder.go`
   listed `fd7c886 build(deps): bump goquery` (2025-11-17) as a change to that file; it is
   not one. `git log -L` attributes every remaining line to the boundary in the same way.
2. **A date bound cuts holes inside the window on a merge-heavy repository.** Kubernetes'
   one-year shallow clone has **60** boundary commits, not one. A boundary is recorded with
   no parents at all, and boundary `34da38ea4` is the 2026-10-30 merge of
   kubernetes/kubernetes#131719, opened on 2025-05-12, before the bound. The
   kubernetes line-range query stopped at boundary `34da38ea4` (2026-10-30) and returned
   only that commit; the true most recent change to those lines, `e83c643` (committed
   2026-08-19, well inside the year), was missed. Option C + prefetch returned it.
3. **A depth bound does not bound size.** On kubernetes every commit is within 2,000 hops
   of the tip through merge parents, so `--depth=2000` downloaded the whole history
   (143,508 commits, 1.32 GB). It is not a bound at all on a merge-heavy repository.
4. **Author date is not the bound.** `f262b1b0b` was authored on 2024-11-10 and committed on
   2026-10-22; it is inside a one-year window by committer date only. `git log --since`
   uses the committer date, and so must anything that states the bound.
5. **Lazy fetches can be refused.** With `git --no-lazy-fetch`, a line-range query inside
   the prefetched window answered locally; the same query without `--since` failed with
   `fatal: unable to read <blob>` (exit 128) instead of reaching the network. So reading
   from a blobless repository can be made network-free and credential-free, and "I ran out
   of local history" is a detectable error rather than a silent stop.

### The four questions, per option

| | Behaviour on incremental refresh | Connectors that cannot support it | Credentials |
|---|---|---|---|
| **A** | `pull --ff-only` on a shallow clone fetches every new commit; the boundary stays put, so the window grows until a re-clone resets it. `pullOrCloneRepo`'s fallback re-clone silently drops back to depth 1 unless its arguments change too | `local`, `upload` | the connector's token, at ingest only |
| **B** | as A | as A | as A |
| **C + prefetch** | fetch the newly indexed commit (new commits and trees only), then prefetch only the blobs still missing in the window. Not measured: the first fetch is the upper bound | `local`, `upload`. A host without partial-clone support ignores the filter with a warning and sends everything; the size cap then catches it. Today's clone already sends `--filter=blob:limit`, so such a host has been sending everything all along | the connector's token, at ingest only. Reads run with `--no-lazy-fetch` and no credential in the environment, so a chat call cannot reach the network |
| **D** | as C | as C | as C, and the token again on every read |
| **E** | nothing to refresh; it is always current, so every call has to pin `sha=<indexed commit>` or it describes code newer than the index | `local`, `upload`; `gitlab` needs a second client (`/projects/:id/repository/commits`) beside the Octokit one | the connector's token on **every chat call**, under the host's rate limit (5,000 requests per hour per token on GitHub) |

## Decision

> **History comes from a separate, bare, blobless history repository per git connector,
> fetched at the indexed commit at ingest, with the blobs of the last 365 days prefetched in
> one batch. The chat tool reads it locally with lazy fetching disabled. Its bound is 365
> days by committer date, and the tool says so whenever an answer reaches it.**

- **Why C + prefetch.** It is the only option measured that is both correct and local. A
  and B are wrong in ways a tool cannot repair (findings 1–3), D is too slow to read, plain
  C makes a chat call download history with the connector's token, and E puts a token and
  a rate limit on every chat call and needs a second client per host.
- **Why a separate repository.** The working-tree clone stays exactly as it is. Its size cap,
  `pullOrCloneRepo`, the #1322 restore at a commit, and every reader of the clone are
  untouched; a failed or oversized history fetch costs the history and nothing else. It
  lives at `<clone root>/<connectorId>.history.git`, resolved in
  `server/src/lib/connectors/repo/clone-path.ts` beside the clone path (#777: one source of
  truth for these paths).
- **Pinned to the indexed commit.** The history fetch runs after a code-graph ingest has
  recorded its commit, and fetches that commit, so the history describes the same version
  as the citations of #2325, and line ranges mean the same lines.
- **Its own cap.** `REPO_HISTORY_MAX_BYTES`, default twice the clone cap (200 MB). The
  measured history-to-working-tree ratio was 1.1× (miniflux) and 1.2× (kubernetes). Over
  the cap, the history repository is deleted and the connector reads as "history too
  large", never as a failed ingest.
- **Off by default.** History is fetched only when the history tool is enabled. It costs
  what C + prefetch measured, on top of the clone: 2.8 s and 7.1 MB for miniflux, 1 min 49 s
  and 441 MB for kubernetes. It becomes default only on the #2338 measurement.

### The bound, and what the tool returns beyond it

- **Bound: 365 days, by committer date**, configurable when Part B adds the key. One bound
  for file, line-range and symbol queries, so every answer about one project covers the
  same period. Trees for all time are on disk, so a file-only query could go further, but
  two different horizons in one chat would be harder to state than one.
- **Result cap: 20 commits per call**, newest first, with a cursor for the next page.
- **Every result states its coverage**, and none is ever an empty list on its own:
  - `more: "cap"`: more commits exist; the cursor fetches them.
  - `more: "bound"`: the walk reached the bound. The result says "no history before
    <date> is available to this tool; the file may have changed before then", with zero
    commits or with some.
  - `more: "none"`: only when the history provably starts inside the window: the commit
    that added the path, or the repository's root commit, is inside it.
  - A `fatal: unable to read <blob>` from git (finding 5) means local history ran out
    before the bound. It is reported as `more: "bound"` at the date reached, never as an
    error or as "unchanged".
  - `status: "unavailable"` with a reason, in the manner of #2326: `no_history_for_source`
    (`local`, `upload`), `history_not_fetched` (the tool is off, the fetch failed or has not
    run since the connector was added), `history_too_large`.

## Consequences for Part B

These are the constraints the tool is built to, recorded here so the review of this note
can reject them before any code exists.

- **No shell.** `git` runs through `execFile` with an argument array: `--no-lazy-fetch`,
  `--git-dir=<history repo>`, `--no-ext-diff`, `--no-textconv`, a timeout and an output
  cap. The environment carries `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1` and no
  credential.
- **Validated inputs.** The revision is the stored indexed SHA (checked against the
  existing `SHA_RE`), never one the model supplies. The path is repository-relative,
  normalised, has no `..`, no leading `-` and no control character, follows `--`, and must
  be a file the index knows for that connection. A line range is two positive integers. A
  symbol is resolved through the code graph to a path and a line range at the indexed
  commit, and an ambiguous symbol returns its candidates instead of guessing.
- **Boundaries cannot be misread.** The history repository is never shallow, so finding 1
  cannot occur; the tool still refuses to run on one that is (a `shallow` file present).
- **Renames are followed** (`--follow`) for file queries inside the window, where the blobs
  that rename detection compares are present.
- **ACL.** The connection is looked up by project and id, never by id alone, and the path
  passes the `code-access.ts` filter before git runs. A file the caller may not read gets
  the reply a missing file gets, as `read_file_slice` does.
- **Commit text is redacted.** Subject, body excerpt and author name pass #2333's shared
  redaction. The git format string never requests an e-mail (`%ae`, `%ce`), and the
  connector redactor's e-mail pattern (`pii-redactor.ts`) removes the addresses in
  trailers such as `Signed-off-by:`. #2333 keeps PII patterns off source code; commit
  text is prose about people, so here the e-mail pattern applies as well.
- **Permalinks** come from the #2325 builder, extended with a commit form
  (`/commit/<sha>` on GitHub and GitHub Enterprise, `/-/commit/<sha>` on GitLab) and built
  from stored connector metadata only; any other host gets `null`.
- **Git on the server.** `--no-lazy-fetch` reached Git in March 2024; Debian trixie, the
  base of `Dockerfile.server`, packages Git 2.47.3. That Dockerfile installs no `git`
  package today, so Part B must check that the image it ships can run `git` at all, and
  add it if not; the existing clone path depends on the same binary.

## Rejected

- **A, deepen by date.** It is the cheapest correct-looking option and the only one whose
  errors are invisible: a boundary reported as a change (finding 1) and holes inside the
  window (finding 2). Dropping boundary commits fixes the first; nothing local fixes the
  second.
- **B, deepen by count.** Measured unbounded on a merge-heavy repository (finding 3).
- **Plain C.** It is complete for files, but a line range downloads history during the chat
  call with the connector's token, taking 1 min 42 s on kubernetes.
- **D, treeless.** Over three minutes for one file's history.
- **E, the host API.** It needs a token and a rate limit on every chat call, two clients
  (Octokit and GitLab), an explicit pin to the indexed commit, and it has no line-range
  history. It stays available as a fallback if a host is ever found that refuses partial
  clones and is too large to clone in full; none is known.

## How the numbers were taken

```bash
git clone --depth=1 --single-branch --branch=<b> --filter=blob:limit=104857600 --no-tags <url> a
git clone --shallow-since=2025-11-12 --single-branch --branch=<b> --filter=blob:limit=104857600 --no-tags <url> b
git clone --filter=blob:none --single-branch --branch=<b> --no-tags <url> c
git clone --filter=tree:0   --single-branch --branch=<b> --no-tags <url> d
# prefetch the window's blobs into c
git -C c rev-list --objects --missing=print --since=2025-11-12 HEAD > objs   # "?<oid>" = missing
grep '^?' objs | cut -c2- > oids                                            # 2,292 / 60,341 blobs
git -C c fetch --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin origin < oids
# reads
git --no-lazy-fetch -C c log --since=2025-11-12 -n 20 --format='%h %cd %s' -- <path>
git --no-lazy-fetch -C c log --since=2025-11-12 -n 20 --format='%h %cd' --no-patch -L <a>,<b>:<path>
```

Sizes are `du -sk` of `.git`; times are wall-clock from `time`, single runs. The network
dominated every fetch time, so treat them as orders of magnitude, not as benchmarks.

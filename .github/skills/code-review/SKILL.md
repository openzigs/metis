---
name: code-review
description: Structured review of an existing pull request. Use when asked to review, critique, audit, or sign off on a PR, or to check one against its epic or issue. Walks requirements, OWASP Top 10 security, code quality, performance, test coverage, CI status, and prior review comments, then publishes a GitHub review with inline comments. Use resolve-pr-comments to FIX review feedback and code-issue to write new code.
argument-hint: "[PR number] — e.g. 'review PR #47' or 'review PR #47 against epic #12'"
---

# Code Review

## Purpose

This skill drives the **Code Review** agent through a structured, multi-dimensional review of a pull request. It goes beyond surface-level linting — it validates the PR against the original requirements, checks for OWASP security issues, evaluates performance characteristics, verifies test quality, and assesses code design. The review is published as a formal GitHub PR review with inline comments.

Inspired by [Google's Engineering Practices](https://google.github.io/eng-practices/review/reviewer/looking-for.html) and the [OWASP Code Review Guide](https://owasp.org/www-project-code-review-guide/).

## When to Use

- A PR is ready for review and the user asks "review PR #N"
- The user wants a pre-merge quality gate before approving
- After the Code Issue agent creates a PR and before the user merges
- The user asks to "check if PR #N meets the requirements for issue #M"
- As a handoff target from the Code Issue agent's delivery step

## Agent

Execute with the **Code Review** agent (`code-review.agent.md`), which has the same tool access as Code Issue but operates with a reviewer mindset — read-heavy, comment-focused, doesn't modify code unless asked.

## Workflow Overview

```
┌───────────────────────────────────────────────────────┐
│  1. ORIENT — Read PR, linked issues, and docs/        │
├───────────────────────────────────────────────────────┤
│  1b. SCANNER — Fetch CodeQL / GHAS bot comments       │
├───────────────────────────────────────────────────────┤
│  1c. PRIOR REVIEWS — Analyze human & Copilot comments │
├───────────────────────────────────────────────────────┤
│  2. REQUIREMENTS — Validate completeness against spec │
├───────────────────────────────────────────────────────┤
│  3. DESIGN — Evaluate architecture and design choices │
├───────────────────────────────────────────────────────┤
│  4. SECURITY — OWASP Top 10 + CVE scan + scanner xref │
├───────────────────────────────────────────────────────┤
│  5. QUALITY — Code quality, complexity, naming, style │
├───────────────────────────────────────────────────────┤
│  6. PERFORMANCE — Identify bottlenecks and anti-pats  │
├───────────────────────────────────────────────────────┤
│  7. TESTS — Coverage, quality, edge cases             │
├───────────────────────────────────────────────────────┤
│  8. DOCUMENTATION — Inline docs, README, changelogs   │
├───────────────────────────────────────────────────────┤
│  9. PUBLISH — Submit GitHub review with verdict       │
├───────────────────────────────────────────────────────┤
│  10. HANDOFF — Offer to fix issues via Code Issue     │
└───────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Orient

**Goal:** Build a complete mental model before reviewing any code.

1. **Read the PR**:
   ```bash
   gh pr view {PR_NUMBER} --json number,title,body,author,headRefName,baseRefName,reviews
   ```
   - Title, description, branch, base branch
   - Extract `Closes #N` / `Fixes #N` references
   - Note the author and any previous reviews
2. **Read the linked issue(s)/epic**:
   ```bash
   gh issue view {ISSUE_NUMBER} --json number,title,body,labels,state
   ```
   - Acceptance criteria and definition of done
   - Sub-issue scope and boundaries
   - Labels (bug, feature, security, etc.)
3. **Scan docs/ folder** — read any relevant specs, architecture docs, or user guides in the `docs/` directory
4. **Fetch the diff**:
   ```bash
   gh pr diff {PR_NUMBER}
   ```
5. **List changed files** to understand the scope:
   ```bash
   gh pr view {PR_NUMBER} --json files --jq '.files[].path'
   ```
6. **Read each changed file in full** — not just the diff hunks. Context matters.
7. **Check CI status immediately** — run this before reading any code:
   ```bash
   gh pr view {PR_NUMBER} --json statusCheckRollup --jq '.statusCheckRollup[] | {name: .name, conclusion: .conclusion}'
   ```
   If any job is **FAILURE**, fetch its logs now:
   ```bash
   gh run list --branch {BRANCH} --json databaseId,name,conclusion --jq '.[] | select(.conclusion == "failure") | .databaseId'
   gh run view {RUN_ID} --log-failed
   ```
   **ALL CI failures must be fixed — even ones predating this PR.** A failing pipeline blocks deployment regardless of cause. When you find any failure:
   - Identify the root cause from the logs
   - Fix it directly in the current branch
   - Include "Fixed pre-existing CI failure: [description]" in your review
   Do not accept the rationalization that a CI failure is "pre-existing and unrelated" — all red must be green before merge.

### Step 1b: Security Scanner Comments (CodeQL / GHAS)

**Goal:** Collect all findings from automated security scanners so they can be cross-referenced during the security review and tracked in the final verdict.

#### Auto-detect CodeQL PR Status

Before fetching scanner comments, determine whether CodeQL actually runs on pull requests in this repository:

```bash
grep -E '^\s*pull_request' .github/workflows/codeql.yml 2>/dev/null
```

- **Output found** (active `pull_request:` trigger exists): CodeQL runs on PRs. Continue with the full procedure below — scanner comments may exist and unresolved High/Critical findings are blocking.
- **No output** (file missing or `pull_request:` trigger is commented out): CodeQL does **not** run on PRs. `github-advanced-security` bot comments will not exist. **Skip to Step 1c** and rely on manual OWASP review in Step 4 as the security gate. Do NOT wait for or block on CodeQL results.

GitHub Advanced Security (GHAS) runs CodeQL analysis on PRs and posts review comments from the `github-advanced-security` bot. These comments identify real vulnerabilities (injection, path traversal, missing rate limiting, XSS, etc.) that the human/agent reviewer must acknowledge.

**Procedure:**

1. **Fetch all review comments** on the PR:
   ```bash
   gh api --paginate "repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments?per_page=100" \
     --jq '.[] | {id, user: .user.login, path, line, body, in_reply_to_id}'
   ```
   `--paginate` matters: the default page is 30 and a busy PR silently truncates.

2. **Filter for scanner bot comments** — identify comments where `.user.login` is `github-advanced-security` (CodeQL), `dependabot`, `snyk`, or any other known security bot. These are distinct from human reviewer comments.

3. **Classify each scanner finding.** The REST payload above carries staleness but
   **not** resolution — `isResolved` lives on the review *thread*, which only GraphQL
   exposes:

   | Signal | Where | Meaning |
   |--------|-------|---------|
   | `position: null` | REST comment | The line is no longer in the diff — the finding MAY be resolved. **Read the current file at the flagged location to verify.** |
   | `position` non-null | REST comment | The code has NOT changed since the comment — finding is **likely still present**. |
   | `isResolved: true` | GraphQL thread | Explicitly resolved by a reviewer — can be skipped. |

   ```bash
   gh api graphql -f query='
     query($owner:String!, $repo:String!, $pr:Int!) {
       repository(owner:$owner, name:$repo) {
         pullRequest(number:$pr) {
           reviewThreads(first:100) {
             nodes { isResolved isOutdated comments(first:1) { nodes { path line author { login } } } }
           }
         }
       }
     }' -F owner={owner} -F repo={repo} -F pr={PR_NUMBER}
   ```
   Note `-F` (typed) rather than `-f` for `pr`: GraphQL's `Int!` rejects the string
   `-f` would send.

4. **Build a scanner findings table** for use in Step 4 and Step 9:

   ```markdown
   | # | Bot | File:Line | Finding | Severity | Outdated? | Verified? |
   |---|-----|-----------|---------|----------|-----------|----------|
   | 1 | CodeQL | src/api/m365.ts:151 | Missing rate limiting | High | No | Pending |
   | 2 | CodeQL | src/m365/file-parser.ts:132 | Incomplete string escaping | Medium | No | Pending |
   ```

5. **For each non-outdated, non-resolved finding**, read the current file at the flagged line to understand the context. These are your **pre-seeded security findings** for Step 4.

6. **For each outdated finding**, still verify by reading the current code — "outdated" means the diff changed, NOT that the issue was fixed. A refactor might move the vulnerability rather than fix it.

**Important:** Scanner findings are authoritative signals. A CodeQL High/Critical that remains unaddressed after your review is a **blocking** issue that must appear in your verdict, even if your own manual analysis didn't independently flag it.

**Critical — CodeQL suppression comments do NOT work:** Inline comments like `// codeql[js/path-injection]` are **ineffective** at suppressing CodeQL findings. If you see a developer using comment-based suppressions, flag it as a blocking issue and instruct them to fix the actual code instead. Valid CodeQL fixes include: `path.resolve()` + `startsWith()` containment for path injection, URL hostname allowlisting for SSRF, parameterized queries for SQL injection, and `express-rate-limit` middleware for missing rate limiting.

### Step 1c: Existing Reviewer Comments (Human & Copilot)

**Goal:** Identify and analyze all prior review comments from human reviewers, GitHub Copilot, or any other non-scanner reviewer so their feedback is incorporated into the review verdict.

Other people or automated reviewers (e.g., GitHub Copilot code review) may have already left comments on the PR. These comments represent prior review work that should not be ignored or duplicated.

**Procedure:**

1. **From the same review comments fetched in Step 1b**, filter for all comments where `.user.login` is NOT a known scanner bot (`github-advanced-security`, `dependabot`, `snyk`, `sonarcloud`) and is NOT the PR author themselves. The REST payload has no `author` field — that spelling exists only on the GraphQL thread nodes, as `author.login`.

2. **Identify the reviewer type** for each comment:

   | Author Pattern | Type | Trust Level |
   |----------------|------|-------------|
   | `copilot` / `github-copilot` / `copilot-pull-request-reviewer` | GitHub Copilot automated review | Medium — good at patterns, may miss context |
   | Any human username | Human reviewer | High — understands business context |
   | Other bots (e.g., `codecov`, `sonarcloud`) | Quality/coverage bots | Medium — data-driven, verify claims |

3. **Classify each existing comment** on the same signals as Step 1b — staleness from
   the REST comment, resolution from the GraphQL thread:

   | Signal | Where | Meaning |
   |--------|-------|---------|
   | `position: null` | REST comment | The line has left the diff — **verify by reading current code** |
   | `position` non-null | REST comment | Code unchanged since the comment — it likely still applies |
   | `isResolved: true` | GraphQL thread | Explicitly resolved — note but don't re-open unless the fix is wrong |
   | `comments.nodes.length > 1` | GraphQL thread | Read the full thread to understand the discussion before judging |

4. **Build an existing comments table** for tracking:

   ```markdown
   | # | Reviewer | Type | File:Line | Comment Summary | Outdated? | Status |
   |---|----------|------|-----------|-----------------|-----------|--------|
   | 1 | mgcronin | Human | src/api/m365.ts:102 | Missing rate limiting on /cleanup | No | Unresolved |
   | 2 | copilot | Copilot | ui/lib/api.ts:42 | Unused import | Yes | Verify |
   ```

5. **For each unresolved, non-outdated comment:**
   - Read the current code at the flagged location
   - Determine if the comment is valid, already addressed, or a false concern
   - If valid and unaddressed: include it in your review findings (do NOT duplicate it as a new inline comment — reference the existing thread instead)
   - If addressed by subsequent commits: note it as resolved in your review summary

6. **For outdated comments with replies:**
   - Read the full thread to understand the discussion
   - Check if the code change that made it "outdated" actually addressed the concern
   - If the concern persists despite the code change, flag it as still-open

7. **Cross-reference with your own findings:**
   - If a prior reviewer already flagged something you also found, reference their comment rather than duplicating
   - If a prior reviewer flagged something you disagree with, explain your reasoning
   - If a prior reviewer's comment was addressed but introduced a new issue, flag the regression

**Priority of existing comments:**
- 🔴 **Blocking comments** from humans (marked with "CRITICAL", "BLOCKING", or severity indicators) → must be addressed before APPROVE
- 🟡 **Copilot suggestions** → validate each one; Copilot can produce false positives on complex code
- 🟢 **Nit / style comments** → nice to fix but not blocking
- **Resolved threads** → verify the fix is correct, then skip

**Include in Step 9 (Publish) review body:**
```markdown
### Prior Review Comments: {N total, M unresolved}
| Reviewer | Unresolved | Addressed | Disagreed |
|----------|------------|-----------|-----------|
| mgcronin | 2 | 3 | 0 |
| copilot | 0 | 1 | 1 (false positive) |
```

### Step 1d: CI Status Check

**Goal:** Verify the CI pipeline is fully green before proceeding with the review. ALL failing CI jobs are blocking — including pre-existing failures not introduced by this PR.

**Procedure:**

1. **Fetch CI job status:**
   ```bash
   gh pr checks {PR_NUMBER}
   ```

2. **Build a CI status table:**

   ```markdown
   | Job | Status | Introduced by PR? | Notes |
   |-----|--------|--------------------|-------|
   | api | ❌ FAILED | No — pre-existing type error | Blocking |
   | ui | ✅ Passed | — | — |
   ```

   > **Note:** This repository does NOT have a CodeQL workflow on pull requests. Do not expect
   > or wait for CodeQL entries in `gh pr checks` output. **Every other check is real, and
   > there are twelve of them** — `api`, `api-outcome`, `changelog`, `generative-e2e`,
   > `postgres-adapter`, `postgres-migrate-deploy`, `sql-lineage`, `ui`, `e2e`, `windows`,
   > `Dependency audit` and `Semgrep`. This note used to end *"Only CI jobs (`api`, `ui`) will
   > appear"*, which was true when it was written and had since become false in ten places;
   > an agent obeying it treated ten checks as non-existent (#1282). Read the set `gh pr
   > checks` actually returns rather than a list from memory — including this one, which will
   > drift too.

3. **For each failing job:**
   - Fetch the failure logs: `gh run view {RUN_ID} --log-failed` or check the Actions tab URL
   - Determine **root cause** — is it a type error, test failure, lint error, build error?
   - Determine **whether this PR introduced it** — check if the same job fails on `main` branch
   - **Regardless of origin, the failure is blocking.** Pre-existing failures must be fixed in this PR as a prerequisite to merging. We do not merge into a red pipeline.

4. **Include the CI status table in Step 9 (Publish) review body** and in the verdict.

**Gate logic:**
- **Any failing CI job** → `REQUEST_CHANGES` (blocking). The PR must fix it, even if the failure is pre-existing.
- The review body must include remediation guidance: what file/line causes the failure and how to fix it.
- If ALL jobs pass → no CI impact on verdict.

### Step 2: Requirements Validation

**Goal:** Ensure the PR delivers what was asked for — no more, no less.

Check each item against the linked issue/epic:

| Check | Question |
|-------|----------|
| **Completeness** | Does the PR address ALL acceptance criteria from the issue? |
| **Scope creep** | Does the PR include changes NOT described in the issue? |
| **Sub-issues** | If this is part of an epic, are all assigned sub-issues covered? |
| **Edge cases** | Did the issue mention edge cases? Are they handled? |
| **Backwards compat** | Does this change break any existing APIs or behavior? |

**Output:** List of requirements with pass/fail status. Flag any gaps.

### Step 3: Design Review

**Goal:** Evaluate high-level architecture and design decisions.

Based on [Google's design review criteria](https://google.github.io/eng-practices/review/reviewer/looking-for.html#design):

- **Does this change belong here?** Or should it be in a library, a different module, or a configuration?
- **Integration:** Does it integrate well with the existing codebase architecture?
- **Abstractions:** Are the right abstractions used? Too many layers? Too few?
- **Coupling:** Does this change introduce tight coupling between modules?
- **Single Responsibility:** Does each new class/function/module do one thing?
- **Over-engineering:** Is there unnecessary generalization or premature abstraction?
- **Patterns:** Does it follow existing patterns in the codebase, or introduce new ones without justification?

Use `context7` to verify any library APIs are used correctly.

**Impact analysis via graphify (if available).** If `graphify-out/graph.json` exists, run `graphify query "<symbol_or_path>" graphify-out/graph.json` for each significantly changed module and `graphify path <changed_file> <suspected_dependent>` to surface non-obvious callers/importers. Flag any caller that the diff didn't update — these are common review-blocking regressions. Skip if no graph is present (it's opt-in dev tooling, not a hard requirement).

### Step 4: Security Review (OWASP Focus)

**Goal:** Identify security vulnerabilities before they reach production.

Scan all changed files for these OWASP Top 10 categories:

| OWASP Category | What to Look For |
|----------------|------------------|
| **A01: Broken Access Control** | Missing auth checks, IDOR, privilege escalation, CORS misconfig |
| **A02: Cryptographic Failures** | Hardcoded secrets, weak algorithms (MD5, SHA1), missing TLS, plaintext storage |
| **A03: Injection** | SQL injection, NoSQL injection, OS command injection, LDAP injection, XSS |
| **A04: Insecure Design** | Missing rate limiting, no input validation at trust boundaries, business logic flaws |
| **A05: Security Misconfiguration** | Debug mode enabled, default credentials, unnecessary features exposed, verbose errors |
| **A06: Vulnerable Components** | Known CVE in dependencies — check the `Dependency audit` CI job result via `gh pr checks {PR_NUMBER}` instead of re-running `pnpm audit`. CI runs it on every PR; a failed audit job is a blocking finding. |
| **A07: Auth Failures** | Weak passwords allowed, missing MFA, session fixation, token leakage in logs/URLs |
| **A08: Data Integrity Failures** | Insecure deserialization, unsigned updates, CI/CD pipeline manipulation |
| **A09: Logging Failures** | Missing audit logs for sensitive ops, PII in logs, no alerting |
| **A10: SSRF** | Unvalidated URLs from user input used in server-side requests |

**Additional checks:**
- No `eval()`, `innerHTML` with untrusted data, or `dangerouslySetInnerHTML` without sanitization
- External links use `rel="noopener noreferrer"` with `target="_blank"`
- API keys / secrets not committed (check `.env` patterns, config files)
- Path traversal protection on file operations
- CSRF tokens present on state-changing requests

**Cross-reference with scanner findings (Step 1b):**

For each finding in the scanner table built during Step 1b:

1. **Read the current code** at the flagged file and line.
2. **Verify** whether the finding is still valid, a false positive, or already fixed.
3. **Update the Verified column**: `Still present`, `Fixed`, or `False positive (reason)`.
4. **For findings still present**: Add them to your review as inline comments with the scanner's severity. Prefix with the scanner name for traceability:
   ```
   🔒 **CodeQL: Missing rate limiting (High)** — This route handler performs file system access without rate limiting.
   Recommend: Add express-rate-limit middleware to this route group.
   ```
5. **For false positives**: Optionally add a comment explaining why the finding doesn't apply, so the scanner comment can be resolved.
6. **Any CodeQL High or Critical finding that is `Still present` is automatically a blocking issue** — it must contribute to a `REQUEST_CHANGES` verdict regardless of other review dimensions.

**Scanner-specific patterns to check:**

| Scanner Finding | What to Verify |
|-----------------|----------------|
| Missing rate limiting | Is the route behind auth middleware? Does it do I/O? Add `express-rate-limit` if exposed. |
| Incomplete string escaping | Is the output used in HTML/SQL context? Check if backslash, quote, and angle bracket escaping are all handled. |
| Incomplete multi-character sanitization | Does the sanitizer handle nested/reconstructed tags? Test with `<scr<script>ipt>` input mentally. |
| Double escaping/unescaping | Trace the data flow: does an entity decode (`&amp;` → `&`) feed into another decode or an HTML context? |
| Uncontrolled data in path expression | Is `path.resolve()` + `startsWith(allowedDir)` used? Check for symlink bypasses. |
| Polynomial ReDoS | Is the regex applied to user input? Check for nested quantifiers. |

**Severity ratings:** Critical / High / Medium / Low / Informational

### Step 5: Code Quality

**Goal:** Ensure the code is readable, maintainable, and follows conventions.

Based on [Google's code review checklist](https://google.github.io/eng-practices/review/reviewer/looking-for.html):

| Dimension | What to Check |
|-----------|---------------|
| **Complexity** | Can each function/method be understood quickly? Is anything over-engineered? |
| **Naming** | Are variables, functions, classes named clearly and consistently? |
| **Comments** | Do comments explain *why*, not *what*? Are there stale comments? |
| **Style** | Does the code follow the project's lint config and style conventions? |
| **Consistency** | Does new code match existing patterns? |
| **DRY** | Is there duplicated logic that should be extracted? |
| **Error handling** | Are errors caught at system boundaries? Are error messages helpful? |
| **Dead code** | Are there unused variables, imports, or unreachable branches? |
| **Magic values** | Are there hardcoded numbers/strings that should be constants? |

### Step 6: Performance Review

**Goal:** Catch performance problems before they manifest in production.

| Pattern | What to Look For |
|---------|------------------|
| **N+1 queries** | Database calls inside loops |
| **Unbounded queries** | `SELECT *` without LIMIT, missing pagination |
| **Memory leaks** | Event listeners not cleaned up, unclosed resources, growing caches |
| **Bundle size** | Large dependencies imported for small features (`moment` vs `dayjs`) |
| **Unnecessary re-renders** | React components missing `useMemo`/`useCallback` where appropriate |
| **Blocking operations** | Synchronous I/O on the main thread, long-running computations without workers |
| **Missing caching** | Repeated expensive computations without memoization |
| **Regex catastrophic backtracking** | Complex regex patterns that could cause ReDoS |

### Step 7: Test Review

**Goal:** Verify tests are correct, meaningful, and sufficient.

| Check | Question |
|-------|----------|
| **Coverage** | Are new code paths covered? Target ≥80% |
| **Happy path** | Do tests verify the primary use case? |
| **Edge cases** | Empty inputs, nulls, boundary values, large datasets? |
| **Error cases** | Do tests verify error handling and failure modes? |
| **Test quality** | Are assertions specific? Do tests have clear names? |
| **False positives** | Would these tests still pass if the implementation were wrong? |
| **Isolation** | Are unit tests properly isolated from external dependencies? |
| **Missing tests** | Are there code changes without corresponding test changes? |

### Step 8: Documentation Review

| Check | Question |
|-------|----------|
| **Inline docs** | Are public APIs documented? Are complex algorithms explained? |
| **README** | If behavior changed, is the README updated? |
| **Changelog fragment** | If the PR has any user-facing changes, does it add `.changes/unreleased/<issue>-<slug>.md` with `issue:`/`section:` frontmatter? A missing fragment with user-facing changes is a **blocking** issue. A PR that edits `CHANGELOG.md` directly is also blocking — that file is assembled from fragments at release and editing it re-creates the parallel-PR conflict #1191 removed. `pnpm changelog:verify` decides this in code; run it rather than judging by eye. |
| **Architecture docs** | If new modules, services, API endpoints, or data models were introduced: is `docs/ARCHITECTURE.md` updated? Specifically check for new Mermaid diagram nodes, updated project structure, new endpoint contracts, and updated tech stack table. Flag as blocking if architectural changes lack documentation. |
| **User Guide** | If user-facing features, config options, or CLI commands changed: is `docs/USER_GUIDE.md` updated? |
| **Migration** | If there are schema/API changes, is there a migration guide? |
| **Removed code** | If features were removed, is the documentation also removed? |

### Step 9: Publish Review

Publish one formal GitHub review carrying the verdict, the summary body, and every
inline comment — in a **single** API call.

> **You almost certainly have no MCP tools.** Five of seven agents declare a `tools:`
> allowlist naming no MCP pattern, which strips every MCP tool from them (#1146). The
> `gh` form below is the primary path, not a fallback. The main session, which does
> hold them, may instead use `mcp__github__create_pull_request_review`. <!-- mcp: main-session only -->

#### The working form — one JSON payload via `--input`

```bash
# 1. Write the review body to a FILE. Do NOT use BODY=$(cat <<'EOF' ... EOF):
#    command substitution re-scans the heredoc, so any backtick in the body — and a
#    review body is mostly backticked identifiers — is executed as a command.
cat > /tmp/review-body.md <<'EOF'
### Verdict: REQUEST_CHANGES

## Code Review Summary — PR #123
...
EOF

# 2. Get the line ranges the diff actually touches. Every comment's `line` MUST fall
#    inside one of these, and one that does not rejects the WHOLE payload (see below),
#    so derive them — do not guess from the file you just read. Each `@@` header ends
#    with the RIGHT-side range as +start,count.
git diff main...HEAD -U0 -- <paths> | grep -E '^(\+\+\+|@@)'

# 3. Write the inline comments as JSON. `line` must be inside a range from step 2,
#    and `side` is RIGHT for added/changed lines, LEFT for deleted ones.
cat > /tmp/review-comments.json <<'EOF'
[
  { "path": "server/src/routes/hooks.ts", "line": 42, "side": "RIGHT",
    "body": "**High** — `projectId` is not in the `where` clause, so this IDORs." }
]
EOF

# 4. Assemble ONE payload. EVERY field goes inside it.
python3 - <<'PY'
import json, pathlib
payload = {
    "event": "REQUEST_CHANGES",
    "body": pathlib.Path("/tmp/review-body.md").read_text(),
    "comments": json.loads(pathlib.Path("/tmp/review-comments.json").read_text()),
}
pathlib.Path("/tmp/review.json").write_text(json.dumps(payload))
PY

# 5. Publish.
gh api --method POST repos/{owner}/{repo}/pulls/{PR_NUMBER}/reviews --input /tmp/review.json
```

#### Two failures that cost real turns, repeatedly

1. **`--input` silently demotes `-f` / `-F` to query-string parameters.** Writing
   `gh api ... --input comments.json -f event=COMMENT -f body="$(cat body.md)"` looks
   like it works and returns **`HTTP 414 Request-URL too long`**, because the whole
   review body was appended to the URL. There is no warning. Put `event`, `body` and
   `comments` in the single JSON document, as above — never alongside it.

2. **`"event": "APPROVE"` returns `422 Can not approve your own pull request`**
   whenever the token authored the PR, which is the default in this repo's
   single-account setup. GitHub offers no override. The fallback:

   ```bash
   # Same payload, one field changed.
   "event": "COMMENT"
   ```
   …and **state the real verdict in the first line of the body** (`### Verdict:
   APPROVE`), so the decision is not lost to the API's constraint. Inline comments
   still attach normally on a `COMMENT` review. Say in the body that `APPROVE` was
   downgraded and why, so a reader does not mistake it for indecision.

Two smaller ones worth knowing:

- A comment whose `line` is **outside the diff** rejects the *entire* payload with
  `422`, losing every other comment with it — which is why step 2 derives the ranges
  rather than trusting the line numbers you read the file at. If a finding is in an
  untouched line, move it into the body rather than dropping the whole review.
- `gh pr review {PR_NUMBER} --request-changes --body-file /tmp/review-body.md` is the
  one-liner for a **body-only** review with no inline comments. It cannot carry them,
  so it is not a substitute for the form above — and use `--body-file`, never
  `--body "$(...)"`, for the same backtick reason as step 1.

**Review verdict logic:**
- **APPROVE** — No critical/high issues, minor nits only
- **COMMENT** — Informational findings, suggestions, no blockers
- **REQUEST_CHANGES** — Any critical, high, or medium security issue; missing requirements; broken tests

**Review body structure:**
```markdown
## Code Review Summary — PR #{PR_NUMBER}

### Requirements: {PASS|PARTIAL|FAIL}
- [x] Acceptance criteria 1
- [ ] Missing: acceptance criteria 2

### Security: {CLEAN|FINDINGS}
| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | — |
| High | 1 | XSS in UserInput.tsx:42 |

### Code Quality: {GOOD|NEEDS WORK}
- Naming: Good
- Complexity: 2 functions flagged
- Style: Consistent

### Performance: {CLEAN|FINDINGS}
- No issues found

### Tests: {SUFFICIENT|GAPS}
- Coverage: 85% (+3%)
- Missing: edge case for empty input

### Documentation: {UP TO DATE|NEEDS UPDATE}
- Changelog fragment: ✅ `.changes/unreleased/1191-changelog-fragments.md` (section: Added)
- docs/ARCHITECTURE.md: ⚠️ New `/api/widgets` endpoint not documented
- README: No changes needed

### Security Scanners: {CLEAN|FINDINGS|N/A}
| Scanner | Finding | File | Severity | Status |
|---------|---------|------|----------|--------|
| CodeQL | Missing rate limiting | src/api/m365.ts:151 | High | Still present |
| CodeQL | Path traversal | src/api/m365.ts:122 | Critical | Fixed |

### CI Status: {ALL GREEN|FAILURES}
| Job | Status | Introduced by PR? | Blocking? |
|-----|--------|--------------------|-----------|
| api | ❌ FAILED — type error in service.ts:12 | No — pre-existing | Yes |
| ui | ✅ Passed | — | — |


### Prior Review Comments: {N total, M unresolved}
| Reviewer | Type | Unresolved | Addressed | Disagreed |
|----------|------|------------|-----------|-----------|
| mgcronin | Human | 2 | 3 | 0 |
| copilot | Copilot | 0 | 1 | 1 (false positive) |

### Verdict: REQUEST_CHANGES
```

**Verdict escalation rules:**
- Any **failing CI job** (regardless of whether this PR introduced it) → `REQUEST_CHANGES` (blocking). Pre-existing failures must be fixed as a prerequisite to merge.
- Any `Still present` CodeQL **Critical** or **High** → `REQUEST_CHANGES` (blocking)
- Any `Still present` CodeQL **Medium** → `COMMENT` (non-blocking, but noted)
- All scanner findings `Fixed` or `False positive` → no impact on verdict
- Any **unresolved blocking comment from a human reviewer** → `REQUEST_CHANGES`
- Any unresolved Copilot suggestion → does NOT block on its own (validate first, may be false positive)
- If the only issues are resolved scanner findings and addressed reviewer comments → eligible for `APPROVE`

### Step 10: Handoff (Optional)

After publishing the review, offer the user:

> **Review published. Would you like me to switch to the Code Issue agent to fix the flagged issues?**

If yes, invoke the `resolve-pr-comments` skill with the same PR number to address the review comments just created.

## Review Comment Style Guide

Follow [Google's guidance on review comments](https://google.github.io/eng-practices/review/reviewer/comments.html):

- **Be kind.** Critique the code, not the person.
- **Explain why.** Don't just say "this is wrong" — explain what's better and why.
- **Prefix nits.** Use `nit:` for stylistic suggestions that aren't blockers.
- **Give credit.** If something is done well, say so. Good practices deserve recognition.
- **Be specific.** Reference the exact line and suggest a concrete alternative.
- **Prioritize.** Security > correctness > performance > style.

## Error Recovery

| Scenario | Action |
|----------|--------|
| `gh pr diff` fails | Fetch the patch: `gh api repos/{owner}/{repo}/pulls/{PR_NUMBER} -H 'Accept: application/vnd.github.diff'` |
| No linked issue found | Review without requirements validation, note the gap |
| `HTTP 414` publishing the review | `-f`/`-F` was used alongside `--input` — fold every field into the one JSON payload (Step 9) |
| `422 Can not approve your own pull request` | Switch `event` to `COMMENT` and put `### Verdict: APPROVE` on the body's first line (Step 9) |
| `422` naming a line not in the diff | Drop that inline comment into the review body and re-post; the whole payload was rejected |
| Too many files to review | Focus on non-generated, non-config files first |
| Cannot determine test coverage | Run tests locally, parse output |
| Docs folder empty | Skip documentation cross-reference, note in review |

## Example Invocations

```
@Code Review review PR #47
```

```
Review PR #23 against the requirements in epic #12
```

```
Do a security-focused review of PR #55
```

```
Check if PR #31 is ready to merge
```

## Shell Execution Rules

Follow the repo-wide shell hygiene defined in `.github/copilot-instructions.md` /
`CLAUDE.md`: batch commands with `&&`, never use watch mode, never background with `&`/`nohup`,
no interactive REPLs. `pnpm test` runs `vitest run` (exits cleanly). Quality gate as one call:

```bash
pnpm lint && pnpm typecheck && pnpm test && cd ui && npx next build
```

When you need a command's output to make a decision, prefer the `execution_subagent` tool
over `execute` where available — it is non-interactive and always exits.

## Prerequisites

- GitHub CLI (`gh`), authenticated with access to read PRs and create reviews — this
  is the primary interface, not a fallback
- `python3` on `PATH` (assembling the review payload in Step 9)
- Project test runner configured (to verify coverage claims)

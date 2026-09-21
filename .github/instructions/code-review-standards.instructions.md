---
applyTo: '**'
description: 'Concise code review standards applied automatically to all reviews. Covers security gates, CI deference, coverage thresholds, and review etiquette.'
---

# Code Review Standards

## Security gate

- Trust CI first: `Dependency audit` (pnpm audit) and `Semgrep` run on every PR. Read their output via `gh pr checks` before scanning manually.
- Manually review *changed code* for OWASP Top 10 (injection, broken auth, path traversal, SSRF, XSS). Flag Critical/High as **blocking**; Moderate as **warning**.
- Never approve with an unresolved High/Critical finding, whether from CI scanners or manual review.

## CI deference

- Run `gh pr checks <PR>` first. All failing jobs are blocking — including pre-existing failures not introduced by the PR.
- Dependency CVE check: read the `Dependency audit` CI job result. Do not re-run `pnpm audit` or `osv-scanner` manually.
- CodeQL: check `.github/workflows/codeql.yml` for `pull_request` trigger. If present, wait for and respect CodeQL results. If absent, perform manual OWASP review of changed code.

## Quality thresholds

- Unit test coverage ≥ 80% (statements, branches, functions, lines). Verify `pnpm test:coverage` output.
- No `TODO`/`FIXME` left in new code without a linked issue.
- No hardcoded secrets, API keys, or credentials.
- Error handling at system boundaries (route handlers, external calls, user input).

## Review etiquette

- Critique code, not people. Explain *why*, not just *what*.
- Prefix non-blocking items with `nit:`.
- Prioritize: **Security → Correctness → Performance → Style**.
- Acknowledge things done well — one-sided reviews erode trust.
- Read all existing unresolved reviewer threads before finalizing verdict. Either agree (add to findings) or explicitly disagree (reply with reasoning).

## Verdict

Always end with one of: **APPROVE**, **COMMENT** (informational), or **REQUEST_CHANGES** with a clear list of blocking items or "None".

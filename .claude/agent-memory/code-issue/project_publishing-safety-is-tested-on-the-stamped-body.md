---
name: publishing-safety-is-tested-on-the-stamped-body
description: In the publishing code, "untrusted text is safe inside a code span" must be tested on the STAMPED body, not the rendered draft; and the publisher test's Prisma double must honour issueDraft where.status.
metadata:
  type: project
---

In the publishing code, "untrusted text is safe inside a code span" must be tested on the STAMPED body, not the rendered draft — marker stripping that acts anywhere in the body splits a span at publish; and `publishing-publisher.test.ts`'s Prisma double must honour `issueDraft` `where.status`.

**Why:** PR #1102 rendered file paths and symbol names from an ingested repository inside code spans and tested the rendered row. The publisher then ran `stripMarker` over the whole body, replacing any `metis-publish` / `metis-source` comment with a newline — including one inside a span. A path shaped like `a<!-- metis-source: x -->## heading [l](https://evil) @user` published a live heading, link and mention the approved preview never showed, and the stripped body stopped hashing back to its draft. Separately, the test double's `issueDraft.findMany` ignored `where.status`, so it selected `published` drafts the real query never does, and a PR-body claim about re-publishing was wrong.

**How to apply:**

- Assert on what is sent to the tracker: `injectMarker(draft, …)` (or the captured POST/PATCH body), never only on the renderer's output. The invariant is `published === draft + marker block`, `hash(stripMarker(published)) === hash(draft)`, strip idempotent — as a property over hostile input (`server/tests/publishing-marker-position-1064.test.ts`).
- Assert Markdown that METIS emits through a real parser (micromark + micromark-extension-gfm are in the lockfile), not a hand-written span check — block-level constructs such as link reference definitions (`[label]: dest`, whose label ignores backticks) are invisible to inline reasoning; the generator must include bare `]` and `]:`. The helper is `server/tests/helpers/markdown-structure.ts`.
- A guard's error message must name a remedy that actually clears it — test the remedy. (`CODE_LINKS_TARGET_MISMATCH` told the user to regenerate; generation compared owner and name only, so for a same-named repository on another host regenerating wrote the same links and was refused again.)
- A marker counts only in the body's final run of marker-only lines (`server/src/lib/publishing/dedup.ts`). Never add a strip, replace or parse that acts on marker-shaped text elsewhere; make it inert where the body is written (`neutraliseMarkerText`). The one exception is `stripOwnMarkerLines` on the drift path: whole lines only, and only lines matching what the `PublishedIssue` row recorded.
- Any new writer of `IssueDraft.body` must pass the text through `neutraliseMarkerText` (today: the generator's `finishBody`, `editDraft`, drift Adopt).
- When a publisher test needs a draft to be selected, set its status; do not loosen the double.
- A property test's hostile generator must include the literal strings the implementation searches for or branches on — twice here it omitted exactly that input (a link-reference-definition shape; the repository's own blob-URL prefix).
- Never "clean" a user-editable Markdown body with a whole-body scan; replace only the section METIS wrote, byte for byte, and leave the rest alone. (The generator records both renderings in `metadata.codeLinkSection`; `bodyWithCodeAsText` swaps them.)
- Semgrep's `detect-non-literal-regexp` is blocking in CI and not installed locally — use string search in `server/src`.

**From #1298 and its review (2026-10-20).**
- The `unverified` requirement label is written by the synthesis model (prompt rule 4), not by code, so the publish-boundary filter `isInternalPublishLabel` is the only guard. Any new label the model is told to emit needs the same check.
- A publish body hash that includes text added at publish time from batch composition (parent link, notes) makes the issue body depend on which drafts share the batch. Check any new publish-time body transform for PATCH churn across differently-shaped batches.
- Publishing test prisma mocks read only `where.draftId` (`publishedIssue.count` in `publishing-draft-generator.test.ts`), so the status/issueNumber conditions deciding "ever published" can be weakened unnoticed. Make a mock evaluate its `where` before trusting tests on it.

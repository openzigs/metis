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
- A marker counts only in the body's final run of marker-only lines (`server/src/lib/publishing/dedup.ts`). Never add a strip, replace or parse that acts on marker-shaped text elsewhere; make it inert where the body is written (`neutraliseMarkerText`).
- Any new writer of `IssueDraft.body` must pass the text through `neutraliseMarkerText` (today: the generator's `finishBody`, `editDraft`, drift Adopt).
- When a publisher test needs a draft to be selected, set its status; do not loosen the double.

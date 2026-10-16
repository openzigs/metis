---
name: cut-off-doc-lazy-render
description: A generated document that looks truncated in a walkthrough screenshot or an innerText read can be the MarkdownPreviewer's progressive rendering, not lost content. Check the stored body and scroll first.
metadata:
  type: project
---

A generated document that "stops" partway in a walkthrough screenshot or an `innerText` / text-snapshot read can be whole. The page just has not drawn the later sections yet.

**Why:** #1170 (walkthrough run 9, J1.7) reported a requirements BRD that "stops right after R2's start marker, R3 to R5 missing". The implementer and the PR #1179 reviewer each reached the same conclusion independently: no content was lost.
- The stored body (`generated_documents.content`, and the version body) held all five requirements.
- jsdom rendered all of them.
- Headless Chrome against the live stack: on load, the content's `innerText` ended exactly at R2's marker, and all 13 sections appeared after scrolling.

The cause is `ui/src/components/markdown-previewer.tsx`:
- It splits the document at H2/H3 and renders only `INITIAL_RENDERED_SECTIONS = 3` up front.
- Every other section is a `PendingSection` holding raw Markdown with `content-visibility: auto`. It renders when an IntersectionObserver (1500px margin) reaches it.
- Skipped content is not in `innerText`, and an early screenshot shows a blank area.
- Body headings that are H2 or H3 (here `## Clarifications`) add more sections, so the cut-off point lands earlier.

**How to apply:**
- Before treating a cut-off document as data loss or a parser bug (for example "an unclosed HTML comment swallows the rest"), read the stored body: `sqlite3 -readonly server/dev.db "select content from generated_documents where id='…'"`, or the version row.
- Then scroll to the end in a real browser and count `[data-section-rendered]` against `[data-section-pending]` in `[data-testid=markdown-content]`.
- To reproduce in a unit test, drive the `IntersectionObserver` as `ui/tests/markdown-previewer-progressive.test.tsx` does. `ui/tests/markdown-previewer-requirements-brd.test.tsx` pins the BRD case.
- Real defects found alongside it in #1170: the markers had been escaped into visible text by `neutralizeHtml`, and body H2s were splitting each requirement into extra sections.

---
name: project_react-markdown-skiphtml-needs-textcontent-assert
description: on react-markdown without rehype-raw, "no <img>/<script> element" passes with skipHtml removed; assert on textContent
metadata:
  type: project
---

On react-markdown without rehype-raw, a test asserting "no `<img>`/`<script>` element" passes with `skipHtml` removed and even against a plain-text renderer; assert on `textContent` to pin `skipHtml`.

**Why:** without `rehype-raw`, react-markdown never turns raw HTML into elements. With `skipHtml` it drops the raw node; without it, it prints the tag source as TEXT. So `container.querySelector("img")` is null either way, and the test cannot tell the two apart (PR #1086 review: 45 UI tests still passed with `skipHtml` deleted).

**How to apply:** assert on the rendered text: `expect(textContent).not.toContain("<")`, `.not.toContain("onerror")`, and an exact match on the surviving prose. Note an INLINE `<script>alert(2)</script>` is three nodes (two html, one text), so `alert(2)` survives as harmless text even with `skipHtml`; use a block-level tag or an attribute payload for the "nothing left" assertion. Then delete `skipHtml` and confirm the test fails.

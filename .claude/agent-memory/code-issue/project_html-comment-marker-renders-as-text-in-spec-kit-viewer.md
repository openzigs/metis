---
name: project_html-comment-marker-renders-as-text-in-spec-kit-viewer
description: react-markdown without rehype-raw/skipHtml prints an HTML comment as literal text; filter server markers in displayArtifactText
metadata:
  type: project
---

react-markdown (`ui/package.json`: `^10.1.0`, no `rehype-raw`, no `skipHtml` on the Spec Kit viewer) renders an HTML comment such as `<!-- metis:plan-source v2 -->` as **literal text** in the METIS UI. Any server-side `<!-- marker -->` written into a Spec Kit artifact must be filtered in `ui/src/lib/spec-kit-display.ts` `displayArtifactText` (#787, #1134).

**Why:** "it's a comment, so it won't show" is the intuition from a browser; react-markdown without `rehype-raw` never parses raw HTML, and without `skipHtml` it keeps the node as text. #787 hit this with the generated-checks marker, #1134 again with the plan-source stamp.

**How to apply:** when a server change adds a marker line to an artifact, add its prefix to `displayArtifactText`'s filter in the same PR, and test that the rendered artifact's `textContent` does not contain `<!--`.

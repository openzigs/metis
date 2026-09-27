---
issue: 310
section: Changed
---

- Dependencies: landed the Dependabot minor/patch npm group (71 updates) and the GitHub Actions group (7 updates). The dependency audit drops from 27 advisories to 13, none High or Critical. Code-graph parsing now runs on `web-tree-sitter` 0.27 with unchanged output.
- `@anthropic-ai/sdk` 0.127.0 no longer caps non-streaming output at 8,192 tokens for `claude-opus-4-0`, `claude-opus-4-20250514` or `claude-opus-4-1-20250805`. Those ids now get the general 21,333 bound; the Vertex-style `@` ids keep 8,192.

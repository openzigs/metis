---
issue: 270
section: Changed
---

- Every page starts with the same header (one title style, description,
  actions); loading pages show its shape, and empty lists share one look.
- The breadcrumb goes down to the page (Workspace › Project › Section › Page),
  and only the last crumb is announced as the current page.
- Diagrams, the schema graph, the diff viewer and the maths stylesheet load
  only when shown: chat and workbench ship ~140 kB less compressed JavaScript.
- The last hard-coded colours follow the Light and Dark themes, and `next dev`
  no longer prints the Next 16 middleware deprecation notice.

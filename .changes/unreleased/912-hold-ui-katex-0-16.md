---
issue: 912
section: Changed
---

- Dependabot no longer proposes `katex` minor bumps. The UI's KaTeX stylesheet
  must match the katex 0.16 that `rehype-katex` renders with, and 0.18 renamed
  the CSS classes, so the UI stays on `~0.16`. Server katex patch bumps still
  arrive.

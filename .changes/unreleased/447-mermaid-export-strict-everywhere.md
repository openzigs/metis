---
issue: 447
section: Security
---

- Word (DOCX) export now renders Mermaid diagrams with HTML labels disabled,
  matching PDF export. Before, only the PDF path turned them off. The HTML
  fallback, used when Chrome is unavailable, now names the strict Mermaid
  security level instead of relying on the library default. All three export
  paths now build their Mermaid settings in one place.

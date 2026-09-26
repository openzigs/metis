---
issue: 196
section: Fixed
---

- The Provenance panel on a document version loads a small summary instead of
  the full manifest (17 MB on a large document). **Download full manifest**
  fetches the whole manifest only when you ask for it.
- The document list and the document view no longer re-read large version
  manifests on every request, and paging through a version's changed symbols no
  longer re-parses the whole stored list for each page.
- Table-of-contents entries and links to headings that contain formatting or
  entities, such as `_emphasis_` or `&amp;`, now go to the right heading.

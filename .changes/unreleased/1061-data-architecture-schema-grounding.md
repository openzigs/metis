---
issue: 1061
section: Fixed
---

- An architecture document's Data Architecture section no longer invents tables and columns. It is its own section, written from the project's database schema (each database's default schema read live, else the database document's schema graph, else the repository's SQL), with the diagram and column tables rendered from the schema.
- What the model writes is then compared with that schema, and a name that could not be matched is marked *(not in schema)*. Nothing is removed, rewritten or corrected: a read can be incomplete (one schema, column-level privileges, Oracle's 10,000-row introspection limit), so the check cannot prove a name is absent. One note per section lists what was marked and what was not checked.
- A mark is never written into code (a fenced or indented block, raw HTML, a code span), a table known by name only has none of its columns marked, and a SAS dataset written as an entity is listed as not checked instead of marked.
- Unmatched names do not change the document's status: it stays ready and its page shows one informational line, which says what the names were compared with (the database, a stored schema and its date, or the repository's SQL). A database that could not be read is reported as unread, not as absent.
- The first regeneration of each existing architecture document after this release rewrites all of its sections once, because the section split changes how they are identified.
- Column names, types and defaults are escaped in the rendered column tables of the architecture and database documents, so a pipe, a line break, a dollar sign or a bare URL in a default can no longer add a row, render as math or become a link.

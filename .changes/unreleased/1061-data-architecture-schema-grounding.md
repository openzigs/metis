---
issue: 1061
section: Fixed
---

- An architecture document's Data Architecture section no longer invents tables and columns. It is its own section, written from the project's database schema (each database's default schema read live, else the database document's schema graph, else the repository's SQL), with the diagram and column tables rendered from the schema.
- What the model writes is then checked against that schema. A table that is not in it is marked; a name in a schema that was not read is left alone. A column its table does not have is removed only when the read proves it (one table of that name, read live, no database unread) and marked otherwise.
- Findings that were repaired do not degrade the document; names left unmatched raise a `schema-unverified` warning that clears when a later run leaves none.
- Column names, types and defaults are escaped in the rendered column tables of the architecture and database documents, so a pipe or line break in a default can no longer add a row.

---
issue: 1061
section: Fixed
---

- An architecture document's Data Architecture section no longer invents tables and columns. It is its own section, written from the project's database schema (read live, else from the database document's schema graph, else from the repository's SQL), with the diagram and column tables rendered from the schema.
- What the model writes is then checked against that schema: a table that is not one is marked, a column its table does not have is removed (marked when the schema was not read live), a contradicted type shows the schema's, and an underscore-only misspelling is corrected. With no schema source the section says so and nothing is removed.

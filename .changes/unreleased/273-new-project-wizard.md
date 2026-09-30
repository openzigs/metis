---
issue: 273
section: Added
---

- A New project wizard on Home: when there are no projects yet, the Projects
  card offers "New project", a single dialog that takes a name, a GitHub
  repository (or "add a source later") and then creates the project, connects
  the repository and starts its Deep Ingest. It lands on the new project's
  Overview with the Ingest stage already reading "Ingesting…". If the
  repository cannot be linked or the ingest cannot start, it says so and still
  opens the project.
- The Overview now shows a Deep Ingest that was started before the page opened
  (for example from the wizard) as running, and clears it when it ends.

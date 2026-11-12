---
issue: 2337
section: Changed
---

- Plainer words on screen: "chunks" is now "sections indexed", the repository **Sync** button is
  **Update**, **Deep Ingest** is **Full re-read**, **Slug** is **Short name**, "Secret ref (vault)"
  is **Access token** or **Password (vault secret)**, and the Issue Sync page is **Issue updates**.
  The Tasks, Scheduler, Projects and Documents pages no longer mention Socket.IO, cron, migration
  projects or a RAG namespace.
- The Help button opens an in-app Help page (getting started, a project's tabs, the words METIS
  uses, who to ask) instead of GitHub. **Profile** in the account menu is a working link. A PR-review
  run links to its review page. `/settings/audit` now redirects to Configuration's Audit log tab.
- Project settings are grouped as **General**, **AI & cost** and **Advanced**; Advanced starts
  closed. No setting was removed.
- The vault picker says to ask an admin when the vault is empty or your role cannot list it. It also
  says you can attach only secrets you created. A refused repository or database connector keeps the
  server's reason in its error toast.
- Empty lists on the Documents, Connections, Import, Compare-analyses and project memory panels use
  the shared empty state, which says what belongs there and what to do next.

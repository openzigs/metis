---
issue: 2343
section: Added
---

- When a change request, a generated document or an uploaded document you started finishes,
  fails or is held in quarantine for review, you get a toast and a bell item that name it and
  land on the result, wherever you are in the app and in a tab opened later. A failure says so
  in plain words and lands where it can be run again. One job gives one toast and one bell item,
  also after a reconnect or with two tabs open. A new **Analysis, ingest and document results**
  switch in Settings → Notifications turns them off (on by default).
- A change request with open clarifying questions reads **Questions waiting (N)** on its step
  header, in the change-request list and on the project Overview.
- A change request shows its formal review as a state: **Review assigned to you** for its
  reviewer, **Your review request was rejected** for the analyst who asked, and otherwise where
  the review stands, each linking to the review. The matching bell items now read the same.
- A generated document can be linked to directly (`?doc=<id>` on the Documentation page).

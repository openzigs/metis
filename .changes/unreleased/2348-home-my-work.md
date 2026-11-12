---
issue: 2348
section: Added
---

- Home opens with **My work**: the change requests you started that need something, grouped as "Waiting on your answers", "In review", "Rejected" and "Ready to hand off", and the reviews waiting on your decision. Each row shows the title, the project and how long it has been in that state.
- Each row opens where the work is: the run's Questions tab, the review, or Publish for that run. An empty group is left out; with nothing at all, Home offers "New change request", or "New project" when you have no project yet.
- Only work in projects you can open is listed, filtered on the server, and Home asks for it in one request (`GET /api/me/work`, which takes no user id: the user comes from the session).
- Tasks, Active runs, Scheduled jobs and the Projects widget now appear on Home for admins only, below My work. Everyone else sees My work and Recent activity.

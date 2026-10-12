---
name: lock-key-as-wide-as-the-resource
description: How to choose a lock key for "one writer per X", and how the same over-width shows up in a UI as a disabled control. From #1059 (PR #1105), where two panel lenses and the review each found the key too wide.
metadata:
  type: project
---

A lock key should be exactly as wide as the resource it protects: a "create new X" job has no shared artifact with other creates.

**Why:** #1059 keyed every Spec Kit job without a `featureSlug` on `<projectId>:`. That key was meant for the project-level `.specify/` files, but `/speckit.specify` without a slug writes none of them: it creates a new feature. Two members creating two features were serialised for minutes (the second got 409), and a long project-level `/plan` blocked "new feature" for the whole project. Before the lock both ran, and `createFeature` already handled the real conflict by retrying the next number.

**How to apply:**

- **List what each command writes before choosing its key.** Commands that share a key must share a written artifact. "No slug in the request" is a property of the request, not of what is written.
- **For a create, reserve first.** Create the row (the store's unique index resolves two creators) and lock the job under the new row's own key. Then nobody else can start on the thing being created, and creators never meet. Check that a cancelled create already left an empty row before the change, so reserving early is not a new behaviour.
- **Refuse before you reserve.** Anything that can be rejected without the resource (an empty brief) must be rejected before the row is created.
- **The UI has the same bug in another form.** One `mutation.isPending` disabling the command box and Run for every feature is a project-wide lock drawn in the page. Derive "busy" from the server's list of live jobs, per scope the typed command would lock, and include other members' jobs: a user should not learn from a 409.
- **A result should move the page only where it was asked for.** Record where the tab was when it started a command; apply selection, input clearing and saved state only if the page is still there and the result is recent. Otherwise show a line with a button.
- **Say in the docs what the lock does not cover.** Here: manual edits and the non-job commands take no lock.

**Added after the cycle-2 review (same PR), where "reserve first" itself regressed two things:**

- **Keep the old failure order.** When a route starts creating a resource before starting its job, list which failures used to occur BEFORE that creation (here `await resolveProvider()` was evaluated first) and keep them first. Reserving early put the feature in front of provider resolution, so an unconfigured provider left one empty feature per attempt. For failures after the reservation that save nothing, remove what the job itself reserved, by id, only while it is still empty.
- **A changed identity breaks every lookup by the old one.** When a job's identity changes (a reserved slug), update every lookup that found the job by its old identity. The page's lost-response recovery still matched `featureSlug === null`. A lost-response recovery should match on a client idempotency token, not on inferred fields. Here the job id is a digest of project, user and token, so the primary key refuses the duplicate and no column was added.
- **`req.ip` is client-controlled here.** In this repo `req.ip` under the default `trust proxy = 1` is client-controlled when the Next UI server is the edge (Next sets `x-forwarded-for` with `??=`; the UI proxy forwards headers verbatim). Key authenticated endpoints' limits on the user, after `requireAuth`.

---
issue: 1581
section: Fixed
---

- A review's and a baseline compare's "what changed" diff renders a requirement body as Markdown,
  as the pinned body beside it does, instead of printing raw `##`, `**Q:**` and the
  `<!-- metis:clarifications -->` markers.
- The reviewer decision that completes a review sends the requester one notification (Review
  approved or Review rejected, naming the reviewer), not that one and a second "Reviewer approved
  your review" beside it.
- A discussion @mention notification names the thread and quotes the message, as a requirement
  comment mention does.
- Requirement comments: Delete asks for confirmation first; editing a comment offers the @mention
  picker, and a mention added by the edit notifies that person (someone already mentioned is not
  notified again); the New comment box opens its suggestions above itself, inside the panel.
- Chat: choosing **New chat** while the last chat is still being restored keeps the new chat; the
  old one no longer replaces it a moment later. A resumed chat with long lines no longer pushes the
  header and Skills panel off the page.
- A publish dry run names an epic the run will create by its title instead of a made-up issue
  number (`→ epic #1000`).

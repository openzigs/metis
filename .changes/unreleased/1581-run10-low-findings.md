---
issue: 1581
section: Fixed
---

- Review and baseline-compare diffs render a requirement body as Markdown, without raw `##` or
  `metis:` markers. The decision that settles a review sends one notification, naming the reviewer.
- Discussion @mention notifications name the thread and quote the message. Deleting a requirement
  comment asks first; editing one offers the @mention picker and notifies anyone newly mentioned.
- Chat: **New chat** pressed while the last chat is still loading is no longer replaced by it, and a
  long transcript line no longer pushes the page sideways. A publish dry run names an epic the run
  creates by title, not by a made-up `#1000`.

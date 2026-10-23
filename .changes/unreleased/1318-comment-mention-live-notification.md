---
issue: 1318
section: Fixed
---

- A comment @mention that arrives live now says who mentioned you and on which
  requirement or Spec Kit artifact, quotes the start of the comment, and its
  **Open →** link opens that comment thread. It used to read "You were mentioned
  in comment <id>" and link to a page that does not exist. The live item and the
  saved one now read the same and are listed once.
- The quote follows the comment: editing it updates the quote, and deleting it
  replaces the quote with "The comment was deleted." Adds a nullable
  `notifications.commentId` column (migration in both schemas).

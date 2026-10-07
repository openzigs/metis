---
issue: 734
section: Fixed
---

- Requirement and Spec Kit artifact comments are open to everyone who can open the project, as
  discussions are: a mentioned workspace member no longer gets 403. Non-members get 404 and the
  denial is audited. The @mention picker offers only users who can open the project, and only
  they are notified.
- A comment @mention notification now names the author and the requirement or artifact, and
  opens its comments instead of the missing `/comments/<id>` page (#735).

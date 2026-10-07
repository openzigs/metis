---
issue: 720
section: Fixed
---

- Signing out from the account menu lands on the plain sign-in page. It used to
  land on `/login?reason=expired` and say "Your session expired — please sign
  in again", because the shell's expired-session redirect won the race against
  the sign-out's own navigation.

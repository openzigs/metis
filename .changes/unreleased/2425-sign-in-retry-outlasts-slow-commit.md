---
issue: 2425
section: Fixed
---

- On Postgres, a first sign-in made at the same moment as another person's no longer fails with
  "This sign-in collided with others made at the same moment" when the database is slow to finish
  writing the other sign-in. The automatic retry used to give up within about 100 ms, which one
  slow disk write could outlast. It now keeps trying for at least 300 ms. The same retry covers
  SCIM provisioning and administrator role reconciliation.

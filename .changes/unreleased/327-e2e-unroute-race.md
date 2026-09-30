---
issue: 327
section: Fixed
---

- Four e2e specs no longer remove their last network route mid-test with
  `unroute` / `unrouteAll`, which could leave a request the page started at
  that instant paused forever. Each route now stays registered and passes
  requests on once it is done, and the route-hygiene check fails the scripts
  suite if an `unroute` or `unrouteAll` call comes back.

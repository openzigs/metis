---
issue: 964
section: Changed
---

- CI now names every unit test that passed only after a vitest retry. The server
  and UI suites retry failed tests to absorb timing flakes, which also hid tests
  that fail deterministically on their first attempt (six of them for over a day,
  #963). Each such test gets a warning annotation and a job-summary row on pull
  requests, and fails the nightly run. Locally, the end of a test run lists them.

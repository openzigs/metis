---
issue: 2115
section: Fixed
---

- Cross-project impact now follows a product's API edges. When an impact run's change touches a
  provider's API, the provider's Cross-project impact block names each project that calls that
  API, the API files the change touches, and the methods that call it (for example
  `Client::update_entry` in a Python client of the Miniflux API). A change that touches none of
  the provider's API, such as a web-UI fix, lists no consumer. A consumer selected into the same
  run gets a Low-confidence match banner on those matches, instead of reading 93–100% with no
  warning.

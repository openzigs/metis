---
issue: 2114
section: Fixed
---

- A product's **Add repository** form offers only the roles the server accepts (Frontend, Backend
  API, Shared library, Microservice, Gateway, Docs), shown with readable labels. Before, it also
  offered shared-library, infrastructure, worker and other, and choosing any of them failed with
  "role is invalid".

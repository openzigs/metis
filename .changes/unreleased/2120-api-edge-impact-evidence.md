---
issue: 2120
section: Fixed
---

- An impact run no longer marks a consumer project's matches Low-confidence when it has no evidence
  for that. When METIS found no code in the provider for the change, or the API edge does not say
  which project calls which, no banner is shown. Before, the provider's own API change could be
  flagged as untouched through an edge read both ways.
- More API layouts are recognised: folders named `routes`, `router`, `controllers`, `handlers`,
  `resolvers` or `webhooks`, and folder names that contain an API word, such as `RestControllers`
  or `public_api`.
- If the API-edge part of an impact run cannot be loaded, the Cross-project impact block now says it
  is unavailable, instead of reporting that no other project is affected.

---
issue: 2127
section: Fixed
---

- An impact run no longer names a project that calls another project's API as affected when the
  change only touched a folder with a generic name. A `handler`, `router` or `routing` folder now
  counts as API only inside an `http` or `server` folder, a singular `route` folder and any `client`
  folder (such as `rest-client`) never count, and camel-case names such as `GraphQLSchema` are
  recognised. Before, a feed-refresh change in Miniflux's `internal/reader/handler/` listed
  python-client as affected.
- While the API-edge part of an impact run is still loading, the Cross-project impact block now
  says it is checking, instead of briefly reporting that no other project is affected.

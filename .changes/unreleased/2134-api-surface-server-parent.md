---
issue: 2134
section: Fixed
---

- An impact run no longer counts a job or queue handler somewhere under a `server` folder as API.
  A `handler`, `router` or `routing` folder now counts only when it sits directly inside an `http`,
  `https`, `server` or `servers` folder, so `server/src/jobs/handlers/` no longer lists the projects that call this
  one's API as affected. Folders such as `grpcclient` or `swaggerclient` are now read as clients
  and no longer count either.

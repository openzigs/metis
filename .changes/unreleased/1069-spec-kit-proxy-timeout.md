---
issue: 1069
section: Fixed
---

- A Spec Kit command that runs longer than five minutes no longer ends in "Internal Server Error".
  The UI proxy now waits up to 15 minutes for these commands (`METIS_SPEC_KIT_PROXY_TIMEOUT_MS`,
  5 to 60 minutes); other requests keep the default.
- If a command's response is still lost, the Spec Kit page checks for the artifact that command
  writes and opens it. If none appears within 3 minutes it says the command may still be running.
- The UI's API proxy answers 400 to a path segment holding an encoded `/`, `\`, `?` or `#`, or a
  dot segment, instead of forwarding it to another upstream route.

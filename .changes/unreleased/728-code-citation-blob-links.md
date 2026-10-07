---
issue: 728
section: Added
---

- Analysis: a code citation on a finding, gap report or requirement diff now
  links to the file on GitHub (or GitHub Enterprise) at the cited lines, opened
  in a new tab. It points at the commit the code was ingested from when known,
  otherwise the connector's branch or tag. Copy stays as a secondary action. The
  locator stays plain text for non-GitHub connectors, or when the project has
  more than one GitHub repository, since a citation does not say which one it
  came from.

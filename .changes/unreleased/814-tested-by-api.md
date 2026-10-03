---
issue: 814
section: Added
---

- The requirement traceability API now says which tests cover a requirement:
  each chain gains a `testedBy` list, resolved from the code the requirement
  is mapped to (a mapped test file, a test that calls the mapped code, or a
  test named for it), and each mapped file is marked `isTest`.
- New `GET /api/projects/:projectId/traceability/test-gaps` lists the
  requirements that have mapped code but no linked test. Requirements with no
  mapped code are counted separately rather than reported as untested.
- The traceability routes now check project access themselves instead of
  relying on another router mounted ahead of them.

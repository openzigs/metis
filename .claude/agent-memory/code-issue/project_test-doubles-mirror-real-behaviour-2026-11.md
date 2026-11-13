---
name: test-doubles-mirror-real-behaviour-2026-11
description: Test setup traps — the mock developer role lacks project.create, and a stubbed orchestrator must copy its forwarding behaviour.
metadata:
  type: project
---

From code-review on 2026-11-12/13.

- **Mock `developer` lacks `project.create`.** A test that creates a project must authenticate as `coordinator`, or it 403s for a reason unrelated to the code under test ([[permission-mock-hides-removed-gate]]).
- **A server test that stubs the orchestrator must copy what it forwards.** A stub that swallows its arguments or drops the forwarded fields passes while the real call would lose them. Copy the real forwarding behaviour into the stub, then assert on what reached it ([[whole-module-vi-mock-stubs-500-at-runtime]]).

---
name: vi-mock-const-misses-default-param
description: vi.mock of an exported constant does not reach a default parameter in the same module
metadata:
  type: project
---

PR #509's palette test mocked PALETTE_DESTINATIONS, but paletteDestinations' default parameter inside navigation.ts still pointed at the real constant, so dropping the explicit argument would have made the test vacuous.

**Why:** Module mocks replace imports seen by other modules, not bindings inside the mocked module.

**How to apply:** Pass the constant explicitly at the call site (with a comment), or inject through a seam.

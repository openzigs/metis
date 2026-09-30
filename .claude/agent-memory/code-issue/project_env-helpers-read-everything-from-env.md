---
name: env-helpers-read-everything-from-env
description: Helpers that take an env must read every setting from it
metadata:
  type: project
---

buildProvider({env}) and maybeWrapProviderForFixtures took mode flags from the passed env but AI_FIXTURE_DIR from process.env (#565); a test stubbing process.env hid it.

**Why:** Mixed sources make the e2e builder and the server disagree.

**How to apply:** Thread every setting through the passed env and test with conflicting process.env and env values.

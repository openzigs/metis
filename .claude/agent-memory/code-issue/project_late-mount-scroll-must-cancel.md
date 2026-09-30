---
name: late-mount-scroll-must-cancel
description: A hook that waits for a late-mounting element must also cancel when its target can never mount, or it fires later as a surprise.
metadata:
  type: project
---

PR #434 (#406) added `useScrollToAnchor`. It waits on a MutationObserver until `#approvals` mounts, then scrolls. Only arrival or unmount cancelled it. As a result, a `#approvals` link without `?tab=approvals` left the page on Summary with the observer armed, and the page jumped whenever the user later opened Approvals. A panel that renders `null` left it armed for the whole session.

**Why:** page tests stubbed the panel with `id="approvals"` already rendered, so the late-mount path and the never-mounts path were invisible to them.

**How to apply:** give every "wait until X appears" effect an explicit cancel for each way X can fail to appear, such as a tab switch, a null render or a different route. Test each cancel with a case where the target is absent when the effect arms. Links: [[socket-contract-guard-half-checks]].

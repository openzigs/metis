---
name: scrollable-tablist-clips-focus-ring
description: overflow-x-auto on a TabsList clips the trigger focus ring
metadata:
  type: project
---

PR #520 made the MCP settings tabs scroll for phones; overflow clipped the ui-kit TabsTrigger's ring-2 ring-offset-2 outline, weakening keyboard focus.

**Why:** Any overflow other than visible clips descendant box-shadows.

**How to apply:** When making a row scrollable, keep p-1 on the list or inset the ring (focus-visible:ring-inset ring-offset-0), and assert the classes.

---
issue: 630
section: Fixed
---

- Settings → MCP → Import / Export: choosing the same `mcp.json` again, after an
  import or after Clear, now shows its preview again. The file picker kept the
  last file selected, so picking it a second time did nothing until a
  different file had been chosen first.

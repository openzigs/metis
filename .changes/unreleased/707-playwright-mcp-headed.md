---
issue: 707
section: Fixed
---

- The `playwright-headed` MCP server, which never connected because current
  `@playwright/mcp` rejects `--headed`, is removed. The plain `playwright` server is
  headed by default and is the one `ui-vision` uses.

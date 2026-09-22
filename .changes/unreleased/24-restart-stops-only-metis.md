---
issue: 24
section: Fixed
---

- `scripts/restart.sh` now stops only processes METIS started: dev processes
  running from the same checkout, their child processes, and MCP sidecars
  tagged with that checkout's `METIS_SIDECAR_OWNER`. It used to send SIGTERM
  to every MCP server on the machine, which disconnected other tools. It
  also no longer stops a process from another project that happens to use
  port 3000 or 4000, or that runs `next dev`. `scripts/restart.ps1` no longer
  matches MCP servers by command line.

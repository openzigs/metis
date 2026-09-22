---
issue: 34
section: Fixed
---

- The `metis-server` image no longer ships the Copilot CLI binary, the Prisma CLI's
  dependency tree, tree-sitter C sources and native builds, compile-time SQLite
  sources, other platforms' prebuilt binaries, Oracle's JDBC jars, or npm/yarn —
  roughly 1.3 GB down to about 0.9 GB on amd64. Its size gate now holds it to its
  own measured budget, and CI image builds cache across runs.

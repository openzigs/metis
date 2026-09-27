---
issue: 2
section: Fixed
---

- `pnpm install` works on Windows without Visual Studio. pnpm ran a
  `node-gyp rebuild` in `better-sqlite3@13` that was never needed, because
  that version ships prebuilt binaries. Only the copy that downloads its
  binary (`better-sqlite3@12`, used by Prisma's adapter) is now allowed to run
  install scripts. The Windows CI job gates again.

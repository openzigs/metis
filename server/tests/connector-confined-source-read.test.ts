/**
 * Issue #217 — reading a repository source file without following a symlink
 * swapped in after the walk checked it (the TOCTOU window #209's review named).
 *
 * Real files and symlinks under os.tmpdir(). The Windows fallback (no
 * O_NOFOLLOW) is exercised on POSIX by forcing `noFollow: false`, which is
 * exactly the code path a platform without the flag takes.
 */
import { execFileSync } from "node:child_process";
import { constants as fsConstants, closeSync, openSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  O_NOFOLLOW_SUPPORTED,
  O_NONBLOCK_SUPPORTED,
  isWithinBoundary,
  readConfinedSourceFile,
  sourceOpenFlags,
} from "../src/lib/connectors/confined-source-read.js";

const SECRET = "export const secret = 'LEAKED-OUTSIDE-BOUNDARY';\n";
/** Symlinks, FIFOs and directory `open` behave differently on Windows (no FIFOs, EISDIR). */
const posixOnly = it.skipIf(process.platform === "win32");

/**
 * Unblock anything stuck opening `fifo` for read: a non-blocking writer open
 * succeeds only while a reader is waiting, and completes that reader's open.
 * Without this, a regression that blocks leaves a libuv thread hung forever.
 */
function releaseFifoReaders(fifo: string): void {
  try {
    closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
  } catch {
    // ENXIO: no reader waiting — nothing to release. ENOENT: already gone.
  }
}

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-217-root-")));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-217-out-")));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await fs.mkdir(path.join(outside, "src"));
  await fs.writeFile(path.join(outside, "secret.ts"), SECRET);
  await fs.writeFile(path.join(outside, "src", "a.ts"), SECRET);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

/** Replace `rel` under root with a symlink to `target`. */
async function swapForLink(rel: string, target: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.rm(abs, { recursive: true, force: true });
  await fs.symlink(target, abs);
}

describe("sourceOpenFlags", () => {
  it("adds O_NOFOLLOW where the platform defines it", () => {
    expect(sourceOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 0x100 })).toBe(0x100);
    expect(O_NOFOLLOW_SUPPORTED).toBe(typeof fsConstants.O_NOFOLLOW === "number");
  });

  it("adds O_NONBLOCK where the platform defines it, with or without O_NOFOLLOW", () => {
    expect(sourceOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x4 })).toBe(0x104);
    expect(sourceOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x4 }, false)).toBe(0x4);
    expect(O_NONBLOCK_SUPPORTED).toBe(typeof fsConstants.O_NONBLOCK === "number");
    if (process.platform !== "win32") {
      expect(sourceOpenFlags() & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    }
  });

  it("falls back to O_RDONLY alone where neither exists (Windows)", () => {
    expect(sourceOpenFlags({ O_RDONLY: 0 })).toBe(0);
    expect(sourceOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 0x100 }, false)).toBe(0);
  });
});

describe("isWithinBoundary", () => {
  it("uses a separator boundary, not a string prefix", () => {
    expect(isWithinBoundary("/srv/a", "/srv/a")).toBe(true);
    expect(isWithinBoundary("/srv/a", `/srv/a${path.sep}x.ts`)).toBe(true);
    expect(isWithinBoundary("/srv/a", "/srv/a-evil/x.ts")).toBe(false);
    expect(isWithinBoundary("/srv/a", "/srv/x.ts")).toBe(false);
  });
});

describe("readConfinedSourceFile", () => {
  it("reads a regular file inside the boundary", async () => {
    const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
      boundary: root,
      maxFileBytes: 1024,
    });
    expect(res).toEqual({ ok: true, content: "export const a = 1;\n", sizeBytes: 20 });
  });

  posixOnly(
    "refuses a file swapped for a symlink to outside — O_NOFOLLOW, no boundary",
    async () => {
      await swapForLink("src/a.ts", path.join(outside, "secret.ts"));
      const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
        maxFileBytes: 1024,
      });
      expect(res).toEqual({ ok: false, reason: "not-regular" });
    },
  );

  posixOnly(
    "with O_NOFOLLOW the symlink is refused at open, before anything is stat'ed",
    async () => {
      await swapForLink("src/a.ts", path.join(outside, "secret.ts"));
      const lstat = vi.spyOn(fs, "lstat");
      await readConfinedSourceFile(path.join(root, "src", "a.ts"), { maxFileBytes: 1024 });
      expect(lstat).not.toHaveBeenCalled();
    },
  );

  it("refuses when the real path inside the boundary is not the file that was opened", async () => {
    // A parent swapped out and back between the open and the realpath: the
    // realpath lands inside the boundary but names a different file. Simulated
    // by resolving to another in-boundary file.
    await fs.writeFile(path.join(root, "src", "other.ts"), "other");
    vi.spyOn(fs, "realpath").mockResolvedValue(path.join(root, "src", "other.ts") as never);
    const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
      boundary: root,
      maxFileBytes: 1024,
    });
    expect(res).toEqual({ ok: false, reason: "escaped" });
  });

  posixOnly(
    "Windows fallback (no O_NOFOLLOW): a final-component symlink is still refused by the identity check",
    async () => {
      await swapForLink("src/a.ts", path.join(outside, "secret.ts"));
      const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
        maxFileBytes: 1024,
        noFollow: false,
      });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain("LEAKED");
    },
  );

  posixOnly(
    "Windows fallback: with a boundary, the realpath re-check refuses the escaped target",
    async () => {
      await swapForLink("src/a.ts", path.join(outside, "secret.ts"));
      const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
        boundary: root,
        maxFileBytes: 1024,
        noFollow: false,
      });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain("LEAKED");
    },
  );

  posixOnly(
    "refuses a file reached through a PARENT directory swapped for a symlink — O_NOFOLLOW alone cannot see this",
    async () => {
      // O_NOFOLLOW only guards the final path component: `src/` → outside/src
      // opens outside/src/a.ts as a perfectly regular file. Only the realpath
      // re-check against the boundary catches it.
      await swapForLink("src", path.join(outside, "src"));
      const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
        boundary: root,
        maxFileBytes: 1024,
      });
      expect(res).toEqual({ ok: false, reason: "escaped" });
    },
  );

  it("reports a file that grew past the ceiling since the walk as too-large, unread", async () => {
    await fs.writeFile(path.join(root, "src", "a.ts"), "x".repeat(2048));
    const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
      boundary: root,
      maxFileBytes: 1024,
    });
    expect(res).toEqual({ ok: false, reason: "too-large", sizeBytes: 2048 });
  });

  it("reads a file that grows after the size check only up to the ceiling, and reports it too-large", async () => {
    // The fstat size check passes (20 bytes); the file then grows past the
    // ceiling before the content read. The read must stop at the ceiling
    // rather than follow the file to EOF. `realpath` runs between the two.
    const file = path.join(root, "src", "a.ts");
    const realRealpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation((async (p: string) => {
      await fs.appendFile(file, "x".repeat(4096));
      return realRealpath(p);
    }) as never);
    const res = await readConfinedSourceFile(file, { boundary: root, maxFileBytes: 1024 });
    expect(res).toEqual({ ok: false, reason: "too-large", sizeBytes: 20 + 4096 });
  });

  it("reads a file of exactly the ceiling whole", async () => {
    const body = "y".repeat(1024);
    await fs.writeFile(path.join(root, "src", "a.ts"), body);
    const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
      maxFileBytes: 1024,
    });
    expect(res).toEqual({ ok: true, content: body, sizeBytes: 1024 });
  });

  it("reads a multi-byte UTF-8 file larger than one read chunk intact", async () => {
    const body = "é€😀".repeat(40_000); // ~360 KB, characters straddle chunk edges
    await fs.writeFile(path.join(root, "src", "a.ts"), body);
    const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
      maxFileBytes: 1024 * 1024,
    });
    expect(res).toEqual({ ok: true, content: body, sizeBytes: Buffer.byteLength(body) });
  });

  posixOnly("reports a directory where a file was as not-regular", async () => {
    // POSIX opens a directory O_RDONLY; only fstat can refuse it. (Windows
    // fails the open with EISDIR, which lands on `unreadable`.)
    await fs.rm(path.join(root, "src", "a.ts"));
    await fs.mkdir(path.join(root, "src", "a.ts"));
    const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
      maxFileBytes: 1024,
    });
    expect(res).toEqual({ ok: false, reason: "not-regular" });
  });

  posixOnly(
    "refuses a FIFO where a file was, without blocking on the open (O_NONBLOCK)",
    { timeout: 5000 },
    async () => {
      // Without O_NONBLOCK, open(O_RDONLY) on a FIFO waits for a writer that
      // never comes: the call never resolves and the timeout fails the test.
      const fifo = path.join(root, "src", "a.ts");
      await fs.rm(fifo);
      execFileSync("mkfifo", [fifo]);
      const pending = readConfinedSourceFile(fifo, { boundary: root, maxFileBytes: 1024 });
      // A blocked open never settles; bound the wait so a regression fails with
      // "hung" (then unblock the stuck thread) instead of leaking it.
      const outcome = await Promise.race([
        pending,
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000).unref()),
      ]);
      releaseFifoReaders(fifo);
      expect(outcome).toEqual({ ok: false, reason: "not-regular" });
    },
  );

  posixOnly(
    "the fstat check alone refuses a FIFO, even when the path-level lstat is fooled",
    { timeout: 5000 },
    async () => {
      // The lstat identity check would also see the FIFO; simulate it racing
      // (reporting a regular file with the handle's identity) so this pins the
      // handle-level fstat check on its own: the FIFO must never be read.
      const fifo = path.join(root, "src", "a.ts");
      await fs.rm(fifo);
      execFileSync("mkfifo", [fifo]);
      const { dev, ino } = await fs.stat(fifo, { bigint: true });
      vi.spyOn(fs, "lstat").mockResolvedValue({ dev, ino, isFile: () => true } as never);
      const probe = await fs.open(path.join(outside, "secret.ts"));
      const handleProto = Object.getPrototypeOf(probe) as { read: () => unknown };
      await probe.close();
      const read = vi.spyOn(handleProto, "read");
      const res = await readConfinedSourceFile(fifo, { maxFileBytes: 1024 });
      releaseFifoReaders(fifo);
      expect(res).toEqual({ ok: false, reason: "not-regular" });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("reports a vanished file as unreadable", async () => {
    const res = await readConfinedSourceFile(path.join(root, "src", "gone.ts"), {
      maxFileBytes: 1024,
    });
    expect(res).toEqual({ ok: false, reason: "unreadable" });
  });
});

/**
 * Issue #217 — reading a repository source file without following a symlink
 * swapped in after the walk checked it (the TOCTOU window #209's review named).
 *
 * Real files and symlinks under os.tmpdir(). The Windows fallback (no
 * O_NOFOLLOW) is exercised on POSIX by forcing `noFollow: false`, which is
 * exactly the code path a platform without the flag takes.
 */
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  O_NOFOLLOW_SUPPORTED,
  isWithinBoundary,
  readConfinedSourceFile,
  sourceOpenFlags,
} from "../src/lib/connectors/confined-source-read.js";

const SECRET = "export const secret = 'LEAKED-OUTSIDE-BOUNDARY';\n";
const posixOnly = it.skipIf(process.platform === "win32");

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

  it("falls back to O_RDONLY alone where it does not (Windows)", () => {
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

  it("reports a directory where a file was as not-regular", async () => {
    await fs.rm(path.join(root, "src", "a.ts"));
    await fs.mkdir(path.join(root, "src", "a.ts"));
    const res = await readConfinedSourceFile(path.join(root, "src", "a.ts"), {
      maxFileBytes: 1024,
    });
    expect(res.ok).toBe(false);
    expect(["not-regular", "unreadable"]).toContain((res as { reason: string }).reason);
  });

  it("reports a vanished file as unreadable", async () => {
    const res = await readConfinedSourceFile(path.join(root, "src", "gone.ts"), {
      maxFileBytes: 1024,
    });
    expect(res).toEqual({ ok: false, reason: "unreadable" });
  });
});

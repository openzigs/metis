/**
 * #1499 — the boot wiring of #1488's repository-permission re-check. The boot
 * block in `index.ts` does not run under test (`METIS_NO_LISTEN=1`), so the
 * listen callback is a named export, tested here, and the boot block is held
 * to calling it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const recheck = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../src/lib/connectors/repo/permission-recheck.js", () => ({
  startRepoPermissionRecheck: recheck.start,
}));

const { onServerListening } = await import("../src/index.js");

describe("#1499 — the boot re-check is started once the server listens", () => {
  it("onServerListening starts the re-check, in the background", () => {
    onServerListening(4000);
    expect(recheck.start).toHaveBeenCalledTimes(1);
    // Fire-and-forget: started with its defaults, nothing awaited.
    expect(recheck.start).toHaveBeenCalledWith();
  });

  it("the boot block's listen callback is onServerListening", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/httpServer\.listen\(PORT, \(\) => onServerListening\(PORT\)\)/);
    // The listen callback is the only caller: no second start elsewhere in boot.
    expect(source.match(/startRepoPermissionRecheck\(\)/g)).toHaveLength(1);
  });
});

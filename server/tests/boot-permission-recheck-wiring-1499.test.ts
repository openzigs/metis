/**
 * #1499 — the boot wiring of #1488's repository-permission re-check. The boot
 * block in `index.ts` does not run under test (`METIS_NO_LISTEN=1`); its one
 * `listen` call is `listenAndStart`, exercised here with a fake server.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const recheck = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../src/lib/connectors/repo/permission-recheck.js", () => ({
  startRepoPermissionRecheck: recheck.start,
}));

const { listenAndStart, onServerListening } = await import("../src/index.js");

/** A server that records its listen call and binds when told to. */
function fakeServer() {
  let onListening: (() => void) | null = null;
  const listen = vi.fn((_port: number, cb: () => void) => {
    onListening = cb;
  });
  return { listen, bind: () => onListening?.() };
}

describe("#1499 — the boot re-check is started once the server listens", () => {
  it("starts nothing before the server is bound, and the re-check once it is", () => {
    recheck.start.mockClear();
    const server = fakeServer();
    listenAndStart(server, 4321);
    expect(server.listen).toHaveBeenCalledWith(4321, expect.any(Function));
    expect(recheck.start).not.toHaveBeenCalled();
    server.bind();
    // Fire-and-forget, with its defaults.
    expect(recheck.start).toHaveBeenCalledTimes(1);
    expect(recheck.start).toHaveBeenCalledWith();
  });

  it("the boot block's listen call is listenAndStart (tripwire: the block itself never runs under test)", () => {
    // Deliberately coupled to the source: a reformat of this one line should
    // update the pattern, not delete the test. Without it, reverting the boot
    // block to a bare `httpServer.listen(PORT)` would silently drop the re-check.
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/^\s*listenAndStart\(httpServer, PORT\);$/m);
  });

  it("onServerListening starts the re-check each time it runs", () => {
    recheck.start.mockClear();
    onServerListening(4000);
    expect(recheck.start).toHaveBeenCalledTimes(1);
  });
});

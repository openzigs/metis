/**
 * #1562 — `make entra-up` / `make entra-down` (scripts/saml-harness/entra-*.sh),
 * run for real against a scratch state directory (ENTRA_STATE_DIR), so a
 * developer's own running mock is never touched.
 *
 * Both scripts trust the pid file only when that pid is still a node process
 * running entra-idp.mjs: a recycled pid neither blocks a start nor gets
 * signalled, even when its command line merely mentions entra-idp.mjs (#2204).
 * entra-down reports a mock that outlives SIGTERM instead of claiming it
 * stopped.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { READY_LINE } from "./entra-idp-harness.mjs";

const UP = fileURLToPath(new URL("../saml-harness/entra-up.sh", import.meta.url));
const DOWN = fileURLToPath(new URL("../saml-harness/entra-down.sh", import.meta.url));

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), "metis-entra-state-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A long-lived process; `ignoreTerm` makes it outlive SIGTERM.
 *
 * - `script`: node runs a file of that name, so "entra-idp.mjs" passes for the mock;
 * - `marker`: `node -e <code> <marker>`, which only mentions the name;
 * - `shellMarker`: a bash process with `marker` on its command line.
 * @param {{ script?: string, marker?: string, shellMarker?: string, ignoreTerm?: boolean }} opts
 */
async function longLived({ script, marker, shellMarker, ignoreTerm = false }) {
  const code = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000); console.log('up');`;
  /** @type {[string, string[]]} */
  let command;
  if (script) {
    const file = join(stateDir(), script);
    writeFileSync(file, code);
    command = [process.execPath, [file]];
  } else if (shellMarker) {
    // A loop, so bash does not exec its last command and drop the marker.
    command = ["bash", ["-c", "echo up; while :; do sleep 1; done", shellMarker]];
  } else {
    command = [process.execPath, ["-e", code, /** @type {string} */ (marker)]];
  }
  const child = spawn(command[0], command[1], { stdio: ["ignore", "pipe", "ignore"] });
  cleanups.push(() => {
    if (child.pid && alive(child.pid)) process.kill(child.pid, "SIGKILL");
  });
  // The SIGTERM handler is installed before 'up' prints.
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return /** @type {number} */ (child.pid);
}

/** @param {string} script @param {string} dir @param {string[]} [args] */
function run(script, dir, args = []) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ENTRA_STATE_DIR: dir },
    timeout: 40_000,
  });
}

describe("make entra-down (#1562)", () => {
  it("reports a mock that is still running after SIGTERM, and keeps its pid file", async () => {
    const dir = stateDir();
    const pid = await longLived({ script: "entra-idp.mjs", ignoreTerm: true });
    writeFileSync(join(dir, "idp.pid"), `${pid}\n`);

    const down = run(DOWN, dir);
    expect(down.status).toBe(1);
    expect(down.stderr).toContain(`FAIL the mock Entra IdP (pid ${pid}) is still running`);
    expect(down.stdout).not.toContain("OK stopped");
    expect(existsSync(join(dir, "idp.pid"))).toBe(true);
    expect(alive(pid)).toBe(true);
  }, 20_000);

  it.each([
    ["another program", { marker: "some-other-program.mjs" }],
    // #2204 — the command line only mentions the mock's file name.
    ["node -e naming entra-idp.mjs as an argument", { marker: "entra-idp.mjs" }],
    ["a shell naming entra-idp.mjs", { shellMarker: "entra-idp.mjs" }],
  ])("never signals a recycled pid (%s): it is left running", async (_label, opts) => {
    const dir = stateDir();
    const pid = await longLived(opts);
    writeFileSync(join(dir, "idp.pid"), `${pid}\n`);

    const down = run(DOWN, dir);
    expect(down.status).toBe(0);
    expect(down.stdout).toContain("stale pid file");
    expect(existsSync(join(dir, "idp.pid"))).toBe(false);
    expect(alive(pid)).toBe(true);
  });
});

describe("make entra-up (#1562)", () => {
  it("starts over a recycled pid, refuses a second copy, and entra-down stops it", async () => {
    const dir = stateDir();
    const other = await longLived({ marker: "entra-idp.mjs" });
    writeFileSync(join(dir, "idp.pid"), `${other}\n`);

    const up = run(UP, dir, ["--no-seed", "--port=0"]);
    expect(up.stderr).toBe("");
    expect(up.status).toBe(0);
    expect(up.stdout).toContain(READY_LINE);
    const pid = Number(readFileSync(join(dir, "idp.pid"), "utf8"));
    expect(pid).not.toBe(other);
    cleanups.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    const again = run(UP, dir, ["--no-seed", "--port=0"]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`already running (pid ${pid})`);

    const down = run(DOWN, dir);
    expect(down.status).toBe(0);
    expect(down.stdout).toContain(`OK stopped the mock Entra IdP (pid ${pid})`);
    expect(existsSync(join(dir, "idp.pid"))).toBe(false);
    // An exited process can linger a moment as a zombie until init reaps it.
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
    expect(alive(other)).toBe(true);
  }, 60_000);
});

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * #24 — `scripts/restart.sh` swept for "orphans" by SIGTERMing every process on the
 * machine whose argv matched `modelcontextprotocol|mcp-server-`, so restarting METIS
 * killed other tools' MCP servers (eight processes, with no METIS process running).
 *
 * ## Isolation — this suite never signals anything
 *
 * The script is run against the REAL process table, so an unfixed (or regressed)
 * selection would otherwise terminate real processes on the machine running the tests.
 * `BASH_ENV` defines a `kill` function, which bash prefers over its builtin: liveness
 * probes (`kill -0`) pass through, every real signal is only RECORDED. The script is
 * also run from a throwaway copy, so its repository root is an empty temp directory
 * nothing live runs in, on ports no METIS process holds, with a unique owner tag.
 * The assertions are on the recorded signal list.
 */

const repoScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "restart.sh");

const posix = process.platform !== "win32";
const tmpRoots = [];
const children = [];

function mkTmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

/** A throwaway checkout: `<root>/scripts/restart.sh` plus `server/` and `ui/`. */
let fakeRepo;
let outside;
let shim;
/** The tag restart.sh derives for `fakeRepo` — the same `cksum` of the checkout path. */
let ownerTag;

beforeAll(() => {
  if (!posix) return;
  fakeRepo = mkTmp("metis-restart-repo-");
  fs.mkdirSync(path.join(fakeRepo, "scripts"));
  fs.mkdirSync(path.join(fakeRepo, "server"));
  fs.mkdirSync(path.join(fakeRepo, "ui"));
  fs.copyFileSync(repoScript, path.join(fakeRepo, "scripts", "restart.sh"));
  ownerTag = `metis-${spawnSync("cksum", { input: fakeRepo, encoding: "utf8" }).stdout.split(" ")[0]}`;
  outside = mkTmp("metis-restart-elsewhere-");
  shim = path.join(outside, "kill-shim.sh");
  fs.writeFileSync(
    shim,
    [
      "kill() {",
      '  if [ "$1" = "-0" ]; then builtin kill "$@"; return; fi',
      '  echo "$*" >> "$KILL_LOG"',
      "}",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  while (children.length) {
    const c = children.pop();
    try {
      process.kill(c, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Start a long-lived node process. `extraArgv` lands in its command line (what the old
 * sweep grepped); `script` may print `expectExtra` more numbers (a grandchild PID, a
 * listening port) as `pid:<n>` lines, printed asynchronously, so they are awaited too.
 */
async function startProcess({ cwd, extraArgv = [], env = {}, script = "", expectExtra = 0 }) {
  const body = `${script};process.stdout.write("ready\\n");setInterval(()=>{},1e5);`;
  const child = spawn(process.execPath, ["-e", body, ...extraArgv], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child.pid);
  const extra = [];
  await new Promise((resolve, reject) => {
    let buf = "";
    child.once("error", reject);
    child.stdout.on("data", (d) => {
      buf += d;
      for (const m of buf.matchAll(/pid:(\d+)/g)) {
        const n = Number(m[1]);
        if (!extra.includes(n)) extra.push(n);
      }
      if (buf.includes("ready") && extra.length >= expectExtra) resolve();
    });
  });
  return { pid: child.pid, extra };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Run the copied script with `kill` neutralised; return the PIDs it tried to signal. */
async function runStopOnly({ serverPort, uiPort, env = {} } = {}) {
  const killLog = path.join(outside, `kills-${Date.now()}-${Math.random()}.log`);
  fs.writeFileSync(killLog, "");
  const res = spawnSync("bash", [path.join(fakeRepo, "scripts", "restart.sh"), "--stop-only"], {
    cwd: outside,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BASH_ENV: shim,
      KILL_LOG: killLog,
      SERVER_PORT: String(serverPort ?? (await freePort())),
      UI_PORT: String(uiPort ?? (await freePort())),
      STOP_GRACE_SECS: "0",
      ...env,
    },
  });
  const signalled = new Set(
    fs
      .readFileSync(killLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => line.split(/\s+/).slice(1))
      .map(Number),
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, signalled };
}

describe.skipIf(!posix)("scripts/restart.sh stops only what METIS started (#24)", () => {
  it("with no METIS process running, signals nothing — not other tools' MCP servers", async () => {
    const otherMcp = await startProcess({
      cwd: outside,
      extraArgv: ["mcp-server-github", "@modelcontextprotocol/server-playwright"],
    });
    const otherNextDev = await startProcess({ cwd: outside, extraArgv: ["next", "dev"] });
    const otherOwner = await startProcess({
      cwd: outside,
      extraArgv: ["mcp-server-other"],
      env: { METIS_SIDECAR_OWNER: `${ownerTag}-someone-else` },
    });
    const tagInArgvOnly = await startProcess({
      cwd: outside,
      extraArgv: [`METIS_SIDECAR_OWNER=${ownerTag}`, "mcp-server-x"],
    });

    const run = await runStopOnly();

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("no running METIS processes found");
    expect([...run.signalled]).toEqual([]);
    for (const p of [otherMcp, otherNextDev, otherOwner, tagInArgvOnly]) {
      expect(alive(p.pid)).toBe(true);
    }
  });

  it("stops a METIS dev process and its whole tree, and nothing beside it", async () => {
    // `next dev` run from inside the checkout, with an MCP-looking grandchild.
    const metisUi = await startProcess({
      cwd: path.join(fakeRepo, "ui"),
      extraArgv: ["next", "dev"],
      script:
        'const g=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e5)","mcp-server-sidecar"],{stdio:"ignore"});process.stdout.write("pid:"+g.pid+"\\n")',
      expectExtra: 1,
    });
    children.push(...metisUi.extra); // the grandchild outlives its SIGKILLed parent
    const otherMcp = await startProcess({ cwd: outside, extraArgv: ["mcp-server-github"] });
    const otherNextDev = await startProcess({ cwd: outside, extraArgv: ["next", "dev"] });

    const run = await runStopOnly();

    expect(run.status, run.stderr).toBe(0);
    expect(run.signalled.has(metisUi.pid)).toBe(true);
    expect(metisUi.extra).toHaveLength(1);
    expect(run.signalled.has(metisUi.extra[0])).toBe(true);
    expect(run.signalled.has(otherMcp.pid)).toBe(false);
    expect(run.signalled.has(otherNextDev.pid)).toBe(false);
  });

  it("finds a sidecar orphaned by a dead server through this checkout's owner tag", async () => {
    const orphan = await startProcess({
      cwd: outside,
      extraArgv: ["mcp-server-orphan"],
      env: { METIS_SIDECAR_OWNER: ownerTag },
    });
    const run = await runStopOnly();
    expect(run.signalled.has(orphan.pid)).toBe(true);
    expect([...run.signalled]).toEqual([orphan.pid]);
  });

  it("does not sweep its own subshells when started with this checkout's tag set", async () => {
    // A forked subshell reports the environment its process was exec'd with, so a
    // script that merely `unset` the tag would still find (and kill) its own workers.
    const run = await runStopOnly({ env: { METIS_SIDECAR_OWNER: ownerTag } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("no running METIS processes found");
    expect([...run.signalled]).toEqual([]);
  });

  it("leaves a non-METIS process on a METIS port alone, and stops a METIS one", async () => {
    const listen =
      'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>process.stdout.write("pid:"+s.address().port+"\\n"))';
    const foreign = await startProcess({ cwd: outside, script: listen, expectExtra: 1 });
    const ours = await startProcess({
      cwd: path.join(fakeRepo, "server"),
      script: listen,
      expectExtra: 1,
    });

    const run = await runStopOnly({ serverPort: foreign.extra[0], uiPort: ours.extra[0] });

    expect(run.status, run.stderr).toBe(0);
    expect(run.signalled.has(foreign.pid)).toBe(false);
    expect(run.signalled.has(ours.pid)).toBe(true);
  });
});

describe("scripts/restart.ps1 (#24)", () => {
  // Windows cannot be exercised here; `Stop-Tree` already runs `taskkill /T`, which
  // takes a METIS process's sidecars down with it, so the machine-wide MCP argv
  // pattern is simply gone. Pin that it stays gone.
  it("no longer matches MCP servers by argv", () => {
    const ps1 = fs.readFileSync(path.join(path.dirname(repoScript), "restart.ps1"), "utf8");
    expect(ps1).not.toMatch(/modelcontextprotocol|mcp-server-/);
  });
});

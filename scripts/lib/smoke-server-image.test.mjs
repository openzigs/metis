import { describe, expect, it, vi } from "vitest";

import {
  CONTAINER_PORT,
  DEFAULT_HOST_PORT,
  DEFAULT_TIMEOUT_S,
  MODULE_PROBES,
  buildRunArgs,
  parseSmokeArgs,
  runSmoke,
} from "./smoke-server-image.mjs";

/**
 * #39 — the smoke gate that makes a green `api` job mean the server image runs.
 * Every docker call and every HTTP poll is injected, so these arms drive the gate
 * through each way an image can fail without a daemon.
 */

/**
 * A scripted docker. `inspect` answers the container-state poll (one entry per
 * poll, the last one repeating); `exec` answers the module probes by probe name.
 *
 * @param {{
 *   version?: number,
 *   run?: { status: number, stderr?: string },
 *   inspect?: string[],
 *   inspectStatus?: number,
 *   exec?: Record<string, number>,
 * }} spec
 */
function fakeDocker(spec = {}) {
  let polls = 0;
  const calls = /** @type {string[][]} */ ([]);
  const docker = vi.fn((/** @type {string[]} */ args) => {
    calls.push(args);
    const sub = args[0];
    if (sub === "version") return { status: spec.version ?? 0, stdout: "27.0.0", stderr: "" };
    if (sub === "run")
      return { status: spec.run?.status ?? 0, stdout: "cid", stderr: spec.run?.stderr ?? "" };
    if (sub === "inspect") {
      const states = spec.inspect ?? ["true 0"];
      const s = states[Math.min(polls, states.length - 1)];
      polls += 1;
      return { status: spec.inspectStatus ?? 0, stdout: `${s}\n`, stderr: "" };
    }
    if (sub === "exec") {
      const code = args[args.length - 1];
      const probe = MODULE_PROBES.find((p) => p.code === code);
      const status = spec.exec?.[probe?.name ?? ""] ?? 0;
      return { status, stdout: "", stderr: status === 0 ? "" : `probe ${probe?.name} blew up` };
    }
    if (sub === "logs") return { status: 0, stdout: "server log line", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
  return { docker, calls };
}

/** A clock that advances by `step` ms every time it is read. */
function fakeClock(step = 1000) {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

/** @param {Array<number | null>} statuses the /healthz status per poll; last repeats */
function fakeFetch(statuses) {
  let i = 0;
  return vi.fn(async () => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return s;
  });
}

function deps(overrides = {}) {
  const out = /** @type {string[]} */ ([]);
  const errs = /** @type {string[]} */ ([]);
  return {
    out,
    errs,
    deps: {
      sleep: async () => {},
      now: fakeClock(),
      log: (/** @type {string} */ m) => out.push(m),
      err: (/** @type {string} */ m) => errs.push(m),
      secret: () => "s3cr3t",
      ...overrides,
    },
  };
}

describe("parseSmokeArgs", () => {
  it("requires --image and applies defaults", () => {
    expect(parseSmokeArgs([])).toEqual({ error: "--image is required" });
    expect(parseSmokeArgs(["--image", "metis-server:ci-1"])).toEqual({
      image: "metis-server:ci-1",
      timeoutS: DEFAULT_TIMEOUT_S,
      port: DEFAULT_HOST_PORT,
    });
  });

  it("parses --timeout and --port", () => {
    expect(parseSmokeArgs(["--image", "x", "--timeout", "30", "--port", "15000"])).toEqual({
      image: "x",
      timeoutS: 30,
      port: 15000,
    });
  });

  it("rejects unknown flags, missing values and non-positive numbers", () => {
    expect(parseSmokeArgs(["--nope", "1"])).toEqual({ error: "unknown argument: --nope" });
    expect(parseSmokeArgs(["--image"])).toEqual({ error: "--image needs a value" });
    expect(parseSmokeArgs(["--image", "--port"])).toEqual({ error: "--image needs a value" });
    expect(parseSmokeArgs(["--image", "x", "--timeout", "0"])).toEqual({
      error: "--timeout must be a positive integer",
    });
    expect(parseSmokeArgs(["--image", "x", "--port", "1.5"])).toEqual({
      error: "--port must be a positive integer",
    });
  });
});

describe("buildRunArgs", () => {
  const args = buildRunArgs({
    image: "metis-server:ci-1",
    name: "smoke",
    port: 14000,
    jwtSecret: "j",
    vaultKey: "v",
    embeddingsToken: "e",
  });

  it("runs the image's own CMD: the image is the last argument, nothing follows it", () => {
    expect(args[0]).toBe("run");
    expect(args.at(-1)).toBe("metis-server:ci-1");
  });

  it("publishes only on loopback, to the port the image listens on", () => {
    expect(args).toContain(`127.0.0.1:14000:${CONTAINER_PORT}`);
  });

  it("passes the per-run secrets and a production-legal auth mode", () => {
    expect(args).toContain("JWT_SECRET=j");
    expect(args).toContain("VAULT_MASTER_KEY=v");
    expect(args).toContain("EMBEDDINGS_TOKEN=e");
    expect(args).toContain("AUTH_MODE=ldap");
    expect(args).not.toContain("AUTH_MODE=mock");
  });

  it("does not skip the migration guard — the boot path under test includes it", () => {
    expect(args.join(" ")).not.toMatch(/METIS_SKIP_MIGRATE/);
  });
});

describe("runSmoke", () => {
  it("passes when /healthz answers 200 and every probe loads", async () => {
    const { docker, calls } = fakeDocker();
    const { deps: d, out } = deps({ docker, fetchStatus: fakeFetch([null, 503, 200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(0);
    expect(out.at(-1)).toMatch(/^PASS: img starts, serves \/healthz and loads 5 runtime module/);
    const execs = calls.filter((c) => c[0] === "exec");
    expect(execs).toHaveLength(MODULE_PROBES.length);
    // The container is always removed.
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("fails and prints the log when the container exits before serving (the #39 shape)", async () => {
    const { docker, calls } = fakeDocker({ inspect: ["true 0", "false 1"] });
    const fetchStatus = fakeFetch([null]);
    const { deps: d, errs } = deps({ docker, fetchStatus });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/exited before serving \/healthz \(exit code 1\)/);
    expect(errs.join("\n")).toContain("server log line");
    expect(calls.some((c) => c[0] === "exec")).toBe(false);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("fails when inspect itself fails (container already gone)", async () => {
    const { docker } = fakeDocker({ inspectStatus: 1, inspect: [""] });
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/exited before serving/);
  });

  it("fails when /healthz never answers 200 within the deadline", async () => {
    const { docker } = fakeDocker();
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([503]) });
    expect(await runSmoke({ image: "img", timeoutS: 5, pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/did not return 200 within 5s \(last status: 503\)/);
    expect(errs.join("\n")).toContain("server log line");
  });

  it("reports 'no response' when nothing ever answered", async () => {
    const { docker } = fakeDocker();
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([null]) });
    expect(await runSmoke({ image: "img", timeoutS: 3, pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/last status: no response/);
  });

  it("fails when /healthz is up but a module probe cannot load (a dead feature in a live image)", async () => {
    const { docker } = fakeDocker({ exec: { lancedb: 1 } });
    const { deps: d, errs, out } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(out).toContain("OK: /healthz returned 200");
    expect(errs.join("\n")).toMatch(/1 of 5 module probe\(s\) failed: lancedb/);
    expect(errs.join("\n")).toContain("probe lancedb blew up");
  });

  it("fails when docker run cannot start the container", async () => {
    const { docker, calls } = fakeDocker({ run: { status: 125, stderr: "no such image" } });
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/docker run did not start the container: no such image/);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("exits 2 (invocation error, not a verdict) when docker is unavailable", async () => {
    const { docker, calls } = fakeDocker({ version: 1 });
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img" }, d)).toBe(2);
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("never logs the generated secrets", async () => {
    const { docker } = fakeDocker({ inspect: ["false 1"] });
    const { deps: d, out, errs } = deps({ docker, fetchStatus: fakeFetch([null]) });
    await runSmoke({ image: "img", pollMs: 1 }, d);
    expect([...out, ...errs].join("\n")).not.toContain("s3cr3t");
  });
});

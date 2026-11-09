import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * #2082 — `scripts/ci/install-trivy.sh` fetched the pinned Trivy release with
 * `curl --retry 3`: four attempts inside ~7 s of curl's default backoff. GitHub's release
 * download answered 504 to every one of them three times on 2026-11-09, and each time the
 * `api` job died after ~20 minutes of image builds.
 *
 * ## How this runs the real script against a 504 burst
 *
 * The script is run unmodified. A `curl` shim first on `PATH` records the arguments the
 * script passed, points the GitHub release URL at a local server, and swaps the
 * `--retry-delay` value for 1 s so a burst costs seconds, not a minute — then execs the
 * REAL curl with every other flag as the script wrote it. So the retry count, the
 * retry-on-what policy and `-f` are curl's own behaviour under the script's own flags; only
 * the spacing is shortened, and the spacing is asserted separately from the recorded args.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "ci", "install-trivy.sh");
const posix = process.platform !== "win32";

const VERSION = "0.0.0-test";
const TARBALL = `trivy_${VERSION}_Linux-64bit.tar.gz`;
const ASSET_PATH = `/aquasecurity/trivy/releases/download/v${VERSION}/${TARBALL}`;

const tmpRoots = [];
function mkTmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

let tarball;
let sha256;
let shimDir;
let realCurl;
let server;
let port;
/** How many requests answer 504 before the asset is served; Infinity = never served. */
let failuresBeforeServing = 0;
let requests = 0;

beforeAll(async () => {
  if (!posix) return;
  realCurl = execFileSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).trim();

  // A release tarball holding a `trivy` that answers `--version`.
  const src = mkTmp("metis-trivy-src-");
  fs.writeFileSync(path.join(src, "trivy"), `#!/bin/sh\necho "Version: ${VERSION}"\n`, {
    mode: 0o755,
  });
  const out = mkTmp("metis-trivy-asset-");
  execFileSync("tar", ["-czf", path.join(out, TARBALL), "-C", src, "trivy"]);
  tarball = fs.readFileSync(path.join(out, TARBALL));
  sha256 = crypto.createHash("sha256").update(tarball).digest("hex");

  shimDir = mkTmp("metis-trivy-shim-");
  fs.writeFileSync(
    path.join(shimDir, "curl"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$@" > "$CURL_ARGS_LOG"',
      "args=()",
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--retry-delay" ]; then a=1; fi',
      '  case "$a" in https://github.com/*) a="$FAKE_GITHUB${a#https://github.com}";; esac',
      '  args+=("$a")',
      '  prev="$a"',
      "done",
      'exec "$REAL_CURL" "${args[@]}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  server = http.createServer((req, res) => {
    requests += 1;
    if (req.url !== ASSET_PATH) {
      res.writeHead(404).end();
    } else if (requests <= failuresBeforeServing) {
      res.writeHead(504).end("Gateway Timeout");
    } else {
      res.writeHead(200, { "content-type": "application/gzip" }).end(tarball);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterEach(() => {
  requests = 0;
  failuresBeforeServing = 0;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the real script, asynchronously: the fake server lives in this process, so a
 * synchronous spawn would block the event loop that has to answer curl.
 */
function install({ sha = sha256 } = {}) {
  const runnerTemp = mkTmp("metis-trivy-runner-");
  const argsLog = path.join(runnerTemp, "curl-args");
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
        REAL_CURL: realCurl,
        FAKE_GITHUB: `http://127.0.0.1:${port}`,
        CURL_ARGS_LOG: argsLog,
        RUNNER_TEMP: runnerTemp,
        TRIVY_VERSION: VERSION,
        TRIVY_SHA256: sha,
        TRIVY_ARCH: "",
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        output,
        installed: path.join(runnerTemp, "trivy", "trivy"),
        curlArgs: fs.existsSync(argsLog) ? fs.readFileSync(argsLog, "utf8").split("\n") : [],
      }),
    );
  });
}

/** The integer value following `flag` in a recorded argv, or undefined. */
function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : Number(argv[at + 1]);
}

describe.skipIf(!posix)("install-trivy.sh download retries (#2082)", () => {
  it("installs the verified binary on the first attempt when the release answers", async () => {
    const run = await install();
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain(`Version: ${VERSION}`);
    expect(fs.existsSync(run.installed)).toBe(true);
    expect(requests).toBe(1);
  }, 30_000);

  it("spaces its retries over at least a minute, retrying every error", async () => {
    const run = await install();
    expect(run.code, run.output).toBe(0);
    const retries = flagValue(run.curlArgs, "--retry");
    const delay = flagValue(run.curlArgs, "--retry-delay");
    expect(retries).toBeGreaterThanOrEqual(1);
    // curl's default backoff (no --retry-delay) is 1, 2, 4 s… — the ~7 s that failed.
    expect(delay, "an explicit --retry-delay").toBeGreaterThanOrEqual(1);
    expect(retries * delay).toBeGreaterThanOrEqual(60);
    // A reset or truncated transfer is not one of curl's default "transient" errors.
    expect(run.curlArgs).toContain("--retry-all-errors");
    // `-f`: an HTTP error is a failure (and so retried), never an HTML body saved as the tarball.
    expect(run.curlArgs.some((a) => /^-[a-zA-Z]*f/.test(a))).toBe(true);
  }, 30_000);

  it("survives a 504 on every retry but the last", async () => {
    // The probe run reads how many retries the script asks for; the burst fills all but one.
    const probe = await install();
    const retries = flagValue(probe.curlArgs, "--retry");
    requests = 0;
    failuresBeforeServing = retries;

    const run = await install();
    expect(run.code, run.output).toBe(0);
    expect(requests).toBe(retries + 1);
    expect(run.output).toContain(`Version: ${VERSION}`);
  }, 60_000);

  it("still fails the step when the release never answers", async () => {
    failuresBeforeServing = Infinity;
    const run = await install();
    expect(run.code).not.toBe(0);
    expect(fs.existsSync(run.installed)).toBe(false);
    // It gave up after its retries rather than looping.
    expect(requests).toBe(flagValue(run.curlArgs, "--retry") + 1);
  }, 60_000);

  it("still refuses a download whose SHA-256 does not match", async () => {
    const run = await install({ sha: "0".repeat(64) });
    expect(run.code).not.toBe(0);
    expect(fs.existsSync(run.installed)).toBe(false);
  }, 30_000);
});

describe("the Install Trivy steps cannot be made non-blocking (#2082)", () => {
  it.each([".github/workflows/ci.yml", ".github/workflows/build-images.yml"])(
    "%s runs install-trivy.sh with no continue-on-error",
    (rel) => {
      const workflow = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      const at = workflow.indexOf("- name: Install Trivy");
      expect(at).toBeGreaterThan(-1);
      const step = workflow.slice(at, workflow.indexOf("\n\n", at));
      expect(step).toContain("bash scripts/ci/install-trivy.sh");
      expect(step).not.toMatch(/continue-on-error|\|\| true/);
    },
  );
});

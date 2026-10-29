/**
 * #1559 — the runner `scripts/entra-idp.mjs` (`pnpm saml:entra`), spawned for
 * real: it prints the ready banner, serves the mock until SIGTERM, then exits
 * 0; a bad argument exits 1 before anything listens.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { READY_LINE } from "./entra-idp-harness.mjs";

const RUNNER = fileURLToPath(new URL("../entra-idp.mjs", import.meta.url));

describe("scripts/entra-idp.mjs (#1559)", () => {
  it("serves the mock until SIGTERM, then exits 0", async () => {
    const child = spawn(process.execPath, [RUNNER, "--port=0", "--no-seed"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

    await expect.poll(() => out, { timeout: 15_000, interval: 100 }).toContain(READY_LINE);
    const metadataUrl = /Federation Metadata: (\S+)/.exec(out)?.[1];
    expect(metadataUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect((await fetch(/** @type {string} */ (metadataUrl))).status).toBe(200);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 20_000);

  it("exits 1 on an argument it does not know", () => {
    const run = spawnSync(process.execPath, [RUNNER, "--host=0.0.0.0"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("FAIL unknown argument '--host=0.0.0.0'");
  });
});

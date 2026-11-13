/**
 * #2333 — time a synchronous call over a large adversarial input in a CHILD
 * process that is killed after `killAfterMs`.
 *
 * A regex that regresses to quadratic time cannot be interrupted in the
 * calling thread: called in-process, a 1 MB input would spin the vitest worker
 * for minutes instead of failing. Here a hang is a SIGKILL, which
 * {@link timeIsolated} reports as a failure. Same pattern as
 * `analysis-synthesis-salvage.test.ts`.
 *
 * Each input is described, not passed (a 1 MB argv overruns `ARG_MAX`): the
 * child builds `prefix + unit.repeat(…)` cut to `length` characters, + `suffix`.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export interface InputSpec {
  prefix?: string;
  unit: string;
  length: number;
  suffix?: string;
}

/**
 * Call `exportName` from `moduleFromServer` (a path relative to `server/`) on
 * each input in a child process, and return how long each call took in ms.
 * Fails the calling test if the child is killed or exits non-zero.
 */
export function timeIsolated(
  moduleFromServer: string,
  exportName: string,
  inputs: readonly InputSpec[],
  killAfterMs = 10_000,
): number[] {
  const serverDir = fileURLToPath(new URL("../..", import.meta.url));
  const modUrl = new URL(moduleFromServer, new URL("../../", import.meta.url)).href;
  const script = `
    const mod = await import(${JSON.stringify(modUrl)});
    const fn = mod[${JSON.stringify(exportName)}];
    const specs = JSON.parse(process.argv[1]);
    const out = specs.map((s) => {
      const body = s.unit.repeat(Math.ceil(s.length / s.unit.length)).slice(0, s.length);
      const input = (s.prefix ?? "") + body + (s.suffix ?? "");
      const t = performance.now();
      fn(input);
      return performance.now() - t;
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(inputs)],
    { cwd: serverDir, encoding: "utf8", timeout: killAfterMs, killSignal: "SIGKILL" },
  );
  // A hang is killed by the timeout: signal SIGKILL, status null.
  expect(res.signal, `killed after ${killAfterMs} ms (a hang)\n${res.stderr}`).toBeNull();
  expect(res.status, res.stderr).toBe(0);
  const ms = JSON.parse(res.stdout) as number[];
  expect(ms).toHaveLength(inputs.length);
  return ms;
}

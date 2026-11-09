/**
 * #1878 — the code a governing reading ran: the HEAD commit and whether the
 * working tree was clean. `combineGoverningReports` and `--reading` refuse a
 * run whose commit does not name its code, so both read this.
 *
 * #2063 — moved out of `scripts/eval-governing.ts`, which runs its CLI on
 * import, so it can be tested.
 */
import { execFileSync } from "node:child_process";
import type { GoverningProvenance } from "./runner.js";

/** Runs `git args` in `cwd` and returns its stdout; throws when git fails. */
export type GitRunner = (args: readonly string[], cwd: string) => string;

const runGit: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The HEAD commit of `cwd` and whether its tree is clean; null where git cannot say. */
export function gitProvenance(
  cwd: string,
  git: GitRunner = runGit,
): Pick<GoverningProvenance, "commit" | "dirty"> {
  const read = (args: readonly string[]): string | null => {
    try {
      return git(args, cwd).trim();
    } catch {
      return null;
    }
  };
  const commit = read(["rev-parse", "HEAD"]);
  const status = read(["status", "--porcelain"]);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

/**
 * Epic #194 (C.1) — SWE-bench-Pro task corpus loader.
 *
 * In production the runner pulls the official SWE-bench-Pro task list from
 * a JSONL manifest cached in `~/.metis/eval-cache/swe-bench/`. Tests pass
 * an in-memory fixture set so they never need to touch the network.
 *
 * Each task is the minimum metadata the runner needs:
 *   - `taskId`     — unique id (e.g. `astropy__astropy-12907`)
 *   - `repo`       — `org/repo` of the upstream repository
 *   - `baseCommit` — commit SHA the patch should apply against
 *   - `prompt`     — natural-language description of the bug to fix
 *   - `expectedPatch` — golden patch used by the scorer for reference
 *   - `testCommand` — shell command the sandbox runs to validate the fix
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SweBenchTask {
  taskId: string;
  repo: string;
  baseCommit: string;
  prompt: string;
  expectedPatch: string;
  testCommand: string;
}

export interface CorpusOptions {
  /** Override the cache root (defaults to ~/.metis/eval-cache/swe-bench). */
  cacheDir?: string;
  /** Override the manifest filename (defaults to `tasks.jsonl`). */
  manifestFile?: string;
  /** Test seam — provide an in-memory list instead of touching the FS. */
  inMemory?: SweBenchTask[];
  /** Optional `.slice(0, limit)` cap so CI runs stay bounded. */
  limit?: number;
}

export function defaultCacheDir(): string {
  return path.join(os.homedir(), ".metis", "eval-cache", "swe-bench");
}

/**
 * Load the SWE-bench-Pro task corpus. Order:
 *   1. `inMemory` if provided (test path).
 *   2. `<cacheDir>/<manifestFile>` if it exists.
 *   3. Throws — production runners are responsible for seeding the cache.
 */
export async function loadCorpus(opts: CorpusOptions = {}): Promise<SweBenchTask[]> {
  if (opts.inMemory) return capLimit(opts.inMemory, opts.limit);
  const dir = opts.cacheDir ?? defaultCacheDir();
  const manifest = path.join(dir, opts.manifestFile ?? "tasks.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(manifest, "utf8");
  } catch (err) {
    throw new Error(
      `SWE-bench-Pro manifest not found at ${manifest}: ${(err as Error).message}. ` +
        `Run \`pnpm --filter @metis/server eval:swebench:seed\` to populate the cache.`,
    );
  }
  const tasks = parseJsonl(raw);
  return capLimit(tasks, opts.limit);
}

export function parseJsonl(raw: string): SweBenchTask[] {
  const out: SweBenchTask[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as Partial<SweBenchTask>;
    if (
      typeof obj.taskId !== "string" ||
      typeof obj.repo !== "string" ||
      typeof obj.baseCommit !== "string" ||
      typeof obj.prompt !== "string" ||
      typeof obj.expectedPatch !== "string" ||
      typeof obj.testCommand !== "string"
    ) {
      throw new Error(`SWE-bench-Pro task is missing required fields: ${trimmed.slice(0, 80)}`);
    }
    out.push(obj as SweBenchTask);
  }
  return out;
}

function capLimit<T>(arr: T[], limit?: number): T[] {
  if (typeof limit === "number" && limit > 0) return arr.slice(0, limit);
  return arr;
}

/**
 * Epic #194 (C.2) — TAU-bench scenario loader.
 *
 * TAU-bench evaluates tool-use agents on multi-turn customer-service
 * scenarios. Each scenario specifies:
 *   - `scenarioId` — unique id (e.g. `airline_001`)
 *   - `prompt`     — initial customer message
 *   - `tools`      — names of the tools the agent may invoke
 *   - `expectedToolCalls` — ordered list of `{ name, args }` the agent
 *     should produce (in order, exact-match scored by {@link scoreScenario})
 *   - `finalState` — JSON object describing the canonical end state of
 *     the back-end (account balance, reservation status, etc.)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface TauScenario {
  scenarioId: string;
  prompt: string;
  tools: string[];
  expectedToolCalls: ExpectedToolCall[];
  finalState: Record<string, unknown>;
}

export interface ExpectedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScenarioOptions {
  cacheDir?: string;
  manifestFile?: string;
  inMemory?: TauScenario[];
  limit?: number;
}

export function defaultCacheDir(): string {
  return path.join(os.homedir(), ".metis", "eval-cache", "tau-bench");
}

export async function loadScenarios(opts: ScenarioOptions = {}): Promise<TauScenario[]> {
  if (opts.inMemory) return capLimit(opts.inMemory, opts.limit);
  const dir = opts.cacheDir ?? defaultCacheDir();
  const manifest = path.join(dir, opts.manifestFile ?? "scenarios.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(manifest, "utf8");
  } catch (err) {
    throw new Error(
      `TAU-bench manifest not found at ${manifest}: ${(err as Error).message}. ` +
        `Run \`pnpm --filter @metis/server eval:tau:seed\` to populate the cache.`,
    );
  }
  return capLimit(parseJsonl(raw), opts.limit);
}

export function parseJsonl(raw: string): TauScenario[] {
  const out: TauScenario[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as Partial<TauScenario>;
    if (
      typeof obj.scenarioId !== "string" ||
      typeof obj.prompt !== "string" ||
      !Array.isArray(obj.tools) ||
      !Array.isArray(obj.expectedToolCalls) ||
      typeof obj.finalState !== "object" ||
      obj.finalState == null
    ) {
      throw new Error(`TAU-bench scenario is missing required fields: ${trimmed.slice(0, 80)}`);
    }
    out.push(obj as TauScenario);
  }
  return out;
}

function capLimit<T>(arr: T[], limit?: number): T[] {
  if (typeof limit === "number" && limit > 0) return arr.slice(0, limit);
  return arr;
}

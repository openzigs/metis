/**
 * Epic #803 (Epic 09) — Domain-eval results store.
 *
 * The runner writes `eval-results/<runId>.json` envelopes; the read API and the
 * drift check both load them back. Centralising the (de)serialisation here keeps
 * validation in one place and lets the route + runner share a single source of
 * truth without a database.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { domainEvalRunResultSchema, type DomainEvalRunResult } from "@metis/shared";

export function defaultResultsDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "eval-results");
}

function isResultFile(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".");
}

export async function listRunIds(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter(isResultFile)
    .map((n) => n.replace(/\.json$/, ""))
    .sort();
}

export async function readRun(dir: string, runId: string): Promise<DomainEvalRunResult | null> {
  // Guard against path traversal — runId is used as a filename.
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const file = path.join(dir, `${runId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const parsed = domainEvalRunResultSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/** Load every valid run, newest first (by startedAt then runId). */
export async function loadAllRuns(dir: string): Promise<DomainEvalRunResult[]> {
  const ids = await listRunIds(dir);
  const runs: DomainEvalRunResult[] = [];
  for (const id of ids) {
    const run = await readRun(dir, id);
    if (run) runs.push(run);
  }
  runs.sort((a, b) => {
    const ta = new Date(a.startedAt).getTime();
    const tb = new Date(b.startedAt).getTime();
    if (tb !== ta) return tb - ta;
    return b.runId.localeCompare(a.runId);
  });
  return runs;
}

export async function writeRun(dir: string, run: DomainEvalRunResult): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${run.runId}.json`);
  await fs.writeFile(file, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return file;
}

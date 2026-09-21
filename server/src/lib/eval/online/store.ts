/**
 * Epic #1316 / issue #1321 — online-eval results store.
 *
 * Mirrors `eval/domain/results-store.ts`: file-backed, no Prisma model, so the
 * committed artifact is the source of truth for the operator view.
 *
 * Two privacy guards live here, because this is the only code path that can put
 * bytes into the shared `eval-results/` tree. (That tree is gitignored today —
 * `.gitignore` — but it is an operator artifact that gets copied around and was
 * committed in the past, so the content-free guarantee is enforced here rather
 * than delegated to an ignore rule.)
 *
 *  1. Every envelope is validated with the `.strict()` schemas from
 *     `@metis/shared` BEFORE it is written. A field that is not on the schema —
 *     including any field carrying user text — makes the write fail rather than
 *     land on disk.
 *  2. {@link assertContentFree} re-walks the serialised envelope and rejects any
 *     string that is not a digest, an id, an ISO timestamp or a known enum. It
 *     is belt-and-braces against a schema change that adds a text field without
 *     anyone noticing the artifact is committed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ONLINE_EVAL_MAX_REASON_CHARS,
  onlineEvalSampleSchema,
  onlineEvalWindowSchema,
  type OnlineEvalSample,
  type OnlineEvalWindow,
} from "@metis/shared";

/** Files in the results dir that are state, not windows. */
export const BUDGET_FILE = "budget.json";
export const PENDING_FILE = "pending.json";
const RESERVED = new Set([BUDGET_FILE, PENDING_FILE]);

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export class OnlineEvalContentLeakError extends Error {
  readonly field: string;
  constructor(field: string, sample: string) {
    super(
      `online-eval envelope field "${field}" carries free text (${sample.length} chars) — ` +
        `online-eval envelopes must stay content-free (#1321)`,
    );
    this.name = "OnlineEvalContentLeakError";
    this.field = field;
  }
}

/**
 * Fields allowed to hold a free-form string, each with its own hard length
 * bound. Everything else in the envelope must be a digest, an id, a timestamp,
 * an enum member or a number.
 *
 * The bound matters as much as the allowlist: an unbounded allowlisted key is
 * exactly where a future author interpolates something (`reason: \`drift on
 * ${question}\``) and slips content past the guard. `judge` is bounded at 128
 * by its schema; `reason` is bounded at {@link ONLINE_EVAL_MAX_REASON_CHARS}
 * both there and here.
 */
const FREE_TEXT_ALLOWLIST: ReadonlyMap<string, number> = new Map([
  ["reason", ONLINE_EVAL_MAX_REASON_CHARS],
  ["judge", 128],
]);
/** A string longer than this in a non-allowlisted field is treated as content. */
const MAX_OPAQUE_STRING = 128;

export function assertContentFree(value: unknown, pathPrefix = ""): void {
  if (typeof value === "string") {
    const key = pathPrefix.split(".").pop() ?? "";
    const allowance = FREE_TEXT_ALLOWLIST.get(key);
    const limit = allowance ?? MAX_OPAQUE_STRING;
    if (value.length > limit) {
      throw new OnlineEvalContentLeakError(pathPrefix || "<root>", value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertContentFree(v, `${pathPrefix}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertContentFree(v, pathPrefix ? `${pathPrefix}.${k}` : k);
    }
  }
}

export function isWindowFile(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".") && !RESERVED.has(name);
}

export async function listWindowIds(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter(isWindowFile)
    .map((n) => n.replace(/\.json$/, ""))
    .sort();
}

export async function readWindow(dir: string, windowId: string): Promise<OnlineEvalWindow | null> {
  // Guard against path traversal — windowId is used as a filename.
  if (!SAFE_ID.test(windowId) || RESERVED.has(`${windowId}.json`)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, `${windowId}.json`), "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = onlineEvalWindowSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Load every valid window, newest first (by completedAt then windowId). */
export async function loadAllWindows(dir: string): Promise<OnlineEvalWindow[]> {
  const ids = await listWindowIds(dir);
  const out: OnlineEvalWindow[] = [];
  for (const id of ids) {
    const w = await readWindow(dir, id);
    if (w) out.push(w);
  }
  out.sort((a, b) => {
    const ta = new Date(a.completedAt).getTime();
    const tb = new Date(b.completedAt).getTime();
    if (tb !== ta) return tb - ta;
    return b.windowId.localeCompare(a.windowId);
  });
  return out;
}

export async function writeWindow(dir: string, window: OnlineEvalWindow): Promise<string> {
  if (!SAFE_ID.test(window.windowId) || RESERVED.has(`${window.windowId}.json`)) {
    throw new Error(`unsafe online-eval windowId: ${window.windowId}`);
  }
  // Strict parse first: unknown keys (the shape a content leak would take) throw.
  const validated = onlineEvalWindowSchema.parse(window);
  assertContentFree(validated);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${window.windowId}.json`);
  await fs.writeFile(file, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Samples accumulated towards the next window. Persisted so a server restart
 * does not discard a half-full window; content-free like the envelope itself.
 */
export async function readPending(dir: string): Promise<OnlineEvalSample[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, PENDING_FILE), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = onlineEvalSampleSchema.array().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function writePending(dir: string, samples: OnlineEvalSample[]): Promise<void> {
  const validated = onlineEvalSampleSchema.array().parse(samples);
  assertContentFree(validated);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, PENDING_FILE),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
}

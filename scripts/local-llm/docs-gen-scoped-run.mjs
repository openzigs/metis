#!/usr/bin/env node
/**
 * Scoped documentation-generation runner — a fast local test run.
 *
 * A full-project doc-gen run on a local model takes ~30 h. This triggers a run
 * limited to a few repository-relative path prefixes (`pathPrefixes` on
 * POST /api/projects/:id/docs/generate), prints the document id, polls until it
 * finishes and prints a summary: status, characters, sections, warnings and the
 * provenance counts. See docs/ops/local-serving.md, "Fast test runs with a path
 * scope".
 *
 * It talks to an ALREADY RUNNING local stack over HTTP with mock auth. It never
 * starts or stops a server, and never talks to the model host itself.
 *
 * Usage:
 *   node scripts/local-llm/docs-gen-scoped-run.mjs --project <projectId> \
 *     --paths packages/domain/src/workout/,packages/physics/
 *
 *   # watch (or just summarise) a document that is already running/finished
 *   node scripts/local-llm/docs-gen-scoped-run.mjs --project <projectId> --doc <docId>
 *
 * Flags:
 *   --project <id>       project id                         (required)
 *   --paths <a/,b/>      comma-separated path prefixes      (required unless --doc)
 *   --doc <id>           watch an existing document instead of generating one
 *   --title <text>       document title                     (default: "Scoped test run")
 *   --doc-type <type>    business-requirements | architecture | user-guide
 *                                                           (default: business-requirements)
 *   --base <url>         API base URL, METIS_API_BASE       (default: http://localhost:4000/api)
 *   --username <u>       METIS_USERNAME                     (default: admin — mock auth)
 *   --password <p>       METIS_PASSWORD                     (default: password — mock auth)
 *   --poll <seconds>     poll interval                      (default: 30)
 *   --max-hours <h>      stop waiting after this long       (default: 12)
 *   --no-wait            print the document id and exit
 *
 * Exit codes: 0 = finished ready/degraded (or --no-wait); 1 = failed, timed out
 * or a request error.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

const DOC_TYPES = new Set(["business-requirements", "architecture", "user-guide"]);
const RUNNING = new Set(["pending", "generating"]);

/**
 * @typedef {object} Options
 * @property {string} base
 * @property {string} project
 * @property {string | null} doc
 * @property {string[]} paths
 * @property {string} [title]
 * @property {string} [docType]
 * @property {string} [username]
 * @property {string} [password]
 * @property {number} pollMs
 * @property {number} maxMs
 * @property {boolean} wait
 */
/** @typedef {(url: string, init: RequestInit) => Promise<Response>} FetchLike */
/** An API response body; its shape is the server's, read defensively. @typedef {any} Json */

/**
 * `--flag value` argv parser (same contract as smoke-test.mjs).
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/**
 * Resolve options from argv + env. Pure; throws on invalid input.
 * @param {Record<string, string | boolean>} args
 * @param {Record<string, string | undefined>} env
 */
export function resolveOptions(args, env) {
  /** @param {string | boolean | undefined} v */
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const project = str(args.project);
  if (!project) throw new Error("--project <projectId> is required");
  const doc = str(args.doc) || null;
  const paths = str(args.paths)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!doc && paths.length === 0) {
    throw new Error("--paths <prefix[,prefix…]> is required (or --doc <docId> to watch one)");
  }
  const docType = str(args["doc-type"]) || "business-requirements";
  if (!DOC_TYPES.has(docType))
    throw new Error(`--doc-type must be one of ${[...DOC_TYPES].join(", ")}`);
  /**
   * @param {string | boolean | undefined} v
   * @param {number} fallback
   * @param {string} name
   */
  const num = (v, fallback, name) => {
    if (v === undefined || v === true) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
    return n;
  };
  return {
    base: (str(args.base) || env.METIS_API_BASE || "http://localhost:4000/api").replace(/\/+$/, ""),
    project,
    doc,
    paths,
    title: str(args.title) || "Scoped test run",
    docType,
    username: str(args.username) || env.METIS_USERNAME || "admin",
    password: str(args.password) || env.METIS_PASSWORD || "password",
    pollMs: num(args.poll, 30, "poll") * 1000,
    maxMs: num(args["max-hours"], 12, "max-hours") * 3_600_000,
    wait: args["no-wait"] !== true,
  };
}

/**
 * The H2 headings of a markdown document, in order.
 * @param {unknown} markdown
 */
export function sectionHeadings(markdown) {
  const out = [];
  let fenced = false;
  for (const line of String(markdown ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^## /.test(line)) out.push(line.slice(3).trim());
  }
  return out;
}

/**
 * Build the printable summary of a finished document (the GET /:docId payload).
 * Pure, so it is testable without a server.
 * @param {Json} doc
 */
export function summarizeDocument(doc) {
  const lines = [];
  const content = typeof doc?.content === "string" ? doc.content : "";
  lines.push(`Document ${doc?.id ?? "?"}: ${doc?.title ?? "(untitled)"}`);
  lines.push(`Status:   ${doc?.status ?? "unknown"}`);
  if (doc?.errorMessage) lines.push(`Error:    ${doc.errorMessage}`);
  lines.push(`Chars:    ${content.length.toLocaleString("en-US")}`);
  const headings = sectionHeadings(content);
  lines.push(`Sections (${headings.length}):`);
  for (const h of headings) lines.push(`  - ${h}`);

  const warnings = Array.isArray(doc?.warnings) ? doc.warnings : [];
  lines.push(`Warnings (${warnings.length}):`);
  const byKind = new Map();
  for (const w of warnings) byKind.set(w?.kind ?? "?", (byKind.get(w?.kind ?? "?") ?? 0) + 1);
  if (byKind.size > 0) {
    lines.push(`  by kind: ${[...byKind].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  }
  for (const w of warnings) {
    lines.push(
      `  - [${w?.severity ?? "?"}] ${w?.kind ?? "?"}${w?.section ? ` (${w.section})` : ""}: ${w?.message ?? ""}`,
    );
  }

  const raw = doc?.versions?.[0]?.provenanceManifest;
  let manifest = null;
  try {
    manifest = typeof raw === "string" ? JSON.parse(raw) : (raw ?? null);
  } catch {
    manifest = null;
  }
  if (manifest) {
    const scope = manifest.document?.pathPrefixes;
    lines.push(
      `Scope:    ${Array.isArray(scope) ? scope.map((p) => `${p}/`).join(", ") : "full project (no path scope)"}`,
    );
    const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
    const primary = manifest.selectedEvidence?.primary;
    const evidence = Array.isArray(primary) ? primary.length : 0;
    lines.push(
      `Provenance: ${sections.length} section record(s), ${evidence} selected evidence source(s)`,
    );
    for (const s of sections) {
      lines.push(
        `  - ${s.sectionLabel}: ${s.providerKind}/${s.model}, facts ${s.factsSourceIds?.length ?? 0}, grounding ${s.groundingSourceIds?.length ?? 0}`,
      );
    }
    const models = manifest.generation?.model;
    if (models) {
      lines.push(`Models:   phase1=${models.phase1?.model} phase2=${models.phase2?.model}`);
    }
  } else {
    lines.push("Provenance: none recorded");
  }
  return lines.join("\n");
}

/**
 * Minimal JSON API client with mock-auth login and one re-login on 401.
 * @param {Pick<Options, "base" | "username" | "password">} opts
 * @param {FetchLike} [fetchImpl]
 */
export function createClient(opts, fetchImpl = globalThis.fetch) {
  /** @type {string | null} */
  let token = null;
  const login = async () => {
    const res = await fetchImpl(`${opts.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: opts.username, password: opts.password }),
    });
    /** @type {Json} */
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.data?.accessToken) {
      throw new Error(`login failed (${res.status}): ${body?.error?.message ?? "no access token"}`);
    }
    token = body.data.accessToken;
  };
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [payload]
   * @param {boolean} [retried]
   * @returns {Promise<Json>}
   */
  const call = async (method, path, payload, retried = false) => {
    if (!token) await login();
    const res = await fetchImpl(`${opts.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    // Access tokens last an hour; a scoped run can outlive one.
    if (res.status === 401 && !retried) {
      token = null;
      return call(method, path, payload, true);
    }
    /** @type {Json} */
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `${method} ${path} → ${res.status}: ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}`.trim(),
      );
    }
    return body;
  };
  return { call };
}

/**
 * Trigger (unless watching an existing doc), wait, and return the summary.
 * `log` receives progress lines; `sleep` is injectable for tests.
 * @param {Options} opts
 * @param {{ log?: (line: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number, fetch?: FetchLike }} [deps]
 * @returns {Promise<{ docId: string, status: string, summary: string | null }>}
 */
export async function run(opts, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  /** @param {number} ms */
  const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const client = createClient(opts, deps.fetch);
  const docsPath = `/projects/${encodeURIComponent(opts.project)}/docs`;

  /** @type {string | null} */
  let docId = opts.doc;
  if (!docId) {
    const created = await client.call("POST", `${docsPath}/generate`, {
      title: opts.title,
      scope: "full",
      docType: opts.docType,
      pathPrefixes: opts.paths,
    });
    const id = created?.data?.id;
    if (typeof id !== "string" || !id) throw new Error("generate returned no document id");
    docId = id;
    log(`Started scoped generation: doc ${docId} ("${created.data.title}")`);
  } else {
    log(`Watching doc ${docId}`);
  }
  if (!opts.wait) return { docId, status: "started", summary: null };

  const watchedId = docId;
  const started = now();
  let lastStatus = null;
  for (;;) {
    const { data } = await client.call("GET", `${docsPath}/${encodeURIComponent(watchedId)}`);
    if (data.status !== lastStatus) {
      log(`[${Math.round((now() - started) / 60000)} min] status: ${data.status}`);
      lastStatus = data.status;
    }
    if (!RUNNING.has(data.status)) {
      return { docId: watchedId, status: data.status, summary: summarizeDocument(data) };
    }
    if (now() - started > opts.maxMs) {
      return {
        docId: watchedId,
        status: "timeout",
        summary: `Stopped waiting after ${opts.maxMs / 3_600_000} h; doc ${watchedId} is still ${data.status}.`,
      };
    }
    await sleep(opts.pollMs);
  }
}

async function main() {
  let opts;
  try {
    opts = resolveOptions(parseArgs(process.argv.slice(2)), process.env);
  } catch (err) {
    console.error(`docs-gen-scoped-run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  try {
    const result = await run(opts);
    if (result.summary) console.log(`\n${result.summary}`);
    process.exit(["ready", "degraded", "started"].includes(result.status) ? 0 : 1);
  } catch (err) {
    console.error(`docs-gen-scoped-run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

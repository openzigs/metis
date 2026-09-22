/**
 * Prune a pnpm virtual store down to what the runtime can actually reach (#34).
 *
 * `Dockerfile.server`'s prod-deps stage runs `pnpm install --prod`, which still
 * installs every *runtime* dependency of the server — including `prisma`, the CLI,
 * which the image never runs (the client is generated at build time) but whose tree
 * (`@prisma/studio-core`, `@prisma/dev`, `@electric-sql/pglite`, react-dom ...) is
 * tens of megabytes. Deleting those by hand-maintained glob is how the image drifted
 * from ~329 MB to 1.3 GB: a glob that no longer matches fails silently.
 *
 * This walks the store as a graph instead. Roots are the symlinks in each importer's
 * `node_modules`; the edges of a store entry `.pnpm/<key>/node_modules/*` are its
 * sibling symlinks. Any edge whose package NAME is in `exclude` is never followed —
 * on every edge, not just at the importer, because `prisma` is also a peer of
 * `@prisma/client`. Every store entry not reached is deleted.
 *
 * Usage (inside the image build):
 *   node prune-pnpm-store.mjs --store /app/node_modules/.pnpm \
 *     --importer /app --importer /app/server --exclude prisma [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * List the symlinks in a `node_modules` directory as `[name, target]` pairs,
 * descending one level into `@scope/` directories. Plain directories (`.bin`,
 * `.pnpm`, a generated `.prisma`) are not edges.
 *
 * @param {string} dir
 * @returns {Array<[string, string]>}
 */
function listLinks(dir) {
  /** @type {Array<[string, string]>} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      out.push([e.name, full]);
    } else if (e.isDirectory() && e.name.startsWith("@")) {
      for (const [inner, innerFull] of listLinks(full)) out.push([`${e.name}/${inner}`, innerFull]);
    }
  }
  return out;
}

/**
 * The store entry key a path resolves into, or null when it resolves outside the
 * store (a workspace package) or not at all (an uninstalled optional dependency).
 *
 * @param {string} linkPath
 * @param {string} storeReal
 * @returns {string | null}
 */
function storeKeyOf(linkPath, storeReal) {
  let real;
  try {
    real = fs.realpathSync(linkPath);
  } catch {
    return null;
  }
  const rel = path.relative(storeReal, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const key = rel.split(path.sep)[0];
  return key === "node_modules" ? null : key;
}

/**
 * @param {object} opts
 * @param {string} opts.storeDir - the `.pnpm` directory
 * @param {string[]} opts.importerDirs - workspace dirs whose `node_modules` are roots
 * @param {string[]} [opts.exclude] - package names whose edges are never followed
 * @param {boolean} [opts.dryRun]
 * @returns {{ kept: string[], removed: string[] }}
 */
export function pruneUnreachable({ storeDir, importerDirs, exclude = [], dryRun = false }) {
  if (!fs.existsSync(storeDir)) throw new Error(`store directory not found: ${storeDir}`);
  const storeReal = fs.realpathSync(storeDir);
  const excluded = new Set(exclude);

  /** @type {Set<string>} */
  const reached = new Set();
  /** @type {string[]} */
  const queue = [];
  const visit = (/** @type {Array<[string, string]>} */ links) => {
    for (const [name, full] of links) {
      if (excluded.has(name)) continue;
      const key = storeKeyOf(full, storeReal);
      if (key != null && !reached.has(key)) {
        reached.add(key);
        queue.push(key);
      }
    }
  };

  for (const importer of importerDirs) visit(listLinks(path.join(importer, "node_modules")));
  while (queue.length > 0) {
    const key = /** @type {string} */ (queue.pop());
    visit(listLinks(path.join(storeReal, key, "node_modules")));
  }

  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const removed = [];
  for (const e of fs.readdirSync(storeReal, { withFileTypes: true })) {
    // `.pnpm/node_modules` is pnpm's hidden hoist dir; `lock.yaml` is metadata.
    if (!e.isDirectory() || e.name === "node_modules") continue;
    if (reached.has(e.name)) {
      kept.push(e.name);
    } else {
      removed.push(e.name);
      if (!dryRun) fs.rmSync(path.join(storeReal, e.name), { recursive: true, force: true });
    }
  }
  return { kept: kept.sort(), removed: removed.sort() };
}

/**
 * @param {string[]} argv
 * @returns {{ storeDir: string, importerDirs: string[], exclude: string[], dryRun: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let storeDir;
  /** @type {string[]} */
  const importerDirs = [];
  /** @type {string[]} */
  const exclude = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg !== "--store" && arg !== "--importer" && arg !== "--exclude") {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    i += 1;
    if (arg === "--store") storeDir = value;
    else if (arg === "--importer") importerDirs.push(value);
    else exclude.push(value);
  }
  if (storeDir == null) throw new Error("--store is required");
  return { storeDir, importerDirs, exclude, dryRun };
}

/**
 * @param {string[]} argv
 * @param {{ log?: (m: string) => void, err?: (m: string) => void }} [io]
 * @returns {number}
 */
export function runPrune(argv, io = {}) {
  /* c8 ignore next 2 — default console loggers; tests inject spies */
  const log = io.log ?? ((m) => console.log(m));
  const err = io.err ?? ((m) => console.error(m));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`prune-pnpm-store: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
  const { kept, removed } = pruneUnreachable(opts);
  for (const r of removed) log(`  - ${r}`);
  log(
    `prune-pnpm-store: ${opts.dryRun ? "would remove" : "removed"} ${removed.length} unreachable store entries; kept ${kept.length}`,
  );
  return 0;
}

/* c8 ignore start — CLI entrypoint, exercised by the Dockerfile.server build */
if (process.argv[1]?.endsWith("prune-pnpm-store.mjs")) {
  process.exit(runPrune(process.argv.slice(2)));
}
/* c8 ignore stop */

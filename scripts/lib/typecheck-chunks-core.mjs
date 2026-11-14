/**
 * #2503 — split one large `tsc -p` project into several smaller programs that, between
 * them, check the same files. Pure logic only; the I/O (parsing the tsconfig, running
 * each chunk in its own Node process, printing diagnostics) lives in
 * `scripts/typecheck-chunked.mjs`.
 *
 * Why: `server/tsconfig.test.json` grew past the 14 GB heap of a 16 GB hosted runner
 * (CI `api` > Typecheck, exit 134). The cost is steady growth, not one hot type: every
 * `tests/*.sqlite.test.ts` instantiates its own Prisma argument/payload types, about
 * 13 MB of checker state per file, and none of it is shared between files. One program
 * holds all of it at once; N programs each hold 1/N of it plus the shared base.
 *
 * The split:
 *  - every root file that is NOT a test file (library source, ambient `.d.ts`, test
 *    helpers, fixtures, scripts, vitest configs) goes into EVERY chunk. Ambient
 *    declarations and module augmentations (`src/types.d.ts`'s `Express.User`,
 *    `tests/helpers/sqlite-migrated-db.ts`'s `ProvidedContext`) only apply to the
 *    program that contains them, so a chunk without them would report false errors;
 *  - the test files are dealt round-robin over the chunks in sorted order, so each
 *    chunk gets an even share of the heavy `tests/` files and the light co-located ones;
 *  - the chunk count grows with the number of test files (`chunkSize`), so the
 *    per-chunk peak stays bounded as the suite grows instead of creeping back to the cap.
 *
 * Coverage: the union of the chunks' root files is exactly the original root set, and
 * every test file is in exactly one chunk (`planChunks` asserts both).
 */

/** A test file: `*.test.*` or `*.spec.*` with a TypeScript extension. */
export const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/;

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isTestFile(file) {
  return TEST_FILE.test(file);
}

/**
 * @param {number} testCount
 * @param {number} chunkSize  most test files per chunk
 * @returns {number}
 */
export function chunkCount(testCount, chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  return Math.max(1, Math.ceil(testCount / chunkSize));
}

/**
 * @typedef {{ shared: string[], chunks: string[][] }} ChunkPlan
 *   `shared` is in every chunk; `chunks[i]` holds chunk i's test files only.
 */

/**
 * @param {readonly string[]} rootNames  the project's root files (`ParsedCommandLine.fileNames`)
 * @param {number} chunkSize
 * @returns {ChunkPlan}
 */
export function planChunks(rootNames, chunkSize) {
  const unique = [...new Set(rootNames)].sort();
  const shared = unique.filter((f) => !isTestFile(f));
  const tests = unique.filter(isTestFile);
  const n = chunkCount(tests.length, chunkSize);
  /** @type {string[][]} */
  const chunks = Array.from({ length: n }, () => []);
  tests.forEach((f, i) => chunks[i % n].push(f));
  assertCovers(unique, { shared, chunks });
  return { shared, chunks };
}

/**
 * Root files of chunk `index`.
 * @param {ChunkPlan} plan
 * @param {number} index
 * @returns {string[]}
 */
export function chunkRoots(plan, index) {
  const tests = plan.chunks[index];
  if (!tests) throw new Error(`no chunk ${index}; the plan has ${plan.chunks.length}`);
  return [...plan.shared, ...tests];
}

/**
 * Throws unless the plan's root files are exactly `rootNames` and every test file is in
 * exactly one chunk. A split that dropped a file would pass silently otherwise.
 * @param {readonly string[]} rootNames
 * @param {ChunkPlan} plan
 */
export function assertCovers(rootNames, plan) {
  const expected = new Set(rootNames);
  const seen = new Map();
  for (const f of plan.shared) seen.set(f, (seen.get(f) ?? 0) + 1);
  for (const chunk of plan.chunks) for (const f of chunk) seen.set(f, (seen.get(f) ?? 0) + 1);
  const missing = [...expected].filter((f) => !seen.has(f));
  const extra = [...seen.keys()].filter((f) => !expected.has(f));
  const duplicated = [...seen].filter(([, c]) => c > 1).map(([f]) => f);
  if (missing.length || extra.length || duplicated.length) {
    throw new Error(
      `chunk plan does not cover the project exactly: missing ${JSON.stringify(missing)}, ` +
        `extra ${JSON.stringify(extra)}, duplicated ${JSON.stringify(duplicated)}`,
    );
  }
}

/**
 * @typedef {{ key: string, text: string, error: boolean }} ChunkDiagnostic
 *   `key` identifies the diagnostic across chunks (file, position, code, message), so a
 *   shared file's error — checked by every chunk — is printed once.
 */

/**
 * @param {readonly (readonly ChunkDiagnostic[])[]} perChunk
 * @returns {ChunkDiagnostic[]}
 */
export function mergeDiagnostics(perChunk) {
  const byKey = new Map();
  for (const list of perChunk) for (const d of list) if (!byKey.has(d.key)) byKey.set(d.key, d);
  return [...byKey.values()];
}

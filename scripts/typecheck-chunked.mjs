#!/usr/bin/env node
/**
 * #2503 — type-check one tsconfig as several smaller programs, one after another, each
 * in its own Node process with its own heap. See `lib/typecheck-chunks-core.mjs` for why
 * and for how the files are split.
 *
 *   node ../scripts/typecheck-chunked.mjs -p tsconfig.test.json [--chunk-size 400] [--heap 8192]
 *   node ../scripts/typecheck-chunked.mjs -p tsconfig.test.json --list-files
 *
 * Run from the package directory: `typescript` is resolved from there, so the package's
 * own compiler checks it. Exit 0 when no chunk reported an error, 1 on type errors, 2 when
 * a chunk could not run (out of memory, crash, bad arguments) — never 0 on a chunk that
 * did not finish.
 *
 * `--list-files` prints the union of every chunk's program files, one per line: the same
 * set `tsc -p <config> --listFilesOnly` prints, which is how the split is proved to
 * check what the single program did.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chunkRoots, mergeDiagnostics, planChunks } from "./lib/typecheck-chunks-core.mjs";

const SELF = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const args = {
    project: undefined,
    chunkSize: 400,
    heap: 8192,
    child: undefined,
    listFiles: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === "-p" || a === "--project") args.project = next();
    else if (a === "--chunk-size") args.chunkSize = Number(next());
    else if (a === "--heap") args.heap = Number(next());
    else if (a === "--child") args.child = Number(next());
    else if (a === "--list-files") args.listFiles = true;
    else fail(`unknown argument ${a}`);
  }
  if (!args.project) fail("-p <tsconfig> is required");
  if (!Number.isInteger(args.heap) || args.heap < 512)
    fail(`--heap must be an integer >= 512, got ${args.heap}`);
  return args;
}

function fail(message) {
  process.stderr.write(`typecheck-chunked: ${message}\n`);
  process.exit(2);
}

function loadTypeScript() {
  return createRequire(join(process.cwd(), "package.json"))("typescript");
}

function parseProject(ts, project) {
  const path = resolve(project);
  const { config, error } = ts.readConfigFile(path, ts.sys.readFile);
  if (error) fail(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config, ts.sys, resolve(path, ".."), undefined, path);
}

/** Child: build chunk `index`'s program and write its result as JSON to stdout. */
function runChild(args) {
  const ts = loadTypeScript();
  const parsed = parseProject(ts, args.project);
  let plan;
  try {
    plan = planChunks(parsed.fileNames, args.chunkSize);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const started = Date.now();
  const program = ts.createProgram({
    rootNames: chunkRoots(plan, args.child),
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
  });
  const host = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  };
  const result = {
    chunks: plan.chunks.length,
    roots: plan.shared.length + plan.chunks[args.child].length,
    tests: plan.chunks[args.child].length,
    files: [],
    diagnostics: [],
    ms: 0,
    heapUsedMB: 0,
    peakRssMB: 0,
  };
  if (args.listFiles) {
    result.files = program.getSourceFiles().map((f) => f.fileName);
  } else {
    result.diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ({
      key: [
        d.file?.fileName ?? "",
        d.start ?? "",
        d.code,
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ].join("\u0000"),
      text: ts.formatDiagnosticsWithColorAndContext([d], host),
      error: d.category === ts.DiagnosticCategory.Error,
    }));
  }
  result.ms = Date.now() - started;
  result.heapUsedMB = Math.round(process.memoryUsage().heapUsed / 2 ** 20);
  // `maxRSS` is in kilobytes.
  result.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  process.stdout.write(JSON.stringify(result));
}

function runChunk(args, index) {
  const childArgs = [
    `--max-old-space-size=${args.heap}`,
    SELF,
    "-p",
    args.project,
    "--chunk-size",
    String(args.chunkSize),
    "--child",
    String(index),
  ];
  if (args.listFiles) childArgs.push("--list-files");
  const res = spawnSync(process.execPath, childArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 2 ** 20,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (res.status !== 0 || res.error) {
    const why = res.error?.message ?? (res.signal ? `signal ${res.signal}` : `exit ${res.status}`);
    fail(`chunk ${index + 1} did not finish (${why}); its program was not checked`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    fail(`chunk ${index + 1} printed no result`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.child !== undefined) return runChild(args);

  const results = [runChunk(args, 0)];
  for (let i = 1; i < results[0].chunks; i++) results.push(runChunk(args, i));
  results.forEach((r, i) =>
    process.stderr.write(
      `typecheck-chunked: ${args.project} chunk ${i + 1}/${r.chunks}: ${r.roots} root files ` +
        `(${r.tests} tests), ${(r.ms / 1000).toFixed(1)} s, heap used ${r.heapUsedMB} MB, peak RSS ${r.peakRssMB} MB\n`,
    ),
  );

  if (args.listFiles) {
    const union = [...new Set(results.flatMap((r) => r.files))].sort();
    process.stdout.write(`${union.join("\n")}\n`);
    return;
  }
  const diagnostics = mergeDiagnostics(results.map((r) => r.diagnostics));
  for (const d of diagnostics) process.stdout.write(d.text);
  const errors = diagnostics.filter((d) => d.error).length;
  if (errors > 0) {
    process.stdout.write(`\nFound ${errors} error${errors === 1 ? "" : "s"}.\n`);
    process.exit(1);
  }
}

main();

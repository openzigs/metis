#!/usr/bin/env node
/**
 * Regenerate the Go oracle snapshot: what the Go TYPE CHECKER says every call
 * of the corpus under `server/tests/fixtures/go-oracle/` resolves to (#1071).
 *
 *   node scripts/gen-go-oracle-snapshot.mjs
 *
 * Needs a Go toolchain on PATH. Run it whenever the corpus changes — a drift
 * test fails until the snapshot's corpus hash matches again. Nothing in the
 * build, the tests or CI runs Go: the tests read the checked-in snapshot.
 *
 * Steps, each of which must succeed:
 *
 *   1. `gofmt -l` over the corpus prints nothing;
 *   2. `go vet ./...` is clean for every module of the corpus and for the
 *      GOPATH tree, on each platform the oracle type-checks for;
 *   3. `scripts/go-oracle-snapshot/main.go` (standard library only) type-checks
 *      the corpus and prints the answer for every call;
 *   4. the answers and the corpus hash are written to
 *      `server/tests/fixtures/go-oracle/oracle.snapshot.json`.
 *
 * No user input reaches a command: every one is a fixed argument vector, no
 * shell, and the Go commands run offline (`GOPROXY=off`, `GOTOOLCHAIN=local`).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repoRoot, "scripts", "go-oracle-snapshot", "main.go");
const fixture = path.join(repoRoot, "server", "tests", "fixtures", "go-oracle");
const snapshotPath = path.join(fixture, "oracle.snapshot.json");

/** Kept in step with the generator's `platforms`. */
const PLATFORMS = [
  ["linux", "amd64"],
  ["windows", "amd64"],
  ["darwin", "arm64"],
];

/** Every file under `dir`, as fixture-relative POSIX paths. */
function filesUnder(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push(path.relative(fixture, next).split(path.sep).join("/"));
    }
  };
  walk(path.join(fixture, dir));
  return out;
}

/**
 * The hash the drift test recomputes (`server/tests/helpers/go-oracle.ts` —
 * the two must stay identical): every corpus file by path and content, line
 * endings normalised.
 */
function corpusHash() {
  const files = ["trees.json", ...filesUnder("corpus"), ...filesUnder("thirdparty")].sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    const content = fs.readFileSync(path.join(fixture, rel), "utf8").replace(/\r\n/g, "\n");
    hash.update(`${rel}\u0000${content}\u0000`);
  }
  return hash.digest("hex");
}

const offline = {
  GOPROXY: "off",
  GOTOOLCHAIN: "local",
  GOWORK: "off",
  GOFLAGS: "",
  CGO_ENABLED: "0",
};

function go(args, cwd, env) {
  return execFileSync("go", args, {
    cwd,
    env: { ...process.env, ...offline, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const unformatted = execFileSync(
  "gofmt",
  ["-l", path.join(fixture, "corpus"), path.join(fixture, "thirdparty")],
  { encoding: "utf8" },
).trim();
if (unformatted) {
  console.error(`gofmt would change:\n${unformatted}`);
  process.exit(1);
}

const trees = JSON.parse(fs.readFileSync(path.join(fixture, "trees.json"), "utf8")).trees;
for (const tree of trees) {
  const root = path.join(fixture, tree.root);
  const units = [];
  if (tree.mode === "modules") {
    for (const rel of filesUnder(tree.root)) {
      if (path.posix.basename(rel) === "go.mod") {
        units.push({
          dir: path.join(fixture, path.posix.dirname(rel)),
          env: { GO111MODULE: "on" },
        });
      }
    }
  } else {
    const gopath = tree.gopath.map((p) => path.join(fixture, p)).join(path.delimiter);
    units.push({ dir: root, env: { GO111MODULE: "off", GOPATH: gopath } });
  }
  for (const unit of units) {
    for (const [GOOS, GOARCH] of PLATFORMS) {
      go(["vet", "./..."], unit.dir, { ...unit.env, GOOS, GOARCH });
    }
  }
}

const snap = JSON.parse(go(["run", generator, fixture], repoRoot, {}));
const lines = ["{"];
lines.push(` "corpusHash": ${JSON.stringify(corpusHash())},`);
lines.push(` "goVersion": ${JSON.stringify(snap.goVersion)},`);
lines.push(` "platforms": ${JSON.stringify(snap.platforms)},`);
lines.push(' "trees": [');
snap.trees.forEach((tree, t) => {
  lines.push("  {");
  lines.push(`   "name": ${JSON.stringify(tree.name)},`);
  lines.push(`   "root": ${JSON.stringify(tree.root)},`);
  lines.push('   "calls": [');
  tree.calls.forEach((call, i) => {
    // One call per line, so a change of the corpus is a readable diff.
    lines.push(`    ${JSON.stringify(call)}${i === tree.calls.length - 1 ? "" : ","}`);
  });
  lines.push("   ],");
  lines.push('   "symbols": [');
  tree.symbols.forEach((symbol, i) => {
    lines.push(`    ${JSON.stringify(symbol)}${i === tree.symbols.length - 1 ? "" : ","}`);
  });
  lines.push("   ]");
  lines.push(`  }${t === snap.trees.length - 1 ? "" : ","}`);
});
lines.push(" ]");
lines.push("}");
fs.writeFileSync(snapshotPath, `${lines.join("\n")}\n`);

const tally = {};
let total = 0;
for (const tree of snap.trees) {
  for (const call of tree.calls) {
    total += 1;
    tally[call.answer.k] = (tally[call.answer.k] ?? 0) + 1;
  }
}
console.log(
  `${snap.goVersion}: ${total} call sites in ${snap.trees.length} trees — ` +
    Object.keys(tally)
      .sort()
      .map((k) => `${k} ${tally[k]}`)
      .join(", "),
);

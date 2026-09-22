import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #34 and #3 — the image builds' WIRING, which no unit test of a helper can see.
 *
 * `prune-pnpm-store.test.ts` proves the pruner is correct; nothing there proves the
 * image actually runs it. `verify-image-size.test.ts` proves the gate's arithmetic;
 * nothing there proves CI builds the images in a way that caches. Both halves failed
 * silently before: a prune glob that stopped matching (`@github+copilot-linux-*` never
 * matched the musl build, 158 MB), and a cache that became an empty directory on a
 * fresh VM. So these assert the configuration itself.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(scriptsDir);
/** @param {string} rel */
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * The text of one top-level job in a workflow: from `  <name>:` to the next
 * two-space-indented key.
 *
 * @param {string} workflow
 * @param {string} job
 */
function jobBlock(workflow, job) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) throw new Error(`job ${job} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("Dockerfile.server runs the reachability prune (#34)", () => {
  const dockerfile = read("Dockerfile.server");

  it("copies the pruner from scripts/lib and runs it over the prod store", () => {
    expect(dockerfile).toMatch(/^COPY scripts\/lib\/prune-pnpm-store\.mjs /m);
    const run = dockerfile.slice(dockerfile.indexOf("RUN node /tmp/prune-pnpm-store.mjs"));
    expect(run).toMatch(/--store node_modules\/\.pnpm/);
    expect(run).toMatch(/--importer \/app\/server/);
  });

  it.each(["prisma", "typescript", "@github/copilot", "@github/copilot-sdk"])(
    "never follows an edge to %s",
    (name) => {
      const run = dockerfile.slice(dockerfile.indexOf("RUN node /tmp/prune-pnpm-store.mjs"));
      const cmd = run.slice(0, run.indexOf("\n\n"));
      expect(cmd.split(/\s+/).join(" ")).toContain(`--exclude ${name} `);
    },
  );

  it("runs the pruner in the prod-deps stage, before the runtime copies node_modules", () => {
    const prodDeps = dockerfile.indexOf("AS prod-deps");
    const runner = dockerfile.indexOf("AS runner");
    const prune = dockerfile.indexOf("RUN node /tmp/prune-pnpm-store.mjs");
    expect(prodDeps).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(prodDeps);
    expect(prune).toBeLessThan(runner);
  });

  it("is not hidden from the build context by .dockerignore", () => {
    const ignored = read(".dockerignore")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const pattern of ["scripts", "scripts/", "scripts/lib", "*.mjs"]) {
      expect(ignored).not.toContain(pattern);
    }
  });
});

describe("ci.yml `api` image builds cache across runs (#3)", () => {
  const api = jobBlock(read(".github/workflows/ci.yml"), "api");
  const builds = ["metis-server", "metis-ui", "metis-embeddings", "metis-sql-lineage"];

  it("no longer builds with a plain `docker build`, whose daemon cache dies with the VM", () => {
    expect(api).not.toMatch(/^\s*docker build\b/m);
  });

  it.each(builds)("%s reads and writes the gha cache under its own scope", (image) => {
    const step = api.slice(api.indexOf(`- name: Build ${image}\n`));
    const body = step.slice(0, step.indexOf("\n      - name:", 1));
    expect(body).toContain(`cache-from: type=gha,scope=${image}`);
    expect(body).toContain(`cache-to: type=gha,scope=${image},mode=max`);
    // The size gate inspects the image in the daemon, so it must be loaded there.
    expect(body).toContain("load: true");
    // #509 — an attestation index has no `.Size`; the gate would read "missing".
    expect(body).toContain("provenance: false");
  });

  it("frees runner disk before the first image build", () => {
    const free = api.indexOf("- name: Free runner disk for image builds");
    const firstBuild = api.indexOf("- name: Build metis-server");
    expect(free).toBeGreaterThan(-1);
    expect(free).toBeLessThan(firstBuild);
  });

  it("dropped the 90-minute stopgap timeout", () => {
    const m = api.match(/^ {4}timeout-minutes: (\d+)$/m);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeLessThan(90);
  });
});

describe("build-images.yml uses a cache that survives the runner (#3)", () => {
  const wf = read(".github/workflows/build-images.yml");

  it("has no local-path cache left", () => {
    expect(wf).not.toMatch(/type=local/);
  });

  it("every build step reads and writes the gha cache", () => {
    expect(
      wf.match(/cache-from: type=gha,scope=metis-\$\{\{ matrix\.image\.name \}\}/g),
    ).toHaveLength(2);
    expect(
      wf.match(/cache-to: type=gha,scope=metis-\$\{\{ matrix\.image\.name \}\},mode=max/g),
    ).toHaveLength(2);
  });
});

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

  it.each(["typescript", "@github/copilot", "@github/copilot-sdk"])(
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

describe("Dockerfile.server keeps what the server loads at boot (#39)", () => {
  const dockerfile = read("Dockerfile.server");
  const pkg = JSON.parse(read("server/package.json"));
  const prune = dockerfile.slice(dockerfile.indexOf("RUN node /tmp/prune-pnpm-store.mjs"));
  const pruneCmd = prune.slice(0, prune.indexOf("\n\n"));
  const rmLines = dockerfile
    .split("\n")
    .filter((l) => /node_modules\/\.pnpm\/[^ ]+@\*/.test(l))
    .join("\n");

  // The migration guard runs the Prisma CLI at every boot; excluding it from the
  // reachability walk deletes it, and the server refuses to start.
  it("does not prune the Prisma CLI the migration guard runs", () => {
    expect(pruneCmd.split(/\s+/).join(" ")).not.toContain("--exclude prisma ");
    expect(rmLines).not.toMatch(/\.pnpm\/prisma@\*/);
  });

  it.each(["@prisma+debug", "mysql2"])(
    "does not delete %s, which a runtime import needs",
    (name) => {
      expect(rmLines).not.toContain(`.pnpm/${name}@*`);
    },
  );

  it("ships the prisma config the CLI reads its schema and migration paths from", () => {
    expect(dockerfile).toMatch(/^COPY .*\/app\/server\/prisma\.config\.ts /m);
  });

  it("uses a glibc runtime base, because LanceDB ships no musl binding", () => {
    const runner = dockerfile.split("\n").find((l) => / AS runner$/.test(l));
    expect(runner).toBeDefined();
    expect(runner).not.toMatch(/alpine/);
  });

  it("puts the Oracle Instant Client on the loader path", () => {
    expect(dockerfile).toMatch(/\/opt\/oracle\/instantclient > \/etc\/ld\.so\.conf\.d\//);
    expect(dockerfile).toMatch(/ldconfig/);
  });

  it("gives the runtime user a home directory the server can write to", () => {
    const runner = dockerfile.slice(dockerfile.indexOf(" AS runner"));
    expect(runner).toMatch(/useradd[^\n]*(\\\n[^\n]*)*--create-home[^\n]*(\\\n[^\n]*)*metis$/m);
    expect(runner).not.toMatch(/--no-create-home/);
  });

  it("declares jszip as a runtime dependency, not a devDependency", () => {
    expect(pkg.dependencies.jszip).toBeDefined();
    expect(pkg.devDependencies.jszip).toBeUndefined();
  });
});

describe("ci.yml `api` starts the server image it built (#39)", () => {
  const api = jobBlock(read(".github/workflows/ci.yml"), "api");
  const smoke = api.indexOf("- name: Smoke-test metis-server");
  const body = api.slice(smoke, api.indexOf("\n      - name:", smoke + 1));

  it("has a smoke step that runs the smoke gate against this run's image", () => {
    expect(smoke).toBeGreaterThan(-1);
    expect(body).toMatch(
      /run: node scripts\/lib\/smoke-server-image\.mjs --image "metis-server:ci-\$\{\{ github\.run_id \}\}"/,
    );
  });

  it("runs after the server build and before the images are cleaned up", () => {
    expect(smoke).toBeGreaterThan(api.indexOf("- name: Build metis-server"));
    expect(smoke).toBeLessThan(api.indexOf("- name: Clean up test images"));
  });

  it("is not allowed to fail quietly", () => {
    expect(body).not.toMatch(/continue-on-error/);
    expect(body).not.toMatch(/\|\| true/);
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

  it("every build step reads the gha cache", () => {
    expect(
      wf.match(/cache-from: type=gha,scope=metis-\$\{\{ matrix\.image\.name \}\}/g),
    ).toHaveLength(2);
  });

  // A cache written from a tag ref can be restored only by that same tag, so a
  // tag-push `cache-to` spends the 10 GB repository cache limit on entries no
  // later run can read (review of #38, advisory A4).
  it("the tag-push build reads the cache but never writes it", () => {
    const start = wf.indexOf("- name: Build & push (tag");
    expect(start).toBeGreaterThan(-1);
    const next = wf.indexOf("- name:", start + 1);
    const tagStep = wf.slice(start, next === -1 ? undefined : next);
    expect(tagStep).toMatch(/cache-from: type=gha,scope=metis-/);
    expect(tagStep).not.toMatch(/^\s*cache-to:/m);
  });

  it("the native validation build still writes the gha cache", () => {
    expect(
      wf.match(/cache-to: type=gha,scope=metis-\$\{\{ matrix\.image\.name \}\},mode=max/g),
    ).toHaveLength(1);
  });
});

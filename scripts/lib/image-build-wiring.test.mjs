import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HELM_DEFAULT_WRITABLE_PATHS, HELM_RUN_AS } from "./smoke-server-image.mjs";

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

  // #150 — `@github/copilot` / `@github/copilot-sdk` were excluded here too until
  // they stopped being dependencies at all (no-copilot-dependency-repo.test.mjs).
  it.each(["typescript"])("never follows an edge to %s", (name) => {
    const run = dockerfile.slice(dockerfile.indexOf("RUN node /tmp/prune-pnpm-store.mjs"));
    const cmd = run.slice(0, run.indexOf("\n\n"));
    expect(cmd.split(/\s+/).join(" ")).toContain(`--exclude ${name} `);
  });

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

describe("Dockerfile.server serves both Prisma providers (#45)", () => {
  const dockerfile = read("Dockerfile.server");
  const prismaTs = read("server/src/lib/prisma.ts");
  const prodDeps = dockerfile.slice(
    dockerfile.indexOf("AS prod-deps"),
    dockerfile.indexOf("AS runner"),
  );
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));

  it("generates a Postgres client from the Postgres schema, then the SQLite one into @prisma/client", () => {
    const pg = prodDeps.indexOf("prisma generate --schema prisma/postgres/schema.prisma");
    const copy = prodDeps.indexOf('cp -R "${GENERATED}" server/prisma-clients/postgresql');
    const sqlite = prodDeps.indexOf("prisma generate \\\n", copy);
    expect(pg).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(pg);
    // The default (SQLite) generate runs LAST, so it is what @prisma/client holds.
    expect(sqlite).toBeGreaterThan(copy);
    expect(prodDeps).toContain(`grep -q '"activeProvider": "postgresql"'`);
    expect(prodDeps).toContain(`grep -q '"activeProvider": "sqlite"'`);
  });

  it("ships the Postgres client and points the server at it by the variable prisma.ts reads", () => {
    expect(runner).toMatch(
      /^COPY --from=prod-deps +\/app\/server\/prisma-clients \.\/server\/prisma-clients$/m,
    );
    const env = runner.match(/^ENV (METIS_PRISMA_CLIENT_POSTGRESQL)=(\S+)$/m);
    expect(env).not.toBeNull();
    expect(prismaTs).toContain(`POSTGRES_CLIENT_ENV = "${env?.[1]}"`);
    expect(env?.[2]).toBe("/app/server/prisma-clients/postgresql");
  });

  it("no longer claims production is Postgres-only while deleting compilers", () => {
    expect(dockerfile).not.toMatch(/production deployments use Postgres only/);
  });
});

describe("Dockerfile.server runs where its default data paths are writable (#54)", () => {
  const dockerfile = read("Dockerfile.server");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  const workdirs = [...runner.matchAll(/^WORKDIR (\S+)$/gm)].map((m) => m[1]);
  const cmd = runner.match(/^CMD \["node", "([^"]+)"\]$/m)?.[1];

  it("runs from /app/server, the directory the Helm chart mounts data volumes under", () => {
    expect(workdirs.at(-1)).toBe("/app/server");
    const values = read("deploy/helm/metis/values.yaml");
    expect(values).toContain(`mountPath: ${workdirs.at(-1)}/data/lancedb`);
    expect(values).toContain(`mountPath: ${workdirs.at(-1)}/data/uploads`);
  });

  it("starts the compiled server relative to that directory", () => {
    expect(cmd).toBe("dist/index.js");
    expect(runner).toMatch(/^COPY --from=builder .*\/app\/server\/dist +\.\/server\/dist$/m);
  });

  it("creates the data directory owned by the runtime user, before dropping to it", () => {
    const mk = runner.indexOf("mkdir -p /app/server/data && chown metis:metis /app/server/data");
    expect(mk).toBeGreaterThan(-1);
    expect(mk).toBeLessThan(runner.indexOf("USER metis"));
  });
});

describe("Dockerfile.server pins the Oracle Instant Client download (#51)", () => {
  const dockerfile = read("Dockerfile.server");
  const stage = dockerfile.slice(
    dockerfile.indexOf("AS oracle-client"),
    dockerfile.indexOf("AS runner"),
  );

  it("pairs every download URL with a SHA-256", () => {
    const urls = [...stage.matchAll(/OIC_URL="([^"]+)"/g)].map((m) => m[1]);
    const sums = [...stage.matchAll(/OIC_SHA256="([^"]*)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(sums).toHaveLength(urls.length);
    for (const sum of sums) expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(sums).size).toBe(sums.length);
  });

  it("verifies the zip after downloading it and before unpacking it", () => {
    const curl = stage.indexOf('curl -fsSL "$OIC_URL" -o /tmp/ic.zip');
    const check = stage.indexOf('echo "${OIC_SHA256}  /tmp/ic.zip" | sha256sum -c -');
    const unzip = stage.indexOf("unzip -q /tmp/ic.zip");
    expect(curl).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(curl);
    expect(unzip).toBeGreaterThan(check);
    // Chained with `&&`, so a mismatch fails the build instead of being ignored.
    expect(stage.slice(check, unzip + 5)).toMatch(/sha256sum -c - \\\n \&\& unzip$/);
  });
});

describe("the image's SQLite default is writable wherever the image runs (#60)", () => {
  const dockerfile = read("Dockerfile.server");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  const url = runner.match(/^ENV DATABASE_URL=(\S+)$/m)?.[1];

  it("puts the SQLite file inside the runtime user's data directory, not on the root filesystem", () => {
    expect(url).toMatch(/^file:\/app\/server\/data\/[^/]+\.db$/);
    expect(runner).toContain("mkdir -p /app/server/data && chown metis:metis /app/server/data");
  });

  it("is a directory the Helm chart's default values mount a writable volume at", () => {
    const dir = url?.replace(/^file:/, "").replace(/\/[^/]+$/, "");
    expect(HELM_DEFAULT_WRITABLE_PATHS).toContain(dir);
  });
});

describe("the smoke's helm-default arm matches the Helm chart (#60)", () => {
  const tpl = read("deploy/helm/metis/templates/_components.tpl");
  const values = read("deploy/helm/metis/values.yaml");
  const helpers = read("deploy/helm/metis/templates/_helpers.tpl");
  const persistence = values.slice(values.indexOf("\npersistence:\n"));

  /** @param {string} key */
  const valuesMountPath = (key) => {
    const block = persistence.slice(persistence.indexOf(`\n  ${key}:\n`));
    return block.match(/\n {4}mountPath: (\S+)/)?.[1];
  };

  it("writes to exactly the paths the chart mounts for the server container", () => {
    const mounts = tpl.slice(tpl.indexOf("volumeMounts:"), tpl.indexOf("      volumes:"));
    const paths = [...mounts.matchAll(/mountPath: (.+)$/gm)].map((m) => {
      const v = m[1].trim();
      const ref = v.match(/\.Values\.persistence\.(\w+)\.mountPath/);
      return ref ? valuesMountPath(ref[1]) : v;
    });
    expect(paths.every(Boolean)).toBe(true);
    expect([...new Set(paths)].sort()).toEqual([...HELM_DEFAULT_WRITABLE_PATHS].sort());
  });

  it("runs as the chart's user and group, with a read-only root filesystem", () => {
    const [uid, gid] = HELM_RUN_AS.split(":");
    expect(helpers).toContain(`runAsUser: ${uid}`);
    expect(helpers).toContain(`runAsGroup: ${gid}`);
    expect(helpers).toContain("readOnlyRootFilesystem: true");
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

  it("runs every arm, not just SQLite (#45, #60)", () => {
    expect(body).not.toMatch(/--(database|arm)\b/);
  });
});

describe("ci.yml `api` builds and smokes the server image for Dependabot PRs too (#51)", () => {
  const api = jobBlock(read(".github/workflows/ci.yml"), "api");
  /** @param {string} name */
  const step = (name) => {
    const at = api.indexOf(`- name: ${name}`);
    expect(at, name).toBeGreaterThan(-1);
    return api.slice(at, api.indexOf("\n      - name:", at + 1));
  };
  const skipsDependabot = /if:.*dependabot\//;

  it.each([
    "Free runner disk for image builds",
    "Set up Buildx",
    "Build metis-server",
    "Smoke-test metis-server",
  ])("%s runs on Dependabot PRs", (name) => {
    expect(step(name)).not.toMatch(skipsDependabot);
  });

  it.each(["Build metis-ui", "Build metis-embeddings", "Build metis-sql-lineage"])(
    "%s still skips Dependabot PRs (the heaviest CI cost, and no dependency bump boots them)",
    (name) => {
      expect(step(name)).toMatch(skipsDependabot);
    },
  );
});

describe("docker-compose.prod.yml sets its production storage explicitly (#60)", () => {
  const prod = read("docker-compose.prod.yml");
  const server = prod.slice(prod.indexOf("\n  server:\n"), prod.indexOf("\n  embeddings:\n"));

  it("pins the vector store instead of inheriting the base file's JSON store", () => {
    const vs = server.match(/^ {6}VECTOR_STORE: (.+)$/m)?.[1];
    expect(vs).toBeDefined();
    expect(vs).not.toMatch(/local/);
  });

  it("keeps the server's data directory on a named volume", () => {
    expect(server).toMatch(/^ {6}- [a-z_]+:\/app\/server\/data$/m);
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
    // #51 — the server build also runs for Dependabot PRs, whose token usually
    // cannot write the Actions cache; without `ignore-error` BuildKit fails the
    // step and every Dependabot PR goes red.
    if (image === "metis-server") {
      expect(body).toContain(`cache-to: type=gha,scope=${image},mode=max,ignore-error=true`);
    }
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

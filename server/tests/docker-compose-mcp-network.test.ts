/**
 * Issue #361 (Epic #359) — structural assertions on docker-compose.yml +
 * docker-compose.prod.yml. We don't run `docker compose up`; we just parse
 * the YAML and verify the metis-mcp bridge network is declared with an
 * explicit name so server-spawned wrapper containers can attach by the
 * bare name `metis-mcp`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readCompose(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
}

describe("docker-compose.yml — Issue #361 metis-mcp network wiring", () => {
  it("declares a top-level networks: metis-mcp block with explicit name", () => {
    const dev = readCompose("docker-compose.yml");
    expect(dev).toMatch(/^networks:/m);
    expect(dev).toMatch(/metis-mcp:/);
    // Explicit name avoids the docker compose <project>_metis-mcp prefix.
    expect(dev).toMatch(/name:\s*metis-mcp/);
    expect(dev).toMatch(/driver:\s*bridge/);
  });

  it("does NOT attach the core services to metis-mcp (only wrapper containers do)", () => {
    const dev = readCompose("docker-compose.yml");
    // Each service block should attach to `metis`, not `metis-mcp`. We
    // assert the latter doesn't appear inside any `networks:` list under a
    // service block — a coarse-but-sufficient check.
    const serviceBlock = dev.split(/^volumes:/m)[0]; // everything before volumes
    const lines = serviceBlock.split("\n");
    let inServiceNetworksList = false;
    for (const line of lines) {
      if (/^\s{4}networks:/.test(line)) {
        inServiceNetworksList = true;
        continue;
      }
      if (inServiceNetworksList && /^\s{0,4}\S/.test(line)) {
        // Indentation popped out of the per-service `networks:` list.
        inServiceNetworksList = false;
      }
      if (inServiceNetworksList) {
        expect(line).not.toMatch(/-\s*metis-mcp\s*$/);
      }
    }
  });

  it("wires the dev server container for docker-stdio sibling starts", () => {
    const dev = readCompose("docker-compose.yml");
    expect(dev).toMatch(/DOCKER_HOST:\s*unix:\/\/\/var\/run\/docker\.sock/);
    expect(dev).toMatch(/DOCKER_API_VERSION:\s*\$\{DOCKER_API_VERSION:-1\.41\}/);
    expect(dev).toMatch(/user:\s*root/);
    expect(dev).toMatch(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  });
});

describe("Dockerfile.server.dev — docker-stdio CLI support", () => {
  it("installs the Docker CLI in the dev server image only", () => {
    const devDockerfile = readCompose("Dockerfile.server.dev");
    expect(devDockerfile).toMatch(/apk add --no-cache[^\n]*docker-cli/);
    const prodDockerfile = readCompose("Dockerfile.server");
    expect(prodDockerfile).not.toMatch(/docker-cli/);
  });
});

describe("docker-compose.prod.yml — Issue #361 metis-mcp network wiring", () => {
  it("declares the same metis-mcp network with explicit name", () => {
    const prod = readCompose("docker-compose.prod.yml");
    expect(prod).toMatch(/^networks:/m);
    expect(prod).toMatch(/metis-mcp:/);
    expect(prod).toMatch(/name:\s*metis-mcp/);
    expect(prod).toMatch(/driver:\s*bridge/);
  });
});

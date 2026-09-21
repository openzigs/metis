/**
 * Epic #271 / Issue #282 — wrapper image build smoke tests.
 *
 * These tests exist to verify the Dockerfiles are syntactically valid and
 * can be built. They are gated on `MCP_WRAPPER_BUILD_TESTS=1` because they
 * require a working docker daemon and pull large base images. CI without
 * docker (e.g. the GHE runners that block image registries) will skip.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const WRAPPERS_DIR = resolve(REPO_ROOT, "images", "mcp-wrappers");
const WRAPPERS = ["uvx-runner", "jbang-runner", "node-runner", "npx-runner"] as const;
const SSE_WRAPPERS = [
  "uvx-runner-sse",
  "jbang-runner-sse",
  "node-runner-sse",
  "npx-runner-sse",
] as const;

describe("wrapper image catalog (#282)", () => {
  it("publishes a VERSION file", () => {
    const versionFile = resolve(WRAPPERS_DIR, "VERSION");
    expect(existsSync(versionFile)).toBe(true);
    const content = readFileSync(versionFile, "utf8").trim();
    expect(content).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ships build.sh", () => {
    expect(existsSync(resolve(WRAPPERS_DIR, "build.sh"))).toBe(true);
  });

  it.each(WRAPPERS)("ships a Dockerfile for %s", (wrapper) => {
    const path = resolve(WRAPPERS_DIR, wrapper, "Dockerfile");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    // Every wrapper must drop privileges.
    expect(content).toMatch(/^USER\s+1000:1000\s*$/m);
    // Every wrapper must declare an ENTRYPOINT.
    expect(content).toMatch(/^ENTRYPOINT\s+\[/m);
  });

  // Sub-issue #286 — SSE-exposing wrapper variants.
  it.each(SSE_WRAPPERS)("ships an SSE wrapper Dockerfile for %s", (wrapper) => {
    const path = resolve(WRAPPERS_DIR, wrapper, "Dockerfile");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    // SSE variants must EXPOSE port 8080.
    expect(content).toMatch(/^EXPOSE\s+8080\s*$/m);
    // Bridge MUST go through mcp-proxy on :8080.
    expect(content).toMatch(/mcp-proxy/);
    // Drop privileges in the final stage.
    expect(content).toMatch(/^USER\s+1000:1000\s*$/m);
    // Healthcheck against /healthz.
    expect(content).toMatch(/HEALTHCHECK[\s\S]*\/healthz/);
  });
});

const buildTestsEnabled = process.env.MCP_WRAPPER_BUILD_TESTS === "1";
describe.skipIf(!buildTestsEnabled)("wrapper docker build (gated)", () => {
  it.each(WRAPPERS)(
    "builds %s without errors",
    (wrapper) => {
      const dir = resolve(WRAPPERS_DIR, wrapper);
      // `--target` not used; the Dockerfiles are single-stage. The `--pull` flag
      // is intentionally omitted to avoid hammering the upstream registry on
      // every test run — the daemon's local cache is fine for smoke tests.
      expect(() => {
        execSync(`docker build --quiet --tag metis-mcp-${wrapper}:smoke ${dir}`, {
          stdio: "pipe",
        });
      }).not.toThrow();
    },
    600_000,
  );
});

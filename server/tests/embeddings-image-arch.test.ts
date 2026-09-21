/**
 * Issue #786 — the sidecar image must stay glibc, and must stay multi-arch.
 *
 * `onnxruntime-node` ships PREBUILT native bindings and NO musl build. Verified
 * against the installed package (v1.21.0): it carries
 * `bin/napi-v3/linux/{x64,arm64}/`, both linking `GLIBC_2.17`, and its
 * package.json declares no `libc` field — so npm/pnpm will happily INSTALL it on
 * Alpine and it will only explode at `require()` time, inside the pod, at boot.
 *
 * Two facts therefore have to be kept true by tests rather than by memory:
 *
 *   1. `Dockerfile.embeddings` never moves to an Alpine/musl base. This is an
 *      IMAGE property, not a scheduling one — a container brings its own libc,
 *      so no Kubernetes node label can save an Alpine-based image. The chart
 *      cannot defend this; only this guard can.
 *
 *   2. The image really is published for both architectures it is allowed to be
 *      scheduled on. The chart's `nodeAffinity` (values.yaml → embeddings) lets
 *      the sidecar land on amd64 OR arm64 (Graviton) nodes, and that permission
 *      is only safe while `build-images.yml` actually pushes both. If the arm64
 *      platform is ever dropped from the release build, this test fails —
 *      instead of an operator discovering it as `exec format error` on a
 *      Graviton node pool.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const DOCKERFILE = resolve(REPO_ROOT, "Dockerfile.embeddings");
const WORKFLOW = resolve(REPO_ROOT, ".github/workflows/build-images.yml");
const VALUES = resolve(REPO_ROOT, "deploy/helm/metis/values.yaml");

const dockerfile = readFileSync(DOCKERFILE, "utf8");
const workflow = readFileSync(WORKFLOW, "utf8");
const values = readFileSync(VALUES, "utf8");

/** Every `FROM <image>` in the Dockerfile. */
function baseImages(source: string): string[] {
  return [...source.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
}

describe("Dockerfile.embeddings — glibc only, never Alpine (#786)", () => {
  it("every stage builds on a glibc base", () => {
    const froms = baseImages(dockerfile);
    expect(froms.length).toBeGreaterThan(0);
    for (const image of froms) {
      // Named stages (`AS builder` → `FROM node:20-bookworm-slim AS runner`) all
      // resolve to a node:*-bookworm-slim base here.
      expect(image).toContain("bookworm");
    }
  });

  it("no stage is Alpine/musl — onnxruntime-node has no musl build", () => {
    expect(dockerfile.toLowerCase()).not.toMatch(/^from\s+\S*alpine/im);
    for (const image of baseImages(dockerfile)) {
      expect(image.toLowerCase()).not.toContain("alpine");
      expect(image.toLowerCase()).not.toContain("musl");
    }
  });

  it("says WHY, so the next person to shrink the image does not silently break it", () => {
    expect(dockerfile).toMatch(/musl/i);
  });
});

describe("build-images.yml — the sidecar is really published multi-arch (#786)", () => {
  it("builds metis-embeddings-svc from Dockerfile.embeddings", () => {
    expect(workflow).toContain("{ name: embeddings-svc, dockerfile: Dockerfile.embeddings }");
  });

  it("the release (tag) build publishes linux/amd64 AND linux/arm64", () => {
    // The chart's arch affinity permits both; that is only honest while this line
    // holds. PR-time validation is native-arch-only by design (QEMU segfaults on
    // the UI build) — the PUBLISH path is what an EKS node pull actually gets.
    const publish = workflow.slice(workflow.indexOf("Build & push (tag — multi-arch publish)"));
    expect(publish).toContain("platforms: linux/amd64,linux/arm64");
    expect(publish).toContain("push: true");
  });
});

describe("chart — the sidecar cannot be scheduled onto an unsupported arch (#786)", () => {
  it("pins the embeddings pod to linux, and to arches onnxruntime-node ships", () => {
    const embeddings = values.slice(values.indexOf("\nembeddings:"), values.indexOf("\ncopilot:"));
    expect(embeddings).toContain("kubernetes.io/arch");
    expect(embeddings).toContain("amd64");
    expect(embeddings).toContain("arm64");
    expect(embeddings).toContain("kubernetes.io/os");
  });
});

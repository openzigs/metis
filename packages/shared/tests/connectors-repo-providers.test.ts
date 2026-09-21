/**
 * Issue #288 — repo connector zod schema: provider-conditional fields.
 *
 * Proves: github still requires owner/repo; local requires localPath and makes
 * owner/repo optional; upload requires neither owner/repo nor localPath.
 */
import { describe, expect, it } from "vitest";
import {
  createRepoConnectorSchema,
  REPO_PROVIDERS,
  REPO_PROVIDER_LOCAL,
  REPO_PROVIDER_UPLOAD,
} from "../src/index.js";

describe("REPO_PROVIDERS", () => {
  it("includes local + upload (issue #288)", () => {
    expect(REPO_PROVIDERS).toContain("local");
    expect(REPO_PROVIDERS).toContain("upload");
    // github behaviour unchanged — still present.
    expect(REPO_PROVIDERS).toContain("github");
  });
});

describe("createRepoConnectorSchema", () => {
  it("github (default provider) still REQUIRES owner + repo", () => {
    const ok = createRepoConnectorSchema.safeParse({
      label: "main",
      ownerOrOrg: "octocat",
      repoName: "demo",
    });
    expect(ok.success).toBe(true);

    const missing = createRepoConnectorSchema.safeParse({ label: "main" });
    expect(missing.success).toBe(false);
  });

  it("local requires localPath; owner/repo optional", () => {
    const ok = createRepoConnectorSchema.safeParse({
      label: "mounted",
      provider: REPO_PROVIDER_LOCAL,
      localPath: "/srv/code",
    });
    expect(ok.success).toBe(true);

    const noPath = createRepoConnectorSchema.safeParse({
      label: "mounted",
      provider: REPO_PROVIDER_LOCAL,
    });
    expect(noPath.success).toBe(false);
  });

  it("upload requires neither owner/repo nor localPath", () => {
    const ok = createRepoConnectorSchema.safeParse({
      label: "dropzone",
      provider: REPO_PROVIDER_UPLOAD,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a localPath containing a NUL byte", () => {
    const bad = createRepoConnectorSchema.safeParse({
      label: "mounted",
      provider: REPO_PROVIDER_LOCAL,
      localPath: "/srv/code\0/etc",
    });
    expect(bad.success).toBe(false);
  });
});

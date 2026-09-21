/**
 * Tests for dev-file-classifier.ts — Epic #701 / Issue #702.
 */
import { describe, expect, it } from "vitest";
import { classifyDevFile } from "../src/lib/connectors/repo/dev-file-classifier.js";

describe("classifyDevFile", () => {
  describe("dev-pattern filenames", () => {
    it.each([
      "docker-compose.yml",
      "docker-compose.yaml",
      "docker-compose.override.yml",
      "docker-compose.dev.yml",
      "application-dev.properties",
      "application-dev.yml",
      "application-local.yml",
      "application-test.yml",
      ".env.local",
      ".env.development",
      ".env.dev",
      ".env.test",
    ])("classifies '%s' as a dev file", (name) => {
      expect(classifyDevFile(name).isDevFile).toBe(true);
    });

    it("matches dev filenames in nested directories", () => {
      expect(classifyDevFile("config/docker-compose.yml").isDevFile).toBe(true);
      expect(classifyDevFile("src/main/resources/application-dev.properties").isDevFile).toBe(true);
    });

    it("matches case-insensitively on the basename", () => {
      expect(classifyDevFile("Docker-Compose.YML").isDevFile).toBe(true);
      expect(classifyDevFile(".ENV.LOCAL").isDevFile).toBe(true);
    });
  });

  describe("prod-pattern filenames are excluded", () => {
    it.each([
      "application-prod.properties",
      "application-prod.yml",
      "application-production.yml",
      ".env.production",
      ".env.prod",
      "docker-compose.prod.yml",
      "docker-compose.production.yml",
    ])("rejects '%s' as a dev file", (name) => {
      const r = classifyDevFile(name);
      expect(r.isDevFile).toBe(false);
      expect(r.reason).toMatch(/production/i);
    });

    it("rejects prod files even when nested under a dev-named directory", () => {
      // Production filename always wins — directory hints don't matter.
      expect(classifyDevFile("dev/application-prod.yml").isDevFile).toBe(false);
    });
  });

  describe("path-segment heuristic", () => {
    it.each([
      "src/test/resources/datasource.properties",
      "config/dev/database.yml",
      "config/local/db.properties",
      "src/development/db.config",
    ])("classifies dev-segment path '%s' as dev", (p) => {
      expect(classifyDevFile(p).isDevFile).toBe(true);
    });

    it("does NOT classify prod-segment paths as dev", () => {
      expect(classifyDevFile("config/production/db.properties").isDevFile).toBe(false);
      expect(classifyDevFile("deployments/prod/database.yml").isDevFile).toBe(false);
    });

    it("rejects paths that contain both dev AND prod markers (prod wins)", () => {
      expect(classifyDevFile("config/dev-to-prod/db.yml").isDevFile).toBe(false);
    });

    // SECURITY: staging is intentionally NOT a dev marker. Staging
    // environments routinely share prod credentials, so we refuse to
    // surface them through the dev-credential affordance.
    it.each([
      ".env.staging",
      "application-staging.properties",
      "application-staging.yml",
      "config/staging/db.yml",
      "deployments/staging/connection.env",
    ])("rejects staging-pattern '%s' as dev", (p) => {
      expect(classifyDevFile(p).isDevFile).toBe(false);
    });
  });

  describe("ambiguous filenames (safe default)", () => {
    it.each([
      "application.properties",
      "application.yml",
      ".env",
      "config.json",
      "database.yml",
      "src/main/resources/application.properties",
    ])("returns isDevFile=false for ambiguous '%s'", (p) => {
      const r = classifyDevFile(p);
      expect(r.isDevFile).toBe(false);
      expect(r.reason).toBe("no dev marker");
    });
  });

  it("handles Windows-style path separators", () => {
    expect(classifyDevFile("src\\test\\resources\\db.yml").isDevFile).toBe(true);
    expect(classifyDevFile("config\\production\\db.yml").isDevFile).toBe(false);
  });
});

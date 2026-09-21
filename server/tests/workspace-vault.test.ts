/**
 * Tests for workspace vault namespace helpers (Epic #759, Issue #762).
 */
import { describe, it, expect } from "vitest";
import {
  workspaceVaultLabel,
  parseWorkspaceVaultLabel,
  isWorkspaceSecret,
  filterSecretsForWorkspace,
} from "../src/lib/vault/workspace-vault.js";

describe("workspace vault namespace", () => {
  describe("workspaceVaultLabel", () => {
    it("creates prefixed label", () => {
      expect(workspaceVaultLabel("ws-1", "github-token")).toBe("ws:ws-1:github-token");
    });

    it("handles empty workspace id gracefully", () => {
      expect(workspaceVaultLabel("", "key")).toBe("ws::key");
    });
  });

  describe("parseWorkspaceVaultLabel", () => {
    it("parses a valid workspace label", () => {
      const result = parseWorkspaceVaultLabel("ws:ws-123:my-secret");
      expect(result).toEqual({ workspaceId: "ws-123", key: "my-secret" });
    });

    it("handles colons in the key portion", () => {
      const result = parseWorkspaceVaultLabel("ws:ws-1:a:b:c");
      expect(result).toEqual({ workspaceId: "ws-1", key: "a:b:c" });
    });

    it("returns null for non-workspace labels", () => {
      expect(parseWorkspaceVaultLabel("github-token")).toBeNull();
      expect(parseWorkspaceVaultLabel("global:key")).toBeNull();
    });
  });

  describe("isWorkspaceSecret", () => {
    it("returns true for matching workspace", () => {
      expect(isWorkspaceSecret("ws:ws-1:token", "ws-1")).toBe(true);
    });

    it("returns false for different workspace", () => {
      expect(isWorkspaceSecret("ws:ws-2:token", "ws-1")).toBe(false);
    });

    it("returns false for non-workspace labels", () => {
      expect(isWorkspaceSecret("global-secret", "ws-1")).toBe(false);
    });
  });

  describe("filterSecretsForWorkspace", () => {
    const secrets = [
      { label: "ws:ws-1:token-a" },
      { label: "ws:ws-1:token-b" },
      { label: "ws:ws-2:other" },
      { label: "global-key" },
    ];

    it("returns workspace secrets plus globals", () => {
      const filtered = filterSecretsForWorkspace(secrets, "ws-1");
      expect(filtered).toHaveLength(3);
      expect(filtered.map((s) => s.label)).toContain("ws:ws-1:token-a");
      expect(filtered.map((s) => s.label)).toContain("ws:ws-1:token-b");
      expect(filtered.map((s) => s.label)).toContain("global-key");
    });

    it("excludes other workspace secrets", () => {
      const filtered = filterSecretsForWorkspace(secrets, "ws-1");
      expect(filtered.map((s) => s.label)).not.toContain("ws:ws-2:other");
    });
  });
});

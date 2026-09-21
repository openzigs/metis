/**
 * Epic #272 / Sub-issue #291 — ServiceAccount + IRSA helper unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildServiceAccount,
  composeRoleArn,
} from "../src/lib/mcp/provisioners/service-account.js";

describe("composeRoleArn", () => {
  it("preserves a prefix with no trailing dash", () => {
    expect(composeRoleArn("arn:aws:iam::123:role/metis-mcp", "abc123")).toBe(
      "arn:aws:iam::123:role/metis-mcp-abc123",
    );
  });

  it("strips a single trailing dash from the prefix", () => {
    expect(composeRoleArn("arn:aws:iam::123:role/metis-mcp-", "abc123")).toBe(
      "arn:aws:iam::123:role/metis-mcp-abc123",
    );
  });

  it("sanitises server id to [a-zA-Z0-9_-]", () => {
    expect(composeRoleArn("p", "ab/c.123!")).toBe("p-abc123");
  });

  it("slices server id to 32 chars to stay under IAM's 64-char limit", () => {
    const long = "x".repeat(64);
    const out = composeRoleArn("p", long);
    expect(out.endsWith("-" + "x".repeat(32))).toBe(true);
  });
});

describe("buildServiceAccount", () => {
  it("annotates the SA with the IRSA role ARN", () => {
    const sa = buildServiceAccount({
      serverId: "abc",
      resourceName: "mcp-deadbeef",
      namespace: "metis-mcp",
      roleArn: "arn:aws:iam::123:role/metis-mcp-abc",
    });
    expect(sa.kind).toBe("ServiceAccount");
    expect(sa.metadata?.name).toBe("mcp-deadbeef");
    expect(sa.metadata?.namespace).toBe("metis-mcp");
    expect(sa.metadata?.annotations?.["eks.amazonaws.com/role-arn"]).toBe(
      "arn:aws:iam::123:role/metis-mcp-abc",
    );
    expect(sa.metadata?.labels?.["metis.io/server-id"]).toBe("abc");
    expect(sa.metadata?.labels?.["metis.io/managed-by"]).toBe("mcp-provisioner");
    expect(sa.automountServiceAccountToken).toBe(true);
  });
});

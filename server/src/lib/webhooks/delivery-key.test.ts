import { describe, expect, it } from "vitest";
import { deliveryDedupKey } from "./delivery-key.js";

describe("#1506 deliveryDedupKey", () => {
  it("scopes the id by receiver and signer", () => {
    expect(deliveryDedupKey("github-pr", { kind: "deployment" }, "g")).toBe(
      "github-pr:deployment:g",
    );
    expect(deliveryDedupKey("github-pr", { kind: "connector", connectorId: "c1" }, "g")).toBe(
      "github-pr:c:c1:g",
    );
    expect(deliveryDedupKey("github-issues", { kind: "connector", connectorId: "c1" }, "g")).toBe(
      "github-issues:c:c1:g",
    );
    expect(deliveryDedupKey("jira-issues", { kind: "deployment" }, "j")).toBe(
      "jira-issues:deployment:j",
    );
  });

  it("trims the id, and an empty id stays empty (never recorded)", () => {
    expect(deliveryDedupKey("github-pr", { kind: "deployment" }, "  g  ")).toBe(
      "github-pr:deployment:g",
    );
    expect(deliveryDedupKey("github-pr", { kind: "deployment" }, "   ")).toBe("");
  });

  it("never gives a connector named 'deployment' the deployment's key", () => {
    expect(
      deliveryDedupKey("github-pr", { kind: "connector", connectorId: "deployment" }, "g"),
    ).not.toBe(deliveryDedupKey("github-pr", { kind: "deployment" }, "g"));
  });
});

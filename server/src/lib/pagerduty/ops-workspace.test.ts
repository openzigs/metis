import { afterEach, describe, expect, it } from "vitest";

import { opsWorkspaceId } from "./ops-workspace.js";

describe("opsWorkspaceId", () => {
  const original = process.env.PAGERDUTY_OPS_WORKSPACE_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.PAGERDUTY_OPS_WORKSPACE_ID;
    else process.env.PAGERDUTY_OPS_WORKSPACE_ID = original;
  });

  it("returns the trimmed env value when set", () => {
    process.env.PAGERDUTY_OPS_WORKSPACE_ID = "  ws-ops  ";
    expect(opsWorkspaceId()).toBe("ws-ops");
  });

  it("returns null when unset", () => {
    delete process.env.PAGERDUTY_OPS_WORKSPACE_ID;
    expect(opsWorkspaceId()).toBeNull();
  });

  it("returns null when blank", () => {
    process.env.PAGERDUTY_OPS_WORKSPACE_ID = "   ";
    expect(opsWorkspaceId()).toBeNull();
  });
});

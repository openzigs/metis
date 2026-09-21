import { describe, expect, it } from "vitest";

import { hashCase, hashRunInput, canonicaliseCase } from "../../../src/lib/testcoverage/hash.js";

const tc = {
  externalId: "TC-1",
  title: "Login",
  preconditions: "User exists",
  steps: [{ action: "Open app" }, { action: "Type creds", expected: "Form valid" }],
  expected: "Dashboard",
  priority: "medium" as const,
  tags: ["smoke", "auth"],
  source: "csv" as const,
};

describe("testcoverage/hash", () => {
  it("canonicaliseCase produces sorted-key JSON", () => {
    const json = canonicaliseCase(tc);
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe("Login");
    expect(parsed.tags).toEqual(["auth", "smoke"]);
  });

  it("hashCase is deterministic and order-insensitive on tags", () => {
    const h1 = hashCase(tc);
    const h2 = hashCase({ ...tc, tags: ["auth", "smoke"] });
    expect(h1).toBe(h2);
  });

  it("hashCase differs when steps change", () => {
    const h1 = hashCase(tc);
    const h2 = hashCase({ ...tc, steps: [...tc.steps, { action: "Logout" }] });
    expect(h1).not.toBe(h2);
  });

  it("hashRunInput is order-independent across the input set", () => {
    expect(hashRunInput(["a", "b", "c"])).toBe(hashRunInput(["c", "a", "b"]));
  });
});

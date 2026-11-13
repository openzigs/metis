import { describe, expect, it } from "vitest";
import { canChangeSelfApproval, hasPermission, ROLE_KEYS } from "./rbac.js";

describe("canChangeSelfApproval (#2453)", () => {
  it("lets only an admin change the self-approval setting", () => {
    const allowed = ROLE_KEYS.filter((role) => canChangeSelfApproval(role));
    expect(allowed).toEqual(["admin"]);
  });

  it("refuses a coordinator even though it holds review.admin", () => {
    expect(hasPermission("coordinator", "review.admin")).toBe(true);
    expect(canChangeSelfApproval("coordinator")).toBe(false);
  });

  it("refuses developer and reader", () => {
    expect(canChangeSelfApproval("developer")).toBe(false);
    expect(canChangeSelfApproval("reader")).toBe(false);
  });
});

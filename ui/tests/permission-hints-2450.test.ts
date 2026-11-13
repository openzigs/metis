import { describe, expect, it } from "vitest";
import { defaultRolesHolding, START_CHANGE_REQUEST_HINT } from "@/lib/permission-hints";
import { APPROVE_HINT } from "@/components/requirements/requirements-list";

describe("defaultRolesHolding (#2450 review)", () => {
  it("lists the default roles holding a permission, least privileged first", () => {
    expect(defaultRolesHolding("analysis.run")).toBe("developer, coordinator or admin");
    expect(defaultRolesHolding("requirement.approve")).toBe("coordinator or admin");
    expect(defaultRolesHolding("vault.reveal")).toBe("admin");
  });

  it("feeds the hints that name roles, so their text is unchanged", () => {
    expect(START_CHANGE_REQUEST_HINT).toBe(
      "Starting a change request needs the analysis.run permission (developer, coordinator or admin by default). You can still read this project's change requests.",
    );
    expect(APPROVE_HINT).toBe(
      "Approving needs the requirement.approve permission (coordinator or admin by default). You can still request a review.",
    );
  });
});

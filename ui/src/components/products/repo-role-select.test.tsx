/**
 * #2114 — every Role the Add repository form offers is one the API accepts.
 * The options are checked against `addProductRepoSchema`, the validator the
 * server's POST /products/:id/repos route parses the body with.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PRODUCT_REPO_ROLES, addProductRepoSchema } from "@metis/shared";
import { RepoRoleSelect, repoRoleLabel } from "./repo-role-select";

function offeredRoles(): string[] {
  render(<RepoRoleSelect id="repo-role" value="backend-api" onChange={() => {}} />);
  return screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
}

describe("RepoRoleSelect (#2114)", () => {
  it("offers only roles the API's add-repo validator accepts", () => {
    const roles = offeredRoles();
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const parsed = addProductRepoSchema.safeParse({ repoConnectionId: "r1111111111", role });
      expect(parsed.success, `role "${role}" is rejected by the API`).toBe(true);
    }
  });

  it("offers every role the API accepts, in its order", () => {
    expect(offeredRoles()).toEqual([...PRODUCT_REPO_ROLES]);
  });

  it("shows a readable label for each role", () => {
    render(<RepoRoleSelect id="repo-role" value="shared-lib" onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Backend API" })).toHaveValue("backend-api");
    expect(screen.getByRole("option", { name: "Shared library" })).toHaveValue("shared-lib");
    for (const option of screen.getAllByRole("option")) {
      expect(option.textContent).not.toBe((option as HTMLOptionElement).value);
    }
    expect(screen.getByRole("combobox")).toHaveValue("shared-lib");
  });

  it("reports the chosen role", () => {
    const onChange = vi.fn();
    render(<RepoRoleSelect id="repo-role" value="backend-api" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gateway" } });
    expect(onChange).toHaveBeenCalledWith("gateway");
  });
});

describe("repoRoleLabel (#2114)", () => {
  it("labels a known role", () => {
    expect(repoRoleLabel("microservice")).toBe("Microservice");
  });

  it("shows a value outside the list as stored", () => {
    expect(repoRoleLabel("worker")).toBe("worker");
  });
});

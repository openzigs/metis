/**
 * Behavioural tests for ProjectCreateForm (#426).
 *
 * Covers the binding acceptance criteria:
 *  - submit is disabled while required fields (Name/Slug) are empty/invalid,
 *  - an empty Name shows an inline error on submit (never a silent no-op),
 *  - a valid form calls the API and clears + reports success,
 *  - a structured server validation error renders inline per field,
 *  - the repo-pair "both or neither" rule blocks submit + shows its message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectCreateForm } from "@/components/projects/project-create-form";
import { ApiError } from "@/lib/api-client";
import { makeWrapper } from "./test-utils";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { create: vi.fn() },
}));

import { projectsApi } from "@/lib/projects-api";
import { toast } from "sonner";

const create = projectsApi.create as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  create.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

function renderForm(onCreated?: (...args: unknown[]) => void) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <ProjectCreateForm onCreated={onCreated as never} />
    </Wrapper>,
  );
}

describe("ProjectCreateForm", () => {
  it("disables submit while required fields are empty", () => {
    renderForm();
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
  });

  // WCAG SC 1.3.5 (#659): project metadata is NOT information about the user.
  // Name, Slug and the repo owner/name fields must correctly OMIT autocomplete
  // so a browser never autofills identity data into project config. ("Owner /
  // Org" is the source-repo owner, not the user's organization.)
  it("omits autocomplete on project-metadata inputs (not user info) (#659)", async () => {
    const user = userEvent.setup();
    renderForm();
    expect(screen.getByTestId("project-name-input")).not.toHaveAttribute("autocomplete");
    expect(screen.getByTestId("project-slug-input")).not.toHaveAttribute("autocomplete");
    await user.click(screen.getByTestId("toggle-repo-section"));
    expect(screen.getByTestId("repo-owner-input")).not.toHaveAttribute("autocomplete");
    expect(screen.getByTestId("repo-name-input")).not.toHaveAttribute("autocomplete");
  });

  it("keeps submit disabled with a Name but no Slug", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
  });

  it("enables submit once Name and Slug are filled", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    expect(screen.getByTestId("project-create-submit")).toBeEnabled();
  });

  // SC 3.3.3 (#663): a malformed slug (detectable cause) suggests the normalized
  // value and blocks submit, instead of only rejecting it as required/invalid.
  it("suggests a normalized slug for a malformed value and blocks submit (#663)", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "My Project");
    await user.type(screen.getByTestId("project-slug-input"), "my project");
    const form = screen.getByTestId("project-create-form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(screen.getByText(/try “my-project”/i)).toBeInTheDocument());
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });

  it("shows an inline Name-required error and does NOT call the API on empty-Name submit", async () => {
    const user = userEvent.setup();
    renderForm();
    // Fill slug only, then submit via the form (button is disabled, so dispatch).
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    const form = screen.getByTestId("project-create-form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(screen.getByText(/Name is required/i)).toBeInTheDocument());
    expect(create).not.toHaveBeenCalled();
  });

  it("shows an inline error on Name blur when left empty", async () => {
    const user = userEvent.setup();
    renderForm();
    const name = screen.getByTestId("project-name-input");
    await user.click(name);
    await user.tab();
    await waitFor(() => expect(screen.getByText(/Name is required/i)).toBeInTheDocument());
  });

  it("submits a valid form, calls the API, and reports success", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    create.mockResolvedValueOnce({ id: "p1", name: "Acme", slug: "acme" });
    renderForm(onCreated);
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme", slug: "acme" })),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Project created");
  });

  it("maps a structured server validation error onto the matching field inline", async () => {
    const user = userEvent.setup();
    create.mockRejectedValueOnce(
      new ApiError(400, "Slug is required", "VALIDATION_ERROR", {
        fields: [{ field: "slug", message: "slug is already taken" }],
      }),
    );
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(screen.getByText(/slug is already taken/i)).toBeInTheDocument());
  });

  it("shows a top-level alert for a non-field server error", async () => {
    const user = userEvent.setup();
    create.mockRejectedValueOnce(new ApiError(500, "boom", "INTERNAL_ERROR"));
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(screen.getByText(/Failed to create project/i)).toBeInTheDocument());
  });

  it("clears a server field error once the user edits that field", async () => {
    const user = userEvent.setup();
    create.mockRejectedValueOnce(
      new ApiError(400, "x", "VALIDATION_ERROR", {
        fields: [{ field: "name", message: "name already exists" }],
      }),
    );
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(screen.getByText(/name already exists/i)).toBeInTheDocument());
    await user.type(screen.getByTestId("project-name-input"), "2");
    await waitFor(() => expect(screen.queryByText(/name already exists/i)).not.toBeInTheDocument());
  });

  it("blocks submit and shows the repo-pair message when only Owner is set", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    await user.click(screen.getByTestId("toggle-repo-section"));
    await user.type(screen.getByTestId("repo-owner-input"), "acme-corp");
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
    expect(screen.getByText(/Both Owner and Repository are required/i)).toBeInTheDocument();
  });

  it("includes the primary repo in the payload when both repo fields are set", async () => {
    const user = userEvent.setup();
    create.mockResolvedValueOnce({ id: "p1", name: "Acme", slug: "acme" });
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.type(screen.getByTestId("project-slug-input"), "acme");
    await user.click(screen.getByTestId("toggle-repo-section"));
    await user.type(screen.getByTestId("repo-owner-input"), "acme-corp");
    await user.type(screen.getByTestId("repo-name-input"), "my-app");
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryRepo: expect.objectContaining({ ownerOrOrg: "acme-corp", repoName: "my-app" }),
        }),
      ),
    );
  });
});

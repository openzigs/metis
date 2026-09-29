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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  // #23 — Create used to stay disabled, silently, until Slug was typed by hand.
  it("derives the Slug from the Name and enables submit (#23)", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "  My Cool Project! ");
    expect(screen.getByTestId("project-slug-input")).toHaveValue("my-cool-project");
    expect(screen.getByTestId("project-create-submit")).toBeEnabled();
  });

  it("stops deriving once the Slug is edited by hand, and resumes when it is cleared (#23)", async () => {
    const user = userEvent.setup();
    renderForm();
    const name = screen.getByTestId("project-name-input");
    const slug = screen.getByTestId("project-slug-input");
    await user.type(name, "Acme");
    await user.clear(slug);
    await user.type(slug, "custom");
    await user.type(name, " Labs");
    expect(slug).toHaveValue("custom");
    await user.clear(slug);
    await user.type(name, "!");
    expect(slug).toHaveValue("acme-labs");
  });

  // PR #367 panel — the test above cannot tell "clearing resumes derivation"
  // from "the blur refill filled it": typing into Name blurs Slug first. Change
  // the Name WITHOUT moving focus, so only the onChange hand-back can refill it.
  it("hands a cleared Slug back to the Name before any blur (#23)", async () => {
    const user = userEvent.setup();
    renderForm();
    const name = screen.getByTestId("project-name-input");
    const slug = screen.getByTestId("project-slug-input");
    await user.type(name, "Acme");
    await user.clear(slug);
    await user.type(slug, "custom");
    await user.clear(slug);
    expect(slug).toHaveFocus();
    fireEvent.change(name, { target: { value: "Acme Labs Two" } });
    expect(slug).toHaveFocus();
    expect(slug).toHaveValue("acme-labs-two");
  });

  // #23 review — clearing the Slug used to leave it empty ("Slug is required")
  // until the Name changed. It refills from the current Name once focus leaves.
  it("refills a cleared Slug from the current Name on blur (#23)", async () => {
    const user = userEvent.setup();
    renderForm();
    const slug = screen.getByTestId("project-slug-input");
    await user.type(screen.getByTestId("project-name-input"), "Acme Labs");
    await user.clear(slug);
    await user.type(slug, "custom");
    await user.clear(slug);
    // Still focused: an emptied field is left for the user to type into.
    expect(slug).toHaveValue("");
    await user.tab();
    expect(slug).toHaveValue("acme-labs");
    expect(screen.getByTestId("project-create-submit")).toBeEnabled();
  });

  // #23 review — a Name may be 128 characters but a slug only 64
  // (packages/shared/src/project.ts), so the derived slug is capped.
  it("caps the derived Slug at the schema's 64 characters (#23)", async () => {
    const user = userEvent.setup();
    renderForm();
    // 63 × "a", then a space: an uncapped cut at 64 would end in a hyphen.
    await user.type(
      screen.getByTestId("project-name-input"),
      `${"a".repeat(63)} ${"b".repeat(40)}`,
    );
    const value = (screen.getByTestId("project-slug-input") as HTMLInputElement).value;
    expect(value).toBe("a".repeat(63));
    expect(screen.getByTestId("project-create-submit")).toBeEnabled();
    await user.clear(screen.getByTestId("project-name-input"));
    await user.type(screen.getByTestId("project-name-input"), "c".repeat(100));
    expect(screen.getByTestId("project-slug-input")).toHaveValue("c".repeat(64));
  });

  it("explains why Create is disabled when the Name yields no Slug (#23)", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "!!!");
    expect(screen.getByTestId("project-slug-input")).toHaveValue("");
    expect(screen.getByTestId("project-create-submit")).toBeDisabled();
    // No blur / submit needed: the reason is shown as soon as it applies.
    expect(screen.getByText(/Slug is required/i)).toBeInTheDocument();
  });

  it("describes the Slug field so the derivation is discoverable (#23)", () => {
    renderForm();
    const slug = screen.getByTestId("project-slug-input");
    expect(slug).toHaveAccessibleDescription(/filled in from the name/i);
  });

  it("logs no duplicate-key warning when the repo section is expanded and typed into (#23)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = userEvent.setup();
      renderForm();
      await user.click(screen.getByTestId("toggle-repo-section"));
      await user.type(screen.getByTestId("repo-owner-input"), "acme");
      const dupes = spy.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("same key")),
      );
      expect(dupes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("resets to deriving after a successful create", async () => {
    const user = userEvent.setup();
    create.mockResolvedValueOnce({ id: "p1", name: "Acme", slug: "x" });
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
    await user.clear(screen.getByTestId("project-slug-input"));
    await user.type(screen.getByTestId("project-slug-input"), "x");
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(screen.getByTestId("project-name-input")).toHaveValue(""));
    await user.type(screen.getByTestId("project-name-input"), "Beta");
    expect(screen.getByTestId("project-slug-input")).toHaveValue("beta");
  });

  // SC 3.3.3 (#663): a malformed slug (detectable cause) suggests the normalized
  // value and blocks submit, instead of only rejecting it as required/invalid.
  it("suggests a normalized slug for a malformed value and blocks submit (#663)", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "My Project");
    await user.clear(screen.getByTestId("project-slug-input"));
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
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(screen.getByText(/slug is already taken/i)).toBeInTheDocument());
  });

  it("shows a top-level alert for a non-field server error", async () => {
    const user = userEvent.setup();
    create.mockRejectedValueOnce(new ApiError(500, "boom", "INTERNAL_ERROR"));
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
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
    await user.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(screen.getByText(/name already exists/i)).toBeInTheDocument());
    await user.type(screen.getByTestId("project-name-input"), "2");
    await waitFor(() => expect(screen.queryByText(/name already exists/i)).not.toBeInTheDocument());
  });

  it("blocks submit and shows the repo-pair message when only Owner is set", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByTestId("project-name-input"), "Acme");
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

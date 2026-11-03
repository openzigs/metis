/**
 * #1617 — "Start Spec Kit feature" on the requirements list.
 *
 *   - disabled, with the reason as a tooltip, while the selection holds a
 *     requirement that is not approved (and while nothing is selected);
 *   - on success, opens the new feature on the Spec Kit page;
 *   - a 422 (or 404) from the server lists the requirement ids it named.
 *
 * That the opened feature's spec lists every selected title is asserted on the
 * Spec Kit page's rendered content in `spec-kit-page.test.tsx` (#1617 block),
 * and on the written `spec.md` by the server suite (#1616).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({
      push: routerPush,
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
  };
});

const startFeature = vi.hoisted(() => vi.fn());
vi.mock("@/lib/spec-kit-api", () => ({
  specKitApi: { startFeatureFromRequirements: startFeature },
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { ApiError } from "@/lib/api-client";
import {
  StartSpecKitFeatureAction,
  refusedRequirementIds,
  startSpecKitFeatureBlocker,
  type SpecKitSeedCandidate,
} from "@/components/requirements/start-spec-kit-feature";

const APPROVED_A: SpecKitSeedCandidate = { id: "req-a", title: "Login", reviewStatus: "approved" };
const APPROVED_B: SpecKitSeedCandidate = { id: "req-b", title: "Logout", reviewStatus: "approved" };
const DRAFT: SpecKitSeedCandidate = { id: "req-d", title: "Signup", reviewStatus: "draft" };

function renderAction(selected: SpecKitSeedCandidate[], writeHint?: string) {
  return render(
    <StartSpecKitFeatureAction projectId="p1" selected={selected} writeHint={writeHint} />,
    { wrapper: makeWrapper({ withAuth: false }) },
  );
}

const button = () => screen.getByTestId("start-spec-kit-feature-button");
/** The tooltip lives on the HoverHint wrapper, since a disabled button gets no hover. */
const tooltip = () => button().closest("[data-hover-hint]")?.getAttribute("title") ?? null;

beforeEach(() => {
  routerPush.mockReset();
  startFeature.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("StartSpecKitFeatureAction (#1617)", () => {
  it("is disabled with an explanatory tooltip when the selection holds a non-approved requirement", () => {
    renderAction([APPROVED_A, DRAFT]);
    expect(button()).toBeDisabled();
    expect(tooltip()).toBe(
      'Only approved requirements can start a Spec Kit feature. Not approved: "Signup".',
    );
    fireEvent.click(button());
    expect(startFeature).not.toHaveBeenCalled();
  });

  it("is disabled, saying what to do, with nothing selected", () => {
    renderAction([]);
    expect(button()).toBeDisabled();
    expect(tooltip()).toMatch(/Select one or more approved requirements/);
  });

  it("carries the page's write hint for a viewer who cannot write", () => {
    renderAction([APPROVED_A], "Requires project.update");
    expect(button()).toBeDisabled();
    expect(tooltip()).toBe("Requires project.update");
  });

  it("sends the approved selection and opens the new feature on the Spec Kit page", async () => {
    startFeature.mockResolvedValue({
      feature: { id: "f9", slug: "004-login-1-more", title: "Login (+1 more)" },
      artifact: { key: "spec.md" },
      message: "Generated spec.md (v1) for 004-login-1-more",
      requirementIds: ["req-a", "req-b"],
      jobId: "j1",
    });
    renderAction([APPROVED_A, APPROVED_B]);
    expect(button()).toBeEnabled();
    expect(tooltip()).toBeNull();
    fireEvent.click(button());
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/projects/p1/spec-kit?feature=004-login-1-more"),
    );
    expect(startFeature).toHaveBeenCalledWith("p1", ["req-a", "req-b"]);
    expect(toastSuccess).toHaveBeenCalledWith("Generated spec.md (v1) for 004-login-1-more");
  });

  it("renders the requirement ids a 422 names", async () => {
    startFeature.mockRejectedValue(
      new ApiError(422, "Not approved: req-b", "SPECKIT_REQUIREMENTS_NOT_APPROVED", {
        requirementIds: ["req-b", "req-zz"],
      }),
    );
    renderAction([APPROVED_A, APPROVED_B]);
    fireEvent.click(button());
    const list = await screen.findByTestId("start-spec-kit-refused-ids");
    expect(list).toHaveTextContent("req-b — Logout");
    expect(list).toHaveTextContent("req-zz");
    expect(list).not.toHaveTextContent("req-a");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only approved requirements can start a Spec Kit feature",
    );
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("names the ids of a 404 as not in this project", async () => {
    startFeature.mockRejectedValue(
      new ApiError(404, "not found", "SPECKIT_REQUIREMENTS_NOT_FOUND", {
        requirementIds: ["req-a"],
      }),
    );
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "These requirements are not in this project:",
    );
    expect(screen.getByTestId("start-spec-kit-refused-ids")).toHaveTextContent("req-a — Login");
  });

  it("says Spec Kit is off rather than quoting the API", async () => {
    startFeature.mockRejectedValue(new ApiError(409, "PUT /enabled", "SPEC_KIT_DISABLED"));
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Spec Kit is off for this project");
    expect(alert).not.toHaveTextContent("PUT /enabled");
    expect(screen.queryByTestId("start-spec-kit-refused-ids")).not.toBeInTheDocument();
  });
});

describe("startSpecKitFeatureBlocker / refusedRequirementIds", () => {
  it("allows only an approved, non-empty selection", () => {
    expect(startSpecKitFeatureBlocker([APPROVED_A])).toBeUndefined();
    expect(startSpecKitFeatureBlocker([{ ...APPROVED_A, reviewStatus: null }])).toMatch(
      /Not approved: "Login"/,
    );
  });

  it("refuses more ids than the server accepts", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...APPROVED_A, id: `r${i}` }));
    expect(startSpecKitFeatureBlocker(many)).toBe("Select at most 100 requirements.");
  });

  it("reads ids only from a refusal that names them", () => {
    expect(refusedRequirementIds(new Error("x"))).toBeNull();
    expect(refusedRequirementIds(new ApiError(500, "x", "OTHER", { requirementIds: ["a"] }))).toBe(
      null,
    );
    expect(
      refusedRequirementIds(
        new ApiError(422, "x", "SPECKIT_REQUIREMENTS_NOT_APPROVED", { requirementIds: ["a", 3] }),
      ),
    ).toEqual(["a"]);
  });
});

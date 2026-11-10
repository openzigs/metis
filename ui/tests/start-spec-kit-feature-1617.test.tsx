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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
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
const getEnabled = vi.hoisted(() => vi.fn());
vi.mock("@/lib/spec-kit-api", () => ({
  specKitApi: { startFeatureFromRequirements: startFeature, getEnabled },
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import {
  SPEC_KIT_OFF_REASON,
  StartSpecKitFeatureAction,
  refusedRequirementIds,
  startSpecKitFeatureBlocker,
  type SpecKitSeedCandidate,
} from "@/components/requirements/start-spec-kit-feature";

const APPROVED_A: SpecKitSeedCandidate = { id: "req-a", title: "Login", reviewStatus: "approved" };
const APPROVED_B: SpecKitSeedCandidate = { id: "req-b", title: "Logout", reviewStatus: "approved" };
const DRAFT: SpecKitSeedCandidate = { id: "req-d", title: "Signup", reviewStatus: "draft" };

function renderAction(
  selected: SpecKitSeedCandidate[],
  writeHint?: string,
  queryClient?: QueryClient,
) {
  return render(
    <StartSpecKitFeatureAction projectId="p1" selected={selected} writeHint={writeHint} />,
    { wrapper: makeWrapper({ withAuth: false, ...(queryClient ? { queryClient } : {}) }) },
  );
}

const STARTED = {
  feature: { id: "f9", slug: "004-login", title: "Login" },
  artifact: { key: "spec.md" },
  message: "Generated spec.md (v1) for 004-login",
  requirementIds: ["req-a"],
  jobId: "j1",
};
/** The start token the n-th call sent (0-based). */
const tokenOf = (n: number): string => startFeature.mock.calls[n]![2] as string;

const button = () => screen.getByTestId("start-spec-kit-feature-button");
/** The tooltip lives on the HoverHint wrapper, since a disabled button gets no hover. */
const tooltip = () => button().closest("[data-hover-hint]")?.getAttribute("title") ?? null;

beforeEach(() => {
  routerPush.mockReset();
  startFeature.mockReset();
  getEnabled.mockReset();
  getEnabled.mockResolvedValue({ enabled: true });
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
    expect(startFeature).toHaveBeenCalledWith("p1", ["req-a", "req-b"], expect.any(String));
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
    // #1749 — and links to the page that turns it on.
    expect(within(alert).getByRole("link", { name: "Open the Spec Kit page" })).toHaveAttribute(
      "href",
      "/projects/p1/spec-kit",
    );
  });

  it("does not link to the Spec Kit page on any other failure", async () => {
    startFeature.mockRejectedValue(new ApiError(500, "boom", "INTERNAL"));
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("link")).not.toBeInTheDocument();
  });
});

// #1749 — the action said Spec Kit was off only through a 409 after the click.
describe("StartSpecKitFeatureAction — Spec Kit off (#1749)", () => {
  it("is disabled with the reason, and links to the Spec Kit page, while Spec Kit is off", async () => {
    getEnabled.mockResolvedValue({ enabled: false });
    renderAction([APPROVED_A]);
    const off = await screen.findByTestId("start-spec-kit-off");
    expect(
      within(off).getByRole("link", { name: "Turn it on from the Spec Kit page" }),
    ).toHaveAttribute("href", "/projects/p1/spec-kit");
    expect(button()).toBeDisabled();
    expect(tooltip()).toBe(SPEC_KIT_OFF_REASON);
    fireEvent.click(button());
    expect(startFeature).not.toHaveBeenCalled();
    expect(getEnabled).toHaveBeenCalledWith("p1");
  });

  it("stays enabled when Spec Kit is on", async () => {
    renderAction([APPROVED_A]);
    await waitFor(() => expect(getEnabled).toHaveBeenCalled());
    expect(button()).toBeEnabled();
    expect(screen.queryByTestId("start-spec-kit-off")).not.toBeInTheDocument();
  });

  it("blocks nothing when whether Spec Kit is on cannot be read (the server still checks)", async () => {
    getEnabled.mockRejectedValue(new ApiError(500, "boom", "INTERNAL"));
    renderAction([APPROVED_A]);
    await waitFor(() => expect(getEnabled).toHaveBeenCalled());
    expect(button()).toBeEnabled();
  });

  it("keeps the write hint first for a viewer who cannot write", async () => {
    getEnabled.mockResolvedValue({ enabled: false });
    renderAction([APPROVED_A], "Requires project.update");
    await waitFor(() => expect(getEnabled).toHaveBeenCalled());
    expect(tooltip()).toBe("Requires project.update");
    expect(screen.queryByTestId("start-spec-kit-off")).not.toBeInTheDocument();
  });

  it("ranks Spec Kit off before the selection in the blocker", () => {
    expect(startSpecKitFeatureBlocker([], undefined, true)).toBe(SPEC_KIT_OFF_REASON);
    expect(startSpecKitFeatureBlocker([APPROVED_A], undefined, false)).toBeUndefined();
  });
});

describe("StartSpecKitFeatureAction — retry-safe start (#1702)", () => {
  it("sends a start token the server accepts (16–128 of A-Z a-z 0-9 _ -)", async () => {
    startFeature.mockResolvedValue(STARTED);
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    await waitFor(() => expect(startFeature).toHaveBeenCalledTimes(1));
    expect(tokenOf(0)).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("after a lost response, the retry of the same selection sends the SAME token", async () => {
    startFeature.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    startFeature.mockResolvedValueOnce(STARTED);
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The response was lost, so the feature may already have been created",
    );
    fireEvent.click(button());
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/projects/p1/spec-kit?feature=004-login"),
    );
    expect(startFeature).toHaveBeenCalledTimes(2);
    expect(tokenOf(1)).toBe(tokenOf(0));
  });

  it("a proxy's 5xx without the server's envelope is a lost response too", async () => {
    startFeature.mockRejectedValueOnce(new ApiError(504, "Gateway Timeout"));
    startFeature.mockResolvedValueOnce(STARTED);
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    await screen.findByRole("alert");
    fireEvent.click(button());
    await waitFor(() => expect(startFeature).toHaveBeenCalledTimes(2));
    expect(tokenOf(1)).toBe(tokenOf(0));
  });

  it("an answer from the server ends the start: the next one gets a new token", async () => {
    startFeature.mockRejectedValueOnce(new ApiError(503, "no provider", "AI_UNAVAILABLE"));
    startFeature.mockResolvedValueOnce(STARTED);
    startFeature.mockResolvedValueOnce(STARTED);
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    await screen.findByRole("alert");
    fireEvent.click(button());
    await waitFor(() => expect(startFeature).toHaveBeenCalledTimes(2));
    expect(tokenOf(1)).not.toBe(tokenOf(0));
    // After a success too.
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    await waitFor(() => expect(startFeature).toHaveBeenCalledTimes(3));
    expect(tokenOf(2)).not.toBe(tokenOf(1));
  });

  it("a different selection after a lost response is a new start, with a new token", async () => {
    startFeature.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    startFeature.mockResolvedValueOnce(STARTED);
    const view = renderAction([APPROVED_A]);
    fireEvent.click(button());
    await screen.findByRole("alert");
    view.rerender(<StartSpecKitFeatureAction projectId="p1" selected={[APPROVED_A, APPROVED_B]} />);
    fireEvent.click(button());
    await waitFor(() => expect(startFeature).toHaveBeenCalledTimes(2));
    expect(startFeature.mock.calls[1]![1]).toEqual(["req-a", "req-b"]);
    expect(tokenOf(1)).not.toBe(tokenOf(0));
  });

  it("clears the previous failure as soon as a new start begins", async () => {
    startFeature.mockRejectedValueOnce(new ApiError(409, "PUT /enabled", "SPEC_KIT_DISABLED"));
    startFeature.mockImplementationOnce(() => new Promise(() => {}));
    renderAction([APPROVED_A]);
    fireEvent.click(button());
    await screen.findByRole("alert");
    fireEvent.click(button());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(button()).toHaveTextContent("Starting Spec Kit feature…");
  });

  it("does not move a user who left the page while the feature was being made", async () => {
    let finish!: (v: typeof STARTED) => void;
    startFeature.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderAction([APPROVED_A]);
    fireEvent.click(button());
    await waitFor(() => expect(startFeature).toHaveBeenCalledTimes(1));
    view.unmount();
    finish(STARTED);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("refreshes the project's Spec Kit feature list on success", async () => {
    startFeature.mockResolvedValue(STARTED);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderAction([APPROVED_A], undefined, qc);
    fireEvent.click(button());
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.projects.specKitFeaturesAll("p1"),
      }),
    );
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

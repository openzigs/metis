/** #1171 — the cross-project refusal helpers and dialog. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import {
  CrossProjectConfirmDialog,
  extractCrossProjectRefusal,
  otherProjectsLabel,
} from "@/components/publishing/cross-project-confirm-dialog";

describe("extractCrossProjectRefusal", () => {
  it("is null for anything but a REPO_CROSS_PROJECT ApiError", () => {
    expect(extractCrossProjectRefusal(null)).toBeNull();
    expect(extractCrossProjectRefusal(new Error("x"))).toBeNull();
    expect(extractCrossProjectRefusal(new ApiError(409, "x", "APPROVAL_REQUIRED"))).toBeNull();
  });

  it("reads the repo and the nameable projects", () => {
    const err = new ApiError(409, "m", "REPO_CROSS_PROJECT", {
      repo: "o/r",
      projects: ["A", "", 7, "B"],
    });
    expect(extractCrossProjectRefusal(err)).toEqual({ repo: "o/r", projects: ["A", "B"] });
  });

  it("tolerates missing details", () => {
    expect(extractCrossProjectRefusal(new ApiError(409, "m", "REPO_CROSS_PROJECT"))).toEqual({
      repo: "",
      projects: [],
    });
  });
});

describe("otherProjectsLabel", () => {
  it("names none, one or several", () => {
    expect(otherProjectsLabel([])).toBe("another project");
    expect(otherProjectsLabel(["A"])).toBe("the project “A”");
    expect(otherProjectsLabel(["A", "B"])).toBe("the projects “A”, “B”");
  });
});

describe("CrossProjectConfirmDialog", () => {
  it("falls back to the form's target and confirms", () => {
    const onConfirm = vi.fn();
    render(
      <CrossProjectConfirmDialog
        open
        onOpenChange={() => {}}
        refusal={{ repo: "", projects: [] }}
        fallbackRepo="me/sandbox"
        pending={false}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByTestId("cross-project-confirm-text")).toHaveTextContent(
      "me/sandbox is already connected to another project",
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish anyway" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while the retry is in flight", () => {
    render(
      <CrossProjectConfirmDialog
        open
        onOpenChange={() => {}}
        refusal={null}
        fallbackRepo="me/sandbox"
        pending
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByTestId("cross-project-confirm-button")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

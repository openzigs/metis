/**
 * Issue #122 — Rebuild AST cache button unit tests.
 *
 * Covers idle → in-progress → completed (with stats) and the failed path that
 * surfaces a parsed error and never shows a misleading "completed" state.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";

const rebuildFn = vi.fn();
vi.mock("@/lib/ast-cache-api", () => ({
  astCacheApi: { rebuild: (...args: unknown[]) => rebuildFn(...args) },
}));

import type { AstCacheRebuildResult } from "@/lib/ast-cache-api";
import { RebuildCacheButton } from "@/components/projects/rebuild-cache-button";

function renderButton() {
  return render(<RebuildCacheButton projectId="p1" repoId="r1" />);
}

describe("RebuildCacheButton", () => {
  it("rebuilds and shows completion stats", async () => {
    rebuildFn.mockResolvedValueOnce({
      repoId: "r1",
      projectId: "p1",
      message: "Cache rebuild complete",
      stats: { indexedFiles: 5, skippedFiles: 2, totalSymbols: 12, discoveredFiles: 7 },
    });
    renderButton();
    fireEvent.click(screen.getByTestId("rebuild-cache-button-r1"));
    const status = await screen.findByTestId("rebuild-cache-status-r1");
    expect(status).toHaveTextContent("5 file(s)");
    expect(status).toHaveTextContent("12 symbol(s)");
    expect(rebuildFn).toHaveBeenCalledWith("p1", "r1");
  });

  it("shows a parsed error and no completed state on failure", async () => {
    rebuildFn.mockImplementationOnce(() =>
      Promise.reject(new ApiError(404, "Repository not found", "NOT_FOUND")),
    );
    renderButton();
    fireEvent.click(screen.getByTestId("rebuild-cache-button-r1"));
    expect(await screen.findByTestId("rebuild-cache-error-r1")).toHaveTextContent(
      "Repository not found",
    );
    expect(screen.queryByTestId("rebuild-cache-status-r1")).not.toBeInTheDocument();
  });

  it("shows the in-progress label while a rebuild is pending", async () => {
    let resolve: (v: AstCacheRebuildResult) => void = () => {};
    rebuildFn.mockReturnValueOnce(
      new Promise<AstCacheRebuildResult>((r) => {
        resolve = r;
      }),
    );
    renderButton();
    const btn = screen.getByTestId("rebuild-cache-button-r1");
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveTextContent("Rebuilding…"));
    expect(btn).toBeDisabled();
    resolve({
      repoId: "r1",
      projectId: "p1",
      message: "Cache rebuild complete",
      stats: { indexedFiles: 1, skippedFiles: 0, totalSymbols: 1, discoveredFiles: 1 },
    });
    await screen.findByTestId("rebuild-cache-status-r1");
  });
});

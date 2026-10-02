/**
 * #733 — the Scans page publish no longer reaches the scanned (upstream) repo.
 * With no saved target the server refuses with ERR_NO_PUBLISH_TARGET (400);
 * the triage row must surface that and point at the Publish page, where
 * "Save as project target" lives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj-1", scanId: "scan-1" })),
}));
vi.mock("@/lib/scanner-api", () => ({
  scannerApi: {
    getScan: vi.fn(),
    listFindings: vi.fn(),
    triage: vi.fn(),
    publish: vi.fn(),
  },
}));

import { scannerApi } from "@/lib/scanner-api";
import ScanTriagePage from "@/app/(authed)/projects/[id]/scans/[scanId]/page";

const publish = vi.mocked(scannerApi.publish);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(scannerApi.getScan).mockReturnValue(new Promise(() => {}));
  vi.mocked(scannerApi.listFindings).mockResolvedValue([
    {
      id: "sf-1",
      scanId: "scan-1",
      ruleId: null,
      symbolId: "sym-1",
      title: "Null deref",
      body: "details",
      severity: "high",
      category: "security",
      evidenceLines: "[1]",
      fingerprint: "fp",
      confidence: 0.9,
      triageStatus: "approved",
      triageNote: null,
      materializedFindingId: null,
    },
  ] as never);
});

async function clickPublishGithub() {
  render(<ScanTriagePage />, { wrapper: makeWrapper({ withAuth: false }) });
  fireEvent.click(await screen.findByTestId("scanner-finding-publish-github-sf-1"));
}

describe("Scan triage — GitHub publish target (#733)", () => {
  it("sends only the provider; the server resolves the saved target", async () => {
    publish.mockResolvedValue({} as never);
    await clickPublishGithub();
    await waitFor(() => expect(publish).toHaveBeenCalled());
    expect(publish).toHaveBeenCalledWith("proj-1", "scan-1", "sf-1", { provider: "github" });
  });

  it("surfaces ERR_NO_PUBLISH_TARGET with a link to the Publish page", async () => {
    publish.mockRejectedValue(
      new ApiError(
        400,
        "No GitHub publish target is configured for this project.",
        "ERR_NO_PUBLISH_TARGET",
      ),
    );
    await clickPublishGithub();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/No GitHub publish target/);
    const link = screen.getByTestId("scanner-finding-set-target-sf-1");
    expect(link.getAttribute("href")).toBe("/projects/proj-1/publish");
  });

  it("shows no Publish-page link for an unrelated publish failure", async () => {
    publish.mockRejectedValue(new ApiError(409, "repo moved", "ERR_STALE_COMMIT"));
    await clickPublishGithub();
    await screen.findByRole("alert");
    expect(screen.queryByTestId("scanner-finding-set-target-sf-1")).toBeNull();
  });
});

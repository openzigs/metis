/**
 * #432 — a Deep Ingest that completes with failures is not a success.
 *
 * The server already words such a run "Deep ingest completed with N failures…"
 * and (since #432) reports the count as `failureCount`; the banner used the
 * success palette regardless, so a partial run still looked green.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DeepIngestOutcomeBanner,
  deepIngestBannerTone,
} from "@/components/connectors/deep-ingest-outcome-banner";
import type { DeepIngestOutcome } from "@/hooks/use-deep-ingest";

const outcome = (over: Partial<DeepIngestOutcome>): DeepIngestOutcome => ({
  connectorId: "r1",
  status: "completed",
  message: "Deep ingest complete: 10 of 12 files parsed.",
  failureCount: 0,
  ...over,
});

describe("deepIngestBannerTone (#432)", () => {
  it("is success for a clean run", () => {
    expect(deepIngestBannerTone(outcome({}))).toBe("success");
  });

  it("is warning for a run that completed with failures", () => {
    expect(deepIngestBannerTone(outcome({ failureCount: 1 }))).toBe("warning");
    expect(deepIngestBannerTone(outcome({ failureCount: 3 }))).toBe("warning");
  });

  it("is error for a failed run, whatever the count", () => {
    expect(deepIngestBannerTone(outcome({ status: "failed" }))).toBe("error");
    expect(deepIngestBannerTone(outcome({ status: "failed", failureCount: 2 }))).toBe("error");
  });
});

describe("DeepIngestOutcomeBanner (#432)", () => {
  it("renders nothing without an outcome", () => {
    const { container } = render(<DeepIngestOutcomeBanner outcome={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a clean run in the success palette", () => {
    render(<DeepIngestOutcomeBanner outcome={outcome({})} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Deep ingest complete: 10 of 12 files parsed.");
    expect(banner.className).toContain("bg-success-muted");
    expect(banner.className).not.toContain("warning");
  });

  it("renders a partly failed run in the warning palette, not success-green", () => {
    const message = "Deep ingest completed with 2 failures: 2 source files could not be ingested.";
    render(<DeepIngestOutcomeBanner outcome={outcome({ message, failureCount: 2 })} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(message);
    expect(banner.className).toContain("bg-warning-muted");
    expect(banner.className).toContain("border-warning/40");
    expect(banner.className).not.toContain("success");
    expect(screen.getByText(message).className).toContain("text-warning");
  });

  it("renders a failed run as an alert with the server's message", () => {
    render(
      <DeepIngestOutcomeBanner
        outcome={outcome({ status: "failed", message: "Repository ingestion failed." })}
      />,
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Deep ingest failed");
    expect(banner).toHaveTextContent("Repository ingestion failed.");
    expect(banner.className).toContain("border-destructive/40");
  });
});

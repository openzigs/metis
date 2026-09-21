/**
 * Issue #1333 — the drift verdict must state the history gap wherever it is
 * reported, including the Domain Eval tab.
 *
 * `eval-domain-nightly.yml` silently committed nothing between 2026-07-21 and
 * the #1333 fix, so every nightly in that window compared against the same
 * 2026-07-21 envelope and came back "within threshold". A table that renders
 * those rows as a bare "OK" invites exactly the wrong reading — five weeks of
 * one repeated comparison presented as five weeks of stability.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DomainDriftCell } from "./domain-eval-panel";
import type { DomainDrift } from "@/lib/eval-api";

const drift = (over: Partial<DomainDrift> = {}): DomainDrift => ({
  previousF1: 0.9,
  deltaF1: 0.0,
  thresholdPct: 0.05,
  alert: false,
  reason: "WITHIN_THRESHOLD",
  baselineRunId: "2026-08-22T03-00-00-000Z",
  baselineAgeDays: 7,
  staleBaseline: false,
  ...over,
});

const RUN = "2026-08-29T03-00-00-000Z";

describe("DomainDriftCell", () => {
  it("shows a plain OK for a healthy week-over-week comparison", () => {
    render(<DomainDriftCell runId={RUN} drift={drift()} driftAlert={false} />);
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.queryByTestId(`domain-drift-stale-${RUN}`)).toBeNull();
  });

  it("shows the Drift badge when the threshold was breached", () => {
    render(<DomainDriftCell runId={RUN} drift={drift({ alert: true })} driftAlert />);
    expect(screen.getByTestId(`domain-drift-badge-${RUN}`)).toBeInTheDocument();
  });

  it("states the gap inline — not only in a tooltip — when the baseline is stale", () => {
    render(
      <DomainDriftCell
        runId={RUN}
        drift={drift({
          staleBaseline: true,
          baselineAgeDays: 39,
          baselineRunId: "2026-07-21T03-00-00-000Z",
        })}
        driftAlert={false}
      />,
    );
    const badge = screen.getByTestId(`domain-drift-stale-${RUN}`);
    // Visible text, so a reader scanning the column cannot miss it.
    expect(badge).toHaveTextContent("Stale baseline (39d)");
    expect(badge).toHaveTextContent("not week-over-week");
    // …and the full explanation, naming the baseline run, on hover.
    expect(badge).toHaveAttribute("title", expect.stringContaining("2026-07-21T03-00-00-000Z"));
  });

  it("still shows the gap on a row that otherwise reads OK", () => {
    render(
      <DomainDriftCell
        runId={RUN}
        drift={drift({ staleBaseline: true, baselineAgeDays: 39 })}
        driftAlert={false}
      />,
    );
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByTestId(`domain-drift-stale-${RUN}`)).toBeInTheDocument();
  });

  it("says nothing about staleness for a pre-#1333 envelope with no baseline age", () => {
    render(
      <DomainDriftCell
        runId={RUN}
        drift={drift({ staleBaseline: false, baselineAgeDays: null, baselineRunId: null })}
        driftAlert={false}
      />,
    );
    expect(screen.queryByTestId(`domain-drift-stale-${RUN}`)).toBeNull();
  });
});

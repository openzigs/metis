/**
 * Issue #859 (Epic #852 Phase 4b) — AnalysisDatabaseAwareIndicator component
 * tests.
 *
 * Locks the "ran / skipped + why" surfacing on the analysis results page for
 * every `AnalysisDatabaseAwareReason`: the two "ran" reasons badge as "on",
 * the explicit `off` reason badges as "off" with no link, the two
 * no-schema-data reasons badge as "skipped" AND render the actionable hint
 * linking to `/projects/:id/connections`, and an absent (null) decision
 * (pre-#855 runs) renders nothing.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisDatabaseAwareIndicator } from "./analysis-database-aware-indicator";
import type { AnalysisDatabaseAware, AnalysisDatabaseAwareReason } from "@/lib/analysis-api";

function makeDecision(reason: AnalysisDatabaseAwareReason): AnalysisDatabaseAware {
  const enabled = reason !== "off";
  const ran = reason === "on" || reason === "auto->resolved-on";
  return { setting: "auto", enabled, ran, reason };
}

describe("AnalysisDatabaseAwareIndicator (#859)", () => {
  it("renders nothing when the decision is null (pre-#855 runs)", () => {
    const { container } = render(
      <AnalysisDatabaseAwareIndicator databaseAware={null} projectId="proj-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('badges "on" for an explicit on decision, with no skipped hint', () => {
    render(
      <AnalysisDatabaseAwareIndicator databaseAware={makeDecision("on")} projectId="proj-1" />,
    );
    const badge = screen.getByTestId("database-aware-badge");
    expect(badge).toHaveTextContent("Database-aware analysis: on");
    expect(badge.dataset.reason).toBe("on");
    expect(screen.queryByTestId("database-aware-skipped-hint")).not.toBeInTheDocument();
  });

  it('badges "on" for an auto-resolved-on decision, with no skipped hint', () => {
    render(
      <AnalysisDatabaseAwareIndicator
        databaseAware={makeDecision("auto->resolved-on")}
        projectId="proj-1"
      />,
    );
    const badge = screen.getByTestId("database-aware-badge");
    expect(badge).toHaveTextContent("Database-aware analysis: on");
    expect(badge.dataset.reason).toBe("auto->resolved-on");
    expect(screen.queryByTestId("database-aware-skipped-hint")).not.toBeInTheDocument();
  });

  it('badges "off" for an explicit off decision, with no skipped hint or link', () => {
    render(
      <AnalysisDatabaseAwareIndicator databaseAware={makeDecision("off")} projectId="proj-1" />,
    );
    const badge = screen.getByTestId("database-aware-badge");
    expect(badge).toHaveTextContent("Database-aware analysis: off");
    expect(badge.dataset.reason).toBe("off");
    expect(screen.queryByTestId("database-aware-skipped-hint")).not.toBeInTheDocument();
    expect(screen.queryByTestId("database-aware-connections-link")).not.toBeInTheDocument();
  });

  it('badges "off" for a platform-disabled decision and explains it in the title, with no connect-a-database hint (#849)', () => {
    // A kill-switch is not a data gap: connecting a database would change
    // nothing, so the actionable hint must NOT appear.
    render(
      <AnalysisDatabaseAwareIndicator
        databaseAware={{
          setting: "auto",
          enabled: false,
          ran: false,
          reason: "auto->platform-disabled",
        }}
        projectId="proj-1"
      />,
    );
    const badge = screen.getByTestId("database-aware-badge");
    expect(badge).toHaveTextContent("Database-aware analysis: off");
    expect(badge.dataset.reason).toBe("auto->platform-disabled");
    expect(badge).toHaveAttribute("title", expect.stringContaining("platform configuration"));
    expect(screen.queryByTestId("database-aware-skipped-hint")).not.toBeInTheDocument();
    expect(screen.queryByTestId("database-aware-connections-link")).not.toBeInTheDocument();
  });

  it('badges "skipped" and shows the connect/re-ingest hint for skipped-no-schema-data, linking to /projects/:id/connections', () => {
    render(
      <AnalysisDatabaseAwareIndicator
        databaseAware={makeDecision("skipped-no-schema-data")}
        projectId="proj-42"
      />,
    );
    const badge = screen.getByTestId("database-aware-badge");
    expect(badge).toHaveTextContent("Database-aware analysis: skipped");
    expect(badge.dataset.reason).toBe("skipped-no-schema-data");
    expect(screen.getByTestId("database-aware-skipped-hint")).toHaveTextContent(
      "Schema-impact analysis skipped — no schema data.",
    );
    const link = screen.getByTestId("database-aware-connections-link");
    expect(link).toHaveAttribute("href", "/projects/proj-42/connections");
    expect(link).toHaveTextContent("Connect a database or re-ingest");
  });

  it('badges "skipped" and shows the connect/re-ingest hint for auto->resolved-off-no-data, linking to /projects/:id/connections', () => {
    render(
      <AnalysisDatabaseAwareIndicator
        databaseAware={makeDecision("auto->resolved-off-no-data")}
        projectId="proj-7"
      />,
    );
    const badge = screen.getByTestId("database-aware-badge");
    expect(badge).toHaveTextContent("Database-aware analysis: skipped");
    expect(badge.dataset.reason).toBe("auto->resolved-off-no-data");
    const link = screen.getByTestId("database-aware-connections-link");
    expect(link).toHaveAttribute("href", "/projects/proj-7/connections");
  });
});

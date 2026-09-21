/**
 * Issue #827 (Epic #820) — database-changes section of the gap report.
 *
 * These tests pin the safety-critical rendering rules carried from #825:
 *   - the suggested DDL is always labelled "review only, never executed" and is
 *     rendered inert as text (no HTML injection);
 *   - rows that could not be reconciled against the live schema are split into a
 *     distinct "unverified" table;
 *   - an unresolved cross-project identity renders "impact unknown", NEVER "no
 *     consumers"; and it is visually distinct from a resolved-but-empty change;
 *   - `riskClass` is honestly "Unclassified" when absent;
 *   - the whole section is omitted when a requirement has no database changes.
 *
 * Queries are accessible (roles / visible text / stable test ids) — never
 * snapshots.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import type { GapReportDatabaseChange } from "@metis/shared";
import { GapReportSchemaSection } from "./gap-report-schema-section";

function change(overrides: Partial<GapReportDatabaseChange> = {}): GapReportDatabaseChange {
  return {
    tableName: "orders",
    columnName: null,
    changeKind: "add-table",
    reconciliation: "matched",
    confidence: 0.9,
    suggestedDdl: "CREATE TABLE orders (id INT);",
    identityResolved: true,
    consumers: [],
    ...overrides,
  };
}

function renderSection(changes: GapReportDatabaseChange[] | undefined, projectId = "proj-1") {
  return render(<GapReportSchemaSection projectId={projectId} changes={changes} />);
}

afterEach(() => cleanup());

describe("GapReportSchemaSection — omission", () => {
  it("renders nothing when there are no database changes (undefined)", () => {
    renderSection(undefined);
    expect(screen.queryByTestId("gap-database-changes")).toBeNull();
  });

  it("renders nothing when the database-changes list is empty", () => {
    renderSection([]);
    expect(screen.queryByTestId("gap-database-changes")).toBeNull();
  });
});

describe("GapReportSchemaSection — a verified change row", () => {
  it("renders object, change kind, reconciliation, confidence, and risk", () => {
    renderSection([
      change({ tableName: "orders", columnName: null, changeKind: "add-table", confidence: 0.9 }),
    ]);
    const table = screen.getByTestId("db-verified-changes");
    const row = within(table).getByTestId("db-change-row");
    expect(row).toHaveAttribute("data-object", "orders");
    expect(within(row).getByText("Add table")).toBeInTheDocument();
    expect(within(table).getByTestId("db-recon-badge-matched")).toHaveTextContent(
      "Matched live schema",
    );
    expect(within(row).getByText("0.90")).toBeInTheDocument();
  });

  it("labels a column change as table.column", () => {
    renderSection([
      change({ tableName: "orders", columnName: "status", changeKind: "add-column" }),
    ]);
    expect(screen.getByTestId("db-change-row")).toHaveAttribute("data-object", "orders.status");
    expect(screen.getByText("Add column")).toBeInTheDocument();
  });

  it("renders the reconciliation 'Not checked' badge when reconciliation is null", () => {
    renderSection([change({ reconciliation: null })]);
    expect(screen.getByTestId("db-recon-badge-unchecked")).toHaveTextContent("Not checked");
  });

  it("exposes accessible table semantics with column headers", () => {
    renderSection([change()]);
    const table = screen.getByRole("table", {
      name: /reconciled against the live schema/i,
    });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Object",
      "Change",
      "Reconciliation",
      "Confidence",
      "Risk",
    ]);
  });
});

describe("GapReportSchemaSection — suggested DDL safety", () => {
  it("always shows the review-only label (not a tooltip) and renders the DDL as text", () => {
    renderSection([change({ suggestedDdl: "ALTER TABLE orders ADD COLUMN status TEXT;" })]);
    const ddl = screen.getByTestId("db-suggested-ddl");
    // The persistent, visible caption — always present, not hidden behind hover.
    expect(within(ddl).getByText("Suggested DDL — for review only, never executed")).toBeVisible();
    expect(ddl).toHaveTextContent("ALTER TABLE orders ADD COLUMN status TEXT;");
  });

  it("renders DDL containing markup as inert text — no HTML injection", () => {
    const malicious = "CREATE TABLE t; -- <script>alert(1)</script>";
    const { container } = renderSection([change({ suggestedDdl: malicious })]);
    // The angle brackets are shown verbatim; no <script> node is ever created.
    expect(screen.getByTestId("db-suggested-ddl")).toHaveTextContent(malicious);
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows an explicit 'no suggested DDL' note when the DDL is null", () => {
    renderSection([change({ suggestedDdl: null })]);
    expect(screen.getByTestId("db-ddl-none")).toHaveTextContent(/no suggested ddl/i);
    expect(screen.queryByTestId("db-suggested-ddl")).toBeNull();
  });
});

describe("GapReportSchemaSection — verified vs unverified separation", () => {
  it("splits table-not-found / column-not-found rows into a distinct unverified table", () => {
    renderSection([
      change({ tableName: "orders", reconciliation: "matched" }),
      change({ tableName: "ghost_table", reconciliation: "table-not-found" }),
      change({ tableName: "orders", columnName: "missing", reconciliation: "column-not-found" }),
    ]);

    const verified = screen.getByTestId("db-verified-changes");
    expect(within(verified).getByText("orders")).toBeInTheDocument();
    expect(within(verified).queryByText("ghost_table")).toBeNull();

    const unverifiedBlock = screen.getByTestId("db-unverified-changes");
    expect(unverifiedBlock).toHaveTextContent(/unverified against live schema/i);
    expect(unverifiedBlock).toHaveTextContent(/could not be confirmed/i);
    const unverifiedTable = within(unverifiedBlock).getByTestId("db-unverified-changes-table");
    expect(within(unverifiedTable).getByText("ghost_table")).toBeInTheDocument();
    expect(within(unverifiedTable).getByText("orders.missing")).toBeInTheDocument();
  });

  it("omits the unverified block entirely when every row is reconciled", () => {
    renderSection([change({ reconciliation: "matched" }), change({ reconciliation: null })]);
    expect(screen.getByTestId("db-verified-changes")).toBeInTheDocument();
    expect(screen.queryByTestId("db-unverified-changes")).toBeNull();
  });

  it("omits the verified table when every row is unverified", () => {
    renderSection([change({ tableName: "ghost", reconciliation: "table-not-found" })]);
    expect(screen.queryByTestId("db-verified-changes")).toBeNull();
    expect(screen.getByTestId("db-unverified-changes")).toBeInTheDocument();
  });
});

describe("GapReportSchemaSection — risk badges (text, never colour-only)", () => {
  it("renders a loud Breaking badge", () => {
    renderSection([change({ riskClass: "breaking" })]);
    const badge = screen.getByTestId("db-risk-badge-breaking");
    expect(badge).toHaveTextContent("Breaking");
    expect(badge).toHaveAttribute("aria-label", "Risk: Breaking");
  });

  it("renders an Expanding (additive) badge", () => {
    renderSection([change({ riskClass: "expanding" })]);
    expect(screen.getByTestId("db-risk-badge-expanding")).toHaveTextContent("Expanding");
  });

  it("renders a Neutral badge", () => {
    renderSection([change({ riskClass: "neutral" })]);
    expect(screen.getByTestId("db-risk-badge-neutral")).toHaveTextContent("Neutral");
  });

  it("renders 'Unclassified' when riskClass is absent", () => {
    renderSection([change({})]);
    expect(screen.getByTestId("db-risk-badge-unclassified")).toHaveTextContent("Unclassified");
  });
});

describe("GapReportSchemaSection — cross-project consumers per row", () => {
  it("says 'impact unknown' and links the identity manager when identity is unresolved", () => {
    renderSection([change({ identityResolved: false, consumers: undefined })], "proj-77");
    const unknown = screen.getByTestId("db-consumers-unknown");
    expect(unknown).toHaveTextContent(/cross-project impact unknown/i);
    // Never the "no consumers" language.
    expect(unknown).not.toHaveTextContent(/no other project/i);
    const link = screen.getByTestId("db-identity-manager-link");
    expect(link).toHaveAttribute("href", "/projects/proj-77/connections");
  });

  it("says 'no other project' only when identity is resolved with zero consumers", () => {
    renderSection([change({ identityResolved: true, consumers: [] })]);
    expect(screen.getByTestId("db-consumers-none")).toHaveTextContent(/no other project/i);
    expect(screen.queryByTestId("db-consumers-unknown")).toBeNull();
  });

  it("treats a resolved change with an absent consumers list as zero consumers", () => {
    renderSection([change({ identityResolved: true, consumers: undefined })]);
    expect(screen.getByTestId("db-consumers-none")).toHaveTextContent(/no other project/i);
    // A resolved-but-empty change never contributes to the consumer banner.
    expect(screen.queryByTestId("db-cross-project-banner")).toBeNull();
  });

  it("lists sibling consumers with their read/write usage", () => {
    renderSection([
      change({
        tableName: "orders",
        identityResolved: true,
        consumers: [
          {
            projectId: "p-billing",
            projectName: "Billing",
            usage: "readBy",
            objectQualifiedName: "public.orders",
          },
          {
            projectId: "p-fulfil",
            projectName: "Fulfilment",
            usage: "writtenBy",
            objectQualifiedName: "public.orders",
          },
        ],
      }),
    ]);
    const list = screen.getByTestId("db-consumers-list");
    expect(within(list).getByText("Billing")).toBeInTheDocument();
    expect(list).toHaveTextContent(/Billing\s+reads/);
    expect(within(list).getByText("Fulfilment")).toBeInTheDocument();
    expect(list).toHaveTextContent(/Fulfilment\s+writes/);
  });
});

describe("GapReportSchemaSection — cross-project banner", () => {
  it("shows the consumer banner only when a resolved change has consumers", () => {
    renderSection([
      change({
        tableName: "orders",
        riskClass: "breaking",
        identityResolved: true,
        consumers: [
          {
            projectId: "p-billing",
            projectName: "Billing",
            usage: "readBy",
            objectQualifiedName: "public.orders",
          },
        ],
      }),
    ]);
    const banner = screen.getByTestId("db-cross-project-banner");
    expect(banner).toHaveTextContent(/affects 1 other project: Billing/i);
    const impact = within(banner).getByTestId("db-cross-project-impact");
    expect(impact).toHaveTextContent(/Billing/);
    expect(impact).toHaveTextContent(/reads/);
    expect(impact).toHaveTextContent(/orders/);
    // Risk is echoed by its word, not colour alone.
    expect(impact).toHaveTextContent(/Breaking/);
  });

  it("pluralises and de-duplicates affected project names", () => {
    renderSection([
      change({
        tableName: "orders",
        consumers: [
          {
            projectId: "p-billing",
            projectName: "Billing",
            usage: "readBy",
            objectQualifiedName: "public.orders",
          },
        ],
      }),
      change({
        tableName: "invoices",
        consumers: [
          {
            projectId: "p-billing",
            projectName: "Billing",
            usage: "writtenBy",
            objectQualifiedName: "public.invoices",
          },
          {
            projectId: "p-reporting",
            projectName: "Reporting",
            usage: "readBy",
            objectQualifiedName: "public.invoices",
          },
        ],
      }),
    ]);
    // Billing appears twice across rows but is listed once in the headline.
    expect(screen.getByTestId("db-cross-project-banner")).toHaveTextContent(
      /affects 2 other projects: Billing, Reporting/i,
    );
    expect(screen.getAllByTestId("db-cross-project-impact")).toHaveLength(3);
  });

  it("renders the unknown-identity notice distinctly from a zero-consumer change", () => {
    renderSection([change({ identityResolved: false, consumers: undefined })], "proj-9");
    const unknownBanner = screen.getByTestId("db-cross-project-unknown");
    expect(unknownBanner).toHaveTextContent(/cross-project impact unknown/i);
    expect(within(unknownBanner).getByTestId("db-cross-project-unknown-link")).toHaveAttribute(
      "href",
      "/projects/proj-9/connections",
    );
    // No resolved consumers ⇒ no consumer banner.
    expect(screen.queryByTestId("db-cross-project-banner")).toBeNull();
  });

  it("shows no banner at all when every change is resolved with zero consumers", () => {
    renderSection([change({ identityResolved: true, consumers: [] })]);
    expect(screen.queryByTestId("db-cross-project-banner")).toBeNull();
    expect(screen.queryByTestId("db-cross-project-unknown")).toBeNull();
  });

  it("shows both the consumer banner and the unknown notice when rows mix", () => {
    renderSection([
      change({
        tableName: "orders",
        identityResolved: true,
        consumers: [
          {
            projectId: "p-billing",
            projectName: "Billing",
            usage: "readBy",
            objectQualifiedName: "public.orders",
          },
        ],
      }),
      change({ tableName: "secrets", identityResolved: false, consumers: undefined }),
    ]);
    expect(screen.getByTestId("db-cross-project-banner")).toBeInTheDocument();
    expect(screen.getByTestId("db-cross-project-unknown")).toHaveTextContent(/secrets/);
  });
});

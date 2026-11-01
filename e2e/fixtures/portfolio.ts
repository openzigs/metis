/**
 * #1629 — the synthetic portfolio the portfolio gap and impact journeys run
 * over (epic #1608). Invented names and code only: no production content.
 *
 *   Workspace "Portfolio A"  Payments   payments-api       (pays an invoice by instant transfer)
 *                                       payments-db        (writes the ledger_entries table)
 *                                       reporting-service  (also on Reporting: see below)
 *   Workspace "Portfolio B"  Reporting  reporting-service  (reads ledger_entries, calls the API)
 *
 * Cross-product coupling is recorded the way METIS records it (#1623): a repo
 * may be attached to several products, and an edge on one product between two
 * of its repos reaches every other product either repo is on. Both edges are
 * on Payments and end at `reporting-service`, which is also Reporting's repo:
 *
 *   - the contract edge: `reporting-service -> payments-api`, `api` /
 *     `contract`, `consumes` (low);
 *   - the shared-table edge: `payments-db -> reporting-service` through the
 *     `ledger_entries` table, `database` / `intrusive`, `writes` (high).
 *
 * So when Payments must change, Reporting is downstream of it, most severely
 * through the shared database. A reader outside "Portfolio B" cannot read
 * Reporting, nor `reporting-service`.
 *
 * The model's answers are the committed replay fixtures in `e2e/fixtures/llm`,
 * recorded from `portfolio-record-book.json` (see that file and the spec's
 * header for how to re-record them).
 */

export interface PortfolioRepo {
  /** The connector label, which is also the repo name the prompts and the page show. */
  label: string;
  files: Array<{ path: string; content: string }>;
}

const repo = (label: string, files: Record<string, string>): PortfolioRepo => ({
  label,
  files: Object.entries(files).map(([path, content]) => ({ path: `${label}/${path}`, content })),
});

export const PAYMENTS_API = repo("payments-api", {
  "src/instant-transfer.ts": [
    "// Pays an open invoice by instant bank transfer (SEPA Instant).",
    "export interface Invoice {",
    "  id: string;",
    "  amountCents: number;",
    "  iban: string;",
    "}",
    "",
    "export async function payInvoiceByInstantTransfer(invoice: Invoice): Promise<string> {",
    "  const transfer = await sendInstantTransfer(invoice.iban, invoice.amountCents);",
    "  await markInvoicePaid(invoice.id, transfer.id);",
    "  return transfer.id;",
    "}",
    "",
    "declare function sendInstantTransfer(iban: string, cents: number): Promise<{ id: string }>;",
    "declare function markInvoicePaid(invoiceId: string, transferId: string): Promise<void>;",
    "",
  ].join("\n"),
});

export const PAYMENTS_DB = repo("payments-db", {
  "src/ledger-writer.ts": [
    "// Records every settled payment in the ledger_entries table.",
    "export async function recordLedgerEntry(db: Db, invoiceId: string, cents: number) {",
    "  await db.query(",
    "    'INSERT INTO ledger_entries (invoice_id, amount_cents) VALUES ($1, $2)',",
    "    [invoiceId, cents],",
    "  );",
    "}",
    "",
    "interface Db {",
    "  query(sql: string, params: unknown[]): Promise<unknown>;",
    "}",
    "",
  ].join("\n"),
});

export const REPORTING_SERVICE = repo("reporting-service", {
  "src/revenue-report.ts": [
    "// Builds the monthly revenue report from the ledger_entries table.",
    "export async function monthlyRevenue(db: Db, month: string): Promise<number> {",
    "  const rows = await db.query(",
    "    'SELECT SUM(amount_cents) AS total FROM ledger_entries WHERE month = $1',",
    "    [month],",
    "  );",
    "  return Number((rows as Array<{ total: number }>)[0]?.total ?? 0);",
    "}",
    "",
    "interface Db {",
    "  query(sql: string, params: unknown[]): Promise<unknown>;",
    "}",
    "",
  ].join("\n"),
});

export const PORTFOLIO = {
  workspaces: { a: "Portfolio A", b: "Portfolio B" },
  products: { payments: "Payments", reporting: "Reporting" },
  /** The shared table both edges' database side is about. */
  table: "ledger_entries",
} as const;

/**
 * The requirements the journeys check, and what the recorded model answers
 * make of each (`portfolio-record-book.json`).
 */
export const STATEMENTS = {
  /** Journey 1 — payments-api implements it: Payments covers it, Reporting does not. */
  covered: "Customers can pay an invoice by instant bank transfer.",
  /** Journey 2 — no repo implements it: nothing in the portfolio covers it. */
  uncovered: "Customers can split one invoice across several payment cards.",
  /**
   * Journey 3 — two criteria, payments-api meets only the first: Payments
   * covers part of it, so it must change, and Reporting is downstream.
   */
  partial: "Customers can pay an invoice by instant bank transfer and get a receipt by email.",
} as const;

/**
 * Epic #803 (Epic 09) — golden corpus authoring script.
 *
 * One-shot generator that materialises the curated, license-clean synthetic
 * corpus under `eval-data/corpus/<id>/` plus `eval-data/manifest.json`. Every
 * document is ORIGINAL synthetic content authored for METIS (CC0-1.0) so there
 * are no third-party licensing concerns. Run with:
 *
 *   node eval-data/build-fixtures.mjs
 *
 * The committed `.md` + `.json` files are the source of truth; this script is
 * kept only to make the curation reproducible and reviewable.
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, "corpus");

/**
 * Each item: id, title, docType, overview (modal-free), and a list of
 * requirements. `sentence` is the prose statement placed in the doc;
 * `title`/`description`/`type`/`priority` form the golden expectation.
 */
const ITEMS = [
  {
    id: "prd-01-auth-portal",
    title: "Customer Authentication Portal",
    docType: "prd",
    overview: "This PRD captures the scope for the customer-facing authentication portal.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Email and password sign-in",
        description: "Registered customers sign in with an email address and password.",
        sentence:
          "The portal must allow registered customers to sign in with an email address and password.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Self-service password reset",
        description: "Customers reset a forgotten password through an emailed reset link.",
        sentence:
          "The system must let customers reset a forgotten password through an emailed reset link.",
      },
      {
        type: "feature",
        priority: "critical",
        title: "Multi-factor authentication",
        description: "A one-time passcode is required as a second authentication factor.",
        sentence:
          "Sign-in is critical and must require a one-time passcode as a second authentication factor.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Remember this device",
        description: "Customers should be able to mark a device as trusted for thirty days.",
        sentence: "Customers should be able to mark a device as trusted for thirty days.",
      },
    ],
  },
  {
    id: "prd-02-checkout",
    title: "Storefront Checkout Flow",
    docType: "prd",
    overview: "Defines the storefront checkout experience for the web and mobile clients.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Guest checkout",
        description: "Shoppers complete a purchase without creating an account.",
        sentence:
          "The checkout must allow shoppers to complete a purchase without creating an account.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Multiple payment methods",
        description: "Card, wallet, and bank-transfer payment methods are supported.",
        sentence: "Checkout must support card, wallet, and bank-transfer payment methods.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Promotion code entry",
        description: "Shoppers should be able to apply a promotion code before payment.",
        sentence: "Shoppers should be able to apply a promotion code before payment.",
      },
      {
        type: "chore",
        priority: "low",
        title: "Deprecate legacy cart cookie",
        description: "The legacy cart cookie may be removed once sessions migrate.",
        sentence:
          "The legacy cart cookie may be deprecated once all sessions migrate to the new store.",
      },
    ],
  },
  {
    id: "prd-03-notifications",
    title: "Notification Preferences Center",
    docType: "prd",
    overview: "Scope for a unified notification preferences center across channels.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Per-channel opt-in",
        description: "Users opt in to email, SMS, and push channels independently.",
        sentence: "Users must be able to opt in to email, SMS, and push channels independently.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Quiet hours",
        description: "Users should be able to define quiet hours that suppress push alerts.",
        sentence: "Users should be able to define quiet hours that suppress push alerts.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Transactional override",
        description:
          "Critical transactional messages are always delivered regardless of preferences.",
        sentence:
          "Critical transactional messages must always be delivered regardless of channel preferences.",
      },
    ],
  },
  {
    id: "prd-04-search",
    title: "Catalog Search Revamp",
    docType: "prd",
    overview: "Improves catalog search relevance and filtering for the marketplace.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Typeahead suggestions",
        description: "Search returns typeahead suggestions as the shopper types.",
        sentence: "Search must return typeahead suggestions as the shopper types a query.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Faceted filters",
        description: "Results should be filterable by price, brand, and rating facets.",
        sentence: "Results should be filterable by price, brand, and rating facets.",
      },
      {
        type: "bug",
        priority: "high",
        title: "Fix empty-state ranking",
        description: "An incorrect ranking of zero-result queries is fixed.",
        sentence:
          "The pipeline must fix the incorrect ranking that returns zero results for valid queries.",
      },
      {
        type: "feature",
        priority: "low",
        title: "Recent searches",
        description: "Shoppers may revisit their five most recent searches.",
        sentence: "Shoppers may optionally revisit their five most recent searches.",
      },
    ],
  },
  {
    id: "prd-05-dashboard",
    title: "Analytics Dashboard",
    docType: "prd",
    overview: "An operational analytics dashboard for account administrators.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Realtime usage tiles",
        description: "Administrators view realtime usage tiles for the account.",
        sentence: "The dashboard must show administrators realtime usage tiles for the account.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Exportable reports",
        description: "Administrators should be able to export reports as CSV.",
        sentence: "Administrators should be able to export any report as a CSV file.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Role-scoped visibility",
        description: "Tiles are scoped to the viewer's role and permissions.",
        sentence: "Dashboard tiles must be scoped to the viewer's role and permissions.",
      },
    ],
  },
  {
    id: "brd-01-billing",
    title: "Subscription Billing Requirements",
    docType: "brd",
    overview: "Business requirements for the recurring subscription billing engine.",
    requirements: [
      {
        type: "feature",
        priority: "critical",
        title: "Accurate proration",
        description: "Mid-cycle plan changes are prorated to the day.",
        sentence: "Billing is critical and must prorate mid-cycle plan changes to the day.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Dunning retries",
        description: "Failed payments are retried on a configurable dunning schedule.",
        sentence: "The engine must retry failed payments on a configurable dunning schedule.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Tax calculation",
        description: "Invoices should include jurisdiction-aware tax calculation.",
        sentence: "Invoices should include jurisdiction-aware tax calculation for each line item.",
      },
      {
        type: "chore",
        priority: "low",
        title: "Archive legacy invoices",
        description: "Invoices older than seven years may be archived to cold storage.",
        sentence: "Invoices older than seven years may be archived to cold storage.",
      },
    ],
  },
  {
    id: "brd-02-compliance",
    title: "Data Compliance Requirements",
    docType: "brd",
    overview: "Regulatory data-handling requirements for the platform.",
    requirements: [
      {
        type: "feature",
        priority: "critical",
        title: "Right to erasure",
        description: "Personal data is erased within thirty days of a verified request.",
        sentence:
          "The platform must erase personal data within thirty days of a verified erasure request.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Audit trail",
        description: "All access to sensitive records is recorded in an immutable audit trail.",
        sentence: "All access to sensitive records must be recorded in an immutable audit trail.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Regional data residency",
        description: "Customer data is stored in the customer's selected region.",
        sentence: "Customer data must be stored in the region selected by the customer.",
      },
    ],
  },
  {
    id: "brd-03-onboarding",
    title: "Merchant Onboarding Requirements",
    docType: "brd",
    overview: "Business requirements for onboarding new merchants to the marketplace.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Identity verification",
        description: "New merchants complete identity verification before listing.",
        sentence:
          "New merchants must complete identity verification before they can list products.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Guided setup checklist",
        description: "Merchants should be guided by a setup checklist during onboarding.",
        sentence: "Merchants should be guided by a setup checklist during the onboarding flow.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Payout account linking",
        description: "Merchants link a verified payout account to receive funds.",
        sentence: "Merchants must link a verified payout account before they can receive funds.",
      },
      {
        type: "feature",
        priority: "low",
        title: "Sandbox catalog",
        description: "Merchants may explore a sandbox catalog before going live.",
        sentence: "Merchants may optionally explore a sandbox catalog before going live.",
      },
    ],
  },
  {
    id: "brd-04-support",
    title: "Customer Support Requirements",
    docType: "brd",
    overview: "Requirements for the omnichannel customer support desk.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Unified ticket inbox",
        description: "Agents work tickets from email, chat, and phone in one inbox.",
        sentence:
          "Agents must be able to work tickets from email, chat, and phone in one unified inbox.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "SLA timers",
        description: "Tickets should display SLA timers based on priority.",
        sentence: "Tickets should display SLA timers calculated from the ticket priority.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Escalation routing",
        description: "Breached tickets are escalated to a senior queue automatically.",
        sentence: "Breached tickets must be escalated to a senior queue automatically.",
      },
    ],
  },
  {
    id: "brd-05-inventory",
    title: "Inventory Management Requirements",
    docType: "brd",
    overview: "Business requirements for multi-warehouse inventory management.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Realtime stock levels",
        description: "Stock levels are updated in realtime across warehouses.",
        sentence: "The system must update stock levels in realtime across all warehouses.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Low-stock alerts",
        description: "Planners should receive low-stock alerts below a threshold.",
        sentence:
          "Planners should receive low-stock alerts when quantity falls below a configured threshold.",
      },
      {
        type: "bug",
        priority: "high",
        title: "Fix oversell race",
        description: "A concurrency race that oversells the last unit is fixed.",
        sentence:
          "The service must fix the concurrency race that oversells the last available unit.",
      },
      {
        type: "feature",
        priority: "low",
        title: "Cycle-count export",
        description: "Planners may export a cycle-count worksheet weekly.",
        sentence: "Planners may export a cycle-count worksheet on a weekly basis.",
      },
    ],
  },
  {
    id: "us-01-profile",
    title: "User Story: Profile Editing",
    docType: "user-story",
    overview: "As a member, I want to manage my profile so my information stays current.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Edit display name",
        description: "A member updates their display name from the profile page.",
        sentence: "A member must be able to update their display name from the profile page.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Upload avatar",
        description: "A member should be able to upload a profile avatar image.",
        sentence: "A member should be able to upload a profile avatar image.",
      },
      {
        type: "feature",
        priority: "low",
        title: "Set pronouns",
        description: "A member may add pronouns shown next to their name.",
        sentence: "A member may optionally add pronouns that appear next to their name.",
      },
    ],
  },
  {
    id: "us-02-cart",
    title: "User Story: Shopping Cart",
    docType: "user-story",
    overview: "As a shopper, I want a reliable cart so I can purchase multiple items.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Add item to cart",
        description: "A shopper adds an item to the cart from the product page.",
        sentence: "A shopper must be able to add an item to the cart from the product page.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Update quantities",
        description: "A shopper updates item quantities within the cart.",
        sentence: "A shopper must be able to update item quantities within the cart.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Save cart for later",
        description: "A shopper should be able to save the cart for later.",
        sentence: "A shopper should be able to save the cart for later viewing.",
      },
    ],
  },
  {
    id: "us-03-watchlist",
    title: "User Story: Price Watchlist",
    docType: "user-story",
    overview: "As a buyer, I want a watchlist so I am told when prices drop.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Add to watchlist",
        description: "A buyer adds a product to a personal watchlist.",
        sentence: "A buyer must be able to add a product to a personal watchlist.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Price-drop alert",
        description: "A buyer is alerted when a watched price drops.",
        sentence: "The system must alert a buyer when a watched product's price drops.",
      },
      {
        type: "feature",
        priority: "low",
        title: "Share watchlist",
        description: "A buyer may share a watchlist with a friend.",
        sentence: "A buyer may optionally share a watchlist with a friend.",
      },
    ],
  },
  {
    id: "us-04-reviews",
    title: "User Story: Product Reviews",
    docType: "user-story",
    overview: "As a customer, I want to review products so others can decide.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Submit a review",
        description: "A customer submits a star rating and written review.",
        sentence: "A customer must be able to submit a star rating and a written review.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Edit a review",
        description: "A customer should be able to edit a review they posted.",
        sentence: "A customer should be able to edit a review they previously posted.",
      },
      {
        type: "bug",
        priority: "high",
        title: "Fix duplicate submissions",
        description: "A defect that posts duplicate reviews on retry is fixed.",
        sentence:
          "The service must fix the defect that posts duplicate reviews when a submission is retried.",
      },
    ],
  },
  {
    id: "us-05-orders",
    title: "User Story: Order Tracking",
    docType: "user-story",
    overview: "As a customer, I want to track orders so I know when to expect them.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "View order status",
        description: "A customer views the current status of an order.",
        sentence: "A customer must be able to view the current status of any order.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Delivery estimate",
        description: "A customer should see an estimated delivery date.",
        sentence: "A customer should see an estimated delivery date for each shipment.",
      },
      {
        type: "feature",
        priority: "low",
        title: "Reorder past purchase",
        description: "A customer may reorder a previous purchase in one click.",
        sentence: "A customer may reorder a previous purchase with a single click.",
      },
    ],
  },
  {
    id: "prd-06-mobile-offline",
    title: "Mobile Offline Mode",
    docType: "prd",
    overview: "Defines offline behaviour for the mobile application.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Offline read access",
        description: "Users read previously loaded content while offline.",
        sentence: "The app must allow users to read previously loaded content while offline.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Queue offline actions",
        description: "Actions taken offline should be queued and synced later.",
        sentence: "Actions taken offline should be queued and synced when connectivity returns.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Conflict resolution",
        description: "Sync conflicts are resolved with a last-writer-wins policy.",
        sentence: "The sync engine must resolve conflicts using a last-writer-wins policy.",
      },
    ],
  },
  {
    id: "prd-07-admin-roles",
    title: "Administrative Roles and Permissions",
    docType: "prd",
    overview: "Scope for granular administrative roles and permissions.",
    requirements: [
      {
        type: "feature",
        priority: "critical",
        title: "Least-privilege roles",
        description: "Administrators are granted least-privilege scoped roles.",
        sentence: "The platform must grant administrators least-privilege scoped roles by default.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Custom role builder",
        description: "Owners build custom roles from a permission catalog.",
        sentence: "Owners must be able to build custom roles from a permission catalog.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Role change audit",
        description: "Role changes should be written to the audit log.",
        sentence: "Role changes should be written to the audit log with the actor and timestamp.",
      },
    ],
  },
  {
    id: "brd-06-returns",
    title: "Returns and Refunds Requirements",
    docType: "brd",
    overview: "Business requirements for the returns and refunds workflow.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Initiate a return",
        description: "Customers initiate a return within the return window.",
        sentence: "Customers must be able to initiate a return within the published return window.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Automated refund",
        description: "Approved returns trigger an automated refund to the original method.",
        sentence:
          "Approved returns must trigger an automated refund to the original payment method.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Return label generation",
        description: "The system should generate a prepaid return label.",
        sentence: "The system should generate a prepaid return label for each approved return.",
      },
      {
        type: "chore",
        priority: "low",
        title: "Migrate return reasons",
        description: "Legacy return reason codes may be migrated to the new taxonomy.",
        sentence: "Legacy return reason codes may be migrated to the new taxonomy over time.",
      },
    ],
  },
  {
    id: "us-06-messaging",
    title: "User Story: In-App Messaging",
    docType: "user-story",
    overview: "As a user, I want in-app messaging so I can reach support quickly.",
    requirements: [
      {
        type: "feature",
        priority: "high",
        title: "Start a conversation",
        description: "A user starts a support conversation from any screen.",
        sentence: "A user must be able to start a support conversation from any screen.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Attach a screenshot",
        description: "A user should be able to attach a screenshot to a message.",
        sentence: "A user should be able to attach a screenshot to a support message.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Delivery receipts",
        description: "Messages display delivery and read receipts.",
        sentence: "The messaging surface must display delivery and read receipts for each message.",
      },
    ],
  },
  {
    id: "prd-08-accessibility",
    title: "Accessibility Compliance",
    docType: "prd",
    overview: "Accessibility requirements aligning the product with WCAG AA.",
    requirements: [
      {
        type: "feature",
        priority: "critical",
        title: "Keyboard navigation",
        description: "All interactive controls are reachable by keyboard.",
        sentence: "Every interactive control must be reachable and operable by keyboard alone.",
      },
      {
        type: "feature",
        priority: "high",
        title: "Screen-reader labels",
        description: "Controls expose descriptive labels to screen readers.",
        sentence: "Controls must expose descriptive labels to assistive screen readers.",
      },
      {
        type: "feature",
        priority: "medium",
        title: "Reduced-motion mode",
        description: "Users should be able to enable a reduced-motion mode.",
        sentence: "Users should be able to enable a reduced-motion mode that limits animation.",
      },
    ],
  },
];

function slugTypeTag(r) {
  return `${r.type}/${r.priority}`;
}

function renderDoc(item) {
  const lines = [];
  lines.push(`# ${item.title}`);
  lines.push("");
  lines.push(
    "> Original synthetic document authored for the METIS Domain Eval golden corpus (CC0-1.0).",
  );
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(item.overview);
  lines.push("");
  lines.push("## Requirements");
  lines.push("");
  for (const r of item.requirements) {
    lines.push(`- ${r.sentence}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderExpected(item) {
  return item.requirements.map((r, i) => ({
    id: `R${i + 1}`,
    type: r.type,
    title: r.title,
    description: r.description,
    priority: r.priority,
  }));
}

/**
 * Epic #712 / Issue #717 — self-contained code-graph citation eval fixture.
 *
 * The BA-pipeline golden corpus above proves requirements EXTRACTION. This
 * separate fixture proves the epic's other promise: a project-scoped question
 * about a KNOWN symbol returns a citable `filePath:startLine-endLine` answer
 * sourced from the code graph (fused retrieval #714 + chat code-search tool
 * #713 + citation rendering #715), never a reconstruction.
 *
 * It is deliberately SELF-CONTAINED (review note 2026-07-08): the `repo/` files
 * below are a synthesized micro-repo with known symbols. The eval + unit tests
 * parse them DETERMINISTICALLY with METIS's own `parseSource`, build an
 * in-memory code graph / symbol index, and DERIVE the expected locator from the
 * resulting `CodeSymbol` record — so there is NO dependency on any externally
 * ingested repo, no DB, and no network. `codegraph.json` names only the target
 * symbol + the question; it never hardcodes the file:line (that is derived).
 *
 * This item lives in its own directory with a `codegraph.json` descriptor and
 * NO `expected.json`, so the domain-eval corpus loader (which keys on
 * `expected.json`) silently skips it and the domain `manifest.json` — validated
 * by a strict `docType` enum — is left untouched.
 */
const CODEGRAPH_FIXTURE = {
  id: "codegraph-01-citation",
  title: "Code-graph citation grounding",
  kind: "code-graph-citation",
  question:
    "How is the payment processing fee calculated? Point me at the calculateProcessingFee function and cite the exact source location.",
  target: {
    name: "calculateProcessingFee",
    filePath: "payments/fee-calculator.ts",
    language: "ts",
    kind: "function",
  },
  // Substrings that a grounded, code-graph-cited answer must NOT contain — the
  // "I made this up from memory" tells the epic is guarding against.
  forbiddenDisclaimers: [
    "reconstructed from the knowledge base",
    "reconstructed from my knowledge",
    "based on my general knowledge",
  ],
  note: "Self-contained fixture: repo/ files are parsed by METIS's parseSource to build the code graph; the expected filePath:startLine-endLine is derived from the resulting CodeSymbol record, never hardcoded. No external-repo ingestion, no network.",
  files: {
    "payments/fee-calculator.ts": [
      "/**",
      " * Fee calculation for the payments domain (METIS code-graph eval fixture).",
      " */",
      "export interface FeeSchedule {",
      "  percentage: number;",
      "  flatCents: number;",
      "}",
      "",
      "export function calculateProcessingFee(amountCents, schedule) {",
      "  const variableCents = Math.round(amountCents * schedule.percentage);",
      "  return variableCents + schedule.flatCents;",
      "}",
      "",
      "export class RefundPolicy {",
      "  isRefundable(daysSincePurchase) {",
      "    return daysSincePurchase <= 30;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "orders/order-repository.py": [
      '"""Order persistence for the code-graph eval fixture."""',
      "",
      "",
      "class OrderRepository:",
      "    def find_by_id(self, order_id):",
      "        return self._rows.get(order_id)",
      "",
      "",
      "def summarize_orders(orders):",
      "    return len(orders)",
      "",
    ].join("\n"),
  },
};

async function buildCodegraphFixture() {
  const dir = path.join(CORPUS_DIR, CODEGRAPH_FIXTURE.id);
  await mkdir(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(CODEGRAPH_FIXTURE.files)) {
    const abs = path.join(dir, "repo", relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const descriptor = {
    id: CODEGRAPH_FIXTURE.id,
    title: CODEGRAPH_FIXTURE.title,
    kind: CODEGRAPH_FIXTURE.kind,
    question: CODEGRAPH_FIXTURE.question,
    target: CODEGRAPH_FIXTURE.target,
    forbiddenDisclaimers: CODEGRAPH_FIXTURE.forbiddenDisclaimers,
    note: CODEGRAPH_FIXTURE.note,
  };
  await writeFile(
    path.join(dir, "codegraph.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
    "utf8",
  );
  return Object.keys(CODEGRAPH_FIXTURE.files).length;
}

async function main() {
  await rm(CORPUS_DIR, { recursive: true, force: true });
  await mkdir(CORPUS_DIR, { recursive: true });
  const manifestItems = [];
  for (const item of ITEMS) {
    const dir = path.join(CORPUS_DIR, item.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "source.md"), renderDoc(item), "utf8");
    await writeFile(
      path.join(dir, "expected.json"),
      `${JSON.stringify(renderExpected(item), null, 2)}\n`,
      "utf8",
    );
    manifestItems.push({
      id: item.id,
      title: item.title,
      docType: item.docType,
      source: "original-synthetic",
      license: "CC0-1.0",
    });
  }
  const manifest = { version: 1, items: manifestItems };
  await writeFile(
    path.join(__dirname, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const codegraphFiles = await buildCodegraphFixture();
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${ITEMS.length} corpus items (${manifestItems.length} manifest entries) ` +
      `+ 1 code-graph citation fixture (${codegraphFiles} synthesized source files).`,
  );
  void slugTypeTag;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

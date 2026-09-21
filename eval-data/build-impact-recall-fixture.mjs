/**
 * Epic #929 / Issue #930 (baseline) + Issue #939 (LAYERED rework) — labeled
 * requirement→(code, tables) recall eval fixture generator for METIS Impact
 * Analysis.
 *
 * Materialises the committed, license-clean JPetStore-6-style fixture under
 * `eval-data/corpus/impact-recall-01-jpetstore/manifest.json`. As of #939 the
 * fixture is a REPRESENTATIVE, **LAYERED** JPetStore-6 graph — domain →
 * service → web-action → mapper — not a mapper-only corpus. The manifest is a
 * fully hand-authored, self-contained code+schema graph:
 *
 *   - DOMAIN model classes   (`org.jpetstore.domain.*`)          — corpus symbols
 *   - SERVICE classes        (`org.jpetstore.service.*`)         — corpus symbols
 *   - WEB-ACTION classes     (`org.jpetstore.web.actions.*`)     — corpus symbols
 *   - MAPPER methods         (`org.jpetstore.persistence.*`)     — corpus symbols
 *   - MyBatis statement symbols (schema-only, never terminal objects)
 *   - tables, and the `calls`/`executes`/`reads`/`writes` edges that connect them.
 *
 * WHY LAYERED (the #939 fix): the original #930 fixture modelled ONLY the
 * persistence/mapper layer, so its BM25 corpus contained just mapper methods and
 * it had NO `calls` edges. That made the harness artificially clean (tblR≈1.00,
 * tblP≈0.42) — it OVERSTATED precision/recall vs the live-ingested JPetStore-6
 * project, which returned wrong/tangential tables for the same requirements
 * (#939 evidence). The layered application code is exactly where the two real
 * failure modes live:
 *
 *   (a) BM25 SEED POLLUTION — domain/service/web-action symbols share entity
 *       tokens ("account", "product", "status") with the mapper methods and can
 *       OUT-RANK or DISPLACE the right mapper in the seed set; and
 *   (b) DOWNSTREAM FAN-OUT — a web-action/service pulled into the (upstream)
 *       blast radius fans out over `calls` edges to MANY mappers → MANY tables →
 *       over-broad / wrong table sets.
 *
 * All added layer symbols are `inCorpus: true` so they participate in BM25
 * ranking (seed pollution) and the `calls` edges wire web-action → service →
 * mapper (and service → service) so the schema crossing fans out just like a
 * real ingested project. The existing mapper →(executes)→ statement
 * →(reads/writes)→ table chain is kept intact.
 *
 * Modelled on `eval-data/build-fixtures.mjs`. Unlike that script it is NON-
 * destructive: it writes ONLY its own fixture directory, never `rm`-ing the
 * shared corpus. Run with (the prettier pass collapses short arrays back to the
 * committed style; JSON.stringify expands them, so skipping it produces churn):
 *
 *   node eval-data/build-impact-recall-fixture.mjs
 *   npx prettier --write eval-data/corpus/impact-recall-01-jpetstore/manifest.json
 *
 * The committed `manifest.json` is the artifact under test; this generator is
 * kept so the curation is reproducible and reviewable.
 *
 * NAME CONVENTION (#1016): code symbols use the PRODUCTION `path/File.java::Type::member`
 * shape ingest emits (verified by `name-convention.ts`); MyBatis statement symbols keep
 * their dotted `<namespace>.<statement>` SQL namespace; tables/columns use the bare
 * `schema-graph.ts` tableQualifiedName/columnQualifiedName form. Row `id`s remain the
 * slug of the legacy dotted name, stable across the #1016 qualified-name migration.
 *
 * COLUMNS (#1029): every table also emits its real JPetStore-6 columns as `kind:"column"`
 * schema rows. They carry NO edges, so they are inert to the crossing and to
 * `buildEntityVocabulary` (which skips `column` kinds) — the deterministic table scores
 * are unchanged — and exist solely to feed the column-informed table-relevance judge.
 *
 * Why a synthesized graph (not an ingested repo): the schema graph (tables +
 * `reads`/`writes` edges) is produced by MyBatis/ORM ingest, which the offline
 * eval parser does not run. Hand-authoring the graph keeps the fixture fully
 * deterministic AND lets us model the exact `code →(calls)→ service →(calls)→
 * mapper →(executes)→ statement →(reads/writes)→ table` chain the #928 crossing
 * walks. No DB, no network, no live LLM.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "corpus", "impact-recall-01-jpetstore");

const PKG_PERSISTENCE = "org.jpetstore.persistence";
const PKG_SERVICE = "org.jpetstore.service";
const PKG_WEB = "org.jpetstore.web.actions";
const PKG_DOMAIN = "org.jpetstore.domain";

/**
 * ── Layer 4: the data-access layer ───────────────────────────────────────────
 * Each mapper method declares the tables its MyBatis statement reads/writes. The
 * generator expands every method into a mapper-method symbol (in the BM25 corpus)
 * + a `language=sql` statement symbol (schema-only, never a terminal object)
 * joined by an `executes` edge, and the statement's `reads`/`writes` edges to the
 * named tables. #939 adds `orderstatus` + `sequence` — tables the LIVE project
 * surfaces on the checkout path (order-status row + the SEQUENCE id allocator).
 */
const MAPPERS = {
  AccountMapper: {
    file: "persistence/AccountMapper.java",
    methods: {
      getAccountByUsername: { reads: ["account", "profile", "signon"] },
      // Lean billing lookup (account row only) — the order write-path resolves the
      // billing account through this, so checkout surfaces `account` WITHOUT the
      // profile/signon join, matching the LIVE checkout evidence set.
      getAccount: { reads: ["account"] },
      updateAccount: { writes: ["account"] },
      insertAccount: { writes: ["account", "profile", "signon"] },
    },
  },
  SignonMapper: {
    file: "persistence/SignonMapper.java",
    methods: {
      getSignon: { reads: ["signon"] },
      login: { reads: ["signon"] },
    },
  },
  ProductMapper: {
    file: "persistence/ProductMapper.java",
    methods: {
      getProduct: { reads: ["product"] },
      getProductListByCategory: { reads: ["product", "category"] },
      searchProductList: { reads: ["product"] },
      updateProduct: { writes: ["product"] },
      insertProduct: { writes: ["product"] },
    },
  },
  CategoryMapper: {
    file: "persistence/CategoryMapper.java",
    methods: {
      getCategory: { reads: ["category"] },
      getCategoryList: { reads: ["category"] },
      insertCategory: { writes: ["category"] },
      updateCategory: { writes: ["category"] },
    },
  },
  ItemMapper: {
    file: "persistence/ItemMapper.java",
    methods: {
      getItem: { reads: ["item", "inventory"] },
      getItemListByProduct: { reads: ["item", "product"] },
      updateItem: { writes: ["item"] },
    },
  },
  InventoryMapper: {
    file: "persistence/InventoryMapper.java",
    methods: {
      getInventoryQuantity: { reads: ["inventory"] },
      updateInventory: { writes: ["inventory"] },
    },
  },
  OrderMapper: {
    file: "persistence/OrderMapper.java",
    methods: {
      getOrder: { reads: ["orders", "lineitem", "account"] },
      getOrdersByUsername: { reads: ["orders", "account"] },
      insertOrder: { writes: ["orders"] },
      insertLineItem: { writes: ["lineitem"] },
      insertOrderStatus: { writes: ["orderstatus"] },
    },
  },
  SequenceMapper: {
    file: "persistence/SequenceMapper.java",
    methods: {
      getSequence: { reads: ["sequence"] },
      getNextId: { reads: ["sequence"], writes: ["sequence"] },
    },
  },
};

const TABLE_NAMES = [
  "account",
  "profile",
  "signon",
  "product",
  "category",
  "item",
  "inventory",
  "orders",
  "lineitem",
  "orderstatus",
  "sequence",
];

/**
 * ── Real JPetStore-6 table COLUMNS (#1029) ───────────────────────────────────
 * Per-table column lists from the canonical JPetStore-6 DDL — the DISAMBIGUATING
 * SIGNAL the #1029 column-informed table-relevance judge reads. A loyalty
 * requirement citing "saved billing and delivery details" maps to account
 * (addr1/city/state/zip/country/phone) and the orders bill/ship snapshot, NOT to
 * profile (langpref/favcategory, no address) — the ambiguity every NAME-only
 * recall lever lost.
 *
 * Emitted as kind:"column" schema rows (qualifiedName <table>.<column> via
 * schema-graph.ts columnQualifiedName, #1016). They carry NO edges, so the #928
 * crossing never reaches them and the deterministic table scores are unchanged;
 * buildEntityVocabulary also skips column kinds. Their sole role is to give the
 * judge real columns per candidate table.
 */
const COLUMNS = {
  account: [
    "userid",
    "email",
    "firstname",
    "lastname",
    "status",
    "addr1",
    "addr2",
    "city",
    "state",
    "zip",
    "country",
    "phone",
  ],
  profile: ["userid", "langpref", "favcategory", "mylistopt", "banneropt"],
  signon: ["username", "password"],
  product: ["productid", "category", "name", "descn"],
  category: ["catid", "name", "descn"],
  item: [
    "itemid",
    "productid",
    "listprice",
    "unitcost",
    "supplier",
    "status",
    "attr1",
    "attr2",
    "attr3",
    "attr4",
    "attr5",
  ],
  inventory: ["itemid", "qty"],
  orders: [
    "orderid",
    "userid",
    "orderdate",
    "shipaddr1",
    "shipaddr2",
    "shipcity",
    "shipstate",
    "shipzip",
    "shipcountry",
    "billaddr1",
    "billaddr2",
    "billcity",
    "billstate",
    "billzip",
    "billcountry",
    "courier",
    "totalprice",
    "billtofirstname",
    "billtolastname",
    "shiptofirstname",
    "shiptolastname",
    "creditcard",
    "exprdate",
    "cardtype",
    "locale",
  ],
  lineitem: ["orderid", "linenum", "itemid", "quantity", "unitprice"],
  orderstatus: ["orderid", "linenum", "timestamp", "status"],
  sequence: ["name", "nextid"],
};

/**
 * ── Layer 0: documentation NOISE rows (#1003) ────────────────────────────────
 * High-ranking JPetStore xdoc/index.xml documentation pages that share checkout/
 * order tokens with the mappers. They sit in the BM25 corpus (competing for seed
 * slots) but are module-kind XML files the entity-vocabulary + #1003 documentation
 * filter must EXCLUDE — a union that re-seeds them is a measurable code-precision
 * regression. Reproduced here so regeneration keeps the #1003 guard exercised.
 */
const DOC_NOISE_NAME = "Cancel Order Order Status Shipping Order Checkout";
const DOC_NOISE = [
  { id: "site_xdoc_index_en", path: "src/site/xdoc/index.xml" },
  { id: "site_xdoc_index_es", path: "src/site/es/xdoc/index.xml" },
  { id: "site_xdoc_index_ja", path: "src/site/ja/xdoc/index.xml" },
  { id: "site_xdoc_index_ko", path: "src/site/ko/xdoc/index.xml" },
];

/**
 * ── Layer 1: domain model classes ────────────────────────────────────────────
 * Plain entity classes in the BM25 corpus. They own NO schema or call edges (a
 * domain object is a graph leaf), so their sole role is SEED POLLUTION: they
 * carry the entity token ("account", "product", …) and compete with the mapper
 * methods for the top BM25 slot, exactly like a real ingested project.
 */
const DOMAIN_CLASSES = [
  "Account",
  "Profile",
  "Signon",
  "Product",
  "Category",
  "Item",
  "Inventory",
  "Order",
  "LineItem",
  "Cart",
  "CartItem",
  "Sequence",
];

/**
 * ── Layer 1b: Stripes form/DTO beans ─────────────────────────────────────────
 * A real Stripes/MVC JPetStore carries a form-bean + DTO layer beside the domain
 * model. Like the domain classes these are corpus-only graph leaves (no edges),
 * so their role is purely SEED POLLUTION — they raise the document-frequency of
 * the entity tokens ("account", "product", …), which LOWERS each token's BM25
 * IDF. The effect reproduces the #939 headline failure: for a vaguely-worded
 * "Add a <flag> to <entity>" requirement, the spuriously-matched high-IDF
 * "add"/"to" web-action seed (`addItemToCart`) DISPLACES the now-diluted entity
 * mapper methods below the seed-confidence floor, so the entity's own table is
 * MISSED and only the pollution/fan-out tables (inventory, item) survive — just
 * as the live-ingested project returned "inventory only" for product/account.
 */
const FORM_BEANS = [
  "AccountBean",
  "AccountForm",
  // The catalog is the largest UI surface in JPetStore, so the product view/DTO
  // layer is correspondingly bean-heavy — enough to dilute the "product" token's
  // IDF so the vague REQ-01 ("Add a discontinued flag to product") loses its
  // product mapper seed to the "add…to" pollution and MISSES the product table.
  "ProductBean",
  "ProductForm",
  "ProductView",
  "ProductSummary",
  "ProductDetailBean",
  "ItemBean",
  "ItemForm",
  "OrderBean",
  "OrderForm",
  "CategoryBean",
  "CartBean",
];

/**
 * ── Layer 3: service classes ─────────────────────────────────────────────────
 * Business-logic methods in the BM25 corpus. Each `calls` one or more mapper
 * methods (or other services). `getInventoryStatus` is deliberately the ONLY
 * service that carries the rare "status" token AND routes to the inventory
 * mapper — it is the seed-pollution engine behind the #939 "add a status flag to
 * account" → inventory failure (a rare high-IDF token displacing the account
 * mappers). Method → callee mapper/service qualifiedNames listed in `calls`.
 */
const SERVICES = {
  AccountService: {
    file: "service/AccountService.java",
    methods: {
      getAccount: { calls: ["AccountMapper.getAccount"] },
      updateAccount: { calls: ["AccountMapper.updateAccount"] },
      insertAccount: { calls: ["AccountMapper.insertAccount"] },
    },
  },
  CatalogService: {
    file: "service/CatalogService.java",
    methods: {
      getProduct: { calls: ["ProductMapper.getProduct"] },
      getProductListByCategory: { calls: ["ProductMapper.getProductListByCategory"] },
      getCategory: { calls: ["CategoryMapper.getCategory"] },
      getCategoryList: { calls: ["CategoryMapper.getCategoryList"] },
      getItem: { calls: ["ItemMapper.getItem"] },
      getItemListByProduct: { calls: ["ItemMapper.getItemListByProduct"] },
      isItemInStock: { calls: ["InventoryMapper.getInventoryQuantity"] },
      updateQuantity: { calls: ["InventoryMapper.updateInventory"] },
      getInventoryStatus: { calls: ["InventoryMapper.getInventoryQuantity"] },
    },
  },
  OrderService: {
    file: "service/OrderService.java",
    methods: {
      getOrder: { calls: ["OrderMapper.getOrder"] },
      getOrdersByUsername: { calls: ["OrderMapper.getOrdersByUsername"] },
      getNextId: { calls: ["SequenceMapper.getNextId"] },
      // The checkout write path — fans out to orders, orderstatus, sequence (the
      // id allocator) and account (billing lookup). This fan-out is what makes the
      // LIVE checkout result noisy (#939 evidence: account, orders, orderstatus,
      // sequence) — notably WITHOUT the lineitem the requirement actually wants,
      // so REQ-07 records a genuine over-broad+partial-miss result.
      insertOrder: {
        calls: [
          "OrderMapper.insertOrder",
          "OrderMapper.insertOrderStatus",
          "SequenceMapper.getNextId",
          "AccountService.getAccount",
        ],
      },
    },
  },
};

/**
 * ── Layer 2: web-action classes (Stripes ActionBeans) ────────────────────────
 * Controller entry points in the BM25 corpus. Each `calls` one or more services.
 * A web-action pulled UP into the blast radius (because it transitively calls a
 * seeded mapper) then fans DOWN over these `calls` edges to every mapper it
 * reaches — the downstream fan-out that over-broadens the surfaced table set.
 */
const WEB_ACTIONS = {
  AccountActionBean: {
    file: "web/actions/AccountActionBean.java",
    methods: {
      newAccount: { calls: ["AccountService.insertAccount"] },
      editAccount: { calls: ["AccountService.updateAccount"] },
      signon: { calls: ["AccountService.getAccount"] },
    },
  },
  CartActionBean: {
    file: "web/actions/CartActionBean.java",
    methods: {
      addItemToCart: { calls: ["CatalogService.getItem", "CatalogService.isItemInStock"] },
      viewCart: { calls: ["CatalogService.getItem"] },
      checkout: { calls: ["OrderService.insertOrder"] },
    },
  },
  CatalogActionBean: {
    file: "web/actions/CatalogActionBean.java",
    methods: {
      viewProduct: { calls: ["CatalogService.getProduct", "CatalogService.getItemListByProduct"] },
      viewCategory: {
        calls: ["CatalogService.getCategory", "CatalogService.getProductListByCategory"],
      },
      viewItem: { calls: ["CatalogService.getItem", "CatalogService.getInventoryStatus"] },
      searchProducts: { calls: ["CatalogService.getProductListByCategory"] },
    },
  },
  OrderActionBean: {
    file: "web/actions/OrderActionBean.java",
    methods: {
      newOrder: { calls: ["OrderService.insertOrder"] },
      newOrderForm: { calls: ["OrderService.getNextId", "AccountService.getAccount"] },
      viewOrder: { calls: ["OrderService.getOrder"] },
      listOrders: { calls: ["OrderService.getOrdersByUsername"] },
    },
  },
};

/**
 * Labeled requirements. `expectedTables` is the PRIMARY signal (the ground truth
 * this harness scores table recall/precision against); `expectedCodeSymbols` is
 * the simple method name the mapping is expected to seed. Wording deliberately
 * ranges from entity-named ("...to product") to vaguer business phrasing
 * ("Compute the checkout total...") so the measured precision reflects the real
 * over-broad / wrong-table behaviour the harness exists to drive down. Three of
 * these mirror the #939 live-evidence rows (REQ-01 product, REQ-03 account,
 * REQ-07 checkout) and now reproduce the live failure modes.
 */
const REQUIREMENTS = [
  {
    id: "REQ-01",
    text: "Add a discontinued flag to product",
    expectedTables: ["product"],
    expectedCodeSymbols: ["updateProduct"],
  },
  {
    id: "REQ-02",
    text: "Store a shipping method on each order",
    expectedTables: ["orders"],
    expectedCodeSymbols: ["insertOrder"],
  },
  {
    id: "REQ-03",
    text: "Add a status flag to account",
    expectedTables: ["account"],
    expectedCodeSymbols: ["updateAccount"],
  },
  {
    id: "REQ-04",
    text: "Allow a customer to login and deactivate their account",
    expectedTables: ["account", "signon", "profile"],
    expectedCodeSymbols: ["getAccountByUsername"],
  },
  {
    id: "REQ-05",
    text: "Track inventory stock levels for each item",
    expectedTables: ["inventory", "item"],
    expectedCodeSymbols: ["updateInventory", "getItem"],
  },
  {
    id: "REQ-06",
    text: "Category management for the product catalog",
    expectedTables: ["category"],
    expectedCodeSymbols: ["getCategory", "updateCategory"],
  },
  {
    id: "REQ-07",
    text: "Compute the checkout total for an order",
    expectedTables: ["orders", "lineitem"],
    expectedCodeSymbols: ["getOrder"],
  },
  {
    id: "REQ-08",
    text: "Update product details in the catalog",
    expectedTables: ["product"],
    expectedCodeSymbols: ["updateProduct"],
  },
  {
    id: "REQ-09",
    text: "List items by product for the storefront",
    expectedTables: ["item", "product"],
    expectedCodeSymbols: ["getItemListByProduct"],
  },
  {
    id: "REQ-10",
    text: "Place an order with line items from the cart",
    expectedTables: ["orders", "lineitem"],
    expectedCodeSymbols: ["insertOrder", "insertLineItem"],
  },
  {
    id: "REQ-11",
    text: "Introduce a loyalty programme: shoppers accumulate points whenever they complete a purchase, based on the value of that purchase, and may redeem accumulated points as a discount at checkout. The running points balance must be shown alongside the shopper's saved billing and delivery details.",
    expectedTables: ["account", "orders"],
    expectedCodeSymbols: ["updateAccount", "insertOrder"],
  },
];

/** Stable id slug from a fully-qualified name. */
function slug(qn) {
  return qn.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}

/**
 * Resolve a short callee reference (`ClassName.method`) written in the SERVICE /
 * WEB_ACTION `calls` lists to a fully-qualified name. The class name's package is
 * inferred from where the class is defined (mapper/service), so the authoring
 * stays terse while the emitted edges are fully qualified.
 */
function resolveCalleeQn(ref) {
  const [cls, method] = ref.split(".");
  const def = MAPPERS[cls] ?? SERVICES[cls] ?? WEB_ACTIONS[cls];
  if (!def) throw new Error(`Unresolved call target: ${ref}`);
  return `${def.file}::${cls}::${method}`;
}

function buildManifest() {
  const codeSymbols = [];
  const tables = [];
  const edges = [];

  for (const name of TABLE_NAMES) {
    tables.push({
      id: `table_${name}`,
      name,
      qualifiedName: name,
      kind: "table",
      source: "mybatis",
    });
  }

  // Column schema rows (#1029) — kind:"column", qualifiedName <table>.<column>
  // (schema-graph.ts columnQualifiedName). No edges: inert to the crossing and the
  // entity vocabulary, so the deterministic table scores are unchanged. They exist
  // solely to feed the #1029 column-informed table-relevance judge its columns.
  for (const [table, cols] of Object.entries(COLUMNS)) {
    for (const col of cols) {
      tables.push({
        id: `col_${table}_${col}`,
        name: col,
        qualifiedName: `${table}.${col}`,
        kind: "column",
        source: "mybatis",
      });
    }
  }

  // Layer 1 — domain model classes (corpus-only seed pollution, no edges).
  for (const cls of DOMAIN_CLASSES) {
    const dotted = `${PKG_DOMAIN}.${cls}`;
    const filePath = `domain/${cls}.java`;
    codeSymbols.push({
      id: slug(dotted),
      name: cls,
      qualifiedName: `${filePath}::${cls}`,
      kind: "class",
      filePath,
      language: "java",
      inCorpus: true,
    });
  }

  // Layer 1b — Stripes form/DTO beans (corpus-only seed pollution, no edges).
  for (const cls of FORM_BEANS) {
    const dotted = `org.jpetstore.web.beans.${cls}`;
    const filePath = `web/beans/${cls}.java`;
    codeSymbols.push({
      id: slug(dotted),
      name: cls,
      qualifiedName: `${filePath}::${cls}`,
      kind: "class",
      filePath,
      language: "java",
      inCorpus: true,
    });
  }

  // Layer 4 — mapper methods + MyBatis statement symbols + reads/writes edges.
  for (const [mapper, spec] of Object.entries(MAPPERS)) {
    for (const [method, io] of Object.entries(spec.methods)) {
      const dotted = `${PKG_PERSISTENCE}.${mapper}.${method}`;
      const methodQn = `${spec.file}::${mapper}::${method}`;
      const stmtQn = `${dotted}.statement`;
      // Mapper method — in the BM25 corpus (a code-change requirement seeds here).
      codeSymbols.push({
        id: slug(dotted),
        name: method,
        qualifiedName: methodQn,
        kind: "method",
        filePath: spec.file,
        language: "java",
        inCorpus: true,
      });
      // MyBatis statement symbol — schema-graph only, never a terminal object.
      codeSymbols.push({
        id: slug(stmtQn),
        name: `${method}.statement`,
        qualifiedName: stmtQn,
        kind: "method",
        filePath: spec.file.replace(/\.java$/, ".xml"),
        language: "sql",
        inCorpus: false,
      });
      // method →(executes)→ statement
      edges.push({ from: methodQn, to: stmtQn, kind: "executes" });
      // statement →(reads|writes)→ table
      for (const t of io.reads ?? []) edges.push({ from: stmtQn, to: t, kind: "reads" });
      for (const t of io.writes ?? []) edges.push({ from: stmtQn, to: t, kind: "writes" });
    }
  }

  // Layers 2 + 3 — service + web-action methods (corpus) and their `calls` edges.
  const layered = [
    { defs: SERVICES, pkg: PKG_SERVICE },
    { defs: WEB_ACTIONS, pkg: PKG_WEB },
  ];
  for (const { defs, pkg } of layered) {
    for (const [cls, spec] of Object.entries(defs)) {
      for (const [method, body] of Object.entries(spec.methods)) {
        const dotted = `${pkg}.${cls}.${method}`;
        const methodQn = `${spec.file}::${cls}::${method}`;
        codeSymbols.push({
          id: slug(dotted),
          name: method,
          qualifiedName: methodQn,
          kind: "method",
          filePath: spec.file,
          language: "java",
          inCorpus: true,
        });
        for (const ref of body.calls ?? []) {
          edges.push({ from: methodQn, to: resolveCalleeQn(ref), kind: "calls" });
        }
      }
    }
  }

  // Layer 0 — documentation noise rows (#1003): module-kind XML, in the BM25 corpus
  // but excluded by the entity-vocabulary + #1003 documentation filter. No edges.
  for (const doc of DOC_NOISE) {
    codeSymbols.push({
      id: doc.id,
      name: DOC_NOISE_NAME,
      qualifiedName: doc.path,
      kind: "module",
      filePath: doc.path,
      language: "xml",
      inCorpus: true,
    });
  }

  return {
    version: 1,
    id: "impact-recall-01-jpetstore",
    title: "JPetStore-6 requirement→(code, tables) impact recall fixture (layered)",
    kind: "impact-recall",
    license: "CC0-1.0",
    source: "original-synthetic",
    projectId: "impact-recall-eval-project",
    note: "Hand-authored, self-contained, LAYERED JPetStore-6-style code+schema graph for the Impact Analysis recall/precision eval (#930, layered in #939). Symbols/edges model the full domain →(–)→ web-action →(calls)→ service →(calls)→ mapper →(executes)→ statement →(reads/writes)→ table chain the #928 crossing walks, so BM25 seed pollution and downstream fan-out reproduce the live-ingested project's over-broad behaviour. No DB, no network, no live LLM. #1003 added four deliberately high-ranking `src/site/**/xdoc/index.xml` documentation rows as NOISE (they must never be seeded). #1002 added REQ-11, the VOCABULARY-MISMATCH regression case: a loyalty requirement written the way a business analyst writes one, naming the account entity only as 'the shopper's saved billing and delivery details' and the order entity only as 'a purchase', so neither noun is lexically present. Under deterministic BM25 it seeds on `checkout` alone and MISSES both expected tables (macro table recall 1.00 -> 0.91) - the defect reported on requirement 3 of epic #999. NOTE: the LITERAL phrasing ('...visible on the customer's account') does NOT reproduce the miss in this corpus, because `OrderMapper.getOrder.statement` reads `account` in a join, so any order-lexical seed reaches the table by FAN-OUT; the business-vocabulary phrasing is what isolates the seeding defect.",
    tables,
    codeSymbols,
    edges,
    requirements: REQUIREMENTS,
  };
}

async function main() {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const manifest = buildManifest();
  await writeFile(
    path.join(FIXTURE_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const corpusCount = manifest.codeSymbols.filter((s) => s.inCorpus).length;
  const callsCount = manifest.edges.filter((e) => e.kind === "calls").length;
  // eslint-disable-next-line no-console
  console.log(
    `Wrote LAYERED impact-recall fixture: ${manifest.codeSymbols.length} code symbols ` +
      `(${corpusCount} in BM25 corpus), ${manifest.tables.length} tables, ` +
      `${manifest.edges.length} edges (${callsCount} calls), ` +
      `${manifest.requirements.length} labeled requirements → ${FIXTURE_DIR}/manifest.json`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

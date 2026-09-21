import type { DocsGenFixture } from "./runner.js";

const singleRepoFiles = {
  orderService: [
    "export interface OrderInput {",
    "  customerId: string;",
    "  amountCents: number;",
    "}",
    "",
    "export class OrderService {",
    "  validate(input: OrderInput): void {",
    '    if (!input.customerId) throw new Error("customer required");',
    '    if (input.amountCents <= 0) throw new Error("amount required");',
    "  }",
    "",
    "  calculateTotal(input: OrderInput): number {",
    "    return input.amountCents;",
    "  }",
    "",
    "  queueFulfillment(orderId: string): string {",
    "    return `queued:${orderId}`;",
    "  }",
    "",
    "  create(input: OrderInput): string {",
    "    this.validate(input);",
    "    return this.queueFulfillment(`${input.customerId}:${this.calculateTotal(input)}`);",
    "  }",
    "}",
  ].join("\n"),
  paymentGateway: [
    "export class PaymentGateway {",
    "  authorize(amountCents: number): string {",
    "    return `auth:${amountCents}`;",
    "  }",
    "}",
  ].join("\n"),
};

const multiRepoFiles = {
  ordersApi: [
    "export class OrdersApi {",
    "  listOrders(): string[] {",
    '    return ["pending", "paid"];',
    "  }",
    "",
    "  describeHealth(): string {",
    '    return "orders api healthy";',
    "  }",
    "}",
  ].join("\n"),
  billingWorker: [
    "export class BillingWorker {",
    "  fetchInvoices(): string[] {",
    '    return ["invoice-1"];',
    "  }",
    "",
    "  enqueueSettlement(invoiceId: string): string {",
    "    return `settle:${invoiceId}`;",
    "  }",
    "",
    "  runCycle(): string {",
    '    return this.enqueueSettlement(this.fetchInvoices()[0] ?? "missing");',
    "  }",
    "}",
  ].join("\n"),
};

export const DOCS_GEN_BENCHMARK_FIXTURES: Record<string, DocsGenFixture> = {
  "docsgen-01-single-repo": {
    id: "docsgen-01-single-repo",
    mode: "single-repo",
    title: "Order Service Architecture",
    docType: "architecture",
    benchmarkReferenceCorpusId: "docsgen-01-single-repo",
    repositories: [
      {
        repoId: "orders-service",
        label: "orders-service",
        defaultBranch: "main",
        commit: "1111111111111111111111111111111111111111",
        files: [
          { path: "src/orders/OrderService.ts", content: singleRepoFiles.orderService },
          { path: "src/orders/PaymentGateway.ts", content: singleRepoFiles.paymentGateway },
        ],
        symbols: [
          {
            kind: "interface",
            qualifiedName: "orders.OrderInput",
            filePath: "src/orders/OrderService.ts",
            startLine: 1,
            endLine: 4,
            language: "typescript",
          },
          {
            kind: "class",
            qualifiedName: "orders.OrderService",
            filePath: "src/orders/OrderService.ts",
            startLine: 6,
            endLine: 24,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "orders.OrderService.validate",
            filePath: "src/orders/OrderService.ts",
            startLine: 7,
            endLine: 10,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "orders.OrderService.calculateTotal",
            filePath: "src/orders/OrderService.ts",
            startLine: 12,
            endLine: 14,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "orders.OrderService.queueFulfillment",
            filePath: "src/orders/OrderService.ts",
            startLine: 16,
            endLine: 18,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "orders.OrderService.create",
            filePath: "src/orders/OrderService.ts",
            startLine: 20,
            endLine: 23,
            language: "typescript",
          },
          {
            kind: "class",
            qualifiedName: "orders.PaymentGateway",
            filePath: "src/orders/PaymentGateway.ts",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        ],
        edges: [
          {
            kind: "calls",
            fromQualifiedName: "orders.OrderService.create",
            toQualifiedName: "orders.OrderService.validate",
            filePath: "src/orders/OrderService.ts",
            line: 21,
          },
          {
            kind: "calls",
            fromQualifiedName: "orders.OrderService.create",
            toQualifiedName: "orders.OrderService.queueFulfillment",
            filePath: "src/orders/OrderService.ts",
            line: 22,
          },
        ],
      },
    ],
  },
  "docsgen-02-multi-repo": {
    id: "docsgen-02-multi-repo",
    mode: "multi-repo",
    title: "Order Fulfillment Topology",
    docType: "architecture",
    benchmarkReferenceCorpusId: "docsgen-02-multi-repo",
    repositories: [
      {
        repoId: "orders-api",
        label: "orders-api",
        defaultBranch: "main",
        commit: "2222222222222222222222222222222222222222",
        files: [{ path: "src/api/OrdersApi.ts", content: multiRepoFiles.ordersApi }],
        symbols: [
          {
            kind: "class",
            qualifiedName: "api.OrdersApi",
            filePath: "src/api/OrdersApi.ts",
            startLine: 1,
            endLine: 8,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "api.OrdersApi.listOrders",
            filePath: "src/api/OrdersApi.ts",
            startLine: 2,
            endLine: 4,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "api.OrdersApi.describeHealth",
            filePath: "src/api/OrdersApi.ts",
            startLine: 6,
            endLine: 8,
            language: "typescript",
          },
        ],
      },
      {
        repoId: "billing-worker",
        label: "billing-worker",
        defaultBranch: "main",
        commit: "3333333333333333333333333333333333333333",
        files: [{ path: "src/worker/BillingWorker.ts", content: multiRepoFiles.billingWorker }],
        symbols: [
          {
            kind: "class",
            qualifiedName: "worker.BillingWorker",
            filePath: "src/worker/BillingWorker.ts",
            startLine: 1,
            endLine: 12,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "worker.BillingWorker.fetchInvoices",
            filePath: "src/worker/BillingWorker.ts",
            startLine: 2,
            endLine: 4,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "worker.BillingWorker.enqueueSettlement",
            filePath: "src/worker/BillingWorker.ts",
            startLine: 6,
            endLine: 8,
            language: "typescript",
          },
          {
            kind: "method",
            qualifiedName: "worker.BillingWorker.runCycle",
            filePath: "src/worker/BillingWorker.ts",
            startLine: 10,
            endLine: 12,
            language: "typescript",
          },
        ],
        edges: [
          {
            kind: "calls",
            fromQualifiedName: "worker.BillingWorker.runCycle",
            toQualifiedName: "worker.BillingWorker.fetchInvoices",
            filePath: "src/worker/BillingWorker.ts",
            line: 11,
          },
          {
            kind: "calls",
            fromQualifiedName: "worker.BillingWorker.runCycle",
            toQualifiedName: "worker.BillingWorker.enqueueSettlement",
            filePath: "src/worker/BillingWorker.ts",
            line: 11,
          },
        ],
      },
    ],
  },
};

export const DEFAULT_DOCS_GEN_BENCHMARK_FIXTURE_ID = "docsgen-01-single-repo";

export function listDocsGenBenchmarkFixtureIds(): string[] {
  return Object.keys(DOCS_GEN_BENCHMARK_FIXTURES).sort();
}

export function resolveDocsGenBenchmarkFixture(id: string): DocsGenFixture {
  const fixture = DOCS_GEN_BENCHMARK_FIXTURES[id];
  if (!fixture) {
    throw new Error(
      `unknown docs-gen benchmark fixture ${JSON.stringify(id)}. Expected one of: ${listDocsGenBenchmarkFixtureIds().join(", ")}`,
    );
  }
  return fixture;
}

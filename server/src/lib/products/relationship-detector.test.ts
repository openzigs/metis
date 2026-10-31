/**
 * Cross-repo relationship detector tests (Epic #544 / Issue #548).
 */
import { describe, expect, it } from "vitest";
import { detectRelationships, type RepoCrawlData } from "./relationship-detector.js";
import type { CrawlResult } from "./repo-crawler.js";

function makeCrawlResult(overrides: Partial<CrawlResult> = {}): CrawlResult {
  return {
    specs: [],
    routes: [],
    types: [],
    metadata: {
      repoConnectionId: "r1",
      filesScanned: 0,
      totalBytes: 0,
      crawledAt: new Date().toISOString(),
      duration: 0,
    },
    ...overrides,
  };
}

describe("relationship-detector", () => {
  describe("detectRelationships", () => {
    it("returns empty array when no repos provided", () => {
      const edges = detectRelationships([]);
      expect(edges).toEqual([]);
    });

    it("returns empty array for single repo", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "frontend",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult(),
        },
      ];
      const edges = detectRelationships(repos);
      expect(edges).toEqual([]);
    });
  });

  describe("API spec references", () => {
    it("detects when a spec references another repo by name", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "frontend",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "openapi",
                filePath: "openapi.yaml",
                content:
                  '{"paths":{"/api/data":{}}, "servers":[{"url":"https://backend-api.example.com"}]}',
              },
            ],
          }),
        },
        {
          repoConnectionId: "r2",
          repoName: "backend-api",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult(),
        },
      ];

      const edges = detectRelationships(repos);
      expect(edges.length).toBeGreaterThan(0);
      const edge = edges.find((e) => e.sourceRepoId === "r1" && e.targetRepoId === "r2");
      expect(edge).toBeDefined();
      expect(edge!.edgeType).toBe("calls");
      expect(edge!.confidence).toBe(0.95);
      // #1619 — an API spec reference crosses as a versioned contract.
      expect(edge).toMatchObject({
        integrationKind: "api",
        strength: "contract",
        direction: "consumes",
      });
      expect(edge!.resource).toBeUndefined();
    });
  });

  describe("shared types", () => {
    it("detects shared type names across repos", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "service-a",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            types: [
              {
                name: "UserDto",
                kind: "interface",
                filePath: "src/types/user.ts",
                exported: true,
              },
            ],
          }),
        },
        {
          repoConnectionId: "r2",
          repoName: "shared-types",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            types: [
              {
                name: "UserDto",
                kind: "interface",
                filePath: "packages/shared/user.ts",
                exported: true,
              },
            ],
          }),
        },
      ];

      const edges = detectRelationships(repos);
      expect(edges.length).toBeGreaterThan(0);
      const edge = edges.find((e) => e.edgeType === "imports");
      expect(edge).toBeDefined();
      expect(edge!.confidence).toBe(0.8);
      // #1619 — a shared type is a shared domain model.
      expect(edge).toMatchObject({
        integrationKind: "shared-library",
        strength: "model",
        direction: "depends-on",
      });
    });

    it("ignores non-exported types", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "service-a",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            types: [
              { name: "Internal", kind: "interface", filePath: "src/types/x.ts", exported: false },
            ],
          }),
        },
        {
          repoConnectionId: "r2",
          repoName: "service-b",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            types: [
              { name: "Internal", kind: "interface", filePath: "src/types/x.ts", exported: false },
            ],
          }),
        },
      ];
      const edges = detectRelationships(repos);
      expect(edges.filter((e) => e.edgeType === "imports")).toHaveLength(0);
    });
  });

  describe("route consumers", () => {
    it("detects when a spec references routes from another repo", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "backend",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            routes: [
              {
                method: "GET",
                path: "/api/users",
                filePath: "src/routes/users.ts",
                framework: "express",
              },
              {
                method: "POST",
                path: "/api/orders",
                filePath: "src/routes/orders.ts",
                framework: "express",
              },
            ],
          }),
        },
        {
          repoConnectionId: "r2",
          repoName: "frontend",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "openapi",
                filePath: "api-client.yaml",
                content: "paths:\n  /api/users:\n    get:\n      summary: Get users",
              },
            ],
          }),
        },
      ];

      const edges = detectRelationships(repos);
      const callEdge = edges.find(
        (e) => e.sourceRepoId === "r2" && e.targetRepoId === "r1" && e.edgeType === "calls",
      );
      expect(callEdge).toBeDefined();
      expect(callEdge!.confidence).toBe(0.75);
    });
  });

  describe("protobuf packages", () => {
    it("detects shared protobuf packages", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "service-a",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "protobuf",
                filePath: "proto/shared.proto",
                content:
                  'syntax = "proto3";\npackage com.org.events;\nmessage Event { string id = 1; }',
              },
            ],
          }),
        },
        {
          repoConnectionId: "r2",
          repoName: "service-b",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "protobuf",
                filePath: "proto/events.proto",
                content:
                  'syntax = "proto3";\npackage com.org.events;\nmessage EventHandler { string id = 1; }',
              },
            ],
          }),
        },
      ];

      const edges = detectRelationships(repos);
      const protoEdge = edges.find((e) => e.edgeType === "produces");
      expect(protoEdge).toBeDefined();
      expect(protoEdge!.confidence).toBe(0.9);
      expect(protoEdge).toMatchObject({ integrationKind: "api", strength: "contract" });
    });
  });

  describe("GraphQL references", () => {
    it("detects GraphQL type extensions across repos", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "users-service",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "graphql",
                filePath: "schema.graphql",
                content: "type User {\n  id: ID!\n  name: String!\n}",
              },
            ],
          }),
        },
        {
          repoConnectionId: "r2",
          repoName: "orders-service",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "graphql",
                filePath: "schema.graphql",
                content: "extend type User {\n  orders: [Order]\n}\ntype Order {\n  id: ID!\n}",
              },
            ],
          }),
        },
      ];

      const edges = detectRelationships(repos);
      const extendsEdge = edges.find((e) => e.edgeType === "extends");
      expect(extendsEdge).toBeDefined();
      expect(extendsEdge!.sourceRepoId).toBe("r2");
      expect(extendsEdge!.targetRepoId).toBe("r1");
      expect(extendsEdge!.confidence).toBe(0.85);
      expect(extendsEdge).toMatchObject({ integrationKind: "api", strength: "contract" });
    });
  });

  // #1619 — the two heuristics that go through a shared resource.
  describe("event topics", () => {
    const repo = (id: string, topics: NonNullable<CrawlResult["topics"]>): RepoCrawlData => ({
      repoConnectionId: id,
      repoName: id,
      ownerOrOrg: "org",
      crawlResult: makeCrawlResult({ topics }),
    });

    it("links a subscriber to the publisher of the same topic, through the topic", () => {
      const edges = detectRelationships([
        repo("pub", [
          {
            topic: "orders.created",
            role: "publish",
            filePath: "asyncapi.yaml",
            source: "asyncapi",
          },
        ]),
        repo("sub", [
          {
            topic: "orders.created",
            role: "subscribe",
            filePath: "src/c.ts",
            lineNumber: 4,
            source: "code",
          },
        ]),
      ]);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        sourceRepoId: "sub",
        targetRepoId: "pub",
        edgeType: "consumes",
        integrationKind: "event",
        strength: "contract",
        direction: "consumes",
        confidence: 0.9,
        resource: { kind: "topic", name: "orders.created" },
        sourceFile: "src/c.ts",
        targetFile: "asyncapi.yaml",
      });
      expect(edges[0].evidence.map((e) => e.pattern)).toEqual([
        "topic_client_call",
        "asyncapi_channel",
      ]);
    });

    it("is less confident with no AsyncAPI document on either side", () => {
      const edges = detectRelationships([
        repo("pub", [{ topic: "t", role: "publish", filePath: "a.ts", source: "code" }]),
        repo("sub", [{ topic: "t", role: "subscribe", filePath: "b.ts", source: "code" }]),
      ]);
      expect(edges[0].confidence).toBe(0.75);
    });

    it("prefers the AsyncAPI document as a side's evidence when code names the topic too", () => {
      const edges = detectRelationships([
        repo("pub", [
          { topic: "t", role: "publish", filePath: "a.ts", source: "code" },
          { topic: "t", role: "publish", filePath: "asyncapi.yaml", source: "asyncapi" },
        ]),
        repo("sub", [{ topic: "t", role: "subscribe", filePath: "b.ts", source: "code" }]),
      ]);
      expect(edges[0].targetFile).toBe("asyncapi.yaml");
    });

    it("draws nothing for a topic only one side names, or for a repo that talks to itself", () => {
      expect(
        detectRelationships([
          repo("a", [
            { topic: "t", role: "publish", filePath: "a.ts", source: "code" },
            { topic: "t", role: "subscribe", filePath: "a.ts", source: "code" },
          ]),
          repo("b", [{ topic: "other", role: "publish", filePath: "b.ts", source: "code" }]),
        ]),
      ).toEqual([]);
    });
  });

  describe("shared tables", () => {
    const repo = (
      id: string,
      tables: NonNullable<CrawlResult["tables"]>,
      codeGraphTables?: RepoCrawlData["codeGraphTables"],
    ): RepoCrawlData => ({
      repoConnectionId: id,
      repoName: id,
      ownerOrOrg: "org",
      crawlResult: makeCrawlResult({ tables }),
      codeGraphTables,
    });

    it("is intrusive from the writer when one side writes the table", () => {
      const edges = detectRelationships([
        repo("reader", [{ table: "orders", access: "read", filePath: "r.py", lineNumber: 2 }]),
        repo("writer", [{ table: "orders", access: "write", filePath: "w.sql" }]),
      ]);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        sourceRepoId: "writer",
        targetRepoId: "reader",
        edgeType: "produces",
        integrationKind: "database",
        strength: "intrusive",
        direction: "writes",
        resource: { kind: "table", name: "orders" },
      });
    });

    it("is model coupling when both only read it", () => {
      const edges = detectRelationships([
        repo("a", [{ table: "orders", access: "read", filePath: "a.sql" }]),
        repo("b", [{ table: "orders", access: "read", filePath: "b.sql" }]),
      ]);
      expect(edges[0]).toMatchObject({
        sourceRepoId: "a",
        targetRepoId: "b",
        edgeType: "consumes",
        strength: "model",
        direction: "reads",
      });
    });

    it("counts the code graph's tables, and a write there outranks a read in the crawl", () => {
      const edges = detectRelationships([
        repo(
          "a",
          [{ table: "orders", access: "read", filePath: "a.sql" }],
          [{ table: "orders", access: "write", filePath: "src/repo.go", lineNumber: 9 }],
        ),
        repo("b", [], [{ table: "orders", access: "read", filePath: "src/q.ts" }]),
      ]);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ sourceRepoId: "a", strength: "intrusive" });
      expect(edges[0].sourceFile).toBe("src/repo.go");
    });

    it("draws one edge per table, and none for a table one repo alone touches", () => {
      const edges = detectRelationships([
        repo("a", [
          { table: "orders", access: "write", filePath: "a.sql" },
          { table: "carts", access: "write", filePath: "a.sql" },
          { table: "mine", access: "write", filePath: "a.sql" },
        ]),
        repo("b", [
          { table: "orders", access: "read", filePath: "b.sql" },
          { table: "carts", access: "read", filePath: "b.sql" },
        ]),
      ]);
      expect(edges.map((e) => e.resource?.name).sort()).toEqual(["carts", "orders"]);
    });
  });

  describe("deduplication", () => {
    it("deduplicates edges keeping highest confidence", () => {
      const repos: RepoCrawlData[] = [
        {
          repoConnectionId: "r1",
          repoName: "api-service",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "openapi",
                filePath: "openapi.json",
                content: '{"paths":{"/users":{"get":{"summary":"list users"}}}}',
              },
            ],
            routes: [
              {
                method: "GET",
                path: "/users",
                filePath: "src/routes/users.ts",
                framework: "express",
              },
            ],
          }),
        },
        {
          repoConnectionId: "r2",
          repoName: "client-app",
          ownerOrOrg: "org",
          crawlResult: makeCrawlResult({
            specs: [
              {
                format: "openapi",
                filePath: "client-spec.yaml",
                content: "paths:\n  /users:\n    get:\n      summary: list users from api-service",
              },
            ],
          }),
        },
      ];

      const edges = detectRelationships(repos);
      // Should not have duplicate source:target:type combos
      const keys = edges.map((e) => `${e.sourceRepoId}:${e.targetRepoId}:${e.edgeType}`);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });
  });
});

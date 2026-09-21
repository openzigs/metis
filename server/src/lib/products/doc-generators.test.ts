/**
 * Doc generator tests (Epic #544 / Issues #551, #552, #553).
 */
import { describe, expect, it } from "vitest";
import { generateUnifiedArchitectureDoc, type UnifiedDocInput } from "./unified-doc-generator.js";
import { generatePerServiceDoc, generateAllPerServiceDocs } from "./per-service-doc-generator.js";
import {
  generateApiContractDoc,
  parseOpenApiEndpoints,
  parseGraphQLTypes,
  parseProtobuf,
} from "./api-contract-doc-generator.js";

describe("unified-doc-generator", () => {
  const baseInput: UnifiedDocInput = {
    productName: "My Product",
    productDescription: "A multi-service product",
    repos: [
      {
        repoConnectionId: "r1",
        repoName: "frontend",
        ownerOrOrg: "org",
        role: "frontend",
        defaultBranch: "main",
      },
      {
        repoConnectionId: "r2",
        repoName: "backend-api",
        ownerOrOrg: "org",
        role: "backend-api",
        defaultBranch: "main",
      },
    ],
    edges: [
      {
        sourceRepoId: "r1",
        targetRepoId: "r2",
        edgeType: "calls",
        confidence: 0.95,
        evidence: [{ filePath: "openapi.yaml", pattern: "spec_reference", matchType: "spec" }],
      },
    ],
  };

  it("generates a document with all required sections", () => {
    const doc = generateUnifiedArchitectureDoc(baseInput);
    expect(doc.title).toContain("My Product");
    expect(doc.content).toContain("# My Product — Architecture Documentation");
    expect(doc.content).toContain("## System Overview");
    expect(doc.content).toContain("## Service Map");
    expect(doc.content).toContain("## API Contracts");
    expect(doc.content).toContain("## Data Flow");
    expect(doc.content).toContain("## Provenance");
  });

  it("includes Mermaid service map diagram", () => {
    const doc = generateUnifiedArchitectureDoc(baseInput);
    expect(doc.content).toContain("```mermaid");
    expect(doc.content).toContain("graph TB");
    expect(doc.content).toContain("frontend");
    expect(doc.content).toContain("backend-api");
  });

  it("includes API contracts table", () => {
    const doc = generateUnifiedArchitectureDoc(baseInput);
    expect(doc.content).toContain("| frontend | backend-api | 95% |");
  });

  it("includes data flow sequence diagram", () => {
    const doc = generateUnifiedArchitectureDoc(baseInput);
    expect(doc.content).toContain("sequenceDiagram");
  });

  it("includes correct metadata", () => {
    const doc = generateUnifiedArchitectureDoc(baseInput);
    expect(doc.metadata.repoCount).toBe(2);
    expect(doc.metadata.edgeCount).toBe(1);
    expect(doc.metadata.generatedAt).toBeDefined();
  });

  it("handles empty edges gracefully", () => {
    const input = { ...baseInput, edges: [] };
    const doc = generateUnifiedArchitectureDoc(input);
    expect(doc.content).toContain("No API contract edges detected");
    expect(doc.content).toContain("No data flow edges detected");
  });
});

describe("per-service-doc-generator", () => {
  const repos = [
    {
      repoConnectionId: "r1",
      repoName: "frontend",
      ownerOrOrg: "org",
      role: "frontend",
      defaultBranch: "main",
    },
    {
      repoConnectionId: "r2",
      repoName: "backend",
      ownerOrOrg: "org",
      role: "backend-api",
      defaultBranch: "main",
    },
  ];
  const edges = [
    {
      sourceRepoId: "r1",
      targetRepoId: "r2",
      edgeType: "calls" as const,
      confidence: 0.9,
      evidence: [
        {
          filePath: "src/api.ts",
          pattern: "http_call",
          matchType: "url",
          snippet: "calls /api/users",
        },
      ],
    },
  ];

  it("generates doc with cross-references for a repo", () => {
    const doc = generatePerServiceDoc({
      productName: "My Product",
      repo: repos[0],
      allRepos: repos,
      edges,
    });
    expect(doc.title).toContain("frontend");
    expect(doc.content).toContain("## Dependencies");
    expect(doc.content).toContain("### Services This Calls");
    expect(doc.content).toContain("**backend**");
    expect(doc.content).toContain("## Cross-References");
  });

  it("shows incoming edges for target repo", () => {
    const doc = generatePerServiceDoc({
      productName: "My Product",
      repo: repos[1],
      allRepos: repos,
      edges,
    });
    expect(doc.content).toContain("### Services That Call This");
    expect(doc.content).toContain("**frontend**");
  });

  it("handles repo with no edges gracefully", () => {
    const doc = generatePerServiceDoc({
      productName: "My Product",
      repo: repos[0],
      allRepos: repos,
      edges: [],
    });
    expect(doc.content).toContain("No outgoing dependencies detected");
    expect(doc.content).toContain("No incoming dependencies detected");
    expect(doc.content).toContain("No cross-repo relationships detected");
  });

  it("generates docs for all repos", () => {
    const docs = generateAllPerServiceDocs({
      productName: "My Product",
      repos,
      edges,
    });
    expect(docs).toHaveLength(2);
    expect(docs[0].title).toContain("frontend");
    expect(docs[1].title).toContain("backend");
  });

  it("includes role information", () => {
    const doc = generatePerServiceDoc({
      productName: "My Product",
      repo: repos[0],
      allRepos: repos,
      edges,
    });
    expect(doc.content).toContain("## Role: frontend");
  });
});

describe("api-contract-doc-generator", () => {
  describe("parseOpenApiEndpoints — JSON", () => {
    it("parses JSON OpenAPI spec", () => {
      const content = JSON.stringify({
        openapi: "3.0.0",
        paths: {
          "/users": {
            get: {
              summary: "List users",
              tags: ["Users"],
              parameters: [],
              responses: { "200": { description: "OK" } },
            },
            post: { summary: "Create user", tags: ["Users"] },
          },
          "/users/{id}": {
            get: { summary: "Get user", tags: ["Users"] },
          },
        },
      });
      const endpoints = parseOpenApiEndpoints(content);
      expect(endpoints).toHaveLength(3);
      expect(endpoints[0].method).toBe("GET");
      expect(endpoints[0].path).toBe("/users");
      expect(endpoints[0].summary).toBe("List users");
      expect(endpoints[0].tags).toEqual(["Users"]);
    });

    it("returns empty array for invalid JSON", () => {
      const endpoints = parseOpenApiEndpoints("not json at all");
      expect(endpoints).toEqual([]);
    });

    it("parses JSON spec with parameters and responses", () => {
      const content = JSON.stringify({
        openapi: "3.0.0",
        paths: {
          "/items/{id}": {
            get: {
              summary: "Get item",
              description: "Returns a single item by ID",
              tags: ["Items"],
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "integer" } },
                { name: "fields", in: "query", required: false, schema: { type: "string" } },
              ],
              responses: {
                "200": { description: "Successful response" },
                "404": { description: "Not found" },
              },
            },
            delete: {
              summary: "Delete item",
              description: "Deletes an item",
              responses: { "204": { description: "Deleted" } },
            },
          },
        },
      });
      const endpoints = parseOpenApiEndpoints(content);
      expect(endpoints).toHaveLength(2);
      expect(endpoints[0].parameters).toHaveLength(2);
      expect(endpoints[0].parameters![0].required).toBe(true);
      expect(endpoints[0].parameters![0].type).toBe("integer");
      expect(endpoints[0].responses).toHaveLength(2);
      expect(endpoints[0].description).toBe("Returns a single item by ID");
      expect(endpoints[1].method).toBe("DELETE");
    });

    it("handles paths with non-object values", () => {
      const content = JSON.stringify({
        openapi: "3.0.0",
        paths: {
          "/valid": { get: { summary: "OK" } },
          "/invalid": null,
        },
      });
      const endpoints = parseOpenApiEndpoints(content);
      expect(endpoints).toHaveLength(1);
    });
  });

  describe("parseOpenApiEndpoints — YAML", () => {
    it("parses YAML-like OpenAPI paths", () => {
      const content = `openapi: "3.0.0"
paths:
  /users:
    get:
      summary: List users
    post:
      summary: Create user
  /users/{id}:
    get:
      summary: Get user by ID
`;
      const endpoints = parseOpenApiEndpoints(content);
      expect(endpoints.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("parseGraphQLTypes", () => {
    it("parses GraphQL types", () => {
      const content = `
type User {
  id: ID!
  name: String!
  email: String
}

type Query {
  users: [User]
  user(id: ID!): User
}

input CreateUserInput {
  name: String!
  email: String!
}

enum Role {
  ADMIN
  USER
}
`;
      const types = parseGraphQLTypes(content);
      expect(types.length).toBeGreaterThanOrEqual(3);
      const userType = types.find((t) => t.name === "User");
      expect(userType).toBeDefined();
      expect(userType!.fields!.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty for no types", () => {
      const types = parseGraphQLTypes("# just a comment");
      expect(types).toEqual([]);
    });
  });

  describe("parseProtobuf", () => {
    it("parses protobuf services and messages", () => {
      const content = `
syntax = "proto3";
package myservice;

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
  rpc CreateUser (CreateUserRequest) returns (User);
}

message User {
  string id = 1;
  string name = 2;
  string email = 3;
}

message GetUserRequest {
  string id = 1;
}

message CreateUserRequest {
  string name = 1;
  string email = 2;
}
`;
      const { services, messages } = parseProtobuf(content);
      expect(services).toHaveLength(1);
      expect(services[0].name).toBe("UserService");
      expect(services[0].methods).toHaveLength(2);
      expect(services[0].methods[0].name).toBe("GetUser");
      expect(messages).toHaveLength(3);
      expect(messages[0].name).toBe("User");
      expect(messages[0].fields).toHaveLength(3);
    });

    it("returns empty for no definitions", () => {
      const { services, messages } = parseProtobuf("// empty file");
      expect(services).toEqual([]);
      expect(messages).toEqual([]);
    });
  });

  describe("generateApiContractDoc", () => {
    it("generates doc from OpenAPI spec", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "backend",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "openapi",
            filePath: "openapi.json",
            content: JSON.stringify({
              openapi: "3.0.0",
              paths: { "/users": { get: { summary: "List users", tags: ["Users"] } } },
            }),
          },
        ],
      });
      expect(doc.title).toContain("backend");
      expect(doc.content).toContain("## OpenAPI Specification");
      expect(doc.content).toContain("/users");
    });

    it("generates doc from GraphQL schema", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "graph-svc",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "graphql",
            filePath: "schema.graphql",
            content: "type Query { hello: String }",
          },
        ],
      });
      expect(doc.content).toContain("## GraphQL Schema");
    });

    it("generates doc from protobuf", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "grpc-svc",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "protobuf",
            filePath: "service.proto",
            content:
              "service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }\nmessage HelloRequest { string name = 1; }\nmessage HelloReply { string message = 1; }",
          },
        ],
      });
      expect(doc.content).toContain("## Protobuf Definitions");
      expect(doc.content).toContain("Greeter");
      expect(doc.content).toContain("SayHello");
    });

    it("handles empty specs", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "empty",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [],
      });
      expect(doc.content).toContain("No API specifications found");
    });

    it("generates full OpenAPI doc with parameters and responses", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "api-svc",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "openapi",
            filePath: "api.json",
            content: JSON.stringify({
              openapi: "3.0.0",
              paths: {
                "/items/{id}": {
                  get: {
                    summary: "Get item",
                    description: "Fetch a single item",
                    tags: ["Items"],
                    parameters: [
                      { name: "id", in: "path", required: true, schema: { type: "string" } },
                    ],
                    responses: {
                      "200": { description: "OK" },
                      "404": { description: "Not found" },
                    },
                  },
                },
              },
            }),
          },
        ],
      });
      expect(doc.content).toContain("**Parameters:**");
      expect(doc.content).toContain("**Responses:**");
      expect(doc.content).toContain("| id | path | Yes | string |");
      expect(doc.content).toContain("| 200 | OK |");
    });

    it("generates full GraphQL doc with enums, inputs, and object types", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "graph-svc",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "graphql",
            filePath: "schema.graphql",
            content: `
type Query {
  users: [User]
  user(id: ID!): User
}

type User {
  id: ID!
  name: String!
}

input CreateUserInput {
  name: String!
  email: String!
}

enum Role {
  ADMIN
  USER
  GUEST
}
`,
          },
        ],
      });
      expect(doc.content).toContain("### Query");
      expect(doc.content).toContain("### Types");
      expect(doc.content).toContain("#### User");
      expect(doc.content).toContain("### Input Types");
      expect(doc.content).toContain("#### CreateUserInput");
      expect(doc.content).toContain("### Enums");
      expect(doc.content).toContain("#### Role");
    });

    it("generates full protobuf doc with services and messages", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "grpc-svc",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "protobuf",
            filePath: "service.proto",
            content: `
service OrderService {
  rpc CreateOrder (CreateOrderRequest) returns (Order);
  rpc GetOrder (GetOrderRequest) returns (Order);
}

message Order {
  string id = 1;
  string status = 2;
  int32 amount = 3;
}

message CreateOrderRequest {
  string product_id = 1;
  int32 quantity = 2;
}

message GetOrderRequest {
  string id = 1;
}
`,
          },
        ],
      });
      expect(doc.content).toContain("### Services");
      expect(doc.content).toContain("#### OrderService");
      expect(doc.content).toContain("CreateOrder");
      expect(doc.content).toContain("### Messages");
      expect(doc.content).toContain("#### Order");
      expect(doc.content).toContain("| id | `string` | 1 |");
    });

    it("generates swagger format spec", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "legacy",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "swagger",
            filePath: "swagger.json",
            content: JSON.stringify({
              swagger: "2.0",
              paths: { "/health": { get: { summary: "Health check" } } },
            }),
          },
        ],
      });
      expect(doc.content).toContain("## OpenAPI Specification");
      expect(doc.content).toContain("/health");
    });

    it("handles unparseable OpenAPI spec gracefully", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "broken",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "openapi",
            filePath: "spec.json",
            content: JSON.stringify({ openapi: "3.0.0" }), // no paths
          },
        ],
      });
      expect(doc.content).toContain("Could not parse endpoints");
    });

    it("handles unparseable GraphQL spec gracefully", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "broken",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "graphql",
            filePath: "schema.graphql",
            content: "# empty file with no types",
          },
        ],
      });
      expect(doc.content).toContain("Could not parse types");
    });

    it("handles unparseable protobuf spec gracefully", () => {
      const doc = generateApiContractDoc({
        productName: "My Product",
        repoName: "broken",
        repoConnectionId: "r1",
        ownerOrOrg: "org",
        specs: [
          {
            format: "protobuf",
            filePath: "empty.proto",
            content: "// empty proto",
          },
        ],
      });
      expect(doc.content).toContain("Could not parse definitions");
    });
  });
});

/**
 * Repo crawler unit tests (Epic #544 / Issue #550).
 */
import { describe, expect, it } from "vitest";
import { crawlFiles, shouldSkipPath, type FileEntry } from "./repo-crawler.js";

describe("repo-crawler", () => {
  describe("shouldSkipPath", () => {
    it("skips node_modules", () => {
      expect(shouldSkipPath("src/node_modules/foo/bar.ts")).toBe(true);
    });

    it("skips .git", () => {
      expect(shouldSkipPath(".git/config")).toBe(true);
    });

    it("skips dist", () => {
      expect(shouldSkipPath("dist/index.js")).toBe(true);
    });

    it("allows valid paths", () => {
      expect(shouldSkipPath("src/routes/users.ts")).toBe(false);
    });

    it("skips test directories", () => {
      expect(shouldSkipPath("__tests__/utils.test.ts")).toBe(true);
    });
  });

  describe("crawlFiles — spec discovery", () => {
    it("discovers OpenAPI YAML spec", () => {
      const files: FileEntry[] = [
        { path: "openapi.yaml", content: "openapi: 3.0.0\npaths:\n  /users:", size: 50 },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].format).toBe("openapi");
      expect(result.specs[0].filePath).toBe("openapi.yaml");
    });

    it("discovers Swagger JSON spec", () => {
      const files: FileEntry[] = [
        { path: "api/swagger.json", content: '{"swagger":"2.0"}', size: 20 },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].format).toBe("swagger");
    });

    it("discovers GraphQL schema", () => {
      const files: FileEntry[] = [
        { path: "src/schema.graphql", content: "type Query { users: [User] }", size: 30 },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].format).toBe("graphql");
    });

    it("discovers protobuf files", () => {
      const files: FileEntry[] = [
        {
          path: "proto/service.proto",
          content: 'syntax = "proto3";\npackage myservice;',
          size: 40,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].format).toBe("protobuf");
    });
  });

  describe("crawlFiles — route extraction", () => {
    it("extracts Express routes", () => {
      const files: FileEntry[] = [
        {
          path: "src/routes/users.ts",
          content: `
router.get("/users", handler);
router.post("/users", createHandler);
router.delete("/users/:id", deleteHandler);
`,
          size: 100,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.routes).toHaveLength(3);
      expect(result.routes[0].method).toBe("GET");
      expect(result.routes[0].path).toBe("/users");
      expect(result.routes[0].framework).toBe("express");
      expect(result.routes[1].method).toBe("POST");
      expect(result.routes[2].method).toBe("DELETE");
      expect(result.routes[2].path).toBe("/users/:id");
    });

    it("extracts NestJS decorator routes", () => {
      const files: FileEntry[] = [
        {
          path: "src/controllers/users.controller.ts",
          content: `
@Get("/users")
async getUsers() {}

@Post("/users")
async createUser() {}
`,
          size: 80,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.routes).toHaveLength(2);
      expect(result.routes[0].framework).toBe("nestjs");
    });

    it("extracts Next.js App Router handlers", () => {
      const files: FileEntry[] = [
        {
          path: "app/api/users/route.ts",
          content: `
export async function GET(request: Request) {}
export async function POST(request: Request) {}
`,
          size: 60,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.routes).toHaveLength(2);
      expect(result.routes[0].method).toBe("GET");
      expect(result.routes[0].framework).toBe("nextjs");
    });

    it("extracts Go chi/gin routes", () => {
      const files: FileEntry[] = [
        {
          path: "src/handlers/routes.go",
          content: `
r.Get("/api/items", listItems)
r.Post("/api/items", createItem)
`,
          size: 60,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.routes).toHaveLength(2);
      expect(result.routes[0].framework).toBe("go");
    });
  });

  describe("crawlFiles — type extraction", () => {
    it("extracts TypeScript interfaces", () => {
      const files: FileEntry[] = [
        {
          path: "src/types/user.ts",
          content: `
export interface User {
  id: string;
  name: string;
}
export interface CreateUserInput {
  name: string;
}
`,
          size: 80,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.types).toHaveLength(2);
      expect(result.types[0].name).toBe("User");
      expect(result.types[0].kind).toBe("interface");
      expect(result.types[0].exported).toBe(true);
    });

    it("extracts type aliases", () => {
      const files: FileEntry[] = [
        {
          path: "packages/shared/types.ts",
          content: `export type Status = "active" | "inactive";`,
          size: 50,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.types).toHaveLength(1);
      expect(result.types[0].kind).toBe("type");
      expect(result.types[0].exported).toBe(true);
    });

    it("extracts protobuf messages from proto files", () => {
      const files: FileEntry[] = [
        {
          path: "proto/user.proto",
          content: `
message User {
  string id = 1;
  string name = 2;
}
message CreateUserRequest {
  string name = 1;
}
`,
          size: 80,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.types.filter((t) => t.kind === "message")).toHaveLength(2);
    });

    it("does not extract non-exported types from type paths", () => {
      const files: FileEntry[] = [
        {
          path: "src/types/internal.ts",
          content: `interface InternalThing { x: number; }`,
          size: 40,
        },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.types[0].exported).toBe(false);
    });
  });

  describe("crawlFiles — limits", () => {
    it("respects max files limit", () => {
      const files: FileEntry[] = Array.from({ length: 600 }, (_, i) => ({
        path: `src/types/file${i}.ts`,
        content: `export interface Type${i} {}`,
        size: 30,
      }));
      const result = crawlFiles(files, "repo1", { maxFiles: 100 });
      expect(result.metadata.filesScanned).toBeLessThanOrEqual(100);
    });

    it("respects max bytes limit", () => {
      const files: FileEntry[] = [
        { path: "src/types/big.ts", content: "x".repeat(1000), size: 1000 },
        { path: "src/types/also-big.ts", content: "y".repeat(1000), size: 1000 },
      ];
      const result = crawlFiles(files, "repo1", { maxBytes: 1500 });
      expect(result.metadata.filesScanned).toBe(1);
    });

    it("skips files in node_modules", () => {
      const files: FileEntry[] = [
        { path: "node_modules/foo/index.ts", content: "export type X = string;", size: 25 },
        { path: "src/types/real.ts", content: "export interface Real {}", size: 25 },
      ];
      const result = crawlFiles(files, "repo1");
      expect(result.types).toHaveLength(1);
      expect(result.types[0].name).toBe("Real");
    });
  });

  describe("crawlFiles — metadata", () => {
    it("includes correct metadata", () => {
      const files: FileEntry[] = [{ path: "openapi.yaml", content: "openapi: 3.0.0", size: 15 }];
      const result = crawlFiles(files, "repo-123", { commitSha: "abc123" });
      expect(result.metadata.repoConnectionId).toBe("repo-123");
      expect(result.metadata.commitSha).toBe("abc123");
      expect(result.metadata.filesScanned).toBe(1);
      expect(result.metadata.totalBytes).toBe(15);
      expect(result.metadata.crawledAt).toBeDefined();
      expect(result.metadata.duration).toBeGreaterThanOrEqual(0);
    });
  });
});

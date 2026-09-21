import { describe, expect, it } from "vitest";
import {
  createDatabaseConnectionSchema,
  createDocumentSchema,
  createKnowledgeChunkSchema,
  createProjectSchema,
  createRepoConnectionSchema,
  documentSchema,
  knowledgeChunkSchema,
  projectSchema,
  updateProjectSchema,
} from "../src/project.js";
import { MAX_DOCUMENT_BYTES } from "../src/constants.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const now = new Date();

describe("project domain", () => {
  describe("project", () => {
    it("createProjectSchema accepts a valid payload with defaults applied", () => {
      const parsed = createProjectSchema.parse({ name: "Acme", slug: "acme" });
      expect(parsed.slug).toBe("acme");
    });

    it("rejects an uppercase slug", () => {
      expect(() => createProjectSchema.parse({ name: "Acme", slug: "Acme" })).toThrow();
    });

    it("rejects a slug starting with a hyphen", () => {
      expect(() => createProjectSchema.parse({ name: "Acme", slug: "-bad" })).toThrow();
    });

    it("updateProjectSchema requires the id", () => {
      expect(() => updateProjectSchema.parse({ name: "x" })).toThrow();
      expect(updateProjectSchema.parse({ id: validId, name: "x" }).id).toBe(validId);
    });

    it("projectSchema validates a hydrated row", () => {
      expect(
        projectSchema.parse({
          id: validId,
          name: "Acme",
          slug: "acme",
          description: "",
          status: "active",
          createdById: validId,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ status: "active" });
    });
  });

  describe("document", () => {
    const baseDoc = {
      projectId: validId,
      filename: "design.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      storagePath: "s3://bucket/key",
      checksum: "abc123",
    };

    it("createDocumentSchema accepts a valid payload", () => {
      expect(createDocumentSchema.parse(baseDoc).filename).toBe("design.pdf");
    });

    it("rejects oversize uploads", () => {
      expect(() =>
        createDocumentSchema.parse({ ...baseDoc, sizeBytes: MAX_DOCUMENT_BYTES + 1 }),
      ).toThrow();
    });

    it("rejects negative size", () => {
      expect(() => createDocumentSchema.parse({ ...baseDoc, sizeBytes: -1 })).toThrow();
    });

    it("documentSchema requires uploadedAt", () => {
      expect(
        documentSchema.parse({
          ...baseDoc,
          id: validId,
          uploadedById: validId,
          uploadedAt: now,
          deletedAt: null,
        }),
      ).toMatchObject({ id: validId });
    });
  });

  describe("knowledge chunk", () => {
    it("accepts a valid md5", () => {
      expect(
        createKnowledgeChunkSchema.parse({
          projectId: validId,
          documentId: validId,
          position: 0,
          text: "hello",
          md5: "d41d8cd98f00b204e9800998ecf8427e",
          vectorRef: null,
          metadata: null,
        }),
      ).toMatchObject({ position: 0 });
    });

    it("rejects a non-hex md5", () => {
      expect(() =>
        createKnowledgeChunkSchema.parse({
          projectId: validId,
          documentId: validId,
          position: 0,
          text: "hello",
          md5: "not-a-real-md5-hash--------------",
          vectorRef: null,
          metadata: null,
        }),
      ).toThrow();
    });

    it("knowledgeChunkSchema rejects negative position", () => {
      expect(() =>
        knowledgeChunkSchema.parse({
          id: validId,
          projectId: validId,
          documentId: validId,
          position: -1,
          text: "x",
          md5: "d41d8cd98f00b204e9800998ecf8427e",
          vectorRef: null,
          metadata: null,
          createdAt: now,
        }),
      ).toThrow();
    });
  });

  describe("connections", () => {
    it("repoConnection happy path", () => {
      expect(
        createRepoConnectionSchema.parse({
          projectId: validId,
          label: "primary",
          provider: "github",
          ownerOrOrg: "acme",
          repoName: "core",
        }),
      ).toMatchObject({ provider: "github" });
    });

    it("repoConnection rejects unknown provider", () => {
      expect(() =>
        createRepoConnectionSchema.parse({
          projectId: validId,
          label: "primary",
          // @ts-expect-error — runtime check
          provider: "bitbucket",
          ownerOrOrg: "acme",
          repoName: "core",
        }),
      ).toThrow();
    });

    it("databaseConnection happy path with optional fields omitted", () => {
      const parsed = createDatabaseConnectionSchema.parse({
        projectId: validId,
        label: "warehouse",
        driver: "postgres",
      });
      expect(parsed.driver).toBe("postgres");
    });

    it("databaseConnection rejects invalid port", () => {
      expect(() =>
        createDatabaseConnectionSchema.parse({
          projectId: validId,
          label: "warehouse",
          driver: "postgres",
          port: 70000,
        }),
      ).toThrow();
    });
  });
});

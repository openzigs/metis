import { describe, expect, it } from "vitest";
import {
  agentSchema,
  createAgentSchema,
  createMCPServerSchema,
  createScheduledJobSchema,
  createSkillSchema,
  createTaskSchema,
  mcpServerSchema,
  scheduledJobSchema,
  skillSchema,
  taskSchema,
} from "../src/platform.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const now = new Date();

describe("platform domain", () => {
  describe("MCPServer", () => {
    it("global scope + http transport with url", () => {
      expect(
        createMCPServerSchema.parse({
          label: "github",
          transport: "http",
          url: "https://mcp.example.com",
        }),
      ).toMatchObject({ scope: "global" });
    });

    it("project scope without projectId is rejected", () => {
      expect(() =>
        createMCPServerSchema.parse({
          scope: "project",
          label: "github",
          transport: "stdio",
          command: "node mcp.js",
        }),
      ).toThrow();
    });

    it("stdio transport without command is rejected", () => {
      expect(() =>
        createMCPServerSchema.parse({
          label: "github",
          transport: "stdio",
        }),
      ).toThrow();
    });

    it("http transport without url is rejected", () => {
      expect(() =>
        createMCPServerSchema.parse({
          label: "github",
          transport: "http",
        }),
      ).toThrow();
    });

    it("mcpServerSchema rejects global scope with projectId set", () => {
      expect(() =>
        mcpServerSchema.parse({
          id: validId,
          scope: "global",
          projectId: validId,
          label: "x",
          transport: "stdio",
          command: "node x.js",
          url: null,
          envSecretId: null,
          capabilities: null,
          enabled: true,
          createdById: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });

    it("mcpServerSchema accepts a project-scoped row with projectId", () => {
      expect(
        mcpServerSchema.parse({
          id: validId,
          scope: "project",
          projectId: validId,
          label: "x",
          transport: "stdio",
          command: "node x.js",
          url: null,
          envSecretId: null,
          capabilities: null,
          enabled: true,
          createdById: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ scope: "project" });
    });

    it("mcpServerSchema rejects project scope without projectId", () => {
      expect(() =>
        mcpServerSchema.parse({
          id: validId,
          scope: "project",
          projectId: null,
          label: "x",
          transport: "stdio",
          command: "node x.js",
          url: null,
          envSecretId: null,
          capabilities: null,
          enabled: true,
          createdById: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });

    it("mcpServerSchema rejects stdio transport without command", () => {
      expect(() =>
        mcpServerSchema.parse({
          id: validId,
          scope: "global",
          projectId: null,
          label: "x",
          transport: "stdio",
          command: null,
          url: null,
          envSecretId: null,
          capabilities: null,
          enabled: true,
          createdById: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });

    it("mcpServerSchema rejects http transport without url", () => {
      expect(() =>
        mcpServerSchema.parse({
          id: validId,
          scope: "global",
          projectId: null,
          label: "x",
          transport: "http",
          command: null,
          url: null,
          envSecretId: null,
          capabilities: null,
          enabled: true,
          createdById: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });

    it("createMCPServerSchema accepts sse transport with url", () => {
      expect(
        createMCPServerSchema.parse({
          label: "live",
          transport: "sse",
          url: "https://stream.example.com",
        }),
      ).toMatchObject({ transport: "sse" });
    });
  });

  describe("Skill", () => {
    it("happy path", () => {
      expect(
        createSkillSchema.parse({
          key: "code-issue",
          name: "Code Issue",
          version: "0.1.0",
          manifest: "{}",
        }),
      ).toMatchObject({ key: "code-issue" });
    });

    it("rejects key with uppercase", () => {
      expect(() =>
        createSkillSchema.parse({
          key: "Code-Issue",
          name: "x",
          version: "0.1.0",
          manifest: "{}",
        }),
      ).toThrow();
    });

    it("skillSchema hydrated row", () => {
      expect(
        skillSchema.parse({
          id: validId,
          key: "x",
          name: "x",
          description: "",
          version: "0.1.0",
          manifest: "{}",
          enabled: true,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ enabled: true });
    });
  });

  describe("Agent", () => {
    it("happy path with defaults", () => {
      expect(
        createAgentSchema.parse({
          key: "code-issue",
          name: "Code Issue",
          manifest: "{}",
        }),
      ).toMatchObject({ key: "code-issue" });
    });

    it("agentSchema hydrated row", () => {
      expect(
        agentSchema.parse({
          id: validId,
          key: "x",
          name: "x",
          description: "",
          model: "",
          manifest: "{}",
          enabled: true,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ key: "x" });
    });
  });

  describe("ScheduledJob", () => {
    it("happy path with 5-field cron", () => {
      expect(
        createScheduledJobSchema.parse({
          key: "nightly",
          name: "Nightly",
          cron: "0 3 * * *",
        }),
      ).toMatchObject({ enabled: true });
    });

    it("happy path with 6-field cron", () => {
      expect(
        createScheduledJobSchema.parse({
          key: "nightly",
          name: "Nightly",
          cron: "0 0 3 * * *",
        }),
      ).toMatchObject({ key: "nightly" });
    });

    it("rejects 4-field cron", () => {
      expect(() =>
        createScheduledJobSchema.parse({
          key: "nightly",
          name: "Nightly",
          cron: "0 3 * *",
        }),
      ).toThrow();
    });

    it("scheduledJobSchema hydrated row", () => {
      expect(
        scheduledJobSchema.parse({
          id: validId,
          key: "nightly",
          name: "Nightly",
          cron: "0 3 * * *",
          taskType: "http-webhook",
          payload: "{}",
          projectId: null,
          enabled: true,
          lastRunAt: null,
          nextRunAt: null,
          maxAttempts: 3,
          createdById: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ enabled: true });
    });
  });

  describe("Task", () => {
    it("createTaskSchema applies defaults", () => {
      const parsed = createTaskSchema.parse({ type: "analysis.run" });
      expect(parsed.priority).toBe(5);
      expect(parsed.maxAttempts).toBe(3);
      expect(parsed.payload).toEqual({});
    });

    it("rejects priority out of range", () => {
      expect(() => createTaskSchema.parse({ type: "x", priority: 0 })).toThrow();
      expect(() => createTaskSchema.parse({ type: "x", priority: 11 })).toThrow();
    });

    it("rejects empty type", () => {
      expect(() => createTaskSchema.parse({ type: "" })).toThrow();
    });

    it("taskSchema validates hydrated row", () => {
      expect(
        taskSchema.parse({
          id: validId,
          scheduledJobId: null,
          projectId: null,
          type: "analysis.run",
          trigger: "manual",
          status: "pending",
          priority: 5,
          payload: "{}",
          result: null,
          errorMessage: null,
          progress: null,
          attempts: 0,
          maxAttempts: 3,
          scheduledFor: null,
          startedAt: null,
          completedAt: null,
          createdById: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ status: "pending" });
    });
  });
});

describe("MCPServer k8s-sse field validation", () => {
  const base = {
    scope: "global" as const,
    label: "x",
    transport: "sse" as const,
    url: "https://example.com/sse",
  };

  it("accepts memory limits up to 16Gi", () => {
    expect(() => createMCPServerSchema.parse({ ...base, k8sMemoryLimit: "16Gi" })).not.toThrow();
    expect(() => createMCPServerSchema.parse({ ...base, k8sMemoryLimit: "16384Mi" })).not.toThrow();
  });

  it("rejects memory limits above 16Gi", () => {
    expect(() => createMCPServerSchema.parse({ ...base, k8sMemoryLimit: "32Gi" })).toThrow(
      /16Gi|16384Mi/,
    );
    expect(() => createMCPServerSchema.parse({ ...base, k8sMemoryLimit: "20480Mi" })).toThrow();
  });

  it("accepts CPU limits up to 8000m / 8 cores", () => {
    expect(() => createMCPServerSchema.parse({ ...base, k8sCpuLimit: "8000m" })).not.toThrow();
    expect(() => createMCPServerSchema.parse({ ...base, k8sCpuLimit: "8" })).not.toThrow();
  });

  it("rejects CPU limits above 8000m", () => {
    expect(() => createMCPServerSchema.parse({ ...base, k8sCpuLimit: "16000m" })).toThrow(
      /8000m|8 cores/,
    );
    expect(() => createMCPServerSchema.parse({ ...base, k8sCpuLimit: "16" })).toThrow();
  });

  it("accepts a CSV egressAllowlist of cidr: / host: entries", () => {
    expect(() =>
      createMCPServerSchema.parse({
        ...base,
        egressAllowlist: "cidr:10.0.0.0/8, host:api.github.com",
      }),
    ).not.toThrow();
    expect(() => createMCPServerSchema.parse({ ...base, egressAllowlist: "" })).not.toThrow();
  });

  it("rejects egressAllowlist entries without cidr:/host: prefix", () => {
    expect(() =>
      createMCPServerSchema.parse({ ...base, egressAllowlist: "api.github.com" }),
    ).toThrow(/cidr:|host:/);
    expect(() =>
      createMCPServerSchema.parse({
        ...base,
        egressAllowlist: "cidr:10.0.0.0/8, bogus:nope",
      }),
    ).toThrow();
  });

  it("rejects empty cidr / host bodies", () => {
    expect(() => createMCPServerSchema.parse({ ...base, egressAllowlist: "cidr:" })).toThrow(
      /Empty CIDR/,
    );
    expect(() => createMCPServerSchema.parse({ ...base, egressAllowlist: "host:" })).toThrow(
      /Empty host/,
    );
  });
});

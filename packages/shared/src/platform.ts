/**
 * MCPServer, Skill, Agent, ScheduledJob, Task schemas.
 */
import { z } from "zod";
import {
  DEFAULT_MAX_TASK_ATTEMPTS,
  DEFAULT_TASK_PRIORITY,
  MCP_RUNTIMES,
  MCP_SCOPES,
  MCP_STATUSES,
  MCP_TOOL_RISKS,
  MCP_TRANSPORTS,
  MCP_TRUST_LEVELS,
  TASK_STATUSES,
} from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";
import {
  egressAllowlistCsvSchema,
  k8sCpuLimitSchema,
  k8sMemoryLimitSchema,
} from "./mcp-validators.js";

// ---- MCPServer -------------------------------------------------------------
// Vault reference pattern — env values that should resolve from the secret
// vault are written as `${vault:label-or-id}` so the value never leaves the
// platform in plaintext.
export const VAULT_REF_PATTERN = /\$\{vault:[^}]+\}/;

const mcpEnvShape = z.record(z.string());
const mcpHeadersShape = z.record(z.string());
const mcpArgsShape = z.array(z.string()).max(64);

// Tool descriptor surfaced to the UI — never includes raw plaintext args.
export const mcpToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  risk: z.enum(MCP_TOOL_RISKS),
  inputSchema: z.unknown().optional(),
});
export type MCPToolDescriptor = z.infer<typeof mcpToolDescriptorSchema>;

const mcpBaseShape = {
  id: idSchema,
  scope: z.enum(MCP_SCOPES),
  projectId: idSchema.nullable(),
  label: z.string().min(1).max(128),
  transport: z.enum(MCP_TRANSPORTS),
  /** Epic #271 — execution runtime (default `native` for back-compat). */
  runtime: z.enum(MCP_RUNTIMES).default("native"),
  command: z.string().max(2048).nullable(),
  args: z.array(z.string()).max(64).nullable().default(null),
  url: z.string().url().nullable(),
  headers: z.record(z.string()).nullable().default(null),
  envJson: z.record(z.string()).nullable().default(null),
  envSecretId: idSchema.nullable(),
  envSecretRefs: z.record(z.string()).nullable().default(null),
  trustLevel: z.enum(MCP_TRUST_LEVELS).default("untrusted"),
  defaultToolRisk: z.enum(MCP_TOOL_RISKS).default("medium"),
  version: z.string().nullable().default(null),
  sha256: z.string().nullable().default(null),
  capabilities: z.string().nullable().default(null), // JSON-encoded
  status: z.enum(MCP_STATUSES).default("idle"),
  lastHealthCheckAt: dateSchema.nullable().default(null),
  latencyMs: z.number().int().nullable().default(null),
  failureCount: z.number().int().default(0),
  lastError: z.string().nullable().default(null),
  healthCheckIntervalSec: z.number().int().min(5).max(86_400).default(60),
  enabled: z.boolean(),
  createdById: idSchema.nullable(),
  deletedAt: dateSchema.nullable(),
};

function refineConnection(
  v: {
    scope: string;
    projectId?: string | null;
    transport: string;
    command?: string | null;
    url?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (v.scope === "project" && !v.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectId is required when scope is 'project'",
      path: ["projectId"],
    });
  }
  if (v.scope === "global" && v.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectId must be null when scope is 'global'",
      path: ["projectId"],
    });
  }
  if (v.transport === "stdio" && !v.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "command is required for stdio transport",
      path: ["command"],
    });
  }
  if ((v.transport === "http" || v.transport === "sse") && !v.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "url is required for http/sse transport",
      path: ["url"],
    });
  }
}

export const mcpServerSchema = z
  .object(mcpBaseShape)
  .merge(timestampsSchema)
  .superRefine(refineConnection);
export type MCPServer = z.infer<typeof mcpServerSchema>;

export const createMCPServerSchema = z
  .object({
    scope: z.enum(MCP_SCOPES).default("global"),
    projectId: idSchema.optional(),
    label: z.string().min(1).max(128),
    transport: z.enum(MCP_TRANSPORTS),
    /** Epic #271 — execution runtime (default `native` for back-compat). */
    runtime: z.enum(MCP_RUNTIMES).default("native"),
    command: z.string().max(2048).optional(),
    args: mcpArgsShape.optional(),
    url: z.string().url().optional(),
    headers: mcpHeadersShape.optional(),
    env: mcpEnvShape.optional(),
    envSecretRefs: z.record(z.string()).optional(),
    trustLevel: z.enum(MCP_TRUST_LEVELS).default("untrusted"),
    defaultToolRisk: z.enum(MCP_TOOL_RISKS).default("medium"),
    version: z.string().max(64).optional(),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    healthCheckIntervalSec: z.number().int().min(5).max(86_400).default(60),
    enabled: z.boolean().default(true),
    /** Epic #272 — per-server k8s-sse overrides. */
    egressAllowlist: egressAllowlistCsvSchema.optional(),
    k8sMemoryLimit: k8sMemoryLimitSchema.optional(),
    k8sCpuLimit: k8sCpuLimitSchema.optional(),
    coldStart: z.boolean().optional(),
  })
  .superRefine(refineConnection);
export type CreateMCPServerInput = z.infer<typeof createMCPServerSchema>;

export const updateMCPServerSchema = z
  .object({
    label: z.string().min(1).max(128).optional(),
    /** Epic #271 — runtime is mutable post-registration. */
    runtime: z.enum(MCP_RUNTIMES).optional(),
    command: z.string().max(2048).nullable().optional(),
    args: mcpArgsShape.nullable().optional(),
    url: z.string().url().nullable().optional(),
    headers: mcpHeadersShape.nullable().optional(),
    env: mcpEnvShape.nullable().optional(),
    envSecretRefs: z.record(z.string()).nullable().optional(),
    trustLevel: z.enum(MCP_TRUST_LEVELS).optional(),
    defaultToolRisk: z.enum(MCP_TOOL_RISKS).optional(),
    version: z.string().max(64).nullable().optional(),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .nullable()
      .optional(),
    healthCheckIntervalSec: z.number().int().min(5).max(86_400).optional(),
    enabled: z.boolean().optional(),
    /** Epic #272 — per-server k8s-sse overrides (nullable to clear). */
    egressAllowlist: egressAllowlistCsvSchema.nullable().optional(),
    k8sMemoryLimit: k8sMemoryLimitSchema.nullable().optional(),
    k8sCpuLimit: k8sCpuLimitSchema.nullable().optional(),
    coldStart: z.boolean().optional(),
  })
  .strict();
export type UpdateMCPServerInput = z.infer<typeof updateMCPServerSchema>;

// mcp.json importer schema — VS Code / Claude Desktop format.
export const mcpJsonServerEntrySchema = z
  .object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .passthrough();
export const mcpJsonImportSchema = z.object({
  servers: z.record(mcpJsonServerEntrySchema).optional(),
  mcpServers: z.record(mcpJsonServerEntrySchema).optional(),
  inputs: z.unknown().optional(),
});
export type MCPJsonImport = z.infer<typeof mcpJsonImportSchema>;
export type MCPJsonServerEntry = z.infer<typeof mcpJsonServerEntrySchema>;

// ---- Epic #162 — MCP platform v1.1.0 ---------------------------------------

// Issue #98 — registry browser. Mirrors the public registry payload shape
// returned by https://registry.modelcontextprotocol.io/v0/servers — the upstream
// schema is intentionally permissive (`passthrough`) so we don't break when
// optional fields appear or disappear.
export const mcpRegistryEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    publisher: z.string().optional(),
    category: z.string().optional(),
    homepage: z.string().url().optional(),
    repository: z.string().url().optional(),
    install: z
      .object({
        type: z.enum(["stdio", "http", "sse"]).optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().url().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type MCPRegistryEntry = z.infer<typeof mcpRegistryEntrySchema>;

export const mcpRegistryListSchema = z.object({
  servers: z.array(mcpRegistryEntrySchema),
  total: z.number().int().optional(),
  next: z.string().nullable().optional(),
});
export type MCPRegistryList = z.infer<typeof mcpRegistryListSchema>;

// Issue #105 — schema diff vs last-approved snapshot.
export const mcpSchemaDiffSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type MCPSchemaDiff = z.infer<typeof mcpSchemaDiffSchema>;

// Issue #104 — per-tool, per-session approval gate.
export const MCP_APPROVAL_STATUSES = ["pending", "approved", "denied", "timeout"] as const;
export type MCPApprovalStatus = (typeof MCP_APPROVAL_STATUSES)[number];
export const mcpToolApprovalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  serverId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  status: z.enum(MCP_APPROVAL_STATUSES),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});
export type MCPToolApprovalView = z.infer<typeof mcpToolApprovalSchema>;

// Issue #104 — hidden character scan result.
export const mcpHiddenCharRangeSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
  code: z.number().int(),
  label: z.string(),
});
export type MCPHiddenCharRange = z.infer<typeof mcpHiddenCharRangeSchema>;

// Issue #124 — Copilot CLI mcp.json format. Same shape as VS Code/Claude
// Desktop but the export must be deterministic for `mcp.json` round-trip.
export const copilotMcpJsonServerSchema = z
  .object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    env: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional(),
  })
  .passthrough();
export const copilotMcpJsonSchema = z.object({
  servers: z.record(copilotMcpJsonServerSchema).default({}),
});
export type CopilotMcpJson = z.infer<typeof copilotMcpJsonSchema>;
export type CopilotMcpJsonServer = z.infer<typeof copilotMcpJsonServerSchema>;

// ---- Skill -----------------------------------------------------------------
export const skillSchema = z
  .object({
    id: idSchema,
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1).max(128),
    description: z.string().max(2048).default(""),
    version: z.string().min(1).max(32),
    manifest: z.string(), // JSON-encoded
    enabled: z.boolean(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type Skill = z.infer<typeof skillSchema>;

export const createSkillSchema = skillSchema
  .pick({ key: true, name: true, description: true, version: true, manifest: true, enabled: true })
  .partial({ description: true, enabled: true });
export type CreateSkillInput = z.infer<typeof createSkillSchema>;

// ---- Agent -----------------------------------------------------------------
export const agentSchema = z
  .object({
    id: idSchema,
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1).max(128),
    description: z.string().max(2048).default(""),
    model: z.string().max(128),
    manifest: z.string(),
    enabled: z.boolean(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type Agent = z.infer<typeof agentSchema>;

export const createAgentSchema = agentSchema
  .pick({ key: true, name: true, description: true, model: true, manifest: true, enabled: true })
  .partial({ description: true, model: true, enabled: true });
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

// ---- ScheduledJob ----------------------------------------------------------
// Permissive cron validation — accepts 5 or 6 field crontabs. Full semantic
// validation is delegated to the scheduler runtime in Phase 4.
const cronSchema = z
  .string()
  .min(9)
  .max(128)
  .regex(/^(\S+\s+){4,5}\S+$/, "cron must have 5 or 6 whitespace-separated fields");

export const scheduledJobSchema = z
  .object({
    id: idSchema,
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1).max(128),
    cron: cronSchema,
    taskType: z.string().min(1).max(64),
    payload: z.string(), // JSON-encoded
    projectId: idSchema.nullable(),
    enabled: z.boolean(),
    lastRunAt: dateSchema.nullable(),
    nextRunAt: dateSchema.nullable(),
    maxAttempts: z.number().int().min(1).max(20),
    createdById: idSchema.nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;

export const createScheduledJobSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(128),
  cron: cronSchema,
  taskType: z.string().min(1).max(64).default("http-webhook"),
  payload: z.record(z.unknown()).default({}),
  projectId: idSchema.optional().nullable(),
  enabled: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(20).default(DEFAULT_MAX_TASK_ATTEMPTS),
});
export type CreateScheduledJobInput = z.infer<typeof createScheduledJobSchema>;

export const updateScheduledJobSchema = createScheduledJobSchema.partial().omit({ key: true });
export type UpdateScheduledJobInput = z.infer<typeof updateScheduledJobSchema>;

// ---- Task ------------------------------------------------------------------
export const TASK_TRIGGERS = ["scheduled", "manual", "retry", "webhook"] as const;
export type TaskTrigger = (typeof TASK_TRIGGERS)[number];

export const taskSchema = z
  .object({
    id: idSchema,
    scheduledJobId: idSchema.nullable(),
    projectId: idSchema.nullable(),
    type: z.string().min(1).max(128),
    trigger: z.enum(TASK_TRIGGERS),
    status: z.enum(TASK_STATUSES),
    priority: z.number().int().min(1).max(10),
    payload: z.string(),
    result: z.string().nullable(),
    errorMessage: z.string().max(4096).nullable(),
    progress: z.number().int().min(0).max(100).nullable(),
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(1).max(20),
    scheduledFor: dateSchema.nullable(),
    startedAt: dateSchema.nullable(),
    completedAt: dateSchema.nullable(),
    createdById: idSchema.nullable(),
  })
  .merge(timestampsSchema);
export type Task = z.infer<typeof taskSchema>;

export const createTaskSchema = z.object({
  type: z.string().min(1).max(128),
  trigger: z.enum(TASK_TRIGGERS).default("manual"),
  priority: z.number().int().min(1).max(10).default(DEFAULT_TASK_PRIORITY),
  payload: z.record(z.unknown()).default({}),
  maxAttempts: z.number().int().min(1).max(20).default(DEFAULT_MAX_TASK_ATTEMPTS),
  scheduledFor: dateSchema.optional(),
  scheduledJobId: idSchema.optional(),
  projectId: idSchema.optional().nullable(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

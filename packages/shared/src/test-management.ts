/**
 * Test management tool connection schemas — Epic #856 / Issue #871.
 *
 * Shared between server (validation) and UI (form types / API contracts).
 * Mirrors `jira.ts` but for the Xray / Zephyr / TestRail family of providers
 * which already drive the Test Coverage Gap Analysis exporters/providers.
 */
import { z } from "zod";
import { idSchema, timestampsSchema, dateSchema } from "./common.js";

// ---- Constants -------------------------------------------------------------

export const TEST_MANAGEMENT_KINDS = ["xray", "zephyr", "testrail"] as const;
export type TestManagementKind = (typeof TEST_MANAGEMENT_KINDS)[number];

export const TEST_MANAGEMENT_STATUSES = ["untested", "ok", "error"] as const;
export type TestManagementStatus = (typeof TEST_MANAGEMENT_STATUSES)[number];

// ---- Validators ------------------------------------------------------------

const labelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/, "invalid label");

const httpUrlSchema = z
  .string()
  .url("must be a valid URL")
  .max(512)
  .refine((u) => u.startsWith("https://") || u.startsWith("http://"), "must start with http(s)://");

// ---- Auth input schemas (raw secrets — never persisted) --------------------

/**
 * Xray Cloud auth — JWT exchange uses client_id + client_secret.
 * Server stores both in the vault and persists only `${vault:label}` refs.
 */
export const xrayAuthInputSchema = z.object({
  kind: z.literal("xray"),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(2048),
});
export type XrayAuthInput = z.infer<typeof xrayAuthInputSchema>;

/** Zephyr Scale Cloud auth — pre-issued JWT bearer token. */
export const zephyrAuthInputSchema = z.object({
  kind: z.literal("zephyr"),
  bearerToken: z.string().min(1).max(4096),
});
export type ZephyrAuthInput = z.infer<typeof zephyrAuthInputSchema>;

/** TestRail auth — HTTP Basic with email + API key. */
export const testrailAuthInputSchema = z.object({
  kind: z.literal("testrail"),
  email: z.string().email().max(256),
  apiKey: z.string().min(1).max(2048),
});
export type TestRailAuthInput = z.infer<typeof testrailAuthInputSchema>;

export const testManagementAuthInputSchema = z.discriminatedUnion("kind", [
  xrayAuthInputSchema,
  zephyrAuthInputSchema,
  testrailAuthInputSchema,
]);
export type TestManagementAuthInput = z.infer<typeof testManagementAuthInputSchema>;

// ---- Proxy / TLS ----------------------------------------------------------

export const proxyConfigSchema = z
  .object({
    url: httpUrlSchema,
  })
  .nullable()
  .optional();
export type ProxyConfig = z.infer<typeof proxyConfigSchema>;

export const tlsConfigInputSchema = z
  .object({
    rejectUnauthorized: z.boolean().optional(),
    /** Optional CA cert PEM — server stores in vault, persists only ref. */
    caCert: z.string().max(16_384).nullable().optional(),
  })
  .nullable()
  .optional();
export type TlsConfigInput = z.infer<typeof tlsConfigInputSchema>;

// ---- Create / Update input schemas -----------------------------------------

export const createTestManagementConnectionSchema = z.object({
  label: labelSchema,
  kind: z.enum(TEST_MANAGEMENT_KINDS),
  baseUrl: httpUrlSchema,
  auth: testManagementAuthInputSchema,
  proxyConfig: proxyConfigSchema,
  tlsConfig: tlsConfigInputSchema,
});
export type CreateTestManagementConnectionInput = z.infer<
  typeof createTestManagementConnectionSchema
>;

export const updateTestManagementConnectionSchema = z.object({
  label: labelSchema.optional(),
  baseUrl: httpUrlSchema.optional(),
  /** When provided, rotates the auth secrets. Kind must match the existing row. */
  auth: testManagementAuthInputSchema.optional(),
  proxyConfig: proxyConfigSchema,
  tlsConfig: tlsConfigInputSchema,
});
export type UpdateTestManagementConnectionInput = z.infer<
  typeof updateTestManagementConnectionSchema
>;

// ---- API response (masked secrets) -----------------------------------------

export interface TestManagementConnectionDetail {
  id: string;
  projectId: string;
  label: string;
  kind: TestManagementKind;
  baseUrl: string;
  /** Per-kind shape; never contains plaintext — only `${vault:label}` refs and non-secret hints (e.g. testrail email). */
  authConfig: Record<string, string>;
  proxyConfig: ProxyConfig | null;
  tlsConfig: { rejectUnauthorized: boolean; hasCaCert: boolean } | null;
  status: TestManagementStatus;
  errorMessage: string | null;
  lastTestedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** Result of a connectivity test. */
export interface TestManagementTestResult {
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
}

// ---- Entity schema (for read paths if needed) ------------------------------

export const testManagementConnectionSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    label: labelSchema,
    kind: z.enum(TEST_MANAGEMENT_KINDS),
    baseUrl: httpUrlSchema,
    status: z.enum(TEST_MANAGEMENT_STATUSES).default("untested"),
    errorMessage: z.string().nullable().default(null),
    lastTestedAt: dateSchema.nullable().default(null),
    createdById: idSchema,
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type TestManagementConnection = z.infer<typeof testManagementConnectionSchema>;

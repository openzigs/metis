/**
 * Epic #594 / Issue #604 — Bedrock Inference Profile Manager.
 *
 * CRUD service for inference profile metadata. The profile ARN is used as
 * the model identifier when invoking Bedrock — no AWS SDK import needed.
 * Configuration is stored in the `InferenceProfile` Prisma table.
 */
import { z } from "zod";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("inference-profile-manager");

export const inferenceProfileSchema = z.object({
  arn: z
    .string()
    .min(1)
    .max(500)
    .regex(/^arn:aws[a-zA-Z-]*:bedrock:[a-z0-9-]+:\d{12}:/, "Must be a valid Bedrock ARN"),
  modelId: z.string().min(1).max(200),
  costCenter: z.string().max(100).optional(),
  environment: z.string().max(50).optional(),
  tags: z.record(z.string()).optional(),
});

export type InferenceProfileInput = z.infer<typeof inferenceProfileSchema>;

export interface InferenceProfileRecord {
  id: string;
  projectId: string;
  arn: string;
  modelId: string;
  costCenter: string | null;
  environment: string | null;
  tags: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

function parseTags(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function toRecord(row: {
  id: string;
  projectId: string;
  arn: string;
  modelId: string;
  costCenter: string | null;
  environment: string | null;
  tags: string;
  createdAt: Date;
  updatedAt: Date;
}): InferenceProfileRecord {
  return { ...row, tags: parseTags(row.tags) };
}

export class InferenceProfileManager {
  /** Get the inference profile for a project, or null if not configured. */
  async get(projectId: string): Promise<InferenceProfileRecord | null> {
    const row = await prisma.inferenceProfile.findUnique({ where: { projectId } });
    return row ? toRecord(row) : null;
  }

  /** Create or update the inference profile for a project. */
  async upsert(projectId: string, input: InferenceProfileInput): Promise<InferenceProfileRecord> {
    const data = {
      arn: input.arn,
      modelId: input.modelId,
      costCenter: input.costCenter ?? null,
      environment: input.environment ?? null,
      tags: JSON.stringify(input.tags ?? {}),
    };

    const row = await prisma.inferenceProfile.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });

    log.info("Inference profile upserted", { projectId, arn: input.arn });
    return toRecord(row);
  }

  /** Delete the inference profile for a project. Returns true if deleted. */
  async delete(projectId: string): Promise<boolean> {
    try {
      await prisma.inferenceProfile.delete({ where: { projectId } });
      log.info("Inference profile deleted", { projectId });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the model identifier for a Bedrock call. Returns the inference
   * profile ARN if one is configured for the project, otherwise the original
   * model ID.
   */
  async resolveModelId(projectId: string | undefined, defaultModelId: string): Promise<string> {
    if (!projectId) return defaultModelId;
    const profile = await this.get(projectId);
    return profile?.arn ?? defaultModelId;
  }
}

let singleton: InferenceProfileManager | null = null;

export function getInferenceProfileManager(): InferenceProfileManager {
  if (!singleton) singleton = new InferenceProfileManager();
  return singleton;
}

/** Test helper. */
export function __resetInferenceProfileManagerSingleton(): void {
  singleton = null;
}

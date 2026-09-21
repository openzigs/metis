/**
 * Change Analysis schemas — Epic #557 (issues #564–#569).
 *
 * Shared between server (validation) and UI (form types / API contracts).
 */
import { z } from "zod";
import {
  CHANGE_ANALYSIS_STATUSES,
  CHANGE_REVIEW_STATUSES,
  CHANGE_SEVERITIES,
  CHANGE_TYPES,
  PUBLISH_DESTINATIONS,
} from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";

// ---- ChangeAnalysis --------------------------------------------------------

export const changeAnalysisSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    baseAnalysisId: idSchema,
    headAnalysisId: idSchema,
    status: z.enum(CHANGE_ANALYSIS_STATUSES),
    summary: z.string().max(4096).nullable(),
    totalChanges: z.number().int().min(0),
    additions: z.number().int().min(0),
    removals: z.number().int().min(0),
    modifications: z.number().int().min(0),
    startedById: idSchema,
    startedAt: dateSchema,
    completedAt: dateSchema.nullable(),
    errorMessage: z.string().max(4096).nullable(),
  })
  .merge(timestampsSchema);
export type ChangeAnalysis = z.infer<typeof changeAnalysisSchema>;

export const triggerChangeAnalysisSchema = z.object({
  baseAnalysisId: idSchema,
  headAnalysisId: idSchema,
});
export type TriggerChangeAnalysisInput = z.infer<typeof triggerChangeAnalysisSchema>;

// ---- RequirementChange -----------------------------------------------------

export const requirementChangeSchema = z.object({
  id: idSchema,
  changeAnalysisId: idSchema,
  changeType: z.enum(CHANGE_TYPES),
  severity: z.enum(CHANGE_SEVERITIES),
  impactScore: z.number().min(0).max(1),
  requirementId: idSchema.nullable(),
  previousRequirementId: idSchema.nullable(),
  title: z.string().min(1).max(255),
  previousTitle: z.string().max(255).nullable(),
  body: z.string().min(1),
  previousBody: z.string().nullable(),
  diffSummary: z.string().max(4096).nullable(),
  reviewStatus: z.enum(CHANGE_REVIEW_STATUSES),
  reviewedById: idSchema.nullable(),
  reviewedAt: dateSchema.nullable(),
  createdAt: dateSchema,
});
export type RequirementChange = z.infer<typeof requirementChangeSchema>;

export const reviewChangeSchema = z.object({
  reviewStatus: z.enum(["approved", "rejected"] as const),
});
export type ReviewChangeInput = z.infer<typeof reviewChangeSchema>;

// ---- API response aggregates -----------------------------------------------

export interface ChangeAnalysisDetail extends ChangeAnalysis {
  changes: RequirementChange[];
}

// ---- Publishing destination config -----------------------------------------

export const publishDestinationConfigSchema = z.object({
  publishDestination: z.enum(PUBLISH_DESTINATIONS),
  jiraProjectKey: z.string().min(1).max(32).nullable().optional(),
  jiraConnectionId: idSchema.nullable().optional(),
});
export type PublishDestinationConfig = z.infer<typeof publishDestinationConfigSchema>;

/**
 * Stakeholder + project-context model — Epic #208 (E6.1 / #230).
 *
 * Shared between the server (Zod validation, service layer) and the UI (form
 * types / API contracts) for the `Stakeholder`, `ProjectContext`, and
 * `RequirementStakeholder` Prisma models. A real BA captures who cares about a
 * project (stakeholders, on a power/interest grid), the project framing
 * (goals/scope/constraints/glossary), and which stakeholders each requirement
 * serves.
 *
 * Per the METIS schema-duality convention, list-shaped ProjectContext fields are
 * stored JSON-as-TEXT and (de)serialised by the application; the schemas here
 * describe the parsed runtime shape.
 */
import { z } from "zod";

// ---- Constants -------------------------------------------------------------

/** Power/interest grid axes — the classic stakeholder-analysis dimensions. */
export const STAKEHOLDER_LEVELS = ["low", "medium", "high"] as const;
export type StakeholderLevel = (typeof STAKEHOLDER_LEVELS)[number];

/** Per-link priority a stakeholder assigns to a requirement (MoSCoW). */
export const STAKEHOLDER_PRIORITIES = ["must-have", "should-have", "nice-to-have"] as const;
export type StakeholderPriority = (typeof STAKEHOLDER_PRIORITIES)[number];

const nameSchema = z.string().trim().min(1, "name is required").max(200);
const shortText = z.string().trim().max(255);
const longText = z.string().trim().max(4_000);

// ---- Stakeholder -----------------------------------------------------------

export const createStakeholderSchema = z.object({
  name: nameSchema,
  role: shortText.optional(),
  description: longText.optional(),
  influence: z.enum(STAKEHOLDER_LEVELS).optional(),
  interest: z.enum(STAKEHOLDER_LEVELS).optional(),
  viewpoint: shortText.optional(),
});
export type CreateStakeholderInput = z.infer<typeof createStakeholderSchema>;

/** Partial update — every field optional, but at least one must be present. */
export const updateStakeholderSchema = createStakeholderSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });
export type UpdateStakeholderInput = z.infer<typeof updateStakeholderSchema>;

export const stakeholderSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  role: z.string(),
  description: z.string(),
  influence: z.enum(STAKEHOLDER_LEVELS),
  interest: z.enum(STAKEHOLDER_LEVELS),
  viewpoint: z.string(),
});
export type Stakeholder = z.infer<typeof stakeholderSchema>;

// ---- Project context -------------------------------------------------------

/** A single domain-glossary entry. */
export const glossaryEntrySchema = z.object({
  term: z.string().trim().min(1).max(200),
  definition: z.string().trim().min(1).max(2_000),
});
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

const scopeList = z.array(z.string().trim().min(1).max(1_000)).max(100);

export const projectContextSchema = z.object({
  businessGoals: longText.optional(),
  inScope: scopeList.optional(),
  outOfScope: scopeList.optional(),
  constraints: scopeList.optional(),
  glossary: z.array(glossaryEntrySchema).max(200).optional(),
});
export type ProjectContextInput = z.infer<typeof projectContextSchema>;

/** Fully-resolved project context (all fields present, lists parsed). */
export interface ProjectContext {
  businessGoals: string;
  inScope: string[];
  outOfScope: string[];
  constraints: string[];
  glossary: GlossaryEntry[];
}

// ---- Requirement ↔ stakeholder link ---------------------------------------

export const linkStakeholderSchema = z.object({
  stakeholderId: z.string().trim().min(1, "stakeholderId is required").max(64),
  priority: z.enum(STAKEHOLDER_PRIORITIES).optional(),
  viewpoint: shortText.optional(),
});
export type LinkStakeholderInput = z.infer<typeof linkStakeholderSchema>;

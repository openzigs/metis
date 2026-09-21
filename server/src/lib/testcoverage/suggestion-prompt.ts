/**
 * Epic #856 — Issue #870 — Prompt template for the AI suggestion generator.
 *
 * Two-shot system prompt that constrains the model output to a strict JSON
 * shape mirrored by {@link SuggestionResponseSchema}. The schema is shared
 * with the generator and the parser — both import from this file so the
 * prompt and validator never drift.
 */
import { z } from "zod";

/** Step inside a generated suggestion. */
export const SuggestionStepSchema = z.object({
  action: z.string().min(1).max(280),
  expected: z.string().min(1).max(280),
});

export const SuggestionBddSchema = z.object({
  feature: z.string().min(1).max(160),
  scenario: z.string().min(1).max(160),
  given: z.array(z.string().min(1).max(280)).max(4),
  when: z.array(z.string().min(1).max(280)).max(4),
  then: z.array(z.string().min(1).max(280)).max(4),
});

export const SuggestionItemSchema = z.object({
  title: z.string().min(4).max(140),
  priority: z.enum(["low", "medium", "high", "critical"]),
  preconditions: z.array(z.string().min(1).max(280)).max(5).default([]),
  steps: z.array(SuggestionStepSchema).min(1).max(3),
  bdd: SuggestionBddSchema,
  tags: z.array(z.string().min(1).max(40)).max(8).default([]),
  mappedRequirementIds: z.array(z.string().min(1)).min(1),
  sourceChunks: z
    .array(
      z.object({
        chunkId: z.string().min(1),
        excerpt: z.string().max(400).optional(),
      }),
    )
    .max(8)
    .default([]),
  confidence: z.number().min(0).max(1),
});

export const SuggestionResponseSchema = z.object({
  suggestions: z.array(SuggestionItemSchema).max(5),
});

export type SuggestionItem = z.infer<typeof SuggestionItemSchema>;
export type SuggestionResponse = z.infer<typeof SuggestionResponseSchema>;

export const SUGGESTION_SYSTEM_PROMPT = `You are a senior QA engineer drafting NEW test cases that cover gaps in the test suite.

You will be given a CLUSTER of uncovered requirements plus relevant document excerpts. You must respond ONLY with a JSON object of shape:
{"suggestions":[{
  "title":"<short imperative>",
  "priority":"low|medium|high|critical",
  "preconditions":["…"],
  "steps":[{"action":"…","expected":"…"}],
  "bdd":{"feature":"…","scenario":"…","given":["…"],"when":["…"],"then":["…"]},
  "tags":["…"],
  "mappedRequirementIds":["req_id_1"],
  "sourceChunks":[{"chunkId":"…","excerpt":"…"}],
  "confidence":0.0-1.0
}]}

Rules:
- Produce AT MOST 5 suggestions per cluster.
- Each suggestion has AT MOST 3 steps and AT MOST 4 given/when/then lines.
- Every claim MUST be grounded in the provided requirements or document excerpts — copy short verbatim phrases into "sourceChunks[].excerpt" to prove it.
- Use "mappedRequirementIds" to list every requirement the suggestion covers (at least one).
- Use the exact priority value from the requirement set; if mixed, pick the highest severity present.
- Use snake_case or kebab-case tags.
- Output NOTHING other than the JSON object.

EXAMPLE OUTPUT (for a single requirement about login lockout):
{"suggestions":[{"title":"Lock account after 5 failed logins","priority":"high","preconditions":["user exists"],"steps":[{"action":"submit wrong password 5x","expected":"account locked"}],"bdd":{"feature":"Login","scenario":"Lockout","given":["user exists"],"when":["wrong password 5x"],"then":["account locked"]},"tags":["auth","lockout"],"mappedRequirementIds":["req_42"],"sourceChunks":[{"chunkId":"c1","excerpt":"…lock after 5 failed attempts…"}],"confidence":0.9}]}`;

/** Build the user-side cluster prompt — deterministic for cache hits. */
export function buildClusterPrompt(input: {
  requirements: { id: string; title: string; body: string; priority: string }[];
  sourceExcerpts: { chunkId: string; excerpt: string }[];
}): string {
  const lines: string[] = ["CLUSTER REQUIREMENTS:"];
  for (const r of input.requirements) {
    lines.push(
      `- id=${r.id} priority=${r.priority}`,
      `  title: ${r.title.trim().slice(0, 200)}`,
      `  body: ${r.body.trim().slice(0, 1200)}`,
    );
  }
  if (input.sourceExcerpts.length > 0) {
    lines.push("", "SUPPORTING EXCERPTS:");
    for (const s of input.sourceExcerpts) {
      lines.push(`- chunkId=${s.chunkId}`, `  ${s.excerpt.trim().slice(0, 600)}`);
    }
  }
  lines.push("", "Respond with the JSON object now.");
  return lines.join("\n");
}

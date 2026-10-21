/**
 * Structured NFR + acceptance-criteria elicitor — Epic #208 (E6.2 / #231).
 *
 * Today NFRs/ACs exist only as an enum value on extracted requirements
 * (`requirements-extractor.ts:27`) plus template placeholders. This adds REAL
 * elicitation following the METIS house structured-output pattern (NO Vercel AI
 * SDK): a `provider.chat(messages, { disableTools: true })` call with a
 * JSON-shaped prompt, then a dedicated `parseNfrAcceptance()` validator
 * (strip fences → `JSON.parse` → shape guard → per-item Zod, applied AFTER
 * parse, never at the model boundary). Modeled on `requirements-extractor.ts`.
 *
 * #1081 — an answer that cannot be read is no longer returned as "no NFRs":
 * the call goes through `requestStructuredVerdict` (one re-prompt carrying the
 * parse error), and a second failure comes back marked `unread`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AcceptanceCriterion,
  type Nfr,
  type NfrAcceptanceResult,
  acceptanceCriterionSchema,
  nfrSchema,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";
import {
  hasVerdict,
  jsonObjectWhereDeclared,
  requestStructuredVerdict,
} from "./structured-verdict.js";
import { noUsableItem, type UnreadModelReply } from "./unread-reply.js";

const log = createChildLogger("nfr-elicitor");

const ELICITATION_SYSTEM_PROMPT = [
  "You are a requirements analyst. From the provided requirement text, elicit",
  "the NON-FUNCTIONAL REQUIREMENTS (NFRs) and explicit ACCEPTANCE CRITERIA.",
  "",
  "For each NFR output a JSON object with:",
  '  - category: one of "performance", "security", "scalability", "availability",',
  '    "reliability", "usability", "maintainability", "compliance",',
  '    "observability", "other"',
  "  - title: concise NFR title",
  "  - description: full NFR description",
  '  - metric: a measurable target if stated (e.g. "p95 < 200ms", "99.9% uptime"),',
  "    else an empty string",
  '  - priority: one of "must-have", "should-have", "nice-to-have"',
  "",
  "For each acceptance criterion output a JSON object with:",
  "  - statement: what the criterion verifies",
  "  - given / when / then: optional Given/When/Then framing (empty strings if",
  "    not applicable)",
  "",
  "Respond ONLY with a JSON object:",
  '{ "nfrs": [...], "acceptanceCriteria": [...] }',
  "Do not include markdown fences or commentary.",
].join("\n");

export interface NfrElicitorDeps {
  provider: AIProvider;
  model?: string;
}

export interface NfrElicitationResult extends NfrAcceptanceResult {
  usage: TokenUsage;
  /**
   * #1081 — set when the model's answer could not be read after one re-prompt
   * (or the call failed). The lists are then empty because nothing was READ,
   * not because the model found nothing; the caller records it for the UI.
   */
  unread?: UnreadModelReply;
}

/**
 * #1081 — the envelope only; each item is still read leniently below (an
 * invalid NFR is dropped on its own). What is NOT lenient is the envelope: an
 * answer with neither list is not an elicitation, and reading it as "no NFRs"
 * is the silent empty result #1081 removes.
 */
const envelopeSchema = z
  .object({
    nfrs: z.array(z.unknown()).nullish(),
    acceptanceCriteria: z.array(z.unknown()).nullish(),
  })
  .refine((o) => o.nfrs != null || o.acceptanceCriteria != null, {
    message: "expected an nfrs or acceptanceCriteria array",
  })
  // #1081 review — entries, but not one usable, is not "none found".
  .refine((o) => !noUsableItem(o.nfrs, (i) => nfrSchema.safeParse(withId(i)).success), {
    message: "no nfrs entry has the required fields",
    path: ["nfrs"],
  })
  .refine(
    (o) =>
      !noUsableItem(
        o.acceptanceCriteria,
        (i) => acceptanceCriterionSchema.safeParse(withId(i)).success,
      ),
    {
      message: "no acceptanceCriteria entry has the required fields",
      path: ["acceptanceCriteria"],
    },
  );
type NfrEnvelope = z.infer<typeof envelopeSchema>;

/** The item as validated: the model need not invent an id. */
function withId(raw: unknown): unknown {
  return raw && typeof raw === "object" ? { id: randomUUID(), ...(raw as object) } : raw;
}

/** The shape quoted back to the model in the re-prompt. */
const NFR_SHAPE =
  '{ "nfrs": [ { "category": string, "title": string, "description": string, ' +
  '"metric": string, "priority": string } ], "acceptanceCriteria": [ { "statement": string, ' +
  '"given": string, "when": string, "then": string } ] }';

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyResult(): NfrAcceptanceResult {
  return { nfrs: [], acceptanceCriteria: [] };
}

/** Per-item Zod validation of a read envelope; a missing `id` is synthesised. */
function normalizeNfrAcceptance(envelope: NfrEnvelope): NfrAcceptanceResult {
  const nfrs: Nfr[] = [];
  for (const raw of envelope.nfrs ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
    const parsed = nfrSchema.safeParse(withId);
    if (parsed.success) nfrs.push(parsed.data);
  }

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  for (const raw of envelope.acceptanceCriteria ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
    const parsed = acceptanceCriterionSchema.safeParse(withId);
    if (parsed.success) acceptanceCriteria.push(parsed.data);
  }

  return { nfrs, acceptanceCriteria };
}

/**
 * Parse + validate one LLM response into typed NFRs + acceptance criteria.
 * Invalid items are dropped individually.
 *
 * #1081 — returns `null` when the response cannot be read at all, which is
 * NOT the same as an empty answer (`{ nfrs: [], acceptanceCriteria: [] }`).
 * @internal — exposed for testing.
 */
export function parseNfrAcceptance(content: string): NfrAcceptanceResult | null {
  let json: unknown;
  try {
    json = extractJsonObject(content);
  } catch {
    return null;
  }
  const envelope = envelopeSchema.safeParse(json);
  return envelope.success ? normalizeNfrAcceptance(envelope.data) : null;
}

export class NfrElicitor {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;

  constructor(deps: NfrElicitorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
  }

  /** Elicit structured NFRs + acceptance criteria from raw requirement text. */
  async elicit(rawInput: string, signal?: AbortSignal): Promise<NfrElicitationResult> {
    if (!rawInput.trim()) {
      return { ...emptyResult(), usage: zeroUsage() };
    }

    const messages: ChatMessage[] = [
      { role: "system", content: ELICITATION_SYSTEM_PROMPT },
      { role: "user", content: rawInput },
    ];

    log.info("Eliciting NFRs + acceptance criteria from input", { chars: rawInput.length });

    const outcome = await requestStructuredVerdict(this.provider, {
      label: "nfr-elicitation",
      schema: envelopeSchema,
      schemaName: "NFR and acceptance-criteria",
      expectedShape: NFR_SHAPE,
      messages,
      model: this.model,
      signal,
      disableTools: true,
      responseFormat: jsonObjectWhereDeclared(this.provider, this.model),
    });
    if (!hasVerdict(outcome)) {
      log.warn("NFR/AC answer could not be read — recorded as unread, not as empty", {
        reason: outcome.reason,
        attempts: outcome.attempts,
      });
      return {
        ...emptyResult(),
        usage: outcome.usage,
        unread: { reason: outcome.reason, detail: outcome.detail },
      };
    }

    const parsed = normalizeNfrAcceptance(outcome.verdict);
    log.info("Elicited NFRs + acceptance criteria", {
      nfrs: parsed.nfrs.length,
      acceptanceCriteria: parsed.acceptanceCriteria.length,
    });

    return { ...parsed, usage: outcome.usage };
  }
}

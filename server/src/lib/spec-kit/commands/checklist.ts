/**
 * Epic #396 (MVP-3) — `/speckit.checklist` command.
 *
 * Generates per-domain quality checklists for a feature. Default domains:
 * `security`, `performance`, `accessibility`, `observability`, `testability`.
 * The default set is overridable via `SpecKitConfig.checklistDomains`.
 *
 * Precondition (412): feature must have spec.md AND plan.md.
 *
 * #787 — the items are derived from the feature's own `spec.md` and `plan.md`
 * in ONE model call with the domains as `##` headings. A domain the model left
 * empty, or every domain when there is no online provider, falls back to the
 * fixed `DOMAIN_TEMPLATES`, and that file says in its body that it is a generic
 * template. The provider is resolved lazily, after the 404/412 checks, and a
 * provider that cannot be built (`AIProviderError`, or a retired provider)
 * counts as no provider rather than failing the command. Merge mode keeps check states AND every line the reviewer added
 * that the regenerated set does not contain.
 */
import { prisma } from "../../prisma.js";
import {
  getFeatureArtifact,
  writeFeatureArtifact,
  type FeatureArtifactDto,
} from "../feature-artifacts.js";
import { requireGate } from "../gates.js";
import { resolveFeatureBySlug } from "../features.js";
import { SpecKitArtifactError } from "../artifacts.js";
import { loadProjectContext, runSpecKitAgent, type RunDeps } from "./runner.js";
import type { AIProvider } from "../../ai/types.js";
import { AIProviderError, AIProviderRetiredError } from "../../ai/errors.js";

export const DEFAULT_CHECKLIST_DOMAINS = [
  "security",
  "performance",
  "accessibility",
  "observability",
  "testability",
] as const;

export interface ChecklistInput {
  projectId: string;
  featureSlug: string;
  /** `merge` preserves existing check states and added lines; `overwrite` replaces. */
  mode?: "merge" | "overwrite";
  /** Optional override of the configured domain set. */
  domains?: string[];
  /** Bypass the planGate (audit-emitted high-severity event). */
  force?: boolean;
  actorId?: string | null;
  sessionId?: string | null;
  /**
   * #787 — the project's provider. Absent or offline ⇒ no model call, and
   * every domain is the labelled generic template.
   */
  deps?: RunDeps;
  /**
   * #787 — lazily builds the project's provider, called only after the
   * feature and gate checks pass and only when `deps.provider` is absent.
   * An `AIProviderError` (or a retired provider) ⇒ the labelled template.
   */
  resolveProvider?: () => Promise<AIProvider>;
}

/** #787 — where a domain's items came from. */
export type ChecklistSource = "feature" | "template";

export interface ChecklistResult {
  artifacts: FeatureArtifactDto[];
  domains: string[];
  sources: Record<string, ChecklistSource>;
  tokensUsed: number;
  message: string;
}

const CHECKLIST_SYSTEM_PROMPT_HEAD = [
  "You are a senior reviewer writing Spec Kit quality checklists for ONE feature.",
  "",
  "Derive every item from the feature's spec.md and plan.md given by the user:",
  "name the concrete endpoint, table, query, scope, component or flow it checks.",
  "Do not write generic advice that would fit any feature on any project.",
  "",
  "Output Markdown ONLY: one `## <Domain>` heading per domain below, in this order,",
  "each followed by 2-6 items, every item exactly in this form:",
  "- [ ] <check> — rationale: <why, citing the spec or plan> — owner: <role>",
  "If a domain genuinely does not apply to this feature, give it one item saying why.",
  "",
  "Domains:",
].join("\n");

function checklistSystemPrompt(domains: string[]): string {
  return [CHECKLIST_SYSTEM_PROMPT_HEAD, ...domains.map((d) => `## ${capitalize(d)}`)].join("\n");
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export async function runChecklist(input: ChecklistInput): Promise<ChecklistResult> {
  // Request-body domains reach the system prompt and the artifact key: validate first.
  for (const d of input.domains ?? []) {
    if (typeof d !== "string" || !DOMAIN_RE.test(d)) {
      throw new SpecKitArtifactError(
        400,
        "SPECKIT_INVALID_CHECKLIST_DOMAIN",
        `Checklist domain must match ${DOMAIN_RE} (got: ${String(d).slice(0, 80)})`,
      );
    }
  }
  const feature = await resolveFeatureBySlug(input.projectId, input.featureSlug);
  if (!feature) {
    throw new SpecKitArtifactError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature not found: ${input.featureSlug}`,
    );
  }
  // Gate: needs spec + plan (planGate implies specGate).
  await requireGate({
    featureId: feature.id,
    gate: "planGate",
    force: input.force ?? false,
    actorId: input.actorId ?? null,
    command: "speckit.checklist",
  });

  const domains = input.domains ?? (await loadConfiguredDomains(input.projectId));
  const mode = input.mode ?? "merge";

  // #787 — one model pass over the feature's own spec + plan.
  let derived = new Map<string, string[]>();
  let tokensUsed = 0;
  let provider = input.deps?.provider;
  let unavailable = false;
  if (provider === undefined && input.resolveProvider) {
    try {
      provider = await input.resolveProvider();
    } catch (err) {
      if (!(err instanceof AIProviderError || err instanceof AIProviderRetiredError)) throw err;
      unavailable = true;
    }
  }
  const online = provider !== undefined && !provider.offline;
  if (online) {
    const spec = await getFeatureArtifact(feature.id, "spec.md");
    const plan = await getFeatureArtifact(feature.id, "plan.md");
    const run = await runSpecKitAgent({
      command: "checklist",
      project: await loadProjectContext(input.projectId),
      systemPrompt: checklistSystemPrompt(domains),
      userPrompt: [
        `Feature: ${feature.slug} — ${feature.title}`,
        "",
        "spec.md:",
        "```md",
        spec?.content ?? "(missing — the plan gate was forced)",
        "```",
        "",
        "plan.md:",
        "```md",
        plan?.content ?? "(missing — the plan gate was forced)",
        "```",
      ].join("\n"),
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      deps: { provider },
    });
    tokensUsed = run.tokensUsed;
    derived = parseChecklistSections(run.content, domains);
  }

  const artifacts: FeatureArtifactDto[] = [];
  const sources: Record<string, ChecklistSource> = {};
  for (const domain of domains) {
    const key = `checklist-${domain}.md`;
    const items = derived.get(domain);
    sources[domain] = items ? "feature" : "template";
    const generated = items
      ? renderChecklist(domain, feature.slug, items)
      : generateChecklist(domain, feature.slug);
    let next = generated;
    if (mode === "merge") {
      const existing = await getFeatureArtifact(feature.id, key);
      if (existing) next = mergeChecklists(existing.content, generated);
    }
    const written = await writeFeatureArtifact({
      featureId: feature.id,
      key,
      content: next,
      actorId: input.actorId ?? null,
    });
    artifacts.push(written);
  }
  const fromFeature = domains.filter((d) => sources[d] === "feature");
  const fromTemplate = domains.filter((d) => sources[d] === "template");
  const why = online
    ? "the model returned no items"
    : unavailable
      ? "the project's AI provider is unavailable"
      : "no online AI provider";
  const parts = [
    fromFeature.length > 0 ? `derived from spec.md and plan.md: ${fromFeature.join(", ")}` : "",
    fromTemplate.length > 0 ? `generic template: ${fromTemplate.join(", ")} (${why})` : "",
  ].filter((p) => p.length > 0);
  return {
    artifacts,
    domains,
    sources,
    tokensUsed,
    message: `Generated ${artifacts.length} checklist(s) for ${feature.slug} — ${parts.join("; ")}.`,
  };
}

async function loadConfiguredDomains(projectId: string): Promise<string[]> {
  const cfg = await prisma.specKitConfig.findUnique({ where: { projectId } });
  if (!cfg || !cfg.checklistDomains) return [...DEFAULT_CHECKLIST_DOMAINS];
  try {
    const parsed = JSON.parse(cfg.checklistDomains) as unknown;
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string") && parsed.length > 0) {
      return parsed as string[];
    }
  } catch {
    // fall through to defaults on malformed JSON
  }
  return [...DEFAULT_CHECKLIST_DOMAINS];
}

const DOMAIN_TEMPLATES: Record<
  string,
  Array<{ check: string; rationale: string; owner: string }>
> = {
  security: [
    {
      check: "Authentication enforced on every mutating endpoint",
      rationale: "Prevent unauthenticated writes (OWASP A01).",
      owner: "engineer",
    },
    {
      check: "Input validation on all user-supplied data",
      rationale: "Mitigate injection (OWASP A03).",
      owner: "engineer",
    },
    {
      check: "Secrets loaded from vault, never committed",
      rationale: "Prevent credential leaks (OWASP A07).",
      owner: "engineer",
    },
  ],
  performance: [
    {
      check: "P99 latency under 500 ms for primary user flow",
      rationale: "Maintain perceived responsiveness.",
      owner: "engineer",
    },
    {
      check: "No N+1 queries in hot paths",
      rationale: "Database-bound regression risk.",
      owner: "engineer",
    },
  ],
  accessibility: [
    {
      check: "All interactive controls have accessible names",
      rationale: "WCAG 2.1 4.1.2.",
      owner: "designer",
    },
    {
      check: "Color contrast ratio ≥ 4.5:1 for normal text",
      rationale: "WCAG 2.1 1.4.3.",
      owner: "designer",
    },
  ],
  observability: [
    {
      check: "Structured logs emitted at every system boundary",
      rationale: "Debuggability in production.",
      owner: "engineer",
    },
    {
      check: "Audit-log entry for every privileged action",
      rationale: "Forensic + compliance.",
      owner: "engineer",
    },
  ],
  testability: [
    { check: "Unit test coverage ≥ 80% on new code", rationale: "Repo policy.", owner: "engineer" },
    {
      check: "Critical user flows have e2e coverage",
      rationale: "Regression safety.",
      owner: "qa",
    },
  ],
};

/** The marker comment every generated checklist carries (feature or template). */
const GENERATED_MARKER = "<!-- Generated by /speckit.checklist";

/** #787 — the visible label on a checklist that was NOT derived from the feature. */
export const GENERIC_TEMPLATE_BANNER =
  "> Generic template — not derived from this feature's spec.md and plan.md. Edit these items or re-run with an AI provider configured.";

/** #787 — hidden line recording the check texts this run generated (base64 JSON, comment-safe). */
const GENERATED_CHECKS_PREFIX = "<!-- speckit-generated-checks:";

function encodeGeneratedChecks(items: string[]): string {
  const checks = items.map((i) => {
    const m = ITEM_RE.exec(i);
    return checkText(m ? m[2]! : i);
  });
  return `${GENERATED_CHECKS_PREFIX} ${Buffer.from(JSON.stringify(checks)).toString("base64")} -->`;
}

function decodeGeneratedChecks(existing: string): Set<string> {
  const line = existing.split(/\r?\n/).find((l) => l.trim().startsWith(GENERATED_CHECKS_PREFIX));
  if (!line) return new Set();
  const b64 = line
    .trim()
    .slice(GENERATED_CHECKS_PREFIX.length)
    .replace(/-->\s*$/, "")
    .trim();
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((c): c is string => typeof c === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/** Every check text in the fixed generic templates (files written before the marker existed). */
function templateChecks(): Set<string> {
  return new Set(Object.values(DOMAIN_TEMPLATES).flatMap((t) => t.map((x) => x.check)));
}

function renderDocument(
  domain: string,
  featureSlug: string,
  items: string[],
  generic: boolean,
): string {
  return [
    `# ${capitalize(domain)} Checklist — ${featureSlug}`,
    "",
    generic
      ? `${GENERATED_MARKER} from the default ${domain} template. Re-run with mode=merge to keep check states and your own items. -->`
      : `${GENERATED_MARKER} from this feature's spec.md and plan.md. Re-run with mode=merge to keep check states and your own items. -->`,
    "",
    encodeGeneratedChecks(items),
    "",
    ...(generic ? [GENERIC_TEMPLATE_BANNER, ""] : []),
    ...items,
    "",
  ].join("\n");
}

/** The fixed, feature-independent template for a domain — labelled as generic. */
export function generateChecklist(domain: string, featureSlug: string): string {
  const template = DOMAIN_TEMPLATES[domain] ?? [
    {
      check: `Define quality bar for ${domain}`,
      rationale: "Domain not in default template.",
      owner: "engineer",
    },
  ];
  const items = template.map(
    (t) => `- [ ] ${t.check} — rationale: ${t.rationale} — owner: ${t.owner}`,
  );
  return renderDocument(domain, featureSlug, items, true);
}

/** #787 — a checklist whose items were derived from the feature's spec + plan. */
export function renderChecklist(domain: string, featureSlug: string, items: string[]): string {
  return renderDocument(domain, featureSlug, items, false);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ITEM_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;

/** The identity of a checklist item: its text before `— rationale:`. */
function checkText(rest: string): string {
  return rest.split(/\s+—\s*rationale:/)[0]!.trim();
}

function normaliseHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`#]/g, " ")
    .replace(/-/g, " ")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact (normalised) match wins; otherwise the longest domain the heading starts with, on a word boundary. */
function matchDomain(heading: string, domains: string[]): string | null {
  const h = normaliseHeading(heading);
  const exact = domains.find((d) => normaliseHeading(d) === h);
  if (exact) return exact;
  let best: string | null = null;
  for (const d of domains) {
    const n = normaliseHeading(d);
    const hit = h.startsWith(n + " ") || h.startsWith(n + ":");
    if (hit && (!best || n.length > normaliseHeading(best).length)) best = d;
  }
  return best;
}

/**
 * #787 — split the model's reply into per-domain item lines. A `## <heading>`
 * belongs to a domain when it starts with the domain name (case-insensitive),
 * so `## Performance checklist` counts. Items are normalised to `- [ ] …`;
 * headings for unasked domains and non-item lines are dropped, and a domain
 * with no items is absent from the map (the caller falls back to the template).
 */
export function parseChecklistSections(reply: string, domains: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of reply.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = matchDomain(heading[1]!, domains);
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (!current || !item || item[2]!.trim().length === 0) continue;
    const list = out.get(current) ?? [];
    list.push(`- [ ] ${item[2]!.trim()}`);
    out.set(current, list);
  }
  return out;
}

/**
 * Merge an existing checklist with a freshly generated one.
 *
 * - A generated item whose check text matches an existing item keeps that
 *   item's `[x]` / `[ ]` state (the rationale may change).
 * - #787 — every other non-blank line of the existing file (a reviewer's own
 *   item, with its state, or a note) is kept, after the last generated item.
 *   The old title, the generated marker comment and the generic banner are
 *   not carried over, so a re-run does not duplicate them.
 */
export function mergeChecklists(existing: string, generated: string): string {
  const stateByCheck = new Map<string, string>();
  for (const line of existing.split(/\r?\n/)) {
    const m = ITEM_RE.exec(line);
    if (m) stateByCheck.set(checkText(m[2]!), m[1]!);
  }
  const out: string[] = [];
  const generatedChecks = new Set<string>();
  const generatedLines = new Set<string>();
  let lastItem = -1;
  for (const line of generated.split(/\r?\n/)) {
    generatedLines.add(line.trim());
    const m = ITEM_RE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const check = checkText(m[2]!);
    generatedChecks.add(check);
    const preserved = stateByCheck.get(check);
    out.push(preserved !== undefined ? `- [${preserved}] ${m[2]!.trim()}` : line);
    lastItem = out.length - 1;
  }

  // #787 - an unticked line this tool generated earlier (recorded in the marker, or a
  // fixed template check from before the marker) is not the reviewer's: drop it.
  const previouslyGenerated = decodeGeneratedChecks(existing);
  const fixedTemplate = templateChecks();
  const kept: string[] = [];
  for (const line of existing.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0 || generatedLines.has(t)) continue;
    if (/^#\s/.test(t) || t.startsWith(GENERATED_MARKER) || t === GENERIC_TEMPLATE_BANNER) continue;
    const m = ITEM_RE.exec(line);
    if (t.startsWith(GENERATED_CHECKS_PREFIX)) continue;
    if (m && generatedChecks.has(checkText(m[2]!))) continue;
    if (m && m[1] === " ") {
      const c = checkText(m[2]!);
      if (previouslyGenerated.has(c) || fixedTemplate.has(c)) continue;
    }
    if (!kept.includes(line)) kept.push(line);
  }
  if (kept.length === 0) return out.join("\n");
  const at = lastItem >= 0 ? lastItem + 1 : out.length;
  out.splice(at, 0, ...kept);
  return out.join("\n");
}

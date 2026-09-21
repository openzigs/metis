/**
 * Epic #396 (MVP-3) — `/speckit.checklist` command.
 *
 * Generates per-domain quality checklists for a feature. Default domains:
 * `security`, `performance`, `accessibility`, `observability`, `testability`.
 * The default set is overridable via `SpecKitConfig.checklistDomains`.
 *
 * Precondition (412): feature must have spec.md AND plan.md.
 * Idempotent merge mode preserves checked items via line-level diff.
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
  /** `merge` preserves existing check states; `overwrite` replaces. */
  mode?: "merge" | "overwrite";
  /** Optional override of the configured domain set. */
  domains?: string[];
  /** Bypass the planGate (audit-emitted high-severity event). */
  force?: boolean;
  actorId?: string | null;
}

export interface ChecklistResult {
  artifacts: FeatureArtifactDto[];
  domains: string[];
  message: string;
}

export async function runChecklist(input: ChecklistInput): Promise<ChecklistResult> {
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
  const artifacts: FeatureArtifactDto[] = [];

  for (const domain of domains) {
    const key = `checklist-${domain}.md`;
    const generated = generateChecklist(domain, feature.slug);
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
  return {
    artifacts,
    domains,
    message: `Generated ${artifacts.length} checklist(s) for ${feature.slug}: ${domains.join(", ")}.`,
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

export function generateChecklist(domain: string, featureSlug: string): string {
  const template = DOMAIN_TEMPLATES[domain] ?? [
    {
      check: `Define quality bar for ${domain}`,
      rationale: "Domain not in default template.",
      owner: "engineer",
    },
  ];
  const items = template
    .map((t) => `- [ ] ${t.check} — rationale: ${t.rationale} — owner: ${t.owner}`)
    .join("\n");
  return [
    `# ${capitalize(domain)} Checklist — ${featureSlug}`,
    "",
    `<!-- Generated by /speckit.checklist (Epic #396 MVP-3). Re-run with mode=merge to preserve check states. -->`,
    "",
    items,
    "",
  ].join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Merge an existing checklist with a freshly generated one. Preserves the
 * `[x]` / `[X]` / `[ ]` state of items whose `check` text exactly matches
 * the generated entry; appends new items at the end.
 */
export function mergeChecklists(existing: string, generated: string): string {
  const stateByCheck = new Map<string, string>();
  for (const line of existing.split(/\r?\n/)) {
    const m = /^-\s*\[([ xX])\]\s*(.*?)\s+—\s*rationale:/.exec(line);
    if (m) stateByCheck.set(m[2]!.trim(), m[1]!);
  }
  const out: string[] = [];
  for (const line of generated.split(/\r?\n/)) {
    const m = /^(-\s*\[)([ xX])(\]\s*)(.*?)(\s+—\s*rationale:.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const check = m[4]!.trim();
    const preserved = stateByCheck.get(check);
    if (preserved !== undefined) {
      out.push(`${m[1]}${preserved}${m[3]}${m[4]}${m[5]}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

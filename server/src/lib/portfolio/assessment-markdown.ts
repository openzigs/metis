/**
 * Epic #1608 (#1624) — a reader's view of a portfolio assessment as Markdown:
 * the BA summary first, the requirement restated as functional and
 * non-functional requirements, the products, then a technical deep dive per
 * affected product (#1623's impact path, contract items, tables, topics and
 * severity derivation) and the coverage evidence.
 *
 * It renders a `PortfolioAssessmentView`, so it shows only what
 * `viewPortfolioAssessment` let the reader see: a restricted product is a row
 * reading "Restricted" and nothing more. Every stored or user-written string
 * is escaped (`mdBlock` / `mdInline` / a table cell), and code is put in an
 * inert span with its backticks stripped.
 */
import { z } from "zod";
import {
  PORTFOLIO_DEGRADED_REASON,
  portfolioModifierText,
  portfolioResourceLists,
  type CodeCitation,
  type PortfolioAssessmentView,
} from "@metis/shared";
import { mdBlock, mdInline } from "../analysis/analysis-export.js";
import { escapeMarkdownCell } from "../analysis/traceability-matrix.js";

type Row = PortfolioAssessmentView["products"][number];

const COVERAGE_LABEL: Record<Row["coverage"], string> = {
  covers: "Covers it",
  partial: "Covers part of it",
  "not-covered": "Does not cover it",
  "not-checked": "Not checked",
  restricted: "Restricted",
};

const IMPACT_LABEL: Record<Row["impactKind"], string> = {
  "direct-change": "Must change",
  "downstream-consumer": "Downstream consumer",
  restricted: "Restricted",
  none: "Not affected",
};

const VERDICT_LABEL: Record<NonNullable<PortfolioAssessmentView["verdict"]>, string> = {
  implemented: "Implemented",
  partial: "Partly covered",
  "gap-confirmed": "Nothing in the portfolio covers this",
  "could-not-verify": "Could not verify",
};

const cell = (value: string) => escapeMarkdownCell(mdInline(value));
const code = (value: string) => `\`${mdInline(value).replace(/`/g, "'")}\``;

const repoRef = z.object({ repoConnectionId: z.string(), label: z.string() });
const hopSchema = z.object({
  edgeIds: z.array(z.string()),
  fromProductId: z.string(),
  toProductId: z.string(),
  provider: repoRef,
  consumer: repoRef,
  integrationKind: z.string().nullable(),
  strength: z.string().nullable(),
  confidence: z.number(),
  resource: z.object({ kind: z.string(), name: z.string() }).nullable(),
  callSites: z.array(z.object({ filePath: z.string(), line: z.number().nullable() })),
  contract: z
    .object({
      version: z.number(),
      breaking: z.boolean(),
      items: z.array(z.object({ id: z.string(), change: z.string(), breaking: z.boolean() })),
    })
    .nullable(),
  sharedObjects: z.array(
    z.object({
      schemaName: z.string().nullable(),
      objectName: z.string(),
      objectType: z.string(),
      usageClass: z.string(),
    }),
  ),
  severity: z.object({
    severity: z.string(),
    strength: z.string().nullable(),
    base: z.string(),
    modifiers: z.array(z.object({ kind: z.string(), confidence: z.number().optional() })),
  }),
});
type Hop = z.output<typeof hopSchema>;
const impactSchema = z.object({
  severity: z.string().nullable(),
  hiddenEdgeCount: z.number().default(0),
  hops: z.array(hopSchema),
});
const reposSchema = z.array(
  z.object({ repoConnectionId: z.string(), label: z.string(), verdict: z.string() }),
);

function impactOf(p: Row): z.output<typeof impactSchema> | null {
  const parsed = impactSchema.safeParse((p.technicalDetail as { impact?: unknown }).impact);
  return parsed.success ? parsed.data : null;
}

function reposOf(p: Row): z.output<typeof reposSchema> {
  const parsed = reposSchema.safeParse((p.technicalDetail as { repos?: unknown }).repos);
  return parsed.success ? parsed.data : [];
}

/**
 * The Impact cell. #1673 — a product the change may reach only through one the
 * reader cannot read reads "Restricted", as the view (#1625) labels it: for
 * this reader, not from what the run stored.
 */
function impactCell(p: Row): string {
  return `${IMPACT_LABEL[p.impactKind]}${p.via ? ` via ${cell(p.via)}` : ""}`;
}

function impactHeading(p: Row): string {
  const tags = [p.via ? `via ${p.via}` : null, p.severity].filter(Boolean).join(", ");
  return `${IMPACT_LABEL[p.impactKind]}${tags ? ` (${mdInline(tags)})` : ""}`;
}

/** #1673 — the page's words (`@metis/shared`), escaped: an unknown kind is stored text. */
function modifierText(m: Hop["severity"]["modifiers"][number]): string {
  return mdInline(portfolioModifierText(m));
}

function deepDive(
  v: PortfolioAssessmentView,
  p: Row,
  name: (productId: string) => string,
  labels: ReadonlyMap<string, string>,
): string[] {
  const out = [`### ${mdInline(name(p.productId))}`, ""];
  if (p.coverage === "restricted") {
    out.push("Restricted: you cannot read this product, so nothing about it is shown.", "");
    return out;
  }
  out.push(`**Coverage:** ${COVERAGE_LABEL[p.coverage]} · **Impact:** ${impactHeading(p)}`, "");
  const impact = impactOf(p);
  const hops = impact?.hops ?? [];
  const last = hops.at(-1);

  const repos = new Map(
    reposOf(p).map((r) => [r.repoConnectionId, `${code(r.label)}: ${mdInline(r.verdict)}`]),
  );
  if (last && !repos.has(last.consumer.repoConnectionId)) {
    repos.set(last.consumer.repoConnectionId, `${code(last.consumer.label)}: consumer`);
  }
  if (repos.size > 0) out.push("**Repos**", "", ...[...repos.values()].map((r) => `- ${r}`), "");

  const files = [
    ...v.repos
      .filter((r) => r.productId === p.productId)
      .flatMap((r) =>
        (r.citations as CodeCitation[]).map(
          (c) =>
            `- ${code(`${c.filePath}:${c.startLine}`)} (${mdInline(labels.get(r.repoConnectionId) ?? r.repoConnectionId)})`,
        ),
      ),
    ...(last?.callSites ?? []).map(
      (s) =>
        `- ${code(s.line === null ? s.filePath : `${s.filePath}:${s.line}`)} (${mdInline(last!.consumer.label)}): call site`,
    ),
  ];
  if (files.length > 0) out.push("**Files**", "", ...files, "");

  if (last?.contract && last.contract.items.length > 0) {
    out.push(
      `**Contract items** (version ${last.contract.version})`,
      "",
      ...last.contract.items.map(
        (i) => `- ${code(i.id)}: ${mdInline(i.change)}${i.breaking ? ", breaking" : ""}`,
      ),
      "",
    );
  }
  // #1673 — one list per resource kind, as the page groups them.
  for (const list of portfolioResourceLists(last?.resource ?? null, last?.sharedObjects ?? [])) {
    out.push(
      `**${list.heading}**`,
      "",
      ...list.items.map((i) => `- ${code(i.name)}${i.detail ? ` (${mdInline(i.detail)})` : ""}`),
      "",
    );
  }
  if (hops.length > 0) {
    out.push(
      "**Edge path**",
      "",
      ...hops.map(
        (h, i) =>
          `${i + 1}. ${mdInline(name(h.fromProductId))} → ${mdInline(name(h.toProductId))}: ${mdInline(
            [h.integrationKind ?? "unclassified", h.strength ?? "unclassified strength"].join(", "),
          )}, confidence ${h.confidence} (${h.edgeIds.map(code).join(", ")})`,
      ),
      "",
      "**Severity derivation**",
      "",
      ...hops.map((h, i) => {
        const mods = h.severity.modifiers.map(modifierText);
        return `- Hop ${i + 1}: ${mdInline(h.severity.strength ?? "unclassified")} coupling starts at ${mdInline(h.severity.base)}${mods.length > 0 ? `; ${mods.join("; ")}` : ""}: ${mdInline(h.severity.severity)}.`;
      }),
      `- Path: ${mdInline(impact?.severity ?? "none")} (a path is as severe as its weakest hop).`,
      "",
    );
  }
  if (impact && impact.hiddenEdgeCount > 0) {
    out.push(
      impact.hiddenEdgeCount === 1
        ? "_1 edge out of this product touches a repo you cannot read, so it was not followed._"
        : `_${impact.hiddenEdgeCount} edges out of this product touch a repo you cannot read, so they were not followed._`,
      "",
    );
  }
  if ((p.technicalDetail as { impactWithheld?: unknown }).impactWithheld === true) {
    out.push(
      "_Its impact path goes through a repo or product you cannot read, so it is not shown._",
      "",
    );
  } else if (p.impactKind === "restricted") {
    out.push(
      "_The check stopped at a product you cannot read, so whether the change reaches this one is not known._",
      "",
    );
  }
  return out;
}

/** A reader's view as Markdown. */
export function renderPortfolioAssessmentMarkdown(v: PortfolioAssessmentView): string {
  const name = (productId: string) => v.productNames[productId] ?? productId;
  const report = v.report;
  const lines = [
    "# Portfolio assessment",
    "",
    "## Requirement",
    "",
    mdBlock(v.statement),
    "",
    `**Status:** ${mdInline(v.status)}`,
    `**Verdict:** ${v.verdict ? VERDICT_LABEL[v.verdict] : "Not yet assessed"}`,
    "",
    "## Summary",
    "",
    mdBlock(v.summary),
    "",
  ];
  if (report?.degraded) {
    lines.push(
      `_Degraded: ${PORTFOLIO_DEGRADED_REASON[report.degradedReason ?? ""] ?? "the model could not write this summary"}, so this is the deterministic template. Business and stakeholder impact were not assessed._`,
      "",
    );
  }
  if (report?.withheld) {
    lines.push(
      "_Part of this assessment is hidden from you, so the written summary and the impact paragraphs are not shown._",
      "",
    );
  }

  const shown = new Map(v.products.map((p) => [p.productId, p]));
  const paragraphs = (report?.products ?? []).filter((p) => {
    const row = shown.get(p.productId);
    return row && row.coverage !== "restricted";
  });
  if (paragraphs.length > 0) {
    lines.push("### Affected products", "");
    for (const p of paragraphs) {
      const row = shown.get(p.productId)!;
      const text = (s: string) => (s ? mdInline(s) : "Not assessed.");
      lines.push(
        `#### ${mdInline(name(p.productId))}: ${impactHeading(row)}`,
        "",
        `- **Functional impact:** ${text(p.functional)}`,
        `- **Business impact:** ${text(p.business)}`,
        `- **Stakeholder impact:** ${text(p.stakeholder)}`,
        "",
      );
    }
  }

  if (report) {
    const functional = report.requirements.filter((r) => r.kind === "functional");
    const nonFunctional = report.requirements.filter((r) => r.kind === "non-functional");
    lines.push(
      "## Functional requirements",
      "",
      ...(report.requirementsSource === "template" && !report.degraded
        ? ["_The model gave no restatement, so these are the assessment's criteria._", ""]
        : []),
      ...(functional.length > 0
        ? functional.map((r, i) => `${i + 1}. ${mdInline(r.text)}`)
        : ["_None identified._"]),
      "",
      "## Non-functional requirements",
      "",
      ...(nonFunctional.length > 0
        ? nonFunctional.map(
            (r) =>
              `- ${r.nfrCategory ? `**${mdInline(r.nfrCategory)}:** ` : ""}${mdInline(r.text)}`,
          )
        : ["_None identified._"]),
      "",
    );
  }

  lines.push(
    "## Products",
    "",
    "| Product | Coverage | Summary | Impact | Severity |",
    "| --- | --- | --- | --- | --- |",
    ...v.products.map((p) =>
      p.coverage === "restricted"
        ? `| ${cell(name(p.productId))} | Restricted |  |  |  |`
        : `| ${cell(name(p.productId))} | ${COVERAGE_LABEL[p.coverage]} | ${cell(p.baSummary)} | ${impactCell(p)} | ${p.severity ? cell(p.severity) : ""} |`,
    ),
  );

  const labels = new Map<string, string>();
  for (const p of v.products) {
    for (const r of reposOf(p)) labels.set(r.repoConnectionId, r.label);
  }
  const affected = v.products.filter((p) => p.impactKind !== "none");
  if (affected.length > 0) {
    lines.push("", "## Technical deep dive", "");
    for (const p of affected) lines.push(...deepDive(v, p, name, labels));
  }

  const cited = v.repos.filter((r) => r.citations.length > 0);
  if (cited.length > 0) {
    lines.push("", "## Evidence", "");
    for (const r of cited) {
      lines.push(
        `### ${mdInline(name(r.productId))}: ${mdInline(labels.get(r.repoConnectionId) ?? r.repoConnectionId)} (${r.verdict})`,
        "",
      );
      for (const c of r.citations as CodeCitation[]) lines.push(`- ${code(c.filePath)}`);
      lines.push("");
    }
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

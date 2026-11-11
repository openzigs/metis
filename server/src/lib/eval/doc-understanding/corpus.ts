/**
 * #2229 — the document-understanding corpus: three Word FRDs/BRDs with
 * labelled requirements (a source span each) and labelled ambiguities (the
 * questions a business analyst would want raised).
 *
 * Each item is `eval-data/corpus/<name>/`:
 *
 *   - `frd.src.md`  the authored document, labels marked inline (`corpus-source.ts`)
 *   - `source.docx` the Word document built from it, which is what every arm reads
 *   - `labels.json` the labels built from it
 *
 * {@link loadDocUnderstandingItem} reads `source.docx` through production's
 * `parseDocument`, so an arm sees what an analyst's upload would give it, and
 * refuses an item whose labels the converted text does not bear out: every
 * span must be found verbatim (whitespace aside) and every labelled section
 * must be a heading of the converted text.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseDocument } from "../../documents/parsers.js";
import { clauseLocator } from "../../governing/clause-verify.js";
import { splitSections, type PolicySection } from "../../governing/rule-extraction.js";
import { AMBIGUITY_KINDS, type FrdLabels } from "./corpus-source.js";

export const DOC_UNDERSTANDING_CORPORA = [
  "docunderstanding-01-clinic-booking",
  "docunderstanding-02-freight-claims",
  "docunderstanding-03-community-grants",
] as const;
export type DocUnderstandingCorpusName = (typeof DOC_UNDERSTANDING_CORPORA)[number];

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const LABEL_STATUS =
  "author-labelled while writing the synthetic document; not yet reviewed by a second person";

const labelsFileSchema = z.object({
  corpusId: z.string().min(1),
  title: z.string().min(1),
  license: z.literal("CC0-1.0"),
  labelStatus: z.string().min(1),
  /** sha256 of the `frd.src.md` the labels were built from. */
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sections: z.array(z.string().min(1)),
  requirements: z
    .array(z.object({ id: z.string().regex(/^R\d+$/), section: z.string(), span: z.string() }))
    .min(1),
  ambiguities: z.array(
    z.object({
      id: z.string().regex(/^A\d+$/),
      kind: z.enum(AMBIGUITY_KINDS),
      description: z.string().min(1),
      question: z.string().min(1),
      requirements: z.array(z.string()),
      spans: z.array(z.string()).min(1),
      sections: z.array(z.string()).min(1),
    }),
  ),
});
export type LabelsFile = z.infer<typeof labelsFileSchema>;

export interface DocUnderstandingItem {
  name: string;
  title: string;
  /** The text production's Word conversion gives, which every arm reads. */
  text: string;
  /** `source.docx`'s size in bytes. */
  docxBytes: number;
  /** `text` split by production's section reader (governing rule extraction). */
  sections: PolicySection[];
  labels: FrdLabels;
}

/** Absolute path of the `eval-data/corpus` root. */
export function corpusRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../eval-data/corpus");
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The ways `labels` disagree with `text`: spans not found, sections that are not headings. */
export function labelProblems(text: string, labels: FrdLabels): string[] {
  const locate = clauseLocator(text);
  const headings = new Set(splitSections(text).map((s) => s.heading));
  const problems: string[] = [];
  for (const r of labels.requirements) {
    if (!locate(r.span)) problems.push(`${r.id}: span not found in the converted text`);
    if (!headings.has(r.section)) problems.push(`${r.id}: section "${r.section}" is not a heading`);
  }
  for (const a of labels.ambiguities) {
    a.spans.forEach((s, i) => {
      if (!locate(s)) problems.push(`${a.id}: span ${i + 1} not found in the converted text`);
    });
    for (const s of a.sections) {
      if (!headings.has(s)) problems.push(`${a.id}: section "${s}" is not a heading`);
    }
  }
  return problems;
}

/** Load one item, refusing it when its labels and its Word document disagree. */
export async function loadDocUnderstandingItem(
  name: string,
  root: string = corpusRoot(),
): Promise<DocUnderstandingItem> {
  const dir = path.join(root, name);
  const buffer = await readFile(path.join(dir, "source.docx"));
  const parsed = await parseDocument({ buffer, mimeType: DOCX_MIME, filename: "source.docx" });
  if (!parsed.ok) throw new Error(`${name}: source.docx did not convert (${parsed.reason})`);
  const labels = labelsFileSchema.parse(
    JSON.parse(await readFile(path.join(dir, "labels.json"), "utf8")),
  );
  if (labels.corpusId !== name) {
    throw new Error(`${name}: labels.json names corpus ${labels.corpusId}`);
  }
  const problems = labelProblems(parsed.text, labels);
  if (problems.length > 0) {
    throw new Error(`${name}: labels disagree with source.docx:\n  ${problems.join("\n  ")}`);
  }
  return {
    name,
    title: labels.title,
    text: parsed.text,
    docxBytes: buffer.length,
    sections: splitSections(parsed.text),
    labels: {
      sections: labels.sections,
      requirements: labels.requirements,
      ambiguities: labels.ambiguities,
    },
  };
}

/** Every registered item, or the named ones, in corpus order. */
export async function loadDocUnderstandingCorpus(
  names: readonly string[] = DOC_UNDERSTANDING_CORPORA,
  root?: string,
): Promise<DocUnderstandingItem[]> {
  for (const n of names) {
    if (!(DOC_UNDERSTANDING_CORPORA as readonly string[]).includes(n)) {
      throw new Error(`unknown corpus ${n}; known: ${DOC_UNDERSTANDING_CORPORA.join(", ")}`);
    }
  }
  return Promise.all(names.map((n) => loadDocUnderstandingItem(n, root)));
}

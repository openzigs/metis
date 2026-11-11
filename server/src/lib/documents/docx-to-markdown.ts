/**
 * #2232 — Word (`.docx`) to Markdown that keeps what a business analyst's document is made of.
 *
 * The previous route (`mammoth.convertToHtml`, then the regex `htmlToMarkdown`) turned every
 * numbered list into `-` bullets, flattened nesting and dropped images, so a BRD's
 * requirement numbers (`3.2.1`, `REQ-12` when Word generates it) and its wireframes vanished
 * before any model saw them. mammoth's HTML carries only "ordered or not" for a list, never
 * the number Word displays, so this module reads the OOXML package itself (JSZip + xmldom,
 * both already direct dependencies) and computes the numbers from `numbering.xml`.
 *
 * What it keeps:
 *   - headings at their level (a `Heading N` style, a style named `heading N`, an outline
 *     level), with the number Word shows on a numbered heading (`## 3.2 Login`);
 *   - list numbers as Word renders them, multi-level formats included (`%1.%2.%3`, letters,
 *     roman numerals, a literal prefix such as `REQ-%1`), and nesting by level;
 *   - tables as Markdown tables (a horizontal span leaves empty filler cells, a vertical
 *     merge repeats the value above so every row reads whole);
 *   - images as numbered references, described by `describeImage` when the caller has a
 *     vision-capable model, otherwise listed as "image not read" with the reason;
 *   - comments and footnotes as notes at the end; tracked changes shown accepted, with the
 *     deleted text listed, never silently gone.
 *
 * Anything it cannot carry is reported in a trailing "Conversion notes" section of the text
 * itself, so a model reading the document, and the analyst reading a chunk, both see it.
 *
 * OWASP: xmldom resolves no external entities and expands no DTD-declared ones (see
 * `auth/saml-provider.ts`), and each package part's declared inflated size is capped before
 * it is read, so a small zip cannot inflate into an unbounded string.
 */
import JSZip from "jszip";
import { DOMParser, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";
import { rowsToMarkdownTable } from "./markdown-utils.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("docx-to-markdown");

/** One image found in the document, handed to an {@link ImageDescriber}. */
export interface DocxImage {
  /** 1-based position of the image in the document. */
  index: number;
  /** File name inside the package, e.g. `image1.png`. */
  name: string;
  contentType: string;
  /** The author's alt text (`descr`, else `title`), or "". */
  altText: string;
  data: Buffer;
}

/**
 * Describe one image, or answer `null` when no vision-capable model is available. A throw is
 * reported as a failed description for that image; the rest of the document still converts.
 */
export type ImageDescriber = (image: DocxImage) => Promise<string | null>;

export interface DocxToMarkdownOptions {
  describeImage?: ImageDescriber;
}

export interface DocxConversion {
  markdown: string;
  /** The same lines as the "Conversion notes" section, for the caller's log. */
  notes: string[];
}

/** Images sent for description per document; past this they are listed as not read. */
export const MAX_DESCRIBED_IMAGES = 20;
/** Largest image sent for description, matching the Jira attachment ceiling. */
export const MAX_DESCRIBED_IMAGE_BYTES = 5 * 1024 * 1024;
/** Declared inflated size above which a package part is refused rather than read. */
export const MAX_DOCX_PART_BYTES = 64 * 1024 * 1024;
/** Deleted (tracked) text quoted per deletion in the notes. */
const MAX_DELETION_QUOTE_CHARS = 200;

const DESCRIBABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  emf: "image/x-emf",
  wmf: "image/x-wmf",
  svg: "image/svg+xml",
};

const REL_OFFICE_DOCUMENT = "/officeDocument";

// ── XML helpers ─────────────────────────────────────────────────────────────

function parseXml(xml: string): XmlElement {
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(
    xml.replace(/^﻿/, ""),
    "text/xml",
  );
  const root = doc.documentElement;
  if (!root) throw new Error("part is not XML");
  return root;
}

function localName(node: XmlNode): string {
  return (node as XmlElement).localName ?? node.nodeName.replace(/^.*:/, "");
}

function childElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as XmlElement);
  }
  return out;
}

function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!el) return undefined;
  return childElements(el).find((c) => localName(c) === name);
}

function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement) => {
    for (const c of childElements(node)) {
      if (localName(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** An attribute by local name, whatever prefix the producer gave it (`w:val`, `r:id`). */
function attr(el: XmlElement | undefined, name: string): string | undefined {
  if (!el) return undefined;
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i);
    if (a && (a.localName ?? a.name.replace(/^.*:/, "")) === name) return a.value;
  }
  return undefined;
}

/** A `w:b`-style toggle: present means on unless `w:val` says false. */
function toggleOn(el: XmlElement | undefined): boolean {
  if (!el) return false;
  const v = attr(el, "val");
  return v === undefined || !/^(0|false|off|none)$/i.test(v);
}

function intAttr(el: XmlElement | undefined, name: string): number | undefined {
  const v = attr(el, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ── Package ─────────────────────────────────────────────────────────────────

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

class Package {
  constructor(private readonly zip: JSZip) {}

  file(path: string): JSZip.JSZipObject | null {
    return this.zip.file(path.replace(/^\//, ""));
  }

  private checkSize(path: string, entry: JSZip.JSZipObject): void {
    const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof declared === "number" && declared > MAX_DOCX_PART_BYTES) {
      throw new Error(`part ${path} is larger than ${MAX_DOCX_PART_BYTES} bytes`);
    }
  }

  async xml(path: string): Promise<XmlElement | undefined> {
    const entry = this.file(path);
    if (!entry) return undefined;
    this.checkSize(path, entry);
    return parseXml(await entry.async("string"));
  }

  declaredSize(path: string): number | undefined {
    const entry = this.file(path);
    return (entry as unknown as { _data?: { uncompressedSize?: number } } | null)?._data
      ?.uncompressedSize;
  }

  async bytes(path: string): Promise<Buffer> {
    const entry = this.file(path);
    if (!entry) throw new Error(`missing part ${path}`);
    this.checkSize(path, entry);
    return entry.async("nodebuffer");
  }

  /** The relationships of `partPath`, keyed by id, with targets resolved to package paths. */
  async relationships(partPath: string): Promise<Map<string, Relationship>> {
    const slash = partPath.lastIndexOf("/");
    const dir = slash >= 0 ? partPath.slice(0, slash) : "";
    const base = partPath.slice(slash + 1);
    const relsPath = `${dir ? `${dir}/` : ""}_rels/${base}.rels`;
    const root = await this.xml(relsPath);
    const out = new Map<string, Relationship>();
    if (!root) return out;
    for (const rel of childElements(root)) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (!id || target === undefined) continue;
      const external = attr(rel, "TargetMode") === "External";
      out.set(id, {
        type: attr(rel, "Type") ?? "",
        target: external ? target : resolvePartPath(dir, target),
        external,
      });
    }
    return out;
  }
}

function resolvePartPath(dir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${dir ? `${dir}/` : ""}${target}`)
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function relOfType(rels: Map<string, Relationship>, suffix: string): string | undefined {
  for (const rel of rels.values()) {
    if (!rel.external && rel.type.endsWith(suffix)) return rel.target;
  }
  return undefined;
}

// ── Styles ──────────────────────────────────────────────────────────────────

interface NumRef {
  numId: string;
  ilvl: number;
}

interface StyleDef {
  name: string;
  basedOn?: string;
  outlineLvl?: number;
  num?: Partial<NumRef>;
}

function readNumPr(pPr: XmlElement | undefined): Partial<NumRef> | undefined {
  const numPr = child(pPr, "numPr");
  if (!numPr) return undefined;
  const numId = attr(child(numPr, "numId"), "val");
  const ilvl = intAttr(child(numPr, "ilvl"), "val");
  return { ...(numId !== undefined ? { numId } : {}), ...(ilvl !== undefined ? { ilvl } : {}) };
}

class Styles {
  private readonly byId = new Map<string, StyleDef>();

  constructor(root: XmlElement | undefined) {
    if (!root) return;
    for (const style of childElements(root)) {
      if (localName(style) !== "style" || attr(style, "type") !== "paragraph") continue;
      const id = attr(style, "styleId");
      if (!id) continue;
      const pPr = child(style, "pPr");
      this.byId.set(id, {
        name: attr(child(style, "name"), "val") ?? id,
        basedOn: attr(child(style, "basedOn"), "val"),
        outlineLvl: intAttr(child(pPr, "outlineLvl"), "val"),
        num: readNumPr(pPr),
      });
    }
  }

  /** The style chain from `id` up its `basedOn` parents (bounded against a cycle). */
  private chain(id: string | undefined): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (cur && !seen.has(cur) && out.length < 20) {
      seen.add(cur);
      const def = this.byId.get(cur);
      if (!def) break;
      out.push(def);
      cur = def.basedOn;
    }
    return out;
  }

  /** Heading level 1..6 for a paragraph style, or `undefined` for body text. */
  headingLevel(id: string | undefined): number | undefined {
    if (id) {
      const own = /^heading\s*([1-9])$/i.exec(id);
      if (own) return Math.min(Number(own[1]), 6);
      if (/^title$/i.test(id)) return 1;
    }
    for (const def of this.chain(id)) {
      const named = /^heading\s*([1-9])$/i.exec(def.name);
      if (named) return Math.min(Number(named[1]), 6);
      if (/^title$/i.test(def.name)) return 1;
      if (def.outlineLvl !== undefined && def.outlineLvl >= 0 && def.outlineLvl < 9) {
        return Math.min(def.outlineLvl + 1, 6);
      }
    }
    return undefined;
  }

  /** Numbering a style carries (a numbered `Heading 2`, say), merged up its chain. */
  numbering(id: string | undefined): Partial<NumRef> | undefined {
    let numId: string | undefined;
    let ilvl: number | undefined;
    for (const def of this.chain(id)) {
      if (numId === undefined && def.num?.numId !== undefined) numId = def.num.numId;
      if (ilvl === undefined && def.num?.ilvl !== undefined) ilvl = def.num.ilvl;
    }
    return numId === undefined ? undefined : { numId, ilvl: ilvl ?? 0 };
  }
}

// ── Numbering ───────────────────────────────────────────────────────────────

interface LevelDef {
  start: number;
  numFmt: string;
  lvlText: string;
  isLgl: boolean;
  /** 1-based level after which this level restarts; 0 never restarts. */
  lvlRestart?: number;
}

interface NumDef {
  abstractId: string;
  startOverrides: Map<number, number>;
  levelOverrides: Map<number, LevelDef>;
}

function readLevel(lvl: XmlElement): LevelDef {
  return {
    start: intAttr(child(lvl, "start"), "val") ?? 1,
    numFmt: attr(child(lvl, "numFmt"), "val") ?? "decimal",
    lvlText: attr(child(lvl, "lvlText"), "val") ?? "",
    isLgl: toggleOn(child(lvl, "isLgl")),
    lvlRestart: intAttr(child(lvl, "lvlRestart"), "val"),
  };
}

const ROMAN: Array<[number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  let rest = n;
  let out = "";
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

/** Word's letter numbering: a..z, then aa..zz, then aaa (the letter repeats). */
function toLetter(n: number): string {
  if (n <= 0) return String(n);
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

export function formatNumber(n: number, numFmt: string): string {
  switch (numFmt) {
    case "lowerLetter":
      return toLetter(n);
    case "upperLetter":
      return toLetter(n).toUpperCase();
    case "lowerRoman":
      return toRoman(n);
    case "upperRoman":
      return toRoman(n).toUpperCase();
    case "decimalZero":
      return n < 10 ? `0${n}` : String(n);
    case "none":
      return "";
    default:
      return String(n);
  }
}

interface ListLabel {
  /** The text Word displays before the paragraph, e.g. `3.2.1` or `REQ-4.`; "" for none. */
  text: string;
  bullet: boolean;
}

class Numbering {
  private readonly abstracts = new Map<string, Map<number, LevelDef>>();
  private readonly nums = new Map<string, NumDef>();
  /** Counters per abstract definition: Word continues a list across its `num` instances. */
  private readonly counters = new Map<string, Array<number | undefined>>();
  private readonly usedNums = new Set<string>();

  constructor(root: XmlElement | undefined) {
    if (!root) return;
    for (const el of childElements(root)) {
      if (localName(el) === "abstractNum") {
        const id = attr(el, "abstractNumId");
        if (id === undefined) continue;
        const levels = new Map<number, LevelDef>();
        for (const lvl of childElements(el)) {
          if (localName(lvl) !== "lvl") continue;
          levels.set(intAttr(lvl, "ilvl") ?? 0, readLevel(lvl));
        }
        this.abstracts.set(id, levels);
      } else if (localName(el) === "num") {
        const numId = attr(el, "numId");
        const abstractId = attr(child(el, "abstractNumId"), "val");
        if (numId === undefined || abstractId === undefined) continue;
        const def: NumDef = { abstractId, startOverrides: new Map(), levelOverrides: new Map() };
        for (const o of childElements(el)) {
          if (localName(o) !== "lvlOverride") continue;
          const ilvl = intAttr(o, "ilvl") ?? 0;
          const start = intAttr(child(o, "startOverride"), "val");
          if (start !== undefined) def.startOverrides.set(ilvl, start);
          const lvl = child(o, "lvl");
          if (lvl) def.levelOverrides.set(ilvl, readLevel(lvl));
        }
        this.nums.set(numId, def);
      }
    }
  }

  private level(num: NumDef, ilvl: number): LevelDef | undefined {
    return num.levelOverrides.get(ilvl) ?? this.abstracts.get(num.abstractId)?.get(ilvl);
  }

  /** Advance the list `ref` belongs to and return the label Word shows; `undefined` = not a list. */
  next(ref: NumRef): ListLabel | undefined {
    const num = this.nums.get(ref.numId);
    if (!num) return undefined;
    const ilvl = Math.max(0, Math.min(ref.ilvl, 8));
    const def = this.level(num, ilvl);
    if (!def) return undefined;
    const counters = this.counters.get(num.abstractId) ?? new Array<number | undefined>(9);
    this.counters.set(num.abstractId, counters);
    const startOf = (l: number) => num.startOverrides.get(l) ?? this.level(num, l)?.start ?? 1;

    if (!this.usedNums.has(ref.numId)) {
      // A `startOverride` restarts the list where this `num` instance is first used.
      this.usedNums.add(ref.numId);
      for (const l of num.startOverrides.keys()) counters[l] = undefined;
    }
    counters[ilvl] = counters[ilvl] === undefined ? startOf(ilvl) : counters[ilvl]! + 1;
    for (let deeper = ilvl + 1; deeper < 9; deeper++) {
      const restart = this.level(num, deeper)?.lvlRestart;
      if (restart === 0) continue;
      if (restart === undefined || ilvl < restart) counters[deeper] = undefined;
    }

    if (def.numFmt === "bullet") return { text: "", bullet: true };
    const text = def.lvlText.replace(/%([1-9])/g, (_m, d: string) => {
      const l = Number(d) - 1;
      const value = counters[l] ?? startOf(l);
      const fmt = def.isLgl ? "decimal" : (this.level(num, l)?.numFmt ?? "decimal");
      return formatNumber(value, fmt === "bullet" ? "decimal" : fmt);
    });
    return { text: text.trim(), bullet: false };
  }
}

// ── Document walk ───────────────────────────────────────────────────────────

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  href?: string;
  /** An `[Image N]` reference, so a paragraph holding only images is not repeated as text. */
  imageRef?: boolean;
}

interface ImageSlot {
  index: number;
  name: string;
  path?: string;
  contentType: string;
  altText: string;
  /** Set when the image cannot be read whatever model is configured. */
  unreadable?: string;
}

type Block =
  { kind: "text"; text: string; listItem?: boolean } | { kind: "image"; slot: ImageSlot };

interface Note {
  id: string;
  author?: string;
  text: string;
}

class Converter {
  readonly images: ImageSlot[] = [];
  readonly deletions: string[] = [];
  insertions = 0;
  readonly commentRefs: string[] = [];
  readonly footnoteRefs: Array<{ kind: "footnote" | "endnote"; id: string; label: string }> = [];
  /** Depth of the list item last emitted at top level, for nesting; reset by any other block. */
  private listDepth = -1;

  constructor(
    private readonly styles: Styles,
    private readonly numbering: Numbering,
    private readonly rels: Map<string, Relationship>,
  ) {}

  /** Render a body-like container (`w:body`, a cell, a text box) into blocks. */
  blocks(container: XmlElement, inCell = false): Block[] {
    const out: Block[] = [];
    for (const el of childElements(container)) {
      switch (localName(el)) {
        case "p":
          this.paragraph(el, out, inCell);
          break;
        case "tbl":
          this.listDepth = -1;
          out.push(...this.table(el));
          break;
        case "sdt":
          for (const c of childElements(el)) {
            if (localName(c) === "sdtContent") out.push(...this.blocks(c, inCell));
          }
          break;
        case "customXml":
          out.push(...this.blocks(el, inCell));
          break;
        case "ins":
        case "moveTo":
          this.insertions++;
          out.push(...this.blocks(el, inCell));
          break;
        case "del":
        case "moveFrom":
          this.recordDeletion(el);
          break;
        default:
          break;
      }
    }
    return out;
  }

  private paragraph(p: XmlElement, out: Block[], inCell: boolean): void {
    const pPr = child(p, "pPr");
    const styleId = attr(child(pPr, "pStyle"), "val");
    const direct = readNumPr(pPr);
    const fromStyle = this.styles.numbering(styleId);
    let ref: NumRef | undefined;
    if (direct?.numId !== undefined) {
      ref = { numId: direct.numId, ilvl: direct.ilvl ?? fromStyle?.ilvl ?? 0 };
    } else if (fromStyle?.numId !== undefined) {
      ref = { numId: fromStyle.numId, ilvl: direct?.ilvl ?? fromStyle.ilvl ?? 0 };
    }
    const label = ref && ref.numId !== "0" ? this.numbering.next(ref) : undefined;
    const outline = intAttr(child(pPr, "outlineLvl"), "val");
    const heading =
      this.styles.headingLevel(styleId) ??
      (outline !== undefined && outline >= 0 && outline < 9 ? Math.min(outline + 1, 6) : undefined);

    const trailing: Block[] = [];
    const segs = this.inline(p, trailing);
    // An image-only paragraph is the image block that follows it; in a table cell the
    // reference stays, since the image block can only follow the whole table.
    const onlyImages = !inCell && segs.every((s) => s.imageRef || s.text.trim().length === 0);
    const text = onlyImages ? "" : renderSegments(segs).trim();
    const images = trailing.filter((b) => b.kind === "image");
    const boxes = trailing.filter((b) => b.kind === "text");

    if (text.length > 0) {
      const prefix = label?.text ? `${label.text} ` : "";
      if (inCell) {
        out.push({ kind: "text", text: `${prefix}${text}` });
      } else if (heading !== undefined) {
        this.listDepth = -1;
        out.push({ kind: "text", text: `${"#".repeat(heading)} ${prefix}${oneLine(text)}` });
      } else if (label) {
        const depth = Math.min(ref!.ilvl, this.listDepth + 1);
        this.listDepth = depth;
        const marker = label.bullet || !/^\d+[.)]$/.test(label.text) ? `- ${prefix}` : prefix;
        out.push({
          kind: "text",
          text: `${"    ".repeat(depth)}${marker}${oneLine(text)}`,
          listItem: true,
        });
      } else {
        this.listDepth = -1;
        out.push({ kind: "text", text });
      }
    }
    if (images.length > 0 || boxes.length > 0) {
      if (!inCell) this.listDepth = -1;
      out.push(...boxes, ...images);
    }
  }

  /** Inline content of a paragraph; images and text boxes found inside go to `trailing`. */
  private inline(el: XmlElement, trailing: Block[]): Segment[] {
    const segs: Segment[] = [];
    for (const c of childElements(el)) {
      switch (localName(c)) {
        case "r":
          segs.push(...this.run(c, trailing));
          break;
        case "hyperlink": {
          const id = attr(c, "id");
          const rel = id ? this.rels.get(id) : undefined;
          const inner = this.inline(c, trailing);
          const href = rel?.external ? safeLinkTarget(rel.target) : undefined;
          if (href) {
            for (const s of inner) s.href = href;
          }
          segs.push(...inner);
          break;
        }
        case "ins":
        case "moveTo":
          this.insertions++;
          segs.push(...this.inline(c, trailing));
          break;
        case "del":
        case "moveFrom":
          this.recordDeletion(c);
          break;
        case "smartTag":
        case "customXml":
        case "fldSimple":
        case "bdo":
        case "dir":
          segs.push(...this.inline(c, trailing));
          break;
        case "sdt": {
          const content = child(c, "sdtContent");
          if (content) segs.push(...this.inline(content, trailing));
          break;
        }
        case "oMath":
        case "oMathPara":
          segs.push(
            plain(
              descendants(c, "t")
                .map((t) => t.textContent ?? "")
                .join(""),
            ),
          );
          break;
        default:
          break;
      }
    }
    return segs;
  }

  private run(r: XmlElement, trailing: Block[]): Segment[] {
    const rPr = child(r, "rPr");
    const bold = toggleOn(child(rPr, "b"));
    const italic = toggleOn(child(rPr, "i"));
    const segs: Segment[] = [];
    const push = (text: string) => segs.push({ text, bold, italic });
    for (const c of childElements(r)) {
      switch (localName(c)) {
        case "t":
          push(c.textContent ?? "");
          break;
        case "tab":
        case "ptab":
          push(" ");
          break;
        case "br":
        case "cr":
          push(attr(c, "type") === "page" ? " " : "\n");
          break;
        case "noBreakHyphen":
          push("-");
          break;
        case "commentReference": {
          const id = attr(c, "id");
          if (id !== undefined) {
            this.commentRefs.push(id);
            segs.push(plain(` [comment ${this.commentRefs.length}]`));
          }
          break;
        }
        case "footnoteReference":
        case "endnoteReference": {
          const id = attr(c, "id");
          if (id !== undefined) {
            const kind = localName(c) === "footnoteReference" ? "footnote" : "endnote";
            const label = `${kind === "footnote" ? "" : "e"}${this.footnoteRefs.length + 1}`;
            this.footnoteRefs.push({ kind, id, label });
            segs.push(plain(`[^${label}]`));
          }
          break;
        }
        case "drawing":
        case "pict":
        case "object":
          segs.push(...this.graphic(c, trailing));
          break;
        case "AlternateContent": {
          // Choice and Fallback render the same content twice; read one.
          const pick = child(c, "Choice") ?? child(c, "Fallback");
          if (pick) segs.push(...this.graphic(pick, trailing));
          break;
        }
        default:
          break;
      }
    }
    return segs;
  }

  /** Images and text boxes inside a drawing; returns the inline `[Image N]` references. */
  private graphic(el: XmlElement, trailing: Block[]): Segment[] {
    const segs: Segment[] = [];
    for (const box of descendants(el, "txbxContent")) {
      trailing.push(...this.blocks(box));
    }
    const docPr = descendants(el, "docPr")[0];
    const blips = [...descendants(el, "blip"), ...descendants(el, "imagedata")];
    for (const blip of blips) {
      const embed = attr(blip, "embed") ?? attr(blip, "id");
      const link = attr(blip, "link");
      const rel = embed ? this.rels.get(embed) : link ? this.rels.get(link) : undefined;
      const altText = (
        attr(docPr, "descr") ||
        attr(docPr, "title") ||
        attr(blip, "title") ||
        ""
      ).trim();
      const index = this.images.length + 1;
      const path = rel && !rel.external ? rel.target : undefined;
      const name = path ? path.slice(path.lastIndexOf("/") + 1) : (rel?.target ?? "unknown");
      const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const slot: ImageSlot = {
        index,
        name,
        path,
        contentType: IMAGE_TYPES_BY_EXTENSION[ext] ?? "application/octet-stream",
        altText,
        ...(path ? {} : { unreadable: "it is linked from outside the document, not embedded" }),
      };
      this.images.push(slot);
      trailing.push({ kind: "image", slot });
      segs.push({ ...plain(`[Image ${index}]`), imageRef: true });
    }
    return segs;
  }

  private recordDeletion(el: XmlElement): void {
    const text = [...descendants(el, "delText"), ...descendants(el, "t")]
      .map((t) => t.textContent ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) this.deletions.push(text);
  }

  private table(tbl: XmlElement): Block[] {
    const rows: string[][] = [];
    const trailing: Block[] = [];
    let above: string[] = [];
    for (const tr of childElements(tbl)) {
      if (localName(tr) !== "tr") continue;
      const row: string[] = [];
      for (const tc of childElements(tr)) {
        if (localName(tc) !== "tc") continue;
        const tcPr = child(tc, "tcPr");
        const span = Math.max(1, intAttr(child(tcPr, "gridSpan"), "val") ?? 1);
        const vMerge = child(tcPr, "vMerge");
        const continued = vMerge !== undefined && attr(vMerge, "val") !== "restart";
        const blocks = this.blocks(tc, true);
        trailing.push(...blocks.filter((b) => b.kind === "image"));
        const own = blocks
          .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
          .map((b) => b.text)
          .join(" ");
        row.push(continued && own.length === 0 ? (above[row.length] ?? "") : own);
        for (let i = 1; i < span; i++) row.push("");
      }
      if (row.length > 0) {
        rows.push(row);
        above = row;
      }
    }
    const out: Block[] = [];
    const md = rowsToMarkdownTable(rows);
    if (md) out.push({ kind: "text", text: md });
    out.push(...trailing);
    return out;
  }
}

function plain(text: string): Segment {
  return { text, bold: false, italic: false };
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

/** Join runs, wrapping bold/italic/link spans once per run of equal formatting. */
function renderSegments(segs: Segment[]): string {
  let out = "";
  let i = 0;
  while (i < segs.length) {
    const s = segs[i];
    let text = s.text;
    let j = i + 1;
    while (
      j < segs.length &&
      segs[j].bold === s.bold &&
      segs[j].italic === s.italic &&
      segs[j].href === s.href
    ) {
      text += segs[j].text;
      j++;
    }
    out += wrap(text, s);
    i = j;
  }
  return out;
}

function wrap(text: string, s: Segment): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  let core = m[2];
  if (core.length === 0) return text;
  if (s.italic) core = `*${core}*`;
  if (s.bold) core = `**${core}**`;
  if (s.href) core = `[${core}](${s.href})`;
  return `${m[1]}${core}${m[3]}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`.trimEnd())
    .join("\n");
}

async function readNotes(
  pkg: Package,
  path: string | undefined,
  item: "comment" | "footnote" | "endnote",
  styles: Styles,
  numbering: Numbering,
  rels: Map<string, Relationship>,
): Promise<Map<string, Note>> {
  const out = new Map<string, Note>();
  const root = path ? await pkg.xml(path) : undefined;
  if (!root) return out;
  for (const el of childElements(root)) {
    if (localName(el) !== item) continue;
    const id = attr(el, "id");
    const type = attr(el, "type");
    if (id === undefined || (type !== undefined && type !== "normal")) continue;
    const text = new Converter(styles, numbering, rels)
      .blocks(el, true)
      .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    out.set(id, { id, author: attr(el, "author"), text });
  }
  return out;
}

async function describe(
  pkg: Package,
  slot: ImageSlot,
  describeImage: ImageDescriber | undefined,
): Promise<{ described: boolean; text: string }> {
  const unread = (why: string) => ({ described: false, text: `image not read: ${why}.` });
  if (slot.unreadable) return unread(slot.unreadable);
  if (!describeImage) return unread("no vision-capable model is configured");
  if (slot.index > MAX_DESCRIBED_IMAGES) {
    return unread(`only the first ${MAX_DESCRIBED_IMAGES} images in a document are described`);
  }
  if (!DESCRIBABLE_IMAGE_TYPES.has(slot.contentType)) {
    return unread(`its format (${slot.name}) cannot be sent to a model`);
  }
  if ((pkg.declaredSize(slot.path!) ?? 0) > MAX_DESCRIBED_IMAGE_BYTES) {
    return unread(`it is larger than ${MAX_DESCRIBED_IMAGE_BYTES / (1024 * 1024)} MB`);
  }
  try {
    const data = await pkg.bytes(slot.path!);
    if (data.length > MAX_DESCRIBED_IMAGE_BYTES) {
      return unread(`it is larger than ${MAX_DESCRIBED_IMAGE_BYTES / (1024 * 1024)} MB`);
    }
    const description = await describeImage({
      index: slot.index,
      name: slot.name,
      contentType: slot.contentType,
      altText: slot.altText,
      data,
    });
    if (description === null) return unread("no vision-capable model is configured");
    if (description.trim().length === 0) return unread("the model returned no description");
    return { described: true, text: description.trim() };
  } catch (err) {
    // The provider's raw message is not written into the converted text: that
    // text is stored as knowledge, shown to every project member and fed to
    // models (#1059). The cause is logged instead.
    log.warn("Word image description failed", { image: slot.index, err: (err as Error).name });
    return unread("the description failed");
  }
}

/** Convert a `.docx` package to Markdown. Throws when the bytes are not a Word package. */
export async function docxToMarkdown(
  buffer: Buffer,
  opts: DocxToMarkdownOptions = {},
): Promise<DocxConversion> {
  const pkg = new Package(await JSZip.loadAsync(buffer));
  const mainPath =
    relOfType(await pkg.relationships(""), REL_OFFICE_DOCUMENT) ?? "word/document.xml";
  const main = await pkg.xml(mainPath);
  const body = main ? child(main, "body") : undefined;
  if (!body) throw new Error(`no Word document body at ${mainPath}`);

  const rels = await pkg.relationships(mainPath);
  const styles = new Styles(await pkg.xml(relOfType(rels, "/styles") ?? "word/styles.xml"));
  const numbering = new Numbering(
    await pkg.xml(relOfType(rels, "/numbering") ?? "word/numbering.xml"),
  );
  const conv = new Converter(styles, numbering, rels);
  const blocks = conv.blocks(body);

  const parts: string[] = [];
  let described = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "text") {
      const prev = blocks[i - 1];
      // Consecutive list items stay one list: a blank line between them would end it.
      const tight = block.listItem && prev?.kind === "text" && prev.listItem;
      if (tight) parts[parts.length - 1] += `\n${block.text}`;
      else parts.push(block.text);
      continue;
    }
    const { slot } = block;
    const result = await describe(pkg, slot, opts.describeImage);
    if (result.described) described++;
    const about = [slot.name, slot.altText ? `alt text "${slot.altText}"` : ""]
      .filter(Boolean)
      .join(", ");
    parts.push(quote(`**Image ${slot.index}** (${about}): ${result.text}`));
  }

  const notes: string[] = [];

  if (conv.footnoteRefs.length > 0) {
    const footnotes = await readNotes(
      pkg,
      relOfType(rels, "/footnotes"),
      "footnote",
      styles,
      numbering,
      rels,
    );
    const endnotes = await readNotes(
      pkg,
      relOfType(rels, "/endnotes"),
      "endnote",
      styles,
      numbering,
      rels,
    );
    const lines = conv.footnoteRefs.map((ref) => {
      const note = (ref.kind === "footnote" ? footnotes : endnotes).get(ref.id);
      return `[^${ref.label}]: ${note?.text || "(empty)"}`;
    });
    parts.push(`## Footnotes\n\n${lines.join("\n")}`);
  }

  const commentsPath = relOfType(rels, "/comments");
  const comments = await readNotes(pkg, commentsPath, "comment", styles, numbering, rels);
  if (conv.commentRefs.length > 0 || comments.size > 0) {
    const referenced = new Set(conv.commentRefs);
    const ordered = [
      ...conv.commentRefs.map((id, i) => ({ label: `comment ${i + 1}`, note: comments.get(id) })),
      ...[...comments.values()]
        .filter((c) => !referenced.has(c.id))
        .map((note) => ({ label: "comment (unanchored)", note })),
    ].filter((c) => c.note);
    if (ordered.length > 0) {
      const lines = ordered.map(
        ({ label, note }) =>
          `- [${label}]${note!.author ? ` ${note!.author}:` : ""} ${note!.text || "(empty)"}`,
      );
      parts.push(`## Reviewer comments\n\n${lines.join("\n")}`);
      notes.push(
        `${ordered.length} reviewer comment${ordered.length === 1 ? " is" : "s are"} kept as notes under "Reviewer comments".`,
      );
    }
  }

  if (conv.images.length > 0) {
    const notRead = conv.images.length - described;
    notes.push(
      `${conv.images.length} image${conv.images.length === 1 ? "" : "s"}: ${described} described, ${notRead} not read.`,
    );
  }
  if (conv.insertions > 0 || conv.deletions.length > 0) {
    notes.push(
      `Tracked changes: ${conv.insertions} insertion${conv.insertions === 1 ? "" : "s"} shown as accepted; ${conv.deletions.length} deletion${conv.deletions.length === 1 ? "" : "s"} not shown in the text.`,
    );
    for (const d of conv.deletions) {
      const shown =
        d.length > MAX_DELETION_QUOTE_CHARS ? `${d.slice(0, MAX_DELETION_QUOTE_CHARS)}…` : d;
      notes.push(`Deleted text: "${shown}"`);
    }
  }
  if (notes.length > 0) {
    parts.push(`## Conversion notes\n\n${notes.map((n) => `- ${n}`).join("\n")}`);
  }

  const hasContent = blocks.length > 0;
  return { markdown: hasContent ? parts.join("\n\n").trim() : "", notes };
}

/**
 * A hyperlink target safe to write inside Markdown `(...)`: only http(s) and
 * mailto, parsed as a URL (so `javascript:` hidden behind another scheme cannot
 * pass), with the characters that would end or split the link destination
 * percent-encoded. Anything else is dropped and the text stays plain.
 */
export function safeLinkTarget(target: string): string | undefined {
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return undefined;
  return url.href.replace(
    /[()<>\s\\]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * #1571 — the markdown the PDF and Word exporters cannot read on their own.
 *
 * Generated documents cite their sources as GFM footnotes (`[^src-n]`, with a
 * `[^src-n]: path` definition at the end; `citation-footnotes.ts`), and write
 * formulas as `$…$` and `$$…$$`. Neither exporter knew either form: marked read
 * each definition as a link reference and printed `^src-n`, the Word converter
 * printed every marker and every formula as typed, and marked's backslash
 * escapes and emphasis broke inline formulas before KaTeX could see them.
 *
 * Pure: no I/O. Fenced code and inline code spans are never touched.
 */

/** Opens a footnote reference in {@link ExtractedFootnotes.body}; a Private Use Area character. */
export const FOOTNOTE_REF_OPEN = "";
/** Closes a footnote reference in {@link ExtractedFootnotes.body}. */
export const FOOTNOTE_REF_CLOSE = "";

/** `FOOTNOTE_REF_OPEN` + footnote number + `FOOTNOTE_REF_CLOSE`. */
export const FOOTNOTE_REF_RE = /(\d+)/g;

export interface ExportFootnote {
  /** 1-based, in order of first reference. */
  number: number;
  /** The definition's text, inline markdown. */
  text: string;
}

export interface ExtractedFootnotes {
  /** The markdown without definitions, each reference replaced by its number between the sentinels. */
  body: string;
  /** Referenced footnotes only, in number order. */
  notes: ExportFootnote[];
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const DEFINITION_RE = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const REFERENCE_RE = /\[\^([^\]\s]+)\]/g;

/**
 * Apply `fn` to the parts of `markdown` outside fenced code blocks and inline
 * code spans. `onLine` sees each line outside a fence first; returning null
 * from it drops the line.
 */
function mapOutsideCode(
  markdown: string,
  fn: (text: string) => string,
  onLine?: (line: string) => string | null,
): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const opener = FENCE_RE.exec(line);
    if (fence) {
      if (opener && opener[1]![0] === fence[0] && opener[1]!.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (opener) {
      fence = opener[1]!;
      out.push(line);
      continue;
    }
    const kept = onLine ? onLine(line) : line;
    if (kept === null) continue;
    out.push(mapOutsideCodeSpans(kept, fn));
  }
  return out.join("\n");
}

/** Apply `fn` to the parts of one line outside its inline code spans. */
function mapOutsideCodeSpans(line: string, fn: (text: string) => string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf("`", i);
    if (open === -1) break;
    let run = 1;
    while (line[open + run] === "`") run++;
    const ticks = "`".repeat(run);
    let close = line.indexOf(ticks, open + run);
    // A closing run must be exactly as long as the opening one.
    while (close !== -1 && line[close + run] === "`") close = line.indexOf(ticks, close + run + 1);
    if (close === -1) break;
    result += fn(line.slice(i, open)) + line.slice(open, close + run);
    i = close + run;
  }
  return result + fn(line.slice(i));
}

/**
 * Pull the footnote definitions out of `markdown` and number its references in
 * order of first use, as GFM does. A reference with no definition stays as
 * written; a definition nothing references is dropped.
 */
export function extractFootnotes(markdown: string): ExtractedFootnotes {
  const definitions = new Map<string, string>();
  const withoutDefinitions = mapOutsideCode(
    markdown,
    (text) => text,
    (line) => {
      const def = DEFINITION_RE.exec(line);
      if (!def) return line;
      if (!definitions.has(def[1]!)) definitions.set(def[1]!, def[2]!.trim());
      return null;
    },
  );
  if (definitions.size === 0) return { body: markdown, notes: [] };

  const numbers = new Map<string, number>();
  const notes: ExportFootnote[] = [];
  const body = mapOutsideCode(withoutDefinitions, (text) =>
    text.replace(REFERENCE_RE, (whole, label: string) => {
      const definition = definitions.get(label);
      if (definition === undefined) return whole;
      let n = numbers.get(label);
      if (n === undefined) {
        n = notes.length + 1;
        numbers.set(label, n);
        notes.push({ number: n, text: definition });
      }
      return `${FOOTNOTE_REF_OPEN}${n}${FOOTNOTE_REF_CLOSE}`;
    }),
  );
  return { body, notes };
}

/**
 * An inline formula, by pandoc's rule: the opening `$` is followed by a
 * non-space, the closing `$` follows a non-space and is not followed by a
 * digit, and neither is escaped. So `costs $5 and $10` is prose, not math.
 * A formula holds no backtick, so a code span's `$` never closes one that
 * opened in prose. Group 1 is the LaTeX.
 */
export const INLINE_MATH_SOURCE =
  String.raw`(?<![\\$])\$(?=[^\s$])((?:\\.|[^$\\\n` +
  "`" +
  String.raw`])*?(?:\\.|[^\s$\\` +
  "`" +
  String.raw`]))\$(?![\d$])`;

/**
 * An inline formula in LaTeX's own delimiters, `\(…\)`, which generated
 * documents use too. marked reads `\(` as an escaped `(`, so these printed raw.
 * Group 1 is the LaTeX.
 */
export const PAREN_MATH_SOURCE = String.raw`\\\((.+?)\\\)`;

/** Opens an inline-formula placeholder in the PDF exporter's markdown. */
export const INLINE_MATH_OPEN = "";
/** Closes an inline-formula placeholder. */
export const INLINE_MATH_CLOSE = "";
/** `INLINE_MATH_OPEN` + formula index + `INLINE_MATH_CLOSE`. */
export const INLINE_MATH_PLACEHOLDER_RE = /(\d+)/g;

/**
 * Take each inline formula (`$…$` or `\(…\)`) outside code out of `markdown`, before marked can
 * read its `\_`, `\{` and `_…_` as markdown. `formulas[i]` is the LaTeX its
 * placeholder (`INLINE_MATH_OPEN` + i + `INLINE_MATH_CLOSE`) stands for.
 */
export function extractInlineMath(markdown: string): { body: string; formulas: string[] } {
  const formulas: string[] = [];
  const re = new RegExp(`${INLINE_MATH_SOURCE}|${PAREN_MATH_SOURCE}`, "g");
  const body = mapOutsideCode(markdown, (text) =>
    text.replace(re, (_whole, dollar: string | undefined, paren: string | undefined) => {
      const formula = (dollar ?? paren)!;
      formulas.push(formula);
      return `${INLINE_MATH_OPEN}${formulas.length - 1}${INLINE_MATH_CLOSE}`;
    }),
  );
  return { body, formulas };
}

// ── LaTeX → readable text, for Word ────────────────────────────────────────

const SYMBOLS: Record<string, string> = {
  times: "×",
  cdot: "·",
  div: "÷",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "~",
  propto: "∝",
  infty: "∞",
  sum: "Σ",
  prod: "Π",
  int: "∫",
  partial: "∂",
  nabla: "∇",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  varnothing: "∅",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  neg: "¬",
  lnot: "¬",
  exists: "∃",
  forall: "∀",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  implies: "⇒",
  iff: "⇔",
  mapsto: "↦",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  langle: "⟨",
  rangle: "⟩",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  circ: "∘",
  bullet: "•",
  star: "⋆",
  prime: "′",
  degree: "°",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  bmod: " mod ",
  mod: " mod ",
  pmod: " mod ",
  quad: "  ",
  qquad: "    ",
};

/** Commands whose one argument is printed as text. */
const TEXT_COMMANDS = new Set([
  "text",
  "textrm",
  "textit",
  "textbf",
  "texttt",
  "textsf",
  "mathrm",
  "mathit",
  "mathbf",
  "mathsf",
  "mathtt",
  "mathcal",
  "mathbb",
  "boldsymbol",
  "operatorname",
  "mbox",
  "hbox",
  "emph",
]);

/** Delimiter-size commands, dropped: `\big(` prints `(`. */
const SIZE_COMMANDS = new Set([
  "left",
  "right",
  "middle",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "Biggl",
  "Biggr",
  "displaystyle",
  "textstyle",
  "limits",
  "nolimits",
]);

/** A converted group that needs brackets when it is a fraction's part or an exponent. */
function bracket(text: string): string {
  const t = text.trim();
  return !t || /^[\w.′]+$/u.test(t) || isWrapped(t) ? t : `(${t})`;
}

/** True when one pair of parentheses encloses all of `t`: `(a + b)`, not `(a) + (b)`. */
function isWrapped(t: string): boolean {
  if (!t.startsWith("(") || !t.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    if (depth === 0 && i < t.length - 1) return false;
  }
  return depth === 0;
}

class LatexReader {
  private i = 0;
  /** How many `cases` environments are open. */
  private cases = 0;
  constructor(private readonly src: string) {}

  /** Convert until the end, or until `stop` (a closing `}`) at this level. */
  read(stop?: string): string {
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (stop && c === stop) {
        this.i++;
        return out;
      }
      out += this.next();
    }
    return out;
  }

  /** One argument: a `{group}`, a command, or one character. */
  private argument(): string {
    while (this.src[this.i] === " ") this.i++;
    if (this.src[this.i] === "{") {
      this.i++;
      return this.read("}");
    }
    if (this.i >= this.src.length) return "";
    return this.next();
  }

  private next(): string {
    const c = this.src[this.i]!;
    if (c === "{") {
      this.i++;
      return this.read("}");
    }
    if (c === "}") {
      this.i++;
      return "";
    }
    if (c === "^" || c === "_") {
      this.i++;
      const arg = this.argument();
      return `${c}${bracket(arg)}`;
    }
    if (c === "&") {
      // A `cases` row is "value, condition"; elsewhere `&` only aligns.
      this.i++;
      return this.cases > 0 ? ", " : " ";
    }
    if (c === "~") {
      this.i++;
      return " ";
    }
    if (c !== "\\") {
      this.i++;
      return c;
    }
    return this.command();
  }

  private command(): string {
    this.i++; // the backslash
    const ch = this.src[this.i];
    if (ch === undefined) return "";
    if (!/[A-Za-z]/.test(ch)) {
      this.i++;
      if (ch === "\\") return "; ";
      if (",;:! ".includes(ch)) return ch === "!" ? "" : " ";
      return ch; // \{ \} \_ \$ \# \% \& \|
    }
    let name = "";
    while (this.i < this.src.length && /[A-Za-z]/.test(this.src[this.i]!)) {
      name += this.src[this.i];
      this.i++;
    }
    if (TEXT_COMMANDS.has(name)) return this.argument();
    if (SIZE_COMMANDS.has(name)) return "";
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const numerator = this.argument();
      const denominator = this.argument();
      return `${bracket(numerator)} / ${bracket(denominator)}`;
    }
    if (name === "sqrt") {
      return `√${bracket(this.argument())}`;
    }
    if (name === "begin") {
      if (this.argument() !== "cases") return "";
      this.cases++;
      return "{ ";
    }
    if (name === "end") {
      if (this.argument() !== "cases") return "";
      this.cases--;
      return " }";
    }
    if (name in SYMBOLS) return SYMBOLS[name]!;
    // An operator name (\min, \log, \max) or anything unknown: its name, as text.
    return name;
  }
}

/**
 * A formula as readable plain text: `\frac{a+b}{2}` → `(a+b) / 2`,
 * `\text{rank} \times 2` → `rank × 2`, `score_{final}` → `score_final`.
 * Word has no LaTeX, and a raw `\text{…}` is not something a reader can use.
 */
export function latexToText(latex: string): string {
  return new LatexReader(latex)
    .read()
    .replace(/\s+/g, " ")
    .replace(/ ([,;])/g, "$1")
    .replace(/;\s*(}|$)/g, " $1") // a row break before the end of `cases` or the formula
    .trim();
}

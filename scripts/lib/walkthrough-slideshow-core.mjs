/**
 * Build the e2e-walkthrough slideshows (Issue #829).
 *
 * ## Why this exists
 *
 * Every walkthrough run (#706, skill `e2e-walkthrough`) leaves a folder of screenshots that
 * nobody but the reviewer ever opens. Each wave now also appends one JSON line per screenshot
 * to `<evidence-dir>/steps.jsonl`, and this module turns that manifest into two static HTML
 * decks:
 *
 * - a **tutorial** deck — the steps that worked, narrated as user-facing "how to" text, so a
 *   run doubles as a guided tour of METIS on a real project;
 * - a **run report** deck — every step, with its verdict, outcome, spend and linked issues,
 *   so runs can be compared side by side.
 *
 * ## Safety model
 *
 * The manifest is written by an agent driving a browser, so every text field is untrusted.
 * Text is HTML-escaped first and only then given a tiny Markdown subset (bold, code, and
 * http(s) links), so no field can ever become markup. Screenshot paths must resolve — after
 * symlinks — to a file inside the evidence directory. The decks carry a Content Security
 * Policy with no inline event handlers and no network origins, so they open offline.
 *
 * The CLI in `scripts/walkthrough/build-slideshow.mjs` is argv glue around `runCli` here, so
 * everything with a decision in it is measured by this package's coverage gate.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The two scales `docs/walkthroughs/RESULTS_TEMPLATE.md` scores every phase on, in the order the
 * report tallies them. Works: did the feature do what it should. Useful: was it worth using.
 */
export const WORKS = /** @type {const} */ (["pass", "partial", "fail", "blocked"]);
export const USEFUL = /** @type {const} */ (["pass", "weak", "fail", "n/a"]);

/** Works values the tutorial deck leaves out: it must not teach a step that did not work. */
export const TUTORIAL_EXCLUDED_WORKS = new Set(["fail", "blocked"]);

/** Useful values the tutorial deck leaves out: a step that works but is useless is not taught. */
export const TUTORIAL_EXCLUDED_USEFUL = new Set(["fail"]);

/** Walkthrough waves, in run order (`e2e-walkthrough` skill, section 3). */
export const WAVES = /** @type {const} */ (["A", "B", "C", "D", "E"]);

/** The base every issue link points at. */
export const ISSUE_URL_BASE = "https://github.com/openzigs/metis/issues/";

/** Above this size an `--inline-images` deck is unwieldy to share; the build warns. */
export const INLINE_WARN_BYTES = 15 * 1024 * 1024;

/** Screenshot types the decks accept, with the MIME type used for an inlined data URI. */
export const IMAGE_TYPES = /** @type {Record<string, string>} */ ({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
});

/** An ISO-8601 date-time with a zone, e.g. `2026-10-03T09:12:00Z`; `Date.parse` alone accepts far more. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const REQUIRED_STRING_FIELDS = ["id", "phase", "chapter", "title", "screenshot", "ts"];
const OPTIONAL_STRING_FIELDS = ["tutorial", "result"];
const KNOWN_FIELDS = new Set([
  ...REQUIRED_STRING_FIELDS,
  ...OPTIONAL_STRING_FIELDS,
  "wave",
  "works",
  "useful",
  "issues",
  "tokens",
  "costCents",
]);

const ASSET_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "walkthrough",
  "slideshow",
);

/**
 * @typedef {object} Step
 * @property {string} id
 * @property {string} wave
 * @property {string} phase
 * @property {string} chapter
 * @property {string} title
 * @property {string} screenshot
 * @property {string} tutorial
 * @property {string} result
 * @property {string} works
 * @property {string} useful
 * @property {number[]} issues
 * @property {number | undefined} tokens
 * @property {number | undefined} costCents
 * @property {string} ts
 */

/**
 * Validate one parsed manifest line.
 *
 * @param {unknown} raw
 * @param {number} line 1-based line number, for messages
 * @returns {{ step: Step | null, errors: string[] }}
 */
export function validateStep(raw, line) {
  const errors = [];
  const at = `steps.jsonl line ${line}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { step: null, errors: [`${at}: expected a JSON object`] };
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);

  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) errors.push(`${at}: unknown field "${key}"`);
  }
  for (const key of REQUIRED_STRING_FIELDS) {
    if (typeof obj[key] !== "string" || obj[key].trim() === "") {
      errors.push(`${at}: "${key}" must be a non-empty string`);
    }
  }
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") {
      errors.push(`${at}: "${key}" must be a string when present`);
    }
  }
  if (!WAVES.includes(/** @type {any} */ (obj.wave))) {
    errors.push(`${at}: "wave" must be one of ${WAVES.join(", ")}`);
  }
  if (!WORKS.includes(/** @type {any} */ (obj.works))) {
    errors.push(`${at}: "works" must be one of ${WORKS.join(", ")}`);
  }
  if (!USEFUL.includes(/** @type {any} */ (obj.useful))) {
    errors.push(`${at}: "useful" must be one of ${USEFUL.join(", ")}`);
  }
  if (
    typeof obj.ts === "string" &&
    !(ISO_TIMESTAMP.test(obj.ts) && !Number.isNaN(Date.parse(obj.ts)))
  ) {
    errors.push(`${at}: "ts" must be an ISO-8601 timestamp`);
  }
  if (
    obj.issues !== undefined &&
    !(
      Array.isArray(obj.issues) &&
      obj.issues.every((n) => Number.isInteger(n) && /** @type {number} */ (n) > 0)
    )
  ) {
    errors.push(`${at}: "issues" must be an array of positive issue numbers`);
  }
  if (obj.tokens !== undefined && !(Number.isInteger(obj.tokens) && Number(obj.tokens) >= 0)) {
    errors.push(`${at}: "tokens" must be a non-negative integer when present`);
  }
  if (
    obj.costCents !== undefined &&
    !(typeof obj.costCents === "number" && Number.isFinite(obj.costCents) && obj.costCents >= 0)
  ) {
    errors.push(`${at}: "costCents" must be a non-negative number when present`);
  }
  if (errors.length > 0) return { step: null, errors };

  return {
    step: {
      id: /** @type {string} */ (obj.id),
      wave: /** @type {string} */ (obj.wave),
      phase: /** @type {string} */ (obj.phase),
      chapter: /** @type {string} */ (obj.chapter),
      title: /** @type {string} */ (obj.title),
      screenshot: /** @type {string} */ (obj.screenshot),
      tutorial: typeof obj.tutorial === "string" ? obj.tutorial : "",
      result: typeof obj.result === "string" ? obj.result : "",
      works: /** @type {string} */ (obj.works),
      useful: /** @type {string} */ (obj.useful),
      issues: /** @type {number[]} */ (obj.issues ?? []),
      tokens: /** @type {number | undefined} */ (obj.tokens),
      costCents: /** @type {number | undefined} */ (obj.costCents),
      ts: /** @type {string} */ (obj.ts),
    },
    errors: [],
  };
}

/**
 * Parse and validate a whole `steps.jsonl`. Blank lines are skipped; every other line must be
 * a valid step, and step ids must be unique.
 *
 * @param {string} text
 * @returns {{ steps: Step[], errors: string[] }}
 */
export function parseManifest(text) {
  /** @type {Step[]} */
  const steps = [];
  /** @type {string[]} */
  const errors = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((content, i) => {
    const line = i + 1;
    if (content.trim() === "") return;
    let raw;
    try {
      raw = JSON.parse(content);
    } catch {
      errors.push(`steps.jsonl line ${line}: not valid JSON`);
      return;
    }
    const { step, errors: stepErrors } = validateStep(raw, line);
    errors.push(...stepErrors);
    if (!step) return;
    if (seen.has(step.id)) {
      errors.push(`steps.jsonl line ${line}: duplicate id "${step.id}"`);
      return;
    }
    seen.add(step.id);
    steps.push(step);
  });
  if (steps.length === 0 && errors.length === 0) errors.push("steps.jsonl: no steps");
  return { steps, errors };
}

const PHASE_RE = /^(\D*)(\d*)(.*)$/s;

/**
 * Natural order for phases: plain numbers first ("2" < "10"), then prefixed ones ("S2" < "S10"),
 * each compared by prefix then number.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function comparePhase(a, b) {
  // The pattern matches every string, so `exec` never returns null here.
  const pa = /** @type {RegExpExecArray} */ (PHASE_RE.exec(a.trim()));
  const pb = /** @type {RegExpExecArray} */ (PHASE_RE.exec(b.trim()));
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  const na = pa[2] === "" ? Number.POSITIVE_INFINITY : Number(pa[2]);
  const nb = pb[2] === "" ? Number.POSITIVE_INFINITY : Number(pb[2]);
  if (na !== nb) return na < nb ? -1 : 1;
  if (pa[3] !== pb[3]) return pa[3] < pb[3] ? -1 : 1;
  return 0;
}

/**
 * Order steps by wave, then phase; steps in the same phase keep manifest order.
 *
 * @param {Step[]} steps
 * @returns {Step[]}
 */
export function orderSteps(steps) {
  return steps
    .map((step, index) => ({ step, index }))
    .sort(
      (x, y) =>
        WAVES.indexOf(/** @type {any} */ (x.step.wave)) -
          WAVES.indexOf(/** @type {any} */ (y.step.wave)) ||
        comparePhase(x.step.phase, y.step.phase) ||
        x.index - y.index,
    )
    .map(({ step }) => step);
}

/**
 * Group ordered steps into chapters, in order of each chapter's first step. With `contiguous`,
 * only adjacent steps share a group, so the input order is kept exactly (the report deck).
 *
 * @param {Step[]} steps already ordered
 * @param {{ contiguous?: boolean }} [opts]
 * @returns {{ chapter: string, steps: Step[] }[]}
 */
export function groupChapters(steps, opts = {}) {
  if (opts.contiguous) {
    /** @type {{ chapter: string, steps: Step[] }[]} */
    const groups = [];
    for (const step of steps) {
      const last = groups.at(-1);
      if (last && last.chapter === step.chapter) last.steps.push(step);
      else groups.push({ chapter: step.chapter, steps: [step] });
    }
    return groups;
  }
  /** @type {Map<string, Step[]>} */
  const byChapter = new Map();
  for (const step of steps) {
    const list = byChapter.get(step.chapter);
    if (list) list.push(step);
    else byChapter.set(step.chapter, [step]);
  }
  return [...byChapter].map(([chapter, list]) => ({ chapter, steps: list }));
}

/**
 * The steps a tutorial may teach: not failed or blocked, not useless, and with tutorial text.
 *
 * @param {Step[]} steps
 * @returns {Step[]}
 */
export function selectTutorialSteps(steps) {
  return steps.filter(
    (s) =>
      !TUTORIAL_EXCLUDED_WORKS.has(s.works) &&
      !TUTORIAL_EXCLUDED_USEFUL.has(s.useful) &&
      s.tutorial.trim() !== "",
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

/**
 * Render bold and http(s) links in a code-free run of raw text. Every character of the input
 * reaches the output through `escapeHtml`; a link whose URL is not http(s) stays literal text.
 *
 * @param {string} raw
 * @returns {string}
 */
function renderLinksAndBold(raw) {
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(LINK_RE)) {
    const index = /** @type {number} */ (m.index);
    out += renderBold(raw.slice(last, index));
    const [whole, label, url] = m;
    if (/^https?:\/\//i.test(url)) {
      out += `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${renderBold(label)}</a>`;
    } else {
      out += renderBold(whole);
    }
    last = index + whole.length;
  }
  return out + renderBold(raw.slice(last));
}

/**
 * @param {string} raw
 * @returns {string}
 */
function renderBold(raw) {
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(BOLD_RE)) {
    const index = /** @type {number} */ (m.index);
    out += escapeHtml(raw.slice(last, index)) + `<strong>${escapeHtml(m[1])}</strong>`;
    last = index + m[0].length;
  }
  return out + escapeHtml(raw.slice(last));
}

/**
 * The Markdown subset narration may use, on one line: `**bold**`, `` `code` `` and
 * `[label](https://…)`. Anything else is text.
 *
 * @param {string} raw
 * @returns {string}
 */
export function renderInline(raw) {
  return raw
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      i % 2 === 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : renderLinksAndBold(part),
    )
    .join("");
}

/**
 * Narration as paragraphs: blank lines separate paragraphs, single newlines become breaks.
 *
 * @param {string} raw
 * @returns {string}
 */
export function renderNarration(raw) {
  return raw
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${p.trim().split(/\r?\n/).map(renderInline).join("<br>")}</p>`)
    .join("");
}

/**
 * Resolve a step's screenshot inside the evidence directory, or throw. Rejects absolute paths,
 * any `..` segment, unknown image types, missing files, and symlinks that escape the directory.
 *
 * @param {string} evidenceDir
 * @param {string} rel
 * @returns {string} the real absolute path
 */
export function resolveScreenshot(evidenceDir, rel) {
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-z]+:/i.test(rel)) {
    throw new Error(`screenshot "${rel}" must be a relative path inside the evidence directory`);
  }
  if (rel.split(/[\\/]/).includes("..")) {
    throw new Error(`screenshot "${rel}" must not contain ".."`);
  }
  if (!(path.extname(rel).toLowerCase() in IMAGE_TYPES)) {
    throw new Error(`screenshot "${rel}" is not a supported image type`);
  }
  const root = fs.realpathSync(evidenceDir);
  const candidate = path.resolve(root, rel);
  if (!fs.existsSync(candidate)) {
    throw new Error(`screenshot "${rel}" does not exist`);
  }
  const real = fs.realpathSync(candidate);
  const inside = path.relative(root, real);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`screenshot "${rel}" resolves outside the evidence directory`);
  }
  return real;
}

/**
 * @param {number} n
 * @param {string} noun
 * @returns {string}
 */
export function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * @param {number} cents
 * @returns {string}
 */
export function formatCost(cents) {
  const dollars = cents / 100;
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

/**
 * @param {number[]} issues
 * @returns {string}
 */
function renderIssueLinks(issues) {
  return issues
    .map(
      (n) => `<a href="${ISSUE_URL_BASE}${n}" rel="noopener noreferrer" target="_blank">#${n}</a>`,
    )
    .join(" ");
}

/**
 * @param {string} value a WORKS or USEFUL value
 * @param {string} [axis] "Works" or "Useful"; prefixes the label on a step slide
 * @returns {string}
 */
function scoreBadge(value, axis) {
  const cls = value === "n/a" ? "na" : value;
  const label = axis ? `${axis}: ${value}` : value;
  return `<span class="badge badge--${escapeHtml(cls)}">${escapeHtml(label)}</span>`;
}

/**
 * @typedef {object} DeckInput
 * @property {"tutorial" | "report"} kind
 * @property {string} title
 * @property {Step[]} steps all valid steps; the deck selects and orders them itself
 * @property {(step: Step) => string} imageSrc the `src` for a step's screenshot
 * @property {{ css: string, js: string } | null} inlineAssets inline the CSS and JS, or link them
 * @property {string} [generatedAt] ISO timestamp shown on the title slide
 */

/**
 * @param {string} title
 * @param {string} subtitle
 * @param {string} body
 * @returns {string}
 */
function titleSlide(title, subtitle, body) {
  return `<section class="slide slide--title" aria-label="${escapeHtml(title)}">
  <div class="title">
    <p class="wordmark" aria-label="METIS">METIS</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">${escapeHtml(subtitle)}</p>
    ${body}
  </div>
</section>`;
}

/**
 * @param {Step} step
 * @param {DeckInput} input
 * @param {{ chapter: string, chapterNo: number, chapterCount: number, stepNo: number, stepCount: number }} pos
 * @returns {string}
 */
function stepSlide(step, input, pos) {
  const tutorial = input.kind === "tutorial";
  const narration = tutorial
    ? `<div class="narration__text">${renderNarration(step.tutorial)}</div>`
    : `<p class="verdict">${scoreBadge(step.works, "Works")}${scoreBadge(step.useful, "Useful")}<span class="where">Wave ${escapeHtml(step.wave)} · Phase ${escapeHtml(step.phase)}</span></p>
      <div class="narration__text">${renderNarration(step.result) || '<p class="muted">No result recorded.</p>'}</div>
      <dl class="facts">
        <dt>Tokens</dt><dd>${step.tokens === undefined ? "–" : step.tokens.toLocaleString("en-US")}</dd>
        <dt>Cost</dt><dd>${step.costCents === undefined ? "–" : formatCost(step.costCents)}</dd>
        <dt>Issues</dt><dd>${step.issues.length ? renderIssueLinks(step.issues) : "–"}</dd>
      </dl>`;
  const notes =
    tutorial && step.result.trim() !== ""
      ? `<aside class="notes" aria-label="Presenter notes">${renderNarration(step.result)}</aside>`
      : "";
  return `<section class="slide slide--step${tutorial ? "" : ` slide--${escapeHtml(step.works)}`}" aria-label="${escapeHtml(step.title)}">
  <header class="meta">
    <span class="meta__chapter">${escapeHtml(pos.chapter)} <span class="muted">· Chapter ${pos.chapterNo} of ${pos.chapterCount}</span></span>
    <span class="meta__counter">Step ${pos.stepNo} of ${pos.stepCount}</span>
  </header>
  <div class="layout">
    <figure class="shot">
      <button type="button" class="shot__zoom" aria-label="Enlarge screenshot: ${escapeHtml(step.title)}">
        <img src="${escapeHtml(input.imageSrc(step))}" alt="${escapeHtml(step.title)}" loading="lazy" decoding="async">
      </button>
    </figure>
    <div class="narration">
      <h2>${escapeHtml(step.title)}</h2>
      ${narration}
    </div>
  </div>
  ${notes}
</section>`;
}

/**
 * Render the slide sections of a deck.
 *
 * @param {DeckInput} input
 * @returns {string[]}
 */
export function renderSlides(input) {
  const tutorial = input.kind === "tutorial";
  const ordered = orderSteps(tutorial ? selectTutorialSteps(input.steps) : input.steps);
  const chapters = groupChapters(ordered, { contiguous: !tutorial });
  const generated = input.generatedAt ? ` · Generated ${input.generatedAt.slice(0, 10)}` : "";

  /** @type {string[]} */
  const slides = [];
  // Slide numbers are 1-based and match the URL hash the deck script uses.
  // Slide 1 is the title and slide 2 the contents (tutorial) or summary (report).
  const chapterSlide = /** @type {number[]} */ ([]);
  let next = 3;
  for (const c of chapters) {
    chapterSlide.push(next);
    next += c.steps.length + (tutorial ? 1 : 0);
  }

  if (tutorial) {
    slides.push(
      titleSlide(
        input.title,
        `${plural(ordered.length, "step")} in ${plural(chapters.length, "chapter")}${generated}`,
        `<p class="hint">Use the arrow keys or swipe · <kbd>G</kbd> for the slide index · <kbd>N</kbd> for notes</p>`,
      ),
    );
    slides.push(`<section class="slide slide--toc" aria-label="Contents">
  <h2>Contents</h2>
  <ol class="toc">
${chapters
  .map(
    (c, i) =>
      `    <li><a href="#${chapterSlide[i]}">${escapeHtml(c.chapter)}</a> <span class="muted">${plural(c.steps.length, "step")}</span></li>`,
  )
  .join("\n")}
  </ol>
</section>`);
  } else {
    const steps = ordered;
    const tokens = steps.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
    const cents = steps.reduce((sum, s) => sum + (s.costCents ?? 0), 0);
    const issues = [...new Set(steps.flatMap((s) => s.issues))].sort((a, b) => a - b);
    slides.push(
      titleSlide(input.title, `Run report, ${plural(steps.length, "step")}${generated}`, ""),
    );
    slides.push(`<section class="slide slide--summary" aria-label="Summary">
  <h2>Summary</h2>
${
  /** @type {Array<[string, readonly string[], "works" | "useful"]>} */ ([
    ["Works", WORKS, "works"],
    ["Useful", USEFUL, "useful"],
  ])
    .map(
      ([axis, scale, key]) => `  <div class="tally" role="group" aria-label="${axis}">
    <span class="tally__axis">${axis}</span>
${scale
  .map(
    (v) =>
      `    <div class="tally__item">${scoreBadge(v)}<span class="tally__n">${steps.filter((s) => s[key] === v).length}</span></div>`,
  )
  .join("\n")}
  </div>`,
    )
    .join("\n")
}
  <table class="waves">
    <thead><tr><th scope="col">Wave</th>${WORKS.map((v) => `<th scope="col">Works ${v}</th>`).join("")}${USEFUL.map((v) => `<th scope="col">Useful ${v}</th>`).join("")}<th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead>
    <tbody>
${WAVES.filter((w) => steps.some((s) => s.wave === w))
  .map((w) => {
    const ws = steps.filter((s) => s.wave === w);
    return `      <tr><th scope="row">${w}</th>${WORKS.map((v) => `<td>${ws.filter((s) => s.works === v).length}</td>`).join("")}${USEFUL.map((v) => `<td>${ws.filter((s) => s.useful === v).length}</td>`).join("")}<td>${ws.reduce((t, s) => t + (s.tokens ?? 0), 0).toLocaleString("en-US")}</td><td>${formatCost(ws.reduce((t, s) => t + (s.costCents ?? 0), 0))}</td></tr>`;
  })
  .join("\n")}
    </tbody>
  </table>
  <p class="spend">Spend: <strong>${tokens.toLocaleString("en-US")}</strong> tokens · <strong>${formatCost(cents)}</strong></p>
  <p class="spend">Issues: ${issues.length ? renderIssueLinks(issues) : "none"}</p>
</section>`);
  }

  chapters.forEach((c, ci) => {
    if (tutorial) {
      slides.push(`<section class="slide slide--chapter" aria-label="${escapeHtml(c.chapter)}">
  <p class="eyebrow">Chapter ${ci + 1} of ${chapters.length}</p>
  <h2>${escapeHtml(c.chapter)}</h2>
  <ol class="chapter__steps">
${c.steps.map((s) => `    <li>${escapeHtml(s.title)}</li>`).join("\n")}
  </ol>
</section>`);
    }
    c.steps.forEach((step, si) => {
      slides.push(
        stepSlide(step, input, {
          chapter: c.chapter,
          chapterNo: ci + 1,
          chapterCount: chapters.length,
          stepNo: si + 1,
          stepCount: c.steps.length,
        }),
      );
    });
  });
  return slides;
}

/**
 * @param {string} content
 * @returns {string}
 */
function cspHash(content) {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

/**
 * Render a complete deck document.
 *
 * @param {DeckInput} input
 * @returns {string}
 */
export function renderDeck(input) {
  const slides = renderSlides(input);
  const inline = input.inlineAssets;
  // Inline assets are allowed by hash, never by 'unsafe-inline'; linked ones by 'self'.
  const scriptSrc = inline ? cspHash(inline.js) : "'self'";
  const styleSrc = inline ? cspHash(inline.css) : "'self'";
  const csp = [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src ${inline ? "data:" : "'self'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const head = inline
    ? `<style>${inline.css}</style>`
    : `<link rel="stylesheet" href="assets/slideshow.css">`;
  // A `</script` inside the inlined script would end the element early; the shipped file has
  // none, and this guard keeps it that way.
  if (inline && /<\/script/i.test(inline.js)) throw new Error("inline script contains </script");
  const script = inline
    ? `<script>${inline.js}</script>`
    : `<script src="assets/slideshow.js"></script>`;

  return `<!doctype html>
<html lang="en" data-deck="${input.kind}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.title)}</title>
${head}
</head>
<body>
<a class="skip" href="#deck">Skip to slides</a>
<main id="deck" class="deck" tabindex="-1">
${slides.join("\n")}
</main>
<div class="chrome">
  <div class="progress" title="Jump to slide"><div class="progress__fill"></div></div>
  <div class="controls">
    <button type="button" class="ctl" data-action="prev" aria-label="Previous slide">&larr;</button>
    <span class="counter" aria-live="polite"></span>
    <button type="button" class="ctl" data-action="next" aria-label="Next slide">&rarr;</button>
    <button type="button" class="ctl" data-action="index" aria-label="Slide index (G)">&#9776;</button>
    ${input.kind === "tutorial" ? `<button type="button" class="ctl" data-action="notes" aria-label="Presenter notes (N)" aria-pressed="false">N</button>` : ""}
    <button type="button" class="ctl" data-action="theme" aria-label="Toggle light and dark theme">&#9680;</button>
  </div>
</div>
<nav class="overlay" aria-label="Slide index" hidden>
  <div class="overlay__panel">
    <h2>Slides</h2>
    <ol class="overlay__list"></ol>
  </div>
</nav>
<div class="lightbox" role="dialog" aria-modal="true" aria-label="Screenshot" hidden>
  <img class="lightbox__img" alt="">
</div>
${script}
</body>
</html>
`;
}

/**
 * @typedef {object} CliOptions
 * @property {string} inDir
 * @property {string} outDir
 * @property {"tutorial" | "report" | "both"} deck
 * @property {string | undefined} title
 * @property {boolean} inlineImages
 */

export const USAGE =
  "Usage: node scripts/walkthrough/build-slideshow.mjs --in <evidence-dir> --out <dir> " +
  "--deck tutorial|report|both [--title <text>] [--inline-images]";

/**
 * @param {string[]} argv arguments after the script name
 * @returns {CliOptions}
 */
export function parseArgs(argv) {
  /** @type {Partial<CliOptions> & { inlineImages: boolean }} */
  const opts = { inlineImages: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--inline-images") {
      opts.inlineImages = true;
      continue;
    }
    const value = argv[i + 1];
    if (!["--in", "--out", "--deck", "--title"].includes(arg)) {
      throw new Error(`unknown argument "${arg}"`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} needs a value`);
    }
    i++;
    if (arg === "--in") opts.inDir = value;
    else if (arg === "--out") opts.outDir = value;
    else if (arg === "--title") opts.title = value;
    else {
      if (value !== "tutorial" && value !== "report" && value !== "both") {
        throw new Error(`--deck must be tutorial, report or both`);
      }
      opts.deck = value;
    }
  }
  if (!opts.inDir) throw new Error("--in is required");
  if (!opts.outDir) throw new Error("--out is required");
  if (!opts.deck) throw new Error("--deck is required");
  return /** @type {CliOptions} */ (opts);
}

/**
 * Read the shipped deck stylesheet and script.
 *
 * @returns {{ css: string, js: string }}
 */
export function readAssets() {
  return {
    css: fs.readFileSync(path.join(ASSET_DIR, "slideshow.css"), "utf8"),
    js: fs.readFileSync(path.join(ASSET_DIR, "slideshow.js"), "utf8"),
  };
}

/**
 * Make a flat, collision-free asset file name for a screenshot.
 *
 * @param {number} index
 * @param {string} rel
 * @returns {string}
 */
function assetName(index, rel) {
  const base = path.basename(rel).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${String(index + 1).padStart(3, "0")}-${base}`;
}

/**
 * Build the requested decks from an evidence directory.
 *
 * @param {CliOptions & { now?: Date }} opts
 * @returns {{ decks: { kind: string, file: string, bytes: number }[], warnings: string[] }}
 */
export function buildSlideshow(opts) {
  const manifestPath = path.join(opts.inDir, "steps.jsonl");
  if (!fs.existsSync(manifestPath)) throw new Error(`no steps.jsonl in ${opts.inDir}`);
  const { steps, errors } = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  if (errors.length > 0) throw new Error(`invalid manifest:\n  ${errors.join("\n  ")}`);

  /** @type {Map<string, string>} step id -> real screenshot path */
  const shots = new Map();
  /** @type {string[]} */
  const pathErrors = [];
  for (const step of steps) {
    try {
      shots.set(step.id, resolveScreenshot(opts.inDir, step.screenshot));
    } catch (err) {
      pathErrors.push(`step "${step.id}": ${/** @type {Error} */ (err).message}`);
    }
  }
  if (pathErrors.length > 0) throw new Error(`invalid screenshots:\n  ${pathErrors.join("\n  ")}`);

  const assets = readAssets();
  const kinds = /** @type {("tutorial" | "report")[]} */ (
    opts.deck === "both" ? ["tutorial", "report"] : [opts.deck]
  );
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const decks = [];
  const warnings = [];

  for (const kind of kinds) {
    const deckDir = path.join(opts.outDir, kind);
    fs.mkdirSync(deckDir, { recursive: true });
    const title =
      opts.title ?? (kind === "tutorial" ? "Using METIS: a guided tour" : "METIS walkthrough");
    const deckSteps = kind === "tutorial" ? selectTutorialSteps(steps) : steps;
    /** @type {Map<string, string>} */
    const src = new Map();

    if (opts.inlineImages) {
      for (const step of deckSteps) {
        const real = /** @type {string} */ (shots.get(step.id));
        const mime = IMAGE_TYPES[path.extname(real).toLowerCase()];
        src.set(step.id, `data:${mime};base64,${fs.readFileSync(real).toString("base64")}`);
      }
    } else {
      const assetDir = path.join(deckDir, "assets");
      // Clear the previous build's screenshots: they are unredacted and would travel with the folder.
      fs.rmSync(path.join(assetDir, "img"), { recursive: true, force: true });
      fs.mkdirSync(path.join(assetDir, "img"), { recursive: true });
      fs.writeFileSync(path.join(assetDir, "slideshow.css"), assets.css);
      fs.writeFileSync(path.join(assetDir, "slideshow.js"), assets.js);
      deckSteps.forEach((step, i) => {
        const name = assetName(i, step.screenshot);
        fs.copyFileSync(
          /** @type {string} */ (shots.get(step.id)),
          path.join(assetDir, "img", name),
        );
        src.set(step.id, `assets/img/${name}`);
      });
    }

    const html = renderDeck({
      kind,
      title: kind === "report" && opts.title ? `${opts.title}: run report` : title,
      steps: deckSteps,
      imageSrc: (step) => /** @type {string} */ (src.get(step.id)),
      inlineAssets: opts.inlineImages ? assets : null,
      generatedAt,
    });
    const file = path.join(deckDir, "index.html");
    fs.writeFileSync(file, html);
    const bytes = Buffer.byteLength(html);
    if (opts.inlineImages && bytes > INLINE_WARN_BYTES) {
      warnings.push(
        `${kind} deck is ${(bytes / 1024 / 1024).toFixed(1)} MB inlined (over 15 MB); ` +
          "share the folder build instead",
      );
    }
    decks.push({ kind, file, bytes });
  }
  return { decks, warnings };
}

/**
 * The CLI, with its streams injected so it can be tested in-process.
 *
 * @param {string[]} argv
 * @param {{ log: (msg: string) => void, error: (msg: string) => void }} io
 * @returns {number} exit code
 */
export function runCli(argv, io) {
  /** @type {CliOptions} */
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.error(`build-slideshow: ${/** @type {Error} */ (err).message}\n${USAGE}`);
    return 2;
  }
  try {
    const { decks, warnings } = buildSlideshow(opts);
    for (const w of warnings) io.error(`build-slideshow: warning: ${w}`);
    for (const d of decks) io.log(`${d.kind}: ${d.file} (${(d.bytes / 1024).toFixed(0)} KB)`);
    return 0;
  } catch (err) {
    io.error(`build-slideshow: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
}

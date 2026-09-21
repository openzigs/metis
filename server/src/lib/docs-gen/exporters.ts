/**
 * Epic #486 / Issue #491 — PDF + Word Export.
 *
 * Converts generated markdown into PDF or DOCX format.
 * PDF: Uses Puppeteer to render markdown as styled HTML with Mermaid diagrams, then page.pdf().
 * Word: Uses the docx library with TOC, headings, code blocks, tables, and Mermaid diagrams
 *       rendered as PNG images via Puppeteer.
 */

import type { Browser } from "puppeteer";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Resolve the local mermaid bundle at module load time to avoid CDN in Puppeteer
const _req = createRequire(import.meta.url);
const _dirName = path.dirname(fileURLToPath(import.meta.url));

// Inline the logo SVG so it renders correctly in PDF (no file:// path needed)
let _logoSvg: string | null = null;
try {
  _logoSvg = readFileSync(path.resolve(_dirName, "../../../../static/icon.svg"), "utf8");
} catch {
  _logoSvg = null;
}
let _mermaidPath: string | null = null;
try {
  _mermaidPath = _req.resolve("mermaid/dist/mermaid.min.js");
} catch {
  _mermaidPath = null;
}
let _katexJsPath: string | null = null;
let _katexCssPath: string | null = null;
let _katexAutoRenderPath: string | null = null;
try {
  _katexJsPath = _req.resolve("katex/dist/katex.min.js");
  _katexCssPath = _req.resolve("katex/dist/katex.min.css");
  _katexAutoRenderPath = _req.resolve("katex/dist/contrib/auto-render.min.js");
} catch {
  _katexJsPath = null;
}

export interface ExportResult {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Export a markdown document to the specified format.
 */
export async function exportDocument(
  markdown: string,
  title: string,
  format: "pdf" | "docx" | "markdown",
): Promise<ExportResult> {
  const safeTitle = title.replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 100);

  if (format === "pdf") {
    return exportToPdf(markdown, safeTitle);
  }
  if (format === "markdown") {
    return exportToMarkdown(markdown, safeTitle);
  }
  return exportToDocx(markdown, safeTitle);
}

// ============================================================================
// Markdown Export — generated docs are already stored as markdown internally,
// so this is a pass-through of the source with the correct download headers.
// ============================================================================

function exportToMarkdown(markdown: string, title: string): ExportResult {
  return {
    buffer: Buffer.from(markdown, "utf-8"),
    mimeType: "text/markdown",
    filename: `${title}.md`,
  };
}

// ============================================================================
// PDF Export — Puppeteer with Mermaid rendering
// ============================================================================

const PDF_CSS = `
  @page { margin: 2cm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.7;
    max-width: 100%;
    color: #1a1a1a;
    font-size: 11pt;
  }
  h1 { border-bottom: 2px solid #2563eb; padding-bottom: 0.5rem; margin-top: 2.5rem; color: #1e3a5f; page-break-before: always; }
  h1:first-child { page-break-before: avoid; }
  h2 { border-bottom: 1px solid #cbd5e1; padding-bottom: 0.3rem; margin-top: 2rem; color: #334155; }
  h3 { margin-top: 1.5rem; color: #475569; }
  h4 { margin-top: 1.2rem; color: #64748b; }
  code {
    background: #f1f5f9;
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.85em;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    color: #dc2626;
  }
  pre {
    background: #1e293b;
    color: #e2e8f0;
    padding: 1.2rem;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 0.82em;
    line-height: 1.5;
    page-break-inside: avoid;
  }
  pre code { background: none; padding: 0; color: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; page-break-inside: avoid; }
  th, td { border: 1px solid #e2e8f0; padding: 0.6rem 0.8rem; text-align: left; font-size: 0.9em; }
  th { background: #f8fafc; font-weight: 600; color: #334155; }
  tr:nth-child(even) { background: #f8fafc; }
  blockquote {
    border-left: 4px solid #2563eb;
    margin: 1rem 0;
    padding: 0.8rem 1rem;
    background: #eff6ff;
    color: #1e40af;
    border-radius: 0 6px 6px 0;
  }
  blockquote p { margin: 0; }
  hr { border: none; border-top: 2px solid #e2e8f0; margin: 2rem 0; }
  ul, ol { padding-left: 1.5rem; }
  li { margin-bottom: 0.3rem; }
  img { max-width: 100%; height: auto; }
  .mermaid-container { text-align: center; margin: 1.5rem 0; page-break-inside: avoid; background: white; border-radius: 6px; padding: 1rem; overflow: visible; }
  .mermaid-container svg { max-width: 100%; height: auto; background: white; display: block; margin: 0 auto; }
  .mermaid-container.diagram-oversized { page-break-inside: auto; page-break-before: always; }
  .katex-display { overflow-x: auto; padding: 0.5rem 0; }
  .math-display { text-align: center; margin: 1rem 0; overflow-x: auto; }
  .doc-header { display: flex; align-items: center; gap: 0.75rem; padding-bottom: 1.25rem; margin-bottom: 1.5rem; border-bottom: 2px solid #2563eb; }
  .doc-header img, .doc-header svg { width: 40px; height: 40px; border-radius: 8px; flex-shrink: 0; }
  .doc-header-title { font-size: 1.4rem; font-weight: 700; color: #1e3a5f; }
`;

// #686 — Mermaid diagrams come from LLM-generated, user-influenced markdown and
// are rendered inside a --no-sandbox Chromium on the host network. Under a
// "loose" security level with HTML labels, a crafted node label could execute
// JS in the render page and reach the internal network / cloud metadata
// (SSXSS -> SSRF). Render under the STRICT security level (mermaid runs the
// label through DOMPurify) with HTML labels DISABLED (labels become inert SVG
// <text>). Exported as the single source of truth so the posture is regression-
// tested and the two render sites cannot silently drift back to loose.
export const MERMAID_RENDER_SECURITY = { securityLevel: "strict", htmlLabels: false } as const;

// #686 — Chromium launch args for the export renderer. --no-sandbox is required
// in most container runtimes (no user namespaces), but it weakens isolation, so
// a hardened deployment whose runtime supports the Chrome sandbox can re-enable
// it by setting PDF_EXPORT_CHROME_SANDBOX=true. Diagram-label JS execution is
// already blocked by the strict mermaid security level above, so the sandbox is
// defense-in-depth here.
export function chromeLaunchArgs(): string[] {
  const base = ["--disable-dev-shm-usage"];
  if (process.env.PDF_EXPORT_CHROME_SANDBOX === "true") return base;
  return ["--no-sandbox", "--disable-setuid-sandbox", ...base];
}

async function exportToPdf(markdown: string, title: string): Promise<ExportResult> {
  let puppeteer: typeof import("puppeteer") | undefined;
  try {
    puppeteer = (await import("puppeteer")) as unknown as typeof import("puppeteer");
  } catch {
    return fallbackHtmlExport(markdown, title);
  }

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: chromeLaunchArgs(),
    });
    const page = await browser.newPage();

    const html = await buildHtmlDocument(markdown, title);
    // domcontentloaded is sufficient — mermaid is injected below via addScriptTag
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Inject mermaid from local filesystem (no CDN dependency)
    if (_mermaidPath) {
      await page.addScriptTag({ path: _mermaidPath });
    } else {
      await page.addScriptTag({
        url: "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
      });
    }

    // Render diagrams now that mermaid is loaded, with per-diagram error handling
    await page.evaluate(`
      (async () => {
        mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: '${MERMAID_RENDER_SECURITY.securityLevel}', maxTextSize: 500000, flowchart: { useMaxWidth: true, htmlLabels: ${MERMAID_RENDER_SECURITY.htmlLabels} }, sequence: { useMaxWidth: true } });
        const elements = document.querySelectorAll('pre.mermaid');
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          const container = el.closest('.mermaid-container') || el.parentElement;
          const code = el.textContent || '';
          try {
            const r = await mermaid.render('mermaid-pdf-' + i, code);
            container.innerHTML = r.svg;
          } catch (e) {
            const label = (code.split('\\n')[0] || 'diagram').trim().slice(0, 80);
            container.innerHTML = '<div style="border:1px solid #e2e8f0;border-radius:6px;padding:1rem;color:#94a3b8;font-style:italic;text-align:center;background:#f8fafc;font-family:sans-serif;font-size:13px;">Diagram could not be rendered: ' + label + '</div>';
          }
        }
        // Clean up Mermaid error elements (bomb icons) injected into body
        document.querySelectorAll('[id^="dmermaid-pdf-"]').forEach(function(el) { el.remove(); });
        document.querySelectorAll('body > svg, body > div').forEach(function(el) {
          if (!el.closest('.mermaid-container') && (el.querySelector('.error-icon') || (el.textContent && el.textContent.indexOf('Syntax error') !== -1))) {
            el.remove();
          }
        });

        // Scale oversized SVGs so they fit within one printed A4 page.
        // A4 content area at 96 dpi ≈ 794 × 1123 px; subtract 2 cm margins
        // top + bottom (~152 px) plus header/footer (~40 px) → ~930 px safe height.
        // If even after scaling the diagram exceeds the page height, switch to
        // page-break-before:always so it gets its own page without overlapping text.
        const PAGE_CONTENT_H = 900;
        const PAGE_CONTENT_W = document.body.clientWidth || 700;
        document.querySelectorAll('.mermaid-container svg').forEach(function(svg) {
          const bb = svg.getBoundingClientRect();
          let w = bb.width  || parseFloat(svg.getAttribute('width')  || '0');
          let h = bb.height || parseFloat(svg.getAttribute('height') || '0');
          if (h <= 0 || w <= 0) return;

          // Scale to fit width first (diagrams wider than the content column).
          if (w > PAGE_CONTENT_W) {
            h = h * (PAGE_CONTENT_W / w);
            w = PAGE_CONTENT_W;
          }
          // Scale to fit height (the overflow-into-next-page problem).
          if (h > PAGE_CONTENT_H) {
            const scale = PAGE_CONTENT_H / h;
            w = Math.floor(w * scale);
            h = PAGE_CONTENT_H;
            // Mark the container so CSS can give it its own page break.
            const container = svg.closest('.mermaid-container');
            if (container) container.classList.add('diagram-oversized');
          }
          svg.setAttribute('width',  Math.floor(w) + 'px');
          svg.setAttribute('height', Math.floor(h) + 'px');
          svg.style.maxWidth = '100%';
        });
      })()
    `);

    // Inject KaTeX and render math expressions
    if (_katexJsPath && _katexAutoRenderPath) {
      await page.addScriptTag({ path: _katexJsPath });
      await page.addScriptTag({ path: _katexAutoRenderPath });
    } else {
      await page.addScriptTag({
        url: "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js",
      });
      await page.addScriptTag({
        url: "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js",
      });
    }
    await page.evaluate(`
      // Render pre-extracted display math blocks via katex.renderToString
      if (typeof katex !== 'undefined') {
        document.querySelectorAll('.math-display[data-formula]').forEach(function(el) {
          const formula = el.getAttribute('data-formula') || '';
          try {
            el.innerHTML = katex.renderToString(formula, { displayMode: true, throwOnError: false });
          } catch (e) {
            el.textContent = formula;
          }
        });
        // Also render any remaining inline $...$ math that marked left intact
        if (typeof renderMathInElement !== 'undefined') {
          renderMathInElement(document.body, {
            delimiters: [
              { left: '$', right: '$', display: false },
              { left: '\\\\\\\\(', right: '\\\\\\\\)', display: false },
              { left: '\\\\\\\\[', right: '\\\\\\\\]', display: true },
            ],
            throwOnError: false,
          });
        }
      }
    `);

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "2cm", bottom: "2cm", left: "1.5cm", right: "1.5cm" },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:9px; width:100%; text-align:center; color:#94a3b8;">${escapeHtml(title)}</div>`,
      footerTemplate: `<div style="font-size:9px; width:100%; text-align:center; color:#94a3b8;">
        <span class="pageNumber"></span> / <span class="totalPages"></span>
      </div>`,
    });

    return {
      buffer: Buffer.from(pdfBuffer),
      mimeType: "application/pdf",
      filename: `${title}.pdf`,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[docs-gen/exporters] PDF generation failed:",
      (err as Error).message?.slice(0, 300),
    );
    return fallbackHtmlExport(markdown, title);
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Build a full HTML document from markdown with Mermaid support and KaTeX.
 */
async function buildHtmlDocument(markdown: string, title: string): Promise<string> {
  const { marked } = await import("marked");

  // Extract display math ($$...$$) and mermaid blocks BEFORE marked processing.
  // marked splits $$\nformula\n$$ into separate <p> tags, breaking KaTeX delimiter matching.
  const mathBlocks: string[] = [];
  const mermaidBlocks: string[] = [];

  let processedMarkdown = markdown.replace(/\$\$([\s\S]*?)\$\$/g, (_match, formula: string) => {
    const idx = mathBlocks.length;
    mathBlocks.push(formula.trim());
    return `<!--MATH_PLACEHOLDER_${idx}-->`;
  });

  processedMarkdown = processedMarkdown.replace(
    /```mermaid\n([\s\S]*?)```/g,
    (_match, code: string) => {
      const idx = mermaidBlocks.length;
      mermaidBlocks.push(code.trim());
      return `<!--MERMAID_PLACEHOLDER_${idx}-->`;
    },
  );

  let htmlContent = await marked(processedMarkdown, {
    gfm: true,
    breaks: false,
  });

  // Inject mermaid blocks back (escaped for DOM textContent recovery, not double-processed by marked)
  for (let i = 0; i < mermaidBlocks.length; i++) {
    htmlContent = htmlContent.replace(
      `<!--MERMAID_PLACEHOLDER_${i}-->`,
      `<div class="mermaid-container"><pre class="mermaid">${escapeHtml(mermaidBlocks[i])}</pre></div>`,
    );
  }

  // Inject math blocks back as <span class="math-display"> — KaTeX renders these in page.evaluate
  for (let i = 0; i < mathBlocks.length; i++) {
    htmlContent = htmlContent.replace(
      `<!--MATH_PLACEHOLDER_${i}-->`,
      `<div class="math-display" data-formula="${escapeHtml(mathBlocks[i])}"></div>`,
    );
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>${PDF_CSS}</style>
  ${_katexCssPath ? `<link rel="stylesheet" href="file://${_katexCssPath}">` : `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">`}
</head>
<body>
  ${_logoSvg ? `<div class="doc-header">${_logoSvg}<span class="doc-header-title">${escapeHtml(title)}</span></div>` : ""}
  ${htmlContent}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fallback when Puppeteer/Chrome isn't available: render markdown as styled HTML.
 */
function fallbackHtmlExport(markdown: string, title: string): ExportResult {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${PDF_CSS}</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
</head><body>
<p><em>PDF export requires Chrome/Puppeteer. Displaying styled HTML instead.</em></p>
<hr>
${markdown.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}
<script>
mermaid.initialize({ startOnLoad: true, theme: 'default' });
document.addEventListener('DOMContentLoaded', function() {
  if (typeof renderMathInElement !== 'undefined') {
    renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  }
});
</script>
</body></html>`;
  return {
    buffer: Buffer.from(html, "utf-8"),
    mimeType: "text/html",
    filename: `${title}.html`,
  };
}

// ============================================================================
// Word (DOCX) Export — with Mermaid diagrams as PNG images
// ============================================================================

async function exportToDocx(markdown: string, title: string): Promise<ExportResult> {
  let docxMod: typeof import("docx");
  try {
    docxMod = await import("docx");
  } catch {
    return {
      buffer: Buffer.from(markdown, "utf-8"),
      mimeType: "text/markdown",
      filename: `${title}.md`,
    };
  }

  // Render Mermaid diagrams to PNG via Puppeteer
  const mermaidImages = await renderMermaidDiagrams(markdown);

  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    TableOfContents,
    AlignmentType,
    ImageRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
  } = docxMod;

  const paragraphs = markdownToDocxElements(markdown, mermaidImages, {
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    ImageRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
  });

  const doc = new Document({
    title,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 24 },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
        heading1: {
          run: { font: "Calibri Light", size: 36, bold: true, color: "1e3a5f" },
          paragraph: { spacing: { before: 360, after: 200 } },
        },
        heading2: {
          run: { font: "Calibri Light", size: 30, bold: true, color: "334155" },
          paragraph: { spacing: { before: 280, after: 160 } },
        },
        heading3: {
          run: { font: "Calibri Light", size: 26, bold: true, color: "475569" },
          paragraph: { spacing: { before: 200, after: 120 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
          },
        },
        children: [
          // Title
          new Paragraph({
            children: [new TextRun({ text: title, bold: true, size: 48, color: "1e3a5f" })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 },
          }),
          new TableOfContents("Table of Contents", {
            hyperlink: true,
            headingStyleRange: "1-3",
          }),
          new Paragraph({ text: "" }),
          ...paragraphs,
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return {
    buffer: Buffer.from(buffer),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: `${title}.docx`,
  };
}

/**
 * Render all Mermaid code blocks in the markdown to PNG buffers.
 */
async function renderMermaidDiagrams(markdown: string): Promise<Map<number, Buffer>> {
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mermaidRegex.exec(markdown)) !== null) {
    blocks.push(match[1].trim());
  }

  if (blocks.length === 0) return new Map();

  let puppeteer: typeof import("puppeteer") | undefined;
  try {
    puppeteer = (await import("puppeteer")) as unknown as typeof import("puppeteer");
  } catch {
    return new Map();
  }

  const images = new Map<number, Buffer>();
  let browser: Browser | null = null;
  const pptr = puppeteer;

  // Overall budget so document export can never hang on a stalled Chromium
  // render. On expiry we force-kill the browser and degrade gracefully to a
  // DOCX without the diagram image (the docx builder tolerates missing images).
  const RENDER_BUDGET_MS = 45_000;
  let budgetExpired = false;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    budgetTimer = setTimeout(() => {
      budgetExpired = true;
      void browser?.close().catch(() => {});
      resolve();
    }, RENDER_BUDGET_MS);
  });

  const work = (async () => {
    browser = await pptr.default.launch({
      headless: true,
      args: chromeLaunchArgs(),
    });

    for (let i = 0; i < blocks.length; i++) {
      if (budgetExpired || !browser) break;
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });

        const html = `<!DOCTYPE html>
<html><head>
<style>body { margin: 0; padding: 16px; background: white; } #container { display: inline-block; background: white; }</style>
</head><body>
<div id="container"><pre class="mermaid">${escapeHtml(blocks[i])}</pre></div>
</body></html>`;

        await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15_000 });

        // Inject mermaid from local filesystem (no CDN dependency)
        if (_mermaidPath) {
          await page.addScriptTag({ path: _mermaidPath });
        } else {
          await page.addScriptTag({
            url: "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
          });
        }

        // Render the single diagram manually
        await page.evaluate(`
          (async () => {
            mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: '${MERMAID_RENDER_SECURITY.securityLevel}', maxTextSize: 500000 });
            const el = document.querySelector('pre.mermaid');
            if (el) {
              try {
                const r = await mermaid.render('mermaid-word-0', el.textContent || '');
                document.getElementById('container').innerHTML = r.svg;
              } catch (e) {
                document.getElementById('container').innerHTML = '';
              }
            }
          })();
        `);

        // Wait for SVG or empty container (error case)
        await page
          .waitForSelector("#container svg, #container:empty", { timeout: 15_000 })
          .catch(() => {});

        const element = await page.$("#container");
        if (element) {
          const screenshot = await element.screenshot({ type: "png", omitBackground: false });
          images.set(i, Buffer.from(screenshot));
        }

        await page.close();
      } catch {
        // Skip failed diagram renders
      }
    }
  })();
  // Ensure a late rejection (after the budget already won the race) does not
  // surface as an unhandled promise rejection.
  void work.catch(() => {});

  try {
    await Promise.race([work, budget]);
  } catch {
    // Swallow — return whatever images we managed to render.
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    if (browser) {
      try {
        await (browser as Browser).close();
      } catch {
        // Browser already closing/closed (e.g. force-killed by the budget timer).
      }
    }
  }

  return images;
}

/**
 * Convert markdown to docx paragraphs with proper formatting, tables, and images.
 */
function markdownToDocxElements(
  markdown: string,
  mermaidImages: Map<number, Buffer>,
  deps: {
    Paragraph: typeof import("docx").Paragraph;
    TextRun: typeof import("docx").TextRun;
    HeadingLevel: typeof import("docx").HeadingLevel;
    AlignmentType: typeof import("docx").AlignmentType;
    ImageRun: typeof import("docx").ImageRun;
    Table: typeof import("docx").Table;
    TableRow: typeof import("docx").TableRow;
    TableCell: typeof import("docx").TableCell;
    WidthType: typeof import("docx").WidthType;
    BorderStyle: typeof import("docx").BorderStyle;
    ShadingType: typeof import("docx").ShadingType;
  },
): (InstanceType<typeof import("docx").Paragraph> | InstanceType<typeof import("docx").Table>)[] {
  const {
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    ImageRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
  } = deps;
  const lines = markdown.split("\n");
  const elements: (
    | InstanceType<typeof import("docx").Paragraph>
    | InstanceType<typeof import("docx").Table>
  )[] = [];

  let i = 0;
  let mermaidIdx = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Mermaid code block
    if (line.trim().startsWith("```mermaid")) {
      const imgBuffer = mermaidImages.get(mermaidIdx);
      // Skip past the mermaid block
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) i++;
      i++; // skip closing ```
      mermaidIdx++;

      if (imgBuffer) {
        elements.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: imgBuffer,
                transformation: { width: 580, height: 400 },
                altText: {
                  title: "Mermaid Diagram",
                  description: "Auto-generated diagram",
                  name: `diagram-${mermaidIdx}`,
                },
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 200 },
          }),
        );
      } else {
        elements.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "[Diagram could not be rendered]",
                italics: true,
                color: "999999",
              }),
            ],
          }),
        );
      }
      continue;
    }

    // Regular code block
    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```

      for (const codeLine of codeLines) {
        elements.push(
          new Paragraph({
            children: [
              new TextRun({ text: codeLine || " ", font: "Consolas", size: 18, color: "e2e8f0" }),
            ],
            shading: { type: ShadingType.SOLID, color: "1e293b" },
            spacing: { after: 0, line: 240 },
          }),
        );
      }
      elements.push(new Paragraph({ text: "", spacing: { after: 120 } }));
      continue;
    }

    // Table detection
    if (line.includes("|") && i + 1 < lines.length && /^\|?[\s\-:|]+\|/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }

      const tableElement = parseMarkdownTable(tableLines, {
        Table,
        TableRow,
        TableCell,
        Paragraph,
        TextRun,
        WidthType,
        BorderStyle,
        ShadingType,
      });
      if (tableElement) {
        elements.push(tableElement);
        elements.push(new Paragraph({ text: "", spacing: { after: 120 } }));
      }
      continue;
    }

    // Headings
    if (line.startsWith("#### ")) {
      elements.push(new Paragraph({ text: line.slice(5), heading: HeadingLevel.HEADING_4 }));
    } else if (line.startsWith("### ")) {
      elements.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith("## ")) {
      elements.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith("# ")) {
      elements.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    }
    // Blockquote
    else if (line.startsWith("> ")) {
      elements.push(
        new Paragraph({
          children: [new TextRun({ text: line.slice(2), italics: true, color: "1e40af" })],
          indent: { left: 720 },
          shading: { type: ShadingType.SOLID, color: "eff6ff" },
          spacing: { after: 80 },
        }),
      );
    }
    // Bullet lists
    else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        new Paragraph({
          children: parseInlineFormatting(line.slice(2), TextRun),
          bullet: { level: 0 },
        }),
      );
    } else if (line.startsWith("  - ") || line.startsWith("  * ")) {
      elements.push(
        new Paragraph({
          children: parseInlineFormatting(line.slice(4), TextRun),
          bullet: { level: 1 },
        }),
      );
    } else if (line.startsWith("    - ") || line.startsWith("    * ")) {
      elements.push(
        new Paragraph({
          children: parseInlineFormatting(line.slice(6), TextRun),
          bullet: { level: 2 },
        }),
      );
    }
    // Numbered list
    else if (/^\d+\.\s/.test(line)) {
      const content = line.replace(/^\d+\.\s/, "");
      elements.push(
        new Paragraph({
          children: parseInlineFormatting(content, TextRun),
          numbering: { reference: "default-numbering", level: 0 },
        }),
      );
    }
    // Horizontal rule
    else if (line.trim() === "---" || line.trim() === "***") {
      elements.push(new Paragraph({ text: "", spacing: { after: 200 } }));
    }
    // Regular paragraph
    else if (line.trim()) {
      const children = parseInlineFormatting(line, TextRun);
      elements.push(new Paragraph({ children }));
    }
    // Empty line
    else {
      elements.push(new Paragraph({ text: "", spacing: { after: 60 } }));
    }

    i++;
  }

  return elements;
}

/**
 * Parse a markdown table into a docx Table.
 */
function parseMarkdownTable(
  lines: string[],
  deps: {
    Table: typeof import("docx").Table;
    TableRow: typeof import("docx").TableRow;
    TableCell: typeof import("docx").TableCell;
    Paragraph: typeof import("docx").Paragraph;
    TextRun: typeof import("docx").TextRun;
    WidthType: typeof import("docx").WidthType;
    BorderStyle: typeof import("docx").BorderStyle;
    ShadingType: typeof import("docx").ShadingType;
  },
): InstanceType<typeof import("docx").Table> | null {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle, ShadingType } =
    deps;

  if (lines.length < 2) return null;

  const parseCells = (line: string) =>
    line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c && !/^[-:]+$/.test(c));

  const headerCells = parseCells(lines[0]);
  if (headerCells.length === 0) return null;

  // lines[1] is the separator
  const dataLines = lines.slice(2);

  const borderStyle = {
    style: BorderStyle.SINGLE,
    size: 1,
    color: "e2e8f0",
  };

  const columnCount = headerCells.length;

  const headerRow = new TableRow({
    tableHeader: true,
    children: headerCells.map(
      (cell) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text: cell, bold: true, size: 20 })],
            }),
          ],
          shading: { type: ShadingType.SOLID, color: "f8fafc" },
          borders: {
            top: borderStyle,
            bottom: borderStyle,
            left: borderStyle,
            right: borderStyle,
          },
        }),
    ),
  });

  const dataRows = dataLines
    .map((line) => {
      const cells = parseCells(line);
      if (cells.length === 0) return null;
      // Pad or trim cells to match header count
      const paddedCells = Array.from({ length: columnCount }, (_, idx) => cells[idx] || "");
      return new TableRow({
        children: paddedCells.map(
          (cell) =>
            new TableCell({
              children: [new Paragraph({ children: parseInlineFormatting(cell, TextRun) })],
              borders: {
                top: borderStyle,
                bottom: borderStyle,
                left: borderStyle,
                right: borderStyle,
              },
            }),
        ),
      });
    })
    .filter((r): r is InstanceType<typeof import("docx").TableRow> => r !== null);

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

/**
 * Parse inline markdown formatting: bold, italic, inline code, links.
 */
function parseInlineFormatting(
  text: string,
  TextRun: typeof import("docx").TextRun,
): InstanceType<typeof import("docx").TextRun>[] {
  const runs: InstanceType<typeof import("docx").TextRun>[] = [];

  // Split by inline patterns: `code`, **bold**, *italic*, [link](url)
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }

    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      runs.push(
        new TextRun({ text: token.slice(1, -1), font: "Consolas", size: 20, color: "dc2626" }),
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else if (token.startsWith("*") && token.endsWith("*")) {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        runs.push(
          new TextRun({ text: linkMatch[1], underline: { color: "2563eb" }, color: "2563eb" }),
        );
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text }));
  }

  return runs;
}

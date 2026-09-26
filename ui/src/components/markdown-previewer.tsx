"use client";

/**
 * Epic #486 / Issue #492 — Rich Markdown Previewer.
 *
 * Renders markdown with:
 * - Full GitHub-Flavored Markdown via react-markdown + remark-gfm
 *   (tables, task lists, strikethrough, autolinks)
 * - LaTeX math via remark-math + rehype-katex
 * - Mermaid diagrams (lazy-rendered after mount)
 * - Tailwind Typography (`prose`) for styling
 * - Sticky table-of-contents sidebar with active-heading tracking
 *
 * #190 — large documents render progressively. The content is split at H2/H3
 * boundaries (fence-aware) and each section gets its own react-markdown pass,
 * run only when the section nears the viewport, is picked from the table of
 * contents, or is the target of the URL hash. Until then a section is shown as
 * its plain text, so the browser's find-in-page still finds words in it and its
 * heading anchor already exists. Heading ids continue one document-wide slug
 * counter across sections, so duplicate headings keep distinct, stable ids.
 */
import { useMemo, useEffect, useRef, useState, useCallback, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import mermaid from "mermaid";
import { DiagramViewer } from "./diagram-viewer";
import {
  splitMarkdownSections,
  remarkSectionSlugs,
  type MarkdownSection,
} from "@/lib/markdown-sections";

/** Sections rendered on mount, before any scrolling. */
export const INITIAL_RENDERED_SECTIONS = 3;
/** How far outside the viewport a section starts rendering. */
const RENDER_AHEAD_MARGIN = "1500px 0px";

interface MarkdownPreviewerProps {
  content: string;
  className?: string;
  showToc?: boolean;
}

function initialRendered(count: number): Set<number> {
  return new Set(Array.from({ length: Math.min(INITIAL_RENDERED_SECTIONS, count) }, (_, i) => i));
}

function hashTarget(): string | null {
  if (typeof window === "undefined" || window.location.hash.length < 2) return null;
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return null;
  }
}

export function MarkdownPreviewer({
  content,
  className = "",
  showToc = true,
}: MarkdownPreviewerProps): React.ReactElement {
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeHeading, setActiveHeading] = useState<string>("");
  // Heading id to scroll to once its section has rendered.
  const pendingScrollId = useRef<string | null>(null);

  // Repair malformed code fences in content before rendering.
  // LLMs sometimes forget to close mermaid blocks or produce incomplete
  // edges, causing the markdown parser to treat subsequent headings as
  // part of the code block.
  const repairedContent = useMemo(() => repairFences(content), [content]);
  const {
    sections,
    toc: tocEntries,
    sectionOfId,
  } = useMemo(() => splitMarkdownSections(repairedContent), [repairedContent]);
  const sectionCount = sections.length;

  const [rendered, setRendered] = useState<Set<number>>(() => initialRendered(sectionCount));
  useEffect(() => {
    setRendered(initialRendered(sectionCount));
  }, [sections, sectionCount]);

  const renderSections = useCallback((indices: number[]) => {
    setRendered((prev) => {
      if (indices.every((i) => prev.has(i))) return prev;
      const next = new Set(prev);
      for (const i of indices) next.add(i);
      return next;
    });
  }, []);

  /** Render the section holding heading `id` (if needed) and scroll to it. */
  const reveal = useCallback(
    (id: string) => {
      const index = sectionOfId.get(id);
      if (index === undefined) return false;
      pendingScrollId.current = id;
      renderSections([index]);
      return true;
    },
    [sectionOfId, renderSections],
  );

  // Scroll to a revealed heading once its section is in the DOM.
  useEffect(() => {
    const id = pendingScrollId.current;
    if (!id) return;
    const index = sectionOfId.get(id);
    if (index !== undefined && !rendered.has(index)) return;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      pendingScrollId.current = null;
    }
  }, [rendered, sectionOfId]);

  // Deep links: honour the URL hash on load and when it changes.
  useEffect(() => {
    const onHash = () => {
      const id = hashTarget();
      if (id) reveal(id);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [reveal]);

  // Render pending sections as they approach the viewport.
  useEffect(() => {
    if (!contentRef.current || rendered.size >= sectionCount) return;
    const pending = contentRef.current.querySelectorAll<HTMLElement>("[data-section-pending]");
    if (pending.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => Number((entry.target as HTMLElement).dataset.sectionPending));
        if (visible.length) renderSections(visible);
      },
      { rootMargin: RENDER_AHEAD_MARGIN },
    );
    pending.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [rendered, sectionCount, renderSections]);

  // Detect dark mode and initialize mermaid with matching theme.
  const isDark =
    typeof window !== "undefined" && document.documentElement.classList.contains("dark");
  const mermaidThemeRef = useRef<string>("");
  const desiredTheme = isDark ? "dark" : "default";
  if (mermaidThemeRef.current !== desiredTheme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: desiredTheme,
      // Render node labels as SVG <text>, NOT HTML inside <foreignObject>.
      // The DiagramViewer sanitizes the SVG with DOMPurify (SVG profile), which
      // empties foreignObject HTML — leaving blank flowchart nodes. SVG text
      // survives sanitization, so labels render correctly.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // Raise parser limit — large ER diagrams (50 tables) can exceed the 50k default.
      maxTextSize: 500000,
      themeVariables: isDark
        ? {
            primaryColor: "#1e293b",
            primaryTextColor: "#e2e8f0",
            lineColor: "#94a3b8",
            primaryBorderColor: "#475569",
          }
        : {
            primaryColor: "#e0e7ff",
            primaryTextColor: "#1e293b",
            lineColor: "#334155",
            primaryBorderColor: "#6366f1",
          },
    });
    mermaidThemeRef.current = desiredTheme;
  }

  // Store rendered mermaid SVGs keyed by their original code content hash.
  // This lets us render them as part of React's tree so re-renders don't destroy them.
  const [mermaidSvgs, setMermaidSvgs] = useState<Map<string, string>>(new Map());

  // Render mermaid diagrams. Stores SVGs in state so React manages them.
  const renderMermaid = useCallback(async () => {
    if (!contentRef.current) return;
    const codeEls = contentRef.current.querySelectorAll<HTMLElement>("code.language-mermaid");
    if (codeEls.length === 0) return;

    const newSvgs = new Map<string, string>();
    for (const codeEl of Array.from(codeEls)) {
      const rawCode = (codeEl.textContent ?? "").trim();
      if (!rawCode) continue;
      // Use shared sanitizeMermaidCode so the key stored here always matches
      // what the `pre` renderer looks up.
      const code = sanitizeMermaidCode(rawCode);
      if (!code) continue;
      const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const { svg } = await mermaid.render(id, code);
        newSvgs.set(code, svg);
      } catch (e) {
        /* eslint-disable-next-line no-console */
        console.warn("[MarkdownPreviewer] Mermaid render failed:", e);
        // Store a sentinel so the pre renderer shows an error instead of raw text.
        newSvgs.set(code, "");
      }
    }
    if (newSvgs.size > 0) {
      setMermaidSvgs((prev) => {
        const merged = new Map(prev);
        for (const [k, v] of newSvgs) merged.set(k, v);
        return merged;
      });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void renderMermaid();
    }, 100);
    return () => clearTimeout(timer);
  }, [rendered, renderMermaid]);

  // Track which heading is in view for the TOC.
  useEffect(() => {
    if (!contentRef.current || !showToc) return;
    const headings = contentRef.current.querySelectorAll("h1, h2, h3");
    if (headings.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveHeading(entry.target.id);
        }
      },
      { rootMargin: "-20% 0% -80% 0%" },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [rendered, showToc]);

  return (
    <div className={`flex gap-6 ${className}`} data-testid="markdown-previewer">
      {showToc && tocEntries.length > 3 && (
        <nav
          className="hidden lg:block w-64 shrink-0 sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto"
          aria-label="Table of contents"
          data-testid="markdown-toc"
        >
          <h4 className="text-sm font-semibold text-muted-foreground mb-2">Contents</h4>
          <ul className="space-y-1 text-sm">
            {tocEntries.map((entry) => (
              <li key={entry.id} style={{ paddingLeft: `${(entry.level - 1) * 12}px` }}>
                <a
                  href={`#${entry.id}`}
                  className={`block py-0.5 cursor-pointer text-muted-foreground hover:text-foreground transition-colors ${
                    activeHeading === entry.id ? "text-foreground font-medium" : ""
                  }`}
                  onClick={(e) => {
                    e.preventDefault();
                    reveal(entry.id);
                  }}
                >
                  {entry.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div
        ref={contentRef}
        className="flex-1 min-w-0 prose prose-sm md:prose-base dark:prose-invert max-w-none prose-headings:scroll-mt-20 prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none"
        data-testid="markdown-content"
      >
        {/* Each section is its own memoized ReactMarkdown pass, run only once
            the section is wanted; rendering one never re-parses another. */}
        {sections.map((section) =>
          rendered.has(section.index) ? (
            <div key={section.index} data-section-rendered={section.index}>
              <MemoizedSection
                markdown={section.markdown}
                slugOccurrences={section.slugOccurrences}
                mermaidSvgs={mermaidSvgs}
              />
            </div>
          ) : (
            <PendingSection key={section.index} section={section} />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A section not rendered yet: its heading (carrying the real anchor id) and
 * its raw text. Cheap for the browser, searchable with find-in-page, and
 * `content-visibility: auto` skips its layout while it is off screen.
 */
function PendingSection({ section }: { section: MarkdownSection }): React.ReactElement {
  const { heading } = section;
  const HeadingTag = heading ? (`h${heading.level}` as "h2" | "h3") : null;
  const body = heading
    ? section.markdown.slice(section.markdown.indexOf("\n") + 1)
    : section.markdown;
  return (
    <div
      data-section-pending={section.index}
      aria-busy="true"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 600px" }}
    >
      {HeadingTag && heading && <HeadingTag id={heading.id}>{heading.text}</HeadingTag>}
      <div className="not-prose whitespace-pre-wrap break-words text-sm text-muted-foreground">
        {body}
      </div>
    </div>
  );
}

// ============================================================================
// Memoized per-section renderer — each section is independently rendered so
// adding new sections never causes already-visible sections to re-parse.
// ============================================================================

interface SectionProps {
  markdown: string;
  slugOccurrences: Readonly<Record<string, number>>;
  mermaidSvgs: Map<string, string>;
}

const MemoizedSection = memo(function Section({
  markdown,
  slugOccurrences,
  mermaidSvgs,
}: SectionProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkMath,
        [remarkSectionSlugs, { occurrences: slugOccurrences }],
      ]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code: ({ node: _nc, className, children, ...props }) => {
          if (!className) {
            return (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]" {...props}>
                {children}
              </code>
            );
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
        pre: ({ node: _np, children, ...props }) => {
          const child = Array.isArray(children) ? children[0] : children;
          if (child && typeof child === "object" && "props" in child) {
            const childProps = (child as { props: { className?: string; children?: ReactNode } })
              .props;
            if (childProps.className === "language-mermaid") {
              const rawCode = nodeToString(childProps.children).trim();
              const sanitized = sanitizeMermaidCode(rawCode);
              const svg = mermaidSvgs.get(sanitized);
              if (svg === undefined) {
                // Not rendered yet — keep the real code element in the DOM (hidden)
                // so renderMermaid() can find it, plus show a loading message.
                return (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    <pre className="hidden" {...props}>
                      {children}
                    </pre>
                    <div className="inline-flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      Rendering diagram…
                    </div>
                  </div>
                );
              } else if (svg === "") {
                return (
                  <div className="mermaid-block rounded-md border border-destructive/40 bg-destructive/10 p-4 not-prose">
                    <p className="text-xs text-destructive mb-2 font-medium">
                      ⚠ Diagram could not be rendered
                    </p>
                    <pre className="text-xs overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                      {sanitized}
                    </pre>
                  </div>
                );
              } else {
                return <DiagramViewer svg={svg} title={mermaidDiagramTitle(sanitized)} />;
              }
            }
          }
          return (
            <pre className="overflow-x-auto rounded-md" {...props}>
              {children}
            </pre>
          );
        },
        table: ({ node: _nt, children, ...props }) => (
          <div className="overflow-x-auto">
            <table {...props}>{children}</table>
          </div>
        ),
        a: ({ node: _na, href, children, ...props }) => (
          <a
            href={sanitizeUrl(href ?? "#")}
            target={href?.startsWith("http") ? "_blank" : undefined}
            rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
            {...props}
          >
            {children}
          </a>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
});

// ============================================================================
// Helpers
// ============================================================================

function nodeToString(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToString).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeToString((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function sanitizeMermaidCode(raw: string): string {
  let code = raw;
  code = code.replace(/^.*--[->]+\s*#{1,4}\s.*$/gm, "");
  code = code.replace(/^(\s*\S+\s+--[->]+)\s*$/gm, "");
  code = code.replace(/^#{1,4}\s.+$/gm, "");
  code = code.replace(/^```[\w-]*$/gm, "");
  const fenceIdx = code.indexOf("```");
  if (fenceIdx > 0) code = code.substring(0, fenceIdx);
  const headingIdx = code.search(/^#{1,4}\s/m);
  if (headingIdx > 0) code = code.substring(0, headingIdx);
  // Collapse newlines inside pipe edge labels and escape curly braces.
  // LLMs sometimes wrap long labels across lines (e.g. `-->|Submit Jobs\nwith IDs|`)
  // which breaks Mermaid's parser, and use `{param}` URL templates which conflict
  // with Mermaid's rhombus-node syntax.
  // SKIP for ER diagrams — they use `||` relationship syntax (`}o--||`) which the
  // cross-line pipe regex would corrupt.
  const isErDiagram = /^\s*erDiagram\b/m.test(code);
  if (!isErDiagram) {
    code = code.replace(
      /\|([^|]+)\|/g,
      (_, label: string) =>
        `|${label.replace(/\n\s*/g, " ").replace(/\{/g, "(").replace(/\}/g, ")")}|`,
    );
  }
  return code.trim();
}

/** Derive a human-readable diagram title from the first Mermaid directive keyword. */
function mermaidDiagramTitle(code: string): string {
  const firstLine = code.trimStart().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  if (/^\s*erdiagram\b/.test(firstLine)) return "Entity Relationship Diagram";
  if (/^\s*sequencediagram\b/.test(firstLine)) return "Sequence Diagram";
  if (/^\s*classDiagram\b/i.test(firstLine)) return "Class Diagram";
  if (/^\s*stateDiagram\b/i.test(firstLine)) return "State Diagram";
  if (/^\s*gantt\b/.test(firstLine)) return "Gantt Chart";
  if (/^\s*pie\b/.test(firstLine)) return "Pie Chart";
  if (/^\s*mindmap\b/.test(firstLine)) return "Mind Map";
  if (/^\s*timeline\b/.test(firstLine)) return "Timeline";
  if (/^\s*gitgraph\b/.test(firstLine)) return "Git Graph";
  if (/^\s*(graph|flowchart)\b/.test(firstLine)) return "Flowchart";
  return "Diagram";
}
// ============================================================================

function sanitizeUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("vbscript:")
  ) {
    return "#";
  }
  return url;
}

/**
 * Repair broken code fences in LLM-generated markdown.
 * Inserts a closing ``` when a markdown heading appears inside an open fence
 * (indicating the LLM forgot to close it), and closes any trailing open fence.
 */
function repairFences(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,})([\w-]*)/);

    if (!inFence) {
      if (fenceMatch) {
        inFence = true;
      }
      result.push(line);
    } else {
      if (fenceMatch && !fenceMatch[2]) {
        // Closing fence
        inFence = false;
        result.push(line);
      } else if (/^#{1,4}\s/.test(line)) {
        // Markdown heading inside a code block — close the fence first
        result.push("```");
        inFence = false;
        result.push(line);
      } else if (/--[->]+\s*#{1,4}\s/.test(line)) {
        // Arrow running into a heading mid-line — close the fence
        result.push("```");
        inFence = false;
        result.push(line);
      } else {
        result.push(line);
      }
    }
  }

  if (inFence) {
    result.push("```");
  }

  return result.join("\n");
}

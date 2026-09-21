"use client";

/**
 * Lightweight markdown renderer for Chat messages.
 *
 * Supports:
 * - GitHub-Flavored Markdown (tables, task lists, strikethrough)
 * - LaTeX math via remark-math + rehype-katex
 * - Mermaid diagrams (rendered after streaming completes)
 * - Syntax-highlighted code blocks
 * - Tailwind Typography styling
 *
 * Unlike MarkdownPreviewer, this omits the TOC sidebar and intersection
 * observers to stay performant during streaming.
 */
import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import mermaid from "mermaid";
import DOMPurify from "dompurify";

interface ChatMarkdownProps {
  content: string;
  streaming?: boolean;
}

export function ChatMarkdown({ content, streaming = false }: ChatMarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mermaidSvgs, setMermaidSvgs] = useState<Map<string, string>>(new Map());

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
      // The SVG is sanitized with DOMPurify (SVG profile) before injection, which
      // empties foreignObject HTML — leaving blank flowchart nodes. SVG text
      // survives sanitization, so labels render correctly.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    mermaidThemeRef.current = desiredTheme;
  }

  const renderMermaid = useCallback(async () => {
    if (!containerRef.current) return;
    const codeEls = containerRef.current.querySelectorAll<HTMLElement>("code.language-mermaid");
    if (codeEls.length === 0) return;

    const newSvgs = new Map<string, string>();
    for (const codeEl of Array.from(codeEls)) {
      let code = (codeEl.textContent ?? "").trim();
      if (!code) continue;
      // Sanitize common LLM issues
      code = code.replace(/^```[\w-]*$/gm, "");
      const fenceIdx = code.indexOf("```");
      if (fenceIdx > 0) code = code.substring(0, fenceIdx);
      // Escape curly braces and collapse newlines inside pipe edge labels
      code = code.replace(
        /\|([^|]+)\|/g,
        (_, label: string) =>
          `|${label.replace(/\n\s*/g, " ").replace(/\{/g, "(").replace(/\}/g, ")")}|`,
      );
      code = code.trim();
      if (!code) continue;
      const id = `mermaid-chat-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const { svg } = await mermaid.render(id, code);
        newSvgs.set(code, svg);
      } catch {
        // Invalid mermaid syntax — skip
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

  // Render mermaid only after streaming stops (avoids re-rendering mid-stream)
  useEffect(() => {
    if (streaming) return;
    const timer = setTimeout(() => void renderMermaid(), 150);
    return () => clearTimeout(timer);
  }, [content, streaming, renderMermaid]);

  const repairedContent = repairFences(content);

  return (
    <div
      ref={containerRef}
      className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
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
                const svg = mermaidSvgs.get(rawCode);
                if (svg) {
                  // Defense-in-depth: svg is Mermaid `securityLevel: "strict"` output,
                  // additionally sanitized with DOMPurify before injection.
                  const safeSvg = DOMPurify.sanitize(svg, {
                    USE_PROFILES: { svg: true, svgFilters: true, html: true },
                  });
                  return (
                    <div
                      className="flex justify-center overflow-x-auto rounded-md border border-border bg-muted p-4 not-prose"
                      // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- svg is Mermaid strict-mode output sanitized with DOMPurify; no user HTML reaches the DOM.
                      dangerouslySetInnerHTML={{ __html: safeSvg }}
                    />
                  );
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
        {repairedContent}
      </ReactMarkdown>
    </div>
  );
}

function nodeToString(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToString).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeToString((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

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

function repairFences(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,})([\w-]*)/);
    if (!inFence) {
      if (fenceMatch) inFence = true;
      result.push(line);
    } else {
      if (fenceMatch && !fenceMatch[2]) {
        inFence = false;
        result.push(line);
      } else {
        result.push(line);
      }
    }
  }
  if (inFence) result.push("```");
  return result.join("\n");
}

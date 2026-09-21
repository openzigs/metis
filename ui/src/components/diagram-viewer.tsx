"use client";

/**
 * Interactive diagram viewer with pan, zoom, and fullscreen controls.
 * Wraps rendered SVG content (e.g. Mermaid ER diagrams) in a pannable
 * viewport with toolbar buttons and keyboard shortcuts.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import DOMPurify from "dompurify";

interface DiagramViewerProps {
  /** Raw SVG string (innerHTML) */
  svg: string;
  /** Optional label shown in the toolbar */
  title?: string;
  className?: string;
  /** Map of entity name → description for hover tooltips */
  entityDescriptions?: Map<string, string>;
}

export function DiagramViewer({
  svg,
  title,
  className = "",
  entityDescriptions,
}: DiagramViewerProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  // Defense-in-depth: the SVG is produced by Mermaid with `securityLevel: "strict"`,
  // but we additionally run it through DOMPurify (SVG profile) before injecting so
  // any scriptable content / event handlers are stripped.
  const sanitizedSvg = useMemo(
    () => DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } }),
    [svg],
  );

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current
        .requestFullscreen()
        .then(() => setIsFullscreen(true))
        .catch(() => {});
    } else {
      document
        .exitFullscreen()
        .then(() => setIsFullscreen(false))
        .catch(() => {});
    }
  }, []);

  // Listen for fullscreen exit via Escape
  const handleFullscreenChange = useCallback(() => {
    setIsFullscreen(!!document.fullscreenElement);
  }, []);

  useEffect(() => {
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [handleFullscreenChange]);

  // Add hover tooltips to ER entity labels in the SVG
  useEffect(() => {
    if (!svgContainerRef.current || !entityDescriptions || entityDescriptions.size === 0) return;
    const svgEl = svgContainerRef.current.querySelector("svg");
    if (!svgEl) return;

    // Mermaid ER entities have CSS class "er entityLabel" or text inside .entity groups
    const entityTexts = svgEl.querySelectorAll<SVGTextElement>(
      ".er.entityLabel text, .entityLabel text, g.entity text",
    );

    const handleMouseEnter = (e: MouseEvent) => {
      const target = e.currentTarget as SVGTextElement;
      const name = target.textContent?.trim() ?? "";
      const desc = entityDescriptions.get(name);
      if (desc) {
        const rect = target.getBoundingClientRect();
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (containerRect) {
          setTooltip({
            text: desc,
            x: rect.left - containerRect.left + rect.width / 2,
            y: rect.top - containerRect.top - 8,
          });
        }
      }
    };
    const handleMouseLeave = () => setTooltip(null);

    entityTexts.forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("mouseenter", handleMouseEnter);
      el.addEventListener("mouseleave", handleMouseLeave);
    });

    return () => {
      entityTexts.forEach((el) => {
        el.removeEventListener("mouseenter", handleMouseEnter);
        el.removeEventListener("mouseleave", handleMouseLeave);
      });
    };
  }, [sanitizedSvg, entityDescriptions]);

  return (
    <div
      ref={containerRef}
      className={`relative rounded-md border border-border bg-muted not-prose ${className} ${
        isFullscreen ? "fixed inset-0 z-50 rounded-none border-none" : ""
      }`}
    >
      <TransformWrapper
        initialScale={1}
        minScale={0.1}
        maxScale={5}
        centerOnInit
        wheel={{ step: 0.08 }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            {/* Toolbar */}
            <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md bg-background/80 backdrop-blur-sm border border-border p-1 shadow-sm">
              {title && (
                <span className="text-xs text-muted-foreground px-2 hidden sm:inline">{title}</span>
              )}
              <ToolbarButton onClick={() => zoomIn()} title="Zoom in (+)">
                <ZoomInIcon />
              </ToolbarButton>
              <ToolbarButton onClick={() => zoomOut()} title="Zoom out (-)">
                <ZoomOutIcon />
              </ToolbarButton>
              <ToolbarButton onClick={() => resetTransform()} title="Reset zoom">
                <ResetIcon />
              </ToolbarButton>
              <div className="w-px h-4 bg-border mx-0.5" />
              <ToolbarButton onClick={toggleFullscreen} title="Toggle fullscreen (F)">
                {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
              </ToolbarButton>
            </div>

            {/* Pan/zoom area */}
            <TransformComponent
              wrapperStyle={{
                width: "100%",
                height: isFullscreen ? "100vh" : "600px",
                cursor: "grab",
              }}
              contentStyle={{ width: "100%", height: "100%" }}
            >
              <div
                ref={svgContainerRef}
                className="flex items-center justify-center min-w-full min-h-full p-8"
                // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- svg is Mermaid strict-mode output sanitized with DOMPurify (see sanitizedSvg); no user HTML reaches the DOM.
                dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
              />
            </TransformComponent>

            {/* Tooltip for entity hover */}
            {tooltip && (
              <div
                className="absolute z-20 max-w-xs px-3 py-2 text-xs rounded-md bg-popover text-popover-foreground border border-border shadow-lg pointer-events-none"
                style={{
                  left: `${tooltip.x}px`,
                  top: `${tooltip.y}px`,
                  transform: "translate(-50%, -100%)",
                }}
              >
                {tooltip.text}
              </div>
            )}

            {/* Hint */}
            <div className="absolute bottom-2 left-2 text-xs text-muted-foreground/60 pointer-events-none">
              Scroll to zoom · Drag to pan · Double-click to reset
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Icons (inline SVG, 16×16)
// ---------------------------------------------------------------------------

function ZoomInIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

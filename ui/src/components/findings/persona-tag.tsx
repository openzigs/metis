"use client";

/**
 * Issue #177 — Persona attribution chip for analysis findings.
 *
 * Each specialist analysis agent has a named persona (Mary the Business
 * Analyst, Winston the Solution Architect, etc.). Finding cards used to show
 * the raw `agentKey` ("code", "database", …) which is opaque to humans. This
 * chip renders the persona's avatar, name and role so a reader instantly knows
 * *who* surfaced the finding.
 *
 * Accessibility:
 *  - The avatar emoji is decorative (`aria-hidden`); the accessible name comes
 *    from the visible text + a descriptive `title`.
 *  - Falls back to a generic 🤖 glyph and the raw agent key when no persona is
 *    resolved (e.g. an unknown/legacy agent key), so the chip never renders
 *    blank.
 */
import * as React from "react";

export interface PersonaTagPersona {
  agentKey: string;
  name: string;
  role: string;
  avatar: string;
}

export interface PersonaTagProps {
  /** Resolved persona for the finding's agent, when known. */
  persona?: PersonaTagPersona;
  /** Raw agent key — used for the fallback label when no persona resolves. */
  agentKey: string;
  /** Render only the avatar + name (omit the role). Defaults to false. */
  compact?: boolean;
  /** Optional className to layer on top of the chip styles. */
  className?: string;
}

const FALLBACK_AVATAR = "🤖";

const BASE =
  "inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-xs font-medium text-zinc-200";

export function PersonaTag({
  persona,
  agentKey,
  compact = false,
  className,
}: PersonaTagProps): React.ReactElement {
  const avatar = persona?.avatar ?? FALLBACK_AVATAR;
  const name = persona?.name ?? agentKey;
  const role = persona?.role;
  const title = role ? `${name} · ${role} (${agentKey})` : `${name} (${agentKey})`;

  return (
    <span
      className={className ? `${BASE} ${className}` : BASE}
      data-testid="persona-tag"
      data-agent-key={agentKey}
      title={title}
    >
      <span aria-hidden="true">{avatar}</span>
      <span data-testid="persona-tag-name">{name}</span>
      {!compact && role ? (
        <span className="text-zinc-400" data-testid="persona-tag-role">
          · {role}
        </span>
      ) : null}
    </span>
  );
}

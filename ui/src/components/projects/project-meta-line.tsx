/**
 * Issue #430 (epic #407) — project card meta line.
 *
 * Renders the muted `<slug> · <status>` line beneath a project name. The slug is
 * styled as `<code>`; tokens are joined by a middot that only ever appears
 * *between* two present tokens — so a missing slug no longer yields a stray
 * leading `· draft`. The token-assembly logic lives in {@link formatProjectMeta}
 * (pure, unit-tested); this component only renders.
 */
import { formatProjectMeta, META_SEPARATOR } from "@/lib/format-project-meta";

export interface ProjectMetaLineProps {
  slug?: string | null;
  status?: string | null;
}

export function ProjectMetaLine({ slug, status }: ProjectMetaLineProps) {
  const { tokens } = formatProjectMeta({ slug, status });
  if (tokens.length === 0) return null;

  const slugToken = (slug ?? "").trim();
  const hasSlug = slugToken.length > 0;

  return (
    <p className="text-xs text-muted-foreground" data-testid="project-meta-line">
      {tokens.map((token, i) => (
        <span key={i}>
          {i > 0 ? META_SEPARATOR : null}
          {hasSlug && i === 0 ? <code>{token}</code> : token}
        </span>
      ))}
    </p>
  );
}

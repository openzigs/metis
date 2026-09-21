/**
 * Stakeholders + project-context panel (Epic #208 / Issue #233).
 *
 * Presentational surface for the stakeholder/context model and the elicited
 * NFR/AC/assumption/risk artifacts. Kept prop-driven (no data fetching) so it
 * is trivially unit-testable; the analysis page wires the data in.
 */
"use client";

import type {
  AcceptanceCriterion,
  Assumption,
  Nfr,
  ProjectContext,
  Risk,
  Stakeholder,
} from "@metis/shared";

const LEVEL_CLASS: Record<string, string> = {
  high: "bg-red-900/40 text-red-200",
  medium: "bg-amber-900/40 text-amber-200",
  low: "bg-zinc-800 text-zinc-300",
};

function LevelBadge({ label, value }: { label: string; value: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LEVEL_CLASS[value] ?? "bg-zinc-800 text-zinc-300"}`}
      title={`${label}: ${value}`}
    >
      {label}: {value}
    </span>
  );
}

function StakeholderList({ stakeholders }: { stakeholders: Stakeholder[] }) {
  if (stakeholders.length === 0) {
    return <p className="text-xs text-zinc-500">No stakeholders captured yet.</p>;
  }
  return (
    <ul className="space-y-2" data-testid="stakeholder-list">
      {stakeholders.map((s) => (
        <li key={s.id} className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-zinc-100">{s.name}</span>
            <div className="flex gap-1">
              <LevelBadge label="influence" value={s.influence} />
              <LevelBadge label="interest" value={s.interest} />
            </div>
          </div>
          {s.role ? <p className="text-xs text-zinc-400">{s.role}</p> : null}
          {s.viewpoint ? (
            <p className="text-[11px] text-zinc-500">viewpoint: {s.viewpoint}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ContextSummary({ context }: { context: ProjectContext | null }) {
  if (!context) return null;
  const hasAny =
    context.businessGoals ||
    context.inScope.length > 0 ||
    context.outOfScope.length > 0 ||
    context.constraints.length > 0 ||
    context.glossary.length > 0;
  if (!hasAny) {
    return <p className="text-xs text-zinc-500">No project context captured yet.</p>;
  }
  return (
    <div className="space-y-2 text-sm" data-testid="project-context">
      {context.businessGoals ? (
        <p>
          <span className="text-zinc-400">Business goals: </span>
          {context.businessGoals}
        </p>
      ) : null}
      {context.inScope.length > 0 ? <ScopeList label="In scope" items={context.inScope} /> : null}
      {context.outOfScope.length > 0 ? (
        <ScopeList label="Out of scope" items={context.outOfScope} />
      ) : null}
      {context.constraints.length > 0 ? (
        <ScopeList label="Constraints" items={context.constraints} />
      ) : null}
      {context.glossary.length > 0 ? (
        <div>
          <span className="text-zinc-400">Glossary:</span>
          <ul className="ml-4 list-disc">
            {context.glossary.map((g) => (
              <li key={g.term}>
                <span className="font-medium">{g.term}</span>: {g.definition}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ScopeList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <span className="text-zinc-400">{label}:</span>
      <ul className="ml-4 list-disc">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export interface ElicitedArtifacts {
  nfrs: Nfr[];
  acceptanceCriteria: AcceptanceCriterion[];
  assumptions: Assumption[];
  risks: Risk[];
}

function ArtifactsSection({ artifacts }: { artifacts: ElicitedArtifacts | null }) {
  if (!artifacts) return null;
  const empty =
    artifacts.nfrs.length === 0 &&
    artifacts.acceptanceCriteria.length === 0 &&
    artifacts.assumptions.length === 0 &&
    artifacts.risks.length === 0;
  if (empty) {
    return (
      <p className="text-xs text-zinc-500">No elicited NFRs, criteria, assumptions, or risks.</p>
    );
  }
  return (
    <div className="space-y-3 text-sm" data-testid="elicited-artifacts">
      {artifacts.nfrs.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold uppercase text-zinc-400">
            Non-functional requirements
          </h4>
          <ul className="ml-4 list-disc">
            {artifacts.nfrs.map((n) => (
              <li key={n.id}>
                <span className="font-medium">{n.title}</span> ({n.category}/{n.priority})
                {n.metric ? <span className="text-zinc-400"> — {n.metric}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {artifacts.acceptanceCriteria.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold uppercase text-zinc-400">Acceptance criteria</h4>
          <ul className="ml-4 list-disc">
            {artifacts.acceptanceCriteria.map((a) => (
              <li key={a.id}>{a.statement}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {artifacts.assumptions.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold uppercase text-zinc-400">Assumptions</h4>
          <ul className="ml-4 list-disc">
            {artifacts.assumptions.map((a) => (
              <li key={a.id}>
                {a.statement}{" "}
                <span className="text-zinc-500">(impact if false: {a.impactIfFalse})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {artifacts.risks.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold uppercase text-zinc-400">Risks</h4>
          <ul className="ml-4 list-disc">
            {artifacts.risks.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.title}</span>{" "}
                <span className="text-zinc-500">
                  (likelihood: {r.likelihood}, impact: {r.impact})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export interface StakeholdersPanelProps {
  stakeholders: Stakeholder[];
  context?: ProjectContext | null;
  artifacts?: ElicitedArtifacts | null;
}

export function StakeholdersPanel({
  stakeholders,
  context = null,
  artifacts = null,
}: StakeholdersPanelProps) {
  return (
    <section
      className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
      data-testid="stakeholders-panel"
    >
      <header>
        <h3 className="text-sm font-semibold text-zinc-100">Stakeholders &amp; context</h3>
        <p className="text-xs text-zinc-500">
          Who the requirements serve, the project framing, and the elicited NFRs, acceptance
          criteria, assumptions, and risks.
        </p>
      </header>

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase text-zinc-400">Stakeholders</h4>
        <StakeholderList stakeholders={stakeholders} />
      </div>

      {context ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase text-zinc-400">Project context</h4>
          <ContextSummary context={context} />
        </div>
      ) : null}

      {artifacts ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase text-zinc-400">Elicited artifacts</h4>
          <ArtifactsSection artifacts={artifacts} />
        </div>
      ) : null}
    </section>
  );
}

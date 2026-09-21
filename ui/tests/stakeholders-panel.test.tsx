/**
 * Tests for <StakeholdersPanel /> (Epic #208 / Issue #233).
 *
 * The panel surfaces stakeholders, project context, and the elicited
 * NFR/AC/assumption/risk artifacts.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  AcceptanceCriterion,
  Assumption,
  Nfr,
  ProjectContext,
  Risk,
  Stakeholder,
} from "@metis/shared";
import { StakeholdersPanel } from "@/components/analysis/StakeholdersPanel";

const stakeholders: Stakeholder[] = [
  {
    id: "sh1",
    projectId: "p1",
    name: "Compliance Officer",
    role: "Legal",
    description: "",
    influence: "high",
    interest: "medium",
    viewpoint: "compliance",
  },
];

const context: ProjectContext = {
  businessGoals: "Reduce onboarding time",
  inScope: ["self-service signup"],
  outOfScope: ["enterprise SSO"],
  constraints: ["GDPR"],
  glossary: [{ term: "KYC", definition: "know your customer" }],
};

const artifacts = {
  nfrs: [
    {
      id: "n1",
      category: "performance",
      title: "Fast signup",
      description: "be fast",
      metric: "p95<2s",
      priority: "must-have",
    } satisfies Nfr,
  ],
  acceptanceCriteria: [
    {
      id: "a1",
      statement: "User receives a confirmation email",
      given: "",
      when: "",
      then: "",
    } satisfies AcceptanceCriterion,
  ],
  assumptions: [
    {
      id: "as1",
      statement: "Email delivery is reliable",
      rationale: "",
      impactIfFalse: "medium",
    } satisfies Assumption,
  ],
  risks: [
    {
      id: "r1",
      title: "Spam filtering",
      description: "Emails may be filtered",
      likelihood: "medium",
      impact: "high",
      mitigation: "",
    } satisfies Risk,
  ],
};

describe("<StakeholdersPanel />", () => {
  it("renders stakeholders with influence/interest badges", () => {
    render(<StakeholdersPanel stakeholders={stakeholders} />);
    expect(screen.getByText("Compliance Officer")).toBeInTheDocument();
    expect(screen.getByText("Legal")).toBeInTheDocument();
    expect(screen.getByText("influence: high")).toBeInTheDocument();
    expect(screen.getByText("interest: medium")).toBeInTheDocument();
    expect(screen.getByText(/viewpoint: compliance/)).toBeInTheDocument();
  });

  it("shows an empty state when there are no stakeholders", () => {
    render(<StakeholdersPanel stakeholders={[]} />);
    expect(screen.getByText(/No stakeholders captured/i)).toBeInTheDocument();
  });

  it("renders project context goals, scope, constraints, and glossary", () => {
    render(<StakeholdersPanel stakeholders={[]} context={context} />);
    expect(screen.getByText(/Reduce onboarding time/)).toBeInTheDocument();
    expect(screen.getByText("self-service signup")).toBeInTheDocument();
    expect(screen.getByText("enterprise SSO")).toBeInTheDocument();
    expect(screen.getByText("GDPR")).toBeInTheDocument();
    expect(screen.getByText("KYC")).toBeInTheDocument();
  });

  it("renders an empty context state when context is all-empty", () => {
    render(
      <StakeholdersPanel
        stakeholders={[]}
        context={{ businessGoals: "", inScope: [], outOfScope: [], constraints: [], glossary: [] }}
      />,
    );
    expect(screen.getByText(/No project context captured/i)).toBeInTheDocument();
  });

  it("renders elicited NFRs, criteria, assumptions, and risks", () => {
    render(<StakeholdersPanel stakeholders={[]} artifacts={artifacts} />);
    expect(screen.getByText("Fast signup")).toBeInTheDocument();
    expect(screen.getByText(/p95<2s/)).toBeInTheDocument();
    expect(screen.getByText(/confirmation email/)).toBeInTheDocument();
    expect(screen.getByText(/impact if false: medium/)).toBeInTheDocument();
    expect(screen.getByText("Spam filtering")).toBeInTheDocument();
    expect(screen.getByText(/likelihood: medium, impact: high/)).toBeInTheDocument();
  });

  it("shows an empty artifacts state when all lists are empty", () => {
    render(
      <StakeholdersPanel
        stakeholders={[]}
        artifacts={{ nfrs: [], acceptanceCriteria: [], assumptions: [], risks: [] }}
      />,
    );
    expect(screen.getByText(/No elicited NFRs/i)).toBeInTheDocument();
  });

  it("renders the full panel when all data is supplied", () => {
    render(
      <StakeholdersPanel stakeholders={stakeholders} context={context} artifacts={artifacts} />,
    );
    expect(screen.getByTestId("stakeholders-panel")).toBeInTheDocument();
    expect(screen.getByTestId("stakeholder-list")).toBeInTheDocument();
    expect(screen.getByTestId("project-context")).toBeInTheDocument();
    expect(screen.getByTestId("elicited-artifacts")).toBeInTheDocument();
  });
});

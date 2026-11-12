/**
 * #2337 — in-app help. The Help menu used to link the User Guide and the issue
 * tracker on GitHub, which an analyst may have no access to. This page answers
 * the first questions inside METIS: how to start, where things are in a
 * project, what METIS's own words mean, and who to ask.
 *
 * The project section list is read from the tab model, so it cannot drift from
 * the tab bar.
 */
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getProjectTabModel } from "@/components/projects/project-tabs";

const GETTING_STARTED: ReadonlyArray<{ step: string; detail: string }> = [
  {
    step: "Open or create a project",
    detail: "Projects lists every project you can open. One project describes one system.",
  },
  {
    step: "Connect what METIS should read",
    detail:
      "Add a repository, a database or documents. A private repository needs an access token that an admin stores in the vault.",
  },
  {
    step: "Run an analysis",
    detail: "METIS reads the sources and drafts requirements, each with the evidence behind it.",
  },
  {
    step: "Review the requirements",
    detail: "Approve, edit or reject each one, and discuss it with your team.",
  },
  {
    step: "Produce the deliverables",
    detail: "Generate documentation, or publish approved requirements as issues for the team.",
  },
];

/** The words METIS uses on screen that mean something specific here. */
const HELP_GLOSSARY: ReadonlyArray<{ term: string; meaning: string }> = [
  {
    term: "Sections indexed",
    meaning:
      "METIS splits each document and file into short sections so it can search them. The count is how many it can search.",
  },
  {
    term: "Update",
    meaning: "Fetch the latest changes to a repository and re-read only the files that changed.",
  },
  {
    term: "Full re-read",
    meaning:
      "Read the whole repository again from scratch. Use it the first time, or when an update is not enough.",
  },
  {
    term: "Vault secret",
    meaning:
      "A password or access token an admin stores in METIS's encrypted vault. Forms ask you to pick one by name; nobody sees its value.",
  },
  {
    term: "Short name",
    meaning: "A lower-case name used in the project's web address, such as payments-portal.",
  },
];

export default function HelpPage() {
  const sections = getProjectTabModel("help").sections;
  return (
    <div className="space-y-6 p-6" data-testid="help-root">
      <PageHeader
        title="Help"
        description="How to get started, where things are, and who to ask."
      />

      <Card className="space-y-3 p-4">
        <h2 className="text-lg font-semibold">Getting started</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          {GETTING_STARTED.map(({ step, detail }) => (
            <li key={step}>
              <span className="font-medium">{step}.</span>{" "}
              <span className="text-muted-foreground">{detail}</span>
            </li>
          ))}
        </ol>
        <p className="text-sm">
          <Link href="/projects" className="underline">
            Go to Projects →
          </Link>
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-lg font-semibold">Inside a project</h2>
        <p className="text-sm text-muted-foreground">
          A project&apos;s tabs, left to right, and the pages under each:
        </p>
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]" data-testid="help-project-tabs">
          {sections.map((section) => (
            <div key={section.id} className="contents">
              <dt className="font-medium">{section.label}</dt>
              <dd className="text-muted-foreground">
                {section.items.length > 0
                  ? section.items.map((item) => item.label).join(", ")
                  : "Where each stage stands and what to do next"}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-lg font-semibold">Words METIS uses</h2>
        <dl className="space-y-2 text-sm" data-testid="help-glossary">
          {HELP_GLOSSARY.map(({ term, meaning }) => (
            <div key={term}>
              <dt className="font-medium">{term}</dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="space-y-2 p-4" id="contact" data-testid="help-contact">
        <h2 className="text-lg font-semibold">Need a hand?</h2>
        <p className="text-sm text-muted-foreground">
          Ask your METIS administrator. They give people access to projects, add secrets to the
          vault, and choose the AI models and budgets. Your own details are under{" "}
          <Link href="/settings/profile" className="underline">
            Settings → Profile
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}

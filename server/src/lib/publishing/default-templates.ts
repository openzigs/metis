/**
 * Default Templates — Epic #595 / Issue #612.
 *
 * Four built-in templates seeded for every new project:
 *   1. GitHub Epic
 *   2. GitHub Feature
 *   3. Jira Story
 *   4. Jira Bug
 *
 * These encode METIS best practices for AI-generated issues and match
 * the existing output format of draft-generator.ts.
 */
import type { TemplateSchema } from "./template-schema.js";

export const GITHUB_EPIC_TEMPLATE: TemplateSchema = {
  name: "GitHub Epic",
  platform: "github",
  templateType: "epic",
  sections: [
    {
      key: "title",
      label: "Title",
      type: "text",
      required: true,
      validation: { minLength: 5, maxLength: 200 },
      placeholder: "[Epic] Project Name — Feature Area",
    },
    {
      key: "description",
      label: "Description",
      type: "markdown",
      required: true,
      validation: { minLength: 20 },
      placeholder: "Describe the epic's goal and scope…",
    },
    {
      key: "architectureDiagram",
      label: "Architecture Diagram",
      type: "markdown",
      required: false,
      placeholder: "```mermaid\nflowchart LR\n  A --> B\n```",
    },
    {
      key: "subIssues",
      label: "Sub-Issues",
      type: "checklist",
      required: true,
      validation: { minItems: 1 },
      placeholder: "List of sub-issues to be created",
    },
    {
      key: "acceptanceCriteria",
      label: "Acceptance Criteria",
      type: "checklist",
      required: true,
      validation: { minItems: 1 },
      placeholder: "Conditions that must be met for the epic to be considered done",
    },
    {
      key: "storyPoints",
      label: "Story Points",
      type: "number",
      required: true,
      validation: { min: 1, max: 100 },
      defaultValue: 13,
    },
    {
      key: "labels",
      label: "Labels",
      type: "tags",
      required: false,
      defaultValue: ["epic", "metis-generated"],
      validation: { maxItems: 20 },
    },
  ],
};

export const GITHUB_FEATURE_TEMPLATE: TemplateSchema = {
  name: "GitHub Feature",
  platform: "github",
  templateType: "feature",
  sections: [
    {
      key: "title",
      label: "Title",
      type: "text",
      required: true,
      validation: { minLength: 5, maxLength: 200 },
      placeholder: "[Feature] Short description",
    },
    {
      key: "description",
      label: "Description",
      type: "markdown",
      required: true,
      validation: { minLength: 20 },
      placeholder: "Describe what the feature does and why it's needed…",
    },
    {
      key: "acceptanceCriteria",
      label: "Acceptance Criteria",
      type: "checklist",
      required: true,
      validation: { minItems: 1 },
      placeholder: "Given/When/Then acceptance criteria",
    },
    {
      key: "storyPoints",
      label: "Story Points",
      type: "number",
      required: true,
      validation: { min: 1, max: 21 },
      defaultValue: 3,
    },
    {
      key: "technicalNotes",
      label: "Technical Details",
      type: "markdown",
      required: false,
      placeholder: "Implementation notes, affected files, approaches…",
    },
    {
      key: "dependencies",
      label: "Dependencies",
      type: "checklist",
      required: false,
      placeholder: "Other issues that must be completed first",
    },
    {
      key: "labels",
      label: "Labels",
      type: "tags",
      required: false,
      defaultValue: ["feature", "metis-generated"],
      validation: { maxItems: 20 },
    },
    {
      key: "priority",
      label: "Priority",
      type: "select",
      required: false,
      validation: { options: ["critical", "high", "medium", "low"] },
      defaultValue: "medium",
    },
  ],
};

export const JIRA_STORY_TEMPLATE: TemplateSchema = {
  name: "Jira Story",
  platform: "jira",
  templateType: "story",
  sections: [
    {
      key: "title",
      label: "Summary",
      type: "text",
      required: true,
      validation: { minLength: 5, maxLength: 255 },
      placeholder: "As a [user], I want [feature] so that [benefit]",
    },
    {
      key: "description",
      label: "Description",
      type: "markdown",
      required: true,
      validation: { minLength: 20 },
      placeholder: "Detailed description of the story…",
    },
    {
      key: "acceptanceCriteria",
      label: "Acceptance Criteria",
      type: "checklist",
      required: true,
      validation: { minItems: 1 },
      placeholder: "Given/When/Then acceptance criteria",
    },
    {
      key: "storyPoints",
      label: "Story Points",
      type: "number",
      required: true,
      validation: { min: 1, max: 21 },
      defaultValue: 3,
    },
    {
      key: "priority",
      label: "Priority",
      type: "select",
      required: true,
      validation: { options: ["Highest", "High", "Medium", "Low", "Lowest"] },
      defaultValue: "Medium",
    },
    {
      key: "component",
      label: "Component",
      type: "text",
      required: false,
      placeholder: "e.g. Backend, Frontend, API",
    },
    {
      key: "labels",
      label: "Labels",
      type: "tags",
      required: false,
      defaultValue: ["metis-generated"],
      validation: { maxItems: 20 },
    },
    {
      key: "evidenceBlock",
      label: "Evidence / Citations",
      type: "markdown",
      required: false,
      placeholder: "Source references and traceability links…",
    },
  ],
  platformFields: {
    storyPoints: { jiraField: "customfield_10016" },
    priority: { jiraField: "priority" },
    component: { jiraField: "components" },
    labels: { jiraField: "labels" },
  },
};

export const JIRA_BUG_TEMPLATE: TemplateSchema = {
  name: "Jira Bug",
  platform: "jira",
  templateType: "bug",
  sections: [
    {
      key: "title",
      label: "Summary",
      type: "text",
      required: true,
      validation: { minLength: 5, maxLength: 255 },
      placeholder: "[Bug] Short description of the defect",
    },
    {
      key: "description",
      label: "Description",
      type: "markdown",
      required: true,
      validation: { minLength: 10 },
      placeholder: "Describe the bug…",
    },
    {
      key: "stepsToReproduce",
      label: "Steps to Reproduce",
      type: "checklist",
      required: true,
      validation: { minItems: 1 },
      placeholder: "Numbered steps to reproduce the issue",
    },
    {
      key: "expectedBehavior",
      label: "Expected Behavior",
      type: "markdown",
      required: true,
      placeholder: "What should happen…",
    },
    {
      key: "actualBehavior",
      label: "Actual Behavior",
      type: "markdown",
      required: true,
      placeholder: "What actually happens…",
    },
    {
      key: "severity",
      label: "Severity",
      type: "select",
      required: true,
      validation: { options: ["Blocker", "Critical", "Major", "Minor", "Trivial"] },
      defaultValue: "Major",
    },
    {
      key: "environment",
      label: "Environment",
      type: "text",
      required: false,
      placeholder: "OS, browser, version, etc.",
    },
    {
      key: "priority",
      label: "Priority",
      type: "select",
      required: true,
      validation: { options: ["Highest", "High", "Medium", "Low", "Lowest"] },
      defaultValue: "Medium",
    },
    {
      key: "labels",
      label: "Labels",
      type: "tags",
      required: false,
      defaultValue: ["bug", "metis-generated"],
      validation: { maxItems: 20 },
    },
  ],
  platformFields: {
    severity: { jiraField: "customfield_10017" },
    priority: { jiraField: "priority" },
    environment: { jiraField: "environment" },
    labels: { jiraField: "labels" },
  },
};

/** All default templates in seed order. */
export const DEFAULT_TEMPLATES: TemplateSchema[] = [
  GITHUB_EPIC_TEMPLATE,
  GITHUB_FEATURE_TEMPLATE,
  JIRA_STORY_TEMPLATE,
  JIRA_BUG_TEMPLATE,
];

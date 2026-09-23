/**
 * Epic #739 / Issue #740 — Tests for GitHub issue webhook handler.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeGithubIssueEvent,
  type GithubIssueWebhookPayload,
} from "./github-issue-webhook.js";

describe("normalizeGithubIssueEvent", () => {
  const basePayload: GithubIssueWebhookPayload = {
    action: "edited",
    issue: {
      id: 12345,
      node_id: "I_abc123",
      number: 42,
      title: "Bug fix",
      body: "Fixed the thing",
      state: "open",
      labels: [{ name: "bug" }, { name: "priority:high" }],
      assignees: [{ login: "dev1" }],
    },
    changes: { title: { from: "Old title" } },
    sender: { login: "contributor" },
  };

  it("normalizes edited action", () => {
    const { event } = normalizeGithubIssueEvent(basePayload, "delivery-1");
    expect(event).not.toBeNull();
    expect(event!.source).toBe("github");
    expect(event!.action).toBe("edited");
    expect(event!.externalId).toBe("I_abc123");
    expect(event!.externalRef).toBe("42");
    expect(event!.current.title).toBe("Bug fix");
    expect(event!.current.labels).toEqual(["bug", "priority:high"]);
    expect(event!.current.assignees).toEqual(["dev1"]);
    expect(event!.changes.title).toBe("Bug fix");
    expect(event!.actor).toBe("contributor");
  });

  it("normalizes closed action", () => {
    const payload = { ...basePayload, action: "closed" };
    payload.issue = { ...basePayload.issue, state: "closed" };
    const { event } = normalizeGithubIssueEvent(payload, "delivery-2");
    expect(event!.action).toBe("closed");
    expect(event!.current.state).toBe("closed");
    expect(event!.changes.state).toBe("closed");
  });

  it("normalizes reopened action", () => {
    const payload = { ...basePayload, action: "reopened" };
    const { event } = normalizeGithubIssueEvent(payload, "delivery-3");
    expect(event!.action).toBe("reopened");
    expect(event!.changes.state).toBe("open");
  });

  it("normalizes labeled action", () => {
    const payload = { ...basePayload, action: "labeled" };
    const { event } = normalizeGithubIssueEvent(payload, "delivery-4");
    expect(event!.action).toBe("labeled");
    expect(event!.changes.labels).toEqual(["bug", "priority:high"]);
  });

  it("normalizes assigned action", () => {
    const payload = { ...basePayload, action: "assigned" };
    const { event } = normalizeGithubIssueEvent(payload, "delivery-5");
    expect(event!.action).toBe("assigned");
    expect(event!.changes.assignees).toEqual(["dev1"]);
  });

  it("returns null for unsupported actions", () => {
    const payload = { ...basePayload, action: "pinned" };
    const { event, reason } = normalizeGithubIssueEvent(payload, "delivery-6");
    expect(event).toBeNull();
    expect(reason).toBe("UNSUPPORTED_ACTION");
  });

  it("returns null when issue payload is missing", () => {
    const payload = { action: "edited" } as unknown as GithubIssueWebhookPayload;
    const { event, reason } = normalizeGithubIssueEvent(payload, "delivery-7");
    expect(event).toBeNull();
    expect(reason).toBe("NO_ISSUE_PAYLOAD");
  });

  it("uses provided deliveryId", () => {
    const { event } = normalizeGithubIssueEvent(basePayload, "custom-delivery-id");
    expect(event!.deliveryId).toBe("custom-delivery-id");
  });

  it("handles missing optional fields gracefully", () => {
    const payload: GithubIssueWebhookPayload = {
      action: "edited",
      issue: {
        id: 1,
        node_id: "N_1",
        number: 1,
        title: "Title",
        body: null,
        state: "open",
      },
    };
    const { event } = normalizeGithubIssueEvent(payload, "d-1");
    expect(event!.current.body).toBe("");
    expect(event!.current.labels).toEqual([]);
    expect(event!.current.assignees).toEqual([]);
    expect(event!.actor).toBeUndefined();
  });
});

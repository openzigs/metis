/**
 * Epic #739 / Issue #741 — Tests for Jira webhook handler.
 */
import { describe, it, expect } from "vitest";
import {
  verifyJiraWebhookSignature,
  normalizeJiraIssueEvent,
  type JiraWebhookPayload,
} from "./jira-webhook.js";
import crypto from "node:crypto";

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyJiraWebhookSignature", () => {
  const secret = "jira-webhook-secret";
  const body = '{"webhookEvent":"jira:issue_updated"}';

  it("returns ok when signature matches (Cloud format)", () => {
    const sig = sign(body, secret);
    const result = verifyJiraWebhookSignature(body, secret, { signature: sig });
    expect(result.ok).toBe(true);
  });

  it("returns ok when signature has sha256= prefix", () => {
    const sig = "sha256=" + sign(body, secret);
    const result = verifyJiraWebhookSignature(body, secret, { signature: sig });
    expect(result.ok).toBe(true);
  });

  it("returns SIGNATURE_MISMATCH on bad signature", () => {
    const result = verifyJiraWebhookSignature(body, secret, {
      signature: "a".repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("SIGNATURE_MISMATCH");
  });

  it("returns NO_SIGNATURE when signature missing", () => {
    const result = verifyJiraWebhookSignature(body, secret, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_SIGNATURE");
  });

  it("returns NO_SECRET_CONFIGURED when secret empty", () => {
    const result = verifyJiraWebhookSignature(body, "", { signature: "abc" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_SECRET_CONFIGURED");
  });

  it("returns REPLAY_DETECTED when timestamp too old", () => {
    const sig = sign(body, secret);
    const oldTs = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    const result = verifyJiraWebhookSignature(body, secret, {
      signature: sig,
      timestamp: oldTs,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("REPLAY_DETECTED");
  });

  it("accepts timestamp within 5-minute window", () => {
    const sig = sign(body, secret);
    const recentTs = Date.now() - 2 * 60 * 1000; // 2 minutes ago
    const result = verifyJiraWebhookSignature(body, secret, {
      signature: sig,
      timestamp: recentTs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("normalizeJiraIssueEvent", () => {
  const cloudPayload: JiraWebhookPayload = {
    webhookEvent: "jira:issue_updated",
    timestamp: Date.now(),
    issue: {
      id: "10042",
      key: "PROJ-42",
      fields: {
        summary: "Bug in login",
        description: "Detailed description",
        status: { name: "In Progress" },
        labels: [{ name: "bug" }, { name: "critical" }],
        assignee: { displayName: "Dev User", accountId: "acc-123" },
      },
    },
    changelog: {
      items: [
        { field: "summary", fromString: "Old Summary", toString: "Bug in login" },
        { field: "assignee", fromString: "Other", toString: "Dev User" },
      ],
    },
    user: { displayName: "Admin", accountId: "admin-1" },
  };

  it("normalizes Cloud issue_updated payload", () => {
    const { event } = normalizeJiraIssueEvent(cloudPayload, "jira-delivery-1");
    expect(event).not.toBeNull();
    expect(event!.source).toBe("jira");
    expect(event!.externalId).toBe("10042");
    expect(event!.externalRef).toBe("PROJ-42");
    expect(event!.action).toBe("edited");
    expect(event!.current.title).toBe("Bug in login");
    expect(event!.current.body).toBe("Detailed description");
    expect(event!.current.state).toBe("open");
    expect(event!.current.labels).toEqual(["bug", "critical"]);
    expect(event!.current.assignees).toEqual(["Dev User"]);
    expect(event!.changes.title).toBe("Bug in login");
    expect(event!.changes.assignees).toEqual(["Dev User"]);
    expect(event!.actor).toBe("Admin");
  });

  it("produces identical normalized event for DC payload format", () => {
    // DC uses same structure but may have `name` instead of `accountId`
    const dcPayload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      timestamp: Date.now(),
      issue: {
        id: "10042",
        key: "PROJ-42",
        fields: {
          summary: "Bug in login",
          description: "Detailed description",
          status: { name: "In Progress" },
          labels: ["bug", "critical"] as unknown as Array<{ name?: string } | string>,
          assignee: { displayName: "Dev User", name: "devuser" },
        },
      },
      changelog: {
        items: [{ field: "summary", fromString: "Old", toString: "Bug in login" }],
      },
      user: { displayName: "Admin", name: "admin" },
    };

    const { event: cloudEvent } = normalizeJiraIssueEvent(cloudPayload, "del-1");
    const { event: dcEvent } = normalizeJiraIssueEvent(dcPayload, "del-2");

    // Both should produce same normalized fields
    expect(dcEvent!.source).toBe(cloudEvent!.source);
    expect(dcEvent!.current.title).toBe(cloudEvent!.current.title);
    expect(dcEvent!.current.labels).toEqual(cloudEvent!.current.labels);
    expect(dcEvent!.current.assignees).toEqual(cloudEvent!.current.assignees);
  });

  it("detects closed status from changelog", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      issue: {
        id: "10043",
        key: "PROJ-43",
        fields: {
          summary: "Done task",
          status: { name: "Done" },
        },
      },
      changelog: {
        items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
      },
    };

    const { event } = normalizeJiraIssueEvent(payload, "del-3");
    expect(event!.action).toBe("closed");
    expect(event!.current.state).toBe("closed");
  });

  it("returns null for non-issue events", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:project_created",
    };
    const { event, reason } = normalizeJiraIssueEvent(payload, "del-4");
    expect(event).toBeNull();
    expect(reason).toBe("UNSUPPORTED_EVENT");
  });

  it("returns null when issue payload is missing", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
    };
    const { event, reason } = normalizeJiraIssueEvent(payload, "del-5");
    expect(event).toBeNull();
    expect(reason).toBe("NO_ISSUE_PAYLOAD");
  });

  it("handles missing fields gracefully", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      issue: {
        id: "10044",
        key: "PROJ-44",
        fields: {},
      },
    };
    const { event } = normalizeJiraIssueEvent(payload, "del-6");
    expect(event!.current.title).toBe("");
    expect(event!.current.body).toBe("");
    expect(event!.current.labels).toEqual([]);
    expect(event!.current.assignees).toEqual([]);
  });

  it("infers assigned action from changelog", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      issue: {
        id: "10045",
        key: "PROJ-45",
        fields: {
          summary: "Task",
          assignee: { displayName: "New Dev" },
        },
      },
      changelog: {
        items: [{ field: "assignee", fromString: null, toString: "New Dev" }],
      },
    };
    const { event } = normalizeJiraIssueEvent(payload, "del-7");
    expect(event!.action).toBe("assigned");
  });
});

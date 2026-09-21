/**
 * Issue #611 (epic #608) — shared notification channel/event vocabulary.
 */
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  isNotificationChannel,
  isNotificationEvent,
} from "../src/notifications.js";

describe("notification vocabulary", () => {
  it("covers the required channels", () => {
    expect(NOTIFICATION_CHANNELS).toEqual(["email", "inApp", "webhook", "teams"]);
  });

  it("covers the required events", () => {
    expect(NOTIFICATION_EVENTS).toEqual([
      "analysisCompleted",
      "requirementsApproved",
      "issuesPublished",
      "systemAlerts",
      "mention",
      "slaDeadline",
    ]);
  });

  it("has no duplicate values", () => {
    expect(new Set(NOTIFICATION_CHANNELS).size).toBe(NOTIFICATION_CHANNELS.length);
    expect(new Set(NOTIFICATION_EVENTS).size).toBe(NOTIFICATION_EVENTS.length);
  });
});

describe("isNotificationChannel", () => {
  it("accepts every declared channel", () => {
    for (const channel of NOTIFICATION_CHANNELS) {
      expect(isNotificationChannel(channel)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isNotificationChannel("sms")).toBe(false);
    expect(isNotificationChannel("")).toBe(false);
    expect(isNotificationChannel(1)).toBe(false);
    expect(isNotificationChannel(null)).toBe(false);
    expect(isNotificationChannel(undefined)).toBe(false);
  });
});

describe("isNotificationEvent", () => {
  it("accepts every declared event", () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(isNotificationEvent(event)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isNotificationEvent("deploy")).toBe(false);
    expect(isNotificationEvent({})).toBe(false);
    expect(isNotificationEvent(null)).toBe(false);
  });
});

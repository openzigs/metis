/**
 * Issue #1098 — on a run started from imported items, the code agent is given
 * each imported item once, first, and not the document agent's unrelated
 * features.
 */
import { describe, expect, it } from "vitest";
import {
  codeAgentRequirementSet,
  IMPORTED_RESTATEMENT_CONTAINMENT,
  scopeRequirementsToImported,
} from "./new-requirements.js";

const IMPORTED = [
  { id: "NR-1", text: "Keyboard shortcut to mark all entries as read" },
  { id: "NR-2", text: "Per-feed refresh interval" },
  { id: "NR-3", text: "Export starred entries to JSON" },
  { id: "NR-4", text: "Hide read feeds in the sidebar" },
  { id: "NR-5", text: "Terminate all sessions button" },
];
const IMPORTED_IDS = new Set(IMPORTED.map((r) => r.id));

const RESTATEMENTS = [
  {
    id: "REQ-024",
    text: "The system SHALL let a user mark all entries read with a keyboard shortcut.",
  },
  { id: "REQ-025", text: "Users can set a refresh interval for each feed (per-feed)." },
  { id: "REQ-026", text: "Starred entries can be exported as a JSON file." },
  { id: "REQ-027", text: "The sidebar hides feeds whose entries are all read." },
  { id: "REQ-028", text: "A button terminates all of the user's sessions." },
];
const UNRELATED = [
  "Import subscriptions from an OPML file",
  "Play YouTube videos inline",
  "Show favicons beside each feed",
  "Send a webhook on new entries",
  "Fever API compatibility",
  "Google Reader API compatibility",
  "Fetch original content with a scraper",
  "Rewrite rules per feed",
  "Block lists using regular expressions",
  "Keep lists using regular expressions",
  "Proxy media through the server",
  "Two-factor authentication with TOTP",
  "WebAuthn passkeys for login",
  "OAuth2 and OpenID Connect sign-in",
  "Integration with Pinboard",
  "Integration with Wallabag",
  "Integration with Pocket",
  "Telegram bot notifications",
  "Custom CSS for the reader",
  "Bookmarklet to subscribe to a site",
  "Translations into twenty languages",
  "PostgreSQL as the only database",
  "Single static binary deployment",
].map((text, i) => ({ id: `REQ-${String(i + 1).padStart(3, "0")}`, text }));

describe("scopeRequirementsToImported — #1098", () => {
  it("gives the code agent the imported items first, once each, and nothing unrelated", () => {
    const result = scopeRequirementsToImported(
      [...UNRELATED, ...RESTATEMENTS],
      IMPORTED,
      IMPORTED_IDS,
    );

    expect(result.requirements).toEqual(IMPORTED);
    expect(result.restated).toEqual([
      { id: "REQ-024", restatesId: "NR-1" },
      { id: "REQ-025", restatesId: "NR-2" },
      { id: "REQ-026", restatesId: "NR-3" },
      { id: "REQ-027", restatesId: "NR-4" },
      { id: "REQ-028", restatesId: "NR-5" },
    ]);
    expect(result.leftOut.map((r) => r.id)).toEqual(UNRELATED.map((r) => r.id));
    expect(result.merged).toEqual([]);
  });

  it("keeps an operator's own free-text requirement, after the imported items", () => {
    const result = scopeRequirementsToImported(
      [],
      [
        { id: "NR-1", text: "Add rate limiting" },
        ...IMPORTED.map((r, i) => ({ ...r, id: `NR-${i + 2}` })),
      ],
      new Set(["NR-2", "NR-3", "NR-4", "NR-5", "NR-6"]),
    );
    expect(result.requirements.map((r) => r.id)).toEqual([
      "NR-2",
      "NR-3",
      "NR-4",
      "NR-5",
      "NR-6",
      "NR-1",
    ]);
  });

  it("folds a restatement into the imported item it matches best", () => {
    const result = scopeRequirementsToImported(
      [{ id: "REQ-1", text: "Mark all entries as read from the keyboard shortcut list" }],
      [
        { id: "NR-1", text: "Mark entries as read" },
        { id: "NR-2", text: "Keyboard shortcut to mark all entries as read" },
      ],
      new Set(["NR-1", "NR-2"]),
    );
    expect(result.restated).toEqual([{ id: "REQ-1", restatesId: "NR-2" }]);
  });

  it("matches a singular restatement of a plural title", () => {
    const result = scopeRequirementsToImported(
      [{ id: "REQ-1", text: "A user can mute a feed." }],
      [{ id: "NR-1", text: "Mute feeds" }],
      new Set(["NR-1"]),
    );
    expect(result.restated).toEqual([{ id: "REQ-1", restatesId: "NR-1" }]);
  });

  it("reports a candidate with no usable text as dropped", () => {
    const result = scopeRequirementsToImported(
      [],
      [{ id: "NR-1", text: "!!!" }],
      new Set(["NR-1"]),
    );
    expect(result.requirements).toEqual([]);
    expect(result.dropped).toEqual([
      expect.objectContaining({ id: "NR-1", reason: "unparseable" }),
    ]);
  });

  it("does not call a requirement a restatement on one shared word", () => {
    expect(IMPORTED_RESTATEMENT_CONTAINMENT).toBeGreaterThan(0.5);
    const result = scopeRequirementsToImported(
      [{ id: "REQ-1", text: "Import subscriptions from an OPML file" }],
      [{ id: "NR-1", text: "Export subscriptions as OPML" }],
      new Set(["NR-1"]),
    );
    // "subscription" and "opml" are two of three words: a restatement by the measure.
    expect(result.restated).toHaveLength(1);
    const unrelated = scopeRequirementsToImported(
      [{ id: "REQ-1", text: "Show favicons beside each feed" }],
      [{ id: "NR-1", text: "Per-feed refresh interval" }],
      new Set(["NR-1"]),
    );
    expect(unrelated.restated).toEqual([]);
  });
});

describe("codeAgentRequirementSet — #1098", () => {
  it("is the ordinary merge on a run with no imported items", () => {
    const doc = [{ id: "REQ-001", text: "Log every login." }];
    const result = codeAgentRequirementSet(
      doc,
      [{ id: "NR-1", text: "Add /api/status." }],
      new Set(),
    );
    expect(result.requirements.map((r) => r.id)).toEqual(["REQ-001", "NR-1"]);
    expect(result.leftOut).toEqual([]);
    expect(result.restated).toEqual([]);
  });

  it("scopes to the imported items when there are some", () => {
    const result = codeAgentRequirementSet([...UNRELATED, ...RESTATEMENTS], IMPORTED, IMPORTED_IDS);
    expect(result.requirements).toEqual(IMPORTED);
    expect(result.leftOut).toHaveLength(23);
  });

  it("keeps an imported item past the candidate cap and folds its restatement into it", () => {
    const titles = Array.from({ length: 10 }, (_, i) => `Widget number${i + 1} export option`);
    const all = titles.map((text, i) => ({ id: `NR-${i + 1}`, text }));
    const capped = all.slice(0, 8);
    const restatements = [9, 10].map((n) => ({
      id: `REQ-${n}`,
      text: `The system SHALL provide a widget number${n} export option for users.`,
    }));
    const result = codeAgentRequirementSet(
      restatements,
      capped,
      new Set(all.map((r) => r.id)),
      all,
    );
    expect(result.requirements.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(result.leftOut).toEqual([]);
    expect(result.restated).toEqual([
      { id: "REQ-9", restatesId: "NR-9" },
      { id: "REQ-10", restatesId: "NR-10" },
    ]);
  });
});

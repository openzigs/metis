import { describe, expect, it } from "vitest";
import type { AnalysisSourceRequirement } from "@metis/shared";
import { classifyRequirementOrigins, orderTickedFirst, tickedFirst } from "./imported-scope.js";

const source = (candidateId: string, title: string): AnalysisSourceRequirement => ({
  candidateId,
  requirementId: `req-${candidateId}`,
  title,
  externalSource: "github",
  externalId: candidateId.replace("NR-", ""),
  externalUrl: null,
});

const req = (id: string, title: string, description = "") => ({ id, title, description });

describe("classifyRequirementOrigins — #1129", () => {
  it("returns an empty map on a run started from no imported items", () => {
    expect(classifyRequirementOrigins([req("REQ-1", "Export OPML")], []).size).toBe(0);
  });

  it("marks a requirement that restates a ticked item 'ticked' and the rest 'added'", () => {
    const origins = classifyRequirementOrigins(
      [
        req("REQ-1", "Mark all entries as read from the keyboard", "A shortcut marks all read."),
        req("REQ-2", "Import OPML", "Users can import subscriptions from an OPML file."),
        req("REQ-3", "Toggle entry bookmark", "Existing API behaviour."),
      ],
      [source("NR-1", "Keyboard shortcut to mark all entries as read")],
    );
    expect(origins.get("REQ-1")).toBe("ticked");
    expect(origins.get("REQ-2")).toBe("added");
    expect(origins.get("REQ-3")).toBe("added");
  });

  it("matches on the description when the title was rewritten", () => {
    const origins = classifyRequirementOrigins(
      [req("REQ-1", "Feed refresh scheduling", "Allow a per-feed refresh interval to be set.")],
      [source("NR-1", "Per-feed refresh interval")],
    );
    expect(origins.get("REQ-1")).toBe("ticked");
  });

  it("does not call a requirement ticked on one shared word of a long imported title", () => {
    const origins = classifyRequirementOrigins(
      [req("REQ-1", "Webhook delivery", "Send a webhook when a feed has new entries.")],
      [source("NR-1", "Show favicons beside each feed in the sidebar list")],
    );
    expect(origins.get("REQ-1")).toBe("added");
  });
});

describe("tickedFirst / orderTickedFirst — #1129", () => {
  it("puts ticked items first and keeps the original order within each group", () => {
    const origins = new Map([
      ["a", "added" as const],
      ["b", "ticked" as const],
      ["c", "added" as const],
      ["d", "ticked" as const],
    ]);
    const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    expect(orderTickedFirst(items, (i) => i.id, origins).map((i) => i.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
      "e",
    ]);
  });

  it("returns the input order unchanged when nothing is classified", () => {
    const items = [{ id: "x" }, { id: "y" }];
    expect(orderTickedFirst(items, (i) => i.id, new Map())).toEqual(items);
  });

  it("tickedFirst is the set of ticked ids", () => {
    const origins = new Map([
      ["a", "added" as const],
      ["b", "ticked" as const],
    ]);
    expect([...tickedFirst(origins)]).toEqual(["b"]);
  });
});

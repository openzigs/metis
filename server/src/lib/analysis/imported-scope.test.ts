import { describe, expect, it } from "vitest";
import type { AnalysisSourceRequirement, SynthesizedRequirement } from "@metis/shared";
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

  it("matches on the description when the title alone shares no word", () => {
    // The title has no word of the imported title; only the description does,
    // so dropping the description from the join turns this "added".
    const origins = classifyRequirementOrigins(
      [req("REQ-1", "Scheduling options", "Allow a per-feed refresh interval to be set.")],
      [source("NR-1", "Per-feed refresh interval")],
    );
    expect(origins.get("REQ-1")).toBe("ticked");
    expect(
      classifyRequirementOrigins(
        [req("REQ-1", "Scheduling options")],
        [source("NR-1", "Per-feed refresh interval")],
      ).get("REQ-1"),
    ).toBe("added");
  });

  it("does not call a requirement ticked on one shared word of a long imported title", () => {
    const origins = classifyRequirementOrigins(
      [req("REQ-1", "Webhook delivery", "Send a webhook when a feed has new entries.")],
      [source("NR-1", "Show favicons beside each feed in the sidebar list")],
    );
    expect(origins.get("REQ-1")).toBe("added");
  });
});

const synth = (title: string, body: string, sourceIds?: string[]): SynthesizedRequirement => ({
  type: "feature",
  title,
  body,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: [],
  ...(sourceIds !== undefined ? { sourceIds } : {}),
});

describe("classifyRequirementOrigins — recorded #1063 provenance decides first", () => {
  const ticked = [source("NR-1", "Per-feed refresh interval")];

  it("files a requirement the synthesis recorded as its own 'added' even when its words overlap a ticked title", () => {
    // The adversarial counterexample: the word join scores this 0.5 against
    // "Per-feed refresh interval" and would file it "ticked", while the badge
    // (fed by the recorded `sourceIds: []`) says "Added by the analysis".
    const requirements = [req("REQ-1", "Refresh all feeds", "Trigger a refresh of every feed.")];
    const synthesized = [synth("Refresh all feeds", "Trigger a refresh of every feed.", [])];

    expect(classifyRequirementOrigins(requirements, ticked).get("REQ-1")).toBe("ticked");
    expect(classifyRequirementOrigins(requirements, ticked, synthesized).get("REQ-1")).toBe(
      "added",
    );
  });

  it("files a requirement whose recorded ids include a ticked item 'ticked' though no word matches", () => {
    const requirements = [req("REQ-1", "Polling cadence", "Choose how often a source is polled.")];
    const synthesized = [synth("Polling cadence", "How often a source is polled.", ["NR-1"])];

    expect(classifyRequirementOrigins(requirements, ticked).get("REQ-1")).toBe("added");
    expect(classifyRequirementOrigins(requirements, ticked, synthesized).get("REQ-1")).toBe(
      "ticked",
    );
  });

  it("ignores recorded ids that are not this run's ticked items, and falls back to words", () => {
    // `cleanSourceIds`: a list naming only unknown ids is "not recorded". The
    // title shares no word with the ticked one, so the fallback says "added"
    // where the unchecked list (one id, so "ticked") would not.
    const requirements = [req("REQ-1", "Import OPML")];
    const synthesized = [synth("Import OPML", "", ["NR-99"])];

    expect(classifyRequirementOrigins(requirements, ticked, synthesized).get("REQ-1")).toBe(
      "added",
    );
  });

  it("leaves a rejected requirement out of the join, as promotion joins over the approved subset", () => {
    // REQ-B (rejected) and REQ-A both match S1, which records the ticked item.
    // Joined over everything, REQ-B takes S1 and REQ-A gets S2 ("added"); once
    // REQ-A alone is promoted it takes S1 and its badge says ticked.
    const requirements = [
      req("REQ-B", "Per-feed refresh interval setting"),
      req("REQ-A", "Refresh interval"),
    ];
    const synthesized = [
      synth("Per-feed refresh interval setting", "", ["NR-1"]),
      synth("Refresh interval defaults", "", []),
    ];

    expect(classifyRequirementOrigins(requirements, ticked, synthesized).get("REQ-A")).toBe(
      "added",
    );
    expect(
      classifyRequirementOrigins(requirements, ticked, synthesized, {
        rejectedIds: new Set(["REQ-B"]),
      }).get("REQ-A"),
    ).toBe("ticked");
  });

  it("falls back to the word join per requirement when its synthesized match recorded nothing", () => {
    const requirements = [
      req("REQ-1", "Per-feed refresh interval setting"),
      req("REQ-2", "Refresh all feeds", "Trigger a refresh of every feed."),
    ];
    const synthesized = [
      synth("Per-feed refresh interval setting", "Degraded: no sourceIds."),
      synth("Refresh all feeds", "Trigger a refresh of every feed.", []),
    ];

    const origins = classifyRequirementOrigins(requirements, ticked, synthesized);
    expect(origins.get("REQ-1")).toBe("ticked");
    expect(origins.get("REQ-2")).toBe("added");
  });

  it("leaves a requirement unclassified when it has no provenance and no imported title has a significant word", () => {
    const origins = classifyRequirementOrigins(
      [req("REQ-1", "Import OPML"), req("REQ-2", "Export OPML")],
      [source("NR-1", "the and of")],
      [synth("Import OPML", "", [])],
    );
    expect(origins.get("REQ-1")).toBe("added");
    expect(origins.has("REQ-2")).toBe(false);
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

/**
 * Issue #2596 — the requirements the analysis added at the checkpoint that
 * look like one read from the documents. The fixture is the reviewed list of
 * the 2026-11-16 walkthrough (FRD-12, Miniflux): 8 requirements extracted from
 * the document and 10 NFRs the elicitor added, 6 of them restating one of the 8.
 */
import { describe, expect, it } from "vitest";
import { resembledRequirements } from "./resembling-requirements.js";
import type { StructuredRequirement } from "./types/requirements.js";

const extracted = (id: string, title: string): StructuredRequirement => ({
  id,
  title,
  description: "",
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});
const nfr = (id: string, title: string): StructuredRequirement => ({
  ...extracted(id, title),
  type: "non-functional",
  elicitedNfr: { nfrCategory: "reliability", evidenceFindingIds: [] },
});

const OPTIONAL = extracted("R-1", "Optional expiry date when creating an API key");
const NEVER = extracted("R-2", "Keys without an expiry date never expire");
const REFUSED = extracted("R-3", "Expired keys are refused like unknown keys");
const LIST = extracted("R-4", "API key list shows expiry");
const PYTHON = extracted("R-5", "Python client can set expiry on key creation");
const FILTER = extracted("R-6", "Filter entries by maximum reading time");
const COMBINES = extracted("R-7", "Reading-time filter combines with existing filters");
const NO_FILTER = extracted("R-8", "No filter leaves entries list unchanged");

const WALKTHROUGH: StructuredRequirement[] = [
  OPTIONAL,
  NEVER,
  REFUSED,
  LIST,
  PYTHON,
  FILTER,
  COMBINES,
  NO_FILTER,
  nfr("N-1", "Expired API keys refused identically to unknown keys"),
  nfr(
    "N-2",
    "Backward compatibility: keys without expiry never expire and existing keys stay valid",
  ),
  nfr("N-3", "Unambiguous, clock-consistent expiry semantics"),
  nfr("N-4", "Backward compatibility of entries list when the reading-time filter is omitted"),
  nfr("N-5", "Efficient reading-time filtering on a large entries table"),
  nfr("N-6", "Reading-time data definition, backfill and NULL/zero handling"),
  nfr("N-7", "Reading-time filter composes with existing filters and validates input"),
  nfr("N-8", "Expiry visible in the API keys list (UI and API) with localisation"),
  nfr("N-9", "Client support for setting expiry on key creation"),
  nfr("N-10", "Automated test coverage for new behaviour"),
];

describe("#2596 — added requirements that resemble an extracted one", () => {
  it("places each walkthrough NFR beside the requirement it restates", () => {
    const out = resembledRequirements(WALKTHROUGH);
    expect(Object.fromEntries(out)).toEqual({
      "N-1": REFUSED.id,
      "N-2": NEVER.id,
      "N-4": FILTER.id,
      "N-5": FILTER.id,
      "N-7": COMBINES.id,
      "N-8": LIST.id,
      "N-9": PYTHON.id,
    });
  });

  it("leaves an NFR that shares only a word or two with every requirement", () => {
    const out = resembledRequirements(WALKTHROUGH);
    for (const id of ["N-3", "N-6", "N-10"]) expect(out.has(id)).toBe(false);
  });

  it("never marks a requirement read from the documents, however alike two of them are", () => {
    const twin = extracted("R-9", "Expired keys are refused like unknown keys");
    expect(resembledRequirements([REFUSED, twin]).size).toBe(0);
  });

  it("compares a requirement offered from a synthesis item as an added one", () => {
    const offered = {
      ...extracted("SYN-1", "Expired API keys refused identically to unknown keys"),
      synthesisItemKey: "k1",
    };
    expect(Object.fromEntries(resembledRequirements([REFUSED, offered]))).toEqual({
      "SYN-1": REFUSED.id,
    });
  });

  it("never places an added requirement beside another added one", () => {
    const a = nfr("N-1", "Expired API keys refused identically to unknown keys");
    const b = nfr("N-2", "Expired API keys refused like unknown keys");
    expect(resembledRequirements([a, b]).size).toBe(0);
  });

  it("refuses a tie: no guess between two equally close requirements", () => {
    const a = extracted("R-a", "Export entries as CSV file");
    const b = extracted("R-b", "Export entries as JSON file");
    const added = nfr("N-x", "Export entries file quickly");
    expect(resembledRequirements([a, b, added]).size).toBe(0);
  });

  it("needs three shared words, so two short titles never resemble on two", () => {
    const a = extracted("R-a", "API keys");
    const added = nfr("N-x", "API keys rotate");
    expect(resembledRequirements([a, added]).size).toBe(0);
  });

  it("needs most of the shorter title, so three shared words of many do not count", () => {
    const a = extracted(
      "R-a",
      "Entries list paginates, sorts, filters and exports reading history",
    );
    const added = nfr("N-x", "Reading history entries retention policy for archived feeds purge");
    expect(resembledRequirements([a, added]).size).toBe(0);
  });
});

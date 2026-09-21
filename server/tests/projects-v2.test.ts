/**
 * Projects v2 GraphQL helpers.
 */
import { describe, expect, it, vi } from "vitest";
import {
  addProjectItem,
  applyFieldMappings,
  encodeFieldValue,
  listProjectsV2,
  parseFieldMappings,
} from "../src/lib/publishing/projects-v2.js";
import type { PublishOctokitLike } from "../src/lib/publishing/types.js";

function makeClient(responses: Array<unknown>): PublishOctokitLike {
  let i = 0;
  return {
    request: vi.fn(async () => {
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return { status: 200, headers: {}, data: r };
    }),
  } as unknown as PublishOctokitLike;
}

describe("encodeFieldValue", () => {
  it("encodes each supported type", () => {
    expect(encodeFieldValue({ fieldId: "f", type: "text", value: "hi" })).toEqual({ text: "hi" });
    expect(encodeFieldValue({ fieldId: "f", type: "number", value: "5" })).toEqual({ number: 5 });
    expect(encodeFieldValue({ fieldId: "f", type: "date", value: "2026-01-01" })).toEqual({
      date: "2026-01-01",
    });
    expect(encodeFieldValue({ fieldId: "f", type: "single_select", value: "opt_1" })).toEqual({
      singleSelectOptionId: "opt_1",
    });
  });

  it("throws on unsupported types", () => {
    expect(() => encodeFieldValue({ fieldId: "f", type: "bogus" as never, value: "x" })).toThrow();
  });
});

describe("parseFieldMappings", () => {
  it("returns null on empty/invalid input", () => {
    expect(parseFieldMappings(null)).toBeNull();
    expect(parseFieldMappings("")).toBeNull();
    expect(parseFieldMappings("not json")).toBeNull();
  });
  it("filters bad entries", () => {
    const raw = JSON.stringify({
      Status: { fieldId: "f1", type: "single_select", value: "opt" },
      Bogus: { fieldId: "f2", type: "alien", value: "x" },
      MissingId: { type: "text", value: "x" },
      Points: { fieldId: "f3", type: "number", value: 5 },
    });
    const mappings = parseFieldMappings(raw);
    expect(mappings).toEqual({
      Status: { fieldId: "f1", type: "single_select", value: "opt" },
      Points: { fieldId: "f3", type: "number", value: 5 },
    });
  });
  it("returns null when no entries survive filtering", () => {
    expect(parseFieldMappings(JSON.stringify({ X: { type: "alien" } }))).toBeNull();
  });
});

describe("addProjectItem", () => {
  it("returns the new item id", async () => {
    const client = makeClient([{ data: { addProjectV2ItemById: { item: { id: "PVI_1" } } } }]);
    const r = await addProjectItem(client, { projectId: "PV_1", contentId: "I_1" });
    expect(r.projectItemId).toBe("PVI_1");
  });

  it("throws on GraphQL errors[]", async () => {
    const client = makeClient([{ errors: [{ message: "bad" }] }]);
    await expect(addProjectItem(client, { projectId: "x", contentId: "y" })).rejects.toThrow(/bad/);
  });

  it("throws when item.id is missing", async () => {
    const client = makeClient([{ data: { addProjectV2ItemById: { item: {} } } }]);
    await expect(addProjectItem(client, { projectId: "x", contentId: "y" })).rejects.toThrow();
  });
});

describe("applyFieldMappings", () => {
  it("applies each mapping and tags ok/fail per field", async () => {
    const client = makeClient([
      { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVI_1" } } } },
      { errors: [{ message: "nope" }] },
      new Error("boom"),
    ]);
    const out = await applyFieldMappings(client, {
      projectId: "PV_1",
      itemId: "PVI_1",
      mappings: {
        Status: { fieldId: "f1", type: "single_select", value: "open" },
        Points: { fieldId: "f2", type: "number", value: 5 },
        Date: { fieldId: "f3", type: "date", value: "2026-01-01" },
      },
    });
    expect(out).toEqual([
      { fieldId: "f1", ok: true },
      { fieldId: "f2", ok: false, error: "nope" },
      { fieldId: "f3", ok: false, error: "boom" },
    ]);
  });
});

describe("listProjectsV2", () => {
  it("returns the visible boards", async () => {
    const client = makeClient([
      {
        data: {
          viewer: {
            projectsV2: {
              nodes: [{ id: "PV_1", number: 1, title: "Board A", url: "https://x" }],
            },
          },
        },
      },
    ]);
    const boards = await listProjectsV2(client);
    expect(boards).toEqual([{ id: "PV_1", number: 1, title: "Board A", url: "https://x" }]);
  });
  it("throws on GraphQL errors", async () => {
    const client = makeClient([{ errors: [{ message: "forbidden" }] }]);
    await expect(listProjectsV2(client)).rejects.toThrow(/forbidden/);
  });
  it("returns [] when nodes are missing", async () => {
    const client = makeClient([{ data: { viewer: {} } }]);
    expect(await listProjectsV2(client)).toEqual([]);
  });
});

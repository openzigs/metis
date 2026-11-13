/**
 * #2310 (review of #2430) — `clarification-records.ts` against a real SQLite
 * database built by the migration chain:
 *
 *   - stored requirement ids are qualified by their analysis, and a record
 *     reads back only its own analysis's (unqualified ids written before
 *     #2310 are its own);
 *   - extending a record's requirements is a compare-and-set, so two reuses
 *     racing on one record each keep their id;
 *   - the edges of `recordClarification`, `reopenChangedSources` and the
 *     defensive column reads.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const {
  addClarificationRequirements,
  findClarificationsById,
  findSettledClarifications,
  qualifyRequirementId,
  recordClarification,
  reopenChangedSources,
} = await import("../src/lib/clarifications/clarification-records.js");
type ClarificationInput =
  import("../src/lib/clarifications/clarification-records.js").ClarificationInput;

const WS = "ws-2310r";
const USER = "u-2310r";
const PA = "proj-2310r-a";
const A1 = "ana-2310r-1";
const A2 = "ana-2310r-2";
const A3 = "ana-2310r-3";

const SOURCE = {
  documentId: "doc-2310r",
  filename: "frd.docx",
  headingPath: ["4 Accounts"],
  quote: "Passwords must be long enough for every account holder.",
};

const input = (over: Partial<ClarificationInput> = {}): ClarificationInput => ({
  origin: "analysis",
  questionKey: "key-1",
  analysisId: A1,
  question: "How long must a password be?",
  answer: "At least 12 characters.",
  answeredAt: new Date("2026-11-12T10:00:00.000Z"),
  ambiguityField: "minimumLength",
  source: SOURCE,
  requirementIds: ["R-1"],
  productIds: [],
  ...over,
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2310 — clarification records: qualified requirement ids and the edges",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const storedIds = async (id: string) =>
      JSON.parse(
        (await db.clarificationRecord.findUniqueOrThrow({ where: { id } })).requirementIds,
      ) as string[];

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2310-clarification-records");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PA, name: PA, slug: PA, createdById: USER, workspaceId: WS },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      vi.restoreAllMocks();
      await db.clarificationRecord.deleteMany({});
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("stores requirement ids qualified by their analysis, and a Spec Kit record's as they are", async () => {
      expect(qualifyRequirementId(A1, "R-1")).toBe(`${A1}:R-1`);
      expect(qualifyRequirementId(null, "AC-1")).toBe("AC-1");

      const { record } = await recordClarification(PA, input({ requirementIds: ["R-1", "R-1"] }));
      expect(await storedIds(record.id)).toEqual([`${A1}:R-1`]);
      expect(record.requirementIds).toEqual(["R-1"]);

      const spec = await recordClarification(
        PA,
        input({
          origin: "spec-kit",
          questionKey: "key-spec",
          analysisId: null,
          specKitFeature: "001-export",
          requirementIds: ["AC-1"],
          source: null,
        }),
      );
      expect(await storedIds(spec.record.id)).toEqual(["AC-1"]);
      expect(spec.record).toMatchObject({
        origin: "spec-kit",
        requirementIds: ["AC-1"],
        source: null,
      });
    });

    it("reads back only its own analysis's ids: pre-#2310 unqualified ones are its own, another analysis's are not", async () => {
      const { record } = await recordClarification(PA, input());
      await db.clarificationRecord.update({
        where: { id: record.id },
        data: {
          requirementIds: JSON.stringify(["R-0", `${A1}:R-1`, `${A2}:R-2`, "R-0", 7]),
        },
      });
      const read = (await findClarificationsById(PA, [record.id])).get(record.id)!;
      expect(read.requirementIds).toEqual(["R-0", "R-1"]);
    });

    it("reads a malformed list column as empty, and a source without document or file name without them", async () => {
      const { record } = await recordClarification(
        PA,
        input({ source: { headingPath: [], quote: "Passwords are long." } }),
      );
      expect(record.source).toEqual({ headingPath: [], quote: "Passwords are long." });
      expect(record.answeredById).toBeNull();
      for (const raw of ["not json", '{"a":1}', ""]) {
        await db.clarificationRecord.update({
          where: { id: record.id },
          data: { requirementIds: raw, productIds: raw, sourceHeadingPath: raw },
        });
        const read = (await findClarificationsById(PA, [record.id])).get(record.id)!;
        expect(read.requirementIds).toEqual([]);
        expect(read.productIds).toEqual([]);
        expect(read.source?.headingPath).toEqual([]);
      }
    });

    it("adds a reusing analysis's requirement once, qualified, and reports a missing record", async () => {
      const { record } = await recordClarification(PA, input());
      expect(await addClarificationRequirements(PA, record.id, A2, ["R-1"])).toBe(true);
      // `R-1` of A2 is not `R-1` of A1.
      expect(await storedIds(record.id)).toEqual([`${A1}:R-1`, `${A2}:R-1`]);
      const update = vi.spyOn(db.clarificationRecord, "updateMany");
      expect(await addClarificationRequirements(PA, record.id, A2, ["R-1"])).toBe(true);
      expect(update).not.toHaveBeenCalled();
      expect(await addClarificationRequirements(PA, "no-such-record", A2, ["R-1"])).toBe(false);
      expect(await addClarificationRequirements("another-project", record.id, A2, ["R-3"])).toBe(
        false,
      );
    });

    it("two reuses racing on one record each keep their id: the write is a compare-and-set", async () => {
      const { record } = await recordClarification(PA, input());
      const findFirst = db.clarificationRecord.findFirst.bind(db.clarificationRecord);
      // A3's reuse lands between A2's read and A2's write.
      vi.spyOn(db.clarificationRecord, "findFirst").mockImplementationOnce((async (
        args: Parameters<typeof findFirst>[0],
      ) => {
        const read = await findFirst(args);
        await db.clarificationRecord.update({
          where: { id: record.id },
          data: { requirementIds: JSON.stringify([`${A1}:R-1`, `${A3}:R-3`]) },
        });
        return read;
      }) as never);
      expect(await addClarificationRequirements(PA, record.id, A2, ["R-2"])).toBe(true);
      expect(await storedIds(record.id)).toEqual([`${A1}:R-1`, `${A3}:R-3`, `${A2}:R-2`]);
    });

    it("gives up, and says so, when the list keeps changing under it", async () => {
      const { record } = await recordClarification(PA, input());
      const findFirst = db.clarificationRecord.findFirst.bind(db.clarificationRecord);
      let n = 0;
      vi.spyOn(db.clarificationRecord, "findFirst").mockImplementation((async (
        args: Parameters<typeof findFirst>[0],
      ) => {
        const read = await findFirst(args);
        n += 1;
        await db.clarificationRecord.update({
          where: { id: record.id },
          data: { requirementIds: JSON.stringify([`${A1}:R-1`, `${A3}:R-${n}`]) },
        });
        return read;
      }) as never);
      expect(await addClarificationRequirements(PA, record.id, A2, ["R-2"])).toBe(false);
      expect(n).toBe(3);
      expect(await storedIds(record.id)).not.toContain(`${A2}:R-2`);
    });

    it("a create that loses the race to the same question updates the row the other one made", async () => {
      await recordClarification(PA, input({ answer: "At least 8 characters." }));
      // This submit read no row: the other one created it in between.
      vi.spyOn(db.clarificationRecord, "findUnique").mockResolvedValueOnce(null);
      const { record, changed } = await recordClarification(PA, input({ analysisId: A2 }));
      expect(changed).toBe(true);
      expect(record).toMatchObject({ answer: "At least 12 characters.", analysisId: A2 });
      expect(await db.clarificationRecord.count({ where: { projectId: PA } })).toBe(1);
    });

    it("a create that fails for another reason is not taken for a race", async () => {
      vi.spyOn(db.clarificationRecord, "create").mockRejectedValueOnce(new Error("disk full"));
      await expect(recordClarification(PA, input())).rejects.toThrow("disk full");
    });

    it("looks nothing up for no keys or ids", async () => {
      const findMany = vi.spyOn(db.clarificationRecord, "findMany");
      expect((await findSettledClarifications(PA, [])).size).toBe(0);
      expect((await findClarificationsById(PA, [])).size).toBe(0);
      expect(
        await reopenChangedSources(PA, [{ key: "k", question: { question: "Uncited?" } }]),
      ).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
    });

    it("reopens nothing when an edited paragraph reads equally like two answered ones", async () => {
      const slot = { ...SOURCE, quote: "alpha bravo charlie delta echo" };
      await recordClarification(
        PA,
        input({ questionKey: "k-x", source: { ...slot, quote: "alpha bravo charlie delta xray" } }),
      );
      await recordClarification(
        PA,
        input({
          questionKey: "k-y",
          source: { ...slot, quote: "alpha bravo charlie delta yankee" },
        }),
      );
      // An uncited record and one in another section are never candidates.
      await recordClarification(PA, input({ questionKey: "k-none", source: null }));
      await recordClarification(
        PA,
        input({ questionKey: "k-other", source: { ...slot, headingPath: ["9 Other"] } }),
      );
      const reopened = await reopenChangedSources(PA, [
        {
          key: "k-new",
          question: {
            question: "How long must a password be?",
            ambiguityField: "minimumLength",
            citation: { ...slot, quote: "alpha bravo charlie delta zulu" },
          },
        },
      ]);
      expect(reopened).toEqual([]);
      const statuses = await db.clarificationRecord.findMany({ select: { status: true } });
      expect(statuses.every((r) => r.status === "settled")).toBe(true);
    });
  },
);

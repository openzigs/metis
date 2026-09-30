import { describe, it, expect } from "vitest";
import { formatDocLabel } from "@/lib/doc-label";

describe("formatDocLabel", () => {
  it("reduces a connector:repo symbol to its basename + directory", () => {
    const raw =
      "connector:repo:cmexample0000000000acmerp:src/components/wmsCommon/wms-common-db/src/main/java/com/acme/wms/common/mybatis/inv/vo/CarrierWithdrawnVO.java";
    const label = formatDocLabel(raw, "repo");
    expect(label.kind).toBe("repo");
    expect(label.primary).toBe("CarrierWithdrawnVO.java");
    expect(label.secondary).toBe(
      "src/components/wmsCommon/wms-common-db/src/main/java/com/acme/wms/common/mybatis/inv/vo",
    );
    // The noisy connector prefix must not appear in the human label.
    expect(label.primary).not.toContain("connector:repo:");
    expect(label.secondary).not.toContain("connector:repo:");
  });

  it("handles a connector:repo path with no directory (bare file)", () => {
    const label = formatDocLabel("connector:repo:abc123:README.md", "repo");
    expect(label.kind).toBe("repo");
    expect(label.primary).toBe("README.md");
    expect(label.secondary).toBeUndefined();
  });

  it("labels generated docs with a friendly name + short id fragment", () => {
    const label = formatDocLabel("generated-doc-cmqpizckr017z8ewh2unm1418.md", "generated");
    expect(label.kind).toBe("generated");
    expect(label.primary).toBe("Generated document");
    expect(label.secondary).toBe("#nm1418");
  });

  it("leaves a normal uploaded filename untouched", () => {
    const name = "D100 - UC101 Regional Hubs WMS_OMS Data Exchange_v0.8.docx";
    const label = formatDocLabel(name, "upload");
    expect(label.kind).toBe("file");
    expect(label.primary).toBe(name);
    expect(label.secondary).toBeUndefined();
  });

  // #547 — an upload stored before #540 may carry a connector- or
  // generated-shaped name. Its source says it is a file.
  it.each(["connector:repo:abc123:src/a.ts", "generated-doc-cmqpizckr017z8ewh2unm1418.md"])(
    "labels an upload named %s as the file it is",
    (name) => {
      expect(formatDocLabel(name, "upload")).toEqual({ primary: name, kind: "file" });
    },
  );

  it("falls back to 'Untitled' for empty/whitespace names", () => {
    expect(formatDocLabel("", "upload").primary).toBe("Untitled");
    expect(formatDocLabel("   ", "upload").primary).toBe("Untitled");
  });
});

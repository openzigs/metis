import { describe, it, expect } from "vitest";
import { formatDocLabel } from "@/lib/doc-label";

describe("formatDocLabel", () => {
  it("reduces a connector:repo symbol to its basename + directory", () => {
    const raw =
      "connector:repo:cmexample0000000000acmerp:src/components/wmsCommon/wms-common-db/src/main/java/com/acme/wms/common/mybatis/inv/vo/CarrierWithdrawnVO.java";
    const label = formatDocLabel(raw);
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
    const label = formatDocLabel("connector:repo:abc123:README.md");
    expect(label.kind).toBe("repo");
    expect(label.primary).toBe("README.md");
    expect(label.secondary).toBeUndefined();
  });

  it("labels generated docs with a friendly name + short id fragment", () => {
    const label = formatDocLabel("generated-doc-cmqpizckr017z8ewh2unm1418.md");
    expect(label.kind).toBe("generated");
    expect(label.primary).toBe("Generated document");
    expect(label.secondary).toBe("#nm1418");
  });

  it("leaves a normal uploaded filename untouched", () => {
    const name = "D100 - UC101 Regional Hubs WMS_OMS Data Exchange_v0.8.docx";
    const label = formatDocLabel(name);
    expect(label.kind).toBe("file");
    expect(label.primary).toBe(name);
    expect(label.secondary).toBeUndefined();
  });

  it("falls back to 'Untitled' for empty/whitespace names", () => {
    expect(formatDocLabel("").primary).toBe("Untitled");
    expect(formatDocLabel("   ").primary).toBe("Untitled");
  });
});

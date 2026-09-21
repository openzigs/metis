/**
 * Tests for the bundled macOS sandbox-exec profile (Epic #395 #417).
 *
 * The profile itself is the security boundary — a too-permissive
 * `file-write*` rule defeats the entire local-dev sandbox. We assert
 * the file's content rather than attempting to spawn `sandbox-exec`
 * (which is macOS-only and requires a real working directory).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const profilePath = resolve(here, "../../../../src/lib/sandbox/local-dev/profiles/macos.sb");
const profile = readFileSync(profilePath, "utf8");

describe("macos.sb sandbox-exec profile", () => {
  it("starts from default-deny", () => {
    expect(profile).toMatch(/\(deny default\)/);
  });

  it('scopes file-write* to (param "SANDBOX_DIR") only', () => {
    // Find the (allow file-... file-write* ...) form. Must include SANDBOX_DIR.
    const writeBlockMatch = profile.match(/\(allow[^)]*file-write\*[\s\S]*?\)\)/);
    expect(writeBlockMatch).not.toBeNull();
    const writeBlock = writeBlockMatch?.[0] ?? "";
    expect(writeBlock).toContain('(param "SANDBOX_DIR")');
  });

  it("does NOT grant file-write* to /private/tmp (shared with all host processes)", () => {
    // We allow the sandbox-private SANDBOX_DIR plus a tiny set of /dev nodes.
    // /private/tmp must not appear anywhere in a write-allow form.
    const writeBlockMatch = profile.match(/\(allow[^)]*file-write\*[\s\S]*?\)\)/);
    expect(writeBlockMatch?.[0] ?? "").not.toContain("/private/tmp");
  });

  it("does NOT grant file-write* to /private/var/folders (shared tmp tree)", () => {
    const writeBlockMatch = profile.match(/\(allow[^)]*file-write\*[\s\S]*?\)\)/);
    expect(writeBlockMatch?.[0] ?? "").not.toContain("/private/var/folders");
  });
});

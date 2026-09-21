/**
 * A3 (#148) — verify the muted-foreground tokens meet WCAG 2.2 SC 1.4.3
 * (≥4.5:1 for normal text) against their theme backgrounds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(dirname, "../src/app/globals.css"), "utf8");

/** Parse `H S% L%` HSL triplets into [h, s, l]. */
function parseHsl(triplet: string): [number, number, number] {
  const m = triplet.trim().match(/([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) throw new Error(`bad hsl: ${triplet}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: string, bg: string): number {
  const l1 = relLuminance(hslToRgb(...parseHsl(fg)));
  const l2 = relLuminance(hslToRgb(...parseHsl(bg)));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull a token value from the first matching `:root` / `.dark` block. */
function token(block: string, name: string): string {
  const blockRe = new RegExp(`${block}\\s*\\{([\\s\\S]*?)\\}`);
  const body = css.match(blockRe)?.[1] ?? "";
  const m = body.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found in ${block}`);
  return m[1].trim();
}

describe("muted-foreground contrast (SC 1.4.3)", () => {
  it("light theme meets ≥4.5:1 against the background", () => {
    const ratio = contrast(token(":root", "muted-foreground"), token(":root", "background"));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("dark theme meets ≥4.5:1 against the background", () => {
    const ratio = contrast(token("\\.dark", "muted-foreground"), token("\\.dark", "background"));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * SC 1.4.11 Non-text Contrast (AA) — #660 (epic #658).
 *
 * User-interface component boundaries, state indicators, and meaningful
 * graphical objects must clear ≥3:1 against the adjacent surface they are drawn
 * on, in BOTH the light (`:root`) and dark (`.dark`) themes. Adjacent surfaces
 * per W3C G17 / Relative Luminance are the container tokens a boundary can be
 * painted over: `--background`, `--card`, and `--muted`.
 *
 * Non-text boundary/indicator tokens asserted here:
 *  - `--border` — the global component/divider boundary (`* { border-color }`)
 *    and the visible boundary of many interactive controls.
 *  - `--input`  — the form-control (text field / select / textarea) boundary;
 *    its edge is the sole visual cue that identifies the control.
 *  - `--ring`   — the keyboard focus indicator (SC 1.4.11 focus-state contrast).
 *
 * EXEMPT per SC 1.4.11 — deliberately NOT asserted:
 *  - Disabled / inactive components. The app dims these via opacity utilities
 *    (e.g. `disabled:opacity-50`) rather than a dedicated color token, and the
 *    SC exempts inactive components from the 3:1 requirement.
 *  - Purely decorative graphics.
 *  - Fill tokens whose legibility is governed by their paired `*-foreground`
 *    text/icon (an SC 1.4.3 text-vs-fill concern, checked elsewhere) rather than
 *    by a boundary against the page: `--primary`, `--secondary`, `--accent`,
 *    `--destructive`, `--muted`. These are surfaces that carry content on top,
 *    not boundaries, so fill-vs-page contrast is not a 1.4.11 requirement.
 */
const SURFACES = ["background", "card", "muted"] as const;
const NON_TEXT_BOUNDARY_TOKENS = ["border", "input", "ring"] as const;
const THEMES = [
  { name: "light", block: ":root" },
  { name: "dark", block: "\\.dark" },
] as const;

describe("non-text contrast (SC 1.4.11)", () => {
  for (const theme of THEMES) {
    for (const tk of NON_TEXT_BOUNDARY_TOKENS) {
      for (const surface of SURFACES) {
        it(`${theme.name}: --${tk} meets ≥3:1 against --${surface}`, () => {
          const ratio = contrast(token(theme.block, tk), token(theme.block, surface));
          expect(ratio).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }
});

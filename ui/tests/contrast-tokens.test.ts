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

/**
 * SC 1.4.3 Contrast (Minimum) — #266. The dark-only `text-zinc-*` / `bg-zinc-*`
 * surfaces on the Templates and Analysis screens were replaced with these
 * token pairs (text on the surfaces it is painted over). Each pair must clear
 * 4.5:1 in BOTH themes, so the migrated screens are legible whichever theme is
 * active. `bg-muted/NN` translucent panels sit between `--background` and
 * `--muted`, so checking both ends bounds every alpha in between.
 */
const TEXT_PAIRS = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["primary-foreground", "primary"],
] as const;

describe("migrated surface text contrast (SC 1.4.3, #266)", () => {
  for (const theme of THEMES) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${theme.name}: --${fg} meets ≥4.5:1 against --${bg}`, () => {
        const ratio = contrast(token(theme.block, fg), token(theme.block, bg));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/**
 * #267 — `--destructive` re-tuned. It is used both as TEXT (`text-destructive`,
 * 114 call sites) on the page surfaces and as a FILL under
 * `--destructive-foreground` (Button / Badge / AlertDialog action). Before the
 * change it measured 3.76:1 (light) and 1.99:1 (dark) as text.
 */
describe("destructive contrast (SC 1.4.3, #267)", () => {
  for (const theme of THEMES) {
    for (const surface of ["background", "card", "muted"] as const) {
      it(`${theme.name}: --destructive text meets ≥4.5:1 against --${surface}`, () => {
        expect(
          contrast(token(theme.block, "destructive"), token(theme.block, surface)),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${theme.name}: --destructive-foreground meets ≥4.5:1 on --destructive`, () => {
      expect(
        contrast(token(theme.block, "destructive-foreground"), token(theme.block, "destructive")),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/**
 * #267 — semantic status tokens. Each status has three tokens:
 *  - `--X`          text colour on the page surfaces AND on its own tint;
 *  - `--X-foreground` text on a solid `--X` fill;
 *  - `--X-muted`    the tint behind soft badges / alerts (`bg-X-muted text-X`).
 * `warning` includes the amber badges #285's review measured just under 4.5:1
 * in the light theme.
 */
const STATUSES = ["success", "warning", "info"] as const;

describe("status token contrast (SC 1.4.3, #267)", () => {
  for (const theme of THEMES) {
    for (const status of STATUSES) {
      for (const surface of ["background", "card", `${status}-muted`] as const) {
        it(`${theme.name}: --${status} meets ≥4.5:1 against --${surface}`, () => {
          expect(
            contrast(token(theme.block, status), token(theme.block, surface)),
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${theme.name}: --${status}-foreground meets ≥4.5:1 on --${status}`, () => {
        expect(
          contrast(token(theme.block, `${status}-foreground`), token(theme.block, status)),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/**
 * #267 — chart series tokens `--chart-1..5` (#301 added 6 and 7 for the
 * seven-category token breakdown). Series marks are meaningful graphics
 * (SC 1.4.11): each must clear ≥3:1 against the chart surface in both themes.
 * Seven DISTINCT colours are required, or two series read as one.
 */
const CHART_SERIES = 7;
const CHART_INDEXES = Array.from({ length: CHART_SERIES }, (_, i) => i + 1);

describe("chart token contrast (SC 1.4.11, #267)", () => {
  for (const theme of THEMES) {
    for (let i = 1; i <= CHART_SERIES; i += 1) {
      for (const surface of ["background", "card"] as const) {
        it(`${theme.name}: --chart-${i} meets ≥3:1 against --${surface}`, () => {
          expect(
            contrast(token(theme.block, `chart-${i}`), token(theme.block, surface)),
          ).toBeGreaterThanOrEqual(3);
        });
      }
    }
    // Avatar initials (PresenceAvatars, discussion-message-list) are
    // `text-background` on `bg-chart-N`: that is text, so SC 1.4.3's 4.5:1.
    for (let i = 1; i <= CHART_SERIES; i += 1) {
      it(`${theme.name}: --background text meets ≥4.5:1 on --chart-${i}`, () => {
        expect(
          contrast(token(theme.block, "background"), token(theme.block, `chart-${i}`)),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${theme.name}: the ${CHART_SERIES} chart colours are distinct`, () => {
      const values = CHART_INDEXES.map((i) => token(theme.block, `chart-${i}`));
      expect(new Set(values).size).toBe(CHART_SERIES);
    });
  }
});

/**
 * The tokens only reach utilities (`text-success`, `bg-warning-muted`, …)
 * through the `@theme inline` mapping; a token missing there generates no CSS
 * and the class silently does nothing.
 */
describe("status + chart tokens are exposed to Tailwind (#267)", () => {
  const theme = css.match(/@theme inline\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const names = [
    ...STATUSES.flatMap((s) => [s, `${s}-foreground`, `${s}-muted`]),
    ...CHART_INDEXES.map((i) => `chart-${i}`),
  ];
  for (const name of names) {
    it(`--color-${name} maps to hsl(var(--${name}))`, () => {
      expect(theme).toContain(`--color-${name}: hsl(var(--${name}));`);
    });
  }
});

/**
 * #267 — `--destructive` has no `-muted` tint: soft destructive badges and
 * rows use `bg-destructive/10` over the page (and the Alert uses `/5`). Check
 * the text against that composite, not against the bare page.
 */
function composite(fg: string, alpha: number, bg: string): [number, number, number] {
  const top = hslToRgb(...parseHsl(fg));
  const under = hslToRgb(...parseHsl(bg));
  return [0, 1, 2].map((i) => top[i] * alpha + under[i] * (1 - alpha)) as [number, number, number];
}

describe("destructive text on its translucent tint (SC 1.4.3, #267)", () => {
  for (const theme of THEMES) {
    for (const surface of ["background", "card"] as const) {
      it(`${theme.name}: --destructive on bg-destructive/10 over --${surface} meets ≥4.5:1`, () => {
        const text = relLuminance(hslToRgb(...parseHsl(token(theme.block, "destructive"))));
        const tint = relLuminance(
          composite(token(theme.block, "destructive"), 0.1, token(theme.block, surface)),
        );
        const [hi, lo] = text > tint ? [text, tint] : [tint, text];
        expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

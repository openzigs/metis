/**
 * Issue #104 — hidden / suspicious unicode character scanner.
 *
 * Catches the usual prompt-injection toolkit: zero-width chars, RTL/LTR
 * overrides, soft hyphen, BOM, and the broader `Cf` (format) class. The UI
 * surfaces these as inline `[ZWSP]` / `[RLO]` / etc. badges so a reviewer can
 * actually see the contents of an otherwise invisible payload before clicking
 * Approve.
 */
import type { MCPHiddenCharRange } from "@metis/shared";

interface Definition {
  code: number;
  label: string;
}

const KNOWN: Definition[] = [
  { code: 0x00ad, label: "SHY" }, // soft hyphen
  { code: 0x180e, label: "MVS" }, // mongolian vowel separator
  { code: 0x200b, label: "ZWSP" },
  { code: 0x200c, label: "ZWNJ" },
  { code: 0x200d, label: "ZWJ" },
  { code: 0x200e, label: "LRM" },
  { code: 0x200f, label: "RLM" },
  { code: 0x202a, label: "LRE" },
  { code: 0x202b, label: "RLE" },
  { code: 0x202c, label: "PDF" },
  { code: 0x202d, label: "LRO" },
  { code: 0x202e, label: "RLO" },
  { code: 0x2060, label: "WJ" },
  { code: 0x2061, label: "FA" },
  { code: 0x2062, label: "IT" },
  { code: 0x2063, label: "IS" },
  { code: 0x2064, label: "IP" },
  { code: 0x2066, label: "LRI" },
  { code: 0x2067, label: "RLI" },
  { code: 0x2068, label: "FSI" },
  { code: 0x2069, label: "PDI" },
  { code: 0xfeff, label: "BOM" },
];

const KNOWN_MAP = new Map<number, string>(KNOWN.map((d) => [d.code, d.label]));

/**
 * Returns the per-codepoint label for `codePoint` if it is suspicious.
 * Falls back to the broader `Cf` class for anything not in the curated map
 * (variation selectors, tag chars, etc.) so we don't miss novel injections.
 */
export function classifyHiddenChar(codePoint: number): string | null {
  const known = KNOWN_MAP.get(codePoint);
  if (known) return known;
  // U+FE00..U+FE0F variation selectors
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return "VS";
  // U+E0000..U+E007F language tag chars (deprecated, used in steganography)
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return "TAG";
  return null;
}

export function scanForHiddenChars(text: string): MCPHiddenCharRange[] {
  if (!text) return [];
  const ranges: MCPHiddenCharRange[] = [];
  let i = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const label = classifyHiddenChar(code);
    if (label) {
      ranges.push({ start: i, end: i + ch.length, code, label });
    }
    i += ch.length;
  }
  return ranges;
}

/** Compact summary suitable for log lines: "ZWSP=2,RLO=1". */
export function summarizeRanges(ranges: MCPHiddenCharRange[]): string {
  const counts = new Map<string, number>();
  for (const r of ranges) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/**
 * Render `text` with `[LABEL]` markers in place of every hidden char so a UI
 * (or a log line) can show "Hello[ZWSP]world".
 */
export function annotateHiddenChars(text: string): string {
  if (!text) return "";
  const ranges = scanForHiddenChars(text);
  if (ranges.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const r of ranges) {
    out += text.slice(cursor, r.start) + `[${r.label}]`;
    cursor = r.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * #1071 (PR #1104, review cycle 5) — one WIDE declaration reached through
 * every form Go has for naming a type, `count` times over.
 *
 * Cycle 4 bounded what the resolver keeps for a type that EMBEDS a wide struct
 * and for an interface that embeds another. The same copy was still made for a
 * defined type (`type T W`): 111 KB per type, a heap abort from 2.15 MB of Go.
 * A fix written for the reported form had missed the next form twice, so the
 * forms are enumerated here and each is measured: by the resolver's own count
 * of what it retains, and by the heap.
 *
 * Every tree here is Go that compiles (`go vet` at a small size, when the
 * shapes were written). Used by `go-resolver-type-forms.test.ts` and by the
 * out-of-process probes the PR reports.
 */
import type { GoTree } from "./go-verdicts.js";

/**
 * The forms a wide declaration is reached through. The first seven are the
 * type forms; then four compound shapes; then `defined-embedder`, a defined
 * type over a struct that is wide by what it EMBEDS (two hundred structs).
 */
export const GO_WIDE_SHAPES = [
  "embed",
  "defined",
  "alias",
  "pointer-defined",
  "generic",
  "interface-embed",
  "defined-interface",
  "diamond",
  "alias-chain",
  "generic-types",
  "test-view",
  "defined-embedder",
] as const;

export type GoWideShape = (typeof GO_WIDE_SHAPES)[number];

/** `type W struct { F func(); w0 int; … }` with `fields` fields besides `F`. */
function wideStruct(fields: number, header = "type W struct {"): string {
  let src = `${header}\n\tF func()\n`;
  for (let i = 0; i < fields; i += 1) src += `\tw${i} int\n`;
  return `${src}}\n\n`;
}

/** `type W interface { M0(); … }` with `methods` methods. */
function wideInterface(methods: number): string {
  let src = "type W interface {\n";
  for (let i = 0; i < methods; i += 1) src += `\tM${i}()\n`;
  return `${src}}\n\n`;
}

/** What each call of a shape resolves to, so that a probe measures binding and not refusal. */
export const GO_WIDE_SHAPE_VERDICT: Record<GoWideShape, string> = {
  embed: "unbound func-value",
  defined: "unbound func-value",
  alias: "unbound func-value",
  "pointer-defined": "unbound func-value",
  generic: "unbound func-value",
  "interface-embed": "unbound interface",
  // A defined type over an interface is not read as one: undecided, never a guess.
  "defined-interface": "unknown",
  diamond: "receiver-type p/p.go::L::OnlyL",
  // Mixed: twelve aliases are followed, the rest of the chain is undecided.
  "alias-chain": "unbound func-value",
  "generic-types": "unbound func-value",
  // Mixed: the calls of `p_test.go` to `Probe` bind; every `F` is a func value.
  "test-view": "unbound func-value",
  // The one-line type declares none of the two hundred embeddings it reaches:
  // it may keep sixty-four layer types, and is left undecided (`budget`).
  "defined-embedder": "unknown:budget",
};

/**
 * `count` types over one declaration `width` members wide, and one call
 * through each of them.
 */
export function goWideShape(shape: GoWideShape, count: number, width = 3_000): GoTree {
  let src = "package p\n\n";
  const each = (line: (i: number) => string): void => {
    for (let i = 0; i < count; i += 1) src += line(i);
  };
  switch (shape) {
    case "embed":
      src += wideStruct(width);
      each((i) => `type T${i} struct{ W }\n`);
      each((i) => `func f${i}(t T${i}) { t.F() }\n`);
      break;
    case "defined":
      src += wideStruct(width);
      each((i) => `type T${i} W\n`);
      each((i) => `func f${i}(t T${i}) { t.F() }\n`);
      break;
    case "alias":
      src += wideStruct(width);
      each((i) => `type T${i} = W\n`);
      each((i) => `func f${i}(t T${i}) { t.F() }\n`);
      break;
    case "pointer-defined":
      src += wideStruct(width);
      each((i) => `type T${i} W\n`);
      each((i) => `func f${i}(t *T${i}) { t.F() }\n`);
      break;
    case "generic":
      src += wideStruct(width, "type W[A any] struct {");
      each((i) => `type T${i} W[int]\n`);
      each((i) => `func f${i}(t T${i}) { t.F() }\n`);
      break;
    case "interface-embed":
      src += wideInterface(width);
      each((i) => `type I${i} interface {\n\tW\n\tX${i}()\n}\n`);
      each((i) => `func f${i}(v I${i}) { v.M0() }\n`);
      break;
    case "defined-interface":
      src += wideInterface(width);
      each((i) => `type T${i} W\n`);
      each((i) => `func f${i}(t T${i}) { t.M0() }\n`);
      break;
    case "diamond":
      // T<i> reaches the wide struct twice, through L and through R.
      src += wideStruct(width);
      src += "type Base struct{ W }\n\ntype L struct{ Base }\n\ntype R struct{ Base }\n\n";
      src += "func (L) OnlyL() {}\n\n";
      each((i) => `type T${i} struct {\n\tL\n\tR\n}\n`);
      each((i) => `func f${i}(t T${i}) { t.OnlyL() }\n`);
      break;
    case "alias-chain":
      src += wideStruct(width);
      each((i) => `type A${i} = ${i === 0 ? "W" : `A${i - 1}`}\n`);
      each((i) => `func f${i}(t A${i}) { t.F() }\n`);
      break;
    case "generic-types":
      src += wideStruct(width);
      each((i) => `type G${i}[A any] struct {\n\tW\n\tv A\n}\n`);
      each((i) => `func f${i}(g G${i}[int]) { g.F() }\n`);
      break;
    case "defined-embedder": {
      // W embeds `width / 15` structs of fourteen fields each: wide because it
      // says so. T<i> says nothing but `W`.
      const embedded = Math.max(1, Math.floor(width / 15));
      for (let j = 0; j < embedded; j += 1) {
        src += `type E${j} struct {\n`;
        if (j === 0) src += "\tF func()\n";
        for (let k = 0; k < 14; k += 1) src += `\te${j}_${k} int\n`;
        src += "}\n\n";
      }
      src += "type W struct {\n";
      for (let j = 0; j < embedded; j += 1) src += `\tE${j}\n`;
      src += "}\n\n";
      each((i) => `type T${i} W\n`);
      each((i) => `func f${i}(t T${i}) { t.F() }\n`);
      break;
    }
    case "test-view": {
      src += wideStruct(width);
      each((i) => `type T${i} W\n`);
      each((i) => `func f${i}(t T${i}) { t.F() }\n`);
      let test = "package p\n\n";
      for (let i = 0; i < count; i += 1) test += `func (t T${i}) Probe() {}\n`;
      for (let i = 0; i < count; i += 1) {
        test += `func probe${i}(t T${i}) {\n\tt.Probe()\n\tt.F()\n}\n`;
      }
      return { "p/p.go": src, "p/p_test.go": test };
    }
  }
  return { "p/p.go": src };
}

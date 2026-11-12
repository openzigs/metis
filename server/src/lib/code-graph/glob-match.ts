/**
 * #2327 — one bounded glob matcher for repository paths, shared by the symbol
 * search's `fileGlob` pre-filter (`hybrid-search.ts`) and `list_files`.
 *
 * Both used to compile the glob into a regular expression. That is fine for a
 * glob a developer writes; since #2327 a model writes it, and a pattern such as
 * `*a*a*a*a*a*a*a*a*b` compiled to `[^/]*a[^/]*a…` backtracks polynomially in
 * the number of stars on a long path. This matcher never backtracks: it walks
 * the path once per glob token, so a match costs O(tokens × path length) for
 * any pattern.
 *
 * Syntax, on `/`-separated repository-relative paths:
 *   - `*`   any run of characters within one segment (no `/`);
 *   - `?`   exactly one character other than `/`;
 *   - `**` followed by `/`: zero or more whole directories (so `src/`, `**`,
 *           `/a.ts` written together matches `src/a.ts` as well as `src/x/a.ts`);
 *   - `**`  anywhere else, any run of characters including `/` (`src/**`
 *           matches everything under `src/`);
 *   - every other character, `[`, `{` and `\` included, is literal.
 * The whole path must match. Case-sensitive, as the code graph is.
 */

type Token =
  | { kind: "lit"; ch: string }
  | { kind: "one" }
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "dirs" };

function tokenize(glob: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < glob.length;) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      let j = i + 2;
      while (glob[j] === "*") j++; // `***` is `**`
      if (glob[j] === "/") {
        tokens.push({ kind: "dirs" });
        i = j + 1;
      } else {
        tokens.push({ kind: "any" });
        i = j;
      }
    } else if (ch === "*") {
      tokens.push({ kind: "star" });
      i++;
    } else if (ch === "?") {
      tokens.push({ kind: "one" });
      i++;
    } else {
      tokens.push({ kind: "lit", ch });
      i++;
    }
  }
  return tokens;
}

/**
 * Compile `glob` into a predicate on repository-relative paths. Compile once
 * and reuse it across the paths of one search.
 */
export function compileGlob(glob: string): (filePath: string) => boolean {
  const tokens = tokenize(glob);
  return (s: string): boolean => {
    const n = s.length;
    // cur[j]: the tokens so far can consume exactly s[0..j).
    let cur = new Uint8Array(n + 1);
    cur[0] = 1;
    for (const t of tokens) {
      const next = new Uint8Array(n + 1);
      let any = false;
      switch (t.kind) {
        case "lit":
          for (let j = 0; j < n; j++) if (cur[j] && s[j] === t.ch) next[j + 1] = 1;
          break;
        case "one":
          for (let j = 0; j < n; j++) if (cur[j] && s[j] !== "/") next[j + 1] = 1;
          break;
        case "star":
          for (let j = 0; j <= n; j++) {
            if (cur[j] || (j > 0 && next[j - 1] && s[j - 1] !== "/")) next[j] = 1;
          }
          break;
        case "any":
          for (let j = 0; j <= n; j++) if (cur[j] || (j > 0 && next[j - 1])) next[j] = 1;
          break;
        case "dirs": {
          // Zero directories, or any run that ends at a `/`.
          let seen = false;
          for (let j = 0; j <= n; j++) {
            if (cur[j]) next[j] = 1;
            if (j > 0 && seen && s[j - 1] === "/") next[j] = 1;
            if (cur[j]) seen = true;
          }
          break;
        }
      }
      for (let j = 0; j <= n; j++) if (next[j]) any = true;
      if (!any) return false;
      cur = next;
    }
    return cur[n] === 1;
  };
}

/** One-shot form of {@link compileGlob}. */
export function matchRepoGlob(filePath: string, glob: string): boolean {
  return compileGlob(glob)(filePath);
}

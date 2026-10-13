/**
 * Issue #1072 — what a symbol's search documents know about it beyond its name.
 *
 * Until #1072 the BM25 document was `name + qualifiedName` and the embedding
 * text was a header line plus the first ten body lines. This module holds the
 * bounds of the fields #1072 adds. They were fixed in the pre-registration
 * commit, before any arm was scored, so a measured result could not move them
 * (`docs/decisions/0020-contextual-symbol-documents.md`).
 *
 * Two kinds of field, with different lifetimes:
 *
 *  - OWN-FILE fields (signature, doc comment, receiver, package) depend only on
 *    the file that declares the symbol. They change exactly when that file is
 *    re-parsed.
 *  - CROSS-FILE fields (callers, tables) depend on edges written by OTHER
 *    files. They change when a file that does not declare the symbol changes.
 */

/** Longest signature kept, in characters. A declaration longer than this is a parameter list, not a name. */
export const MAX_SIGNATURE_CHARS = 300;

/**
 * Longest doc comment kept, in characters. About 150 tokens: the summary
 * paragraph of a doc comment. BM25 normalises by document length, so an
 * unbounded comment would tax the symbol that is documented best.
 */
export const MAX_DOC_COMMENT_CHARS = 600;

/** Longest receiver (the type a method is declared on) kept, in characters. */
export const MAX_RECEIVER_CHARS = 120;

/** Longest package name kept, in characters. */
export const MAX_PACKAGE_CHARS = 120;

/**
 * N — the most caller names one symbol's documents carry.
 *
 * Five, because the field is there to say what a symbol is used FOR, and a
 * handful of distinct callers says that; a utility called from two hundred
 * places is described by none of them, and its document would otherwise be
 * two hundred names long and outrank nothing. Chosen before measuring and not
 * swept: a sweep over N on a 127-query corpus would be fitted to it.
 *
 * Which five is deterministic and independent of call counts: distinct caller
 * names in ascending code-unit order. Ordering by call frequency would reorder
 * the list — and so change the document — whenever an unrelated file gained a
 * call site.
 */
export const MAX_CONTEXT_CALLERS = 5;

/** The most table names one symbol's documents carry (distinct, ascending code-unit order). */
export const MAX_CONTEXT_TABLES = 8;

/** Longest single caller or table name kept, in characters. */
export const MAX_CONTEXT_NAME_CHARS = 80;

/** Most lines of a symbol's body a fused hit's snippet carries. */
export const MAX_SNIPPET_LINES = 10;

/** Most characters a fused hit's snippet carries. */
export const MAX_SNIPPET_CHARS = 800;

# docretrieval-03-analyst-docs — pre-registration (#2527)

Written and committed **before any query was authored**, as #1184 did for the wide corpus.
Nothing below may be changed after the sweep has run; a change after that point is a new
experiment and needs a new pre-registration.

## The question

Does `DEFAULT_RAG_CHUNK_SIZE` = 2048 (overlap 256) still hold on the documents a business
analyst actually uploads — BRDs, PRDs, FRDs and policies — with today's default embedder?
The evidence for 2048 (#1160, #1178, #1183, #1184) was measured only on METIS's own
engineering docs, and the wide corpus has been at 168 queries since publication, below the
~190 its size arms needed.

## The corpus

Fourteen documents, all synthetic or public, already committed under `eval-data/corpus/`.
Listed with their source in `sources.json`:

| documents | source | how the text is read |
|---|---|---|
| `brd-01` … `brd-06` | `<id>/source.md` | verbatim |
| `prd-01`, `prd-02` | `<id>/source.md` | verbatim |
| `docunderstanding-01` … `04` | `<id>/source.docx` | the production `parseDocument` Word conversion, which is what an analyst's upload gives |
| `governing-01`, `governing-02` | `<id>/policy-v2.md` | verbatim |

- The FRDs are read from `source.docx`, not `frd.src.md`: the `.src.md` carries `[[R…]]`
  label markers and an HTML comment holding the ambiguity labels, which no analyst's
  document contains.
- Only `policy-v2.md` of each governing set is included. `v1` and `v2` differ in four or five
  lines, so including both would give most queries two equally right answers in two
  documents.
- Every document's text is pinned by sha256 in `sources.json`. If a source or the Word
  conversion changes, loading fails rather than measuring a different corpus.

## The query count

- **Target: 220 queries. Floor: 200. Ceiling: 250** (`PRACTICAL_QUERY_CEILING`).
- Allocated roughly by document length:

| document | queries |
|---|---:|
| each `brd-0*` (6) | 2 each = 12 |
| each `prd-0*` (2) | 2 each = 4 |
| `governing-01-sample-policy` | 12 |
| `governing-02-clinic-records` | 18 |
| `docunderstanding-01-clinic-booking` | 30 |
| `docunderstanding-02-freight-claims` | 32 |
| `docunderstanding-03-community-grants` | 46 |
| `docunderstanding-04-library-lending` | 66 |
| **total** | **220** |

## Query rules (as `docretrieval-01` and `-02`)

- Each query names one verbatim, unique answer span of 60–320 characters in its document.
- Written as an analyst would ask it, from the capability, not by restating the span.
- Each is tagged `lexical` (reuses the span's distinctive terms) or `paraphrase` (asks for
  the same fact in other words). Aim for about half of each.
- Copy-discipline audits, asserted in `corpus.test.ts`:
  - longest contiguous word run shared with the span: **at most 8**, and **at most 10%** of
    queries at 5 or more;
  - IDF-weighted question coverage: the count at 0.60 or above is reported, and the
    `lexical` mean must exceed the `paraphrase` mean.

## The sweep

- `pnpm eval:doc-retrieval --corpus docretrieval-03-analyst-docs --extra-sizes 4096`.
- Size arms 768 / 1024 / 2048 (control) / 3072, plus 4096, all requesting overlap 256 (768
  is clamped to 192 by the chunker, as today). The overlap ladder at 2048 runs too, as it
  always does.
- Embedder: the default, `Alibaba-NLP/gte-modernbert-base` (768d, CLS-pooled, q8). The
  report records the identity it actually ran with.
- Reranker: the default, i.e. `RAG_RERANK` unset (off). Contextual chunks `off`.
- k = 10, nDCG@10 the headline, `all` the decision statistic.

## The decision rule (unchanged from #1160/#1184)

- Pre-registered minimum important delta: **+0.04 nDCG@10** over the 2048 control.
- `DEFAULT_RAG_CHUNK_SIZE` moves only if an arm is **MAGNITUDE-ESTABLISHED upward** on `all`:
  the bootstrap 95% paired CI's lower bound clears +0.04 and the sign test agrees (on
  disagreement the sign test wins).
- Otherwise 2048 stays, and the result is recorded as a **resolved** null for analyst
  documents if `queriesNeededForHalfWidth` at ±0.04 is at or below the queries run on every
  size arm, and as **unresolved** if not.
- Content coverage must stay at or above 99.8% at every arm, with no answer span dropped.

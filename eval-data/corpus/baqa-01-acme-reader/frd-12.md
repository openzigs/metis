# FRD-12: Expiring API keys and a reading-time filter

Functional requirements document for the Acme Reader product line: the Acme Reader server
(Miniflux) and the Acme Reader Python client. Written for the METIS question-answering
measurement (#2237); synthetic, CC0-1.0.

## Background

Analysts automate their reading lists with scripts that sign in with an API key. Today an API
key never expires, so a key copied into an old script keeps working for ever. Analysts also
want to pull only the articles they can read in a short break.

## FRD-12.1 API keys can expire

1. When an API key is created, the person creating it may give an expiry date. A key created
   without one never expires, as today.
2. Once its expiry date has passed, a key is refused exactly as an unknown key is refused.
3. The list of API keys shows each key's expiry date, or that it never expires.
4. A script using the Python client can set the expiry date when it creates a key.

Acceptance criteria:

- A key created with an expiry date of yesterday cannot be used to read entries.
- A key created without an expiry date can still be used a year later.
- The expiry date appears in the API keys list returned by the server.

## FRD-12.2 Entries can be filtered by reading time

1. The entries list can be limited to articles whose estimated reading time is at most a given
   number of minutes.
2. The filter combines with the existing status, category and feed filters.

Acceptance criteria:

- Asking for entries with a reading time of at most 5 minutes returns no entry whose reading
  time is 6 minutes or more.
- Leaving the filter out returns the same entries as today.

## Out of scope

Pricing, customer commitments and service levels are not part of this document.

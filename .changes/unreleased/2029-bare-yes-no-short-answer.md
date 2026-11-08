---
issue: 2029
section: Changed
---

- A business analyst's bare "Yes." or "No." can back a Compliant governing
  finding in the same way as a longer short answer such as "No, we do not.",
  when the finding quotes it with the end of the question it answers. Whether
  the answer meets the rule depends on how the question was worded, so METIS
  does not reject an answer because it is one word long. A tested decision now
  covers this, and a client that disconnects while METIS retries an unsettled
  answer still keeps the existing retry delay. This stays behind the
  `GOVERNING_DOCS_ENABLED` setting, which is off by default.

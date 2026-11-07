---
issue: 1875
section: Added
---

- A shared wording guard for governing-document findings, so METIS never says a
  requirement or system is "SOC 2 compliant", "GDPR certified", "fully
  compliant" or similar: SOC 2 is an attestation report, not a certification,
  and an LLM rule check is not an audit. It finds and rewrites such claims in
  model prose ("SOC 2 compliant" becomes "SOC 2-reviewed"), leaves neutral
  wording such as "SOC 2 control CC6.1" alone, and builds the summary sentence
  ("No gaps found against 12 of 40 applicable rules in Information Security
  Policy v3. Not an audit opinion."). The findings, panel and BRD section that
  use it follow in #1874, #1876 and #1877.

---
issue: 2105
section: Added
---

- `eval:governing`: a third, held-out set built from real, published text,
  `governing-03-openemr-hipaa`. Its 32 obligations are quoted word for word from the HIPAA
  Security Rule (45 CFR 164.312 and 164.308(a)(5), public domain) and NIST SP 800-63B-4
  (public domain), with each source's URL and retrieval date. Its 25 requirements are quoted
  from real OpenEMR issues, each with its issue URL; 8 of them touch nothing a rule covers.
  Two blind AI labellers, neither of them the agent that chose the requirements, agreed on
  16 of the 25 pairs either listed (0.64). A third pass settled the nine disagreements, and a
  per-rule consistency pass added nine pairs. No person has reviewed the labels. The loader
  now accepts a set of real text (`synthetic: false`) only when it names every source and
  each requirement's own URL. Such a set is not held to the synthetic sets' minimum of eight
  non-resembling items; this one has two.
- The Miniflux walkthrough has three real governing documents in `docs/walkthroughs/governing/`:
  NIST SP 800-63B-4 excerpts, and GitLab's Record Retention Policy and Security Compliance
  Controls (CC BY-SA 4.0, attributed to GitLab).

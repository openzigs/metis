---
issue: 2108
section: Fixed
---

- Governing checks on real policy text: a request written as a defect report is checked as the
  fix it asks for, a request for a rule's safeguard is more often **Compliant**, and a sign-in,
  password or logging request no longer draws most of the policy's rules on that subject. On
  the held-out real-text set precision went from 0.52 to 0.76, but recall fell from 0.80 to
  0.75, so governing checks stay marked **Preview**.
- `eval:governing`: a real-text tuning set (`governing-04-openemr-asvs`, OWASP ASVS 5.0.0 against
  OpenEMR issues), and A5 reports now say at which stage each error arose.

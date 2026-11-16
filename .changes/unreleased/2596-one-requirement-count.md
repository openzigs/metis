---
issue: 2596
section: Fixed
---

- A gated analysis now gives one consistent requirement count. The Outcome says how many
  requirements are listed for approval and how they relate to the summary's count, for example
  "the 8 the analysis wrote up and 10 non-functional requirements it found". Checkpoints says the
  same instead of "not the 8 the synthesis produced". "Documents read in full" counts requirement
  statements and says how many requirements the analysis made from them.
- On Checkpoints, a requirement the analysis added that restates one taken from the document is
  listed straight after it, with a note to approve one and reject the other if they say the same
  thing.
- A non-functional requirement the analysis found is no longer marked "No code link" when the
  findings it cites point at code. Before, every one was marked, although approving gave most of
  them code links.
- The Requirements tab lists the requirements awaiting approval, with Approve all, instead of
  only giving their number.

---
issue: 2068
section: Fixed
---

- Company-policy clarifying questions no longer lead to dead ends.
  - A **Needs BA input** finding that no answer could settle is no longer asked: one with only
    the general fallback question, one whose policy quote was dropped, and one you already
    accepted or rejected.
  - A finding that is still Needs BA input after your answer, with a new question, now gets
    that question. If the clarifying questions were already complete, they reopen with just
    that question the next time you open the Questions tab, as long as rounds are left.
  - Analyses whose clarifying questions were completed before the finding questions arrived
    (#2059) now reopen with them the same way, the next time you open their Questions tab.
    You no longer need to run them again. An analysis that used all three rounds still needs a
    new run.

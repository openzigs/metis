---
issue: 1245
section: Fixed
---

- Saving a scheduled job that someone else changed after you opened it is now refused (409) instead of silently undoing their change, such as a webhook rebind; the Scheduler page asks you to reopen the job. API clients may send `expectedVersion`; requests without it still work.

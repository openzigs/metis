---
issue: 2292
section: Fixed
---

- A project's monthly token budget now holds while a Word document's images are being described.
  Before, the images described at the same time could all pass the budget check, so up to three
  extra images per upload were sent after the budget was spent. An image description cut off at
  its 45-second limit now counts the tokens the provider had already billed. A Word heading or list
  item holding a very long run of spaces no longer takes seconds to convert.
- An image description's reply is capped at 4,096 tokens. An image that waits for budget room is
  no longer reported as "timed out" because an earlier image was slow.

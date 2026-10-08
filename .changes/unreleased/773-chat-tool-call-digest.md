---
issue: 773
section: Fixed
---

- Chat no longer retracts citations it had verified in an earlier turn. Each
  earlier answer is now sent back to the model with a short list of the tools
  it called in that turn (tool name and arguments, such as the file and line
  range it read), so a follow-up question no longer leads the assistant to
  claim it "had not actually read" files it did read. Tool results themselves
  are still not replayed.

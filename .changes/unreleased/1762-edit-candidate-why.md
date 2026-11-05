---
issue: 1762
section: Added
---

- The impact result now says why each file to edit was chosen, when one of the opt-in ways of
  choosing them is on (stored requirement links, the AI edit check, the AI ranking or the code
  agent). Each file shows what found it, and the files are listed most likely first. A file the
  AI named a checked line in shows the reason and a link to that line. A doubtful file stays
  listed, with a badge and the reason. When there is no file to edit, or only doubtful ones, the
  card says "METIS could not find the code this change touches" and names the project. With all
  of those options off, the card is unchanged.

---
issue: 1132
section: Fixed
---

- A document section the AI model could not finish now ends on its last complete sub-section, never on an empty heading or bare label; its note counts every missing topic, including the one cut partway.
- A published document with such a section offers **Regenerate unfinished sections**, which redrafts only those sections; the warning states the limit as answer and reasoning parts ("answer 16,384 + reasoning 32,768").

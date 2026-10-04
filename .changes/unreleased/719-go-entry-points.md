---
issue: 719
section: Fixed
---

- Code Overview lists a Go project's `func main` as an entry point. A root
  `main.go` matched none of the entry-point file patterns, so a Go project such
  as Miniflux reported "0 entry points".

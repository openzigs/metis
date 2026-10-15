---
issue: 1147
section: Added
---

- The METIS roadmap board (GitHub Projects, openzigs project 2) is kept up to
  date nightly by `.github/workflows/roadmap.yml`: open issues missing from the
  board are added, and Tier, Kind, Area, Progress % and Sub-issues done are set
  from each issue's labels and sub-issues; Area comes from the `area:` label, and
  a missing Area option is added. Status is never touched. Run it by hand with
  `node scripts/sync-roadmap.mjs --org openzigs --project 2 --dry-run`.

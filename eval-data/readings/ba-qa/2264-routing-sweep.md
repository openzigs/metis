# Routing multi-product chat (#2336), offline

Commit: e6676d504c9830856a4c4d0a1423c3b4952a0a3c

Router: probe k 8, floor 0.25, keep ratio 0.5. No model is called.

## Is the right project in the router's top k

| Scope | Answerable | Top 1 | Top 2 | Top 3 | Top 1, 2, 3 on signals alone (mentions ignored) | Routed (not fallen back) | Routed choice holds the answer | Mean projects searched | No-answer questions fallen back |
|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| 2 | 12 | 67% (8/12) | 100% (12/12) | 100% (12/12) | 58% (7/12), 100% (12/12), 100% (12/12) | 100% (12/12) | 100% (12/12) | 2.0 | 50% (1/2) |
| 5 | 15 | 73% (11/15) | 100% (15/15) | 100% (15/15) | 60% (9/15), 100% (15/15), 100% (15/15) | 100% (15/15) | 100% (15/15) | 2.5 | 50% (1/2) |
| 9 | 18 | 78% (14/18) | 94% (17/18) | 100% (18/18) | 67% (12/18), 94% (17/18), 100% (18/18) | 94% (17/18) | 100% (17/17) | 2.9 | 50% (1/2) |

## What reaches the prompt: search-all, ranked, routed, oracle

`ranked` merges every project's probe hits on cosine (a ranking counterfactual, #2264's ground); its time is the probe's and its block length counts excerpt text only.

| Scope | Mode | Questions | Projects searched | Searches failed | Excerpts from an answer product | Questions missing an answer product | Expected files retrieved | Mean ms | Max ms | Mean block chars |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | all | 12 | 2.0 | 0% (0/24) | 70% (67/96) | 0% (0/12) | 25% (8/32) | 63 | 70 | 11520 |
| 2 | ranked | 12 | 2.0 | 0% (0/24) | 71% (68/96) | 0% (0/12) | 25% (8/32) | 67 | 88 | 8874 |
| 2 | routed | 12 | 2.0 | 0% (0/24) | 70% (67/96) | 0% (0/12) | 25% (8/32) | 130 | 153 | 11520 |
| 2 | oracle | 12 | 1.3 | 0% (0/16) | 100% (96/96) | 0% (0/12) | 34% (11/32) | 51 | 69 | 12514 |
| 5 | all | 15 | 5.0 | 0% (0/75) | 66% (79/120) | 0% (0/15) | 25% (8/32) | 72 | 92 | 12094 |
| 5 | ranked | 15 | 5.0 | 0% (0/75) | 63% (76/120) | 0% (0/15) | 22% (7/32) | 74 | 104 | 8872 |
| 5 | routed | 15 | 2.5 | 0% (0/37) | 68% (82/120) | 0% (0/15) | 25% (8/32) | 131 | 176 | 11517 |
| 5 | oracle | 15 | 1.3 | 0% (0/19) | 100% (114/114) | 0% (0/15) | 34% (11/32) | 43 | 70 | 11622 |
| 9 | all | 18 | 9.0 | 0% (0/162) | 69% (100/144) | 0% (0/18) | 25% (8/32) | 77 | 98 | 12631 |
| 9 | ranked | 18 | 9.0 | 0% (0/162) | 68% (98/144) | 0% (0/18) | 22% (7/32) | 91 | 121 | 9231 |
| 9 | routed | 18 | 2.9 | 0% (0/52) | 74% (107/144) | 0% (0/18) | 25% (8/32) | 144 | 181 | 11503 |
| 9 | oracle | 18 | 1.2 | 0% (0/22) | 100% (138/138) | 0% (0/18) | 34% (11/32) | 40 | 87 | 11589 |

## Per question

| Scope | Question | Answer in | Ranked (profile/evidence) | Route | Chosen |
|---:|---|---|---|---|---|
| 2 | R1 | miniflux | *miniflux 0.50/0.81, python-client 0.38/0.81 | routed | 2 |
| 2 | R2 | miniflux | *miniflux 0.38/0.83, python-client 0.38/0.83 | routed | 2 |
| 2 | R3 | miniflux | *miniflux 0.40/0.66, python-client 0.30/0.66 | routed | 2 |
| 2 | R4 | miniflux | *miniflux 0.44/0.60, python-client 0.33/0.73 | routed | 2 |
| 2 | R5 | python-client | *python-client 0.83/1.00, miniflux 0.50/0.76 | routed | 2 |
| 2 | R6 | python-client | *python-client 0.75/1.00, miniflux 0.38/1.00 | routed | 2 |
| 2 | R7 | miniflux, python-client | *python-client 0.71/1.00, *miniflux 0.43/1.00 | routed | 2 |
| 2 | R8 | miniflux, python-client | *python-client 0.33/1.00, miniflux 0.11/1.00 | routed | 2 |
| 2 | R9 | miniflux, python-client | *python-client 0.36/0.83, miniflux 0.18/1.00 | routed | 2 |
| 2 | R10 | miniflux, python-client | miniflux 0.25/0.84, python-client 0.13/0.68 | routed | 2 |
| 2 | R17 | python-client | *python-client 0.57/1.00, miniflux 0.14/0.49 | routed | 2 |
| 2 | R18 | miniflux | *miniflux 0.67/1.00, python-client 0.44/1.00 | routed | 2 |
| 2 | R19 | - | miniflux 0.00/0.00, python-client 0.00/0.00 | fallback: no-evidence | 2 |
| 2 | R20 | - | miniflux 0.00/1.00, python-client 0.00/0.00 | routed | 1 |
| 5 | R1 | miniflux | *miniflux 0.50/0.65, python-client 0.38/0.65, library-lending 0.00/0.41, billing 0.00/0.15 | routed | 2 |
| 5 | R2 | miniflux | *miniflux 0.38/0.80, python-client 0.38/0.86, library-lending 0.00/0.66, billing 0.00/0.09 | routed | 3 |
| 5 | R3 | miniflux | *miniflux 0.40/0.49, python-client 0.30/0.51, library-lending 0.00/0.65, billing 0.00/0.08 | routed | 3 |
| 5 | R4 | miniflux | *miniflux 0.44/0.61, python-client 0.33/0.77, library-lending 0.00/0.49, billing 0.00/0.18 | routed | 2 |
| 5 | R5 | python-client | *python-client 0.83/1.00, miniflux 0.50/0.82, library-lending 0.00/0.32, billing 0.00/0.14 | routed | 2 |
| 5 | R6 | python-client | *python-client 0.75/1.00, miniflux 0.38/1.00, library-lending 0.00/0.36, billing 0.00/0.10 | routed | 2 |
| 5 | R7 | miniflux, python-client | *python-client 0.71/0.87, *miniflux 0.43/0.87, library-lending 0.00/0.36, billing 0.00/0.23 | routed | 4 |
| 5 | R8 | miniflux, python-client | *python-client 0.33/0.74, miniflux 0.11/0.74, library-lending 0.00/0.53, billing 0.00/0.17 | routed | 3 |
| 5 | R9 | miniflux, python-client | *python-client 0.36/0.75, miniflux 0.18/0.85, library-lending 0.00/0.25, billing 0.00/0.15 | routed | 2 |
| 5 | R10 | miniflux, python-client | miniflux 0.25/0.90, python-client 0.13/0.61, billing 0.00/0.61, notify 0.00/0.49 | routed | 3 |
| 5 | R11 | notify | notify 0.75/0.64, billing 0.50/0.64, library-lending 0.00/0.55, miniflux 0.00/0.20 | routed | 2 |
| 5 | R12 | billing | *billing 0.50/0.74, notify 0.33/0.47, miniflux 0.00/0.63, library-lending 0.00/0.37 | routed | 3 |
| 5 | R13 | library-lending | library-lending 0.33/1.00, miniflux 0.00/0.39, python-client 0.00/0.11, notify 0.00/0.00 | routed | 1 |
| 5 | R17 | python-client | *python-client 0.57/0.79, miniflux 0.14/0.38, library-lending 0.00/0.30, billing 0.00/0.09 | routed | 3 |
| 5 | R18 | miniflux | *miniflux 0.67/0.81, python-client 0.44/0.81, library-lending 0.00/0.49, billing 0.00/0.47 | routed | 2 |
| 5 | R19 | - | miniflux 0.00/0.00, python-client 0.00/0.00, library-lending 0.00/0.00, notify 0.00/0.00 | fallback: no-evidence | 5 |
| 5 | R20 | - | miniflux 0.00/1.00, python-client 0.00/0.00, library-lending 0.00/0.00, notify 0.00/0.00 | routed | 1 |
| 9 | R1 | miniflux | *miniflux 0.50/0.67, python-client 0.38/0.79, library-lending 0.00/0.37, clinic-booking 0.00/0.37 | routed | 2 |
| 9 | R2 | miniflux | *miniflux 0.38/0.79, python-client 0.38/0.89, library-lending 0.00/0.63, clinic-booking 0.00/0.30 | routed | 2 |
| 9 | R3 | miniflux | *miniflux 0.40/0.45, python-client 0.30/0.51, library-lending 0.00/0.49, clinic-booking 0.00/0.34 | routed | 3 |
| 9 | R4 | miniflux | *miniflux 0.44/0.57, python-client 0.33/0.82, clinic-booking 0.00/0.53, community-grants 0.00/0.53 | routed | 2 |
| 9 | R5 | python-client | *python-client 0.83/1.00, miniflux 0.50/0.86, library-lending 0.00/0.26, clinic-booking 0.00/0.26 | routed | 2 |
| 9 | R6 | python-client | *python-client 0.75/0.81, miniflux 0.38/0.81, community-grants 0.00/0.35, library-lending 0.00/0.25 | routed | 2 |
| 9 | R7 | miniflux, python-client | *python-client 0.71/0.91, *miniflux 0.43/0.91, library-lending 0.00/0.30, billing 0.00/0.19 | routed | 7 |
| 9 | R8 | miniflux, python-client | *python-client 0.33/0.83, miniflux 0.11/0.83, clinic-booking 0.00/0.47, library-lending 0.00/0.44 | routed | 3 |
| 9 | R9 | miniflux, python-client | *python-client 0.36/0.74, miniflux 0.18/0.81, clinic-booking 0.00/0.34, orders 0.09/0.21 | routed | 2 |
| 9 | R10 | miniflux, python-client | miniflux 0.25/0.87, orders 0.13/0.85, python-client 0.13/0.73, billing 0.00/0.73 | routed | 5 |
| 9 | R11 | notify | notify 0.75/0.73, billing 0.50/0.73, orders 0.00/0.73, freight-claims 0.00/0.73 | routed | 2 |
| 9 | R12 | billing | *billing 0.50/0.68, orders 0.17/0.68, notify 0.33/0.45, miniflux 0.00/0.65 | routed | 4 |
| 9 | R13 | library-lending | library-lending 0.33/1.00, miniflux 0.00/0.37, clinic-booking 0.00/0.37, freight-claims 0.00/0.37 | routed | 1 |
| 9 | R14 | clinic-booking | clinic-booking 0.50/1.00, library-lending 0.00/0.36, miniflux 0.00/0.23, community-grants 0.00/0.23 | routed | 1 |
| 9 | R15 | freight-claims | freight-claims 0.00/1.00, library-lending 0.00/0.61, clinic-booking 0.00/0.39, community-grants 0.00/0.39 | fallback: signals-disagree | 9 |
| 9 | R16 | community-grants | community-grants 0.50/1.00, miniflux 0.00/0.39, freight-claims 0.00/0.33, library-lending 0.00/0.22 | routed | 1 |
| 9 | R17 | python-client | *python-client 0.57/0.83, miniflux 0.14/0.44, library-lending 0.00/0.27, freight-claims 0.00/0.17 | routed | 2 |
| 9 | R18 | miniflux | *miniflux 0.67/0.84, python-client 0.44/0.84, orders 0.11/0.48, billing 0.00/0.48 | routed | 2 |
| 9 | R19 | - | miniflux 0.00/0.00, python-client 0.00/0.00, library-lending 0.00/0.00, notify 0.00/0.00 | fallback: no-evidence | 9 |
| 9 | R20 | - | miniflux 0.00/1.00, community-grants 0.00/0.43, python-client 0.00/0.00, library-lending 0.00/0.00 | routed | 1 |

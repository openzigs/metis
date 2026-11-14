# Relevance floor sweep (#2241): localization-01-miniflux-heldout, Alibaba-NLP/gte-modernbert-base

| Floor | Off-topic emptied | Unanswerable emptied | Answerable emptied | Ambiguous emptied | Expected excerpts kept | Excerpts dropped |
|---:|---:|---:|---:|---:|---:|---:|
| 0.450 | 0/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.460 | 0/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.470 | 0/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.480 | 0/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.490 | 1/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.500 | 1/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.510 | 1/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.520 | 1/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.530 | 1/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.540 | 2/6 | 0/0 | 0/24 | 0/0 | 33/33 | 0/192 |
| 0.550 | 3/6 | 0/0 | 0/24 | 0/0 | 33/33 | 1/192 |
| 0.560 | 3/6 | 0/0 | 0/24 | 0/0 | 33/33 | 6/192 |
| 0.570 | 6/6 | 0/0 | 0/24 | 0/0 | 32/33 | 8/192 |
| 0.580 | 6/6 | 0/0 | 0/24 | 0/0 | 29/33 | 19/192 |
| 0.590 | 6/6 | 0/0 | 0/24 | 0/0 | 28/33 | 25/192 |
| 0.600 | 6/6 | 0/0 | 1/24 | 0/0 | 27/33 | 43/192 |
| 0.610 | 6/6 | 0/0 | 2/24 | 0/0 | 25/33 | 57/192 |
| 0.620 | 6/6 | 0/0 | 5/24 | 0/0 | 22/33 | 75/192 |
| 0.630 | 6/6 | 0/0 | 7/24 | 0/0 | 19/33 | 89/192 |
| 0.640 | 6/6 | 0/0 | 8/24 | 0/0 | 18/33 | 102/192 |
| 0.650 | 6/6 | 0/0 | 12/24 | 0/0 | 14/33 | 130/192 |
| 0.660 | 6/6 | 0/0 | 13/24 | 0/0 | 12/33 | 140/192 |
| 0.670 | 6/6 | 0/0 | 17/24 | 0/0 | 7/33 | 160/192 |
| 0.680 | 6/6 | 0/0 | 20/24 | 0/0 | 4/33 | 174/192 |
| 0.690 | 6/6 | 0/0 | 20/24 | 0/0 | 2/33 | 180/192 |
| 0.700 | 6/6 | 0/0 | 21/24 | 0/0 | 2/33 | 182/192 |
| 0.710 | 6/6 | 0/0 | 21/24 | 0/0 | 1/33 | 186/192 |
| 0.720 | 6/6 | 0/0 | 21/24 | 0/0 | 1/33 | 186/192 |
| 0.730 | 6/6 | 0/0 | 22/24 | 0/0 | 1/33 | 188/192 |
| 0.740 | 6/6 | 0/0 | 22/24 | 0/0 | 1/33 | 188/192 |
| 0.750 | 6/6 | 0/0 | 23/24 | 0/0 | 0/33 | 191/192 |
| 0.760 | 6/6 | 0/0 | 24/24 | 0/0 | 0/33 | 192/192 |
| 0.770 | 6/6 | 0/0 | 24/24 | 0/0 | 0/33 | 192/192 |
| 0.780 | 6/6 | 0/0 | 24/24 | 0/0 | 0/33 | 192/192 |
| 0.790 | 6/6 | 0/0 | 24/24 | 0/0 | 0/33 | 192/192 |
| 0.800 | 6/6 | 0/0 | 24/24 | 0/0 | 0/33 | 192/192 |

Highest floor that empties no answerable question and keeps every expected excerpt: 0.56

Lowest expected-source excerpt: 0.564 (MF-4594, miniflux, `internal/cli/reset_password.go`)
Highest off-topic excerpt: 0.566 (P1, miniflux, `internal/reader/parser/testdata/no_encoding_ISO-8859-1.xml`)

| Question | Expect | Product | Top cosine | Lowest expected cosine | Expected hits |
|---|---|---|---:|---:|---:|
| MF-4483 | answer | miniflux | 0.667 | 0.613 | 1/8 |
| MF-4495 | answer | miniflux | 0.728 | - | 0/8 |
| MF-4500 | answer | miniflux | 0.668 | - | 0/8 |
| MF-4510 | answer | miniflux | 0.613 | 0.574 | 1/8 |
| MF-4516 | answer | miniflux | 0.696 | 0.632 | 3/8 |
| MF-4520 | answer | miniflux | 0.670 | 0.666 | 2/8 |
| MF-4525 | answer | miniflux | 0.668 | 0.609 | 6/8 |
| MF-4526 | answer | miniflux | 0.620 | - | 2/8 |
| MF-4554 | answer | miniflux | 0.636 | - | 0/8 |
| MF-4556 | answer | miniflux | 0.752 | 0.656 | 4/8 |
| MF-4557 | answer | miniflux | 0.641 | - | 0/8 |
| MF-4563 | answer | miniflux | 0.647 | - | 0/8 |
| MF-4566 | answer | miniflux | 0.607 | - | 0/8 |
| MF-4567 | answer | miniflux | 0.749 | 0.681 | 2/8 |
| MF-4572 | answer | miniflux | 0.644 | 0.641 | 2/8 |
| MF-4575 | answer | miniflux | 0.656 | 0.601 | 2/8 |
| MF-4579 | answer | miniflux | 0.627 | 0.570 | 4/8 |
| MF-4592 | answer | miniflux | 0.671 | - | 0/8 |
| MF-4594 | answer | miniflux | 0.597 | 0.564 | 1/8 |
| MF-4599 | answer | miniflux | 0.623 | - | 0/8 |
| MF-4605 | answer | miniflux | 0.649 | - | 0/8 |
| MF-4606 | answer | miniflux | 0.613 | - | 0/8 |
| MF-4608 | answer | miniflux | 0.673 | 0.630 | 2/8 |
| MF-4610 | answer | miniflux | 0.667 | 0.596 | 1/8 |
| P1 | off-topic | miniflux | 0.566 | - | 0/8 |
| P2 | off-topic | miniflux | 0.565 | - | 0/8 |
| P3 | off-topic | miniflux | 0.561 | - | 0/8 |
| P4 | off-topic | miniflux | 0.549 | - | 0/8 |
| P5 | off-topic | miniflux | 0.488 | - | 0/8 |
| P6 | off-topic | miniflux | 0.537 | - | 0/8 |

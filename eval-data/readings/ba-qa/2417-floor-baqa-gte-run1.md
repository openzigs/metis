# Relevance floor sweep (#2241)

| Floor | Off-topic emptied | Unanswerable emptied | Answerable emptied | Ambiguous emptied | Expected excerpts kept | Excerpts dropped |
|---:|---:|---:|---:|---:|---:|---:|
| 0.450 | 0/12 | 0/4 | 0/18 | 0/4 | 33/33 | 0/280 |
| 0.460 | 0/12 | 0/4 | 0/18 | 0/4 | 33/33 | 0/280 |
| 0.470 | 1/12 | 0/4 | 0/18 | 0/4 | 33/33 | 0/280 |
| 0.480 | 1/12 | 0/4 | 0/18 | 0/4 | 33/33 | 0/280 |
| 0.490 | 3/12 | 0/4 | 0/18 | 0/4 | 33/33 | 0/280 |
| 0.500 | 3/12 | 0/4 | 0/18 | 0/4 | 33/33 | 0/280 |
| 0.510 | 3/12 | 0/4 | 0/18 | 0/4 | 33/33 | 5/280 |
| 0.520 | 3/12 | 0/4 | 0/18 | 0/4 | 33/33 | 6/280 |
| 0.530 | 5/12 | 0/4 | 0/18 | 0/4 | 33/33 | 8/280 |
| 0.540 | 6/12 | 0/4 | 0/18 | 0/4 | 33/33 | 13/280 |
| 0.550 | 6/12 | 0/4 | 0/18 | 0/4 | 33/33 | 15/280 |
| 0.560 | 9/12 | 0/4 | 0/18 | 0/4 | 32/33 | 18/280 |
| 0.570 | 12/12 | 0/4 | 0/18 | 0/4 | 32/33 | 23/280 |
| 0.580 | 12/12 | 0/4 | 0/18 | 0/4 | 32/33 | 32/280 |
| 0.590 | 12/12 | 0/4 | 0/18 | 0/4 | 31/33 | 39/280 |
| 0.600 | 12/12 | 0/4 | 0/18 | 0/4 | 31/33 | 50/280 |
| 0.610 | 12/12 | 0/4 | 0/18 | 1/4 | 29/33 | 75/280 |
| 0.620 | 12/12 | 0/4 | 0/18 | 1/4 | 25/33 | 93/280 |
| 0.630 | 12/12 | 0/4 | 0/18 | 3/4 | 22/33 | 117/280 |
| 0.640 | 12/12 | 0/4 | 0/18 | 3/4 | 17/33 | 140/280 |
| 0.650 | 12/12 | 1/4 | 1/18 | 3/4 | 15/33 | 159/280 |
| 0.660 | 12/12 | 1/4 | 1/18 | 3/4 | 14/33 | 174/280 |
| 0.670 | 12/12 | 1/4 | 1/18 | 3/4 | 14/33 | 186/280 |
| 0.680 | 12/12 | 1/4 | 1/18 | 3/4 | 10/33 | 201/280 |
| 0.690 | 12/12 | 1/4 | 4/18 | 3/4 | 8/33 | 218/280 |
| 0.700 | 12/12 | 1/4 | 10/18 | 3/4 | 8/33 | 240/280 |
| 0.710 | 12/12 | 1/4 | 13/18 | 4/4 | 4/33 | 251/280 |
| 0.720 | 12/12 | 2/4 | 14/18 | 4/4 | 4/33 | 255/280 |
| 0.730 | 12/12 | 3/4 | 15/18 | 4/4 | 3/33 | 262/280 |
| 0.740 | 12/12 | 3/4 | 15/18 | 4/4 | 3/33 | 262/280 |
| 0.750 | 12/12 | 3/4 | 15/18 | 4/4 | 3/33 | 262/280 |

Highest floor that empties no answerable question and keeps every expected excerpt: 0.55

| Question | Expect | Product | Top cosine | Lowest expected cosine | Expected hits |
|---|---|---|---:|---:|---:|
| S1 | answer | miniflux | 0.700 | 0.645 | 1/8 |
| S2 | answer | miniflux | 0.682 | - | 1/8 |
| S3 | answer | miniflux | 0.712 | 0.677 | 1/8 |
| S4 | answer | miniflux | 0.691 | - | 0/8 |
| S5 | answer | python-client | 0.697 | 0.614 | 4/8 |
| S6 | answer | python-client | 0.709 | 0.634 | 4/8 |
| S7 | answer | miniflux | 0.645 | 0.619 | 1/8 |
| S8 | answer | miniflux | 0.684 | - | 1/8 |
| S9 | answer | miniflux | 0.720 | 0.618 | 2/8 |
| S10 | answer | miniflux | 0.709 | - | 0/8 |
| S11 | answer | miniflux | 0.682 | - | 0/8 |
| M1 | answer | miniflux | 0.819 | 0.635 | 4/8 |
| M1 | answer | python-client | 0.819 | 0.588 | 2/8 |
| M2 | answer | miniflux | 0.823 | - | 0/8 |
| M2 | answer | python-client | 0.823 | 0.560 | 1/8 |
| M3 | answer | miniflux | 0.843 | 0.705 | 3/8 |
| M3 | answer | python-client | 0.843 | 0.606 | 3/8 |
| M4 | answer | miniflux | 0.701 | 0.620 | 2/8 |
| M4 | answer | python-client | 0.677 | 0.617 | 2/8 |
| A1 | follow-up | miniflux | 0.668 | - | 0/8 |
| A1 | follow-up | python-client | 0.701 | - | 0/8 |
| A2 | follow-up | miniflux | 0.621 | - | 0/8 |
| A2 | follow-up | python-client | 0.609 | - | 0/8 |
| A3 | follow-up | miniflux | 0.609 | - | 0/8 |
| A4 | follow-up | miniflux | 0.622 | - | 0/8 |
| A4 | follow-up | python-client | 0.568 | - | 0/8 |
| U1 | abstain | miniflux | 0.644 | - | 0/8 |
| U1 | abstain | python-client | 0.640 | - | 0/8 |
| U2 | abstain | miniflux | 0.788 | - | 0/8 |
| U2 | abstain | python-client | 0.788 | - | 0/8 |
| U3 | abstain | miniflux | 0.729 | - | 0/8 |
| U4 | abstain | python-client | 0.714 | - | 0/8 |
| H1 | answer | miniflux | 0.692 | - | 0/8 |
| H2 | answer | miniflux | 0.696 | - | 0/8 |
| H3 | answer | miniflux | 0.695 | 0.677 | 1/8 |
| P1 | off-topic | miniflux | 0.566 | - | 0/8 |
| P1 | off-topic | python-client | 0.520 | - | 0/8 |
| P2 | off-topic | miniflux | 0.565 | - | 0/8 |
| P2 | off-topic | python-client | 0.527 | - | 0/8 |
| P3 | off-topic | miniflux | 0.561 | - | 0/8 |
| P3 | off-topic | python-client | 0.461 | - | 0/8 |
| P4 | off-topic | miniflux | 0.539 | - | 0/8 |
| P4 | off-topic | python-client | 0.552 | - | 0/8 |
| P5 | off-topic | miniflux | 0.488 | - | 0/8 |
| P5 | off-topic | python-client | 0.486 | - | 0/8 |
| P6 | off-topic | miniflux | 0.550 | - | 0/8 |
| P6 | off-topic | python-client | 0.550 | - | 0/8 |

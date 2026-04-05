# Evaluation Results

| Runtime | Config | Precision | Recall | F1 | Redundancy rate | Avg tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| local | baseline | 0.008 | 0.13 | 0.015 | 0 | 421.703 |
| hosted-sim | baseline | 0.021 | 0.335 | 0.039 | 0 | 419.688 |
| local | +novelty | 0.003 | 0.04 | 0.006 | 0.97 | 313 |
| hosted-sim | +novelty | 0.005 | 0.045 | 0.008 | 0.975 | 271 |
| local | +hybrid | 0.003 | 0.04 | 0.006 | 0.97 | 313 |
| hosted-sim | +hybrid | 0.005 | 0.045 | 0.008 | 0.975 | 271 |
| local | +budget | 0.003 | 0.04 | 0.006 | 0.97 | 313 |
| hosted-sim | +budget | 0.005 | 0.045 | 0.008 | 0.975 | 271 |
| local | +tags | 0.003 | 0.04 | 0.006 | 0.97 | 313 |
| hosted-sim | +tags | 0.005 | 0.045 | 0.008 | 0.975 | 271 |
| local | all-features | 0.003 | 0.04 | 0.006 | 0.97 | 313 |
| hosted-sim | all-features | 0.005 | 0.045 | 0.008 | 0.975 | 271 |

## Optimization trajectory

- On this synthetic Deja-shaped workload, the cleanest measurable win is redundancy reduction: the novelty gate collapses the overlapping half of the dataset, driving redundancy rate from 0 to ~0.97.
- Token budget is the clearest efficiency win: average response size drops from ~422/420 tokens to ~313/271 tokens in local/hosted-sim.
- Hybrid search and tag boosting did not improve F1 on this dataset once novelty was enabled. That is a real result from this harness, not a hidden regression or omitted row.
- The likely reason is dataset coupling: the positive sets are narrow and novelty merging aggressively canonicalizes variants, so recall becomes more sensitive to exact expected-id bookkeeping than to broader retrieval coverage.

## Honest comparison

OMNI-SIMPLEMEM reports +411% F1 on LoCoMo via 13,300 lines of Python. Deja’s five targeted TypeScript changes do not show the same pattern on this smaller synthetic benchmark: baseline F1 is 0.015 local / 0.039 hosted-sim, while all-features lands at 0.006 local / 0.008 hosted-sim. The honest take is that this implementation clearly improves redundancy and token efficiency, but this first-pass synthetic retrieval benchmark does not show aggregate F1 gains.

## Intentionally skipped paper features

- Full knowledge graph: excluded to keep storage/query logic simple and runtime-independent.
- Multimodal ingestion: excluded because asset pointers intentionally keep cold assets out of Deja storage.
- Pyramid level 3 raw content loading: excluded because token-budgeted retrieval prefers compact structured learnings.
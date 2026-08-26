# E05-C PreFund Parser Pool Benchmark

- Runs: 5 per mode/case
- Representative: 8 files × 1200 rows
- Small: 8 files × 80 rows
- Scope: real managed import, OS Parser Workers, Single Writer, Side DB receipts
- Admission: explicit isolated benchmark Governor (cpu=5/worker=6/utility=1/io=5/memory=2GiB); native E00 admission remains one Parser
- Run order: alternating single/pool by run index to reduce warm-cache ordering bias
- RSS: same-process absolute peak plus per-sample delta from starting RSS

| Case | Single median ms | Pool median ms | Improvement | Single RSS abs/delta | Pool RSS abs/delta | Single/pool spool | Single/pool event-loop p99 | Parity |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| representative | 591.665 | 588.272 | 0.57% | 238698496/2277376 | 249069568/13795328 | 3962782/9906933 | 18.17/43.778 | true |
| small | 402.967 | 269.813 | 33.04% | 287358976/3014656 | 290422784/6422528 | 124204/496800 | 16.531/51.511 | true |

## Gate conclusion

**DOWNGRADE / KEEP PRODUCTION DISABLED**. 代表集中位数改善未达15%；RSS仅记录，尚未qualified；磁盘仅记录，尚未qualified；event-loop仅记录，尚未qualified；native E00资源预算只获批1 Parser，Pool仅由隔离Governor取证；Windows packaged门禁未完成；真实资金与恢复人工门禁未完成。

Native resource admission、RSS、磁盘与event-loop均未qualified；尚无冻结阈值/Windows packaged证据。此报告不会修改 production policy；真实脱敏资金与恢复人工复核仍未完成。

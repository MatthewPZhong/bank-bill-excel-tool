# E05-C PreFund Parser Pool Benchmark

- Runs: 5 per mode/case
- Representative: 8 files × 1200 rows
- Small: 8 files × 80 rows
- Scope: real managed import, OS Parser Workers, Single Writer, Side DB receipts
- Run order: alternating single/pool by run index to reduce warm-cache ordering bias
- RSS: same-process absolute peak plus per-sample delta from starting RSS

| Case | Single median ms | Pool median ms | Improvement | Single RSS abs/delta | Pool RSS abs/delta | Single/pool spool | Single/pool event-loop p99 | Parity |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| representative | 584.378 | 583.695 | 0.12% | 247431168/2097152 | 269418496/18071552 | 3962782/9906933 | 15.524/47.022 | true |
| small | 391.265 | 265.027 | 32.26% | 295075840/2965504 | 298926080/6488064 | 124204/496796 | 15.581/44.335 | true |

## Gate conclusion

**DOWNGRADE / KEEP PRODUCTION DISABLED**. 代表集中位数改善未达15%；RSS仅记录，尚未qualified；磁盘仅记录，尚未qualified；event-loop仅记录，尚未qualified；Windows packaged门禁未完成；真实资金与恢复人工门禁未完成。

RSS、磁盘与event-loop在本机仅记录，尚无冻结阈值/Windows packaged证据，均为not qualified。此报告不会修改 production policy；真实脱敏资金与恢复人工复核仍未完成。

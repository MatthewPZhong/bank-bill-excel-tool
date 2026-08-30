# E07-C Duplicate Paired Parser Benchmark

- 命令：`NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules DUPLICATE_PAIRED_BENCH_ROWS=3000 DUPLICATE_PAIRED_BENCH_ITERATIONS=5 node scripts/benchmark-duplicate-paired-parser.js`
- 环境：darwin/arm64，Apple M4 Pro，Node v25.8.0。
- 样本：Bank 3000 行 + Document 3000 行；single 与 paired 每种 5 轮，按 iteration 交替先后并各有 warmup。
- 范围：真实 OS Parser Workers 的 parser-only 对比；single 为同两份输入顺序运行，paired 为两份输入并行运行。该证据不代表 Service 端到端、native production admission 或 Windows packaged 结果。

| 指标 | Single | Paired | 结论 |
| --- | ---: | ---: | --- |
| 中位耗时 | 531.251 ms | 317.776 ms | 改善 40.18%，超过冻结 15% 阈值 |
| paired 观测峰值 RSS | — | 507,150,336 bytes | 低于声明预算 838,860,800 bytes |

## Gate conclusion

本地 parser-only 性能/RSS gate 为 `PASS`，但 `productionEnabled=false` 保持不变。native E00 Governor 当前对该资源向量实际批准 1 个 Parser；Windows native 连续十轮/RSS、production ResourceGovernor 预算和真实脱敏资金/行数守恒人工复核均未完成，因此生产路径继续固定 legacy/single。

精确五轮样本见 [benchmark-evidence.json](./benchmark-evidence.json)。

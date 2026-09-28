# R15 finally 与 helper 跳转写入复核

结论：本项 8 个有限 synthetic fixtures 未发现新问题。current 为 4 个安全例零诊断、4 个有越权路径的例子被拒绝（3 例各 1 条、1 例涉及两处 factory 注入共 2 条 ARCH-RENDERER-SCOPE）。before/current 均无 scanError。每例分别在两侧用 Node VM 执行 flag=false/true，断言注入对象身份、字段和方法调用结果。

| 对照 | VM alias===注入对象 false/true | before/current 诊断数 |
| --- | --- | --- |
| finally 必经的两层 helper 写入 | false / false | 0 / 0 |
| 跳过 helper 写入后 finally 读取 | false / true | 0 / 1 |
| 内层 finally 必经的 helper 写入 | false / false | 0 / 0 |
| 内层 finally continue 跳过外层剩余写入 | false / true | 0 / 1 |
| outer helper 内跳过写入后 finally 读取 | false / true | 0 / 1 |
| helper 内循环 finally 必经写入 | false / false | 0 / 0 |
| 写入在跳转前，读取被同时跳过 | false / false | 0 / 0 |
| 读取发生在 finally 覆盖之前 | true / false | 2 / 2 |

最后一例两处 factory 是尝试路径和跳过路径各一处；静态诊断两处不是两个独立缺陷。此项仅判断该 unsafe fixture 应拒绝，不声称检查器已精确区分所有 return/路径相关性。三个 0→1 对照证明新检查沿 finally 与 helper 调用位置保留可能未执行写入的旧来源；四个安全对照未被误伤。

合同：G8 Spec AC-05（spec.md:101）；G8 TechDoc §4.4 最新 RR14 条款（techdoc.md:134）；architecture/README.md:147。跳转可能跳过写入但仍到达读取时保留来源；必经 finally 写入和同时跳过读写的路径保持精度。不扩展 throw、异常传播或完整 JavaScript 控制流。

HEAD 为 9a38b96b1b8006c5851535d0c1e586bbaeb63f10。before checker adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072，来自 2026-09-28-release-r14-repair/before。current checker eb2aae187b91f9e204eeacf97234ae6a4ebb277a9a0e9ce642cef556153c0e4d。四个共享工具、boundaries/allowlist 对应 manifest 哈希全部匹配；793 个 src/index.html 输入两侧相同，无 mismatch。逐项哈希见 r15-flow-verification.json。

所有运行工作目录：/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10。

实际执行入口：

```sh
node /tmp/r15-flow-compare.cjs r15-flow-probe.cjs minimal > /tmp/r15-flow-before-current.json 2> /tmp/r15-flow-before-current.log
node /tmp/r15-flow-verify.cjs > /tmp/r15-flow-verification.json
```

归档后的复跑入口：

```sh
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-flow-compare.cjs r15-flow-probe.cjs minimal > /tmp/r15-flow-replayed.json
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-flow-verify.cjs
```

compare 从同目录加载 probe/cases，自举 before 工具并核对冻结 manifest，不依赖旧 /tmp 工具目录；verify 校验归档的原始结果，归档后执行输出见 r15-flow-archive-replay.json。

已阅读新增 34 回归与本轮增量；本项没有运行这些正式测试或完整门禁。8 例使用实际 bank-statement 允许字段形成最小 pending 边界，未运行全部 20 active Renderer 配置；无新候选需要真实配置复现。没有修改源码、测试、配置或旧证据，仅新增本项 r15-flow 证据。

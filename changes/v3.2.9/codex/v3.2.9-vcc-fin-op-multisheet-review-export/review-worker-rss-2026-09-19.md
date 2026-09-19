# Worker RSS 合同修订独立审查（2026-09-19）

复审结论：本次 `host-process-rss-v1` 修复范围内未发现剩余可行动 P0/P1/P2。初版两项验证证据完整性 P2 均已复现、修复并通过定点反例验证。本结论不代表正式 Windows PF 或整版发布门禁通过。

审查基线为 `release/v3.2.9`、生产 HEAD `af58af73fc3a37a5d88d49b641e63359bec8f5e3` 加本次验证器/文档改动。审查期间没有修改生产文件、测试或 CI，没有重跑正式十万/百万样本或完整门禁；仅编写审查记录、保存证据及执行离线定点 probe。

## 合同与覆盖范围

依据 [Spec](v3.2.9_VCC_Spec.md) 与 [TechDoc §12.4.1](v3.2.9_VCC_TechDoc.md)：

- 保留 100,000 / 1,000,000 Pending、2 主体、12 充值、0 调整及 256 MiB；绝对峰值差和基线校正增长差同时判定，基线绝对差超过 32 MiB 为 NOT_RUN。
- 生产仍使用 `worker_threads`，同 PID 的宿主 RSS 只计一次；各线程 heap/external/arrayBuffers 为辅助指标。新口径不被声明为旧“独立 Worker RSS”的等价证明。
- 样本生成、导入和计算在独立 Electron 准备进程结束；测量进程读取固定文件摘要，完成固定模块/数据库准备后才启动采样。
- 独立 sampler 的首样本握手早于生产 Review IPC；Service 等待两个生产 Worker 的 exit 后发布、清理并返回，末样本和 sampler exit 完成后才执行额外独立回读。
- 原始 JSONL 采用固定块复算，核对序号、PID/线程、单调时钟、RSS、SHA、次数、峰值及窗口；正式 PF 至少 3 个样本，最大间隔 750 ms，缺证据不能 PASS。
- 比较元数据采用稳定的主体/币种/来源类型/版本/表头/分页结构，不把不同样本的输入 SHA 或记录 ID 要求成相同；资源 PASS 不升级其他 PF、Excel/WPS、安装版或整版验收状态。

## 两项前态 P2 及关闭证据

| 问题 | 初版复现 | 修复与复审结果 |
| --- | --- | --- |
| 实际执行代码没有重新绑定冻结身份 | config 与准备报告共同声明一个不等于磁盘 `performance-worker.js` 的合法 SHA，`loadPreparedFixture` 仍 ACCEPTED | runner 的 `currentProductionIdentity` / `verifyProductionIdentity` / `verifyVerificationScripts` 在准备和测量进程起止核验实际 HEAD、src/assets/package 身份及 7 个脚本原始字节；加载准备报告再次比对实际脚本。相同错误声明现在 REJECTED，合法声明仍 ACCEPTED |
| 配对 helper 接受缺失或非法准备文件身份 | 删除 `preparedFiles`，或仅给相对路径和非法 SHA，两个 PF01 记录均 PASS | helper `readPreparation` 校验原始准备报告普通文件及字节 SHA、case/run/build/PID/环境身份、固定 DB/WAL/SHM/XLSX 四项完整 schema，并绑定比较元数据；先证明新 schema 正例 PASS，再逐项缺失/篡改均 NOT_RUN |

[修复前结果](../../../../logs/verification/release-v3.2.9/rss-contract-v1/independent-review/probe-before.json)保留三项错误准入；[修复后 8 项独立 probe](../../../../logs/verification/release-v3.2.9/rss-contract-v1/independent-review/probe-after.json)全部符合预期。后者包括同时修改原始和复制文件清单、并刷新准备报告 SHA 的非法 DB SHA/相对路径，确认拒绝源于实际 schema 检查；不是因为测试缺少其他新字段而全部失败。

准备文件的逐字节核验发生在测量前；测量进程添加业务只读触发器会合法改变测试 DB，因此配对时重读并核验原始准备证据，不对测量后的 DB 强行重算原始摘要。Archive blob 由已摘要 DB 绑定其 SHA/大小，生产提取器在读取前后重新散列，未发现遗漏原件身份保护。

## 验证证据

独立执行环境为 Node `v24.13.0` / macOS。没有伪装实际 Windows 查询或正式 PF：

- [身份定点检查](../../../../logs/verification/release-v3.2.9/rss-contract-v1/independent-review/identity-after.log)：3/3 PASS，无 skip；覆盖实际脚本、实际 HEAD/产品状态及共同错误脚本声明。
- 上述离线 probe：8/8 PASS；先合法正例，再五项准备证据反例和一组脚本身份正负对照。执行前后所读取六文件 SHA 一致。
- 读取另一实施 Agent 的[最终 helper 测试日志](../../../../logs/verification/release-v3.2.9/rss-contract-v1/independent-review/source-helper-final.log)：112/112 PASS，0 FAIL/0 skip；审查者未重复该套测试。该 Agent 随后只增加测试，未改变已复核 helper。
- 读取根 Agent 的[最终四文件统一测试日志](../../../../logs/verification/release-v3.2.9/rss-contract-v1/focused-release.log)：189 项、188 PASS、0 FAIL、1 个 Windows 专用 skip；这不是完整发布门禁，审查者未重复执行。
- 读取根 Agent 的[最终真实 Electron 汇总](../../../../logs/verification/release-v3.2.9/rss-contract-v1/verification-summary.json)，并独立核对两个原始准备报告字节 SHA 及准备/测量的实际脚本和生产身份：smoke 准备 PID 53362 → 测量 PID 53419，19 Sheet / 40 行回读与清理 PASS；426.209 ms 只有首尾 2 样本，保留补充 smoke 身份，不充当 PF01。
- 最终 drain 10k：准备 PID 53623 → 测量 PID 53682，13 样本/11 周期，最大间隔 501.188 ms；真实 drain 取消耗时 98 ms、`forced=false`、游标退出与清理 PASS。原始 `sourceRows=12372`，取消后不继续消费。
- macOS 运行 windows mode：退出 2，未生成大型夹具，自动和验收状态均 NOT_RUN。

定点命令：

```bash
node --test --test-name-pattern='实际采集源码|实际Git构建|两份声明相同' tests/unit/scripts/vcc-review-performance-fixture-identity.test.js
node /private/tmp/v329-release-20260919-3_bafjvz/rss-contract-independent-review/probe-after.cjs
```

正式 Windows x64 / 16 GiB / 已证明 SSD 同卷的十万、百万配对没有在此次审查执行，`formalWindowsPf=NOT_RUN`；完整发布门禁、Excel/WPS 和安装版验收仍须各自证据，不由本次无剩余 P2 推导通过。

## 冻结身份

[完整复审清单](../../../../logs/verification/release-v3.2.9/rss-contract-v1/independent-review/final-review-manifest.json)保存当前 6 个代码/测试文件 SHA。关键值：

| 文件 | SHA256 |
| --- | --- |
| verify-review-performance.js | `6601314202a41eff4220a396820bb6a28ebecf1095545e5662e0988d8f503c25` |
| performance-memory-contract.js | `f18408528a8302c5ba9d6df9819794162ca9996893f36bf172d476f3b55cb2cf` |
| performance-rss-sampler.js | `9946d8fc8a5e3ff93ceb7bcee9e5f975aa92ef9a06bdec6e347eb16b5fcffa67` |
| performance-worker.js | `464e6e08bb343c6fcc34c7e28c88400b58e93f2810ee8da5a269ae0cd2898066` |
| 最终 memory-contract 测试 | `78f22585fb5c4be163e63ab26cff22bb062b9bbd758ddabe2a2be54a103bb738` |

修复前快照、原始 probe 及其旧哈希保留在同一证据目录；历史 NOT_RUN 未改写成 PASS。


## 最终本地门禁补记

Node 24.13.0 下 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 完整 PASS / exit 0：507 个单测文件、8104 项中 8100 PASS / 0 FAIL / 4 Windows 专用 SKIP；60 个集成脚本全部通过，59 个有计数脚本合计 2579/2579，另 1 个无计数。lint/smoke 通过，1542 份冻结的代码、依赖及验证输入核对未变。 [完整门禁摘要](../../../../logs/verification/release-v3.2.9/rows-admission-fix/verification-summary.json)保留输入及日志 SHA。新增脚本的独立 ESLint 通过。此结果覆盖本轮 RSS 和资源准入最终代码，不替代新候选的 Windows CI、正式 PF 或必要人工验收。

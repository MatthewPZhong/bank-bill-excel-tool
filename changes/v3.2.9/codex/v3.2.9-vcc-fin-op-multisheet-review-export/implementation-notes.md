# v3.2.9 Worker RSS 冲突处理记录

## Task Brief

- Goal：解决生产worker_threads与独立Worker RSS验收冲突，使指标可真实采集、缺证据不可通过。
- Context：基线af58af73；用户明确要求“你来做Worker RSS指标冲突”。
- Constraints：不改业务输出/生产Worker架构；保留100k/1m规模、256 MiB、Windows/SSD等条件；原报告不追认。
- Done when：TechDoc/Spec一致，独立采样与配对判定有反例测试，真实Electron小样本验证准备隔离与测量窗口，独立复审无P2。

## Decisions / Deviations

采用[TechDoc §12.4.1](v3.2.9_VCC_TechDoc.md)的host-process-rss-v1。改的是测量对象，不是把全进程RSS冒充Worker RSS。原独立RSS要求不可实现；生产子进程方案会扩大生命周期变更，未采用。新增32 MiB基线可比性限制和峰值/校正增长双256 MiB判据，防止起点偏差掩盖增长。

## Unknowns Register

| 未知 | 证据/处理 | 当前决定 |
|---|---|---|
| RSS是否可在线程间拆分 | PROBE：官方Node22.19定义、生产review Worker、Service factory均确认同PID | 无独立RSS，修订明确宿主合同 |
| 样本准备污染基线 | PROBE：旧runner在同一Electron进程先导入，再GC采样 | 分离准备进程并退出，再启动全新测量进程 |
| 同步阶段饿死采样 | PROBE：旧Main/Worker均用自身setInterval | 独立采样线程；真实阻塞回归；gap超限不通过 |
| 总RSS差掩盖增长 | PROBE：高小样本基线可抵消大样本增长 | 冷进程、32 MiB基线限制、双判据；不声称数学等价旧Worker口径 |
| 固定Windows性能是否达标 | BLOCK：当前宿主SSD证明缺失 | 仍须真实执行，冲突修复不代验收 |

## Evidence

生产基线为 `af58af73fc3a37a5d88d49b641e63359bec8f5e3`；本次仅修改采证脚本、测试、CI证据上传路径和文档，`src/`、`assets/`及package文件无差异。改动保留在release工作树，尚未提交或推送。

- Node `24.13.0`：四个专项测试文件189项，188 PASS、1 Windows专用SKIP、0 FAIL；7个相关JS文件ESLint通过，`git diff --check`通过。日志：[专项结果](../../../../logs/verification/release-v3.2.9/rss-contract-v1/focused-release.log)。
- Electron `36.9.5`真实小样本：独立准备PID53362退出0后，测量PID53419完成19 Sheet导出及独立回读，清理PASS。426.209ms、首尾2样本，仅是smoke，不能满足正式PF至少一个周期样本的要求。
- 真实10,000 Pending、输出停写且处于SheetStream drain等待时取消：PID53623准备、PID53682测量，98ms收口、未强制终止，游标返回且取消后不再读取，清理PASS；13样本/11周期，最大间隔501.188ms。
- 在当前macOS执行Windows模式，exit 2、NOT_RUN，无大型夹具生成。三次记录中的7脚本摘要与最终实现一致，原始RSS摘要、峰值、数量及准备进程记录的绑定另行复核。见[证据摘要](../../../../logs/verification/release-v3.2.9/rss-contract-v1/verification-summary.json)。
- 独立审查初版发现实际代码身份和准备文件证据两项P2，均已修复；新schema合法正例先PASS后，缺失/篡改证据被拒绝，8项定点probe通过。见[审查报告](review-worker-rss-2026-09-19.md)。

**未执行边界：** 固定Windows x64/16 GiB/SSD的十万/百万正式PF、Excel/WPS和安装版人工验收仍为NOT_RUN；本轮未重跑完整release-check或CI，不将此前af58完整门禁认作新采证脚本的整版验收。旧候选记录保持历史状态。

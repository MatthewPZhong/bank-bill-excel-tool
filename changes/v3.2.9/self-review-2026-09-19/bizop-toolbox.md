# v3.2.9 独立审查：BizOP 自动错误报告、工具箱按行拆分

审查日期：2026-09-19。结论：在本次只读范围内，未发现可复现的 P2 或更高等级缺陷。此结论不替代最终候选门禁或 Windows 人工验收。

## 审查范围与证据身份

- 快照：`/private/tmp/v329-release-20260919-3_bafjvz/review-snapshot`。
- Git HEAD：`6bd55efe0eb1d90c16cd92f3a78e54a39a36b966`，加主 Agent 建立的未提交覆盖层；本审查没有修改生产文件或用户业务数据。
- 依据：快照的 `AGENTS.md`、`CODEX.md`，两个功能的 Spec/TechDoc，以及按行拆分实施、审查修复记录。
- 重点读取：公开 IPC、renderer、BizOP 导入/自动报告/发布事实验证、rows 计划/缓存/Worker/结果复核、Main FilePlan/Publisher/Archive 交接及相关回归和组合集成。
- `source-evidence.json` 记录本轮读取的关键文件 SHA-256。本报告中的路径及行号均相对该快照。

## Requirement / evidence matrix

表中“代码及用例核对”只表示已审读实现和相应断言，不冒充本 Agent 重新运行了该用例。整仓动态结果由主 Agent 在最终候选上统一取得。

| 需求 | 当前实现证据 | 验证证据与结论 |
|---|---|---|
| BizOP FR-03 / AC-05、10–12：只用本次真实失败导入的可用诊断，不串历史报告、不制造空报告 | `biz-op-v327/ipc.js:93` 在真实 Task 身份回调捕获 taskRunId/reportRef；`auto-error-report.js:54` 校验 IMPORT intent、READY lifecycle、封存摘要、producer job/session 和 closed 保护；`:142` 排除完整精确空诊断 | `biz-op-v329-auto-report.test.js` 的身份错配、空诊断、截断/扫描不完整零样本用例；真实 XLSX 集成 `biz-op-auto-error-report.js:117,138,151,207,222,239`。未见绕过身份或误报空报告路径。 |
| BizOP FR-03：有真实错误时触发自动保存，同时保留原业务结果 | `import-main.js:115` 对行错误、文件错误、截断或扫描不完整整批拒绝；`ipc.js:105` 在失败导入后执行自动保存；报告字段只追加到原 result | 成功导入不触发自动报告与现有导入合同相符，不构成遗漏“成功但有坏行”的分支。原业务失败、报告 saved/failed/pending 分层有单元及真实集成断言。 |
| BizOP FR-04 / AC-06、07：本地日期、唯一文件名、无静默覆盖 | `auto-error-report.js:89` 固定本地日期及 UUID；FilePlan 冻结不存在目标，已有目标 EEXIST 拒绝 | 同秒独立任务、UUID 冲突、目录/权限失败用例；真实集成 `biz-op-auto-error-report.js:193`。 |
| BizOP FR-05、08 / AC-14、15：真实发布事实决定 saved，未决不重复导出 | `auto-error-report.js:111` 要求 COMMITTED、唯一输出路径及实际文件 SHA/size；`:154` 仅启动一次原 ERRORS Task，之后恢复和核验同一 Task；不切换新目标重试 | 单元覆盖发布前失败、发布后错误、Archive 未决；真实集成 `biz-op-auto-error-report.js:256,285`。既有恢复是同一发布任务的收尾；尚未开始的自动保存不承诺跨启动补调度。 |
| BizOP FR-07 / AC-07：重放不重复导入/保存，代际和恢复门禁不相互破坏 | `ipc.js:74` 先查同 sender/requestId 的摘要及 promise，后做新请求 admission；10 分钟、64 项有界缓存；销毁仅中止本 sender 请求 | `biz-op-v329-ipc.test.js:63,94,118,132,147,158` 核对恢复未就绪期间的在途/完成重放、同 ID 改参、陌生 sender/frame、新请求门禁及销毁信号。无跨启动去重承诺。 |
| BizOP FR-01、02、06：删 UI 入口但保留预提交取消和错误反馈 | `renderer-biz-op-v327.js:35,74,341` 合并业务与报告反馈，busy 防重复，状态读取故障单独追加；普通文件/日期/删除确认仍有取消路径 | `biz-op-v329-renderer.test.js:112–268` 包含入口不存在、焦点、busy、报告反馈、状态故障、原普通导出。现有 Electron DOM 脚本是正式 renderer 加 mock API，不等于系统对话框端到端。 |
| BizOP 退出与保留/删除联动 | `ipc.js:87` 用 registry 包住导入、恢复和自动保存全链路；报告沿原 ERRORS FilePlan/Archive，业务原件 INPUT hold 未放宽 | `biz-op-auto-error-report.js:322` 真实链路分阶段退出等待；`archive-biz-op-auto-report-retention.js:127,173,226` 覆盖导入/报告期限、未决批次阻删、INPUT hold、到期清理后外部 Documents 报告及原件 hash 不变。永久删除全模块内部协议另由主 Agent 的 Archive 专项审查覆盖，本报告只审这两个调用方的交接。 |
| Rows A07–A11、A22–A25：可信 R、合法 N、K 提前限流、精确范围和完整结果 | `contracts.js:45` 使用 BigInt 计算 K；`service.js:18` 在目录选择、路径数组及 Task 前校验；Main 保留可信 token/source snapshot | 本轮独立纯函数探针 PASS：7,031 组，3,509,509 个连续范围，19 个超限拒绝；完整 1000 项公开结果 167,088 B。仅证明算术/列表预算，不是实际 1000 个 XLSX 容量验收。 |
| Rows 覆盖确认、源/目标身份、父目录竞争 | `service.js:40` 在确认前冻结同一 FilePlan，确认后 freshness；`main.js:21128,21193` 原件别名保护并把 targetParentIdentity 传给 Publisher | `toolbox-row-split-overwrite.test.js` 覆盖确认中、prepare 后、生成后目标创建/替换；`toolbox-row-split-parent-identity.test.js:35` 走实际 Main execute 与 Worker Publisher。未发现重新采样扩大覆盖授权或遗漏父目录身份。 |
| Rows A12–A15、A26–A28：SPLIT 语义、样式与类型、单 writer、完整后发布 | `cache.js:32` 使用既有 SPLIT reader 和 typed codec，封存前验证 source SHA、全部行/样式；`executor.js:34` 串行 commit/validate/release；`service.js:63` 全部 K 清单、路径、size/hash 验证后才调用 Publisher | `toolbox-row-split.test.js` 覆盖跨隐藏 Sheet、重复表头、文本编号/日期/布尔/错误、CSV/BIFF、续 Sheet、延迟 commit、真实 Worker、缺失样式/缓存损坏。非 xlsx 的 reader 仍受 64 MiB 物化输入上限。 |
| Rows 预算与取消/生成失败 | `contracts.js:14` 明确单记录/样式/缓存/生成/临时/结果预算；`cache.js:85,93` 同步读取轮询取消；`executor.js:47` 回放周期让出事件循环；`service.js:113` 将 Publisher staging/旧目标备份计入临时预算 | `toolbox-row-split.test.js:208,274,286,298` 覆盖 writer/缓存/取消不发布、磁盘不足、源快照失效、物化输入超预算、真实 Worker shutdown。Supervisor 在返回结果前等待 transport 清理；未将成功生成误当成正式文件发布。 |
| Rows 发布失败/崩溃恢复与永久删除联动 | `main.js:20539–20644,21182` 复用持久 journal Publisher；已发布但 Archive 未完成返回 pendingArchiveHandoff；原 owner terminal 后 ACK | `toolbox-row-split.test.js:321,354` 覆盖第 2 项发布中断后 journal 恢复、完整归档后清 receipt；`toolbox-row-split-archive-delete.js:123–200` 实际 Main/Worker/Archive，原 owner ACK 前阻删，重开数据库后真实受管文件删除，而原件及正式输出 SHA/行数据保持。 |

## 本轮实测

运行：

```text
/Users/pzhong/.nvm/versions/node/v24.13.0/bin/node rows-integer-probe.js <snapshot>
```

退出码 0。结果保存在 `rows-integer-probe.json`，可复跑源码为 `rows-integer-probe.js`。探针只使用合成路径和纯函数；没有生成工作簿、修改源文件、创建业务数据库或执行发布。

本 Agent 未重复执行根 Agent 负责的 `release-check`，也没有把历史功能分支的门禁状态改记为当前候选 PASS。

## 未完成验收与结论边界

- BizOP Spec AC-05/08/09 明确要求真实报告在 Windows Excel 或 WPS 打开检查；本次审查没有该人工环境证据。
- Rows A33 的 Windows Excel/WPS 打开、样式、文件名、覆盖检查，以及真实业务 Main 系统对话框全流程、Windows/网络卷锁文件和断电恢复，本轮未执行。
- Rows 已有实施记录保留本机两列样本 K=1/8/9/999/1000 的真实生成与发布结果；不能把该历史样本或本轮整数探针扩大为宽表、极端样式、网络卷的容量承诺。
- 本审查无需要交付的 P2+ finding；后续若修改本次读取的生产文件、全门禁出现新失败或用户提出新合同，应重新核对受影响范围。


> 本报告保留审查快照时的结论。后续文档修复及最终组合验证以 [总审查](../release-review-2026-09-19.md) 和 [发布记录](../release.md) 为准。

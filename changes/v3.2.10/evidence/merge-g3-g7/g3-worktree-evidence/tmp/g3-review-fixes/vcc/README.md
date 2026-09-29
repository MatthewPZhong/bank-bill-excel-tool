# R01 VCC OP 来源绑定修复证据

范围：`codex/v3.2.10-renderer-boundaries`，工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries`，HEAD `11086a3cbf632a30adbcfa796e4cd81810c5aef9`。本次仅修改 `src/renderer/controllers/vcc-op-calc.js`、新增 `tests/unit/renderer/vcc-op-calc-source-binding.test.js` 和本目录证据。原审查报告及原探针保持原样；未提交、推送、开 PR、集成或升版。

依据：G3 Spec §4、G3-AC-09/13，TechDoc §4/R4.4。已读 `reconciliation-blindspot-pass` Skill 及 `references/reconciliation-risk-checklist.md`，重点检查来源、账期、期初、后台结算与落库血缘。

## 实现与边界

- 每次实际发送 scan 前同步撤销旧 `scanned/yearMonth/totals` 和保存资格。来源由本次 scan 的私有对象标识；来源操作锁跨导航保留，将 picker/scan/compute/source-check/save 串行化。它不阻止没有忙碌弹窗的后台扫描离页。
- F1 只能确认当前 scan；F2 绑定同一已确认来源对象与自己的 handle。重扫同文件同金额也创建新的来源对象，旧 F2 的回调无权保存。新扫描在 F1 取消、扫描取消/失败/整批拒绝后均不能复活旧保存资格。
- picker 取消尚未修改 Main，保留既有已确认来源；其后仍可重新打开 F2。扫描已成功但离页导致 F1 未获确认时，记录“读取完成、尚未确认”，返回后要求重新导入确认，不恢复旧 F2。
- 后台已确认 compute 与已提交 save 无论页面是否离开都结算本域事实。旧页面代次不写 DOM；如已经返回本域，则由当前访问再读 Main 后恢复按钮和反馈。保存成功清 ready，失败/取消保留实际结算反馈；没有自动重试业务写。
- 进入模块、打开 F2 和发送 save 前，以既有 computeAmounts 返回的账期、完整 totals 与逐文件 metadata 核对当前已确认事实。F1 还核对本次所选文件名、文件数及行数（返回 perFile 时）。发生变化或读取失败即撤销旧 ready、要求重新导入。
- 保存仍只传 `{beginOp}`，保留输入金额字符串；Main 的整数分计算、原子落库及 receipt 规则未改。F2 通过可选 `options.canClose` 接收控制器的来源操作锁，由实际工厂与本地 computing 状态合并；控制器不再第二次 registerModal 覆盖工厂协议。核对/保存期间拒绝导航、替换与关闭；最终销毁仅阻止尚未发送的 save，已发出的 save 继续返回真实结果。

本项没有修改 Main、session、数据库 schema、repository 或公共 IPC。manifest 核对 Main/session/save-contract/schema/repository 当前与 HEAD 无差异。preload 在整批 G3 中已有其他改动，本项没有修改。

## 来源合同调查

当前生产 Main 只有两个调用会改变 VCC compute snapshot：`vccOpCalc:import:scan` 调用 `streamScanAndCompute`（扫描开始先清旧值，成功采用新值），`vccOpCalc:run:save` 调用 `saveRun`（成功后清当前 snapshot）。旧内部 `scanFiles/computeFiles/clearCache/parserPipelineScanAndCompute` 在本次生产 Main 中没有调用入口。

`vccOpCalc:run:compute-amounts` 读取 `getComputeCache()`，返回 `yearMonth/totals/perFile`，不替换 snapshot；它是 tracked IPC，会产生 Task 与活动日志。因此本次增加的事实核对仍有这些记录副作用，不能称为完全无副作用的 getter。

公共 DTO 没有 scanId、源路径或字节内容 hash。`snapshotKey` 仅比较现有事实，不能证明不同字节但相同摘要的文件身份。生产来源一致性主要依赖本域唯一装配、每次 scan 私有身份、sourceOperation 串行化和 F2 handle 绑定；perFile 核对仅补充可见漂移检测。本次没有扩展到其他窗口/外部 IPC 写入者，也没有把 Renderer 金额传回覆盖 Main 的事实。

## 实际验证

所有测试数据均为本地生成 XLSX，真实 streaming reader 与 VCC session，SQLite `:memory:`；每例退出关闭 DB 并删除自己创建的 XLSX 目录。未访问真实财务数据或产品数据库。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 修前原审查真实探针 | 显示 A `2026-07 / 10.00`，实际存 B `2026-08 / 900.00`，期初 `100.00`、期末 `1000.00` | `before-real-probe.log` |
| 新用例在修前源码备份执行的 18 项可完成反例 | 3 PASS、15 FAIL；失败断言证明旧 ready/F2/后台反馈问题 | `before-selected-regressions.log` |
| 修后专项 25 项 + 原有领域控制器 33 项（含 F2 canClose 组合收口后复跑） | 58/58 PASS，0 skipped | `after-focused.log` |
| 两个文件 `node --check` | PASS | `checks.json` |
| 当前工作树 `git diff --check` | PASS | `checks.json` |
| 变更快照 | 修前/修后 controller、新测试、原探针 hash | `manifest.json`、`controller.diff` |

专项覆盖：A/B/A 扫描等待与提前返回，F1 确认/取消/导航取消，picker 取消，扫描成功/失败/取消/整批拒绝，F2 打开后的失败重扫，同文件同金额重扫，同账期同金额不同文件，F1 统计前来源变化，重入与 F2 提交前 Main 核对，已确认统计的后台成功/失败/取消，save 前销毁与 save 已提交后的导航/最终销毁，busy 根替换和重复提交，真实期初校验失败后重试、负数期初，多文件逐文件血缘、run/files/receipt 一致。

修后 R01 正向样例：新扫描 B 未确认时 Run 禁用且没有写入。重新确认 B 后 F2 显示 `2026-08 / 900.00`，输入 `100.00`，落库 `year_month=2026-08, begin_op=100.00, total_amount=900.00, end_op=1000.00`；逐文件表仅 B.xlsx；receipt 的 `compute_snapshot_hash` 等于保存前真实 Main cache 经现有 `hashVccOpComputeSnapshot` 得到的值。

复跑命令（每次显式在上述 worktree 执行）：

```sh
node --test tests/unit/renderer/vcc-op-calc-source-binding.test.js tests/unit/renderer/r4-domain-controllers.test.js
```

修前用例利用测试专用 `VCC_OP_CALC_CONTROLLER_PATH` 指向 `tmp/g3-review-fixes/before/src/renderer/controllers/vcc-op-calc.js`，没有修改或覆盖现有源码。曾尝试完整修前新测试，在等待新增“保存前核对”调用的用例中停止，因为旧实现没有该调用；该轮不计验证结果，已清理该轮临时文件，改为上表明确列出的 18 项。

## 专项风险检查与验收限制

| 风险场景 | 当前证据与处置 | 剩余未知 / 人工点 |
| --- | --- | --- |
| 旧确认月份和新扫描数据错位，期初落到错误账期 | 修前真实 SQLite 复现；修后源对象/锁/handle 绑定及 25 项回归，自动修复完成 | GUI 中人工核对 F1、F2、期初、Main cache、run/files/receipt 一致 |
| 同账期同金额不同来源被当作同一来源 | 本域重扫即使同文件同金额也失效旧 handle；不同文件 perFile 漂移被拒绝 | DTO 无公开不可变 scanId；摘要相同不能代表字节身份。未验证额外窗口或绕过本域的并发 IPC writer |
| 离页使已提交写被误认取消或允许第二次写 | 真实 session 已写后延迟回包，导航/销毁后仍返回成功且只有 1 条 run；失败/取消反馈保留，无自动重试 | 真实 TaskLifecycle 中断、进程退出、COMMIT 后传输不确定恢复未在本次重跑；沿用既有 Main receipt/恢复合同 |
| 金额/方向/期初变形 | 保存参数原样仅 beginOp；真实后端校验字符串、负数、多文件、run/files/receipt 一致；算法及 schema 无差异 | 本次没有重新审定混币种全量合并等既有业务口径，没有使用真实金融样本 |
| 事实重读产生额外 Task/日志 | 已从真实 Main 确认 computeAmounts 不改 snapshot，但会创建 tracked 记录 | 产品 Main 中 Task 展示和活动日志数量需 GUI 验收，不能用替代 API 测试冒充 |

**⚠️ 资金红线，请人工复核。** 本项修复了已复现的自动化来源错位，尚不能声称财务安全验收完成。人工需核对流水文件与账期、F1/F2 所示统计、期初原值、Main snapshot、落库月份/金额/逐文件明细/receipt，尤其重复导入、离页返回和保存结果未知后的恢复。

状态分离：实现完成并通过上述专项验证；整批 G3 集成门禁由主 Agent 统一执行。本项未运行完整 release-check、真实产品 Main、正式 F1/F2 Electron 组合、Windows、Excel/WPS 或安装包验收。DOM 测试使用真实 host/bridge 和记录型 F1/F2 工厂，不能替代真实产品 GUI。

最后组合收口：控制器与记录型工厂已切换为 `options.canClose` 注入；上述 58 项已在这个最终版本复跑通过，manifest、controller.diff、checks.json 均更新。真实 F2 工厂的本地 busy、最终销毁后 DOM 更新保护由并行 modal_host Agent 维护；实际 root F1/F2 组合用例由主 Agent 验证，其结果不计入本记录的 58 项。

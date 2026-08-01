# v3.1.4 Implementation Notes

## Decisions

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D1 | 白名单分类由共享纯函数提供，preflight 与 apply 必须逐行复算并比对 sealed ledger | 防止预检与写库语义漂移 | active |
| D2 | 正常记录仍以 `source_type + row_hash` 为技术身份；过滤记录不进入 source/link 表 | 保持 3.1.3 已证明的数据身份与匹配候选集合 | active |
| D3 | 异常报告在 apply grant 前生成、哈希并写入 ledger manifest | 报告证据不完整时禁止数据库提交 | active |
| D4 | 过滤业务键碰撞时保留正常文件，拒绝所有携带该过滤键的文件 | 满足不删除合法记录并消除文件顺序影响 | active |
| D5 | 报告引用使用 operation key + artifact key + SHA-256 + size；artifact 数字 ID 不是提交前置字段 | archive artifact 在业务提交后才产生 | active |
| D6 | 运行只冻结目标月份、必要来源内的活动墓碑；过滤导出不修改普通 `exported_at` | 保持确认门禁和运行范围语义 | active |
| D7 | `position_run_filtered_sources` 使用完整性哈希绑定运行 ID、墓碑 ID、墓碑审计字段、报告引用和 source revision | 防止关联或墓碑内容被误改后静默导出同报告中的另一条过滤记录 | active |
| D8 | 链接表管理的可删除月份取正常来源月份与活动过滤月份并集，0 行原始表也可按范围解除墓碑 | 避免全量过滤来源形成无法从 UI 清理的永久运行阻断 | active |
| D9 | 运行过滤合并报告与原始异常报告使用相同的 Excel Sheet 行数上限并自动拆分 | 防止跨报告合并后超过 1,048,576 行造成审计数据失败或截断 | active |
| D10 | 普通来源逐文件结果显式返回 source/linked revision | 让过滤提交、恢复和日志能直接核对本次事务推进的版本 | active |
| D11 | 全量过滤阻断按必要来源与目标月份的笛卡尔积逐项判断 | 防止其他月份的正常行掩盖单月来源完全缺失 | active |
| D12 | sealed ledger v5 在多文件过滤时冻结“每文件分片 + 完整批次报告”；全部提交时最后一个过滤文件引用批次报告，部分成功时每个已提交文件引用自己的分片 | 保持正常单报告体验，并让允许来源子集、逐文件事务和任意文件顺序都具备独立审计产物 | active |
| D13 | 正常部分成功与异常恢复统一按 `requiredInputPaths` 和 side DB 文件级提交凭证裁剪 `outputFiles/anomalyReports/逐文件引用` | 禁止未提交或未启用文件进入成功批次的可下载报告 | active |
| D14 | 报告依赖必须由主进程原样持久化到 pending，并在 apply grant 前与预检证据逐项一致 | 防止真实 IPC 编排层丢字段而使过滤导入无法授权或恢复证据失真 | active |
| D15 | 墓碑保存 sealed `report_row_count`；重复折叠的非 owner 过滤行不生成文件级报告依赖 | 保持聚合报告导出行数准确，并避免重复-only 文件制造虚假报告 | active |
| D16 | 业务负责人确认 Spec 13.3 五项资金判断并授权技术发布；Windows R2/R3 转为发布后人工 follow-up | 自动化不能替代资金判断，技术资产发布也不能冒充 Windows 实机验收 | active |
| D17 | 三份对外版本文档在 Windows Release 成功前继续标记 `Unreleased/未发布` | 避免标签后 workflow 失败时 `main` 提前宣称一个不存在的版本已发布 | active |
| D18 | Runbook 只允许 annotated tag，release workflow 以 Git object type 强制拒绝 lightweight tag | 任务清单不能替代可执行发布契约，且不可变 Release 必须能审计 tag 注释对象 | active |
| D19 | 发布负责人单独豁免 R4 候选 Setup 离线升级 canary 与 R6 Windows 10/11 候选包/SmartScreen 验证，二者转发布后 follow-up | 当前无 Windows 实机证据；用户在了解范围和 immutable Release 风险后再次确认发布。豁免解除 tag 前人工门禁，但不等于测试通过 | active |

## Assumptions

- A1：生产路径为 `POSITION_IMPORT_ENGINES.STREAMING`；legacy reader 保持兼容，但新审计事务只在 streaming writer 上启用。
- A2：异常报告批次在 3.1.4 保守锁定，避免 tombstone/run 跨库引用被保留期清理；自动解锁可后续独立迭代。
- A3：第三份调拨真实文件的付款成功缺金额行属于硬错误，文件不会因本迭代变为成功。
- A4：报告从暂存或存档读取时都必须重算 SHA-256/size，路径存在本身不构成可信证据。

## Evidence

- E1：`preflight.js → operation-lifecycle.authorizePositionImportApply → source-writer.js` 已提供 sealed ledger、归档 pending、checkpoint grant 和逐文件 side DB mutation。
- E2：`archive-repository.js` 支持 `getBatchByOperationKey` 与 `getArtifactByKey`，可以在重启后解析不可变报告。
- E3：`position_runs.snapshot_json` 已冻结 source revision；新增 run-filtered 关联无需改变匹配引擎输入。
- E4：生产流式路径只读回放共 7 个文件，6 个成功、1 个拒绝；成功文件合计正常落库 902,204 行、过滤 409 行、生成链接 916,206 行。异常报告 148,742 bytes，SHA-256 为 `0a8f944caf918f03a6e7b0c604044e57e55150ce73b5b2435b34c2ec96ea5b57`。
- E5：现有测试付款派生在源金额/源币种缺失时返回 0 个链接候选；过滤不会删除原本可匹配候选。
- E6：两份成功调拨文件分别过滤 3/2 行；三份测试付款文件分别过滤 197/181/26 行。第三份调拨文件第 8,972 行为付款成功但付款金额为空，按白名单外硬错误整文件 0 行提交。
- E7：覆盖分类、ledger 守恒/碰撞、报告故障注入、墓碑生命周期、运行快照、报告完整性、归档恢复和 UI 契约的定向测试为 189/189 PASS。
- E8：结果回导的 Excel 日期序列兼容处理覆盖合法往返及 1 秒、1 分钟、1 小时篡改测试；仅吸收本地 Excel epoch 历史时区产生的 43 秒固定余量，不放宽 2ms 的相对误差门限。
- E9：按电子表格交付门禁生成并检查包含调拨/测试付款的异常报告和运行合并报告；Sheet 结构、关键值、样式及全部 Sheet 渲染通过，公式错误扫描为 0。纯数字长单号和前导零账号使用 inline rich text 文本单元格，避免科学计数法与精度丢失。
- E10：生产报告到运行合并报告的验证发现并修复两项读取盲区：ZIP 条目顺序导致 ExcelJS streaming reader 漏读，以及调拨两列同名“业务日期”被对象键覆盖；现改为 relationship-aware 扫描并按同名表头出现次序逐列投影。
- E11：`npm run scan:vars` 已按 v3.1.4 刷新 263 个源文件、3,322 个顶层名称；首次 `npm run check:vars` 命中 `ipcRenderer`、`dialog`、`setStatus`，首轮 PR 复核补丁命中同名局部变量 `state`，行内 finding 修复再次命中 `setStatus`，均完成下述关联 review。二轮 finding 修复涉及的 6 个代码文件未命中重要变量。脚本以 2 退出表示存在需人工 review 的命中，不是测试执行错误。
- E12：首次完整门禁仅有两个既有 characterization 日期 fixture 在 Asia/Shanghai 下受 SheetJS 0.18 的 1899 epoch 历史时区余量影响；将 fixture 从本地零点改为本地正午并保留 `<= 1ms` 往返断言后，生产解析、月份契约和结果回导 2ms 门限均未放宽。PR 二轮复核补丁完成后再次执行 `npm run release-check`，最终退出码为 0：lint、smoke、4,481/4,481 单测及 44 个集成脚本（2,051/2,051）全部通过。
- E13：PR 复核补充运行过滤关联完整性锚点；篡改冻结报告哈希或把 `filtered_source_id` 换成同报告、同来源、同月份的另一条墓碑都会以 `position-side-data-invalid` 失败关闭。
- E14：PR 复核补充全量过滤月份的管理入口；原始表 0 行、活动墓碑大于 0 时仍返回来源/月范围，删除结果明确区分原始行数与已解除过滤记录数。
- E15：PR 复核补充运行过滤合并报告的 Sheet 上限注入测试；两行数据在阈值 1 下完整生成基础 Sheet 与 `_2` Sheet，合计行数保持 2。
- E16：PR 复核补充逐文件 revision 结果断言；混合过滤与全量过滤提交都返回 source/linked revision=1，并与侧库事务推进一致。
- E17：PR 行内 review 的多月份反例已锁定：2026-06 有 1 行有效调拨、2026-07 有活动过滤墓碑且有效 0 行时，运行按 2026-07 单月返回 `position-source-all-filtered`，不能被 6 月计数掩盖。
- E18：PR 行内 review 的部分提交反例已锁定：两份含过滤行文件预检后，第一份提交、第二份暂存字节变化时，只恢复第一份 input proof、第一份文件级报告和第一条墓碑；覆盖两份输入的批次报告不会进入恢复输出。两份全部提交时仍保留完整批次报告，运行合并按冻结 `report_key` 去重取行。
- E19：二轮 PR review 的正常部分成功反例已锁定：一份已启用调拨过滤文件与一份未启用测试付款过滤文件混合导入时，最终只返回调拨文件分片；未启用文件从 `outputFiles`、`anomalyReports`、逐文件报告引用和侧库墓碑中同时消失，批次报告因依赖未闭合不进入结果。
- E20：两个文件携带完全相同过滤行时，仅首个 owner 文件进入 `sourceFileIndexes/requiredInputPaths`；第二个文件保持 `filtered=0, duplicate=1`，不会生成额外报告或触发 sealed manifest 数量不一致。
- E21：完整两文件过滤批次的墓碑分别持久化分片行数 1 和聚合报告行数 2；`findFilteredReport(aggregate)` 返回 sealed 2，而不是仅统计引用聚合 key 的最后一条墓碑。
- E22：主进程 `recordPositionArchiveIntentFiles` 的真实转换已由 wiring 回归锁定，output descriptor 的 `requiredInputPaths` 会进入 pending；本轮相关定向测试合计 200/200 PASS。
- E23：PR #114 已于 2026-08-01 以 merge commit `1e5dfc697f043a83ef4881843fd6a284ff31e6d2` 合入 `main`；最终实现 commit 为 `836dc5d1db975c0bee69d83ea1f22a79e91b0639`，全部 review 线程关闭，Codex 最终结论为未发现 major issue。
- E24：`main@1e5dfc6` 的 Windows Build workflow run `30697133308` 成功完成 smoke、主页面对齐、Setup/portable 构建、包体检查和更新资产暂存。
- E25：2026-08-01，用户以业务负责人身份明确确认 Spec 13.3 五项资金判断，并批准创建 `v3.1.4` 技术发布；同时批准将 Windows 大报告恢复和进程硬退出演练保留为不阻断发布的人工 follow-up。不可变批准副本为 [PR #115 评论](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/115#issuecomment-5151496159)。
- E26：发布准备分支使用 Node `24.13.0` 重跑 `npm run release-check`，退出码 0：lint、smoke、unit 4,481/4,481、44 个 integration 脚本 2,051/2,051 全部通过；integration 总耗时 297,909ms。
- E27：`npm run verify:main-panel-alignment` 首次在桌面沙箱内因 Electron 无法启动返回 `electron exit null`；按发布校验需要在沙箱外重跑后，两种窗口尺寸、三种缩放 6/6 PASS。这是执行环境限制，不是产品布局失败。
- E28：发布前变量硬节点完成：`scan:vars` 为 263 个源文件、3,322 个顶层名称；发布准备分支未修改 `src/`，`check:vars -- --include-minor` 安全跳过。
- E29：`npm audit --omit=dev` 为 7 high、2 moderate、0 critical；与上一版发布边界一致，本次不静默升级依赖图。
- E30：PR #115 Codex Review 发现 2 条 P1、3 条 P2；版本状态、人工批准证据和 annotated tag 契约已修订。`app-update-contract.test.js` 定向 6/6、完整 unit 4,481/4,481 PASS；Windows 候选安装和离线升级 canary 被保留为 tag 前 BLOCK，不用原 R2/R3 豁免越过。
- E31：在明确解释候选 Setup 离线升级 canary 的验证范围和未执行风险后，发布负责人于 2026-08-01 再次确认发布，并单独豁免 R4/R6 的 tag 前人工门禁；稳定证据为 [PR #115 评论](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/115#issuecomment-5151827405)。评论明确两项未实测、只转发布后 follow-up，且不豁免 annotated tag、GitHub Actions、四项资产核对和 production/latest 在线 canary。

## Deviations

- Dv1：真实回放推翻了“第三份调拨异常也应被过滤”的早期口头预期：付款成功且付款金额为空属于资金证据硬错误，按已确认白名单整文件拒绝；已反向同步 `spec.md` 第 11.1 节。
- Dv2：发布准备初稿曾在 tag/Release 成功前把三份版本文档写成 2026-08-01 已发布；PR #115 P2 复核指出失败 workflow 会造成对外状态失真，现恢复 `Unreleased/未发布`，正式日期改由发布证据 PR 回写。
- Dv3：R4/R6 在 PR #115 review 修订后按 runbook 恢复为 tag 前 BLOCK；用户随后在了解风险后提供单独可追溯豁免，因此两项不再阻断本次 tag，但保持“未实测”并转入发布后 follow-up。

## Remaining unknowns

- R2（PROBE，发布后人工跟进）：Windows 打包环境下大报告的流式 writer 峰值与存档恢复尚未实机验证。
- R3（PROBE，发布后人工跟进）：代码级故障注入已覆盖多文件部分提交的报告范围；Windows 打包环境仍需人工演练进程硬退出和存档持久重试，确认系统级文件锁与恢复提示符合预期。
- R4（PROBE，发布后人工跟进）：候选 Setup 的 `v3.1.3 → v3.1.4` 离线覆盖 canary 尚未执行；tag 前门禁已由发布负责人单独豁免，但仍需补做主库、平盘 side DB、设置、存档与导出文件保留核对。Release 公开后还需独立完成 production/latest 在线升级 canary。
- R6（PROBE，发布后人工跟进）：Windows 10/11 候选 Setup/portable 启动及 SmartScreen 实际提示尚无人工证据；tag 前门禁已由发布负责人单独豁免，不能按已通过处理。
- R5（PROBE，独立依赖治理）：生产依赖审计仍有 7 high、2 moderate、0 critical；需在独立迭代确认可升级版本并完整回归，不与资金发布收尾混改。

## Reconciliation blindspot pass

| 检查面 | 结论 | 证据 / 门禁 |
|---|---|---|
| 主键与血缘 | PASS | 正常来源继续使用 `source_type + row_hash`；过滤行使用不可变 `report_row_key`、行哈希和报告哈希，运行按墓碑 ID 冻结并以完整性哈希绑定墓碑/报告/revision，不以业务单号批量删除正常记录。 |
| 金额、币种与方向 | PASS，业务负责人已确认 | accepted 行仍走既有规范化与派生；过滤白名单不改值。付款成功调拨缺证据整文件拒绝，过滤行不生成任何链接腿。2026-08-01 已确认 Spec 13.3 五项资金判断。 |
| 时间与月份边界 | PASS | 过滤前要求业务日期可解析，墓碑冻结 `event_date/month_key`；范围删除同步解除墓碑。Excel 日期往返保持 2ms 门限并覆盖 1 秒级篡改。 |
| 幂等与重复 | PASS | 同 `source_type + row_hash` 只保留一条活动墓碑，重导关闭旧墓碑再建审计记录；完整重复仍按 owner 折叠。 |
| 部分失败与恢复 | PASS，有 R3 系统级演练项 | 报告/归档证据在 grant 前密封；单文件 side DB mutation 原子；每个过滤 owner 文件有独立分片，正常部分成功与恢复都只保留依赖闭合的报告；未提交/未启用/重复-only 文件不能进入审计产物；报告损坏、碰撞、source revision 与运行信封不一致均 fail closed。 |
| 行数守恒 | PASS | sealed ledger 校验 `扫描行 = 正常候选 + 过滤 owner + 重复折叠 + reader 过滤`；apply 逐项复算并与 manifest 比对，真实成功文件合计 902,204 正常行 + 409 过滤行。 |
| 匹配与消费 | PASS | 新表未接入候选、严格 1:1、多候选或消费表；运行只从既有 `position_link_rows` 取候选，过滤墓碑仅用于阻断、快照和导出。 |
| 可观测与审计 | PASS | 导入提示展示物理/正常/过滤/重复/链接行数；报告立即导出与存档下载同字节；导出行数取 sealed 报告行数；运行导出按冻结行键合并，最终确认前复核报告 SHA-256/size。 |

资金红线结论：自动化与证据检查未发现会改变已接受行金额、币种、方向或消费归属的路径；业务负责人已于 2026-08-01 确认 Spec 13.3 五项业务判断并批准技术发布。Windows R2/R3/R4/R6 均须按发布后人工跟进完成，不得冒充已验收；R4/R6 的发布前豁免不改变这一结论。

## Important-variable review

- `ipcRenderer`：新增 `position-reconciliation:source:export-anomaly` 与 `position-reconciliation:run:export-filtered` 两个 preload 方法；main 端存在同名 handler，renderer 只通过 `window.desktopApi.positionReconciliation` 调用，没有暴露 Electron 或报告内部路径。前端契约测试覆盖方法清单与调用名。
- `dialog`：两个新 handler 都使用原生保存对话框；用户取消或没有路径时返回 `{status:'cancelled'}`，不会生成、覆盖或登记文件。选择路径后才进入经过 SHA-256/size 校验的复制或合并服务。
- `setStatus`：仍只在异常报告或运行过滤数据成功导出后显示行数与文件名；部分提交恢复若有多个文件级报告，每个按钮独立沿用同一成功/取消/失败契约。取消不改状态，失败继续走统一 `failureDetailsHtml` 弹框，不把失败显示成成功。
- `state`：本轮命中来自 `filtered-source-report.js` 中单个来源 Sheet 的局部写入状态，不是 `renderer.js` 顶层状态单例；渲染层补丁只读取接口返回的 `rowCount/filteredRowCount` 生成删除选项，没有修改模板列表、当前模块或导出可用性状态。
- 平盘 Risk-sensitive 总锚点虽未被 check-vars 名称扫描列为新增命中，仍已按 `POSITION_* / PositionReconciliationStore / source-writer` 的资金清单额外完成主库隔离、row_hash 身份、运行失效、报告存档、金额币种方向和 1:1 消费 review，结论见上一节。

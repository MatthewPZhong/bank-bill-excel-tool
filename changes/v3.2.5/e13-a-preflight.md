# v3.2.5 E13-A — Pending/BizOP Read-only Export Preflight

## Task Brief

- Goal：把 Pending 单次差异、跨月汇总、导入错误报告，以及 BizOP 单日/日期区间工作簿生成迁入模块专用 `thread-single` Worker；保持现有 SQL、排序、列、样式、warning/error 样本、Publisher 与用户可见返回契约不变。
- Context：本分支精确基于 v3.2.5 contract bootstrap `5913a59628ece1abde8640846cc9c726567c64ea`；所有 E13-A action 在代码合并时仍为 `production.enabled=false`，legacy 路径继续生效。
- Constraints：不重写 Pending/BizOP writer；不改变 run/dataset/revision 选择、金额/币种、行序、工作簿 sheet/列/样式；不写业务 DB；不解除 Recovery Hold；不运行 `release-check`、`check-vars` 或 `scan:vars`；不启用 production。
- Done when：5 个 actionKey 均有独立 Policy/Worker/结果合同；Main 冻结并复核稳定来源，Worker 只读生成 task-private staging，Main 完成技术及业务回读后才调用既有 durable Publisher；legacy-vs-managed workbook golden、排序、错误样本、stale/partial、取消与发布失败测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| `pending:diff:export-single` 是单 run 差异；`pending:diff:export-aggregate` 生成“按月维度区别汇总 + 汇总”工作簿 | `src/main.js` 两个 IPC；`src/backend/pending-export/writer.js` | `pending:export-diff` 只绑定 single，`pending:export-summary` 必须绑定 aggregate；不能新增用户入口或第三种 summary。 |
| 当前 Registry 把 single/aggregate 都绑定到 `pending:export-diff`，`pending:export-summary` 为空 | `src/main-process/background-execution/action-task-binding-registry.js` | E13-A 要纠正静态 action 归属；E13-G 后续再刷新完整 AST/provenance authority。 |
| Pending DB 固定为 `{userData}/tool-data-pending.sqlite`；writer 自身在一个 read transaction 内读取 run/diff/rows | `src/backend/pending-db.js`；`buildPendingExportReadSnapshot` | Worker 使用 `{readOnly:true}` + `PRAGMA query_only=ON`；稳定证据校验必须进入 writer 同一 read transaction，不能先查后另开快照。 |
| Pending diff run 没有独立 `status`；v1 receipt 以 `archive_terminal_ack_at` 表示已完成 Task terminal，legacy v0 没有 receipt | `src/backend/pending-db/diff-repository.js` | managed stable gate 允许 legacy v0 或已 ACK 的 v1；拒绝 v1 未 ACK，production=false 下不改变当前用户路径。 |
| Pending 错误报告来自进程内 `lastImportErrors`，可能包含大量行/31 列 cells | `src/main-process/pending-session.js` | Main 必须冻结为 task-private managed source 文件并给出 hash/count，Worker 不得把大数组塞进 256 KiB Protocol payload。 |
| BizOP 单日/区间 writer 已按 `diff_rows.id`、日期和现有 SQL 保持稳定顺序；区间当前用冻结 locator 构建跨侧库临时 DB | `src/main-process/biz-op-recon-run-data.js`、`biz-op-recon-writer.js` | Worker 复用 locator/copy/writer；不能改查询、日期排序或跨月 id 重映射。 |
| BizOP 单日 legacy 仅在写成功后更新主库 mirror `export_path`；区间不更新 | `src/main.js` BizOP export handlers | managed Publisher 成功后仅单日延续该 metadata 写入；生成或发布失败不能提前更新。 |
| 全局 tracked IPC Recovery Hold gate 会按 action→task 绑定阻断冲突任务 | `assertTaskPolicyNotHeld` 与 action binding registry | 新 action 绑定必须准确；导出成功不得关闭任何 Hold。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pending:export-summary` 是否需要新 IPC/新 workbook | 入口/契约盲区 | 高 | 一般 | aggregate IPC 标题、默认文件名及 writer 已明确“汇总” | PROBE（已关闭） | 入口→writer→sheet 数据流核对 | 复用 aggregate；不新增入口/格式。 |
| Pending 错误快照如何跨线程且不超协议上限 | 状态生命周期 | 高 | 容易 | 错误缓存仅在 Main 内存，Protocol 上限 256 KiB | PROBE（已关闭） | 大 cells 样本序列化尺寸 + managed source 文件 | 私有 JSON 源文件 + SHA-256/count，finally 清理。 |
| Pending v1 未 ACK run 是否可导出 | 提交状态 | 高 | 容易 | Spec 要求 partial/interrupted fail closed；repo 有 terminal ACK | PROBE（已关闭） | 构造 ACK/未 ACK run | managed gate 拒绝未 ACK；legacy v0 保持兼容。 |
| BizOP legacy-main locator 如何让 Worker 只读主库 | 双源兼容 | 高 | 容易 | locator 用 `sideDbRelPath=null` 表示主库历史；Main DB 有真实 path | PROBE | legacy-main 与 side DB 两组 fixture | 输入同时带 Main DB 路径与 userDataDir，Worker 只读打开。 |
| Workbook byte hash 是否可作为唯一 golden | 输出/审计盲区 | 中 | 容易 | xlsx ZIP 元数据可能使字节级 hash 不稳定 | ASSUME | 同输入重复生成 + semantic workbook snapshot | 以 sheet 顺序、AOA 值、样式/row count/warning summary 为业务 golden；hash 只作同一产物技术证据。 |
| Windows/真实大文件/RSS 与资金人工抽查 | 发布盲区 | 高 | 困难 | 当前仅本地 capability 实施 | BLOCK（production） | R3.2.5 Windows/观察/人工门禁 | 不阻止 dormant capability；阻止 production/正式发布结论。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 5 个 action 的来源身份与 action→IPC 映射 | 防错 run、错 action、未提交 run | stable evidence 正反测试、Registry 测试 | 推翻 Worker 输入合同 | 保持全部 legacy。 |
| 2 | 复用 Pending writer 建单 Worker 最小切片 | SQL/行序/sheet/样式零漂移 | single/aggregate/error golden | 不进入 BizOP | 移除 managed policy/branch，legacy 无改动。 |
| 3 | 复用 BizOP locator/copy/writer | 双源、跨月、日期排序零漂移 | day/range side+legacy golden | 不允许 Publisher | 保持 BizOP legacy。 |
| 4 | Main 技术/业务回读 + durable Publisher | artifact 全有或全无、失败不改 run | tamper/publisher crash/metadata 时序测试 | production 保持 false | 清理 staging，保留 receipt 交既有恢复。 |
| 5 | 取消、stale、全量回归与本地 review | 状态生命周期、审计和旧路径保护 | 定向 + 允许的 unit/integration/smoke | E13-A 不提交 | 按 action 单独收缩，不改业务 writer。 |

## Blindspot / Reconciliation Gate

- ⚠️ 资金红线，请人工复核：Pending/BizOP 的 run 身份、日期/BU、金额/币种、差异行序及工作簿内容必须由业务负责人抽查；自动 golden 不能替代。
- 生成失败、取消、stale source、Publisher 失败均不得修改 run、diff、imports 或自动关闭 Hold。
- 输入有差异而输出为零、错误样本被截断、区间跳过日期必须保持现有可见结果，不得静默成功。
- 本 PR 只新增 dormant capability；Effective Production Strategy 保持 legacy。

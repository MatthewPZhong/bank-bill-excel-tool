# E11-P0 JPM ID-aware Reader / No-op / Receipt Implementation Notes

## Baseline

- Goal/spec：v3.2.4 Spec §4、§6.1、§8～§11；TechDoc §3～§5、§12～§14 的 E11-P0 子集。
- Historical exact base：首次叠栈时的 E11-A `c6c7ffa5ec195eaca366120d5617e93f558f650f`。
- Final v3.2.3 restack base：E11-A 双父合并候选 `7d9c73ecee94b5a1ac9dd831a53f22f30c77fb23`；其第一父为最终 v3.2.3 metadata 候选 `ab9bb149b397ba4f0ea9f272c9177eb06a473feb`。
- Restack provenance：E11-P0 原独有提交 `1d9588a7e5303e9b8a5621095c445d7a9c1c6005`（旧 parent `0800aec86dd7081082937dfa154b1f2dd1a26b6d`）机械移植为 `25b8d6daafe9f6a3cf89573f7370e2c9b9c9f2e5`，其 parent 与 merge-base 均为上述最终 E11-A。
- Final propagation provenance：将已审查累计 head `888688afdeea9a32b8ac0277a027533308a277bb` 作为第二父合入 `7d9c73ec…`，不修改既有 E11-P0 产品文件；从而同时保留最终 v3.2.3/E11-A 祖先与原独有提交血缘。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：ID-aware reader、exact no-op、receipt schema/repository 与同事务 mutation audit primitive 通过定向验证；JPM live/managed/production 仍关闭。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| E11-P0 只交付判定/持久化原语，不注册 `recon-fix:run-jpm` | 冻结 PR 顺序把 worker-durable/Inspector 放在 E11-B；E11-A policy/runtime 只覆盖只读 action | 在本 PR 接 Worker protocol、critical 或 live IPC | production 与 legacy 路由保持不变；E11-B 显式消费原语 |
| ADM image 覆盖 exact id 与完整 parsed row | 引擎的匹配输入不只含三个写回字段；只 hash flags 无法发现金额/日期/批次 TOCTOU | 只 hash 三个 writeback 字段；hash raw_json bytes | 相同 JSON 语义稳定，任何业务字段变化均 fail closed |
| engine row 通过对象 identity 映射回 reader id | 旧引擎保证原对象返回；数组下标不足以证明未重排/未替换 | 继续按 index 写；把 DB id 混入业务 row | candidate 不污染业务字段；缺失/重复/外来/重排全部拒绝 |
| no-op 与 mutation API 物理分离 | no-op 必须在 critical 和事务之前完成，且不得写 receipt | 单一函数内部先 BEGIN 再判 no-op | future coordinator 必须显式先分支；transaction primitive 拒绝 noop plan |
| raw reader 使用平台 duplicate-aware strict parser，损坏证据只保留 count 与 5 个截断 ID token | legacy reader 会静默 drop 语法坏行并接受重复 key；raw_json 含资金与账号信息 | 修改 legacy reader；在错误中返回 raw/id | 新 reader 对所有坏行汇总后 hard fail，线上 legacy 入口行为不变 |
| mutation 与 receipt 由一个 `BEGIN IMMEDIATE` 原语提交，并在最后故障 seam 后权威回读两者 | 只在 update 后校验会漏掉 trigger/fault 在 receipt 阶段造成的漂移；分事务会产生部分成功 | 先写 ADM 后补 receipt；依赖数组位置 | count/id/order/pre/post/receipt 任一漂移均 rollback；exact id 是唯一写入定位 |
| 已有 receipt 一律 fail closed | committed/not-committed/unknown 的重放判定属于 E11-B Inspector | E11-P0 猜测幂等成功并继续 adopt | 不重复 mutation，不提前实现恢复状态机 |
| Restack 不为 E11-A phase-extension 增加 JPM resource 层或适配分支 | P0 只提供尚未接 Worker 的 reader/plan/transaction/receipt primitives；E11-A Governor 仍是唯一 resource authority；streaming evidence 保持 byte-identical | 在 P0 transaction 中自行申请 lease；为旧 hash 添加 fallback/catch | 上游传播只改变基线与验证证据，不扩大 E11-P0 协议或业务合同 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E11-B 持有完整 result candidate | Spec §6.1 明确 Service private | E11-P0 无法跨 crash 恢复内存 result（本就不在范围） | 本 PR API 不接受 candidate；E11-B 后续实现 pending/adoption |
| receipt 不清理、不 down migrate | TechDoc §14 | 主库长期增加小量审计行 | 如需 retention，另立带恢复影响的规格 |

## Deviations

- 行为偏差：无。
- 传播记录：原 E11-P0 独有提交从旧 E11-A 重叠到最终 E11-A；语义复核与回归未发现需要生产代码适配的上游冲突。

## Evidence

- `NODE_PATH=<共享 node_modules> node --test tests/unit/main-process/recon-id-fix-jpm-writeback-e11-p0.test.js`：19/19 PASS。覆盖实际 JPM 引擎、真实 `DatabaseSync`、strict reader、空表/identity/ID gap、exact no-op、migration/restart、same-transaction receipt、TOCTOU、trigger、ADM/receipt fault injection、existing receipt 与 production-false 边界。
- 最终 E11-A Service suite：14/14 PASS；覆盖 phase-extension 准入/释放、streaming evidence、standard/BOC golden、revision/busy/stale/cancel/close 边界。
- 新套件与 `linked-table-adm-deposit`、JPM seed/engine、ReconFix Service/engine/IO 定向联合：107/107 PASS；legacy ADM、standard/BOC Service golden 与 JPM disabled 边界未回归。
- 最终 v3.2.3/E11-A 组合基线重新执行同一联合清单：`107/107 PASS`；确认 parser-first shutdown 纠偏、ID-aware reader、exact no-op、事务 receipt 与金额/币种/逐行 ID 血缘同时成立。
- 直接集成：`bank-statement-universal-import-routing.js` 20/20 PASS；`v3.0.0-linked-streaming-import.js` 19/19 PASS；`v3.0.4-boc-dispatch-order-fix.js` 31/31 PASS。
- 完整 `npm run smoke` PASS，其中 ReconFix gateway smoke 20/20；首次未设置 `NODE_PATH` 时在加载 `xlsx` 前因隔离 worktree 无依赖失败，使用共享依赖路径重跑同一 smoke 后通过，未修改 package/lock。
- ReconFix Service benchmark gate PASS：5k 的 peak RSS delta `218808320` bytes 小于当时持有 lease envelope `399343616`；10k 为 `367722496 < 500022640`；near-boundary（9750 rows/side、phase 利用率 91.67%）为 `349913088 < 482488408`。三例 shutdown 均无 lease leak，证明 P0 重叠未破坏最终 E11-A resource-control。
- 受影响文件 ESLint PASS；`node --check` 与 `git diff --check` 在提交前复验。
- 隔离 worktree 未安装依赖；测试只通过 `NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules` 复用共享依赖，未改 lock/package。

## Blindspot Pass

- 入口旁路：本 PR 没有新增 policy、entryKey、Worker action、critical 消息、Inspector/recovery 或 IPC；canonical fixture 与 E11-A readonly policies 均锁定 `production.enabled=false / legacy / workerCount=0`。
- 边界条件：空表、ID 有缺口可保持 exact lineage；rowCount、同数量换 ID、重排、重复/外来对象、坏 JSON/重复 key、非 writeback 字段变化均 fail closed。
- 失败模式：`after-updates`、`after-receipt-insert` 注入失败会同时 rollback；未计划行 trigger 与最后 seam 的 ADM 篡改被 postimage 权威回读捕获；已有 receipt 不猜 replay。
- 状态生命周期：no-op transaction API 在读取 DB 前拒绝；receipt 只记录 bounded hashes/counts/identity，不保存 candidate 或 raw rows。Worker durable adoption、critical handshake、Inspector 与 Hold 明确保留给 E11-B。
- 兼容性：migration 仅 `CREATE TABLE IF NOT EXISTS`，AppDatabase 两次重启可见；legacy reader/writer 未替换，标准/BOC 与 JPM legacy engine 回归通过。最终 E11-A streaming evidence 的 canonical digest 与原投影 byte-identical；P0 未新增 resource request/phase lifecycle，唯一 authority 仍是 ServiceHost/Governor。
- 可观测性：损坏 raw_json 只暴露损坏行数与最多 5 个脱敏 token；事务失败使用稳定 code，receipt 不含账户、金额、完整行或结果 candidate。

## Reconciliation Blindspot Pass

- 主键血缘：source object identity 只用于 Service 私有运行期绑定，随后以严格递增 DB id 序列 digest 复验；写入只使用 `WHERE id = ?` 且要求 `changes === 1`，不以数组下标猜测。
- 金额/币种/标志：pre/post image 覆盖完整 ADM parsed row；plan 只允许三个 JPM writeback 字段变化，金额、币种、日期、批次、调拨号与其它字段变化会拒绝。测试显式锁定 USD 与逐行 `Fundtransfer-in金额` 原值。
- 行数/顺序守恒：engine 输出必须与 source 等长、同 identity、同 ID 顺序；事务内前后都复验 rowCount 与 idSequenceDigest，新增/删除/换 ID 全部 rollback。
- 幂等/部分失败：exact noop 不进 DB/receipt；`(action_key, operation_key)` 唯一，既有 receipt fail closed；ADM mutation 与 receipt 同事务，故障矩阵证明无半写。
- 审计/隐私：receipt 保存 task/scenario、pre/post hash、ID digest 与 row counts，可供 E11-B Inspector 使用；不保存 raw_json、金额明细、账户或 candidate。
- 资金红线结论：自动验证没有发现金额/币种或行血缘漂移；真实 JPM 样本逐行核对仍是 production enable 前的人工 REVIEW，自动化不能替代。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| E11-B worker-durable/critical/Inspector/Hold 接线 | PROBE | E11-B | 不阻断 E11-P0，阻断 production enable |
| Windows packaged SQLite lock/rollback 行为 | PROBE | R3.2.4/production enable gate | 不阻断 production-false 基础，阻断 production enable |
| 真实 JPM 样本逐行资金复核 | REVIEW | 资金负责人 | 未完成不得 production enable |

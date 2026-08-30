# E08-B BankBU Optional Dual Parser Unknowns Preflight

## Task Brief

- Goal：在 E08-A durable import/receipt/Inspector/Hold 不变量之上，为 production-false BankBU import 增加可选 Pending/Bank dual parser；两个只读 Parser 只写独立 task-private role spool，既有 single Writer 固定 Pending→Bank 采用。
- Context：精确 parent `d2e0a3d4f362bb762e927f5c2fa7a5313bcea224`；冻结合同为 v3.2.2 Spec §7/§9/§10、TechDoc §9/§11/§12、implementation sequence 与 E08-A notes。
- Constraints：Parser 禁止访问业务 DB、matching、receipt/mirror；不改 1:1/1:N/N:1/N:M、BU normalize、dual-source export、金额币种或公开 runId；失败/取消/乱序/source-change 必须在 critical 前失败并清理 task-private spool；低资源、非双输入或性能/RSS门禁失败回退 single；production 固定 false/legacy/0；禁止 release-check/check-vars/scan:vars。
- Done when：dual 与 single 的 source row index、月份、BU、账号、原始顺序、dataset evidence、side post-image 与 receipt 等价；只有两侧 clean parser success 且源文件仍匹配 snapshot+SHA 才发 critical；任一 pre-critical failure 零 DB mutation/零 receipt/零 mirror并清理 spool；定向 unit/integration/static/benchmark/RSS 通过或明确保留门禁。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E08-A import 在 reader 全成功并复核文件 SHA 后才 await critical，随后调用同一 `importCommittedDataset`。 | `src/main-process/bank-bu-worker/import-operation.js` | dual 只替换 reader 准备阶段；critical、single Writer、side receipt与事务不复制。 |
| E08-A dataset hash 已绑定月份、两角色文件 SHA、完整规范列、`_rowIndex`与数组顺序。 | `bank-bu-worker/identity.js` 与 `bank-bu-worker-e08-a.test.js` | spool consumer必须重建原 row 对象与原顺序，最终继续调用 `buildImportEvidence`。 |
| BankBU policy 已冻结 `thread-pool/compound/downgrade-to-single`，但 production 为 `false/legacy/0`。 | `bank-bu-worker/policies.js` 与 frozen fixture test | 不改 policy 字段；optional coordinator只接受实际获批1或2个 Parser，不把 benchmark结果写成生产启用。 |
| E07-C 已证明 Parser success marker只能在真实 Worker exit 后由 Main coordinator发布，failure marker应等待 sibling terminal，spool cleanup由Main owner负责。 | `duplicate-inbound-match/paired-parser-dispatch.js` 及 E07-C notes/tests | E08-B沿用相同 terminal barrier，避免 parent/lease 在活Parser之前结算。 |
| BankBU reader按第一个sheet、列名定位、保留中间空行形成的真实Excel行号，并把所有业务cell转字符串。 | `backend/bank-bu-recon-import/reader.js` | Parser必须直接调用两只既有 reader，不复制表头、列位移或数值语义。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| role spool如何防止串角色、篡改和source TOCTOU | 血缘 | 高 | 一般 | E08-A evidence与E07-C manifest先例明确 | PROBE | role/yearMonth/job/op/owner、snapshot/SHA、row hash/count、列集与递增row index反例 | 专用contract；Parser前后与Writer消费前后都核对source authority。 |
| Writer如何固定顺序且不复制业务事务 | 顺序/资金 | 高 | 容易 | `importCommittedDataset`唯一参数顺序就是Pending、Bank | PROBE | 让Bank先完成，断言DB两表row_index/evidence/receipt与single完全相同 | Worker按descriptor role固定先consume Pending、再Bank，再调用E08-A原Writer。 |
| Parser失败如何让正在等待的one-shot Writer终止 | 生命周期 | 高 | 容易 | filesystem bounded terminal outcome先例可由Worker轮询 | PROBE | 一快一慢、坏表头、transport crash、source change、cancel | Main等全部Parser terminal后发布failure outcome；Writer在critical前读取并失败。 |
| Governor只批准1 child时是否改变合同 | 资源 | 中 | 容易 | frozen lowMemoryBehavior为downgrade-to-single | ASSUME | fake runtime snapshot=1与optional gate fallback | 实际1时串行执行两role Parser，仍由single Writer采用；门禁禁用/非双输入直接走E08-A single reader。 |
| Windows locked file与真实财务样本 | 外部门禁 | 高 | 容易 | 当前为macOS本地合成fixture | BLOCK production | packaged Windows、脱敏真实月度样本与人工恢复演练 | 不阻断false-gated E08-B合并；禁止启用production。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 建立专用descriptor、路径、manifest/outcome与只读Parser。 | month/role/source/row血缘，零DB依赖 | dependency scan、tamper/source-change/row-order测试 | 阻断dual parser | 删除新模块，single不变。 |
| 2 | E08-A import增加dual spool prepare seam。 | 两侧全成功、Pending→Bank、critical前source exact | completion乱序、critical spy、side DB/receipt parity | 阻断mutation能力 | 保留direct reader分支。 |
| 3 | optional coordinator、gate、actual count和cleanup。 | perf/RSS/低资源fallback、失败取消无残留 | gate矩阵、1/2 worker、failure/cancel cleanup | 阻断optional入口 | gate固定false。 |
| 4 | blindspot/资金扫描与定向验证。 | 旧算法/恢复/export/production字段不漂移 | unit/integration/smoke/static/benchmark/RSS | 保留人工BLOCK | production继续false/0。 |

## BLOCK 与保守假设

- 当前没有需要改变冻结合同或由用户决策的 BLOCK；Windows packaged、真实财务样本和人工恢复仅阻断 production enable。
- ASSUME：task-private parser spool不是 durable business evidence；唯一恢复权威仍是 E08-A side receipt、sideRunId、Main mirror、Inspector 与 Hold，因此 pre-critical终态后应清理而非恢复spool。
- ASSUME：资源实际只批准一个 child 时，以一个并发槽串行两只 role parser仍属于冻结的 single downgrade；不会绕过同一个single Writer，也不会改变production字段。

## Unknowns Closure

| 原未知 | 结论 | 证据 |
| --- | --- | --- |
| role/source/row TOCTOU | 已关闭：descriptor与manifest绑定month/role/job/op/owner/source snapshot+SHA/row hash+count；Writer消费前后及双侧完成后复核 | source-change、manifest role篡改、rows篡改、row index/order focused tests |
| Writer顺序与事务复用 | 已关闭：spool固定先Pending后Bank读取，随后仍调用E08-A `buildImportEvidence`/`importCommittedDataset` | 故意Bank先完成的single/dual side post-image、dataset hash与receipt parity |
| failure/cancel终结 | 已关闭：首个失败abort sibling，等待全部Parser terminal后才发布failure outcome；parent终态后Main owner清理两role spool | failure/cancel零critical、零side DB、staging absent tests |
| singleton Writer注册 | 已关闭：dispatch显式注册唯一`operation:000000` unit；Parser不注册Platform business unit | dispatch request unit identity断言、E08-A host/Supervisor回归 |
| 性能/RSS | 本机parser-only已关闭：3,000行/role交替五轮，dual中位数302.26ms vs single 467.41ms，改善35.33%；峰值RSS 512,671,744B < 838,860,800B | `scripts/benchmark-bank-bu-dual-parser.js 3000 5`；不替代Windows/真实样本门禁 |

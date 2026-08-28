# E11-P0 JPM ID-aware Reader / No-op / Receipt Preflight

## Task Brief

- Goal：为 ReconFix JPM 资金写回提供专用 ID-aware ADM reader、critical 前的 exact no-op 判定，以及与未来 ADM mutation 同一 `BEGIN IMMEDIATE` 的 operation receipt schema/repository/事务原语。
- Context：精确基线为最终 E11-A `c6c7ffa5ec195eaca366120d5617e93f558f650f`；E11-A 已交付 production-false 的 import/standard/BOC Service capability、保守 phase-extension 准入与 streaming evidence，并明确阻断 JPM managed run。E11-P0 的独有提交从旧 E11-A 基线机械移植后，需重新证明两层语义共存。
- Constraints：不注册或启用 `recon-fix:run-jpm`；不实现 Worker durable 协调、Critical Intent/handshake、`commit:receipt` 消息、Inspector、startup recovery、Recovery Hold、export 或 VCC；live IPC/legacy JPM 路径保持不变；JPM production 保持 disabled/legacy；不运行 release-check/check-vars/scan:vars。
- Done when：专用 reader 以 `ORDER BY id ASC` 返回 `id + raw_json + parsed`，坏 JSON hard fail 且不丢行；rowCount、ID digest、pre/post image hash 由同一 canonicalizer 生成；plan 不用数组下标绑定未验证行并能 exact 区分 noop/mutation；noop 只产出有界 handle/summary，不能进入 transaction/receipt；mutation primitive 在同一主库 `BEGIN IMMEDIATE` 内重读并校验 ID/count/order/preimage、按 exact id 更新、写 receipt，任一步失败全部 rollback；定向资金/兼容测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E11-P0 冻结在 E11-A 与 E11-B 之间 | v3.2.4 Spec §9 | 本 PR 可交付 reader/no-op/schema/事务基础，但不得接入 worker-durable 协议或恢复链 |
| JPM managed action 必须保持 production false | v3.2.4 Spec §3；E11-A `policies.js` 只注册 import/run-readonly | 不增加 JPM policy、entryKey、live routing 或 feature enablement |
| 旧 ADM reader 会跳坏 JSON 且丢失 ID | `linked-table-repository.js` `readAdmBankDepositRows()` | 新 reader 必须独立存在；legacy reader 行为不在本 PR 改写，避免改变线上入口 |
| 旧 writer 仅按 `ORDER BY id ASC` 数组下标写回 | `linked-table-repository.js` `writeAdmMatchFlags()` | 新事务原语必须按 exact id，并先验证 rowCount/idSequenceDigest/preImageHash |
| JPM 引擎只写三个 ADM 字段 | `jpm-dispatch-order-fix.js` 对 `admReconFundId/admChannelMatched/admGatewayMatched` 的赋值点 | plan 必须拒绝其它 ADM 字段变化，保护金额、币种、批次和行血缘 |
| ADM 与 receipt 都属于 Main-owned 主库 | `database.js` 初始化 `linked_adm_bank_deposit`；TechDoc §5 要求 receipt 与 ADM mutation 同一主库事务 | receipt schema 加入当前主库的幂等迁移；不得跨 DB 双写 |
| 平台已有 RFC8785/JCS canonicalizer，ReconFix 已有 legacy-safe evidence projection | `background-execution/canonical-json-v1.js`；`recon-id-fix-service/evidence-projection.js` | ID digest、行 image 与 plan hash 复用同一 canonical hash 路径，不另造普通 JSON stringify hash |
| 最终 E11-A 将 ReconFix evidence 改为 byte-identical streaming hash，并在 Worker 大分配前申请 Governor phase extension | E11-A `evidence-projection.js`、`worker-entry.js`、`service.js` 与 14 项 Service 测试 | E11-P0 必须继续复用同一 evidence helper；不得增加第二资源 authority，也不得把尚未接线的 JPM primitive 伪装成 Worker phase |
| Service 大结果必须私有 | v3.2.4 Spec §6.1、TechDoc §4 | E11-P0 plan API 只接收/返回 `resultHandle + boundedSummary`；不接收、存储或公开 fixed/unmatched candidate |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| image hash 应覆盖哪些 ADM 字段 | 数据契约未知 | 高 | 一般 | TechDoc 要求至少覆盖 id 与 writeback 字段；引擎匹配还读取日期、批次、调拨号和金额 | PROBE | 对照引擎所有 ADM 读取/写入点并做非写回字段 TOCTOU 测试 | 覆盖 `id + 完整 parsed row`；另行验证只有三个 writeback 字段可变化，强于最小合同且防输入证据漂移 |
| engine output 如何绑定 DB id 而不依赖数组下标 | 主键血缘盲区 | 高 | 一般 | 引擎承诺原对象原数组返回，但旧 writer 仅按位置 | PROBE | 用 source `parsed object -> id` identity map 验证缺失、重复、外来对象和重排 | plan 按对象 identity 恢复 exact id，再校验完整 idSequenceDigest；changedRows 按 id 保存 |
| exact no-op 如何保证早于 critical/transaction | 状态边界未知 | 高 | 容易 | E11-B 尚未交付，E11-P0 不应引入 critical 协调 | PROBE | API 形状与 spy DB 测试；noop 调用 mutation primitive 必须拒绝 | plan 先纯计算；独立 bounded noop result API；transaction primitive 只接受 mutation plan |
| receipt replay/conflict 在 E11-P0 如何处理 | 幂等盲区 | 高 | 一般 | Inspector/recovery 属 E11-B；receipt 是 committed 权威证据 | PROBE | 同 operationKey 预置 receipt 后调用 mutation primitive | E11-P0 fail closed 并 rollback，不猜测 replay outcome；E11-B 由 Inspector 判定 |
| invalid raw JSON 的错误证据如何可观测且不泄密 | 隐私盲区 | 中 | 容易 | raw_json 可能含账号、订单和金额；DB id 只用于内部定位 | PROBE | 错误 shape 测试禁止 raw text/parsed row，限制样本数量 | 只返回 corruption count 与最多 5 个 HMAC-free SHA-256 截断 ID token，不返回原 ID/raw_json |
| 最终 E11-A 的 phase-extension/streaming evidence 是否要求调整 E11-P0 reader/plan/transaction | 上游传播未知 | 高 | 容易 | E11-P0 只调用 evidence helper，不注册 Worker action、Service resource 或 live route | PROBE | 在最终 E11-A 基线上机械移植独有提交，跑 E11-P0 19 项、E11-A 14 项与联合回归/benchmark | 无代码适配：streaming hash 对 P0 image/digest 保持 byte-identical；resource authority 仍唯一属于 ServiceHost/Governor |

## BLOCK

无。冻结合同允许 E11-P0 独立交付上述基础；E11-B 的 worker-durable/Inspector/Recovery Hold 仍是 production enablement 的后续硬门禁，不由本 PR 假实现。

## PROBE 结论

1. `linked_adm_bank_deposit` 与目标 receipt 表都位于 `AppDatabase` 的同一 `DatabaseSync` 主库连接，具备单事务原子性。
2. JPM 引擎对 ADM 的唯一写集合为 `资金对账ID / 是否与渠道账单匹配 / 是否与网关账单匹配`；日期、金额、币种、批次、调拨号及其它字段必须 byte-semantically 保持。
3. source reader 的 parsed object identity 可作为 engine 私有运行期 id 绑定，随后仍需用 rowCount/idSequenceDigest/imageHash 关闭重排、重复、外来对象和 DB TOCTOU。
4. no-op 不需要 durable receipt；若 plan 为 noop，任何 mutation transaction API 调用都应立即失败，确保后续 E11-B 必须在 critical 前分支。
5. E11-P0 的 reader/plan/transaction/repository 不导入或实例化 `ResourceGovernor`/`ServiceHost`，也不注册 JPM Worker action；最终 E11-A 的 phase extension 仍由既有 Service resource-control 独占管理，没有形成第二 authority。
6. E11-P0 复用的 `reconFixEvidenceSha256()` 在最终 E11-A 中改为有界 streaming 实现但保持 canonical bytes/hash 合同；19 项 P0、14 项 A 与 107 项联合测试均通过，无需兼容补丁。

## ASSUME

- E11-B 将 result candidate 保存在 ReconFix Service 私有状态，并只把本 PR 的 `resultHandle + boundedSummary` 交给 no-op/public protocol；E11-P0 不提前实现 pending map 或 job wire contract。
- receipt 永久保留且不做 down migration，服从 v3.2.4 TechDoc §14；清理/归档策略若未来需要变化，另立规格。
- 旧 live JPM 继续使用 legacy reader/writer；本 PR 的严格 reader 不替换 live 路由，因此 production 行为零变化。

## 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 实现 ID-aware reader 与共享 canonical image | 坏行不丢、ID/order/count、敏感信息边界 | bad JSON/ID order/digest/hash tests | reader 合同不成立，停止事务实现 | 仅保留文档，不接任何 runtime |
| 2 | 实现 pure plan 与 bounded noop result | exact no-op 早于 critical；candidate 私有；非写回字段守恒 | noop/mutation/外来对象/重排/字段漂移 tests | 阻断 E11-B | 不提供 mutation primitive |
| 3 | 增加 receipt schema/repository | 同 action+operation 唯一、字段 exact、只在事务写入 | migration/restart/repository transaction tests | 无 authoritative receipt | 回退尚未发布的加法 DDL 接线 |
| 4 | 实现 exact-id 同事务 mutation+receipt primitive | TOCTOU fail closed、任一步 rollback | count/ID/preimage/postimage/fault injection tests | 资金污染风险，禁止提交 | 保留 reader/plan/schema，不导出 commit primitive |
| 5 | 定向回归与盲区复核 | legacy/E11-A/金额币种标志行数血缘/production false | unit/integration/static + 手工 gate 清单 | 不声明完成 | 修复或停止 |

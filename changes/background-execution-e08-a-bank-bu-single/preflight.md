# E08-A BankBU Single One-shot Jobs Unknowns Preflight

## Task Brief

- Goal：为 `bank-bu:import-month`、`bank-bu:run`、`bank-bu:export-single`、`bank-bu:export-aggregate` 建立 production-false 的 one-shot Worker capability，并完成 side/main identity 与恢复合同。
- Context：exact base `29dc9741f60acb1dba30cada1ce58bdaf5068731`；权威合同为 v3.2.2 Spec/TechDoc、Platform Contract v1、Lifecycle Mapping 与 implementation sequence。
- Constraints：仅 E08-A single Worker；不实现 E08-B dual parser；不接 live IPC/production；不改变 BankBU 1:1/1:N/N:1/N:M、BU/账号归一、月份、对外 runId 或 Excel sheet 语义；禁止 release-check/check-vars/scan-vars、依赖变更和远端操作。
- Done when：import 两 reader 全成功后才以固定 Pending→Bank 顺序在单事务覆盖 side 数据并写 dataset evidence/receipt；run 在 critical ACK 前持久化旧 mirror pre-image，side run/receipt 先提交，Main mirror 以同 operationKey+sideRunId CAS 提交；Inspector 唯一判定四态，partial 仅 complete-mirror；export staging/Publisher 边界与 dual-source 语义可验证；定向崩溃、重启、CAS、顺序和资金守恒测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| BankBU 既有 inline import 已先读 Pending、再读 Bank，随后调用月侧库原子覆盖 | `src/main.js` BankBU import handler；`bank-bu-recon-run-data.js#importMonth` | Worker single 路径复用两个 reader；任一 reader失败时不得打开写事务 |
| 既有 `importMonthAtomic` 的事务顺序固定为 clear pending/bank/runs → insert pending → insert bank | `src/backend/bank-bu-recon-db/month-repository.js` | E08-A 只扩展 dataset evidence/receipt，不改变角色与物理行顺序 |
| BankBU side receipt schema/repository 已由 E06-P0 建立，但 live writer 未调用 | `run-data-store.js#SIDE_DB_DDL_BANK_BU`；`bank-bu-worker/operation-receipt-repository.js` | 复用冻结 receipt 字段；receipt 必须进入真实 side mutation事务 |
| 既有 run 在 side insertRun 后无条件 delete+insert Main mirror，且两侧没有共同 identity | `bank-bu-recon-run-data.js#runViaSideDb/#upsertMainRunMirror` | 新 managed 路径必须独立实现 side-first 与 bounded pre-image CAS；legacy 路径保留 |
| 对外 runId 是 Main mirror id，sideRunId 只属于月侧库命名空间 | `rules/important-variables.md` per-月侧库条目；`bank-bu-recon-run-data.js` | Worker result和mirror必须同时保留 sideRunId；公开结果只返回 mirrorId |
| 既有 export 是 dual-source 重算，aggregate 按月升序并返回 included/skipped | `bank-bu-recon-run-data.js#loadExportDataByRun/#aggregateExportData` | Worker staging生成必须复用这些读语义，不从 receipt 猜业务结果 |
| Platform 对 partial/unknown 禁止算法重跑，并要求 interrupted/Hold | Platform Contract §7、Lifecycle Mapping §3/§10 | complete-mirror只能读取已提交 side run/receipt，CAS冲突返回 unknown |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 旧 side DB 缺 dataset/identity 列如何升级 | schema兼容 | 高 | 一般 | `openSideDb` 对 BankBU 只执行 `CREATE IF NOT EXISTS` | PROBE | 用旧DDL真实临时SQLite再次open并检查列/数据 | 增加幂等 additive ensure；历史业务行不回填伪identity |
| import/run input evidence如何稳定 | identity | 高 | 一般 | reader保留 `_rowIndex` 和完整规范行；平台有RFC8785 canonicalizer | PROBE | 同输入重放hash相同、行序/月/角色变化hash不同 | import hash绑定月份、角色、文件SHA、行数与行canonical hash；run hash绑定当前 dataset evidence |
| Main 当前 mirror 存在多个同月行时如何处理 | 并发/兼容 | 高 | 一般 | managed旧路径通常delete后insert，但历史主库可能保留多run | PROBE | 合成0/1/2行镜像捕获与CAS | 多行不是唯一pre-image，fail closed为 identity conflict/unknown，不静默择最新 |
| complete-mirror如何避免重跑算法 | 恢复 | 高 | 困难 | side run只持久summary，足够构造Main轻量mirror | PROBE | 注入matching spy并在partial恢复断言0调用 | 从 receipt+side run读取post-image；不调用`runReconciliation` |
| export如何满足Main Publisher但不接live | artifact | 中 | 容易 | writer现可写指定路径，平台artifact result有staging manifest范式 | ASSUME | 临时staging生成、hash/readback、目标目录保持未写 | capability只生成staging manifest；Publisher接线留给后续production gate |
| Operation lock由谁持有 | 并发 | 高 | 一般 | Platform规定Main持有业务锁；本PR不接live IPC | ASSUME | coordinator要求caller注入`withOperationLock`，无锁拒绝 | E08-A提供Main coordinator seam并强制锁内capture/CAS；不创建第二套全局锁 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 建立 additive side/main schema 与 canonical identity helper | 旧库兼容、月份/行序/operation identity | 旧库升级探针、hash反例 | 推翻后续持久合同 | 保持production false，撤回新writer接入 |
| 2 | 实现 import/run 单事务与Main pre-image CAS | 原子覆盖、side-first、唯一mirror | transaction rollback、crash window、CAS测试 | 直接阻断E08-A mutation | 仅保留只读export capability |
| 3 | 实现只读Inspector与complete-mirror | partial不重跑、unknown Hold边界 | 四态矩阵、matching spy=0、并发冲突 | 阻断run capability | 保持legacy/production false |
| 4 | 实现one-shot host/policies/export staging | 协议、Task settle、artifact全有或全不发布 | protocol/worker/staging readback | 不影响既有live路径 | 不注册到live runtime |
| 5 | blindspot与资金盲区复核、定向验证 | shutdown/kill/row-count/金额币种/审计 | unit+integration+SQLite crash/restart+lint/check | 未关闭项留人工红线 | 不启用production |

## Unknowns Closure

| 原未知 | 结论 | 证据 |
| --- | --- | --- |
| 旧side DB升级 | 已关闭：additive ensure补列/表/partial unique index，不伪造历史identity | 旧DDL带业务run再次open测试 |
| import/run evidence | 已关闭：month+role+file SHA+完整行/row index/order canonical hash；run复用当前dataset hash | identity lineage单测与真实reader集成 |
| Main多mirror | 已关闭为fail-closed合同：不选择MAX，不删除历史 | capture 2行抛identity conflict；Inspector映射unknown |
| complete-mirror重跑风险 | 已关闭：恢复模块只读取side receipt/run summary并CAS，未导入算法 | partial/old/concurrent CAS测试 |
| export Publisher边界 | capability侧已关闭：stagingRoot内生成manifest、无正式路径/Publisher；live Main settle仍为production BLOCK | staging escape与XLSX readback测试 |
| operation lock归属 | 已关闭：Main注入唯一锁，coordinator单callback覆盖prepare→side→CAS | coordinator端到端锁测试 |

唯一保留BLOCK是Windows packaged/真实财务样本/人工恢复以及live FilePlan validator、Publisher journal、Task settle门禁；因此四个policy继续固定`production=false / legacy / 0`。

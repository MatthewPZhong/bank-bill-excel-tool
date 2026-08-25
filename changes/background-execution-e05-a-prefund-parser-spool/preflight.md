# v3.2.1 E05-A Unknowns Preflight

## Task Brief

- Goal: add a read-only PreFund MPT Parser Core, task-private per-file Spool v1 and an Ordered Coordinator seam without changing the live import path.
- Context: the current `mpt-parser.js` already owns file/header/row normalization while `pre-fund-reconciliation-store.js` mixes that parser with identity, sequence, replacement and SQLite mutation.
- Constraints: no live handler, DB read/write, receipt, critical protocol, migration, repair-token or candidate-order changes; no production parser pool or production enablement; parser transport-crash product mapping remains deferred to E05-P0.
- Done when: parser output is golden-equivalent to the current parser; spool publication is fail-closed and strictly revalidated; coordinator consumes only increasing file indexes with one injected read-only/fake consumer; focused tests and static checks pass.

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 现有 `parseMptFile` 已流式完成 filename/header/schema、日期/金额、fingerprint、raw source SHA-256 与行错误收集。 | `src/main-process/pre-fund-reconciliation/mpt-parser.js`、`mpt-schema.js`。 | Parser Core 复用现有 parser，不复制或改写资金字段规则。 |
| DB identity/sequence/replacement/noop、batch id、dataset version 和 excluded-row 写入发生在 parser callbacks 里。 | `src/backend/pre-fund-reconciliation-store.js` `_importFileUnlocked()`。 | E05-A 不能复用 store import 作为 consumer，也不能把这些判断搬进 Parser Core。 |
| strict 与 skip 的旧差异是同一批 row issues 在 strict 时聚合失败、skip 时写 excluded audit；解析本身相同。 | `rowAggregateError()` 与 `_importFileUnlocked()` 的 `skipInvalidRows` 分支。 | Core 只把 issue 标为 `error` 或 `excluded` candidate；repair token 仍由旧 service 管理。 |
| 当前 service 按输入顺序逐文件 import，业务错误继续，结果与输入同序。 | `PreFundReconciliationService.importMptFiles()`。 | Coordinator 的 business-error path 必须继续推进；consumer 必须单飞。 |
| 已有 durable-file primitive 会把 directory fsync unsupported 与失败显式返回/抛出。 | `src/main-process/background-execution/durable-file.js`。 | Spool manifest 只有在 parent directory barrier supported 后才可宣称 ready，否则清理并失败。 |
| 源快照已有 canonical `{sizeBytes,mtimeMs,ctimeMs,ino?}` 合同。 | `src/main-process/archive-center/source-snapshot.js`。 | Spool writer/reader 复用同一 snapshot 归一化与匹配规则。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Parser transport crash 应成为当前 file error 继续，还是 parent job fatal。 | 已知未知 | 高 | 一般 | Frozen TechDoc 明确留 E05-P0。 | BLOCK（后续） | E05-P0 对旧 handler/TaskLifecycle 做 mixed-result golden。 | E05-A 提供显式 transport-crash seam；未注入政策时 fail closed，不生成产品结果。 |
| Spool issue 在 strict/skip 下如何表达才不提前生成 repair token。 | 已知未知 | 高 | 容易 | 旧 parser 产生同一 issue；store 决定 rollback 或 excluded。 | PROBE | 对同一坏行跑旧 parser collectRowErrors 与新 Core 两种 disposition。 | 只改变 candidate kind：strict=`error`，skip=`excluded`；issue payload 原样等价。 |
| Reader 是否可在验证完成前把行交给真实 writer。 | 盲区 | 高 | 容易 | E05-A 禁止真实 writer；未来 writer transaction 可在 reader 完整结束前保持未提交。 | ASSUME（本 PR） | fake consumer 只读回放，并对 tamper/hash/count 做失败测试。 | Reader 流式校验并仅供只读/fake consumer；E05-B 必须在 COMMIT 前等待 reader 完整成功。 |
| Windows directory fsync unsupported 时能否仍保留 ready spool。 | 已知未知 | 高 | 容易 | 冻结 TechDoc 要求按平台能力 fail closed。 | PROBE | 注入 `capability=unsupported`。 | 删除本 file spool 并抛 `PREFUND_SPOOL_DURABILITY_UNAVAILABLE`。 |
| 本 PR 是否需要生产 Parser Pool。 | 已知事实 | 高 | 容易 | E05-C 才允许 Pool>1，production flag 固定 false。 | ASSUME | 静态检查 live handler/policy diff。 | 只交付 core、one-shot worker entry 和 coordinator component；不接生产 dispatch。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 抽出 Parser Core 候选流与 header identity。 | 金额/日期/长 ID/fingerprint/source sequence 零漂移。 | 旧 parser 与 Core golden 深比较。 | 资金语义漂移，立即停工。 | 删除 wrapper，旧 parser 不改。 |
| 2 | 实现固定目录 Spool v1 原子发布。 | `.part -> fsync -> .ready`、manifest last、source freshness。 | part/manifest/cancel/source-change/durability fault tests。 | 伪 ready 或残留污染。 | 生产未接线；删除新目录模块。 |
| 3 | 实现严格 Reader。 | identity/path/symlink/hash/count/schema/安全整数全部 fail closed。 | tamper/path/symlink/hash/count/source-change tests。 | 将未验证行交给后续 writer。 | Reader 拒绝，consumer 调用为 0。 |
| 4 | 实现 Ordered Coordinator seam。 | 乱序 ready/error 不改变消费顺序；consumer 单飞；transport crash 不猜产品映射。 | 乱序、业务错、取消、crash、backpressure tests。 | 未来多文件提交顺序漂移。 | 保持组件未接 live handler。 |
| 5 | 做 blindspot 与资金 closeout。 | source identity/amount/currency/repair/candidate order 只观察不变。 | 定向 test、ESLint、node --check、diff-check 与 review 记录。 | 不可提交。 | 保持 production false。 |

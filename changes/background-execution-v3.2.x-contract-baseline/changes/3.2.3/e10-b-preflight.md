# E10-B Unknowns Preflight

## Task Brief

- Goal: 实现 `new-account:save-as` 一等 `inline-async` 策略：异步复制既有 E10-A 业务 artifact 到 Main/task-owned staging，Main 完整复核后只交给既有 durable single FIFO Publisher。
- Context: exact parent 为已审查 E10-A `d073ced023b40feb477cf7557801a2899b433500`；E10-A 已冻结 workbook 生成、strict readback 与业务摘要，E10-B 只接复制/发布边界。
- Constraints: 不接 live IPC，不启用 production，不修改 E10-A 业务算法/字段/digest；`fs.promises.copyFile` 不得接 final target；不新增 Publisher、receipt、retry 或恢复方言；不得 blind replay。
- Done when: source identity/snapshot/hash、FilePlan/alias/symlink/TOCTOU、staging ownership/size/hash、业务 evidence 与单 Publisher 全部 fail closed；I/O lease/取消/退出/恢复证据及 E10-A golden 回归通过；production 保持 `false/legacy/0`。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 policy 已给出 exact `inline-async`/16 MiB/I/O=1 形态 | `validation/fixtures/valid/policy-registry.v3.2.x.json` 的 `new-account:save-as` | production policy 逐字段对齐 fixture，不发明第五种 mode |
| action binding 已冻结 canonical → legacy | `action-task-binding-registry.js`: `new-account:save-as → new-account:export` | 不改 public/legacy task identity，不切 live IPC |
| E10-A artifact 含 sheet/header/rowCount/template 与四个业务 digest | `new-account/generation-contract.js` | save-as Main expected evidence 复用此 bounded descriptor，不带 raw rows |
| E10-A cooperative strict readback 已结构化读取 worksheet | `generation-core.js#readBackAndValidateCooperatively`、`strict-worksheet-readback.js` | 扩展为 digest-only Main readback，保持现有 records golden 分支不变 |
| task staging 已有逐祖先 ownership/hardlink/realpath validator | `statement-worker/staging-ownership.js` | copy 前必须 missing，copy 后必须单链接普通文件；清理仅由该 ownership 授权 |
| FilePlan 已冻结 source/target snapshot 与 alias 检查 | `archive-center/file-plan.js`、`toolbox-target-identity.js` | source 与 target 必须各一且不互为 symlink/hardlink/platform alias |
| 既有 Publisher 的默认 dispatcher 是进程级单 FIFO | `toolbox-output-publication-dispatch.js` 的 module singleton `defaultDispatcher` | E10-B 只新增同一 singleton 的窄 wrapper；不得实例化第二 dispatcher |
| Publisher 自带 durable journal 与 crash recovery | `toolbox-output-publication.js`、`toolbox-output-publication-dispatch.js` | uncertain 只沿原 journal recovery；E10-B 不写 intent/receipt/retry |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| save-as source 的 Main business evidence 如何不携带 raw records 复核 | 契约边界 | 高 | 一般 | E10-A 已有四 digest + cooperative parser | PROBE | 用同一 parser 直接对 rowCount/digest 校验，跑 E10-A golden | 扩展现有 readback 接受 exact bounded evidence；原 records 分支不变 |
| 同一 FIFO Publisher 如何支持无需 archive handoff 的 save-as | 恢复边界 | 高 | 容易 | 默认 dispatcher 私有 singleton；core 支持 `requireArchiveHandoff=false` | PROBE | 为 singleton 增加窄导出并测试 FIFO/recovery | 复用同一 `defaultDispatcher.publish`，不调用 factory |
| copy 期间 source drift 能否唯一判定 | TOCTOU | 高 | 容易 | copy 前后 identity/snapshot/hash + staging hash 可交叉验证 | PROBE | before/during/after replacement fault tests | 任一 metadata/identity/hash不一致失败；同 bytes replacement也需 identity不变 |
| shutdown cancel 在不可中断 `copyFile` 中的边界 | 生命周期 | 中 | 容易 | inline adapter AbortSignal；copyFile 无通用 AbortSignal | ASSUME | 实际 heartbeat/quit test | 只在 before-copy 与 after-copy-before-publish safepoint取消；copy中等待 syscall，Publisher 尚未开始 |
| Windows packaged durable publication | 发布门禁 | 高 | 困难 | 合同明确要求 R3.2.3 packaged probe | BLOCK production only | Setup/portable 人工 fault probe | 不阻塞 dormant E10-B，production 必须保持 false |
| 真实资金 workbook 展示与业务摘要 | 资金门禁 | 高 | 困难 | 自动化只能证明 E10-A digest 不漂移 | BLOCK production only | 财务人工逐项复核 | 自动化不替代人工；不扩大 E10-B 业务语义 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 先写 E10-B contract/identity/copy/publisher 红测 | source/target/staging/恢复边界 | 目标测试稳定 RED | 推翻实现形态 | 仅保留测试与文档，不改 production |
| 2 | 实现 bounded copy contract 与 source currentness | 同 size/mtime replacement、copy partial/error | before/during/after drift 全 fail closed | 禁止进入 Main validation | 删除新模块即可回滚 |
| 3 | 接 FilePlan、ownership、business readback | alias/symlink/hardlink/outside/tamper | Publisher=0 mutants | 禁止 Publisher | 保持 dormant seam |
| 4 | 接 existing singleton FIFO Publisher | journal 为唯一 durable receipt/recovery | Publisher 0/1、failure/uncertain/recovery | 任务 interrupted/hold 由既有链负责 | 不新增 fallback/retry |
| 5 | 注册 dormant policy/runtime | I/O=1、CPU/Worker=0、cancel/quit | Governor acquire/release/reject 与 heartbeat | production 不可启用 | production 保持 false/legacy/0 |
| 6 | 全量回归与 blindspot pass | E10-A/资金/平台不漂移 | 定向、unit、integration、smoke、lint/check | 阻止交付 | 精确回退 E10-B commits |

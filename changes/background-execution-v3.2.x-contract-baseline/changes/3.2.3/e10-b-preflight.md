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
| E10-A Worker artifact 含 sheet/header/rowCount/template 与四个业务 digest，但它只是不可信观察 | reviewer真实自洽伪造probe、`new-account/generation-contract.js` | Main必须从冻结payload/asOf/template独立构造out-of-band bounded authority，不得把Worker自报值当expected |
| E10-A cooperative strict readback 已结构化读取 worksheet | `generation-core.js#readBackAndValidateCooperatively`、`strict-worksheet-readback.js` | 扩展为 digest-only Main readback，保持现有 records golden 分支不变 |
| strict scanner会把超出expectedColumnCount的cell计入used range后静默丢值 | reviewer真实J列秘密内容Publisher committed | 冻结exact column/used/dimension authority，任何超界cell/styled blank/merge/dimension fail closed |
| cached formula、calcChain、外链/超链接可在打开或重算后改变业务语义 | reviewerformula cached账户真实probe | generic scanner保留oracle兼容；Main authority显式禁止动态内容 |
| task staging 已有逐祖先 ownership/hardlink/realpath validator | `statement-worker/staging-ownership.js` | copy 前必须 missing，copy 后必须单链接普通文件；清理仅由该 ownership 授权 |
| FilePlan 已冻结 source/target snapshot 与 alias 检查 | `archive-center/file-plan.js`、`toolbox-target-identity.js` | source 与 target 必须各一且不互为 symlink/hardlink/platform alias |
| 重复normalize normalized FilePlan会重新采样targetSnapshot | reviewer absent→created真实覆盖probe | E10-B只消费进程内branded Main plan，原snapshot贯穿全部freshness checks |
| 既有 Publisher 的默认 dispatcher 是进程级单 FIFO | `toolbox-output-publication-dispatch.js` 的 module singleton `defaultDispatcher` | E10-B 只新增同一 singleton 的窄 wrapper；不得实例化第二 dispatcher |
| Publisher 自带 durable archive-handoff journal 与 crash recovery | `toolbox-output-publication.js`、`toolbox-output-publication-dispatch.js` | journal保留到Task artifact durable + Task终态ack；uncertain只沿原 recovery，E10-B不写第二receipt/retry |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| save-as source 的 Main business evidence 如何不携带 raw records 复核 | 契约边界 | 高 | 一般 | 共用row iterator可流式累计四digest | PROBE | 恶意自洽workbook与正确golden | Main authority流式生成；readback接受exact bounded evidence，原records分支不变 |
| Main authority在dispatch前同步遍历近上限记录是否阻塞 | 响应性/取消 | 高 | 容易 | 233536行实测约521ms、timer同量延迟 | PROBE | near-max heartbeat与mid-authority abort | async bounded batch + scheduler/cancel safepoint；取消不spawn Worker |
| Publisher committed到Task settlement崩溃窗口如何唯一恢复 | 恢复边界 | 高 | 一般 | 既有archive-handoff journal、startup recovery与ack seam | PROBE | hard-kill/回包丢失/pre-post settle/重复recovery | `requireArchiveHandoff=true`；settle后终态ack，禁止第二receipt/retry |
| inline terminate是否代表实际copy已停止 | 生命周期 | 高 | 容易 | 原adapter只closed/abort立即返回，真实slow-copy仍运行 | PROBE | slow copy shutdown/deadline/late terminal | adapter持有executionPromise；terminate/close await，Supervisor既有timeout负责leak evidence |
| target parent rename+ordinary replacement是否可识别 | FilePlan/Publisher合同 | 高 | 一般 | 现有targetSnapshot与symlink检查不能识别普通目录replacement；用户已授权最小公共合同增量 | PROBE | direct parent identity贯穿FilePlan/Publisher/journal真实FS故障注入 | 只冻结resolved direct parent，不保存ancestor chain；E10-B require reliable，旧action/journal兼容 |
| copy 期间 source drift 能否唯一判定 | TOCTOU | 高 | 容易 | copy 前后 identity/snapshot/hash + staging hash 可交叉验证 | PROBE | before/during/after replacement fault tests | 任一 metadata/identity/hash不一致失败；同 bytes replacement也需 identity不变 |
| shutdown cancel 在不可中断 `copyFile` 中的边界 | 生命周期 | 中 | 容易 | inline adapter AbortSignal；copyFile 无通用 AbortSignal | PROBE | 实际slow-copy heartbeat/quit/deadline test | copy中等待syscall；transport cleanup等待实际execution，超时显式leak并保留owner |
| Windows packaged durable publication | 发布门禁 | 高 | 困难 | 合同明确要求 R3.2.3 packaged probe | BLOCK production only | Setup/portable 人工 fault probe | 不阻塞 dormant E10-B，production 必须保持 false |
| 真实资金 workbook 展示与业务摘要 | 资金门禁 | 高 | 困难 | 自动化只能证明 E10-A digest 不漂移 | BLOCK production only | 财务人工逐项复核 | 自动化不替代人工；不扩大 E10-B 业务语义 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 先写 E10-B contract/identity/copy/publisher 红测 | source/target/staging/恢复边界 | 目标测试稳定 RED | 推翻实现形态 | 仅保留测试与文档，不改 production |
| 2 | 实现 bounded copy contract 与 source currentness | 同 size/mtime replacement、copy partial/error | before/during/after drift 全 fail closed | 禁止进入 Main validation | 删除新模块即可回滚 |
| 3 | 接 FilePlan、ownership、business readback | alias/symlink/hardlink/outside/tamper | Publisher=0 mutants | 禁止 Publisher | 保持 dormant seam |
| 4 | 接 existing singleton FIFO Publisher | journal 为唯一 durable receipt/recovery | Publisher 0/1、failure/uncertain/recovery | 任务 interrupted/hold 由既有链负责 | 不新增 fallback/retry |
| 5 | direct parent identity贯穿FilePlan/Publisher/journal | parent rename+ordinary replacement与恢复target mutation | prepare/stage/pre-commit/recovery全部fail closed | manual recovery/Hold | selector关闭；旧journal reader兼容 |
| 6 | 注册 dormant policy/runtime | I/O=1、CPU/Worker=0、cancel/quit | Governor acquire/release/reject 与 heartbeat | production 不可启用 | production 保持 false/legacy/0 |
| 7 | 全量回归与 blindspot pass | E10-A/资金/平台不漂移 | 定向、unit、integration、smoke、lint/check | 阻止交付 | 精确回退 E10-B commits |

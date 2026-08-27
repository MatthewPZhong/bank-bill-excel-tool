# E08-A BankBU Single One-shot Jobs Implementation Notes

## Baseline

- Goal/spec：`changes/background-execution-v3.2.x-contract-baseline/changes/3.2.2/spec.md` 与 `techdoc.md` 的 E08-A BankBU single job 合同。
- Initial plan：见同目录 `preflight.md`；先锁 identity/schema，再实现 transaction/CAS/Inspector，最后接 one-shot协议与artifact staging。
- Done when：production=false 的四个 capability、side/main恢复合同和定向证据齐全，既有 live IPC/算法/输出不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| E08-A 作为独立 capability，不修改现有 BankBU IPC | 任务明确不接live production，Platform要求legacy不得绕过Hold | 直接替换`src/main.js` handlers | 现有用户路径零变化，生产启用留后续门禁 |
| Main mirror多行同月直接fail closed | captured pre-image必须唯一，历史多run不能安全猜“当前” | 按MAX(id)隐式择一并删除其余行 | 合成历史冲突进入unknown/Hold，不丢历史 |
| operation lock覆盖prepare critical、side COMMIT与Main CAS整个callback | 若capture与settle分开持锁，同月mirror可在两段之间变化，虽然CAS会拦截但会制造可避免的partial/unknown | capture与settle分别短锁 | Main调用seam强制同月单锁；crash后仍由Inspector恢复 |
| 历史import receipt只有在当前dataset identity仍匹配时才允许exact replay | receipt是审计历史；同月后续import会合法覆盖当前dataset | 看到旧receipt即返回replay | 被新import取代的旧operation返回identity conflict/unknown，不谎报当前提交态 |
| export必须同时给task-private `stagingRoot`和其中的`stagingPath` | frozen policy要求FilePlan；Worker不得看到或写正式目标 | 仅信任任意绝对`stagingPath` | 拒绝路径越界/符号链接逃逸；Worker只返回单artifact manifest |
| Registry中import仍逐字段保持冻结`thread-pool/compound` policy，E08-A执行器只实现single | authoritative fixture是静态未来拓扑，任务明确E08-B dual parser不在范围 | 为当前single擅改冻结policy | production仍`false/legacy/0`；不创建parser child或live route |
| mutation复用Platform现有registered singleton unit `operation:000000` | Supervisor的worker-durable critical/receipt/done均以registered unit为所有权边界；job-level `unitId=null`会被权威协议拒绝 | 新造BankBU job-level durable分支 | `job:start`只初始化，唯一`unit:start`才执行；所有critical/receipt/unit terminal携带同一unitId，未引入E08-B role unit |
| Supervisor四段callback共享一个有界locked session | run必须在ACK前capture/persist preimage，且锁不能在side COMMIT与Main CAS之间释放 | 每个callback重新取同月锁 | 同月锁覆盖prepare/ACK→权威side receipt→Main CAS→双identity receipt/Intent close；inspection/Hold终态后释放 |
| exact replay仍为本次Supervisor execution重新走critical handshake | persisted side result只能免除算法与新side run，不能绕过本次registered unit的Intent/ACK/receipt/settle所有权 | replay直接在ACK前返回 | replay测试保持side run/receipt各1行，同时两次execution的critical计数为2 |
| managed export用同一side只读事务绑定identity与完整业务读取，并在artifact后fresh复核 | WAL允许第二连接在首读后提交；分离连接会产生旧runId配新dataset Excel | 先查identity、关闭连接、再用legacy loader重算 | single/aggregate任一Main选择或side state变化即删task-private staging并以`BANK_BU_EXPORT_SNAPSHOT_STALE`失败关闭，不增加跨月锁 |
| run算法读取Pending/Bank与dataset evidence共用一个side read snapshot，写事务再校验dataset hash | 若两个业务表分次读取，同月覆盖导入可在中间提交，形成跨dataset混合结果 | 只在算法前读一次hash | 新run在`BEGIN IMMEDIATE`内验证input evidence后才落side run/receipt；变化则零run写入失败关闭 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| export capability只负责Worker staging，正式Publisher由Main后续接线 | E08-A不接live；Platform artifact边界明确 | 不能作为production完整路径 | artifact测试明确目标目录零写；production仍false |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 无 | 无行为偏离 | 所有实现均落在E08-A production-false capability seam；未改权威业务合同 | 无 | 不需要 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| E08-A focused unit | `19/19 PASS` | policy exact、dataset/金额币种血缘、import/run事务、四态、singleton Worker协议、真实Supervisor+worker_threads正常settle/reply-loss/Hold |
| 相关BankBU/receipt/Supervisor unit | `141/141 PASS`（含上述19条focused） | month/run repository、side store、legacy dual-source、E06 receipt、Platform worker-durable/unknown-unit/settle/shutdown回归 |
| 真实临时SQLite/XLSX集成 | `21/21 PASS` | 两reader、critical前kill、side COMMIT后kill/restart、CAS complete-mirror、single/aggregate三sheet、included/skipped，以及single/aggregate真实双连接WAL并发变化后零artifact |
| 既有side-db parity | `17/17 PASS` | 1:1/1:N/N:1/N:M数据与输出golden不漂移 |
| 既有BankBU资金smoke | `41/41 PASS` | normalize、匹配基数、异常sheet、source row index、覆盖导入清旧run |
| changed JS ESLint / `node --check` / `git diff --check` | PASS | 静态语法、风格、patch空白；未运行禁止的release-check/check-vars/scan:vars |

## Blindspot Pass

| 盲区 | 处置 | 证据 |
| --- | --- | --- |
| capture与CAS之间的同月入口旁路 | coordinator只暴露`withRunOperationLock`，锁覆盖critical intent、side COMMIT和Main CAS | coordinator真实side/main测试在三段均断言锁仍持有 |
| 历史import receipt被新dataset覆盖后误报replay | receipt同时校验当前dataset operation/task/hash | superseded receipt单测返回unknown |
| Worker拿到正式目标路径 | task-private staging root做词法+realpath边界与symlink检查 | 越界路径单测零文件写入 |
| shutdown/cancel跨critical边界 | critical前可reject/cancel；ACK后进入protected，先receipt再done；Task settle留Main | protocol unit + 两个真实kill探针 |
| 同月多个Main mirror或并发变化 | 唯一pre-image失败关闭；CAS冲突只返回unknown | absent/old/concurrent三类单测 |
| live入口或E08-B旁路 | 未修改`src/main.js`/preload/renderer/Registry production selector，也未创建parser child | diff scope与policy exact fixture |
| mutation绕过registered unit或ACK identity错配 | mutation只响应唯一singleton `unit:start`；ACK绑定unit与fileOperationKey；operation context的taskRunId进入全部coordinator callback | host协议单测 + 真实Supervisor/worker_threads/SQLite端到端prepare计数与双identity settle |
| side COMMIT后reply丢失或Main identity并发冲突 | Inspector权威回读；partial只complete-mirror CAS，identity冲突创建Recovery Hold且不覆盖并发Main mirror | 真实Worker在side commit后exit的reply-loss与Hold测试 |
| export identity/read分离连接造成WAL TOCTOU | managed identity、dataset及完整Pending/Bank算法读取共用单一read transaction；artifact后复核Main选择与全部managed side state | single/aggregate分别在snapshot中由第二真实连接COMMIT新import，均报stale并删除staging |
| run Pending/Bank跨dataset混读 | 算法读事务固定dataset/Pending/Bank；side写事务再次验证dataset hash | critical期间第二连接覆盖导入后`BANK_BU_RUN_DATASET_CHANGED`且side run为0 |

## Reconciliation Blindspot Pass

| 资金/对账检查 | 结论与证据 |
| --- | --- |
| 主键与来源血缘 | dataset hash绑定月、角色、文件SHA、完整规范行、source row index及原始顺序；operationKey/taskRunId贯穿receipt/side run/Main mirror |
| 金额与币种 | 不做数值转换或币种归一；金额/币种原串进入canonical evidence，变更会改变dataset hash |
| 行数守恒 | import实际insert count写dataset；run totals来自同一side read snapshot且commit前hash再校验；parity/smoke覆盖四种基数及N:M行处置 |
| 幂等与重复 | exact replay要求operation/task/input/current dataset全等；identity冲突失败关闭；partial只读side committed result做CAS |
| 部分失败/恢复 | reader失败在事务前；import mutation/evidence/receipt同事务；run side先提交、Main后CAS；not/committed/partial/unknown由唯一Inspector决定 |
| 输出可审计性 | single/aggregate保留dual-source、月份升序、included/skipped、异常sheet与Main runId；managed identity与XLSX行来自同一snapshot，artifact后变化使整份staging删除 |
| 资金红线 | 自动证据通过不替代人工复核；Windows packaged、真实财务样本、真实恢复操作仍BLOCK production enablement |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged native SQLite、真实财务样本与人工恢复复核 | BLOCK production enablement | R3.2.2/用户人工门禁 | 不阻断production=false capability合并；禁止启用 |
| Main FilePlan technical/business validator、Publisher journal与Task settle的live接线 | 本PR明确不接live；保持capability seam | 后续production PR | 不阻断E08-A代码合并；任何live启用前必须补齐 |

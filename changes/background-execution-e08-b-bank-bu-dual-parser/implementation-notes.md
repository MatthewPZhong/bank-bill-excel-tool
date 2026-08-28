# E08-B BankBU Optional Dual Parser Implementation Notes

## Baseline

- Goal/spec：见 v3.2.2 Spec/TechDoc 的 E08-B optional dual parser，以及同目录 `preflight.md`。
- Initial plan：先锁 role/source/row spool identity，再让 E08-A import在critical前消费，最后增加optional gate/coordinator与验证。
- Done when：production=false/legacy/0 不变，dual与single资金数据及E08-A receipt/recovery合同等价，所有pre-critical失败零业务提交且spool已清理。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用BankBU专用role spool，不复用Duplicate业务spool schema | 两模块列、role、source序和错误契约不同；共享业务schema会耦合无关资金链路 | 给Duplicate contract增加BankBU union字段 | E08-B改动局限在BankBU worker目录。 |
| dual只替换E08-A reader准备阶段，Writer仍调用`buildImportEvidence`与`importCommittedDataset` | 复用E08-A operationKey/receipt/side事务/Inspector/Hold的唯一真相 | Parser自行写side DB或receipt | matching、mirror、恢复与资金语义零复制。 |
| Main coordinator只把既有`operation:000000`注册为业务unit；两个role Parser不注册Platform business unit | E08-A Worker mutation只响应singleton `unit:start`，Parser spool不是commit | job:start后不注册unit；给Parser伪造role unit/receipt | 真实Supervisor仍由同一Writer持有critical/receipt/unit done所有权。 |
| success outcome只由Main coordinator在真实Parser clean exit后发布；首个失败先abort sibling并等全部terminal再发布failure | 提前marker会让等待中的Writer/parent先终态并释放CompoundLease，留下未记账Parser | Parser自己把manifest当terminal；首失败立即结束parent | 两侧success才critical；failure/cancel cleanup晚于Parser和parent terminal。 |
| gate禁用、低内存或非双输入直接走E08-A single；Governor实际count=1时一个并发槽按Pending→Bank串行两Parser | frozen lowMemoryBehavior=`downgrade-to-single`，业务Writer始终唯一 | admission后取消dual再启动第二job | 不制造双job/双operation；production policy仍false/legacy/0。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 一个实际Parser并发槽可串行处理两role spool作为低资源single downgrade | frozen policy明确`downgrade-to-single`且Writer仍唯一 | 性能变差但业务不变 | topology/dispatch测试；若门禁口径要求direct reader，optional wrapper可固定gate false。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| E08-B focused unit | `10/10 PASS` | 真worker、role/month/source/row血缘、乱序parity、source-change、failure/cancel、tamper、gate/topology、静态禁DB/matching/receipt/mirror |
| E08-A + BankBU affected unit | `115/115 PASS` | E08-A policy/singleton/Supervisor/Inspector/side-main identity、reader/DB repository与dual-source旧路径 |
| E08-B真实XLSX/worker_threads/SQLite integration | `9/9 PASS` | 两Parser→single Writer、critical、receipt/Inspector、row order、后续matching、cleanup |
| E08-A single integration + side-db parity | `21/21 PASS`；`17/17 PASS` | crash/recovery/export snapshot与1:1/1:N/N:1/N:M golden未漂移 |
| 全量smoke | PASS；BankBU `41/41` | BankBU资金链与全仓相邻业务smoke无回归 |
| parser-only benchmark/RSS | 3,000行/role、五轮：single median 467.41ms，dual median 302.26ms，改善35.33%；peak RSS 512,671,744B/预算838,860,800B | 本机15%与RSS capability gate通过；production仍false/0 |

## Blindspot Pass

| 盲区 | 处置 | 证据 |
| --- | --- | --- |
| dispatcher只发`job:start`导致mutation永不执行 | 已修：direct/dual请求都注册唯一E08-A singleton Writer unit | request unit断言；E08-A host/Supervisor回归 |
| Parser完成顺序影响DB顺序 | descriptor按role固定slot，Writer明确先consume Pending再Bank | Bank先完成的parity测试，DB row_index/完整post-image一致 |
| success marker早于真实Worker exit | `runBankBuParserWorker`只在exit后resolve，Main随后发布success | 真worker state与bounded result测试 |
| sibling仍存活时parent/lease/spool提前释放 | 首失败abort后`Promise.allSettled` terminal barrier，随后failure outcome、parent terminal、cleanup | failure/cancel sibling observed abort与staging absent |
| source/manifest/rows在parse后变化 | snapshot+SHA与manifest/rows hash/count/role/month/op/owner多点复核，全部在critical前 | source、role manifest、rows内容三类反例均零critical |
| 低资源或门禁未过仍启dual | optional wrapper在lowMemory/非双输入/<15%/RSS超限时只调用direct single；actual count只读runtime snapshot | gate矩阵与topology 1/2测试 |
| live/production或后续scope旁路 | 未改main/preload/renderer/background runtime policy集合；BankBU policy fixture仍逐字段false/legacy/0 | E08-A policy test与diff scope |

## Reconciliation Blindspot Pass

| 资金/对账检查 | 结论与证据 |
| --- | --- |
| 主键与来源血缘 | month/role/source file SHA+snapshot、operationKey/taskRunId、`_rowIndex`与原始数组序贯穿spool到E08-A dataset evidence；tamper/source-change fail closed。 |
| 金额、币种、BU、账号 | Parser直接调用既有两reader，spool按冻结DB列保存字符串；不新增normalize/parse/rounding；single/dual完整side row parity。 |
| 行数与顺序守恒 | manifest row count、NDJSON count/hash、严格递增source row index、Pending/Bank固定采用；真实空行fixture保持`[2,4]`。 |
| 幂等与恢复 | 业务写仍由E08-A single transaction/receipt执行；operationKey、sideRunId、mirror、Inspector/Hold零改动；Parser spool不是恢复证据且终态清理。 |
| 部分失败 | 两侧全成功与source exact前零critical；失败/取消/source-change/篡改均零side mutation、零receipt、零mirror。 |
| 算法与输出 | 未改1:1/1:N/N:1/N:M、BU trim/lowercase、dual-source export或sheet/runId；parity、E08-A integration与smoke通过。 |
| 资金红线 | 自动证据不替代Windows packaged、真实月度财务样本及partial/unknown人工恢复复核；production禁止启用。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged、真实财务样本、真实partial/unknown人工恢复 | BLOCK production enablement | R3.2.2人工门禁 | 不阻断production=false capability；禁止启用。 |

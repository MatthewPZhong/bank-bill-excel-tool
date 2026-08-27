# E06-A FundRecon Service Implementation Notes

## Baseline

- Goal/spec：v3.2.2 Spec §3-§13；TechDoc §1-§3、§10-§12；E06-A FundRecon Service。
- Exact base：`aa160cbf351afbe21932a8c9a536fedb25136141`（E06-P0）。
- Initial plan：[preflight.md](./preflight.md)。
- 当前交付边界：production-false capability + Draft PR；真实大样本 RSS、Windows、人工资金复核与 Main live adapter 未闭合，禁止 managed enable。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 完整 session/result 只存在 Worker | frozen Spec 的单一所有者要求；JobEnvelope 256 KiB | Main 与 Worker 双镜像；payload 直接传 rows | managed import 传文件引用；Main 只持有 bounded token/summary |
| Worker 用只读 SQLite transaction 取 scenario/link evidence | AppDatabase init 有 migration/写副作用；证据真值在 Main DB | Worker 构造 AppDatabase；Main 把完整 linked rows 塞 envelope | 快照一致且不越过 DB writer 边界 |
| 复用既有 reconciliation orchestrator | 已冻结轮次和候选消费语义 | Worker 重写/拆分算法 | 最大化 golden 等价，禁止轮次并行 |
| state adoption 必须等待 PersistentReservation adopt ACK | Platform ServiceHost 合同 | 先 publish state 再补资源；OOM 时清旧 state | reservation reject/ACK loss 保留旧 stable state |
| scenario/link signature 是 export 的最终安全门 | invalidate ACK 不是持久提交证明 | 只相信内存 invalidated 标志 | ACK 丢失或 Main/Worker不同步仍不能导出旧结果 |
| status/invalidate 不新增静态 action 或协议 operation | frozen registry 只有 import/run/export，ServiceControl operation 集封闭 | 新增 `fund-recon:status`；把 invalidate 伪装成 run | core 暴露 bounded status/invalidate；action result 返回 revision/summary；远端显式 adapter 仍阻断 production |
| export 只生成 staging FilePlan bundle | commit.kind=`main-settlement`，Main 是 Publisher | Worker直接写最终目录/settle | Worker crash不会产生被误认作已发布的文件 |
| 每个 Worker 主动 ServiceControl exchange 使用新 controlId | 真实 native Worker 首次运行被 generation tombstone 以 `SERVICE_CONTROL_ID_REUSED` 拒绝 | 复用 init/request ID 启动 ready/adopt exchange；放宽 Host | ready、resource request、resource adopted 各自唯一；response 只复用所属 exchange ID |
| staged 文件使用流式 SHA-256 | 整文件 `readFile` 会让大输出产生额外 RSS 峰值 | 一次性读入 Buffer | hash 内存与文件大小解耦；byteSize 同步计数并限制 safe integer |
| 退款 marker 只形成 manifest settlement instruction | legacy 是写盘成功后 Main 更新 marker；Worker DB 必须 read-only | Worker 直接更新 marker DB；忽略跨期提醒 | 写盘前注入提醒；未来 Main 在 Publisher 成功后精确推进；读取失败时 `skipped` 且绝不推进 |
| production=false 下不替换 live IPC | Windows/人工/golden gates 未闭合 | 合并即切 live traffic | legacy 行为零漂移；managed adapter 可独立验证 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证/回滚 |
| --- | --- | --- | --- |
| 文件引用可由 Worker 在 job 生命周期内稳定读取 | Main 已完成 picker，managed job持 operation lock | 用户/外部改文件会导致 source drift | 当前在 Worker 内同步读取；live adapter 的 source fingerprint 仍待补，保持 production=false |
| Main DB read-only BEGIN 提供足够 evidence snapshot | SQLite WAL/read transaction | 非 DB 文件 evidence 可能遗漏 | signature 明确列入来源；遗漏则保持 production=false 并补 probe |
| manifest bundle 可容纳 legacy 多文件输出 | policy 的一个 artifact 指一个 result manifest，不等于一个业务文件 | validator 若限制 entries=1 | 收缩为单 bundle staging seam，不更改冻结 policy |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| Spec 写 `import/run/export/status/invalidate` | 静态 action仍严格只有import/run/export；core status/invalidate已实现，Platform v1无远端独立operation | 不能为一个模块扩展冻结 ServiceControl 方言 | export signature仍最终fail closed；显式远端status/invalidate未闭合，阻断production | 否；冻结基线不在本PR改写 |
| legacy 可分别尝试多个可选 writer | managed staging 任一 writer 失败即清理全部 planned 文件 | canonical artifact 要求 all-or-none，不能发布半套输出 | 更严格的失败语义；production=false 下不改变用户路径 | 不需要；符合 Spec §10 |
| 退款 marker 在 legacy export 内直接结算 | Worker 只生成 `ready/skipped/not-applicable` settlement instruction | Worker不能写Main DB，Publisher前不得推进marker | Main settlement adapter未接线前禁止production | 不需要；符合Main settlement owner边界 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact base / canonical checksum | Base `aa160cbf351afbe21932a8c9a536fedb25136141`；Spec `0cdf28e5310733355fb51d92818dde8fd837ee06b521a4694c0c9cc43300d47f`；TechDoc `9fd15a46b482e6801616554978dff67a02676b437b9759e18d15fce29dcff209`；policy fixture `8ab98e4b7a7b0c669892f069881c25eaaf1f8241b1e7d71e5b63eed8b2c38a22` | 防基线/合同漂移 |
| E06-A focused tests | `24/24 PASS`（policy/service/evidence/artifact/footprint/host/真实 runtime/source reader） | action/service、state adoption、stale、staging、真实 Worker protocol |
| 真实 native Worker | 两次真实 XLSX import 在同一 Service 内 revision 1→2；PersistentReservation replace/adopt完成；shutdown `leakedTransports=[]`、`errors=[]`、Governor lease/dependency=0 | init/ready、request/grant、adopted/ack、generation、资源释放与结果脱敏 |
| service/inline golden | 相同 input/evidence 使用既有 `runReconciliation`，逐字段比较 result且行数守恒；既有资金轮次/全部场景引擎 `1012/1012 PASS` | R1→R5/M2M编排、first-match/no-op、金额币种、候选消费、标黄字段 |
| Platform 回归 | registry/action binding/protocol/adapters/packaged request/E05-C `100/100 PASS` | 未放宽Platform v1、122-key inventory、ServiceHost correlation与既有Worker |
| 最终组合回归 | E06-A focused + runtime inventory + Platform targets + E05-C `133/133 PASS` | 最终 runtime 注册改动与既有静态 inventory 同步且无回归 |
| invalidation/export focused | signature drift、derivation缺失/过期、database identity、invalidate adopt ACK loss均fail closed | scenario/link/date/派生数据 stale result不可导出 |
| artifact staging focused | `6/6 PASS`：lexical/physical symlink escape、业务输出与manifest dangling leaf symlink、path alias、pre-existing target、writer fault cleanup、单manifest hash、退款marker settlement | `lstat` 拒绝任何既存 leaf entry（含 dangling symlink）；all-or-none、Main Publisher/settlement ownership、路径安全、低RSS hash |
| state footprint/十轮 | 共享引用去重、35% headroom、4KiB page、256MiB边界与连续十轮当前-state替换通过 | 证明 estimator 不累计历史 graph；**不是**真实进程 RSS/大样本证明 |

## Blindspot Self-review

| 维度 | 结论 | 证据/剩余风险 |
| --- | --- | --- |
| 入口旁路 | 三action全部注册到同一native entry，production=false；live Main handler未切换 | policy fixture parity + runtime production request拒绝 |
| 边界 | command只传文件/DB/staging引用；结果只含bounded summary/revision/stats或单manifest artifact | validator + 真实runtime结果不含source temp path；stagingPath属于Publisher私有artifact合同 |
| 失败模式 | reservation reject/ACK loss保留旧stable state；evidence drift、DB identity、derivation stale fail closed；writer fault全清理 | focused fault tests |
| 状态生命周期 | busy reject、不排队；revision只在adopt ACK后推进；shutdown release exactly once | core + host + real Worker tests |
| 兼容性 | 复用同一orchestrator/readers/writers；legacy live path不变 | 1012资金回归；managed可选writer失败语义收紧为all-or-none |
| 可观测性 | progress只发bounded round DTO；stable result不含rows/source path；production flag明确关闭 | runtime/validator tests |
| 测试缺口 | 未做Windows packaged、657k入金表/真实大样本process RSS、source mutation、live Main Publisher/settlement | 全部列为production blocker，不以estimator代偿 |

## Reconciliation Blindspot Self-review

| 维度 | 结论 | 证据/红线 |
| --- | --- | --- |
| 主键/候选血缘 | Service把同一working bank/refund/recon clones交给既有orchestrator，不重建candidate bucket、不并行轮次 | inline golden + 1012回归；真实样本仍需人工抽查 |
| 金额/币种 | 未新增金额解析、容差、币种normalize或比较逻辑 | 全量scenario engine回归通过；production enable前仍需人工资金复核 |
| 时间边界 | date policy、scenario、linked meta、derived recon rows进入持久evidence signature；export重算 | evidence drift tests；时区/跨月真实样本仍人工核对 |
| 幂等/重复 | import/run只有adopt ACK后替换；automatic retry=false；staging target已存在时拒绝 | policy + state/staging tests |
| 部分失败 | run fault不覆盖旧result；writer fault无残留；marker read失败只`skipped`，不推进marker | focused fault matrix |
| 行数守恒 | `modifiedRows + unmatchedRows === bankRows`继续由原orchestrator保证 | service golden + 1012回归 |
| 输出去向 | Worker仅写私有staging；manifest绑定每个文件hash；Main仍负责technical/business validation、Publisher、marker settlement | artifact tests；Main adapter未接线前production=false |
| 人工红线 | first-match、同值no-op、退款/调拨回填、标黄、真实金额币种仍要求人工review | 自动测试不能解除资金红线 |

## Remaining Unknowns

| 未知 | 处理 | 合并影响 |
| --- | --- | --- |
| Windows packaged worker/native SQLite | R3.2.2 release evidence / manual | 不阻断 production-false E06-A；阻断 enable |
| 真实业务样本 first-match/同值 no-op/回填标黄 | 人工资金复核 | 不阻断 scaffolding；阻断 enable |
| 真实进程 RSS 与 657k `bank-deposit` 全表读取 | 大样本benchmark；在不漏候选前提下才能窄化读取 | estimator证据不可代偿；阻断FundRecon managed enable |
| remote status/invalidate 与 source fingerprint | Main managed adapter / 后续冻结合同 | core与signature安全门已存在，但显式用户态/变更态通道未闭合；阻断enable |
| Main实时调拨派生、Publisher、退款marker settlement与rollback drill | Main adapter + R3.2.2 policy gate | Worker保持DB read-only；未接线前禁止live traffic |

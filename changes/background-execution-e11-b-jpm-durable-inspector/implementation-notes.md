# E11-B JPM Worker-durable / Inspector Implementation Notes

## Baseline

- Exact base：`1d9588a7e5303e9b8a5621095c445d7a9c1c6005`。
- Review remediation 起点：`6b239559c8e219f32651abd0514a1d67ef30f976`。
- 第二轮 Review remediation 起点：`74bb75468c3d1e30fe889a3ca751168ce48e8547`。
- 第三轮 Review remediation 起点：`615cf64992917221be0890a7270518c98fe57ffd`。
- 第四轮 Review remediation 起点：`71c1ac1066613f2009b4dfcd5e43dc1d2a735b65`。
- Frozen contract：v3.2.4 Spec/TechDoc、Platform critical/recovery contract、E11-A 与 E11-P0 notes。
- Preflight：[preflight.md](./preflight.md)。

## Decisions

| 决定 | 原因 | 影响 |
| --- | --- | --- |
| JPM 使用 runtime 私有固定 single unit | Platform critical lifecycle 以 unit 持有 intent/receipt state，而 ReconFix API 是单 operation | public request 不暴露或接受自定义 critical unit identity；PreFund 多 unit 不变 |
| ADM conflict scope 为模块级固定 scope | JPM plan/transaction 与 legacy writer都观察/写回整张 ADM image | 任一 unknown 阻断所有 JPM mutation，但不阻断 standard/BOC readonly run |
| Inspector 直接 read-only 打开原主库 | WAL 未 checkpoint 的 committed receipt/post image 仍须可见 | 不复制 `.sqlite`，不遗漏 `-wal/-shm`，不改变原 DB family |
| 已有 receipt 或已 ACK/committed Intent 不重新进入 mutation | crash/replay/stale 不得猜测或自动重跑 | caller 得到 fail-closed；Inspector/人工恢复是唯一后续 authority |
| JPM database path 由 Main 在 runtime generation 创建时固定 | caller 可选 path 会让 Worker mutation 越过 Main control DB authority | public input 拒绝 `databasePath/databaseIdentity`；Worker critical 只回传 path 的 canonical digest，Main 在 ACK 前 exact 比较；path 不进入 result/status/error |
| JPM ADM durable lease 由 control DB partial UNIQUE 约束 | 两个 runtime/coordinator 的 query-then-create 会竞争同一整表写集合 | 每个 scope 最多一个非 closed JPM Intent；同/换 Worker 都不得重新 ACK；legacy JPM 的读与最终写各自用同一同步 gate 检查 Hold/open Intent |
| prepared + ACK 在一个 Main control transaction 提交 | Worker 只应看到完整持久 ACK，不能留下 create-prepared 半状态 | ACK transition 故障会整体 rollback，Worker 不进入 mutation |
| candidate adoption 由 Main receipt waiter 授权 | Worker 发出 `commit:receipt` 与 resource request 属于不同 channel，不能只依赖到达顺序 | mutation candidate 仅在 Inspector 同快照确认 authoritative receipt/current post、Intent committed 后获 grant；receipt 丢失/冲突不会采用 full candidate |
| Inspector 先查唯一 receipt，再在同一 read transaction 读取 ADM image | receipt 与 current post 必须属于同一 WAL snapshot | exact receipt + post 才是 committed；无 receipt + pre 才是 not-committed，其余均 unknown |
| recovery 不重建 full result | E11-B 的 full candidate 只存在 Worker Service 私有 map，crash 后不可安全复原 | 首次 definitive inspection 仍按既有 interrupted 收口；unknown 建 Hold 后，人工修复得到 committed/not-committed 时复用 Task begin/complete recovery，把 observation、Intent close、Task failed 与 Hold resolve 放入一个 control transaction，第三次 startup 零动作 |
| JPM 只在 exact fixed `unit:start` 后执行 Service plan | `job:start` send 栈内的 stale/invalid 同步终态会被 Host 当作 generation protocol failure | stale/invalid 只终结当前 job；同一 generation、同一已导入 session 可继续合法 run；不改通用 result binding 协议 |
| Worker instance 只以 canonical digest 进入 durable/in-memory adoption identity | raw Worker UUID 既不应进入持久 evidence，也可能触发 finance-safe 账号模式 | evidence 与 receipt waiter 存储/比较同一 SHA-256 identity；同 Worker 与换 Worker replay 均拒绝，raw ID 不进入状态或错误 |
| startup 按 requestKey exact 恢复 prepared transition owner | live `mark-committed`/`close` owner 可在独立 reserve COMMIT 后、control transaction 前崩溃；startup 重新构造的安全摘要不是首次 exact request | Main-internal owner reader严格回验 persisted JCS/hash/eventId/createdAt 后原样 replay；普通 changed-body reserve 仍 conflict，不放宽 owner 合同 |
| JPM recovery plan 读取模块私有 Task state 投影 | `INSPECTOR_UNAVAILABLE` Hold 的既有 Task 可能是 ordinary running，也可能已 interrupted，不能仅凭 active Hold 猜状态 | threshold 新建 Hold 时把必要 interruption 与 observation/Hold 同 control transaction；重启按 Hold reason + persisted Task state 选择合法边，非法 identity/recovery attempt fail closed |
| bank/mid source 与 ADM replace 共用 JPM durable scope gate | ACKed Intent/active Hold 下 source import/delete 会间接重建全局 ADM image | bank-deposit/mid-allocation 在 source write 前检查；真实 `replaceAdmBankDeposit` 同步边界复检；gate 拒绝不进入历史派生兼容 catch |
| threshold bundle 先恢复、再做新 inspection | `task-run.mark-interrupted` requestKey 不含 reason/message/metadataPatch，不能把旧 `INSPECTOR_UNAVAILABLE` owner 当成新 definitive body | prepared threshold observation attempt/owner 作为 anchor；严格验证后用普通 exact reserve 回验 Task/Hold，并把旧 observation+Hold+Task 原子提交；随后以 active Hold 进入既有 definitive recovery |
| threshold observation anchor 必须先于 Task/Hold owner 且原子完整 | 第三轮仍按 Task owner → Hold owner → attempt → observation owner 排序；已有 Hold + running Task 也会先 reserve Task；这些独立提交点均可能留下无法证明 payload 的残留 | 单个短 `BEGIN IMMEDIATE` 同时写 attempt、绑定 requestKey、写 observation owner；无/已有 Hold 都先 anchor，再 normal-exact reserve Task/Hold，任一后续 crash 均从完整 anchor resume |
| 只迁移 71c1 可证明的 incomplete threshold gap | 无 Hold 时可能留下 Task-only、Task+Hold、Task+Hold+unbound-attempt；已有 Hold 时可能留下 Task-only、Task+unbound-attempt；这些状态没有 observation payload authority | startup 在 Inspector 前按 source/scope/active Hold 分类；同事务逐字节核验 deterministic Task/Hold exact body 后删除 incomplete owner/unbound attempt；不构造旧 observation、不关闭 Intent，随后才允许新 Inspector |
| prepared body-divergent replay 只允许 committed Intent | live `observeReceipt/settleCommitted` 的 mark-committed/close owner 必须可跨 crash exact 续写，但 Task/Hold phase 不能复用不同 body | 默认 reserve 恢复 exact conflict；只有 expected `acked→committed` 与 `committed→closed` 的 Intent transition 可取回 persisted exact request |
| JPM 使用独立 result validator | 不能因新增 bounded JPM terminal shape 放宽 E11-A import/standard/BOC validator | readonly validator 继续拒绝 JPM result，runtime 按 action 绑定 validator |

## Assumptions

- committed 后 candidate 丢失时只收口 durable DB outcome：首次 inspection 标记 interrupted；已有 unknown Hold 的人工收敛复用合法 recovery transition 终结为 `RESULT_LOST` failed；E11-B 不跨 Worker 重建 full result。
- production false 阶段 managed JPM 只由定向测试/显式 non-production runtime 调用；live IPC 仍走 legacy，但受同一 ADM Hold gate。

## Deviations

- Reviewer P2-2（同一 Worker 连续 unit/job result cross-binding）经负责人裁决为 fault-adapter-only 不可达路径，本轮明确不实现，也不扩展 Supervisor 通用协议或缓存。

## Review findings 与裁决

| Finding | 裁决与最小修复 | 定向证据 |
| --- | --- | --- |
| P1 caller 可选 databasePath | 接受；改为 runtime-generation-owned path + critical database digest + Main ACK exact compare | A/B 两库 caller override 与 ACK drift 均在 critical 前拒绝，A/B ADM/receipt 不变 |
| P1 ADM scope 缺少全局 durable exclusivity | 接受；增加幂等 partial UNIQUE，禁止任意同 operation 再 ACK，legacy 读/写各查 Hold/open Intent | migration、两个 coordinator/runtime、同/换 Worker replay、真实 legacy gate 测试 |
| P1 unknown 无法收敛 definitive | 接受；active same-source Hold 进入既有 Task recovery transition，和 observation/Intent/Hold 同 control transaction | unknown→committed、unknown→not-committed 与第三次 startup 幂等测试 |
| P2 synchronous pre-critical reject 终止 Service generation | 接受；JPM plan 延后至 fixed `unit:start`，不改变其它 action eager 路径 | import→stale→同 generation 合法 JPM run，无需重导入 |
| P2-2 unit/job result cross-binding | 拒绝；仅伪造 fault adapter 可制造，不属于可达生产路径 | 未新增通用 Supervisor 协议/缓存，既有 Supervisor 全回归通过 |

### 第二轮 Review findings

| Finding | 裁决与最小修复 | 定向证据 |
| --- | --- | --- |
| P1 prepared owner 后崩溃导致 startup request body conflict | 接受；只为 Main-internal startup 增加 exact prepared transition request resume，逐项验证 requestKey/writer/JCS/hash/event identity，不修改 reserve conflict 语义 | 真实磁盘 DB 的 live mark-committed/close 两个 reserve 后故障窗口，第二次 startup 收敛、第三次零 control action |
| P1 INSPECTOR_UNAVAILABLE Hold 与 running Task 状态冲突 | 接受；新增 JPM 私有 Task state reader；threshold 原子 interruption，definitive 恢复按 reason/state 复用既有 mark-interrupted/begin/complete 合法边 | committed/not-committed 两条 transient-threshold→重启→definitive→再重启矩阵 |
| P1 linked source mutation 绕过 ADM durable lease | 接受；bank/mid import 和 bank delete 在 source write 前 gate，ADM replace 同步边界再次 gate，拒绝错误向 caller 传播 | ACKed Intent 下真实 bank source/ADM 零变化；active Hold 下真实 rebuild 未进入 replace、source/ADM image 零变化；Main 两入口静态顺序锁 |

### 第三轮 Review finding

| Finding | 裁决与最小修复 | 定向证据 |
| --- | --- | --- |
| P1 prepared threshold owner 被新 definitive phase 按 requestKey 盲回放 | 接受；撤销 generic transition blind replay；新 inspection 前只对 JPM exact threshold observation anchor 完成旧 Task/Hold/observation bundle，body 不兼容即 fail closed；live committed Intent 两条 exact resume 保留 | 真实磁盘 owner-reserve 后 crash：committed/not-committed 均验证首启 Task running/Hold 0/prepared owner 3/attempt 1，二启最终 Task/Hold/Intent 且 prepared owner/attempt 清零，三启零 control action；另证 Task body 不兼容时 Intent 保持 acked；原 mark-committed/close case 保持通过 |

### 第四轮 Review finding

| Finding | 裁决与最小修复 | 定向证据 |
| --- | --- | --- |
| P1 threshold persistence 在完整 observation anchor 前提交 Task/Hold owner | 接受；新增单事务 `reserveObservationAnchor`，原子写 attempt + requestKey bind + observation owner；之后才按 Task→Hold normal-exact reserve；已有 Hold 的 Task transition 也使用同一顺序；对 71c1 只清理可证明 legacy gap，exact body 不兼容继续 conflict，Intent 不先关闭 | 真实临时 SQLite：anchor owner trigger 故障证明 attempt/owner 全 rollback；无 Hold 的 Task/Hold owner crash 四路与已有 Hold 的 Task owner crash 两路均二启先恢复 bundle、三启零动作；无 Hold 三种 legacy gap 六路与已有 Hold 两种 gap 四路均在 Inspector 前清零旧 gap、二启收敛、三启 owner/attempt 数量不变 |

## Evidence

- `tests/unit/main-process/recon-id-fix-jpm-durable-e11-b.test.js`：45/45 PASS；第四轮新增 17 个真实磁盘 case，覆盖原子 anchor rollback、无/已有 Hold 的 Task/Hold owner 后 crash 六路、71c1 无 Hold 三种 gap 六路与已有 Hold 两种 gap 四路；原 mark-committed/close、incompatible Task body + ACKed Intent、global ADM gate 全部保持通过。
- RecoveryControl / recovery platform：74/74 PASS；E11-P0 + E11-A + Supervisor/ServiceHost + PreFund E05-B + linked 派生：208/208 PASS。
- 定向 integration：RecoveryControl 27/27、recovery canary 9/9、linked streaming 19/19、gateway upsert 40/40、linked delete/rebuild 73/73 PASS；未运行任务明确禁止的 `release-check` / `check-vars` / `scan:vars`。
- 本轮 3 个变更 JS `node --check`、affected ESLint 与 `git diff --check` 通过。
- production gate 断言 `recon-fix:run-jpm` 仍为 false；Main live IPC 未切 managed，standard/BOC 与 PreFund 回归保持通过。

## Reconciliation blindspot pass

- 主键/顺序/行数：沿用 P0 canonical reader/plan，critical evidence 与 receipt 固定 `rowCount + idSequenceDigest + pre/post image hash`；mutation 只按已验证 exact id，不按数组下标猜行。
- 幂等/部分失败：no-op 不进入 critical/transaction/receipt；operation receipt、Intent 与 candidate adoption 三处拒绝 replay；ADM mutation 和 receipt 仍由 P0 `BEGIN IMMEDIATE` 原语同事务提交。
- 金额/币种/标志：JPM legacy engine 与既有 workbook/ADM 输入保持同源，E11-B 不新增金额或币种算法；定向 engine/parity 回归通过，三个 writeback 字段边界由 P0 plan 保持。
- 可观测性/敏感边界：Worker/Main 只交换 hash、count、opaque handle 与 bounded summary；坏 JSON 只返回有限脱敏 id token，不回传 `raw_json`、full rows、文件路径或 candidate。
- authority/并发：runtime generation 私有持有 canonical DB path；critical 只携带 DB identity digest，control DB partial UNIQUE 决定全局 ADM scope ACK 胜者；legacy 读/写边界都观察同一 Hold/open Intent 集合。
- 资金红线：真实 JPM 样本逐行金额、币种、匹配标志、receipt 与 crash 后 DB 复核仍要求资金负责人手工确认；本地自动测试不能替代该 gate。

## Remaining unknowns

- Windows packaged SQLite/WAL lock 与 abrupt process crash 行为仍需 production enable 前动态验证。
- 多进程真实 legacy/managed 并发的 SQLite 锁时序仍需 production enable 前动态验证；当前已覆盖两个 runtime/coordinator 共用真实 control DB 的竞争与 DB 唯一约束。
- 真实 JPM 样本逐行金额、币种、标志与 receipt 复核必须由资金负责人完成。
- production enable、live managed routing、结果重建/导出与任何 Publisher/VCC 接线均留给后续冻结块；本实现不声称这些路径已可发布。

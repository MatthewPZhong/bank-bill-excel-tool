# E11-B JPM Worker-durable / Inspector Implementation Notes

## Baseline

- Exact base：`1d9588a7e5303e9b8a5621095c445d7a9c1c6005`。
- Review remediation 起点：`6b239559c8e219f32651abd0514a1d67ef30f976`。
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

## Evidence

- `tests/unit/main-process/recon-id-fix-jpm-durable-e11-b.test.js`：18/18 PASS；除原 11 项外，新增 A/B database authority、真实 schema migration probe、DB-enforced scope race、同/换 Worker replay、legacy 双 gate、stale→same-generation 合法 run，以及 unknown→committed/not-committed 原子收敛与第三次 startup 幂等。
- E11-P0 + E11-A：29/29 PASS；Supervisor/ServiceHost/recovery/toolbox：163/163 PASS；PreFund/standard/BOC/legacy JPM：117/117 PASS。
- 完整 `npm run test:integration`：51/51 scripts、2455/2455 assertions PASS；runner 自动耗时快照已从工作树还原，未混入提交。
- `src/` 全量 ESLint、全部 15 个变更 JS `node --check` 与 `git diff --check` 通过。
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

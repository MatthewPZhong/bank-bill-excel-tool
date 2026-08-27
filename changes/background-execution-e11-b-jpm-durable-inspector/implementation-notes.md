# E11-B JPM Worker-durable / Inspector Implementation Notes

## Baseline

- Exact base：`1d9588a7e5303e9b8a5621095c445d7a9c1c6005`。
- Frozen contract：v3.2.4 Spec/TechDoc、Platform critical/recovery contract、E11-A 与 E11-P0 notes。
- Preflight：[preflight.md](./preflight.md)。

## Decisions

| 决定 | 原因 | 影响 |
| --- | --- | --- |
| JPM 使用 runtime 私有固定 single unit | Platform critical lifecycle 以 unit 持有 intent/receipt state，而 ReconFix API 是单 operation | public request 不暴露或接受自定义 critical unit identity；PreFund 多 unit 不变 |
| ADM conflict scope 为模块级固定 scope | JPM plan/transaction 与 legacy writer都观察/写回整张 ADM image | 任一 unknown 阻断所有 JPM mutation，但不阻断 standard/BOC readonly run |
| Inspector 直接 read-only 打开原主库 | WAL 未 checkpoint 的 committed receipt/post image 仍须可见 | 不复制 `.sqlite`，不遗漏 `-wal/-shm`，不改变原 DB family |
| 已有 receipt 或已 ACK/committed Intent 不重新进入 mutation | crash/replay/stale 不得猜测或自动重跑 | caller 得到 fail-closed；Inspector/人工恢复是唯一后续 authority |
| prepared + ACK 在一个 Main control transaction 提交 | Worker 只应看到完整持久 ACK，不能留下 create-prepared 半状态 | ACK transition 故障会整体 rollback，Worker 不进入 mutation |
| candidate adoption 由 Main receipt waiter 授权 | Worker 发出 `commit:receipt` 与 resource request 属于不同 channel，不能只依赖到达顺序 | mutation candidate 仅在 Inspector 同快照确认 authoritative receipt/current post、Intent committed 后获 grant；receipt 丢失/冲突不会采用 full candidate |
| Inspector 先查唯一 receipt，再在同一 read transaction 读取 ADM image | receipt 与 current post 必须属于同一 WAL snapshot | exact receipt + post 才是 committed；无 receipt + pre 才是 not-committed，其余均 unknown |
| recovery 不重建 full result | E11-B 的 full candidate 只存在 Worker Service 私有 map，crash 后不可安全复原 | committed → Intent close + Task `RESULT_LOST` interrupted；not-committed → `NOT_COMMITTED` interrupted；unknown → `INSPECTION_UNKNOWN` interrupted + ADM Hold |
| JPM 使用独立 result validator | 不能因新增 bounded JPM terminal shape 放宽 E11-A import/standard/BOC validator | readonly validator 继续拒绝 JPM result，runtime 按 action 绑定 validator |

## Assumptions

- committed 后 candidate 丢失时只收口 durable DB outcome 并把 Task 标为 interrupted；E11-B 不跨 Worker 重建 full result。
- production false 阶段 managed JPM 只由定向测试/显式 non-production runtime 调用；live IPC 仍走 legacy，但受同一 ADM Hold gate。

## Deviations

无。

## Evidence

- `tests/unit/main-process/recon-id-fix-jpm-durable-e11-b.test.js`：11/11 PASS；真实 Worker/Service/SQLite 覆盖 mutation、exact no-op、stale revision、receipt authority 拒绝、receipt-first WAL Inspector、ID 变化/receipt conflict/坏 JSON、ACK 原子故障、COMMIT 后 event 丢失、protected cancel、pre-critical shutdown cancel、unknown Task/Hold 与 replay。
- `node --test` 定向组合：E11-B + E11-P0 + E11-A 共 40/40 PASS；更宽的 JPM engine、ADM repository、Supervisor、ServiceHost、PreFund worker-durable 与 toolbox runtime 组合为 246/246 PASS。
- `scripts/integration/background-execution-recovery-control.js`、`background-execution-recovery-canary.js`、`background-execution-pure-compute-canary.js` 共 45/45 PASS。
- 变更 `src/**/*.js` 的定向 ESLint、全部变更 JS `node --check` 与 `git diff --check` 通过。
- production gate 断言 `recon-fix:run-jpm` 仍为 false；Main live IPC 未切 managed，standard/BOC 与 PreFund 回归保持通过。

## Reconciliation blindspot pass

- 主键/顺序/行数：沿用 P0 canonical reader/plan，critical evidence 与 receipt 固定 `rowCount + idSequenceDigest + pre/post image hash`；mutation 只按已验证 exact id，不按数组下标猜行。
- 幂等/部分失败：no-op 不进入 critical/transaction/receipt；operation receipt、Intent 与 candidate adoption 三处拒绝 replay；ADM mutation 和 receipt 仍由 P0 `BEGIN IMMEDIATE` 原语同事务提交。
- 金额/币种/标志：JPM legacy engine 与既有 workbook/ADM 输入保持同源，E11-B 不新增金额或币种算法；定向 engine/parity 回归通过，三个 writeback 字段边界由 P0 plan 保持。
- 可观测性/敏感边界：Worker/Main 只交换 hash、count、opaque handle 与 bounded summary；坏 JSON 只返回有限脱敏 id token，不回传 `raw_json`、full rows、文件路径或 candidate。
- 资金红线：真实 JPM 样本逐行金额、币种、匹配标志、receipt 与 crash 后 DB 复核仍要求资金负责人手工确认；本地自动测试不能替代该 gate。

## Remaining unknowns

- Windows packaged SQLite/WAL lock 与 abrupt process crash 行为仍需 production enable 前动态验证。
- 真实 JPM 样本逐行金额、币种、标志与 receipt 复核必须由资金负责人完成。
- production enable、live managed routing、结果重建/导出与任何 Publisher/VCC 接线均留给后续冻结块；本实现不声称这些路径已可发布。

# E11-C ReconFix Export Implementation Notes

## Baseline

- Goal/spec：v3.2.4 Spec §6、§8～§11；TechDoc §8、§12～§14 的 E11-C。
- Restack exact base：`1abcae910715e3271c53ad6022d95070e8d502d3`（E11-B committed-result-lost review-fix head）。
- 原实现来源：旧 base `225ab05f77cd74d25b9aae05dda1ab490104d5c6` 上按序提交 `6e0ee98fddc0b47d669387113c7c65dea4819e2f`、`c32db41ef3a9c993a2497f5e0f455fbdfcb16db1`、`2e03bf2a39537e8b8ff7960758e227773f17900f`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：production-false managed export 在 Service 私有 result 上生成有界有序 manifest，Main 深度 Join 后只调用一次既有 journal Publisher，全部 fault/回归门禁闭合。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| `recon-fix:export` 严格采用 canonical `thread-single/service/native/main-settlement/all-or-none` policy，保持 `production.enabled=false` | canonical fixture deep-equal；runtime registry regression | 自造 export pool、改变 commit kind、提前接 live route | 只新增 non-production capability，不改变 legacy 用户路径 |
| Worker 只收 exact `serviceGeneration + revision + resultHandle`、规范化 FilePlan artifact key 与 task-private generation path | Service 私有持有 full result；Main DTO 不得携带 rows | Main 把 fixed/unmatched rows 重新传进 Worker | JPM candidate/raw row 不跨 protocol，Service crash 后不重建结果 |
| 复用 `writeReconIdFixOutput` / `writeUnmatchedReport`，并在 Worker 与 Main 两次真实打开 workbook 读取业务证据 | legacy sheet/header/order/style/watermark 是业务合同；manifest 不能只描述意图 | 新 writer；只对预期 rows 计算 digest；Main 只信 Worker manifest | manifest 来自实际文件；Main 仍重新验证 sheet/headers/records/style/lineage |
| Main 在 generation 前冻结 result/business/FilePlan/binding authority，并用 runtime reservation 保持 Service 单一 owner 直到 Publisher settlement | Reviewer 反例证明 `job:done` 后 ServiceHost busy 已释放，两次 evidence read 仍存在窗口 | 最后再读一次 evidence；用 Worker manifest/summary 互证 | 只读一次 generation 前 current evidence；Join 直接对 Main 前置 authority；normal import/run 在 settlement 期间拒绝 |
| runtime owner 内部持有唯一 evidence settlement admission；export 必须显式提交且 exact 等于该 owner 的 admission | Round 2 证明 scenario、BOC linked、JPM import writer 不经过 Service reservation；任意另一份合法 admission 不能与当前 runtime 混用 | 只做第三次 evidence read；caller 自建 branded admission；跨进程/无限锁 | current evidence read 前取得 settlement lease，持有到 Publisher resolve/reject；三类 writer 从同 owner `runWriter`，settlement 中同步 BUSY，之后释放 |
| batchContext 是唯一批次 authority，Main 显式持有 kind→artifactKey/target binding | exact-seven 完整覆盖 runtime exact-five；FilePlan 没有业务 kind | 并行信任 caller operation/context；从文件名推断 kind；改通用 FilePlan schema | runtime context 只从 batch 派生；A/B 混批次与反序 target 均在 Worker/Publisher 前失败 |
| 全部 Join 通过后统一走 `publishToolboxPublicationAsync`，不增加第二套 receipt/retry | 既有 Publisher 已覆盖 batch journal、target snapshot、rollback、worker-exit recovery | ReconFix 自己 rename/copy；异常后再次 publish | main+unmatched 单次 all-or-none；uncertain 不猜成功、不重复发布 |
| JPM adopted result 的 linked lineage 绑定 writeback plan/receipt 证明的 post-image hash | probe 发现 E11-B 原 pre-image hash 会让成功 mutation 后立即 stale；Inspector/receipt 已以 post-image 为提交权威 | export 绕过 stale gate；从 receipt 重建 candidate | 不改 mutation/receipt/Inspector 流程，只让 current result lineage 对应当前 ADM image |
| restack 后 export 复用最新 E11-B Service phase-extension：prepare 只给 `resourcePlan`，grant 后才校验 strict staging/读取 linked evidence并创建 plan，phase 持有到 terminal | 新 worker 会拒绝 direct `export-plan`；首次 E11-C restack 9 项报 `RECON_FIX_PHASE_PLAN_INVALID` | 让 export 绕过 phase admission；在 grant 前读取 strict staging/evidence；为 export 申请第二资源 | 使用一次 `estimateRunPhaseBytes(stateMemoryBytes)` 资源估算；grant 边界重验 result/export authority；沿用 worker finally 统一释放，不改变 Publisher/commit authority |
| export plan closure 持有唯一幂等 generation cleanup；Worker 仅在 `execute + post-generation safepoint` 同一失败域调用 | Ultra Reviewer 动态反例证明 execute 成功后 shutdown-only cancel 会在 Main Join/Publisher 前留下无 owner xlsx | Main/Publisher 预删；Service preparation close 无条件删；扩大所有 action cancel；新增第二 cleanup authority | job:error/cancel 删除本 plan 已登记 paths并保留首错；job:done 不删，文件继续交 Main Join/Publisher；不改变 journal/archive handoff |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| live ReconFix export 继续 legacy | scope 明确禁止接 live IPC/Renderer/Preload，canonical production false | managed capability 只由定向测试可达 | 静态 route 与 policy gate；不修改 live handler |
| Main 集成层可从当前 scenario/linked DB 与已持有小型 result DTO 提供 authoritative evidence reader | 冻结合同明确 Main 持 generation/revision/summary/FilePlan；E12 才接 live orchestration | E12 若无法提供 reader，不得启用 production | E11-C API 强制一次 generation 前 `readCurrentEvidence`；缺失直接拒绝 |
| E12 的正常 writer wiring 每次从当前 runtime owner 获取 admission，不缓存或自建第二实例 | runtime manager 是 Main composition root；Round 2 明确禁止接 live handler | handler 若绕过/混用 owner，evidence settlement 不成立 | E11-C export 对 missing/mismatched owner fail closed；E12 接线与实际 handler 反例仍是 production enable 门禁 |

## Deviations

无冻结业务合同偏离。实施中补齐两项前序缺口：JPM public bounded result 增加冻结合同要求的 generation/revision；JPM private current result 的 linked hash 改为 receipt 证明的 post-image。两项均经 E11-B 全回归，未改变 mutation/receipt/Inspector/Hold 合同。Round 2 只交付共享 primitive、runtime owner API 与 fail-closed managed export 合同；按裁决不修改 `main.js` live handler，具体 scenario/BOC/JPM writer wiring 留 E12。此次 restack 的 phase preparation 与 Reviewer Round 2 generation cleanup 都是状态/资源 ownership 兼容修复，不改变 export definitive outcome、artifact/Publisher authority、重试语义或冻结 Spec/TechDoc，因此无需反向修改业务文档。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Preflight 合同/代码检查 | 无 BLOCK；高风险项均进入 PROBE | exact base、范围、状态/文件/Publisher边界 |
| `recon-id-fix-export-e11-c.test.js` | 15/15 PASS | canonical policy；standard/BOC；真实 table-driven main-only/unmatched-only/main+unmatched；set/order/collision/alias/symlink/tamper/stale；rowCounts；sheet/header/records/style/lineage；Service/evidence settlement reservation；post-generation shutdown cancel 双路径零残留/Publisher=0/cancel terminal/同 staging 重试；成功 job:done handoff 保留；A/B batch；reversed targets；self-consistent Worker 伪造；一次真实 journal 提交/failure/uncertain/双 artifact kill 后 rollback 与 committed recovery |
| E11-A/P0/B/C + toolbox generation 组合定向 | 103/103 PASS | 最新 E11-B phase/streaming/Inspector/Hold/threshold/startup recovery；E11-C Publisher/evidence；E11-P0 exact ID/order/same-transaction receipt；E11-A Service ownership |
| 受影响 unit/integration 定向 | 680/680 PASS | background execution、ReconFix engine/IO/service/export/JPM durable/writeback、C4、toolbox generation/publication |
| Recovery integration canary/control | 9/9 + 27/27 PASS | startup recovery、Publisher/Inspector/Hold control 仍按原 durable authority 收敛；generation cleanup 不进入 journal/archive owner 域 |
| `npm run test:integration` | 50/51 scripts PASS；唯一失败为无代码交集的 `toolbox-large-split-multi-sheet` RSS 30/31（tier2 median 144MB，effective budget 143MB，paired margin +2MB） | 所有 ReconFix/background-execution 相关 integration 通过；环境型 RSS 波动不调阈值、不加防御，也不宣称全量 integration 全绿 |
| `npm run smoke` | PASS（2026-08-29 restack） | ReconFix engine/IO/IPC legacy 与全应用 smoke |
| changed source ESLint | PASS（2026-08-29 restack） | worktree 复用主 checkout 同版本依赖，不安装或修改依赖 |
| changed JS `node --check` / `git diff --check` | PASS（2026-08-29 restack） | 语法与 whitespace |

### Reviewer Follow-up Failure Attribution

- 隔离 worktree 没有 `node_modules`，首次直接 `node --test` 因 `Cannot find module 'xlsx'` 失败；后续显式使用主 checkout 的同版本 `NODE_PATH`，未安装或修改依赖。
- Round 2 首次直接运行 E11-C 因同一环境缺口报 `Cannot find module 'jszip'`，未进入任何测试逻辑；同样使用主 checkout 的只读 `NODE_PATH` 后 14/14 通过。
- 首轮 E11-B/E11-C 失败均来自测试 fixture 仍使用旧 DTO/旧 run taskKey/两次 evidence read 预期；同步为冻结 authority、export context、显式 binding 后通过。
- 伪造 workbook 反例最初用 XLSX 整书重写会额外改变 style；改为仅修改 worksheet XML，保留原 style/watermark，确保失败真正来自前置业务 authority 而非测试噪声。
- Restack 首次 E11-C 专属测试 5/14 PASS，9 项统一失败于 `RECON_FIX_PHASE_PLAN_INVALID`；根因是旧 export 直接返回 plan，绕过最新 E11-B phase-extension。改为 grant 后创建 plan 后 14/14 PASS。
- 全量 integration 的唯一失败是全局 toolbox RSS 30/31 环境波动，与 E11-C 变更无代码交集；按项目负责 triage 不修改阈值或增加无关防御，并明确保留 50/51 事实。
- Reviewer Round 2 动态测试首次用 user cooperative cancel，canonical policy 正确返回不接受（`recon-fix:export` 是 `shutdown-only`）；测试改为 runtime shutdown，并在首个 generation artifact 出现后请求取消，使取消只在 execute 完成后的既有 safepoint 收口。

## Blindspot Pass

- 入口旁路：未修改 `src/main.js`、preload、renderer；live legacy export 与 `production.enabled=false` 保持。Round 2 的 writer admission 是 E12 可复用合同，managed export 缺失或混用 runtime owner admission 会在 evidence/Worker/Publisher 前拒绝。
- 权限/所有权：Service 是 full result 单一 owner；Worker path 限于真实 task-private root 的直属固定文件；Main 重新 canonicalize FilePlan 并重验 role/sourceOperation/snapshot、realpath、symlink、alias、key/set/order。
- 状态生命周期：Main 先取得 runtime-owned evidence settlement lease，再冻结/核对 current evidence；Service export 先提交唯一 `resourcePlan`，strict staging/linked evidence 大状态读取只在 phase grant 后发生，且同一 phase 持续到 terminal；export plan closure 独占 generated-path cleanup，Worker 仅把 execute 与 post-generation safepoint 放入该失败域。Service reservation 与 evidence lease 均持续到 Publisher promise resolve/reject。active writer 阻断 settlement，settlement 阻断三类 writer；finally 有界释放。进程 crash 不保留内存锁，发布状态继续只由既有 journal recovery 收敛。
- 失败/恢复：任一 Worker/Join/readback 失败 Publisher=0；post-generation cancel/job:error 清除本 plan 已登记的全部 task-private artifacts，重抛首错；job:done 不删并交给 Main/Publisher。Publisher 只调用一次；committed/unknown/crash 由已有 durable journal recovery 判定，manual recovery/hold 不绕过。
- 兼容性：legacy writer、sheet/header/order/style/watermark 未改；E11-A/P0/B/C + toolbox generation 组合定向 103/103，受影响矩阵 680/680，Recovery integration 9/9 + 27/27；Main DTO/terminal manifest 无 raw rows/path/大 candidate。
- 可观测性/测试：manifest 有 bounded ordered size/hash/rowCounts/业务/lineage evidence； hostile path、tamper、stale、Publisher 与 restart 均有证据。
- Reviewer 反例：final evidence 后的 normal import/run 改为 reservation 期间同步 `SERVICE_BUSY`；不再依赖第三次 read；伪造 cell/新增行即使同步修改 Worker technical/business manifest 与 count summary 也必须对前置 authority 失败。
- Round 2 反例：scenario/BOC/JPM writer 在 Publisher settlement 中均同步 `RECON_FIX_EVIDENCE_SETTLEMENT_BUSY` 且 body=0；Publisher resolve/reject 后放行；两份合法但不同 runtime admission 无法混入同一 export。

## Reconciliation Blindspot Pass

- 主键/血缘：resultHandle + generation/revision + scenario/input/linked/result digests 与 per-kind records digest 冻结为 Main authority；Worker manifest/lineage 必须独立对该 authority；JPM linked lineage 精确指向 committed post-image。
- 金额/币种：不改引擎、金额或币种；复用 legacy fixed/unmatched rows 与 writer，业务回读对 records digest 做逐值守恒。
- 幂等/重复：不重新运行 JPM mutation，不从 receipt 重建 candidate，不在 Publisher 异常后自动二次发布。
- 状态/部分失败：双 artifact 只有一次 journal Publisher；任一项失败为零发布；Publisher 自身 rollback/recovery 继续 all-or-none。
- 行数守恒：main rowCount=fixedRowCount、unmatched rowCount=unmatchedRowCount，artifact 集合由非零结果行精确决定；standard 真实覆盖三种集合（含 unmatched-only），BOC/JPM 按当前引擎可达性固定 main-only，不虚构业务行。
- 资损可观测性：自动化不能替代真实业务逐行、Windows Excel/WPS 与 Publisher 人工恢复演练，继续列为 production enable 硬门禁。

## Important Variable Review

- `freezeWorkerBatchContext`（Critical，使用未修改）：Publisher 前强制 exact-seven；真实 journal 测试确认原 batch receipt 保留。
- `backgroundExecutionRuntime` Service 运行态（Runtime-state）：新增 Main settlement reservation，仅对同 service 的 managed start/execute/close 生效；one-shot/toolbox 与 production gate 不变。
- `backgroundExecutionRuntime` evidence 运行态（Runtime-state）：每个 runtime owner 新增唯一 in-memory admission；只影响显式调用该合同的 ReconFix export/writer，未改 live handler、JPM Hold 或其他 toolbox action。
- `recon-id-fix-io.js`（Risk-sensitive 关联）：只新增只读 output contract getter，headers 来源仍是现有常量；reader/writer 与 C4 三代输入兼容逻辑未改。
- `lastGeneratedExports` / live runtime state：未触碰；legacy 打开目录/重复导出生命周期不漂移。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged journal/Excel lock/kill 行为 | PROBE | production enable gate | 不阻止 production-false 合并，阻止 production enable |
| standard/BOC/JPM 真实业务文件逐行与格式复核 | 人工门禁 | 资金负责人 | 未复核不得 production enable |
| Publisher manual recovery/Hold 在目标 Windows userData 的人工演练 | 人工门禁 | 发布/恢复负责人 | 未复核不得 production enable；不得以自动测试替代 |
| E12 live scenario/BOC/JPM writer handler 使用当前 runtime owner admission 的接线与竞态回归 | 已知后续工作 | E12 owner | 不阻止 E11-C production-false 合并；未完成不得启用 managed production |

# E11-C ReconFix Export Implementation Notes

## Baseline

- Goal/spec：v3.2.4 Spec §6、§8～§11；TechDoc §8、§12～§14 的 E11-C。
- Exact base：`225ab05f77cd74d25b9aae05dda1ab490104d5c6`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：production-false managed export 在 Service 私有 result 上生成有界有序 manifest，Main 深度 Join 后只调用一次既有 journal Publisher，全部 fault/回归门禁闭合。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| `recon-fix:export` 严格采用 canonical `thread-single/service/native/main-settlement/all-or-none` policy，保持 `production.enabled=false` | canonical fixture deep-equal；runtime registry regression | 自造 export pool、改变 commit kind、提前接 live route | 只新增 non-production capability，不改变 legacy 用户路径 |
| Worker 只收 exact `serviceGeneration + revision + resultHandle`、规范化 FilePlan artifact key 与 task-private generation path | Service 私有持有 full result；Main DTO 不得携带 rows | Main 把 fixed/unmatched rows 重新传进 Worker | JPM candidate/raw row 不跨 protocol，Service crash 后不重建结果 |
| 复用 `writeReconIdFixOutput` / `writeUnmatchedReport`，并在 Worker 与 Main 两次真实打开 workbook 读取业务证据 | legacy sheet/header/order/style/watermark 是业务合同；manifest 不能只描述意图 | 新 writer；只对预期 rows 计算 digest；Main 只信 Worker manifest | manifest 来自实际文件；Main 仍重新验证 sheet/headers/records/style/lineage |
| Main Join 绑定原请求 identity、前后两次 authoritative current evidence、重新 canonicalize 的 eager FilePlan、真实路径/文件/hash/readback | 冻结 TechDoc §8、legacy `recon-id-fix:export` sourceOperation 与 hostile-path probes | 只校验 size/hash；让 Worker 决定正式目标 | 任一 set/order/ownership/snapshot/stale/alias/symlink/tamper/业务差异均 Publisher=0，最终 evidence race 也不发布 |
| 全部 Join 通过后统一走 `publishToolboxPublicationAsync`，不增加第二套 receipt/retry | 既有 Publisher 已覆盖 batch journal、target snapshot、rollback、worker-exit recovery | ReconFix 自己 rename/copy；异常后再次 publish | main+unmatched 单次 all-or-none；uncertain 不猜成功、不重复发布 |
| JPM adopted result 的 linked lineage 绑定 writeback plan/receipt 证明的 post-image hash | probe 发现 E11-B 原 pre-image hash 会让成功 mutation 后立即 stale；Inspector/receipt 已以 post-image 为提交权威 | export 绕过 stale gate；从 receipt 重建 candidate | 不改 mutation/receipt/Inspector 流程，只让 current result lineage 对应当前 ADM image |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| live ReconFix export 继续 legacy | scope 明确禁止接 live IPC/Renderer/Preload，canonical production false | managed capability 只由定向测试可达 | 静态 route 与 policy gate；不修改 live handler |
| Main 集成层可从当前 scenario/linked DB 与已持有小型 result DTO 提供 authoritative evidence reader | 冻结合同明确 Main 持 generation/revision/summary/FilePlan；E12 才接 live orchestration | E12 若无法提供 reader，不得启用 production | E11-C API 强制 `readCurrentEvidence`；缺失直接拒绝 |

## Deviations

无冻结合同偏离。实施中补齐两项前序缺口：JPM public bounded result 增加冻结合同要求的 generation/revision；JPM private current result 的 linked hash 改为 receipt 证明的 post-image。两项均经 E11-B 全回归，未改变 mutation/receipt/Inspector/Hold 合同。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Preflight 合同/代码检查 | 无 BLOCK；高风险项均进入 PROBE | exact base、范围、状态/文件/Publisher边界 |
| `recon-id-fix-export-e11-c.test.js` | 9/9 PASS | canonical policy；standard/BOC；main-only/unmatched-only/main+unmatched；set/order/collision/alias/symlink/tamper/stale；rowCounts；sheet/header/records/style/lineage；Publisher=0/一次真实 journal 提交/failure/uncertain/双 artifact kill 后 rollback 与 committed recovery |
| E11-P0/A/B/C + Publisher/recovery 定向 | 97/97 PASS | JPM writeback/receipt/Inspector/Hold；Service ownership；ReconFix 双 artifact 与既有 Publisher actual hard-kill/restart；exact7 recovery |
| 全量 unit | 最终 6258/6263；2 个仅因隔离 worktree 缺 `node_modules/app-builder-lib` NSIS 模板 | 全仓回归；E11-C action 清单已同步，生产代码无遗留失败，依赖环境缺口不伪装修复 |
| `npm run test:integration` | 51 scripts、2455/2455 PASS | 全集成路径；自动改写的耗时清单已恢复基线，未纳入无关 diff |
| `npm run smoke` | PASS | ReconFix engine/IO/IPC legacy 与全应用 smoke |
| ESLint | `NODE_PATH=<主 checkout node_modules> .../.bin/eslint src/` PASS | worktree 无本地依赖；同版本仓库依赖下静态规则通过 |
| changed JS `node --check` / `git diff --check` | PASS | 语法与 whitespace |

## Blindspot Pass

- 入口旁路：未修改 `src/main.js`、preload、renderer；live legacy export 与 `production.enabled=false` 保持。
- 权限/所有权：Service 是 full result 单一 owner；Worker path 限于真实 task-private root 的直属固定文件；Main 重新 canonicalize FilePlan 并重验 role/sourceOperation/snapshot、realpath、symlink、alias、key/set/order。
- 状态生命周期：prepare/execute 前后重读 linked evidence；Main 再比对原请求 identity 与 current evidence；Service crash 后不从 artifact/receipt 猜 result。
- 失败/恢复：任一 Worker/Join/readback 失败 Publisher=0；Publisher 只调用一次；committed/unknown/crash 由已有 durable journal recovery 判定，manual recovery/hold 不绕过。
- 兼容性：legacy writer、sheet/header/order/style/watermark 未改；E11-P0/A/B/C 组合定向 97/97；Main DTO/terminal manifest 无 raw rows/path/大 candidate。
- 可观测性/测试：manifest 有 bounded ordered size/hash/rowCounts/业务/lineage evidence； hostile path、tamper、stale、Publisher 与 restart 均有证据。

## Reconciliation Blindspot Pass

- 主键/血缘：resultHandle + generation/revision + scenario/input/linked/result digests 贯穿 Worker manifest 与 Main Join；JPM linked lineage 精确指向 committed post-image。
- 金额/币种：不改引擎、金额或币种；复用 legacy fixed/unmatched rows 与 writer，业务回读对 records digest 做逐值守恒。
- 幂等/重复：不重新运行 JPM mutation，不从 receipt 重建 candidate，不在 Publisher 异常后自动二次发布。
- 状态/部分失败：双 artifact 只有一次 journal Publisher；任一项失败为零发布；Publisher 自身 rollback/recovery 继续 all-or-none。
- 行数守恒：main rowCount=fixedRowCount、unmatched rowCount=unmatchedRowCount，artifact 集合由非零结果行精确决定。
- 资损可观测性：自动化不能替代真实业务逐行、Windows Excel/WPS 与 Publisher 人工恢复演练，继续列为 production enable 硬门禁。

## Important Variable Review

- `freezeWorkerBatchContext`（Critical，使用未修改）：Publisher 前强制 exact-seven；真实 journal 测试确认原 batch receipt 保留。
- `recon-id-fix-io.js`（Risk-sensitive 关联）：只新增只读 output contract getter，headers 来源仍是现有常量；reader/writer 与 C4 三代输入兼容逻辑未改。
- `lastGeneratedExports` / live runtime state：未触碰；legacy 打开目录/重复导出生命周期不漂移。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged journal/Excel lock/kill 行为 | PROBE | production enable gate | 不阻止 production-false 合并，阻止 production enable |
| standard/BOC/JPM 真实业务文件逐行与格式复核 | 人工门禁 | 资金负责人 | 未复核不得 production enable |
| Publisher manual recovery/Hold 在目标 Windows userData 的人工演练 | 人工门禁 | 发布/恢复负责人 | 未复核不得 production enable；不得以自动测试替代 |

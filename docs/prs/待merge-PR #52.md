---
integrated: false
draft_for_pr: '#52'
target_version: v2.1.8
source_branch: v2.1.8
target_branch: main
created: 2026-05-26
---

# PR #52 — v2.1.8 发版

## Summary

v2.1.7 之后 **15 commit** 收敛，**6 项主题**：

| 主题 | 重点 |
|---|---|
| **F5** C4 manyToOne 算法重设（4/5 根因）| BillDate 数字日期 fix + maxSize 动态档位 + 复合排序 + currency 等值过滤；TEST2.xlsx 28→43 行（根因 #5 ILP 重写延期 v2.1.9）|
| **G1** 单元测试框架建立 | Node 22+ 原生 `node:test` 零 devDep + `tests/unit/` 28 suites / 123 case；全量铺延期 v2.1.9 |
| **N1' (v0.7)** cleanup 改 idle 30min 触发 + 差异保留 | 🔴 FK 反向同步：3 层触发 + `includeDiff=false` 默认仅清 flow_imports |
| **N2** C3「自取值」 | 第二下拉 `__CUSTOM__` + 静态字符串 + DB migration |
| **N3-1/N3-2** 银行对账场景号修复 + Sheet 3「命中场景行」 | `hitScenarios.displayIndex` + writer 可选 Sheet 3 |
| **N4** 收单差异表 29→12 列瘦身 | 🔴 输出契约破坏性变更 + 🔴 DB raw_json 破坏性 migration（永久删 17 字段值 + 自动 DB 备份）|
| **v2.1.7-cleanup** | 10 项 minor 收尾（8 已修 + 2 不可修记录）|

## ⚠️ 关联功能 review（v2.1.8 important-variables v11 升格 7 条）

### Critical（资金红线 / 对外契约）

| 变量 | 层级 | review 要点 |
|---|---|---|
| `findBestAmountSubset` | Critical（F5 v10 已升）| maxSize 动态档位 / 性能护栏 / 资金红线等式不变量 |
| `tryManyToOnePool` | Critical（F5 v10 已升）| 复合排序 / 网关单向消费 / first-match-wins |
| `WRITER_OUTPUT_HEADERS_V2`（新）| Critical | 12 列输出契约；改 → 必须同步模版 + writer + smoke + USER_GUIDE |
| `TEMPLATE_BILL_HEADERS`（新）| Critical | 模版 truth source；改 → 同步 ensureBillRawJsonV2Slim N4_TEMPLATE_BILL_HEADERS 内部副本 |
| `bill_imports.raw_json` 内容契约（新）| Critical | v2.1.8 起仅 9 字段；17 字段值已永久删除不可逆 |
| `WRITER_OUTPUT_HEADERS`（降级 deprecated）| — | 仅历史参照；新代码用 V2 |

### Important-skeleton

| 变量 | 层级 | review 要点 |
|---|---|---|
| `cleanupAfterRunBackground`（v10 已升，v11 更新 review）| Important-skeleton | 新增 `includeDiff=false` 参数；默认仅清 flow（FK 约束）；Phase 2 显式 true |
| `ensureBillRawJsonV2Slim`（新）| Important-skeleton + 🔴 破坏性 | 备份 + 事务 + marker 三重保护；幂等 |
| `setupIdleCleanupTimer`（新）| Important-skeleton | idle 30min 触发 / mutex 抢锁 / 与 before-quit 协作 |
| `parseBillDateMs`（F5 v10 已升）| Important-skeleton | F5 不动 parseBillDateMs，改 c4 引擎入口转换 |
| `INTERNAL_FIELDS`（N3 v10 已升）| Important-skeleton | 加 `_hitScenarioDisplayIndex` 白名单 |
| `BANK_STATEMENT_FIELDS_FOR_C3`（N2 v10 已升）| Important-skeleton | constants 不动；dialog 内联 `__CUSTOM__` option |

### Runtime-state / Risk-sensitive

| 变量 | 层级 | review 要点 |
|---|---|---|
| `lastUserActivityTs` + `IDLE_CLEANUP_MS` + `reportUserActivity`（新）| Runtime-state | renderer 10s 节流上报；idle 30min 阈值硬编码 |
| `cleanup_pending`（N1 v10 已升）| Risk-sensitive | DB 列保留作 3 触发点共用判断依据 |
| `config_json.assign`（N2 v10 已升）| Risk-sensitive | 历史场景 migration `ensureC3AssignAddMode` 加 `mode='direct'` |
| `hitScenarios` / `displayIndex`（N3 v10 已升）| Risk-sensitive | dispatcher 结构变更；smoke 字段迁移零 regression |

## 🔴 升级影响（用户必读）

1. **首次启动 v2.1.8 自动备份 DB**：`<userData>/backups/tool-data-bak-pre-N4-<ts>.sqlite`；大库 5-30 秒
2. **17 字段值永久删除**：升级后 `bill_imports.raw_json` 只剩 9 模版字段，**不可逆**
3. **Excel 自动化失效**：29 列结构脚本必须更新到 12 列
4. **idle 30min 自动清流水**：闲置 30min 后台清 `flow_imports`（不影响差异结果）

## Test plan

### 自动化 hard gate（`npm run release-check` 一键跑）

- [x] **`npm run smoke`** 全套通过：~880 断言（acquiring 203 含新 caseN4 / progress 32 / pragma 27 / dispatcher 21 / scenario-engines 45 / bank-bu-recon 41 / biz-op-recon 154 / render-status 25 / scenario-c1 21 / ...）
- [x] **`npm run test:unit`** 123/123 / 28 suites
- [x] **`npm run test:integration`** 273/273 / 6 脚本 / 1163ms 总耗时（v2.1.8 新增体系）：
  - `acquiring-bill-currency-idle-cleanup` 18/18 — N1' idle 触发链路
  - `acquiring-bill-currency-n4-migration` 115/115 — N4 raw_json migration e2e
  - `bank-statement-hit-scenario-sheet` 26/26 — N3 Sheet 3 完整 pipeline
  - `new-account-balance-statement` 36/36 — 主功能 2 余额账单 e2e（补缺）
  - `pending-data-reconciliation` 33/33 — 主功能 3 Pending 核对 e2e（补缺）
  - `statement-generation-pipeline` 45/45 — 主功能 1 网银账单 e2e
- [x] `npm run scan:vars` 重新生成 var-reference-stats（v11 升格 7 条）

### v2.1.8 工程化基建（reviewer 关注）

- 新增统一集成测试入口 `scripts/integration-runner.js`（自动发现 `scripts/integration/*.js`）
- 新增 `npm run test:integration` + `npm run release-check`（smoke && unit && integration）
- 新增规则 `rules/integration-test-policy.md`：**新加业务模块必须配 ≥ 1 集成测试**
- 4 个 v2.1.8 集成脚本去版本前缀（按模块命名，长期回归契约不绑定版本）
- 补缺主功能 2 / 主功能 3 集成测试（v2.1.7 之前未覆盖）

### GUI 手测（用户跑，依 `docs/iterations/v2.1.8/manual-test-checklist.md`）

- [ ] **N4 升级路径**：v2.1.7 DB → 启动 v2.1.8 → 验证备份文件 + 差异表 12 列 + raw_json 仅 9 字段
- [ ] **N1' idle 30min 触发**：闲置 30min（或临时缩短常量法）后查 activity log + flow_imports 已清
- [ ] **N3 Sheet 3「命中场景行」**：银行对账跑完后导出 xlsx 验证 3 sheet + 命中场景列格式
- [ ] **N2 C3「自取值」**：场景管理新建 C3 → 选「自取值」→ 输入字符串 → 实际对账验证赋值
- [ ] **v2.1.7 回归 §六**：网银账单 / ReconID 修复 / 收单 / 各模块冒烟
- [ ] **性能体感 §七**：启动时间 / DB 体积 / 内存

## Commits（20 个，v2.1.7 → HEAD）

```
33b50c3  [v2.1.8] refactor(test): 集成测试入口 + 模块 2/3 补缺 + 规则文档（B+D 改造）
68a4eea  [v2.1.8] test(release): 主功能 1「生成网银账单」核心 pipeline 集成脚本
4115b2b  [v2.1.8] docs(release): 手测 checklist（8 章 / 4 主题 + 回归 + 性能 + 反馈）
3e2959c  [v2.1.8] test(release): 3 个 v2.1.8 集成验证脚本（N4 e2e / N1' idle / N3 Sheet 3）
30fc5db  [v2.1.8] chore(release): 三件套 + 版本号 bump 2.1.7→2.1.8 + PR #52 草稿 + important-variables v11
37299cf  [v2.1.8] feat(N4): 差异表输出瘦身到 12 列 + bill_imports.raw_json migration（破坏性 + DB 备份）
913f868  [v2.1.8] feat(N1'): cleanup 改 idle 30min 触发 + 差异数据保留（v0.9 含 FK 反向同步）
e07f02b  [v2.1.8] chore(v2.1.7-cleanup): self-review 10 项 minor 收尾（8 已修 + 2 不可修记录）
30247da  [v2.1.8] N1: 收单单据币种校验 cleanup β 方案（移出对账链路 + app.before-quit 主清 + 进入模块兜底）
70524e3  [v2.1.8] N3: 银行对账状态框场景号修复（displayIndex）+ Sheet 3「命中场景行」导出
6d5bcab  [v2.1.8] N2: C3「对账成立后赋值」新增"自取值"（assign-gw 数据源 + 静态字符串）+ 12 unit case
964f076  [v2.1.8] T12: F5 范围收敛 v2.1.8（修 4/5 根因 + 28-43 行）+ 根因 #5 延期 v2.1.9
d610d54  [v2.1.8] T11: currency 字段等值过滤（spec F5-D3）+ 10 unit case
ce2d64a  [v2.1.8] T10: tryManyToOnePool 遍历顺序复合排序（金额降序 + candidates count 降序）+ 6 unit case
a48b4fd  [v2.1.8] T09: findBestAmountSubset maxSize 动态档位 + 性能护栏 + 13 unit case
f02d750  [v2.1.8] T08: BillDate 字符串化 fix（c4 引擎入口，Reverse Sync spec F5-D4 改 b）+ 14 unit case
ee4646e  [v2.1.8] T04-T07: G1 框架搭建 + normalizers 第一批 68 case
6e22375  [v2.1.8] T03: F5 fixture 归档（F5-TEST 42KB + F5-TEST2 46KB）
bc7865c  [v2.1.8] T02: scan:vars 重跑 + important-variables v9→v10 升格 11 条
49e4cbb  [v2.1.8] docs(PM): 评审三件套 + backlog 升级（7 项 backlog + 27 决策点全锁）
```

## 风险

| 等级 | 项 |
|---|---|
| 🔴 | N4 raw_json 破坏性 migration — 17 字段值永久删除（不可逆，配套自动 DB 备份）|
| 🔴 | N4 输出契约 29→12 — 用户 Excel 自动化失效 |
| 🔴 | F5 算法重设 — 资金红线等式不变量 |
| 🟡 | N1' 数据保留策略 — DB 体积持续增长（v2.1.9 评估）|
| 🟡 | F5 #5 根因 — TEST2.xlsx 43/57 行命中（差 14 行延期 v2.1.9）|
| 🟡 | A3 跨进程化未做 — 部分由 N1' idle cleanup 缓解 |

## 延期到 v2.1.9

- F5 根因 #5（subset-sum 剪枝误剪）需 ILP 算法重写
- G1 全量铺第 1 层剩余 13 + 第 2 层 24 文件
- A3 runCheck 跨进程化（worker_threads / utilityProcess）
- A4 SQL JOIN chunked（与 A3 联合评估）
- N4 后续：手动清入口 / 滚动保留窗口 / FK CASCADE 改造

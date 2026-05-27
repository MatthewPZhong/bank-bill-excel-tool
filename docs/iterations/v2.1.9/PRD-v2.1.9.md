# PRD — v2.1.9 α 迭代：银行渠道区分场景 + 单元测试全量铺 + 4 项基建/UX/补强

| 字段 | 值 |
|---|---|
| 文档版本 | v0.3（2026-05-27 — SR-log-1 立项：全局告警统一日志化；α 主题数 8→9；工期 5→5.4 周）；v0.2 α/β 拆分 + 4 项升格；v0.1 起草 |
| 目标版本 | `v2.1.9`（minor — 新增 channels 表 + 调度模型双维改造 + unit case 大规模沉淀） |
| 起始版本 | `v2.1.8`（PR #52 已合并 main） |
| 起草日期 | 2026-05-27 |
| 起草人 | PM |
| 状态 | 起草中（v0.2，待 spec 评审 + 用户对 D19-D22 拍板） |
| 关联文档 | `backlog.md` v0.4 / `spec.md`（v0.3 待修订）/ `tasks.md`（v0.2 待修订）/ `manual-test-checklist.md`（v0.2 待修订）/ `docs/iterations/v2.1.10/backlog.md` v0.1（β 范围） |
| 涉及模块 | 银行对账单处理（N5 + N6）+ 场景管理（N5 + N7）+ 收单单据币种校验（N1-settings + 顺带 N4 重构）+ 全局工程基建（SR-backup-1 + G1-cont + SR-policy-1） |
| 工作分支 | `v2.1.9`（基于 main，待用户拉新分支） |
| 依赖 | v2.1.8（含 N3-1 displayIndex + N3-2 Sheet 3 + N4 raw_json migration + 集成测试体系 + node:test 框架 + N1' idle 30min） |
| package.json.version | 暂保持 `2.1.8`；α 发布前由用户决策是否 bump 到 `2.1.9` |

---

## 一、需求概述

v2.1.9 α 包含 **8 项独立改动 + 1 项前置基建 + 1 项顺带优化**，主线是银行对账单处理模块"银行渠道"维度引入，搭配工程基建大规模升级：

1. **N5 — 银行对账单按"银行渠道"区分场景 🔴 资金红线 + 破坏性 migration**：v2.1.7 F8 first-match-wins 调度从单维（scenarios 列表）扩展为双维（渠道×场景）。新增 `channels` 表 + `scenarios.channel_id INTEGER FK`，初次升级所有现有 scenarios 默认归到"通用"渠道。场景管理页面新增「银行渠道」选择 + CRUD + 转移 + 批量操作。导入按 `<Channel>-<地区>` 匹配渠道，调度采用 **D2=(c) 专属优先 + 通用兜底**。v2.1.8 引入的 Sheet 3 撤除，改独立报表落 error-reports。

2. **N6 — 状态框「：」后两次换行 → 一次**：D18=(a) 改外层文案（`renderer.js:3338, 3351` 删 `\n`），仅银行对账单 2 行；其他 5 模块零改动；保留 v2.1.7 round 2 R3 §8.4.2 内层 replace 设计。

3. **N7 — 场景模板按渠道导入/导出**：场景管理 footer 新增「导入模板文件」「导出模板文件」按钮。导出按渠道多选；新增独立 bundle 类型 `scenarioBundleVersion=1` 与 `bundleVersion=4` 隔离互认；导入冲突策略：缺失渠道弹确认框创建 + 同名场景跳过报告。

4. **SR-backup-1 — sqlite backup API 基建（N5 migration 依赖前置）**：v2.1.8 SR2 沉淀项。新建 `src/backend/database/backup.js`，封装 SQLite 原生 backup API + tmp 文件 + atomic rename，取代 `fs.copyFileSync` 的 3 大隐患（大库阻塞 / WAL 不一致 / 失败无回滚）。

5. **G1-cont — 单元测试全量铺**（升格自 v2.1.10 候选）：v2.1.8 已建 `node:test` 框架 + 123 case；本版铺设第 1 层剩余 13 个文件 + 第 2 层 24 个文件，共 37 个 unit test 文件；预估累计 case ≥ 400+。

6. **SR-policy-1 — integration-runner 自动同步清单**（升格自 v2.1.10 候选）：v2.1.8 SR4 沉淀项。`scripts/integration-runner.js` 末尾自动 in-place 编辑 `rules/integration-test-policy.md §七` 当前清单 markdown 表，避免人工同步漏掉。

7. **N1-settings — idle 阈值 settings 化**（升格自 v2.1.10 候选）：v2.1.8 N1''-D8 锁硬编码 30min；本版改为应用设置弹框新增字段，默认 30min + 范围 5-180min。

8. **N4 重构（顺带）**：SR-backup-1 基建落地后，v2.1.8 N4 migration 的 `fs.copyFileSync` 切换到新 API；一致性收益 + 顺带消除 N4 存量备份风险。

9. **SR-log-1 — 全局告警统一日志化**（新立项）：现状审计发现告警日志覆盖率仅 19%（41/215 处），renderer 175+ 处告警 0 持久化（关闭即失），main 49 处 `console.error/warn` 在打包后用户机器看不到。本版立项：(1) preload 新 IPC `desktopApi.reportLog`；(2) renderer `setStatus` / `createAlertDialog` wrapper hijack 自动上报；(3) main 49 处 `console.error/warn` 改 `appendActivityLogEntry`；(4) 新日志结构 `logs/{YYYY-MM}/{MM-DD}/{level}.log` + JSON Lines + 永久保留 + 双写兼容 `app_activity_log.txt`。

9 项改动间依赖：**N5 是主线，N7 依赖 N5（需渠道枚举），N6 完全独立；SR-backup-1 必须在 N5 + N4 重构前完成；G1-cont 与所有 N 项并行可独立推进；SR-policy-1 + N1-settings + SR-log-1 完全独立可并行**。

---

## 二、版本目标

### 2.1 必做

- **N5-1/2/3** — 场景管理顶部「银行渠道」选择器 + 「管理」按钮 + 渠道管理弹框（名称/开户地/完成-修改/删除）
- **N5-4** — 渠道落库 + 下拉枚举 `<名称>-<开户地>`
- **N5-5** — DB schema 破坏性 migration（channels 表 + scenarios.channel_id FK + backfill 通用 + SR-backup-1 自动备份）
- **N5-6** — 场景行新增「转移」按钮
- **N5-7** — 「批量操作」按钮 + 勾选列 + 批量转移/删除
- **N5-8** — dispatcher 双维调度（D2=c 专属优先 + 通用兜底）+ 未匹配行 fallback 通用 + 保留原始 `<Channel>-<地区>` 用于审计
- **N5-Sheet3 拆出** — 移除 v2.1.8 主输出 xlsx 的 Sheet 3，改独立报表 `命中场景行-{原文件 basename}-{timestamp}.xlsx` 落 `Documents/网银账单生成小助手/error-reports/{date}/`
- **N6** — `renderer.js:3338, 3351` 删 `\n`（D18=a 修订）
- **N7-1** — 场景管理 footer 改 `新增场景 / 批量操作 / 导入模板文件 / 导出模板文件 / 完成`
- **N7-2** — 导出弹框 + 多选下拉
- **N7-3** — 生成 `scenarioBundleVersion=1` 独立文件
- **N7-4** — 导入缺失渠道自动创建 + 落库前弹确认框 + 同名场景跳过报告
- **SR-backup-1** — `src/backend/database/backup.js` 新建 + sqlite backup API + POC 验证 + fallback 设计
- **G1-cont** — 第 1 层剩余 13 文件全量 + 第 2 层 24 文件全量；累计 case ≥ 400+
- **SR-policy-1** — `scripts/integration-runner.js` 末尾 in-place 编辑 `rules/integration-test-policy.md §七`；文件头加生成时间戳
- **N1-settings** — 应用设置弹框新增「收单单据 idle 清理阈值」字段（默认 30min / 范围 5-180min）；settings 表新增 `acquiring_bill_idle_cleanup_minutes` 键
- **N4 重构** — v2.1.8 `ensureBillRawJsonV2Slim` 的 `fs.copyFileSync` 调用切换到 `createBackup(db, 'pre-N4')`
- **SR-log-1** — preload `desktopApi.reportLog` 新 IPC + renderer setStatus/createAlertDialog wrapper hijack + main 49 处 console.error 改造 + `logs/{YYYY-MM}/{MM-DD}/{level}.log` 新结构 + JSON Lines + 双写 `app_activity_log.txt` 兼容
- 三件套（CHANGELOG / VFH / USER_GUIDE）发布前一次性更新
- smoke / 集成测试：N5（6+ 用例）+ N7（5+ 用例）+ N6（1 用例）+ G1-cont（37 文件 / 400+ case）+ SR-policy-1（1 用例）+ N1-settings（2 用例）+ N4 重构回归（1 用例）+ **SR-log-1（4+ 用例）**

### 2.2 明确不做

- **不做** F5-cont（C4 manyToOne 根因 #5 ILP 重写）— 2026-05-27 用户决定，继续延期到 v2.1.11+
- **不做** A3 跨进程化、A4 SQL JOIN chunked、N4-cont-1 raw_json 体积治理、N4-cont-2 FK CASCADE 改造 — 拆到 v2.1.10 β 版本（详 `docs/iterations/v2.1.10/backlog.md`）
- **不做** N5「通用」渠道可改名 / 可删（D1=a 系统内置硬约束）
- **不做** N5 "先通用 + 再专属" 调度模型（D2=c **专属优先 + 通用兜底**；不是 b 的"先通用"）
- **不做** Sheet 3 保留在主输出 xlsx（用户明确**移除**，改独立报表）
- **不做** N7 复用 `bundleVersion=4`（D9=b **独立 `scenarioBundleVersion=1`**）
- **不做** G1-cont CI 阻断（D19 沿用 v2.1.8 既定：先观察 1-2 版本再升级阻断）
- **不做** G1-cont 第 3 层 main.js / renderer / session unit 覆盖（继续靠 smoke + preview）
- **不做** SR-policy-1 输出格式 (a) 末尾追加 markdown 表全文 / (b) 独立文件 — 选 D20=(c) **in-place 编辑**
- **不做** N1-settings UI 暂不做仅支持手动改 settings 表 — 选 D21=(a) **应用设置弹框新增字段**
- **不做** N5 渠道枚举膨胀 UI 优化（虚拟滚动） — 延 v2.1.11+ 评估
- **不做** N5 顺带改其他模块状态框 / tone 体系
- **不做** N6 改内层 updateStatusBox（D18=a 仅改外层文案）
- **不做** SR-log-1 引入 ESLint 强约束（D37=b 暂不引）
- **不做** SR-log-1 日志保留滚动清理（D32=a 永久保留，D35 级联取消）
- **不做** SR-log-1 日志查看 UI（D36=a 仅文件系统暴露）
- **不做** SR-log-1 按域分类（仅按级别 error/warning/info，D30=a）

---

## 三、需求清单总览

| # | 标题 | 模块 | 类型 | 风险 | 文件预估 | 用户拍板 |
|---|---|---|---|---|---|---|
| N5 | 银行渠道区分场景（含 DB schema + 渠道 CRUD + 双维 dispatcher + 独立报表） | 银行对账单处理 / 场景管理 | 架构级 · 调度扩展 + 破坏性 migration | 🔴 **HIGH（资金红线 + 不可逆）** | migrations / channels-repository（新）/ scenarios-repository / dispatcher / session / renderer-dialogs / main / writers（新）+ smoke × 4-6 | ✓ 2026-05-27；11 决策全锁 |
| N7 | 场景模板按渠道导入/导出（新 bundle 类型） | 场景管理 | 功能增强 · 新 bundle 类型 + 冲突合并 | 🟡 MID | renderer-dialogs / main / scenarios-bundle-io（新）+ smoke × 3 | ✓ 6 决策全锁 |
| N6 | 状态框「：」后两次换行 → 一次 | 银行对账单处理 / UI | 缺陷修复 · 文案 | 🟢 LOW | renderer.js（2 行）+ smoke × 1 | ✓ D18=a 全锁 |
| SR-backup-1 | sqlite backup API 改造（N5 migration 依赖前置） | 全局 DB 基建 | 鲁棒性补强 | 🟢 LOW | database / backup（新）+ smoke × 1 | ✓ v2.1.8 SR2 沉淀 |
| **G1-cont** | 单元测试全量铺（第 1 层剩余 13 + 第 2 层 24） | 全局工程基建 | 测试覆盖 | 🟢 LOW | 37 个 tests/unit/*.test.js | ✓ D19=(a) 拍板沿用 v2.1.8 既定 |
| **SR-policy-1** | integration-runner 自动同步清单 | 工程化 | 自动化补强 | 🟢 LOW | scripts/integration-runner.js + rules/integration-test-policy.md | ✓ D20=(c) 拍板 in-place 编辑 |
| **N1-settings** | idle 阈值 settings 化 | 收单单据币种校验 | UX · 可配置 | 🟢 LOW | settings-repository / 应用设置弹框 / acquiring-bill-currency-session + smoke × 2 | ✓ D21=(a) 拍板应用设置弹框 |
| **N4 重构（顺带）** | N4 migration 切到新 backup API | 收单单据币种校验 / 一致性 | 已发代码改动 | 🟡 MID（动 v2.1.8 已合并代码） | migrations.js（ensureBillRawJsonV2Slim 段）+ smoke 回归 | ✓ D22=(a) 拍板是 |
| **SR-log-1** | 全局告警统一日志化 | 全局工程基建 | 大范围 refactor（175+ 49 = 224 处） | 🟡 MID | preload / main.js（49 处 console 改造）/ renderer setStatus + createAlertDialog wrapper / src/backend/logger.js 扩展 + smoke × 4 | ✓ D29-D37 9 项全锁（含 D35 级联取消） |

---

## 四、N5 — 银行渠道区分场景 🔴 资金红线 + 破坏性 migration

### 4.1 背景

2026-05-27 用户立项：银行对账单处理模块需根据银行渠道区分场景。当前调度模型（v2.1.7 F8 + v2.1.8 N3）是**单维 first-match-wins**：所有行过同一个 `scenarios` 列表，按 sort_order 依次匹配，第一个命中即 break。

**问题**：用户实际业务中不同银行渠道有差异化场景需求（如工商-上海有特殊优惠/手续费规则，招商-北京有不同字段映射），单维列表无法区分。

**解决**：引入"银行渠道"维度，scenarios 按渠道分组管理；导入时行匹配渠道后，调度模型变为**双维**：

1. 先按 `<Channel>-<地区>` 匹配渠道库
2. 命中渠道 X → 先过 X 的专属 scenarios（first-match-wins），未命中再过通用 scenarios（first-match-wins）
3. 未匹配任何渠道 → fallback 通用渠道，但保留原始 `<Channel>-<地区>` 用于审计

### 4.2 代码现状（基于 grep）

| 锚点 | 文件:行 | 说明 |
|---|---|---|
| scenarios 表 schema | `src/backend/database/migrations.js:395` | 现有：id / category / name / sort_order / config_json / enabled，**无 channel 关联** |
| Channel + 地区 字段 | `src/constants/bank-statement-fields.js:15-16` | 已是 v2.1.6 标准逻辑字段，column mapping 目标 key |
| 场景管理对话框 | `src/renderer-dialogs.js:5466-5491` | footer 当前只有「新增场景」+「完成」 |
| dispatcher 单维调度 | `src/main-process/scenario-dispatcher.js:66` | runAllScenarios first-match-wins |
| 主输出 xlsx Sheet 3 | `src/main-process/exceljs-writer.js`（v2.1.8 N3-2 引入） | 命中场景行写入分支 |
| 状态框场景号显示 | `src/renderer.js:3345` | v2.1.8 N3-1 已统一 displayIndex |

### 4.3 D2=(c) Reverse Sync 解读

详 `spec.md §2.3` + `backlog.md §D2 reverse sync`。

### 4.4 DB schema 改造

详 `spec.md §3`。

### 4.5 UI 改造

详 `spec.md §4`。

### 4.6 导入匹配（dispatcher + session）

详 `spec.md §2.1` + `spec.md §2.2`。

### 4.7 主输出 xlsx Sheet 3 拆出

详 `spec.md §5`。

### 4.8 重要变量影响

详 `spec.md §9`。

---

## 五、N7 — 场景模板按渠道导入/导出

详 `spec.md §6`。

---

## 六、N6 — 状态框「：」后两次换行 → 一次

详 `spec.md §7`。

---

## 七、SR-backup-1 — sqlite backup API 改造（N5 migration 依赖前置）

详 `spec.md §8`。

---

## 八、G1-cont — 单元测试全量铺（升格自 v2.1.10 候选）

### 8.1 背景

v2.1.8 已完成 G1 框架引入：

- 新增 `tests/unit/` 镜像 src 分层
- `package.json` 加 `"test:unit": "node --test tests/unit/"`
- 累计 123 case / 28 suites（normalizers / c4 主路径 / N2 引擎 / N3 dispatcher / N1 / N4 等）
- 第 1 层（纯函数）：normalizers 全量 / c4 normalizeBillDateValue / findBestAmountSubset / sortRightRowsForManyToOne / currencyMatches
- 第 2 层（带 fixture）：N4 migration / N1 cleanup / N2 引擎 / N3 dispatcher displayIndex

**v2.1.8 留挂**：第 1 层剩余 13 文件 + 第 2 层 24 文件全量未铺（详 v2.1.8 PRD §7.4 范围清单），延期到 v2.1.9。

### 8.2 v2.1.9 范围（37 个 test 文件 / 累计预估 case ≥ 400）

**第 1 层（纯函数，剩余 13 文件）**：

- [ ] `src/backend/file-service/common.js`（FileValidationError 构造与序列化）
- [ ] `src/backend/file-service/error-causes.js`（错误分类映射）
- [ ] `src/backend/acquiring-bill-currency-import/validator.js`
- [ ] `src/backend/bank-bu-recon-import/validator.js`
- [ ] `src/backend/biz-op-recon-import/validator.js`
- [ ] `src/backend/pending-import/validator.js`
- [ ] `src/main-process/scenario-engines/engine-utils.js`
- [ ] `src/main-process/scenario-engines/c1-extract-recon-id.js`
- [ ] `src/main-process/scenario-engines/c2-offset-bill-mark.js`
- [ ] `src/main-process/scenario-engines/c3-gateway-recon-join.js`（含 v2.1.8 N2 mode=custom 主路径，剩余分支）
- [ ] `src/main-process/scenario-engines/c4-recon-id-fix.js`（剩余非 v2.1.8 已覆盖的函数）
- [ ] `src/constants/*.js`（字段表自洽性 — bank-statement-fields / gateway-recon-fields / 等）
- [ ] `src/backend/*-db/columns.js`（schema 完整性 — 4 个 db 模块）

**第 2 层（带 fixture，24 文件）**：

- [ ] `src/backend/database/template-repository.js`（in-memory sqlite）
- [ ] `src/backend/database/scenarios-repository.js`（含 v2.1.9 N5 新增的 listByChannelIdAndCategory）
- [ ] `src/backend/database/channels-repository.js`（v2.1.9 N5 新建）
- [ ] `src/backend/database/settings-repository.js`
- [ ] `src/backend/balance-seed-store.js`
- [ ] `src/backend/balance-adjustment-store.js`
- [ ] `src/backend/big-account-mode-store.js`
- [ ] `src/backend/big-account-order-store.js`
- [ ] `src/backend/own-account-store.js`
- [ ] `src/backend/file-service/readers.js`（tmpdir + 小 fixture xlsx）
- [ ] `src/backend/file-service/writers.js`
- [ ] `src/backend/pending-db/*-repository.js`（4 个）
- [ ] `src/backend/acquiring-bill-currency-db/*-repository.js`（2 个）
- [ ] `src/backend/bank-bu-recon-db/*-repository.js`（2 个）
- [ ] `src/backend/biz-op-recon-db/*-repository.js`（3 个）
- [ ] `src/main-process/monthly-balance.js`
- [ ] `src/main-process/recon-id-fix-engine.js`
- [ ] `src/main-process/statement-generation.js`

### 8.3 决策点 D19（待 spec 拍板）

| ID | 决策点 | 选项 | PM 推荐 |
|---|---|---|---|
| **D19** | 测试框架 + CI 阻断策略 | (a) 沿用 v2.1.8 既定（node:test + CI 不阻断） / (b) 升级到 Vitest / (c) CI 阻断本版升级 | **(a)** — 不破坏 v2.1.8 既定，本版聚焦铺设；CI 阻断留 v2.1.10+ 观察 |

### 8.4 验收

- `npm run test:unit` 累计 case ≥ 400 全绿
- 第 1 层 14 文件全覆盖（含 v2.1.8 已铺 1 + 本版新加 13）
- 第 2 层 24 文件全覆盖
- README 含 unit case 模板 + 新人 30 分钟能上手

---

## 九、SR-policy-1 — integration-runner 自动同步清单

### 9.1 背景

v2.1.8 SR4 沉淀：`scripts/integration-runner.js` 跑完后人工维护 `rules/integration-test-policy.md §七 当前清单` markdown 表 — 容易漏掉。本版自动化。

### 9.2 决策点 D20（待 spec 拍板）

| ID | 决策点 | 选项 | PM 推荐 |
|---|---|---|---|
| **D20** | 输出格式 | (a) 末尾追加 markdown 表全文（每次跑都追加） / (b) 输出到独立文件 `docs/integration-test-clipboard.md` 由用户自行复制粘贴 / (c) **直接 in-place 编辑** `rules/integration-test-policy.md §七` | **(c)** — 直接 in-place 编辑 + 文件头加生成时间戳 + 同时输出到 stdout（防 git diff 噪音视情况评估） |

### 9.3 改动点

- `scripts/integration-runner.js`：末尾收集所有 case 名 + 断言数 + 用时 → 生成 markdown 表 → 用 sed / 字符串替换 in-place 写入 `rules/integration-test-policy.md §七`
- 时间戳格式：`<!-- last-updated: YYYY-MM-DDTHH:mm:ss -->`
- stdout 同步输出便于 CI 日志查看

### 9.4 验收

- 集成测试新增用例自动同步到清单（无需人工 PR）
- 时间戳每次刷新
- `rules/integration-test-policy.md §七` 与 `scripts/integration/*.js` 实际清单 0 偏差

---

## 十、N1-settings — idle 阈值 settings 化

### 10.1 背景

v2.1.8 N1''-D8 拍板「idle 阈值锁硬编码 30min」，预期 v2.1.9 评估配置化。本版升格做。

代码现状：`src/main.js` 内的 `IDLE_CLEANUP_MS = 30 * 60 * 1000` 常量（spec 阶段定位精确位置）。

### 10.2 决策点 D21（待 spec 拍板）

| ID | 决策点 | 选项 | PM 推荐 |
|---|---|---|---|
| **D21** | settings UI 位置 | (a) **应用设置弹框新增字段** / (b) 收单单据币种校验模块独立设置入口 / (c) 暂不做 UI 仅支持手动改 settings 表 | **(a)** — 应用设置弹框新增字段（默认 30min + 范围 5-180min） |

### 10.3 改动点

- `src/backend/database/settings-repository.js`：新增键 `acquiring_bill_idle_cleanup_minutes`
- `src/backend/database/migrations.js`：迁移期幂等插入默认值 30
- `src/main.js`：`IDLE_CLEANUP_MS` 从 settings 读 + change 监听 + 范围校验（5-180）
- 应用设置弹框（spec 阶段定位）：加 input + 保存按钮 + 校验
- IPC `settings:get` / `settings:set` 增加该键支持

### 10.4 验收

- 设置弹框可改值，重启后生效
- 范围外值（如 0 / 200）保存校验报错
- smoke 用例：(1) 默认 30min 行为不变；(2) 改为 60min 后 idle 触发计时器读新值

---

## 十一、N4 重构（顺带）— migration 备份切换到 sqlite backup API

### 11.1 背景

v2.1.8 N4 `ensureBillRawJsonV2Slim`（`src/backend/database/migrations.js`）当前使用 `fs.copyFileSync` 做备份 — v2.1.8 SR2 Important-1 沉淀的 3 大隐患（大库阻塞 / WAL 不一致 / 失败无回滚）。

SR-backup-1 基建落地后顺带改 N4。

### 11.2 决策点 D22（待 spec 拍板）

| ID | 决策点 | 选项 | PM 推荐 |
|---|---|---|---|
| **D22** | 是否本版同步改 v2.1.8 已发的 N4 | (a) **是**（一致性收益 > 返工成本） / (b) 否（v2.1.8 已稳定，N4 不动） / (c) 仅留接口适配 | **(a)** — 既然 backup.js 基建已建，N4 切换成本 0；一致性消除存量风险 |

### 11.3 改动点

- `src/backend/database/migrations.js`：`ensureBillRawJsonV2Slim` 内 `fs.copyFileSync(...)` 替换为 `await createBackup(db, 'pre-N4')`
- 标志位 `settings.bill_raw_json_v2_migrated` 逻辑不变
- 失败回滚路径保持

### 11.4 验收

- v2.1.8 N4 smoke 全跑 0 regression
- N4 migration 首次执行时 `<userData>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite` 文件存在
- 文件大小 = 库大小（atomic）

---

## 十二、SR-log-1 — 全局告警统一日志化（新立项）

### 12.1 背景与现状审计

2026-05-27 用户立项，源于"现在所有的告警都有日志吗"事实查询。grep 审计结果：

| 告警源 | 数量 | 走 activityLog | 持久化率 |
|---|---|---|---|
| main `appendActivityLogEntry` 调用 | 41 处 | 100% | ✅ |
| main `console.error / console.warn` | 49 处 | **0%** | ❌（打包后用户机器看不到） |
| renderer `setStatus` error/warning tone | 45 处 | **0%** | ❌（关闭即失） |
| renderer `createAlertDialog` 错误弹框 | ~50 处（79 处中约 60%） | **0%** | ❌ |
| renderer `console.error / console.warn` | ~30 处 | **0%** | ❌ |
| **合计告警** | **~215 处** | **41 处** | **覆盖率 ≈ 19%** |

**关键缺口**：

1. **renderer 0 持久化** — preload 仅 `reportStartupMetrics` + `reportUserActivity`，无通用告警上报 IPC
2. **main console.error 0 持久化** — 49 处独立调用未配套 `appendActivityLogEntry`
3. **新代码无强约束** — 项目无 ESLint（devDeps 仅 3 个）

### 12.2 9 项决策（D29-D37）全锁

| ID | 决策 | 内容 |
|---|---|---|
| **D29** | (a-修订) | **`logs/{YYYY-MM}/{MM-DD}/{level}.log`** 月+日两层归档（用户拍板修订） |
| **D30** | (a) | 仅级别 error/warning/info（3 类） |
| **D31** | (b) | JSON Lines 格式 |
| **D32** | (a) | 永久保留（用户拍板） |
| **D33** | (a)+(c) | preload 单接口 `desktopApi.reportLog` + wrapper hijack setStatus/createAlertDialog |
| **D34** | (a) | 双写 `app_activity_log.txt`（v2.1.9 兼容 1 版本） |
| **D35** | 取消 | D32 永久保留级联推断；不实施清理机制 |
| **D36** | (a) | 仅文件系统暴露（用户拍板，不加 UI 按钮） |
| **D37** | (b) | 暂不引 ESLint，靠 PR review + USER_GUIDE 提醒 |

### 12.3 日志目录结构（D29 修订）

```
Documents/网银账单生成小助手/
├── app_activity_log.txt              # D34=a 保留双写
├── logs/                             # D29 新结构
│   ├── 2026-05/                      ← 月级归档
│   │   ├── 05-27/                    ← 日级目录
│   │   │   ├── error.log             ← JSON Lines
│   │   │   ├── warning.log
│   │   │   └── info.log
│   │   ├── 05-28/
│   │   └── ...
│   ├── 2026-06/
│   └── 2027-05/                      ← 跨年自然归档
└── error-reports/                    # 业务专属，不动
```

### 12.4 JSON Lines 行格式（D31）

每行一个 JSON 对象（无逗号 / 无外层 array）：

```json
{"ts":"2026-05-27T14:32:18.456+08:00","level":"error","source":"renderer","domain":"db","message":"数据库连接失败","details":["ECONNREFUSED","retry=3"],"stack":"..."}
{"ts":"2026-05-27T14:32:19.012+08:00","level":"warning","source":"main","domain":"migration","message":"N5 channels 表创建","details":["channels.id=1","is_builtin=1"]}
```

字段定义：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `ts` | ISO 8601 with TZ | 是 | 时间戳精度 ms |
| `level` | enum: error/warning/info | 是 | 级别 |
| `source` | enum: main/renderer | 是 | 进程来源 |
| `domain` | string | 否 | 可选域标签（business/migration/ipc/ui/db/startup/unknown）|
| `message` | string | 是 | 主消息 |
| `details` | string[] | 否 | 附加细节列表 |
| `stack` | string | 否 | error 时附 stack trace |

### 12.5 preload IPC + wrapper hijack（D33）

```js
// preload 暴露
desktopApi.reportLog: (payload) => ipcRenderer.send('app:report-log', payload)

// main handler 收 IPC → appendActivityLogEntry 写新结构

// renderer setStatus 内部 wrapper hijack
function setStatus(message, tone = 'info', options = {}) {
  /* 现有逻辑 */
  if (tone === 'error' || tone === 'warning') {
    try {
      desktopApi.reportLog({ level: tone, source: 'renderer', domain: 'ui', message });
    } catch (e) { /* graceful */ }
  }
}

// createAlertDialog 工厂内部同理
```

**调用方零改动** — 所有现有 `setStatus(msg, 'error')` 自动上报。

### 12.6 main 端 49 处 console.error 改造

```js
// 改前
console.error('[xxx] 失败', err);

// 改后
appendActivityLogEntry({ level: 'error', source: 'main', domain: 'xxx', message: '[xxx] 失败', details: [err.message], stack: err.stack });
```

### 12.7 兼容策略（D34=a 双写）

v2.1.9 期间 `appendActivityRecord` 内部**同时**写新结构 + `app_activity_log.txt`；v2.1.10 评估删旧。

### 12.8 风险（CLAUDE.md 规则 7）

| 风险 | 等级 | 缓解 |
|---|---|---|
| 大范围 refactor 224 处调用 | 🟡 MID | wrapper hijack 集中改 2 处工厂 + main 49 处批量改 + grep `console.error` 监控防回退 |
| 永久保留磁盘膨胀 | 🟡 数据保留 | USER_GUIDE 写明日志位置；v2.1.10+ 评估批量清理 UI |
| renderer wrapper hijack 异常阻塞 UI | 🟡 兼容 | try-catch graceful + smoke 覆盖 setStatus 原 4 状态行为不变 |
| 新代码遗漏 console.error | 中 | PR review + USER_GUIDE 显式约束；v2.1.10+ 视情况引 ESLint |

### 12.9 验收

- 日志目录 `logs/{YYYY-MM}/{MM-DD}/{level}.log` 自动按需创建
- JSON Lines 单行可被 `cat | jq -c .` 解析
- renderer `setStatus(msg, 'error')` 自动写 `error.log`
- main `grep "console\.error" src/` 命中 = 0
- `app_activity_log.txt` 仍正常 append（双写）

---

## 十三、验收矩阵（含 SR-log-1）

| 验收项 | 验证方式 | 预期 |
|---|---|---|
| N5 channels 表 migration 幂等 | smoke 启动两次 | 第二次不报错 + 数据不变 |
| N5 老库（v2.1.8）升级 → 所有 scenarios 归到「通用」 | 集成测试 | scenarios.channel_id 全部 = 1 |
| N5 渠道 CRUD（新增/修改/删除/转移/批量） | 手测 + smoke | 数据正确落库 + UI 即时刷新 |
| N5 dispatcher 专属优先 / 通用兜底 / 未匹配 fallback | 集成测试 | 4 种行结果矩阵全覆盖 |
| N5 主输出 xlsx 不再含 Sheet 3 | smoke | sheetCount=2 |
| N5 独立报表落 error-reports + 列序 + 文件名 | 手测 | 文件存在 + 含 3 列 + 命名规范 |
| N5 「通用」渠道不可删 + 不可改名 | 手测 | UI 按钮 disabled |
| N6 状态框冒号后只换一次行 | preview 截图 + 手测 | 银行对账单 4 状态对比 v2.1.8 |
| N6 其他 5 模块状态框零外溢 | preview 截图 | 与 v2.1.8 一致 |
| N7 多选导出生成单文件多渠道结构 | smoke + 手测 | JSON 结构匹配 spec §6.1 |
| N7 导入冲突处理（缺失渠道 / 同名场景） | 手测 + smoke | 弹框 + 结果框 |
| N7 误用 bundleVersion=4 文件导入 | 手测 | 错误提示「文件类型不匹配」 |
| SR-backup-1 大库备份不阻塞 | smoke | 主进程响应延迟 < 100ms |
| SR-backup-1 失败 → 不留半文件 + activityLog | smoke + 故障注入 | 测试目录无残留文件 |
| **G1-cont** test:unit 全跑 case ≥ 400 全绿 | `npm run test:unit` | 0 失败 + 0 跳过 |
| **G1-cont** 第 1 层 14 / 第 2 层 24 文件全覆盖 | 文件存在性检查 | 文件清单 100% |
| **SR-policy-1** integration-runner 自动同步清单 | 集成测试 + git diff | 表内容与 scripts/integration/*.js 一致 + 时间戳每次刷新 |
| **N1-settings** 设置弹框可改值 | 手测 | 重启后生效 + 范围外校验报错 |
| **N1-settings** 默认值兼容 | smoke | settings 表无该键时取默认 30min |
| **N4 重构** v2.1.8 N4 行为不变 | smoke | 0 regression |
| **N4 重构** 备份文件落新路径 | smoke | `<userData>/backups/tool-data-bak-pre-N4-*` 存在 |
| **SR-log-1** 日志目录 `logs/{YYYY-MM}/{MM-DD}/{level}.log` 自动创建 | 启动 + 触发告警 | 三个 level 文件按需自动建 |
| **SR-log-1** JSON Lines 格式可解析 | `cat error.log \| jq -c .` | 每行独立 JSON 对象，0 解析错误 |
| **SR-log-1** renderer `setStatus(msg, 'error')` 自动写日志 | 集成测试 | error.log 含对应记录 |
| **SR-log-1** main 49 处 console.error 0 命中 | `grep "console\.error" src/` | 0 命中（除 logger.js / electron 错误处理兜底外） |
| **SR-log-1** 双写 `app_activity_log.txt` 兼容 | smoke | 旧文件仍正常 append |

---

## 十四、风险汇总

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| Sheet 3 输出契约二次变更（v2.1.8 加 → v2.1.9 拆） | 🔴 资金红线 | USER_GUIDE / CHANGELOG 显式说明；影响用户后处理脚本 |
| DB schema 破坏性 migration（channels + FK + backfill） | 🔴 不可逆 | SR-backup-1 前置；活动日志；失败回滚；幂等 |
| dispatcher 调度模型双维改造 | 🔴 对账契约 | scan:vars 必跑 + 集成测试新增渠道维度用例 6+ 个 + smoke 全跑 |
| 「转移」搬运语义不可逆 | 🟡 用户操作 | 转移弹框二次确认 + 活动日志记录 |
| N7 bundle 文件版本号互认隔离不严 | 🟡 兼容 | reader 严格按顶层 key 分流；类型不匹配报错 |
| N6 改 updateStatusBox 内层风险（已 D18=a 规避） | 🟢 已规避 | 仅改外层 2 行；其他 5 模块零外溢回归验证 |
| **G1-cont** case 期望值"权威性" | 🟡 工程基建 | spec 阶段评审 case 期望值（业务真实 vs 实现 bug 复刻）；与 v2.1.8 同标准 |
| **G1-cont** 工期挤压 N5 主线 | 🟡 资源 | G1-cont 与 N5 并行；G1-cont 单文件无依赖其他主线 |
| **SR-policy-1** in-place 编辑导致 git diff 噪音 | 🟢 LOW | 仅 §七 章节内 + 时间戳行；若 noise 太大改为只输出 stdout |
| **N1-settings** 范围校验绕过 | 🟢 LOW | 前端 + 后端双重校验 |
| **N4 重构** 改 v2.1.8 已发代码 | 🟡 已发代码 | smoke + 集成测试全跑保 N4 行为不变 |
| SR-backup-1 sqlite backup API Electron 36 兼容 | 🟢 LOW | spec 阶段 POC 验证 + fallback `BEGIN IMMEDIATE` + copyFileSync + ROLLBACK |
| **SR-log-1** 大范围 refactor 224 处调用 | 🟡 MID | wrapper hijack 集中改 2 处工厂 + main 批量改 + grep 监控防回退 |
| **SR-log-1** 永久保留磁盘膨胀 | 🟡 数据保留 | USER_GUIDE 写明日志位置；v2.1.10+ 评估批量清理 UI |
| **SR-log-1** renderer wrapper hijack 异常阻塞 UI | 🟡 兼容 | try-catch graceful + smoke 覆盖 setStatus 原 4 状态行为不变 |
| **SR-log-1** 新代码遗漏 console.error | 中 | PR review + USER_GUIDE 显式约束；v2.1.10+ 视情况引 ESLint |

### 14.1 资金红线提醒（CLAUDE.md 规则 7）

⚠️ **本版 α 资金/对账/状态机相关变更**：N5 dispatcher 调度模型改造 + DB schema 破坏性 migration + Sheet 3 输出契约变更 + N5 转移搬运语义。

**强制要求**：

1. spec 阶段必须有专门 reviewer 审 N5
2. 实施前必须确认 DB 备份策略（SR-backup-1 前置）
3. 集成测试硬约束：N5 渠道维度用例 ≥ 6 个，0 regression
4. PR 提交前必须跑 `/check-vars` skill

---

## 十五、文档三件套登记（发版前一次性更新）

按 CLAUDE.md 约束，下列文档**版本号 bump 时统一更新**：

- [ ] `CHANGELOG.md` — v2.1.9 章节 + N5/N6/N7 高亮 + **Sheet 3 拆出破坏性变更警告** + G1-cont 累计 case ≥ 400 工程基建 + SR-policy-1 / N1-settings / N4 重构 + **SR-log-1 全局告警日志化（含新日志目录 + 用户需手动清理说明）**
- [ ] `docs/VERSION_FEATURE_HISTORY.md` — v2.1.9 历史栏 + 银行渠道维度引入 + bundle 类型新增 + 单元测试全量铺 + 全局告警日志化
- [ ] `docs/USER_GUIDE.md` — 「场景管理」+ 「银行对账单处理」章节重写 + 渠道概念入门 + 导入导出操作 + 兜底机制说明 + 独立报表位置 + 「收单单据 idle 清理阈值」设置项 + **「故障排查」章节新增日志位置说明** `logs/{YYYY-MM}/{MM-DD}/{level}.log`

---

## 十六、实施记录（dev 阶段填）

### PR #X — v2.1.9 α 发版（待提交）

- **PR**：待创建
- **分支**：v2.1.9 → main
- **commit 数**：待统计
- **完整改动记录**：待归档 `docs/prs/PR{N}-v2.1.9.md`

#### 主题完成度

| 主题 | 状态 | 备注 |
|---|---|---|
| **N5** 银行渠道区分场景 | ⏳ 待启动 | 11 决策全锁 |
| **N6** 状态框换行修复 | ⏳ 待启动 | D18=a 全锁 |
| **N7** 场景模板按渠道导入/导出 | ⏳ 待启动 | 6 决策全锁 |
| **SR-backup-1** sqlite backup API 前置 | ⏳ 待启动 | N5 + N4 重构依赖 |
| **G1-cont** 单元测试全量铺 | ⏳ 待启动 | D19=(a) 沿用 v2.1.8 ✓ |
| **SR-policy-1** integration-runner 自动同步 | ⏳ 待启动 | D20=(c) in-place 编辑 ✓ |
| **N1-settings** idle 阈值 settings 化 | ⏳ 待启动 | D21=(a) 应用设置弹框 ✓ |
| **N4 重构（顺带）** | ⏳ 待启动 | D22=(a) 是 ✓ |
| **SR-log-1** 全局告警日志化 | ⏳ 待启动 | D29-D37 9 项全锁（含 D35 级联取消）|

#### 拆 v2.1.9-α / v2.1.10-β 后延期到 v2.1.10

详 `docs/iterations/v2.1.10/backlog.md`：

- A3（runCheck 跨进程化）
- A4（SQL JOIN chunked LIMIT/OFFSET）
- N4-cont-1（raw_json 体积治理）
- N4-cont-2（FK CASCADE 改造）

#### 继续延期到 v2.1.11+

- F5-cont（C4 manyToOne ILP / 网络流重写）
- N5-channels-scale（渠道虚拟滚动评估）

---

**当前状态**：v0.2（2026-05-27 — α / β 拆分；4 项 v2.1.10 候选升格到 α；D19-D22 4 个新决策点待拍板）。
**下一步**：spec.md / tasks.md / manual-test-checklist.md 反向同步加 4 个新主题 → 用户审 → 建 v2.1.9 分支 → Phase 0 启动。

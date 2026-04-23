# Log — v2.0.0

> 按日期倒序；Dev / 讨论 / 决策 / 风险 发现都记这里。

---

## 2026-04-23

### 动作

- PRD v0 → v1 定稿（10 个 OT 全部拍板）
- TechDoc v0 完成（§一 评审 + §二 文件清单 + §三 实现方案 + §四 任务分解 + §五 commit 计划 + §七 TechDoc OT 6 个）
- changes/v2.0.0/{spec, tasks, log, test-spec}.md 骨架建立
- `assets/Pending.xlsx` 模板已复制到项目，31 列表头读取确认

### 证据

- PRD 位置：`docs/iterations/v2.0.0/PRD-v2.0.0.md`
- TechDoc 位置：`docs/iterations/v2.0.0/TechDoc-v2.0.0.md`

### 风险

- **R-T1 性能 300 万行 < 3 分钟**：Dev 初步评估可能超标；若实测 5+ 分钟，TechDoc OT-T1 建议放宽 PRD 目标到 5 分钟（等 Task 5 实测后决定）
- **资金敏感**：对账 engine 三类差异（new/missing/changed）语义错误会直接让用户做错决策；Task 7 + Task 9 必须人工小样本核对

### 决策

- OT-1 ~ OT-10 见 PRD §十
- TechDoc OT-T1 ~ OT-T6 见 TechDoc §七

### 可沉淀知识

- [ ] 300 万行 SQLite 批量 INSERT 优化经验（Task 5 完成后写到 `knowledge/`）
- [ ] xlsx 大文件 child process 模式（已在 v1.5.3 pdf-worker 有先例，v2.0.0 扩展到 xlsx）
- [ ] 对账 SQL 生成（动态 matchFields / compareFields）模式（Task 7 完成后写到 `knowledge/`）

---

### T1 完成

**动作**：
- 新建 `src/backend/pending-db.js` + `pending-db/migrations.js` + `pending-db/columns.js`
- `src/main.js` 启动序列加 `openPendingDb`（try-catch 保护，不阻塞启动）

**证据**：
- `node --check` 4 个文件全绿
- `openPendingDb` 实测产出 5 张业务表 + 5 索引 + 34 列 `pending_rows` 表
- 幂等验证（重复 open 不报错）

### T2 决策（Reverse Sync）

**发现**：`index.html:30-39` 现有顶部模块切换本身就是**自定义下拉**（button 触发 menu 展开），不是简单按钮。

**决策**：保留现有自定义下拉，仅追加第 3 项菜单。CSS / 事件 / 动画全部保留。TechDoc §3.1 + §二 已回写。

**证据**：
- `index.html:31-38` 自定义下拉结构
- `src/renderer.js:1066-1079` setCurrentModule + :1081-1091 open/closeModuleMenu + :3002-3015 click handlers + :3083-3090 外部点击关闭
- 改动范围因此大幅缩小（无需新增 `setCurrentTopModule` 函数、无需删除展开动画）

### T2 / T3 / T4 完成

**T2 动作**：
- `index.html` moduleSwitcherMenu 追加 `<button data-module="pending-reconciliation">`
- `src/renderer.js:39-52` MODULES 加 `pendingReconciliation`
- `src/renderer.js:1066-1082` setCurrentModule 从二选扩三选（按 id 查字典取 name + 三 panel 联动）

**T3 动作**：
- `index.html` 在 newAccountModulePanel 后加 `#pendingModulePanel`（2 行布局）+ 引入 `renderer-pending.js` script
- `src/renderer.js` elements 加 6 个 pending DOM ref + state.pending 初始化 + initialize 阶段调用 rendererPending.initialize / bindEvents
- 新增 `src/renderer-pending.js`（骨架：computePendingStatusText / refreshPendingUi / initialize / bindEvents）

**T4 动作**：
- 新增 `src/backend/pending-db/rule-repository.js`（getRule / upsertRule，单条全局 `__GLOBAL__`）
- `src/main.js` 3 个 IPC handlers：`pending:columns` / `pending:rule:get` / `pending:rule:save`
- `src/preload.js` 暴露 `window.desktopApi.pending.{getColumns, getRule, saveRule}`
- `src/renderer-pending.js` 升级：loadColumns / buildRuleDialogNode（两 `<select multiple>`）/ handleRuleConfirm（createConfirmDialog 二次确认）/ handlePendingRuleClick

**T4 偏离 PRD §5.3.4**：
- PRD 原意：点多选下拉外部区域 → 自动弹 confirm 保存
- T4 实现：用 Save / Cancel 按钮明确出口（点 Save → confirm → IPC 保存）
- 原因：`<select multiple>` 的 blur 事件语义复杂（切选项就会 blur）；明确按钮对用户更友好
- 状态：待 T10 状态框完整流时评估是否需要补充 blur-to-save 快捷路径（当前最小化先出）

**验证**：
- `node --check` 所有 T1-T4 新/改文件绿
- `rule-repository` E2E 脚本 6 场景全过（空读 / 新建 / 读 / 覆盖更新 / 单行约束 / malformed 降级）
- `npm run smoke` 通过（v1.5.3 现有功能不回退）

**check-vars 自查（T1-T4 累积）**：
- Important-skeleton: `ipcRenderer` — preload 新 pending 对象，main 同步注册 3 handler ✅
- Runtime-state: `MODULES` / `elements` / `state` / `app` — 均为新增引用，未破坏现有语义 ✅

---

### T5 完成（import worker + 校验 + 批量 INSERT）

**动作**：
- 新增 `src/backend/pending-import/validator.js`
  - `validateHeaders(row)` — 严格对比 PENDING_COLUMNS（顺序 + 内容）
  - `validateFundType(value)` — ∈ {提现/退票/充值} 枚举
  - `computeRowHash(cells)` — SHA-1 拼串（SOH `\u0001` 分隔符）
- 新增 `src/backend/pending-import/worker.js`
  - child process 入口：`node worker.js <jobMetaJson>`
  - jobMeta = `{ dbPath, yearMonth, files, archivePath? }`
  - 事件流到 stdout：`progress` / `error` / `complete`
  - 退出码：0 成功 / 1 校验失败 / 2 系统错误
  - DB 写入：`BEGIN` → `deleteMonth`（覆盖）→ prepared statement 逐行 INSERT → `upsertMonthMeta` → `COMMIT`；任一失败 `ROLLBACK`
- 新增 `src/backend/pending-db/month-repository.js`
  - countRowsInMonth / listMonths / getMonthMeta / upsertMonthMeta / deleteMonth
  - `createRowInserter(db)` 返回 prepared statement 闭包（31 列 INSERT）
- 新增 `scripts/test-v2.0.0-pending-import.js` + package.json `test:v2.0.0:pending-import` script
  - 21 断言，7 场景：happy / 表头错 / fund_type 错 / 多文件合并 / 跨文件冲突 / DB 状态 / 覆盖模式

**验证**：
- `node --check` T5 所有新文件绿
- `npm run test:v2.0.0:pending-import` → 21/21 全过
- `npm run smoke` → 通过（v1.5.3 现有功能不回退）

**check-vars 自查（T5 增量）**：
- T5 只改动 src/backend/pending-* 下新文件；现有清单变量 0 命中
- 新候选升格：`PENDING_COLUMNS`（跨 4 文件：migrations.js / columns.js / validator.js / worker.js）—— T6+ 继续扩散后跑 scan:vars 评估升格到 Critical

**T5 关键决策**：
- worker **内部再做 `deleteMonth`**：防御性，即使父进程忘了删（T6 实现 session 时会显式删），worker 仍能保证一个 year_month 对应一套数据
- child process 启动先不加 `--max-old-space-size=8192`（T6 主进程 spawn 时加；单元测试走常规 heap 也够 happy path）
- Errors 收集模式：校验阶段**收集所有错误**（不 early exit），让用户一次看到所有问题后批量修（不是打地鼠式逐条）

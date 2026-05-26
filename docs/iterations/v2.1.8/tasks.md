# Tasks — v2.1.8 任务拆分

| 字段 | 值 |
|---|---|
| 文档版本 | v0.2（2026-05-26 — N1 方案重设，Phase 6 加 §八.1 v0.7 增量章节 T31a-f；旧 T28-T32 部分超越，状态见各 task 标注；spec v0.8 / PRD v0.7 同步）；v0.1 起草 |
| 关联文档 | `PRD-v2.1.8.md` / `spec.md` |
| 任务总数 | 38 |
| 任务拆分原则 | 单 task 3-5 文件内（CLAUDE.md 小批次原则）；按文件粒度拆，避免 task 间共享文件 |

---

## 一、任务总览

| 阶段 | task 数 | 累计工期 | 关键产出 |
|---|---|---|---|
| Phase 0 - 准备 | 3 | 1-2 天 | 分支 + scan:vars + fixture 归档 |
| Phase 1 - G1 框架 | 4 | 3-5 天 | tests/unit/ + node:test 跑通 + 第 1 层 1 个示例文件 |
| Phase 2 - F5 实现 | 5 | 4-5 天 | 算法重设 + smoke + G1 c4 unit case |
| Phase 3 - G1 全量铺 | 6 | 5-7 天 | 第 1 层剩余 + 第 2 层全部 |
| Phase 4 - N2 实现 | 5 | 2-3 天 | dialog + 引擎 + migration |
| Phase 5 - N3 实现 | 4 | 2-3 天 | dispatcher + writer + IPC 字段 |
| Phase 6 - N1 实现 | 5 | 2-3 天 | app.before-quit + migration + 兜底（v0.6 β 落地） |
| Phase 6.1 - N1' v0.7 增量 | 6 | 1-1.5 天 | idle 30min + 差异保留 + before-quit 简化 + smoke 重写 |
| Phase 7 - A3 实现 | 5 | 5-7 天 | worker + IPC 桥接 + smoke |
| Phase 8 - A4 决策 | 1 | 0.5 天 | 做 / 不做评估 |
| Phase 9 - 收尾 | 5 | 2-3 天 | 三件套 + check-vars + PR |

---

## 二、Phase 0 — 准备

### T01 — 建立 v2.1.8 工作分支

- **Owner**：用户
- **依赖**：v2.1.7 → main 合并完成
- **动作**：`git checkout main && git pull && git checkout -b v2.1.8`
- **验收**：`git branch --show-current` = `v2.1.8`

### T02 — 重跑 scan:vars 评估升格

- **Owner**：PM
- **依赖**：T01
- **动作**：`npm run scan:vars`；对照 spec.md §七 升格建议，更新 `rules/important-variables.md`
- **验收**：scan-vars 报告刷新 + important-variables 含 N1/N2/N3/F5/A3 涉及新条目

### T03 — TEST.xlsx / TEST2.xlsx fixture 归档

- **Owner**：PM
- **依赖**：T01
- **动作**：将 `/Users/pzhong/Desktop/小助手-Debug/2.1.7/` 下 TEST.xlsx / TEST2.xlsx 拷贝到 `scripts/fixtures/v2.1.8/`（或 `tests/unit/fixtures/`）
- **验收**：文件存在 + smoke 可读

---

## 三、Phase 1 — G1 单元测试框架搭建

### T04 — package.json 加 test:unit 脚本

- **Owner**：Dev
- **依赖**：T01
- **文件**：`package.json`
- **动作**：新增 `"test:unit": "node --test tests/unit/"` + `"test:unit:coverage": "node --test --experimental-test-coverage tests/unit/"`
- **验收**：`npm run test:unit` 命令存在（即使无 case 也应正常退出）

### T05 — 建立 tests/unit/ 目录结构（镜像 src）

- **Owner**：Dev
- **依赖**：T04
- **文件**：`tests/unit/README.md` + `tests/unit/.gitkeep`
- **动作**：建立目录骨架：
  ```
  tests/unit/
    backend/
      file-service/
      database/
      acquiring-bill-currency-db/
      ...
    main-process/
      scenario-engines/
    constants/
    fixtures/
  ```
- **验收**：目录存在 + README 含目录说明 + 镜像 src 分层

### T06 — 第 1 个 unit case 示例：normalizers.js

- **Owner**：Dev
- **依赖**：T05
- **文件**：`tests/unit/backend/file-service/normalizers.test.js`
- **动作**：用 `node:test` + `node:assert` 写第 1 批 case，覆盖日期归一 / 金额归一 / 币种归一 各 5+ case
- **验收**：`npm run test:unit` 全绿 + case ≥ 15

### T07 — G1 框架使用文档

- **Owner**：PM
- **依赖**：T06
- **文件**：`tests/unit/README.md`（扩展）
- **动作**：写 unit case 模板 + 命名规范 + fixture 复用模式 + 与 smoke 边界说明
- **验收**：README 含示例 + 新人 30 分钟能上手

---

## 四、Phase 2 — F5 算法重设

### T08 — BillDate 字符串化 fix（Reverse Sync v0.2 改）

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/main-process/scenario-engines/c4-recon-id-fix.js`（**改文件 from recon-id-fix-io.js**）+ `tests/unit/main-process/scenario-engines/c4-recon-id-fix.test.js`（unit case）
- **动作**：
  - `c4-recon-id-fix.js:1058-1065` gateway 映射段：把 `createTime` number 序列号（Excel 序列号）转 ISO 'YYYY-MM-DD' 字符串后赋给 `BillDate`
  - 用 `XLSX.SSF.parse_date_code()` 把 number → 日期对象 → ISO 字符串（normalizers.js 内部已有先例）
  - **不动** `recon-id-fix-io.js:70` raw 模式（spec F5-D4 v0.3 Reverse Sync — 共用函数影响 8 sheet × N 字段，资金红线扩面）
- **验收**：
  - unit case：createTime = 46168（number）→ BillDate = '2026-05-22'（字符串）
  - unit case：createTime = '2026-05-22'（字符串）→ BillDate = '2026-05-22'（不变）
  - unit case：createTime = ''（空）→ BillDate = ''（不变）
  - 手测 TEST2.xlsx：F5 还没全部做完前看 28 行 baseline 应稳定（不应回退到 0 行）

### T09 — findBestAmountSubset 放开 maxSize

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/main-process/scenario-engines/c4-recon-id-fix.js`
- **动作**：按 spec F5-D1 实现动态 maxSize（pool ≤ 12 → 全跑 / 12-20 → maxSize=12 / > 20 → maxSize=10 + warn）
- **验收**：unit case 验证多档位行为

### T10 — tryManyToOnePool 遍历顺序改造

- **Owner**：Dev
- **依赖**：T09
- **文件**：`src/main-process/scenario-engines/c4-recon-id-fix.js`
- **动作**：按 spec F5-D2 改"金额降序 + 子集大小降序"复合排序
- **验收**：unit case 验证大渠道先消费

### T11 — currency 字段过滤增强

- **Owner**：Dev
- **依赖**：T10
- **文件**：`src/main-process/scenario-engines/c4-recon-id-fix.js`
- **动作**：按 spec F5-D3 在候选池构造时加 currency 等值过滤
- **验收**：unit case 验证候选池缩小

### T12 — F5 smoke + unit case 沉淀（v0.4 范围收敛 / 部分完成 2026-05-26）

- **Owner**：Dev + Tester
- **依赖**：T11
- **文件**：`scripts/test-v2.1.8-f5-baseline.js`（smoke）+ `tests/unit/main-process/scenario-engines/c4-recon-id-fix.test.js`（unit）+ `src/main-process/scenario-engines/c4-recon-id-fix.js`（_maxSizeOverride 调试入口）
- **完成内容**：
  - ✅ scripts/test-v2.1.8-f5-baseline.js — fixture smoke 跑 F5-TEST2.xlsx 多档位（default/16/20）
  - ✅ 全套 v2.1.7 smoke suite 0 regression（T11 实测 ✅ 全绿 21+ suites）
  - ✅ unit case：normalizers + c4 normalizeBillDateValue + findBestAmountSubset 动态档位 + sortRightRowsForManyToOne + currencyMatches（111 case 全绿）
- **部分完成 / 延期 v2.1.9**：
  - ❌ TEST2.xlsx 57 行 acceptance 未达：实测 default 28 行 / maxSize=16 甜点 43 行
  - 根因 #5 发现（T12 孤立测试）：subset-sum 剪枝在 38 行 pool + maxSize=30 时漏掉 sum=$9.75M 的 16 行子集解；仅 16 行 candidates 时 ✅ 找到
  - 需要 ILP/网络流范式重写算法，DFS + 剪枝架构无法保证全局最优 → 延期 v2.1.9
- **保留产物**：
  - `_maxSizeOverride` 调试入口（cfg 内部字段，正常 IPC handler 不传，spec F5-D1 默认档位走；spec 评估 / unit case / fixture smoke 用）
  - F5-TEST2.xlsx fixture（已归档 scripts/fixtures/v2.1.8/）保留供 v2.1.9 继续使用
- **验收**：smoke 全绿 + unit ≥ 15 case

---

## 五、Phase 3 — G1 全量铺设

### T13 — 第 1 层覆盖（剩余 13 文件）

- **Owner**：Dev
- **依赖**：T06
- **文件**：见 PRD §7.4 第 1 层列表（normalizers 已在 T06）
- **动作**：每文件按 spec/README 模板写 case，平均 10+ case/文件
- **验收**：`npm run test:unit` 全绿 + 第 1 层 14 文件全有 case

### T14 — 第 2 层覆盖：database/*-repository（3 文件）

- **Owner**：Dev
- **依赖**：T13
- **文件**：`tests/unit/backend/database/{template,scenarios,settings}-repository.test.js`
- **动作**：用 `:memory:` SQLite + migration setup 写 case
- **验收**：CRUD case + migration idempotent case 全覆盖

### T15 — 第 2 层覆盖：store 类（5 文件）

- **Owner**：Dev
- **依赖**：T13
- **文件**：`tests/unit/backend/{balance-seed,balance-adjustment,big-account-mode,big-account-order,own-account}-store.test.js`
- **动作**：用 tmpdir 写 case
- **验收**：所有 store 增删改查 case

### T16 — 第 2 层覆盖：reader/writer（2 文件 + fixture）

- **Owner**：Dev
- **依赖**：T13
- **文件**：`tests/unit/backend/file-service/{readers,writers}.test.js` + `tests/unit/fixtures/sample-*.xlsx`
- **动作**：写最小 xlsx fixture + case 覆盖正常 / 缺列 / 空表
- **验收**：fixture + case 跑通

### T17 — 第 2 层覆盖：业务 DB repository（11 文件）

- **Owner**：Dev
- **依赖**：T13
- **文件**：`tests/unit/backend/{pending-db,acquiring-bill-currency-db,bank-bu-recon-db,biz-op-recon-db}/*.test.js`
- **动作**：用 `:memory:` SQLite + 各模块 schema setup 写 case
- **验收**：所有 repository 公开方法有 case

### T18 — 第 2 层覆盖：main-process（3 文件）

- **Owner**：Dev
- **依赖**：T13 + T17
- **文件**：`tests/unit/main-process/{monthly-balance,recon-id-fix-engine,statement-generation}.test.js`
- **动作**：mock store + DB 写 case
- **验收**：核心计算路径有 case

---

## 六、Phase 4 — N2 自取值实现

### T19 — ~~constants 新增"自取值"枚举~~（v0.6 撤回 — constants 不改）

**v0.6 撤回原因**：实施前 grep 发现 GATEWAY_RECON_FIELDS 被 `bank-statement-io.js:114` 用作网关账单 reader 表头校验 + 多处条件下拉，加 `'__CUSTOM__'` 会破坏 reader。改为在 dialog 渲染层 T20 单独拼接 option，constants 保持不变。

- **状态**：cancelled / 合并到 T20
- **important-variables**：GATEWAY_RECON_FIELDS 撤回 Important-skeleton 升格

### T20 — C3 dialog UI 改造（v0.5 修订 — assign-gw 数据源下拉，非 assign-bank）

- **Owner**：Dev
- **依赖**：T19
- **文件**：`src/renderer-dialogs.js`（C3 dialog factory 约 6103-6233）
- **动作**：
  - assign-gw select 渲染：在 GATEWAY_RECON_FIELDS 选项前先拼 `<option value="__CUSTOM__">自取值</option>`（按 N2-D6 第 2 位规则）；options 列表中遇到 '__CUSTOM__' 字符串时跳过（避免重复）
  - **assign-gw** change 事件：选 `__CUSTOM__` → 该 select 右侧显示 `<input type="text" maxlength="200" placeholder="自取值">` + 设 `assign.mode='custom'`；选真实字段 → 隐藏 input + 设 `assign.mode='direct'`
  - dialog HTML 在 assign-gw select 右侧加 input 容器（默认 hidden）
  - 保存校验：mode='custom' && customValue 空 → 校验报错 "自取值不能为空"
  - 打开时按 `assign.mode` 回显：'custom' → 显示 input + 填回 customValue；'direct' → 隐藏 input
- **验收**：preview 截图 + 手测（dialog 切换 dropdown / 保存 / 重开回显）

### T21 — DB migration

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/backend/database/migrations.js`
- **动作**：幂等 migration 扫描 scenarios where category='gateway-recon-join'，对 config_json 缺 `assign.mode` 的补 `mode='direct'`
- **验收**：unit case（启动 migration + 验证旧 scenario 升级）

### T22 — C3 引擎赋值分支（v0.5 修订）

- **Owner**：Dev
- **依赖**：T19 + T21
- **文件**：`src/main-process/scenario-engines/c3-gateway-recon-join.js`（:158-172）+ `tests/unit/main-process/scenario-engines/c3-gateway-recon-join.test.js`（unit）
- **动作**：
  - :158-172 修改：
    ```js
    const newValue = (assign.mode === 'custom')
      ? String(assign.customValue || '')
      : normalizeCellValue(chosen.row[assign.gwField]);
    ```
  - 旧 reader 兼容：若 mode 字段缺失 → 默认走 'direct' 分支
- **验收**：unit case
  - mode='custom' + customValue='ABC123' → newValue='ABC123'
  - mode='custom' + customValue='' → newValue='' （后续 dialog 校验拦截）
  - mode='direct' / mode 缺失 → 行为不变（按 gwField 取值）
  - mode='direct' + gwField='__CUSTOM__'（异常状态）→ newValue='' graceful 不抛错

### T23 — N2 smoke

- **Owner**：Dev + Tester
- **依赖**：T22
- **文件**：`scripts/test-v2.1.8-n2-custom-assign.js`
- **动作**：smoke 覆盖：
  - 旧 scenario 升级 → 行为不变
  - 新 scenario mode='custom' → 引擎赋值
  - dialog 保存校验
- **验收**：smoke 全绿

---

## 七、Phase 5 — N3 银行对账单修复 + Sheet 3

### T24 — displayIndex 派发口径统一

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/backend/database/scenarios-repository.js`
- **动作**：按 spec §5.3 在 `listScenarios` 返回时附 `displayIndex` 字段（1-based 按 sort_order + id）
- **验收**：unit case + grep 调用方

### T25 — dispatcher + IPC 字段重命名

- **Owner**：Dev
- **依赖**：T24
- **文件**：`src/main-process/scenario-dispatcher.js`（:99）+ `src/main.js`（:3045）
- **动作**：
  - `hitScenarioIds: [1, 5, 7]` → `hitScenarios: [{id, displayIndex, name}]`
  - grep 全部调用方同步
- **验收**：grep `hitScenarioIds` 零命中 + smoke

### T26 — renderer 状态框文案改 displayIndex

- **Owner**：Dev
- **依赖**：T25
- **文件**：`src/renderer.js`（:3319）
- **动作**：状态框 ids 渲染改用 displayIndex
- **验收**：手测对比场景管理 UI 序号

### T27 — Sheet 3「命中场景行」写入

- **Owner**：Dev
- **依赖**：T25
- **文件**：`src/main-process/exceljs-writer.js`（+ 可能 `bank-bu-recon-writer.js`）
- **动作**：
  - 新增 Sheet 3 写入分支
  - 列结构 = 原 44 列 + 末尾「命中场景」列
  - 列值格式 `[${displayIndex}] ${scenarioName}`
  - `INTERNAL_FIELDS` 过滤逻辑保留，白名单显式拼装「命中场景」
- **验收**：smoke + 手测 xlsx 第 3 sheet 列对齐

---

## 八、Phase 6 — N1 cleanup 移出对账链路（β）

### T28 — DB schema migration + runs 表新列 ✅ v0.6 完成（v0.7 保留）

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/backend/database/migrations.js`
- **动作**：幂等 migration `ALTER TABLE acquiring_bill_currency_runs ADD COLUMN cleanup_pending INTEGER DEFAULT 0`
- **验收**：unit case（启动 + 旧库升级 + 字段存在）

### T29 — run-repository 加 cleanup_pending 操作 API ✅ v0.6 完成（v0.7 保留）

- **Owner**：Dev
- **依赖**：T28
- **文件**：`src/backend/acquiring-bill-currency-db/run-repository.js`
- **动作**：新增 `markCleanupPending(db, runId)` / `clearCleanupPending(db, runId)` / `listPendingCleanupRuns(db)`
- **验收**：unit case 覆盖三个 API

### T30 — runCheck 解耦 + main.js 移除 setImmediate ✅ v0.6 完成（v0.7 保留）

- **Owner**：Dev
- **依赖**：T29
- **文件**：`src/main-process/acquiring-bill-currency-session.js` + `src/main.js`（:10307）
- **动作**：
  - runCheck 成功后 `markCleanupPending`
  - main.js:10307 移除 setImmediate(cleanupAfterRunBackground)
- **验收**：手测 runCheck 后 DB 数据保留 + cleanup_pending=1

### T31 — app.before-quit 钩子 + 进度模态框 ⚠️ v0.6 完成 → v0.7 部分超越（见 T31c/d）

- **Owner**：Dev
- **依赖**：T30
- **文件**：`src/main.js` + `src/preload.js` + `src/renderer.js`
- **动作**：
  - main.js 加 `app.on('before-quit', async (event) => {...})`
  - preload 加 `onCleanupQuitProgress` 订阅 API
  - renderer 加退出进度模态框
- **验收**：手测退出 → 弹模态框 → 清完才退出
- **v0.7 超越**：模态框 IPC 广播改静默；renderer 进度模态框删除（T31c/d 处理）

### T32 — 进入模块兜底 + N1 smoke ⚠️ v0.6 完成 → v0.7 smoke 重写（见 T31e）

- **Owner**：Dev + Tester
- **依赖**：T31
- **文件**：`src/main.js` acquiringBillCurrency IPC 入口 + `scripts/test-v2.1.8-n1-cleanup.js`
- **动作**：
  - IPC 入口检查 cleanupPending → 后台 cleanup + toast
  - smoke 覆盖：runCheck → 标志位 / 退出触发 / 进入兜底 / 启动孤儿仍工作
- **验收**：smoke 全绿
- **v0.7 超越**：smoke 用例断言改为「diff 表数据保留」+ 新增 idle 触发用例（T31e 处理）；进入模块兜底机制保留不变

---

## 八.1、Phase 6 v0.7 增量 — N1' idle 30min 触发 + 差异保留

> **背景**：2026-05-26 用户在 v0.6 β 方案落地后提出修订（详 PRD §八 / spec §三）。本节为增量改造 task，非全推翻。

### T31a — Reverse Sync spec/PRD/tasks（v0.7 文档同步）✅ 2026-05-26

- **Owner**：PM
- **依赖**：T32（v0.6 已完成）
- **文件**：`spec.md` §三 / `PRD-v2.1.8.md` §八 / `tasks.md`（本节）
- **动作**：13 项决策点全锁 + 章节重写 + 旧 T28-T32 状态标注
- **验收**：3 文档同步 + 决策点表完整

### T31b — session.js cleanupAfterRunBackground 移除 diff 表清理

- **Owner**：Dev
- **依赖**：T31a
- **文件**：`src/main-process/acquiring-bill-currency-session.js`
- **动作**：
  - `cleanupAfterRunBackground` 新增 `includeDiff=false` 参数；false 时 tables 数组**仅含 flow_imports**（bill_imports 因 FK 约束保留：`diff_rows.bill_import_id REFERENCES bill_imports.id` 无 CASCADE）
  - `cleanupOrphanData` Phase 2 调用 `cleanupAfterRunBackground({ ..., includeDiff: true })`，清 3 表（diff → bill → flow 顺序解 FK），仍删 runs 记录（孤儿 run 元数据无保留意义）
  - Phase 3 ghost-diff 清理保留（仅清真孤儿）
  - **v0.2 反向同步**：发现 FK 约束（migrations.js:1073-1074）→ bill_imports 必须保留；spec v0.9 §3.6 + PRD v0.8 §8.3 同步
- **验收**：现有 unit case + 新加 case 覆盖"清完 diff 数据仍在"

### T31c — main.js idle 计时器 + before-quit 简化

- **Owner**：Dev
- **依赖**：T31b
- **文件**：`src/main.js` + `src/main-process/idle-cleanup-timer.js`（新建可选）
- **动作**：
  - 新增 `setupIdleCleanupTimer()`：常量 `IDLE_CLEANUP_MS = 30 * 60 * 1000` + lastActiveTs 维护 + `setInterval` 1-2min 检查 + 满 30min 触发 cleanup（mutex 抢锁）
  - 新增 IPC handler `app:user-activity`（renderer 上报入口）+ 任意 IPC 入站时也更新 lastActiveTs
  - `before-quit` 钩子简化：删模态框相关 IPC 广播（webContents.send onCleanupQuit*）；保留串行 cleanup + event.preventDefault + app.quit
  - listMonths 兜底保留不动
- **验收**：手测 + 单元（模拟 setInterval tick 触发）

### T31d — preload + renderer user activity 上报

- **Owner**：Dev
- **依赖**：T31c
- **文件**：`src/preload.js` + `src/renderer.js`
- **动作**：
  - preload 加 `reportUserActivity()` 接口（直调 `ipcRenderer.send('app:user-activity')`，无返回）
  - preload 删 `onCleanupQuitStart` / `onCleanupQuitProgress` / `onCleanupQuitDone` 订阅 API
  - renderer 加 mousemove/keydown/click 监听 + 10s 节流 + 调 `desktopApi.reportUserActivity()`
  - renderer 删退出进度模态框相关代码（M-2 路径下 onCleanupQuitStart/Progress/Done 监听一并清理）
- **验收**：手测移动鼠标后 main lastActiveTs 更新 + 30min 不动触发 cleanup

### T31e — N1' smoke：idle 触发 + 差异保留断言

- **Owner**：Dev
- **依赖**：T31d
- **文件**：`scripts/smoke/acquiring-bill-currency-n1.js` 或 `scripts/test-v2.1.8-n1-cleanup.js`
- **动作**：
  - 新增 N1-idle 用例：runCheck 完 → 手动调 cleanup 触发函数 → 断言 flow/bill 表空 + **diff 表数据保留** + runs 记录保留 + cleanup_pending=0
  - 旧 N1 用例断言改：「DB 表均空」→「flow/bill 空，diff 保留」
  - 新增 cleanupOrphanData 用例：Phase 2 不删 runs 记录 + Phase 3 仍清真 ghost-diff
- **验收**：smoke 全绿

### T31f — Commit N1' 全部内容

- **Owner**：Dev
- **依赖**：T31a-e
- **动作**：单 commit `[v2.1.8] feat(N1'): cleanup 改 idle 30min 触发 + 差异数据保留`
- **验收**：commit msg 含决策表 + 验证证据

---

## 九、Phase 7 — A3 跨进程化

### T33 — worker entry 搭建

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/main-process/acquiring-bill-currency-worker.js`（新建）
- **动作**：utilityProcess entry，包含 runCheck 主循环 + DB 重开 + PRAGMA 应用 + 进度回调 + 错误序列化 + 取消协议
- **验收**：worker 独立可启动 + 收发消息

### T34 — worker-host 单例 + IPC 桥接

- **Owner**：Dev
- **依赖**：T33
- **文件**：`src/main-process/acquiring-bill-currency-worker-host.js`（新建）
- **动作**：main 端单例，worker 异常退出自动重启；包装 postMessage / on-message
- **验收**：worker 崩溃后自动重启

### T35 — main.js handler 改 worker 调度

- **Owner**：Dev
- **依赖**：T34
- **文件**：`src/main.js`（:10281）
- **动作**：handler 改为通过 worker-host 调度；progress 透传到 renderer
- **验收**：手测 500w 行主窗口仍可交互

### T36 — A3 smoke

- **Owner**：Dev + Tester
- **依赖**：T35
- **文件**：`scripts/test-v2.1.8-a3-worker.js`
- **动作**：smoke 覆盖：
  - 主进程不阻塞
  - FileValidationError 跨进程保留
  - 取消后 DB 无锁残留
  - worker 崩溃自动重启
  - 进度 5 阶段依次到达
  - 19 个 v2.1.7 smoke suite 全跑
- **验收**：smoke 全绿

### T37 — A4 决策

- **Owner**：PM
- **依赖**：T36
- **动作**：评估 A3 worker 是否已解决主进程不阻塞；做 / 不做决策；记录到 PRD-v2.1.8.md §六
- **验收**：决策记录归档

---

## 十、Phase 9 — 收尾

### T38 — 文档三件套更新

- **Owner**：PM
- **依赖**：所有 Phase 0-7 完成
- **文件**：`CHANGELOG.md` + `docs/VERSION_FEATURE_HISTORY.md` + `docs/USER_GUIDE.md`
- **动作**：v2.1.8 章节 + N1/N2/N3 用户视角说明
- **验收**：三件套一致

### T39 — check-vars 跑 + PR body 段落

- **Owner**：PM
- **依赖**：T38
- **动作**：`npm run check:vars`；输出粘贴到 PR body
- **验收**：check-vars 报告含 N1/N2/N3/F5/A3 涉及变量

### T40 — preview 回归（前端改动）

- **Owner**：Dev
- **依赖**：T20（N2 dialog 改动）
- **动作**：`npm run preview` + `npm run preview:* (相关入口)`
- **验收**：preview 截图与 v2.1.7 对比（除 N2 dialog 外其他不变）

### T41 — backlog 归档

- **Owner**：PM
- **依赖**：T39
- **文件**：`docs/iterations/v2.1.8/backlog.md`
- **动作**：末尾标"已升级为 PRD/spec/tasks，本文件归档参考"
- **验收**：backlog 末尾有归档标记

### T42 — package.json bump + PR

- **Owner**：用户 / team-lead（按 memory `workflow_no_tester_no_auto_pr`）
- **依赖**：T41
- **动作**：用户明确说"提 PR" → bump 2.1.7 → 2.1.8 → 走标准 PR 流程
- **验收**：PR OPEN + v2.1.7 → main 已合并

---

## 十一、依赖图（精简）

```
T01 (分支) ── T02 (scan:vars) ── T03 (fixture)
  │
  ├── Phase 1 (G1 框架)：T04 → T05 → T06 → T07
  │     │
  │     └── T13-T18 (G1 全量铺，可并行)
  │
  ├── Phase 2 (F5)：T08 → T09 → T10 → T11 → T12
  │     │
  │     └── 协同：T12 unit case ↔ T13/T17
  │
  ├── Phase 4 (N2)：T19 → T20 → T21 → T22 → T23
  │
  ├── Phase 5 (N3)：T24 → T25 → T26 + T27
  │
  ├── Phase 6 (N1)：T28 → T29 → T30 → T31 → T32
  │
  └── Phase 7 (A3)：T33 → T34 → T35 → T36 → T37 (A4 决策)

Phase 9 (收尾)：T38 → T39 → T40 → T41 → T42（blocked by 所有 Phase 0-7）
```

---

**当前状态**：v0.1，等用户对 spec.md §八 27 个决策点拍板后，Phase 0 启动。

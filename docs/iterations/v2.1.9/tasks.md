# Tasks — v2.1.9 任务拆分

| 字段 | 值 |
|---|---|
| 文档版本 | v0.4（2026-05-27 — **SR-FIX-1 合并前修补**；Phase 10 加 T41-T44 4 task；任务总数 56→60）；v0.3 SR-log-1 立项 Phase 8.8 加 5 task；v0.2 α 范围扩 4 主题；v0.1 起草 |
| 关联文档 | `PRD-v2.1.9.md` v0.3 / `spec.md` v0.9 / `backlog.md` v0.5 |
| 任务总数 | 60（α 范围，原 56 + **SR-FIX-1 4 task**） |
| 任务拆分原则 | 单 task 3-5 文件内（CLAUDE.md 小批次原则）；按文件粒度拆，避免 task 间共享文件 |
| 关键约束 | SR-backup-1 必须在 N5 migration + N4 重构 前完成；N7 必须在 N5 channels 表落地后；G1-cont 与所有 N 项并行可独立推进 |

---

## 一、任务总览（α 范围）

| 阶段 | task 数 | 累计工期 | 关键产出 |
|---|---|---|---|
| Phase 0 - 准备 | 3 | 0.5 天 | 分支 + scan:vars + grep 调用方 |
| Phase 1 - SR-backup-1 前置 | 3 | 1 天 | backup.js + N5 依赖 ready |
| **Phase 1.5 - G1-cont 全量铺** | **7** | **1.5-2 周** | **37 个 unit test 文件 / 累计 case ≥ 400 / 与所有 N 项并行** |
| Phase 2 - N5 DB schema + migration | 4 | 2-3 天 | channels 表 + scenarios.channel_id + backfill |
| Phase 3 - N5 渠道 CRUD UI | 5 | 3-4 天 | 渠道管理弹框 + 顶部选择器 + 「通用」保护 |
| Phase 4 - N5 dispatcher 双维改造 | 4 | 2-3 天 | dispatcher 伪代码落地 + 单元 + smoke |
| Phase 5 - N5 转移 + 批量操作 | 4 | 2 天 | 单条转移 + 批量勾选 + 批量动作 |
| Phase 6 - N5 独立报表 + Sheet 3 撤除 | 3 | 2 天 | 新 writer + exceljs-writer 修剪 + 列结构 |
| Phase 7 - N7 bundle 导入/导出 | 4 | 3 天 | scenarios-bundle-io + dialog + 冲突处理 |
| Phase 8 - N6 状态框修复 | 2 | 0.5 天 | renderer.js:3338, 3351 删 \\n + preview 回归 |
| **Phase 8.5 - SR-policy-1 自动同步** | **1** | **0.5 天** | **integration-runner in-place 编辑 policy.md §七** |
| **Phase 8.6 - N1-settings 阈值配置化** | **3** | **0.5 天** | **settings 表新键 + 设置弹框字段 + smoke** |
| **Phase 8.7 - N4 重构（顺带）** | **2** | **0.5 天** | **N4 migration 切到 createBackup + 回归** |
| **Phase 8.8 - SR-log-1 全局告警日志化** | **5** | **3.5 天** | **preload IPC + main 49 处改造 + renderer wrapper hijack + 新日志结构 + 双写兼容** |
| Phase 9 - 集成测试 + 收尾 | 6 | 3-4 天 | 集成测试（N5 + N7 + G1-cont + 5 项新含 SR-log-1） + 文档三件套 + check-vars + PR |

**累计工期预估**：~5.4 周（α 范围，PM 上限估算；含 SR-log-1 +3.5 天）

**与 v2.1.8 体量对比**：v2.1.8 ~3 周，v2.1.9 α ~5.4 周 = 1.8 倍（主要来自 G1-cont 1.5-2 周 + SR-log-1 3.5 天）。可并行 G1-cont / SR-log-1 与 N 项推进降低关键路径。

**β 范围（4 主题 ~4 周）已移到 v2.1.10**，详 `docs/iterations/v2.1.10/backlog.md`。

---

## 二、Phase 0 — 准备

### T01 — 建立 v2.1.9 工作分支

- **Owner**：用户
- **依赖**：v2.1.8 PR #52 → main 合并完成（✅ 已完成）
- **动作**：`git checkout main && git pull && git checkout -b v2.1.9`
- **验收**：`git branch --show-current` = `v2.1.9`

### T02 — 重跑 scan:vars 评估升格

- **Owner**：PM
- **依赖**：T01
- **动作**：`npm run scan:vars`；对照 spec.md §九 升格建议，更新 `rules/important-variables.md`
- **验收**：scan-vars 报告刷新 + important-variables 含 channels / channel_id / hitChannelKey / matchStatus 新条目

### T03 — grep N6 updateStatusBox 调用方 ✅ 2026-05-27 已完成

- **Owner**：PM
- **依赖**：T01（实际：PM 在 spec 起草阶段已先行 grep，T01 启动前完成）
- **动作完成情况**：
  - `grep -rn 'updateStatusBox' src/ --include='*.js'` 已跑 → 定义 `renderer.js:542`，7 处调用（含定义本体）
  - 全文件 `：\n` 模式扫描 → 仅 `:3338, :3351`（银行对账单）为 statusBox 文案冗余；其他 5 模块 `xxx：${...}` 全部无 `\n`
- **关键结论**：D18 = (b) 改内层会破坏其他 5 模块视觉 → 修订 spec §七 推 (a) 改外层 2 行（详 spec §7）
- **验收**：spec §7 已含完整 grep 报告表 + 影响分析；backlog v0.3 D18=(a) 拍板

---

## 三、Phase 1 — SR-backup-1 前置

### T04 — 新建 src/backend/database/backup.js

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/backend/database/backup.js`（新建）
- **动作**：
  - 封装 `createBackup(db, label)` 接口
  - POC 验证 `node:sqlite` `DatabaseSync.backup` API 可用性（Electron 36）
  - 失败 fallback：`BEGIN IMMEDIATE` + `fs.copyFileSync` + `ROLLBACK`
  - 备份路径：`<userData>/backups/tool-data-bak-{label}-{timestamp}.sqlite`
  - 用 tmp 文件名 + atomic rename 保证不留半文件
- **验收**：单元测试覆盖：成功备份 / 失败抛错 / tmp 不残留

### T05 — backup.js 单元测试

- **Owner**：Dev
- **依赖**：T04
- **文件**：`tests/unit/backend/database/backup.test.js`（新建）
- **动作**：
  - case 1：500MB+ 库备份（fixture 准备）
  - case 2：备份过程库可读（并发 SELECT）
  - case 3：磁盘满故障注入 → 抛错 + 无残留
  - case 4：标签拼接验证（pre-N5 / pre-N4 等）
- **验收**：unit case ≥ 4 全绿

### T06 — database.js 暴露 createBackup

- **Owner**：Dev
- **依赖**：T04
- **文件**：`src/backend/database.js`
- **动作**：require backup.js + 在 AppDatabase 类暴露 `createBackup(label)` 实例方法
- **验收**：grep 调用方为空（仅 N5/N4 后续会用）

---

## 三.5、Phase 1.5 — G1-cont 单元测试全量铺（与 Phase 2-7 并行）

> 与所有 N 项并行可推进；不阻塞主线；与 spec §11 一致。

### T06a — 第 1 层文件 1-4：file-service 4 文件

- **Owner**：Dev
- **依赖**：T01
- **文件**：`tests/unit/backend/file-service/{common,error-causes}.test.js` + `tests/unit/backend/{acquiring-bill-currency,bank-bu-recon}-import/validator.test.js`
- **动作**：spec §11.2 case 模板；每文件正常 + 边界（空/null）+ 异常路径 ≥ 8 case
- **验收**：`npm run test:unit -- tests/unit/backend/file-service/` 全绿 + case ≥ 32

### T06b — 第 1 层文件 5-7：剩余 validator + engine-utils

- **Owner**：Dev
- **依赖**：T06a
- **文件**：`tests/unit/backend/{biz-op-recon,pending}-import/validator.test.js` + `tests/unit/main-process/scenario-engines/engine-utils.test.js`
- **动作**：同上模板
- **验收**：`npm run test:unit` 累计 case ≥ 60

### T06c — 第 1 层文件 8-11：scenario-engines c1-c4

- **Owner**：Dev
- **依赖**：T06b
- **文件**：`tests/unit/main-process/scenario-engines/{c1-extract-recon-id,c2-offset-bill-mark,c3-gateway-recon-join,c4-recon-id-fix}.test.js`
- **动作**：c3 / c4 v2.1.8 已部分覆盖 → 补剩余分支；c1 / c2 全新
- **验收**：累计 case ≥ 120

### T06d — 第 1 层文件 12-14：constants + columns

- **Owner**：Dev
- **依赖**：T06b
- **文件**：`tests/unit/constants/*.test.js` + `tests/unit/backend/*-db/columns.test.js`（4 个 db 模块）
- **动作**：字段表自洽性 + schema 完整性
- **验收**：累计 case ≥ 160

### T06e — 第 2 层 database/store：8 文件

- **Owner**：Dev
- **依赖**：T06a + T10（channels-repository 已建）
- **文件**：`tests/unit/backend/database/{template,scenarios,channels,settings}-repository.test.js` + `tests/unit/backend/{balance-seed,balance-adjustment,big-account-mode,big-account-order,own-account}-store.test.js`
- **动作**：用 `:memory:` SQLite + migration setup + fixture
- **验收**：累计 case ≥ 220

### T06f — 第 2 层 reader/writer + 业务 db：13 文件

- **Owner**：Dev
- **依赖**：T06a
- **文件**：`tests/unit/backend/file-service/{readers,writers}.test.js` + `tests/unit/backend/{pending,acquiring-bill-currency,bank-bu-recon,biz-op-recon}-db/*.test.js`（4+2+2+3 = 11）
- **动作**：用 `:memory:` SQLite + 各模块 schema setup + tmpdir fixture xlsx
- **验收**：累计 case ≥ 340

### T06g — 第 2 层 main-process：3 文件 + README 更新

- **Owner**：Dev
- **依赖**：T06e + T06f
- **文件**：`tests/unit/main-process/{monthly-balance,recon-id-fix-engine,statement-generation}.test.js` + `tests/unit/README.md`
- **动作**：mock store + DB 写 case；README 加 v2.1.9 新铺示例
- **验收**：累计 case ≥ 400 / 第 1 层 14 + 第 2 层 24 = 38 文件全覆盖（含 v2.1.8 已铺）

---

## 四、Phase 2 — N5 DB schema + migration

### T07 — 新建 channels 表 schema

- **Owner**：Dev
- **依赖**：T06
- **文件**：`src/backend/database/migrations.js`
- **动作**：新增 `ensureChannelsTable()` 函数（spec §3.1 DDL）+ 启动期幂等插入「通用」（id=1）
- **验收**：单元测试 startup 两次 + 表存在 + 「通用」行存在不重复

### T08 — scenarios 表加 channel_id 列

- **Owner**：Dev
- **依赖**：T07
- **文件**：`src/backend/database/migrations.js`
- **动作**：`ensureScenariosChannelIdColumn()` 函数（spec §3.2）— pragma_table_info 检测 + ALTER + backfill 通用
- **验收**：单元测试 startup 两次 + 列存在 + 所有 scenarios.channel_id=1

### T09 — N5 migration 总函数 + 备份 + 事务 + 标志位

- **Owner**：Dev
- **依赖**：T07 + T08 + T04
- **文件**：`src/backend/database/migrations.js`
- **动作**：spec §3.3 `ensureSchemaV2_1_9_N5()` 全流程实现
- **验收**：
  - 标志位 n5_channels_migrated=1 后跳过
  - 备份文件存在
  - 失败回滚 + activityLog
  - 单元测试覆盖：首次执行 / 重复执行 / 失败回滚 3 用例

### T10 — channels-repository.js 新建

- **Owner**：Dev
- **依赖**：T07
- **文件**：`src/backend/database/channels-repository.js`（新建）
- **动作**：CRUD API：
  - `listChannels(db)` — 返回所有渠道列表 + displayIndex
  - `findByNameAndLocation(db, name, location)` — N5-8 调度用
  - `getBuiltinGeneral(db)` — 取 is_builtin=1 内置「通用」
  - `createChannel(db, { name, ownerLocation })` — N5-2 新增 + N7 自动创建
  - `updateChannel(db, id, fields)` — N5-2 修改（屏蔽 is_builtin=1）
  - `deleteChannel(db, id)` — N5-2 删除（屏蔽 is_builtin=1 + 检测 scenarios 数量）
- **验收**：单元测试覆盖所有 API + is_builtin 保护 + unique 约束抛错

---

## 五、Phase 3 — N5 渠道 CRUD UI

### T11 — 场景管理 dialog 顶部「银行渠道」选择器

- **Owner**：Dev
- **依赖**：T10
- **文件**：`src/renderer-dialogs.js`（5468-5491 改造）
- **动作**：
  - dialog-header 加 `<label>` + `<select id="scenario-channel-filter">` + `<button>管理</button>`
  - 启动时拉 channels 列表填充 select
  - select change → 触发场景列表过滤（按 channel_id）
  - 初始选中「通用」（value=1）
- **验收**：preview 截图 + 手测下拉切换刷新列表

### T12 — 渠道管理弹框 dialog factory

- **Owner**：Dev
- **依赖**：T11
- **文件**：`src/renderer-dialogs.js`（新建 `createChannelManagerDialog()` factory）
- **动作**：spec §4.2 UI 设计 — 3 列表格 + 「新增」按钮 + 「完成/修改」二态按钮
- **验收**：preview 截图

### T13 — 「新增」按钮复用账户映射页面样式

- **Owner**：Dev
- **依赖**：T12
- **文件**：`src/renderer-dialogs.js`
- **动作**：
  - grep `createAccountMappingDialog` 定位「新增」按钮 class 名
  - 渠道管理弹框「新增」按钮复用相同 class + 行为模式（inline 新行 + 编辑态）
- **验收**：preview 截图与账户映射页面对比一致

### T14 — IPC handler channels:* 

- **Owner**：Dev
- **依赖**：T10 + T12
- **文件**：`src/main.js` + `src/preload.js`
- **动作**：
  - `channels:list` / `channels:create` / `channels:update` / `channels:delete` 4 个 handler
  - preload `desktopApi.channels.*` 4 个接口
  - trackedIpcHandle 接入活动日志
- **验收**：preload 接口完整 + 手测 4 个动作

### T15 — 「通用」保护 + 防误删

- **Owner**：Dev
- **依赖**：T14
- **文件**：`src/renderer-dialogs.js` + `src/backend/database/channels-repository.js`
- **动作**：
  - UI 层：is_builtin=1 行的删除按钮 disabled + 名称/开户地 input disabled
  - DB 层：deleteChannel 检测 is_builtin=1 抛错；scenarios 数量 > 0 抛错（spec §3.2 (b)）
- **验收**：手测「通用」行无法删；非通用行有 scenarios 时点删提示先转移

---

## 六、Phase 4 — N5 dispatcher 双维改造

### T16 — dispatcher 双维伪代码落地

- **Owner**：Dev
- **依赖**：T10
- **文件**：`src/main-process/scenario-dispatcher.js`
- **动作**：spec §2.1 伪代码 → runAllScenarios 重构
  - buildChannelKey 函数
  - 查 matchedChannel + getBuiltinGeneral
  - 阶段 A 专属 + 阶段 B 通用 first-match-wins
  - 写 _hitChannelKey / _matchStatus / _matchedChannelId metadata
- **验收**：单元测试 spec §2.2 4 种行结果矩阵全覆盖

### T17 — scenarios-repository 加 listByChannelIdAndCategory

- **Owner**：Dev
- **依赖**：T08
- **文件**：`src/backend/database/scenarios-repository.js`
- **动作**：新增 `listByChannelIdAndCategory(db, channelId, category)` 查询 API
- **验收**：单元测试 + grep 调用方（dispatcher）

### T18 — bank-bu-recon-session 接入双维调度

- **Owner**：Dev
- **依赖**：T16 + T17
- **文件**：`src/main-process/bank-bu-recon-session.js`
- **动作**：runReconciliation 内部传入 channelRepo / scenariosRepo 依赖
- **验收**：smoke 全跑 + 集成测试 spec §10 新用例 6+ 个

### T19 — dispatcher 单元 + smoke

- **Owner**：Dev
- **依赖**：T16 + T18
- **文件**：`tests/unit/main-process/scenario-dispatcher.test.js` + `scripts/smoke/v2.1.9-n5-dispatcher.js`
- **动作**：spec §2.2 4 种结果矩阵单元 + 集成 smoke
- **验收**：unit ≥ 8 case / smoke 全绿

---

## 七、Phase 5 — N5 转移 + 批量操作

### T20 — 单条「转移」按钮 + 弹框

- **Owner**：Dev
- **依赖**：T11 + T14
- **文件**：`src/renderer-dialogs.js`
- **动作**：spec §4.3 — 场景行加「转移」按钮 + 转移弹框 dialog factory
- **验收**：preview + 手测搬运行为（A→B 后 A 内不可见）

### T21 — 「批量操作」按钮 + 勾选列

- **Owner**：Dev
- **依赖**：T11
- **文件**：`src/renderer-dialogs.js`
- **动作**：spec §4.4 — footer 加「批量操作」按钮 + 表格左侧勾选框列（含全选）
- **验收**：preview + 手测勾选 / 全选

### T22 — 批量转移 + 批量删除

- **Owner**：Dev
- **依赖**：T20 + T21
- **文件**：`src/renderer-dialogs.js` + `src/main.js`
- **动作**：
  - 「批量操作」右侧加「转移」「删除」按钮
  - 批量转移弹框（单选目标渠道）
  - 批量删除确认框（列出场景名清单）
  - IPC `scenarios:batch-transfer` / `scenarios:batch-delete`
- **验收**：手测批量 5+ 条

### T23 — scenarios.channel_id 转移 + 删除 API

- **Owner**：Dev
- **依赖**：T22
- **文件**：`src/backend/database/scenarios-repository.js`
- **动作**：
  - `transferScenarios(db, scenarioIds, targetChannelId)` — 单条 + 批量同函数
  - `batchDelete(db, scenarioIds)` — 事务包裹
- **验收**：单元测试 + 集成 smoke

---

## 八、Phase 6 — N5 独立报表 + Sheet 3 撤除

### T24 — 新建 scenario-hit-rows-writer.js

- **Owner**：Dev
- **依赖**：T19
- **文件**：`src/main-process/scenario-hit-rows-writer.js`（新建）
- **动作**：spec §5.3 实现 `writeScenarioHitRows(modifiedRows, originalFilePath, opts)`
- **验收**：单元测试覆盖列结构 + 落位 + 命名

### T25 — exceljs-writer Sheet 3 撤除

- **Owner**：Dev
- **依赖**：T24
- **文件**：`src/main-process/exceljs-writer.js`
- **动作**：删除 v2.1.8 N3-2 引入的 Sheet 3「命中场景行」写入分支
- **验收**：smoke 主输出 xlsx sheetCount=2

### T26 — bank-bu-recon-session 接入独立报表

- **Owner**：Dev
- **依赖**：T24
- **文件**：`src/main-process/bank-bu-recon-session.js`
- **动作**：
  - runReconciliation return 后调用 writeScenarioHitRows
  - 路径返回到 IPC handler + UI 提示「命中场景行报表已生成：{path}」
- **验收**：手测对账后报表存在于 error-reports 目录

---

## 九、Phase 7 — N7 bundle 导入/导出

### T27 — 新建 scenarios-bundle-io.js

- **Owner**：Dev
- **依赖**：T10 + T17
- **文件**：`src/backend/scenarios-bundle-io.js`（新建）
- **动作**：spec §6.1 写出 bundle 结构 + spec §6.2 reader 类型识别
- **验收**：单元测试覆盖 export / detectBundleType / parse 流程

### T28 — 场景管理 footer 加导入/导出按钮

- **Owner**：Dev
- **依赖**：T11
- **文件**：`src/renderer-dialogs.js`（5488 footer 改造）
- **动作**：spec §4.5 footer 序 `新增场景 / 批量操作 / 导入模板文件 / 导出模板文件 / 完成`
- **验收**：preview + 手测点击有响应

### T29 — 导出弹框 + 多选下拉

- **Owner**：Dev
- **依赖**：T28
- **文件**：`src/renderer-dialogs.js`
- **动作**：spec §5.3 + spec §6.1 — 弹框多选下拉 + 导出生成 bundle + saveDialog
- **验收**：preview + 手测多选 3 渠道导出文件结构正确

### T30 — 导入冲突处理（缺失渠道 + 同名场景）

- **Owner**：Dev
- **依赖**：T27 + T29
- **文件**：`src/renderer-dialogs.js` + `src/main.js`
- **动作**：spec §6.3 — 缺失渠道确认框 + 同名场景跳过 + 结果框报告
- **验收**：smoke 3 用例（无冲突 / 部分缺失 / 部分同名）

---

## 十、Phase 8 — N6 状态框修复

### T31 — 银行对账单外层文案删冗余 `\n`（D18=a 修订）

- **Owner**：Dev
- **依赖**：T03（已完成 grep）
- **文件**：`src/renderer.js`（`:3338` + `:3351` 共 2 行）
- **动作**：
  - `:3338` `` text = `已导出：\n${ex.mainFileName}`; `` → `` text = `已导出：${ex.mainFileName}`; ``
  - `:3351` `` text = `已导入：\n${bs.fileName}（${bs.rowCount} 行）`; `` → `` text = `已导入：${bs.fileName}（${bs.rowCount} 行）`; ``
  - `:3339`（error-report）+ `:3352`（不平账结果表）**保留** `\n` 不动（行间换行非冒号后冗余）
- **不改**：
  - `:542-566` `updateStatusBox` 内层零改动（v2.1.7 round 2 R3 §8.4.2 设计保留）
  - 其他 5 模块（业银对账 / 业务运营对账 / C4 修复 / 主面板 / 新账户）零改动
- **验收**：
  - 银行对账单 statusBox 冒号后换行从 2 → 1
  - 其他 5 模块 statusBox preview 无差异（T32 回归保护）

### T32 — preview 回归 + 状态框对比

- **Owner**：Dev
- **依赖**：T31
- **文件**：`scripts/preview.js`（或对应 preview 入口）
- **动作**：跑 `npm run preview` + 对比 v2.1.8 截图，4 个状态冒号后换行从 2 → 1
- **验收**：preview 截图归档 + 差异说明

---

## 十.5、Phase 8.5 — SR-policy-1 integration-runner 自动同步清单

### T32a — integration-runner 末尾 in-place 编辑

- **Owner**：Dev
- **依赖**：T01
- **文件**：`scripts/integration-runner.js` + `rules/integration-test-policy.md`
- **动作**：spec §12.2 — 末尾收集 case 名/断言数/耗时 → 生成 markdown 表 → 用正则替换 in-place 写入 `rules/integration-test-policy.md §七`；时间戳格式 `<!-- last-updated: YYYY-MM-DDTHH:mm:ss+08:00 -->`；同时输出 stdout
- **验收**：跑 `npm run test:integration` 后 `git diff rules/integration-test-policy.md` 显示 §七 章节自动更新 + stdout 含表内容

---

## 十.6、Phase 8.6 — N1-settings idle 阈值配置化

### T32b — settings 表新增键 + migration 默认值

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/backend/database/migrations.js` + `src/backend/database/settings-repository.js`
- **动作**：spec §13.2 — 幂等 migration `INSERT OR IGNORE INTO settings (key, value) VALUES ('acquiring_bill_idle_cleanup_minutes', '30')`；settings-repository 暴露 get/set 接口
- **验收**：单元测试覆盖：首次 startup 后键存在 + 值='30'；重启不重复

### T32c — main.js IDLE_CLEANUP_MS 改读 settings + 监听 change

- **Owner**：Dev
- **依赖**：T32b
- **文件**：`src/main.js` + `src/main-process/idle-cleanup-timer.js`（v2.1.8 N1' 已建）
- **动作**：spec §13.2 — 启动时 settingsRepo.get 读取；IPC `settings:set` 监听该键变化 → idleTimer.update(newValue * 60 * 1000)；范围校验 5-180
- **验收**：手测改值 → 重启生效；改值不重启即时生效；范围外抛错

### T32d — 应用设置弹框 UI + smoke ❌ 2026-05-27 撤回（D21 修订为 (c)）

> dev agent #2 Phase 8.6 实施时自扩展新建 `createAppSettingsDialog` factory + ⚙️ 入口按钮，用户审查后否决；T32d 全部回退（删 factory / 入口按钮 / IPC handlers）。后端 settings + range + IDLE_CLEANUP_MS 启动期读保留，T32b/c 不变。

- **Owner**：Dev
- **依赖**：T32c
- **文件**：`src/renderer-dialogs.js`（应用设置弹框 factory，spec 阶段定位）+ `src/preload.js` + `scripts/smoke/v2.1.9-n1-settings.js`
- **动作**：
  - 设置弹框新增字段 `<input type="number" min="5" max="180">` + 单位「分钟」+ hint 文案
  - preload 暴露 `desktopApi.settings.get/set('acquiring_bill_idle_cleanup_minutes')`
  - smoke 用例：(1) 默认 30min 行为不变；(2) 改 60min 后 idle 计时器读新值
- **验收**：preview 截图 + smoke 全绿

---

## 十.7、Phase 8.7 — N4 重构（顺带）

### T32e — N4 ensureBillRawJsonV2Slim 切换到 createBackup

- **Owner**：Dev
- **依赖**：T06（database.js 暴露 createBackup）
- **文件**：`src/backend/database/migrations.js`
- **动作**：spec §14.1.1 — 替换 `fs.copyFileSync(srcDbPath, backupPath)` 为 `const backupPath = await createBackup(db, 'pre-N4')`；activityLog 调用保持
- **验收**：grep `fs.copyFileSync` in migrations.js 零命中

### T32f — N4 重构 smoke + 集成测试回归

- **Owner**：Dev + Tester
- **依赖**：T32e
- **文件**：`scripts/smoke/acquiring-bill-currency.js`（v2.1.8 N4 用例）+ `scripts/integration/v2.1.8-n4-cleanup.js`
- **动作**：
  - 现有 N4 smoke 全跑 0 regression（标志位 / raw_json 字段 9 列）
  - 验证 `<userData>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite` 仍正常生成
- **验收**：smoke + 集成测试全绿；备份文件存在且大小 = 库大小

---

## 十.8、Phase 8.8 — SR-log-1 全局告警日志化（5 task / ~3.5 天）

> 与所有 N 项并行可推进；不阻塞主线；与 spec §十五 一致。

### T32g — preload IPC + main handler + 单元

- **Owner**：Dev
- **依赖**：T01
- **文件**：`src/preload.js` + `src/main.js` + `tests/unit/preload-report-log.test.js`（新）
- **动作**：
  - preload 暴露 `desktopApi.reportLog(payload)` → `ipcRenderer.send('app:report-log', payload)`
  - main `ipcMain.on('app:report-log', ...)` handler 调 appendActivityLogEntry
  - 单元测试：payload 转发 + 默认字段 + 异常 graceful
- **验收**：unit 全绿（4+ case）；preload 接口可调

### T32h — main 49 处 console.error/warn 批量改造

- **Owner**：Dev
- **依赖**：T32g
- **文件**：`src/main.js` + `src/main-process/*.js` + `src/backend/*.js`
- **动作**：
  - `grep -rn "console\.error\|console\.warn" src/main.js src/main-process/ src/backend/ --include="*.js"` → 列出全部
  - 按文件批量改 → appendActivityLogEntry({level: 'error', source: 'main', domain, message, details, stack})
  - 改完 `grep -c "console\.error" src/main.js src/main-process/ src/backend/` = 0（除 logger.js 兜底）
- **验收**：grep 0 命中（logger.js 例外）；smoke 全跑 0 regression

### T32i — renderer setStatus + createAlertDialog wrapper hijack

- **Owner**：Dev
- **依赖**：T32g
- **文件**：`src/renderer.js`（updateStatusBox 已在 :542；setStatus 等内部添加 hijack）+ `src/renderer-dialogs.js`（createAlertDialog 工厂）
- **动作**：
  - setStatus / setNewAccountStatus / setBankBuReconStatus / setBizOpReconStatus / set ReconIdFixStatus / setBankStatementStatus 内部：tone='error'/'warning' 时调 desktopApi.reportLog（try-catch graceful）
  - createAlertDialog 工厂内部：开口处调 desktopApi.reportLog level='error'
  - 调用方零改动（175+ 处现有调用自动覆盖）
- **验收**：
  - 手测触发 setStatus(msg, 'error') → main 端 activity log 与新 error.log 双写
  - try-catch 异常情景：模拟 desktopApi 不存在 → setStatus 仍正常显示（graceful）

### T32j — 新日志结构 + JSON Lines + 双写

- **Owner**：Dev
- **依赖**：T32g
- **文件**：`src/backend/logger.js` + `tests/unit/backend/logger.test.js`
- **动作**：
  - 新增 `getLogFilePath(level, date)` 函数（D29 两层归档）：`logs/{YYYY-MM}/{MM-DD}/{level}.log`
  - 新增 `appendStructuredLog(payload)` 函数（D31 JSON Lines 格式）
  - `appendActivityRecord` 扩展为双写：旧路径 + 新结构（D34=a）
  - 单元测试：路径构造 / JSON Lines 格式校验 / 双写一致性 / 跨月切换
- **验收**：unit 全绿（8+ case）；日志目录按需自动创建

### T32k — SR-log-1 集成测试 + USER_GUIDE 文档

- **Owner**：Dev + Tester
- **依赖**：T32h + T32i + T32j
- **文件**：`scripts/integration/v2.1.9-sr-log-1.js`（新）+ `docs/USER_GUIDE.md`（「故障排查」章节）
- **动作**：
  - 集成测试 4+ 用例：
    - (1) renderer setStatus error → 日志写入 logs/{YYYY-MM}/{MM-DD}/error.log + 旧 app_activity_log.txt 双写
    - (2) main appendActivityLogEntry → 同上双写
    - (3) JSON Lines 行可解析（`cat | jq -c .` 0 报错）
    - (4) wrapper hijack graceful（mock desktopApi 异常 setStatus 仍工作）
  - USER_GUIDE「故障排查」章节新增「日志位置」段：路径 + 用户手动清理建议 + JSON Lines 解析示例
  - CHANGELOG / VFH 在 T36 阶段一起更新
- **验收**：集成测试 4 用例全绿；USER_GUIDE 段落写完

---

## 十一、Phase 9 — 集成测试 + 收尾

### T33 — 集成测试 N5 渠道维度新用例

- **Owner**：Dev + Tester
- **依赖**：T19 + T26
- **文件**：`scripts/integration/v2.1.9-n5-channel-dispatch.js`（新建）
- **动作**：
  - 用例 1：行匹配专属 → 命中专属场景
  - 用例 2：行匹配专属 → 专属未命中 → 通用兜底命中
  - 用例 3：行未匹配渠道 → 通用兜底命中
  - 用例 4：行未匹配渠道 + 通用未命中 → Sheet 2
  - 用例 5：独立报表列结构验证
  - 用例 6：「通用」内置渠道删除阻止
- **验收**：6+ 用例全绿 / 0 regression

### T34 — 集成测试 N7 bundle 导入/导出

- **Owner**：Dev + Tester
- **依赖**：T30
- **文件**：`scripts/integration/v2.1.9-n7-bundle.js`（新建）
- **动作**：
  - 用例 1：单渠道导出 → 文件结构正确
  - 用例 2：多选渠道导出 → channels 数组完整
  - 用例 3：导入缺失渠道 → 弹确认框（mock 确认）→ 创建成功
  - 用例 4：导入同名场景 → 跳过 + 报告
  - 用例 5：误用 bundleVersion=4 文件导入 → 报错
- **验收**：5+ 用例全绿

### T35 — 集成测试 N5 migration 老库升级

- **Owner**：Dev + Tester
- **依赖**：T09
- **文件**：`scripts/integration/v2.1.9-n5-migration.js`（新建）
- **动作**：
  - 用例 1：v2.1.8 老库（无 channels 表 + scenarios.channel_id 空）→ 启动 → 升级完成
  - 用例 2：重复启动 → 跳过（标志位）
  - 用例 3：migration 中断模拟 → 备份保留 + 回滚 + 下次重试
- **验收**：3+ 用例全绿

### T36 — 文档三件套更新

- **Owner**：PM
- **依赖**：所有 Phase 0-8 完成
- **文件**：`CHANGELOG.md` + `docs/VERSION_FEATURE_HISTORY.md` + `docs/USER_GUIDE.md`
- **动作**：
  - CHANGELOG：v2.1.9 章节 + N5/N6/N7 高亮 + **Sheet 3 破坏性变更显著警告**
  - VFH：v2.1.9 历史栏 + 银行渠道维度引入 + bundle 类型新增
  - USER_GUIDE：「场景管理」+ 「银行对账单处理」章节重写 + 渠道概念入门 + 导入导出操作 + 兜底机制 + 独立报表位置
- **验收**：三件套一致 + Sheet 3 警告显著

### T37 — check-vars 跑 + PR body 段落

- **Owner**：PM
- **依赖**：T36
- **动作**：`npm run check:vars`；输出粘贴到 PR body
- **验收**：check-vars 报告含 channels / channel_id / hitChannelKey / matchStatus 涉及变量

### T38 — package.json bump + PR

- **Owner**：用户 / team-lead（按 memory `workflow_no_tester_no_auto_pr`）
- **依赖**：T37
- **动作**：用户明确说"提 PR" → bump 2.1.8 → 2.1.9 → 走标准 PR 流程
- **验收**：PR OPEN

---

## 十一.5、Phase 10 — SR-FIX-1 合并前修补（4 task / 2026-05-27 加）

> 触发条件：PR #53 提交后 self-review 发现 SR1 #1/#2/#3/#4 4 个 🔴 Critical（详 `spec.md §十六`）；用户拍板 F1 方案合并前修；本 Phase 4 task 在 PR #53 合并前完成。

### T41 — dispatcher per-channel batch first-match-wins 重写

- **Owner**：Dev agent
- **依赖**：T38（PR #53 已开）
- **文件**：`src/main-process/scenario-dispatcher.js`（重写 runDualDimensionDispatch + 新增 runChannelBatch helper）
- **动作**：spec §16.2 伪代码 → 实施
  - 删除 `dispatchSingleRow` / `firstMatchWinsForRow`（per-row 路径不再使用）
  - 新增 `runChannelBatch(args)` helper（per-channel 子作用域 first-match-wins）
  - `runDualDimensionDispatch` 改：Step 1 切片 + Step 2 rowMatchedChannelMap 预查 + Step 3 阶段 A 每专属 channel batch + Step 4 阶段 B 通用 batch + Step 5 modifiedRows/unmatchedRows 构造
  - rowMeta 加 hitChannelId 字段
  - 保留向后兼容：deps 缺失 → runLegacySingleDimensionDispatch（不动）
- **验收**：
  - dispatcher 单元 6 不变量 case 全绿（spec §16.4 case 1-6）
  - smoke 全跑 0 regression
  - dispatcher.test.js 既有 30+ case 全绿（C1 路径不变）

### T42 — scenarios.name UNIQUE 全表 → (channel_id, name) migration

- **Owner**：Dev agent
- **依赖**：T41（dispatcher 先就位避免测试期歧义）
- **文件**：
  - `src/backend/database/migrations.js`（新增 `ensureScenariosNameUniqueByChannelId(db)`）
  - `src/backend/database/scenarios-repository.js`（catch 升级支持新旧两种 UNIQUE 错误消息）
- **动作**：spec §16.3
  - 新 migration 函数：检测 + 备份 + 冲突预检 + drop old UNIQUE + create new UNIQUE INDEX (channel_id, name) + 写标志位 `n5_scenarios_unique_migrated`
  - 调用顺序在 `ensureScenariosChannelIdColumn` 之后
  - `scenarios-repository.js` 同时 catch `scenarios.name` 和 `scenarios.channel_id, scenarios.name` 两种错误模式
  - 新增（如缺失）`findByChannelAndName(db, channelId, name)` API（N7 import 路径已预留依赖）
- **验收**：
  - 单元：R1（同 channel 同 name 抛错）+ R2（跨 channel 同 name 允许）+ R3（findByChannelAndName 隔离）全绿（spec §16.4）
  - 老库迁移：v2.1.8 库（无 channel_id）→ N5 channel_id 加列 + backfill → UNIQUE migration → 标志位写入 → 重启幂等

### T43 — C2/C3 双维 unit case 补 15+（SR1 #4 修复）

- **Owner**：Dev agent
- **依赖**：T41 + T42
- **文件**：
  - `tests/unit/main-process/scenario-dispatcher.test.js`（新增 15 case）
  - `tests/unit/backend/database/scenarios-repository.test.js`（新增 3 case）
- **动作**：spec §16.4 矩阵实现
  - case 1-6：C3 阶段 A/B + 1v1 红线 + 跨阶段 gw 重消费边界
  - case 7-10：C2 阶段 A/B + 笛卡尔配对 + reconFields=0 无条件赋值
  - case 11-12：混合 first-match-wins 不变量
  - case 13-15：scenarios.name 跨 channel + 全场景在通用 + 兜底 fallback metadata
  - R1-R3：UNIQUE migration 行为
- **验收**：
  - 新增 ≥ 15 case + 3 case = 18 case 全绿
  - 既有 case 0 regression
  - dispatcher.test.js 总 case ≥ 50（v2.1.9 baseline 30+ + 新增 15+）

### T44 — D16=b writer 同步实现 + 文档收口

- **Owner**：Dev agent + 主线程
- **依赖**：T41 + T43
- **文件**：
  - `src/main-process/scenario-hit-rows-writer.js`（确认 D16=b 落地 — 若 v0.4 实施已含则跳过）
  - `docs/USER_GUIDE.md`（加「已知边界」段：跨 channel gw 重消费 + scenarios.name 跨渠道复用）
  - `CHANGELOG.md`（v2.1.9 章节追加 SR-FIX-1 修复说明）
  - `docs/prs/PR53-v2.1.9.md`（追加「SR-FIX-1 修复」段 — 19 finding 收口表）
- **动作**：
  - 主线程：复核 T41-T43 diff
  - Dev agent：USER_GUIDE / CHANGELOG / PR body 更新
  - 主线程：跑 `npm run smoke && npm run test:unit && npm run test:integration` 验证全绿
  - 主线程：跑 `npm run check:vars` 确认无新增 Critical 命中
- **验收**：
  - 3 文档段落写完
  - release-check（smoke + unit + integration）全绿
  - check-vars 无新增 Critical 命中
  - PR body 含 SR-FIX-1 修复段

---

## 十二、依赖图

```
T01 (分支) ── T02 (scan:vars) ── T03 (grep updateStatusBox) ✅
  │
  ├── Phase 1 (SR-backup-1)：T04 → T05 / T04 → T06
  │     │
  │     └── Phase 8.7 (N4 重构顺带)：T06 → T32e → T32f
  │
  ├── Phase 1.5 (G1-cont — 与 Phase 2-7 并行)：T01 → T06a → T06b → T06c / T06b → T06d
  │                                          ├── T10 (channels-repo) → T06e
  │                                          └── T06a → T06f → T06g
  │
  ├── Phase 2 (N5 schema)：T06 → T07 → T08 → T09 → T10
  │     │
  │     ├── Phase 3 (N5 UI)：T10 → T11 → T12 → T13 → T14 → T15
  │     │
  │     ├── Phase 4 (dispatcher)：T10 → T16 / T08 → T17 → T18 → T19
  │     │
  │     ├── Phase 5 (转移+批量)：T11 → T20 / T11 → T21 → T22 → T23
  │     │
  │     └── Phase 6 (报表+Sheet3)：T19 → T24 → T25 → T26
  │
  ├── Phase 7 (N7)：T10 + T17 → T27 / T11 → T28 → T29 → T30
  │
  ├── Phase 8 (N6)：T03 → T31 → T32
  │
  ├── Phase 8.5 (SR-policy-1)：T01 → T32a（独立可并行）
  │
  ├── Phase 8.6 (N1-settings)：T01 → T32b → T32c → T32d（独立可并行）
  │
  └── Phase 8.8 (SR-log-1)：T01 → T32g → T32h / T32g → T32i / T32g → T32j → T32k（4 子分支汇合于 T32k 集成测试）

Phase 9 (集成测试 + 收尾)：T33 / T34 / T35 / T06g (G1 全绿) / T32a (policy 同步) / T32d (N1-settings smoke) / T32f (N4 重构回归) / T32k (SR-log-1 集成)
                       → T36 → T37 → T38

Phase 10 (SR-FIX-1 合并前修补)：T38 (PR #53 已开) → T41 (dispatcher 重写) → T42 (UNIQUE migration) → T43 (unit case 18+) → T44 (writer + 文档收口) → 合并 PR #53
```

---

## 十三、风险与里程碑

### 13.1 关键风险节点

| 节点 | 风险 | 缓解 |
|---|---|---|
| T09 N5 migration 首次执行 | 不可逆破坏性变更 | 备份必须 ready；本地验证 ≥ 3 个老库 |
| T16 dispatcher 重构 | 资金红线核心 | 单元先行（T19）+ 集成补 6+ 用例（T33） |
| T25 Sheet 3 撤除 | 对外契约变更 | CHANGELOG 显著警告 + USER_GUIDE 同步 |
| T30 N7 导入冲突处理 | 误删/误覆盖风险 | 确认框 + 结果框报告 |
| T31 N6 修改 updateStatusBox 内层 | 影响范围未知 | T03 必须先 grep；preview 全套回归 |

### 13.2 中间里程碑（α 范围）

- **M1**：Phase 0-1 完成 — backup 基建 ready（T01-T06）+ N4 重构启动准备
- **M1.5**：Phase 1.5 启动 — G1-cont 与 N 项并行推进（T06a-g 持续进行）
- **M2**：Phase 2-4 完成 — N5 DB + dispatcher 落地（T07-T19）
- **M3**：Phase 5-6 完成 — N5 UI 全部完成 + 报表（T20-T26）
- **M4**：Phase 7-8 完成 — N7 + N6 落地（T27-T32）
- **M4.5**：Phase 8.5-8.7 完成 — SR-policy-1 / N1-settings / N4 重构（T32a-f）
- **M4.6**：Phase 8.8 完成 — SR-log-1 全局告警日志化（T32g-k）
- **M4.7**：Phase 1.5 完成 — G1-cont 累计 case ≥ 400 全绿（T06g）
- **M5**：Phase 9 完成 — α PR 提交（T33-T38）
- **M6**（β 启动节点）：α PR 进 review → PM 立即起 v2.1.10 β 三件套

---

## 十四、self-review 沉淀计划（v2.1.8 范式）

参 v2.1.8 self-review SR1-SR8 范式，在 PR 提交后预留 1-2 天 self-review 时间，可能产生：

- N5/N7 边界用例补强
- spec 与代码偏差 reverse sync
- 注释/文档完善
- minor bug 修复

按 v2.1.8 模式，self-review 单独 commit（含 SR{N} 标签）+ 不提新 PR（追加到当前 PR）。

---

**当前状态**：v0.1 起草中（2026-05-27 — 等用户对 spec.md §11 spec 评审 checklist 拍板 D18 / SR-backup-1 / 「通用」删除阻止策略后，T01 启动）。
**下一步**：manual-test-checklist.md 起草 → 用户审 → 建 v2.1.9 分支 → Phase 0。

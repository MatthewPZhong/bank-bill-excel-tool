---
pr_number: 39
title: "[v2.1.0-beta.3] 对账单ReconID修复模块扩展 — 网关对账单子模式 + 主面板账单类别筛选"
base: v2.1.0
head: v2.1.0-beta.3
created: 2026-05-12
integrated: false
---

# PR #39 — [v2.1.0-beta.3] 对账单ReconID修复模块扩展 — 网关对账单子模式 + 主面板账单类别筛选

| 字段 | 值 |
|---|---|
| 起源版本 | `v2.1.0-beta.2`（PR #38，merged 2026-05-11） |
| 目标版本 | `v2.1.0-beta.3` |
| 分支 | `v2.1.0-beta.3 → v2.1.0` |
| 起草日期 | 2026-05-12 |
| commits | 15（6 主 task commit + 9 用户反馈 fix commit） |
| 关联文档 | `docs/iterations/v2.1.0-beta.3/{PRD,spec,tasks,log}.md` |

---

## 一、概述

将 v2.1.0-beta.1/beta.2 落地的"单据对账 ReconID 修复"模块扩展为 **对账单ReconID修复** 通用模块，下挂两个子模式：

- **单据对账单子模式**（已有 C4，scenario.category=`recon-id-fix`）— 处理 业务部门账单 vs 对手部门账单 对账
- **网关对账单子模式**（新增 C4 gateway，scenario.category=`gateway-recon-id-fix`）— 处理 网关账单 vs 渠道账单 对账

主面板新增"账单类别"一级筛选下拉作为子模式切换入口，"场景"下拉作为二级筛选（按账单类别过滤场景列表）。两个子模式共用 C4 dialog 前端结构 + 引擎匹配算法骨架；差异点（fixture/字段集/匹配规则文案/1v多 拆账/输出列数）由 subMode 参数化。

---

## 二、改动总览

### 2.1 主 task commit（6 个，按 spec §一 task 分组）

| Commit | Task | 描述 |
|---|---|---|
| 47c87ce | T1+T2 | 网关子模式数据层（gateway 字段常量 + scenarios CHECK 扩至 5 值）+ PM 三件套（PRD/spec/tasks 起草） |
| d7736fc | T3-T5 | 主面板「账单类别」下拉 + 状态级联 + 持久化（business/gateway/null 三态 + 场景下拉按类别动态过滤） |
| bbc3bdc | T6-T7 | C4 dialog 双模式化 — business/gateway subMode 切换文案/枚举/校验/预览 + SubBizType 在 gateway 模式不渲染 |
| 77bb83a | T8-T10 | C4 引擎 + IO 双模式化 + gateway 6 用例 smoke — 算法适配 receiveAmount/createTime + business 零回归 |
| 4346027 | T11 | preview 重跑 + 4 张 gateway 状态截图 + dialog locked fieldPair 按 subMode 选默认值 |
| c94e8df | T12 | version bump 2.1.0-beta.2 → 2.1.0-beta.3 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE） |

### 2.2 用户反馈 fix commit（9 个）

| Commit | 反馈点 |
|---|---|
| 1220e39 | fix #1：账单类别为空时保持 beta.2 完整布局 — 行 2 始终显示，按钮仅 disabled 不 hidden |
| dcccaf1 | fix #2：修正主面板布局对齐 — 场景管理按钮保持在行 1 左 cell，仅"场景及其下拉框"下移至与"导出文件"平行 |
| 289d781 | fix #3：账单类别+场景下拉固定宽度 165px — 修复三态间下拉框宽度因 placeholder 长短不同引起的布局 shift |
| a0fd8bf | fix #4：grid 3 列严格对齐 — 账单类别/场景下拉右对齐 + 场景管理/导出文件垂直对齐 + 状态框等宽 pending-pair |
| f291013 | fix #5：label + 下拉样式同模式风格（.select-label / .template-select）+ 账单类别为空时场景下拉真空白 |
| 3995105 | fix #6：场景管理/导出文件/导入文件/开始运行/状态框 整体往左平移 30px |
| 6f7ddd5 | fix #7：回滚整体 30px 平移，改为非对称平移（场景管理/导出文件 -20px / 导入/运行/状态框 -15px） |
| e0b7411 | fix #8：SCENARIO_CATEGORY_LABELS 文本调整（单据对账修复→单据对账单修复 / 网关对账修复→网关对账单修复）+ commonId 加空值选项 + gateway suffix 输入框 + 校验 |
| 8239110 | fix #9：C4 dialog 错误框去掉 "• " 前缀 |

---

## 三、关键改动

### 3.1 数据层（T1+T2）

- 新增字段常量 `src/constants/gateway-bill-recon-fields.js`：
  - `GATEWAY_BILL_FIELDS` (31) / `CHANNEL_BILL_FIELDS` (16) / `ORDER_REPAIR_FIELDS_GATEWAY` (14, 无 SubBizType) / `RECON_RESULT_FIELDS_GATEWAY` (19)
  - 4 个 sheet 名常量
- `src/preload.js` inline 副本同步 + appConstants 暴露 3 字段
- scenarios.category CHECK 约束 4 → 5 值（新增 `gateway-recon-id-fix`）
  - 新增幂等迁移函数 `ensureScenariosCategoryGatewayReconIdFix`（沿用 v2.1.0-beta.1 PR-A 模板）
  - JS 层 `VALID_CATEGORIES` 同步

### 3.2 主面板（T3-T5）

- HTML 布局重构：行 1 [账单类别下拉 + 场景管理] / 行 1 右 [导入 + 运行] / 行 2 [场景下拉 + 导出文件] / 行 2 右 [状态框]
- CSS grid 3 列严格对齐（60px / 165px / 140px）+ label 同 `.select-label` + select 同 `.template-select`（48px / pill / 14px / chevron）
- state 新增 `state.reconIdFixBillCategory`（'business' | 'gateway' | null）+ 持久化到 `app_settings.recon_id_fix_bill_category`
- 切换账单类别级联清空 selectedScenarioId / Export / Session / Result + 重新过滤场景下拉

### 3.3 dialog 双模式化（T6-T7）

- `createScenarioConfigDialogC4` 从 `state.scenarioDraft.category` 推导 `subMode`（business / gateway）
- 9 处 mode-switch：匹配规则勾选框文案 / 字段下拉枚举源 / 标签文案 / 输出选项 / commonId-source 下拉 / "网关账单"radio 1v多 禁用 / SubBizType 整段不渲染 / locked fieldPair 默认值 / errors + 预览
- commonId source 下拉新增空值 option（选取后 suffix "加上"输入框必须有值，校验强制）

### 3.4 引擎 + IO 双模式化（T8-T9）

- `runC4Scenario(scenario, sheets, subMode)` 加 subMode 参数 + cfg._subMode 沿调用链传递
- 算法适配 gateway 字段名：
  - `findAmountLockedPair` 用 `locked === true` 优先识别（fallback 字段名）
  - `tryOneToManyPool` / `tryManyToOnePool` 用 `amountPair.leftField/rightField` 取 cents（不再硬编码 `r.Amount`）
  - 引擎入口对 gateway 渠道行做 `createTime → BillDate` 字段映射
- gateway 写值规则：
  - 1v1：双 Type=0 + Reference 按 output.mode 选项
  - **1v多 拆账**：输入 1 笔网关丢弃 + 输出 n 笔 Type=1 / Amount=对应渠道.receiveAmount / Reference 按选项
  - **多v1**：输出 n 笔 Type=2 / Amount 保持原值 / Reference 按选项
- IO `getSheetConfigBySubMode` helper 按 subMode 选 4 sheet 名 + 4 字段集
- 文件名前缀：业务 `单据对账修复-...` / 网关 `网关对账修复-...`
- main.js 3 个 IPC handler（import/run/export）按 subMode 路由 + session.subMode vs scenario.category 一致性校验

### 3.5 单测（T10）

- 新增 `scripts/smoke/recon-id-fix-engine-gateway.js`（6 用例 + constants sanity = 7/7 PASS）
- 覆盖：1v1×3 选项 / 1v多 拆账 / 多v1 保 Amount / 全局约束（同一渠道全局唯一消费）
- 注册到 `npm run smoke` dispatcher
- `migrations-recon-id-fix.js` E1 断言 VALID_CATEGORIES 4 → 5

### 3.6 preview（T11）

- 新增 4 张 gateway 状态截图：
  - `recon-id-fix-panel-business.png`（主面板 business）
  - `recon-id-fix-panel-gateway.png`（主面板 gateway）
  - `scenario-config-c4-gateway.png`（dialog 默认）
  - `scenario-config-c4-gateway-1vN.png`（dialog 1v多 网关账单 radio 禁用）
- 4 个 npm 脚本 + 加入 `preview:all` 串联

### 3.7 版本号 + 三件套（T12）

- `package.json` / `package-lock.json`：2.1.0-beta.2 → 2.1.0-beta.3
- `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md`：新增 v2.1.0-beta.3 段（新增 / 变更 / 修复 / 未改动 / smoke 五 section）
- `docs/USER_GUIDE.md`：头部版本号、§1.5 标题改 + 章首两子模式对比表 + §1.5.0 网关对账单子模式 5 步操作流程

---

## 四、⚠️ 关联功能 review（check-vars 自动生成）

本次改动触及以下重要变量，请针对性验证：

- **Important-skeleton**: `settingsRepository`, `ipcRenderer`
  - review: 新增 `getReconIdFixBillCategory` / `setReconIdFixBillCategory` wrapper + IPC channel `settings:set-recon-id-fix-bill-category`；preload 暴露同步；`recon-id-fix:import` 加 payload 参数（subMode），main 端 fallback business 保持向后兼容
- **Runtime-state**: `state.reconIdFixBillCategory`, `elements.reconIdFixBillCategorySelect/ScenarioRow`, `MODULES.reconIdFix.name`
  - review: 新增 state 字段含完整级联清空逻辑；module.id 保留 `recon-id-fix` 未变
- **Risk-sensitive（DB 迁移红线）**: `ensureScenariosCategoryGatewayReconIdFix`
  - review: 幂等迁移函数（沿用 v2.1.0-beta.1 PR-A 模板）；CHECK 约束 4→5 值；事务保护 + RENAME/CREATE/INSERT/DROP 无损重建 + sqlite_master.sql 幂等检查

---

## 五、测试

### 5.1 自动化

- ✅ `npm run smoke` 14 子套全绿
  - recon-id-fix-engine 23/23（business 零回归）
  - recon-id-fix-engine-gateway 7/7（新增 6 用例 + constants sanity）
  - io 13/13 / end-to-end 6/6 / migrations 15/15 / scenarios-repository 7/7
  - ipc-handlers 20/20 / scenario-engines 23/23 / dispatcher 15/15
  - exceljs-writer 3/3 / bank-statement-io 13/13 / scenario-end-to-end 23/23
  - error-causes 39/39 / usage-stats 41/41
- ✅ `npm run scan:vars` 已重跑（A-share 105 / 161 / 258 / 266）
- ✅ business 模式 fixture 跑历史 fixture `samples/单据对账导出不平.xlsx` 输出 byte-for-byte 与 v2.1.0-beta.2 一致

### 5.2 手工验证

- [x] 主面板"账单类别"下拉初始空 + placeholder + 切换 business/gateway/空 三态联动
- [x] 持久化：切到 gateway → 关闭重开 → 恢复 gateway
- [x] business 模式：跑历史 fixture 完整流程（导入/运行/导出）输出 byte-for-byte
- [x] gateway 模式：跑根目录 `资金对账导出不平.xlsx` 完整流程，输出 14 列「订单修复」sheet（文件名前缀 `网关对账修复-...`）
- [x] gateway dialog 视觉：文案 / 字段下拉 / SubBizType 隐藏 / "网关账单"radio 1v多 禁用 / locked fieldPair Amount/receiveAmount
- [x] 场景管理隔离：账单类别切换时场景下拉按类别过滤
- [x] 跨模块切换无串位
- [x] commonId source 新增空值选项 + 空值时 suffix 必填 UI 校验（错误框点确认返回 dialog）
- [x] **gateway mode='both' + suffix 拼接** Reference 输出验证（self-review P0-1 修复 + smoke Case 7 回归保护）
- [x] **gateway mode='both' + source='' 空值 + suffix → 仅 suffix** 输出验证（self-review P0-2 修复 + smoke Case 8 回归保护）
- [x] **gateway 场景不再误入银行对账 dispatcher**（PR #39 Finding 1）：启用 gateway 场景 + 跑「银行对账单处理」不抛"未知 category"
- [x] **删除 gateway 场景刷新 ReconID 模块状态而非银行对账**（PR #39 Finding 2）
- [x] **切换账单类别 main 端 session/result 同步清空**（PR #39 Codex #1）：切换后 panel 不显示旧文件/结果，Run/Export 按钮不误启用
- [x] **UI 默认 config gateway 引擎匹配成功**（PR #39 review round 2）：`createDefaultScenarioConfig` 返回 Amount/receiveAmount + 新增分组同样默认 + 归一化强制修正（含 smoke Case 8.5 回归保护）
- [x] **DB 内旧 gateway 场景自动迁移**（self-review P1-1）：`migrateGatewayReconIdFixFieldPairs` 启动时扫描修复 v2.1.0-beta.3 早期测试期创建的 Amount/Amount locked → receiveAmount

### 5.3 UI 视觉对齐（用户多次反馈精修）

经 9 个 fix commit 调整后确认：
- 行 1 [账单类别下拉] + [场景管理] 与 行 2 [场景下拉] + [导出文件] 严格垂直对齐（grid 60/165/140）
- 账单类别下拉右边界 = 场景下拉右边界
- 场景管理 正下方 = 导出文件
- 状态框 左边界 = 导入文件左边界 / 右边界 = 开始运行右边界（width 292px + transform 59px）
- 5 个右移元素整体左移（场景管理/导出 -20px / 导入/运行/状态框 -15px）
- label 字体样式 + 下拉样式同模式（.select-label + .template-select / 48px pill）
- 账单类别为空时场景下拉显示真空白（无 placeholder 文字）

---

## 六、风险点

- **资金红线（DB 迁移）**：`ensureScenariosCategoryGatewayReconIdFix` 沿用 PR-A 模板，幂等 + 事务保护；已在 smoke `migrations-recon-id-fix.js` 15/15 验证
- **business 模式回归**：所有引擎/IO 改动都通过 mode 参数化分支，default 行为保持 beta.2 一致；smoke 23/23 验证
- **回滚兼容**：用户在 beta.3 创建 `gateway-recon-id-fix` 场景后回滚 beta.2 → 启动失败（CHECK 不含新枚举值），与 v2.1.0-beta.1 → beta.0 回滚行为一致
- **场景管理 dialog 行为**：账单类别为空时按钮 disabled，UI 可见（按 beta.2 完整布局，不 hidden）

---

## 七、未改动（明确）

- C1/C2/C3 dialog 业务逻辑 + 引擎；C3 网关对账 join 与本次"网关对账ReconID修复"完全不同的模块（仅字段常量列名相同）
- 单据子模式现有 C4 引擎默认路径（mode='business' 即 beta.2 行为）
- BrowserWindow 配置 / module.id `recon-id-fix` / scenarios 表列结构与 UNIQUE 约束
- 跨模块场景共享 IPC `scenarios:list/get/create/update/delete`

---

## 八、合并后动作

按 memory `workflow_archive_pr_draft` + `workflow_pr_integrate_prd`：
1. PR 合并到 v2.1.0 后归档草稿为 `docs/prs/PR39-v2.1.0-beta.3.md`（`integrated: true`）
2. 追加改动到 PRD §七 实施记录
3. 按 memory `workflow_multi_version`：v1.5.x / v2.0.0 / v3.0.0 各分支看是否 cherry-pick（本次仅 v2.1.0 改动，其他分支不动）

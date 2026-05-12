# tasks — v2.1.0-beta.3 ReconID 模块改造：新增网关对账单子模式 + 主面板账单类别筛选

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.3` |
| 关联 PRD | `PRD-v2.1.0-beta.3.md` |
| 关联 spec | `spec.md` |
| 起草日期 | 2026-05-11 |
| 起草人 | team-lead（PM 角色） |
| 工作分支 | `v2.1.0-beta.3` |
| PR 计划 | 单 PR：`v2.1.0-beta.3 → v2.1.0` |

> 13 个 task，约 4-6 天完成。task 顺序按依赖关系排列。
> 每完成 1 个 task 提交 1 个 commit：`[v2.1.0-beta.3] <动作>(task-X): <一句话>`

---

## T1：新增 gateway-bill-recon-fields.js + preload.js 同步

- **涉及文件**：
  - 新增 `src/constants/gateway-bill-recon-fields.js`
  - 修改 `src/preload.js`（inline 副本 + IPC 暴露 API）
- **实施要点**：
  - 按 spec §2.6.1 创建文件，包含 4 个字段常量 + 4 个 sheet 名常量
  - preload.js 顶部 inline 副本（参考现有 GATEWAY_RECON_FIELDS / BUSINESS_BILL_FIELDS 同步模式）
  - 若 renderer 通过 IPC 获取字段（参考 v2.1.0-beta.1 的 `scenariosApi.getFields(type)`），扩展 type 枚举：新增 `'gatewayBill'` / `'channelBill'` / `'orderRepairGateway'`
  - **不复用** `GATEWAY_RECON_FIELDS`（v2.0.0-beta.3 C3 用），独立维护，注释提醒
- **验收证据**：
  - `node -e "const m = require('./src/constants/gateway-bill-recon-fields'); console.log(Object.keys(m), m.GATEWAY_BILL_FIELDS.length, m.CHANNEL_BILL_FIELDS.length, m.ORDER_REPAIR_FIELDS_GATEWAY.length)"` 输出 31 / 16 / 14
  - 启动 Electron 应用，DevTools console 验证 `window.desktopApi.scenariosApi.getFields('gatewayBill')` 返回 31 列
- **关联 spec**：§2.6.1 / §2.6.2
- **预计工作量**：0.3 天
- **风险**：低（新增文件，零回归）

---

## T2：scenarios DB 校验扩展 + CHECK 约束迁移（2026-05-11 reverse sync 修订）

- **涉及文件**（**3 个**）：
  - `src/backend/database/scenarios-repository.js`（JS 层白名单）
  - `src/backend/database/migrations.js`（**新增幂等迁移函数**，沿用 v2.1.0-beta.1 PR-A 模板）
  - `src/backend/database.js`（调用新迁移函数）
- **实施要点**：
  - scenarios-repository.js L11-17：`VALID_CATEGORIES` 数组追加 `'gateway-recon-id-fix'`
  - migrations.js：新增 `ensureScenariosCategoryGatewayReconIdFix(db)`（参考 L486-L530 `ensureScenariosCategoryReconIdFix` 完整复制，CHECK 改 5 值），并加入 module.exports
  - database.js L116 附近：在 `ensureScenariosCategoryReconIdFix(db)` 调用之后插入 `ensureScenariosCategoryGatewayReconIdFix(db)`
  - **不动** `settings-repository.js:97` `CURRENT_MODULE_VALID`（这是 module.id 白名单，本次 module.id 保留）
- **验收证据**：
  - `node --check src/backend/database/migrations.js` 语法 OK
  - 启动应用 → DevTools console 验证 DB schema：`SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'` 含 `'gateway-recon-id-fix'`
  - 启动应用第二次 → 看日志确认 `ensureScenariosCategoryGatewayReconIdFix` 走 no-op 分支（幂等）
  - 创建 category=`gateway-recon-id-fix` 测试场景 → DB 查询返回数据
  - 旧库迁移：用 v2.1.0-beta.2 创建若干 C1/C2/C3/C4 场景 → 升级到 beta.3 启动 → 所有旧场景数据无丢失 + scenarios_old 已删除
- **关联 spec**：§2.3.5
- **预计工作量**：0.3 天（修订自 0.1 天）
- **风险**：低（v2.1.0-beta.1 PR-A 模板已 PR #37/#38 实战验证）
- **资金红线提示**：迁移包在事务里，BEGIN/RENAME/CREATE/INSERT/DROP/COMMIT，失败 ROLLBACK

---

## T3：index.html 模块下拉文本 + 主面板布局重排

- **涉及文件**：`index.html` L45 + L215-240
- **实施要点**：
  - L45：模块下拉项文本 `单据对账 ReconID 修复` → `对账单ReconID修复`（`data-module` 保留 `recon-id-fix`）
  - L215-240：reconIdFixModulePanel 重排，按 spec §2.2.1：
    - 行 1 新增 `recon-id-fix-bill-category-row` 含 `<select id="reconIdFixBillCategorySelect">`（3 个 option：空 / business / gateway）
    - 行 2 保留导入文件 + 开始运行
    - 行 3 新增 `recon-id-fix-scenario-row` 整行 `hidden`，含 场景下拉 + 场景管理 + 导出文件 3 个元素
    - 行 4 保留状态
  - CSS：在 `src/styles-gemini-extra.css`（或同等文件）加 `.recon-id-fix-bill-category-row` 样式
- **验收证据**：
  - `npm start` 启动 → 主面板模块下拉显示 `对账单ReconID修复`
  - 切到该模块 → 看到行 1 账单类别下拉（空 placeholder）+ 行 2 导入/运行 + 行 3 隐藏 + 状态栏
- **关联 spec**：§2.1.2 / §2.2.1 / §2.2.2
- **预计工作量**：0.3 天
- **风险**：中（视觉布局改动）

---

## T4：renderer.js state + elements + 持久化加载/切换 + module name

- **涉及文件**：`src/renderer.js`
- **实施要点**：
  - L56-60：`MODULES.reconIdFix.name` = `'对账单ReconID修复'`
  - state 新增字段（约 L143-150）：`reconIdFixBillCategory: null`
  - elements 缓存（约 L240-260）：`reconIdFixBillCategorySelect: document.getElementById('reconIdFixBillCategorySelect')`
  - 启动加载（initializeApp 或同等位置）：从 `desktopApi.settings.get('recon_id_fix_bill_category')` 读取，恢复 UI 选中态
  - change 监听：切换时持久化 + 级联清空 + 刷新 panel
  - 新增辅助函数：`updateReconIdFixPanelVisibility()`（控制行 3 hidden 显隐）+ `clearReconIdFixSessionForCategorySwitch()`（清 selectedScenarioId / Export / import session）
- **验收证据**：
  - DevTools console：`state.reconIdFixBillCategory` 切换前后正确变更
  - SQLite 验证：`SELECT * FROM app_settings WHERE key='recon_id_fix_bill_category'` 持久化生效
  - 切换 business ↔ gateway ↔ ""，行 3 显示/隐藏 + 场景下拉刷新
- **关联 spec**：§2.1.1 / §2.7.3 / §3.1
- **预计工作量**：0.4 天
- **风险**：中（state 级联，参考 v2.1.0-beta.2 PR #38 教训）

---

## T5：renderer.js scenarios 过滤 + 场景管理按钮联动

- **涉及文件**：`src/renderer.js` L3414 + L3728-3732
- **实施要点**：
  - L3414：scenarios filter 改为按 `state.reconIdFixBillCategory` 推导出的 targetCategory 过滤（spec §2.3.4）
  - L3728-3732：场景管理按钮 click handler 改为动态传 allowedCategories（spec §2.3.3）
  - 场景管理按钮 enabled 控制：账单类别为空时 disabled
- **验收证据**：
  - 账单类别=business → 场景下拉只显示 category=`recon-id-fix` 的场景
  - 账单类别=gateway → 场景下拉只显示 category=`gateway-recon-id-fix` 的场景
  - 账单类别=空 → 场景管理按钮 disabled
- **关联 spec**：§2.3.3 / §2.3.4 / §3.2
- **预计工作量**：0.2 天
- **风险**：低

---

## T6：renderer-dialogs.js openScenarioConfigByCategory + 类别选择窗白名单扩展

- **涉及文件**：`src/renderer-dialogs.js`
- **实施要点**：
  - L70-78：`openScenarioConfigByCategory` 加新 case：`if (category === 'gateway-recon-id-fix') return openModal(createScenarioConfigDialogC4('gateway'))`；同时已有 `recon-id-fix` case 改为 `createScenarioConfigDialogC4('business')`
  - L5552（`createScenarioCategorySelectDialog`）：默认枚举加 `'gateway-recon-id-fix'`
  - L5695 / L5730 / L5805 / L7263：grep `if (category === 'recon-id-fix')` 分支，确认是否需要扩展到 gateway（多数是 dialog 状态判断/CRUD 路径，逻辑相同）
- **验收证据**：
  - 银行对账单模块 → 场景管理 → 新增场景 → 类别选择窗显示 5 类（含 gateway-recon-id-fix）；选 gateway → 进入 C4 dialog mode=gateway
  - ReconID 模块（账单类别=gateway）→ 场景管理 → 新增场景 → **跳过类别选择** → 直接 C4 dialog mode=gateway
- **关联 spec**：§2.3.1 / §2.3.2
- **预计工作量**：0.3 天
- **风险**：中（多处调用点）

---

## T7：C4 dialog 加 mode 参数 + mode-switch（文案 / 枚举 / 禁用 / SubBizType 隐藏）

- **涉及文件**：`src/renderer-dialogs.js` L6633-L7400（createScenarioConfigDialogC4 主体）+ L5677-L5901（validate 逻辑）
- **实施要点**：
  - L6633：函数签名加 `(mode = 'business')`
  - L6740-L6750：勾选框文案 mode-switch（业务侧文案/网关侧文案）
  - L5677/L5698：billTypes 字段下拉枚举源 mode-switch（business 用 BUSINESS_BILL_FIELDS/OPPONENT_BILL_FIELDS；gateway 用 GATEWAY_BILL_FIELDS/CHANNEL_BILL_FIELDS）
  - L6768：标签文案 mode-switch（修复结果输出 → 订单修复ID取值）
  - L6904-L6920：选项 span 文本 + commonId-source 下拉枚举 mode-switch
  - L6928-L6940：mode='gateway' 时 SubBizType 取值栏整段 DOM 不渲染
  - L5884 / L5895-L5901：errors 校验文案 + SubBizType 校验跳过
  - "网关账单"选项可用性：勾选 `oneToMany` / `manyToOne` 时禁用（gateway only）
  - **关键**：mode='business' 路径必须保留原代码，零回归
- **验收证据**：
  - 编辑一个 category=`recon-id-fix` 的场景 → dialog 显示 business 文案 + SubBizType 取值栏 + 主边/从边/主从都修复 选项
  - 新建 category=`gateway-recon-id-fix` 场景 → dialog 显示 gateway 文案 + 无 SubBizType 取值栏 + 网关账单/渠道账单/自取值 选项
  - 勾选 `网关 1v多` → "网关账单"选项禁用
  - 切换 `网关 1v多` / `网关 多v1` 互斥
  - 单据模式 dialog 截图与 v2.1.0-beta.2 byte-for-byte 一致
- **关联 spec**：§2.4.1 / §2.4.2 / §2.4.3
- **预计工作量**：0.8 天
- **风险**：高（dialog 改动最大）

---

## T8：C4 引擎加 mode 参数 + 网关写值分支

- **涉及文件**：`src/main-process/scenario-engines/c4-recon-id-fix.js`
- **实施要点**：
  - `runC4Scenario` 签名加 `mode='business'`
  - 算法骨架（subset-sum / BillDate ±1day / tie-break / pairedLeft/Right）**完全保留**
  - 1v1 / 1v多 / 多v1 写值环节按 mode 分支（spec §2.5.2）
  - 新增 helper：`computeReferenceGateway(mainRow, oppRow, scenario)`（spec §2.5.3）
  - 新增 helper：`splitGatewayOneToMany(mainRow, oppRows, scenario)`（spec §2.5.2 — 拆账）
  - 输出 fixedRows 时按 mode 决定列模板（business=ORDER_REPAIR_FIELDS, gateway=ORDER_REPAIR_FIELDS_GATEWAY）
- **验收证据**：
  - 单测 `node scripts/smoke/recon-id-fix-engine.js`（business 现有）全绿 — 零回归
  - 单测 `node scripts/smoke/recon-id-fix-engine-gateway.js`（T10 创建）全绿
- **关联 spec**：§2.5.1 / §2.5.2 / §2.5.3 / §2.5.4
- **预计工作量**：1 天
- **风险**：高（核心算法 + 拆账逻辑独有）

---

## T9：引擎顶层路由 + IO writer mode 分支

- **涉及文件**：
  - `src/main-process/recon-id-fix-engine.js` L9-20
  - `src/main-process/recon-id-fix-io.js` L100-L210
- **实施要点**：
  - engine.js：`runReconIdFix` 内按 `scenario.category` 推导 mode（spec §2.5.1）
  - io.js：reader / writer 加 mode 参数
    - mode='business': 用 BUSINESS_BILL_SHEET_NAME / OPPONENT_BILL_SHEET_NAME / ORDER_REPAIR_FIELDS
    - mode='gateway': 用 GATEWAY_BILL_SHEET_NAME / CHANNEL_BILL_SHEET_NAME / ORDER_REPAIR_FIELDS_GATEWAY
  - `src/main.js` IPC handler 调用引擎时按场景 category 传 mode（或保持隐式由 engine 内部推导，main.js 不变）
- **验收证据**：
  - 跑端到端：导入 `资金对账导出不平.xlsx` → 选 gateway 场景 → 运行 → 导出 → 输出文件「订单修复」sheet = 14 列
  - 跑端到端：导入 `samples/单据对账导出不平.xlsx` → 选 business 场景 → 运行 → 导出 → 输出文件「订单修复」sheet = 15 列（无回归）
- **关联 spec**：§2.5.1 / §2.5.2
- **预计工作量**：0.5 天
- **风险**：中

---

## T10：gateway 引擎单测（fixture 化，**基线 6 用例 + PR #39 review 扩至 9 用例 → 10/10 PASS**）

- **涉及文件**：新增 `scripts/smoke/recon-id-fix-engine-gateway.js`
- **实施要点**：
  - 参考 `scripts/smoke/recon-id-fix-engine.js` 结构
  - 输入 fixture：构造内嵌 fixture（或读 `资金对账导出不平.xlsx`），基线覆盖 6 用例（PRD §6.2）：
    1. 1v1 × Reference 取网关账单
    2. 1v1 × Reference 取渠道账单
    3. 1v1 × Reference 取自取值-网关ReconID
    4. 1v多（拆账，验 Type=1 / Amount=对应渠道.receiveAmount / 输入丢弃 / 每笔渠道一一对应）
    5. 多v1（验 Type=2 / Amount 保持 / Reference 按选项）
    6. 全局约束（同一渠道账单不能被两组复用 — 构造冲突场景验证错误/正确路由）
  - 每个用例：构造 scenario + sheets → 跑 `runReconIdFix` → 断言 fixedRows / unmatched / warnings
  - PR #39 review 期间新增 3 用例（self-review P0-1 / P0-2 + review-round-2 P1 回归保护）：
    7. mode='both' + commonId.source='main' + suffix='-FIX' → Reference 应拼接为 `GW-RECON-007-FIX`
    8. mode='both' + commonId.source='' (空值) + suffix='-ONLY-SUFFIX' → Reference 仅 suffix
    8.5. UI 默认 config（Amount/receiveAmount locked） → 引擎能正确匹配 1 行
- **验收证据**：
  - `node scripts/smoke/recon-id-fix-engine-gateway.js` 退出码 0
  - console 输出 **10/10 PASS**（基线 6 用例 + review 扩展 3 用例 + constants sanity）
- **关联 spec**：§4.2
- **预计工作量**：0.6 天（基线）+ 0.2 天（PR #39 review 扩展）
- **风险**：中（用例构造易漏边界）

---

## T11：preview 重跑 + 新增 gateway 状态截图

- **涉及文件**：`src/renderer-previews.js` + `scripts/render-preview.js`（如需新增状态）
- **实施要点**：
  - 现有 4 个 preview 入口全量重跑（按 memory `workflow_frontend_previews`）
  - 新增 preview 状态：
    - ReconID 主面板：账单类别=空（默认）
    - ReconID 主面板：账单类别=business（行 3 显示）
    - ReconID 主面板：账单类别=gateway（行 3 显示）
    - C4 dialog mode='gateway'：默认态
    - C4 dialog mode='gateway'：勾选 `网关 1v多` → 网关账单选项禁用态
- **验收证据**：
  - `npm run preview` 等 4 个命令全部跑通
  - 新增 5 张 preview 截图存入 `docs/preview-snapshots/v2.1.0-beta.3/`（如约定）
- **关联 spec**：§4.2
- **预计工作量**：0.4 天
- **风险**：低

---

## T12：版本号 bump + 文档三件套

- **涉及文件**：
  - `package.json` / `package-lock.json`
  - `CHANGELOG.md`
  - `docs/VERSION_FEATURE_HISTORY.md`
  - `docs/USER_GUIDE.md`
- **实施要点**：
  - `package.json.version`：`2.1.0-beta.2` → `2.1.0-beta.3`
  - `npm install --package-lock-only`（同步 lock 文件 root version）
  - CHANGELOG.md：新增 v2.1.0-beta.3 条目（feat/fix 分组）
  - VERSION_FEATURE_HISTORY.md：补 v2.1.0-beta.3 特性章节（含 module 重命名 + gateway 子模式 + UI 重排 + 持久化 + 三选项 Reference 取值）
  - USER_GUIDE.md：新增"对账单ReconID修复 — 网关对账单子模式"操作流程
- **验收证据**：
  - `cat package.json | grep version` = `2.1.0-beta.3`
  - 三件套文件 git diff 完整
- **关联 spec**：§2.8
- **预计工作量**：0.3 天
- **风险**：低

---

## T13：scan:vars + check-vars + smoke 全量 + 自测循环

- **涉及文件**：无（验证 task）
- **实施要点**：
  - `npm run scan:vars`（版本号 bump 触发硬节点）
  - `/check-vars` skill（提 PR 前硬节点）→ 输出 PR body "⚠️ 关联功能 review"段落
  - `npm run smoke` 全量
  - 手工自测循环（按 memory `feedback_no_skip_spec` + `workflow_no_tester_no_auto_pr`，用户手工测过+明确说"提 PR"后才提）
- **验收证据**：
  - `docs/analysis/var-reference-stats.md` 重新生成
  - `npm run smoke` 退出码 0
  - 用户确认手工测试通过
- **关联 spec**：§4 / §5
- **预计工作量**：0.5 天
- **风险**：低（验证 task）

---

## 总览

| Task | 文件数 | 工作量 | 风险 |
|---|---|---|---|
| T1 | 2（新增 1 + 改 1） | 0.3 天 | 低 |
| T2 | 3 | 0.3 天 | 低 |
| T3 | 1-2 | 0.3 天 | 中 |
| T4 | 1 | 0.4 天 | 中 |
| T5 | 1 | 0.2 天 | 低 |
| T6 | 1 | 0.3 天 | 中 |
| T7 | 1 | 0.8 天 | **高** |
| T8 | 1 | 1 天 | **高** |
| T9 | 3 | 0.5 天 | 中 |
| T10 | 1（新增） | 0.6 天 | 中 |
| T11 | 1-2 | 0.4 天 | 低 |
| T12 | 4 | 0.3 天 | 低 |
| T13 | 0 | 0.5 天 | 低 |
| **合计** | **~18** | **~5.7 天** | — |

---

## PR 提交节奏

按 memory `workflow_no_tester_no_auto_pr` + `workflow_pr_integrate_prd` + `workflow_archive_pr_draft`：
1. T1-T13 全部完成 + 用户手工测试循环结束 + 用户明确说"提 PR" → team-lead 提 PR
2. PR 草稿写入 `docs/prs/待merge-PR #N.md`
3. PR 创建后重命名为 `docs/prs/PRN-v2.1.0-beta.3.md`
4. 归档后追加改动清单到 PRD §七 实施记录（`integrated: true` 防重复）

---

> **下一步**：用户 review tasks.md → 启动 Dev（从 T1 开始）

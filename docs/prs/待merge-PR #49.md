---
pr: 49
version: v2.1.5
branch: v2.1.5
base: main
status: draft
integrated: false
created: 2026-05-15
---

# [v2.1.5] feat: 模块名空格化 + 场景下拉空状态优化 + C3 网关 join 场景新增「条件」栏

## Summary

v2.1.5 三块独立改动：

- **N1 — 对账单 ReconID 修复模块名加空格**：`对账单ReconID修复` → `对账单 ReconID 修复`（ReconID 前后各加一个空格）；顺手修 usage-stats long-standing bug — `FUNCTION_REGISTRY` 旧 key `'单据对账ReconID修复'` 与 `trackedIpcHandle` 第 2 参 `'对账单ReconID修复'` 不匹配，导致该模块计数自 v2.1.0-beta.1 起静默丢弃；本版改新 key `'对账单 ReconID 修复'` 全链路一致
- **N2 — 对账单 ReconID 修复主面板场景下拉空状态优化**：3 档行为统一为「无可选项时真空白；有可选项时直接列场景」+ fix1.2 修订（默认选中第 1 个枚举值，撤回 v0.2 `selectedIndex = -1` 设计）
- **N3 — 银行对账单处理 C3「提取ReconId-From 网关」场景配置 dialog 新增「条件」栏**：行级 AND 预过滤；柔性校验（0 行 = 不过滤，兼容旧场景）；运行时引擎 `runC3Scenario` 入口新增 Step 0 拆分两侧 + 过滤 `gwRows` / `bankRows`；银行侧虚拟字段「发生额绝对值」由新增 `evalCondition` helper 走 `getBankRowValueForC3` 计算；fix1.1 修订（条件 row 列宽固定，避免 side 切换时 row 跳变）

完整规格见 `docs/iterations/v2.1.5/PRD-v2.1.5.md` v0.3 / `spec.md` v0.2 / `tasks.md`。

## 改动清单（17 个 commit）

| Commit | 描述 |
|---|---|
| `f8c578c` | feat(t1.1): MODULE_REGISTRY.reconIdFix.name 加空格 |
| `5c6f9c4` | feat(t1.2): main.js trackedIpcHandle moduleKey 加空格（3 处） |
| `f229b8d` | fix(t1.3): main.js error message 模块名加空格 |
| `80e9655` | fix(t1.4): usage-stats FUNCTION_REGISTRY 改新 key + 修 long-standing bug |
| `4b4ceb5` | feat(t2): N2 场景下拉空状态优化（删占位 + selectedIndex=-1） |
| `8bfc427` | feat(t3.1): C3 默认配置 + dialog 兜底 — config.conditions 字段 |
| `e55f33b` | feat(t3.2): C3 dialog 新增「条件」栏 UI + 数据流 |
| `c0d8120` | feat(t3.3): C3 dialog 校验 — conditions 柔性 + side/field 一致性 |
| `8010097` | feat(t3.4): C3 confirm 预览段追加 conditions |
| `07e2f02` | feat(t3.5): C3 引擎接入 — runC3Scenario Step 0 + evalCondition helper |
| `5bff875` | test(t4-smoke): C3 引擎 conditions 8 case |
| `7a03373` | test(t4-smoke): N1 usage-stats key 修复 3 case |
| `3b41a96` | fix(t6-fix1.1): C3 条件 row 列宽固定 |
| `e2a5031` | fix(t7-fix1.2): 对账单 ReconID 修复场景下拉默认选第 1 个 |
| `436abef` | docs(fix1): reverse sync PRD/spec/tasks v0.3 |
| `acd6545` | chore(fix1): refresh previews（8 张） |
| `bc91413` | chore: bump version 2.1.5 |

## 文件改动 / 新增清单

| 类型 | 文件 |
|---|---|
| 改 | `src/renderer.js` — N1 模块名 + N2 场景下拉 + fix1.2 默认选第 1 个 |
| 改 | `src/main.js` — N1 4 处字面（3 trackedIpcHandle + 1 error message） |
| 改 | `src/backend/usage-stats.js` — N1 FUNCTION_REGISTRY key |
| 改 | `src/renderer-dialogs.js` — N3 dialog 新增条件栏 + 默认配置 + 校验 + confirm 预览 + fix1.1 c3-cond-row class |
| 改 | `src/main-process/scenario-engines/c3-gateway-recon-join.js` — N3 引擎 Step 0 + evalCondition helper |
| 改 | `src/styles.css` — fix1.1 .scenario-config-c3-cond-row + .scenario-config-c3-cond-field |
| 改 | `src/styles-gemini-extra.css` — fix1.1 同步规则（Clear theme） |
| 改 | `scripts/smoke/scenario-engines.js` — 新增 8 case（C3 conditions） |
| 改 | `scripts/smoke/usage-stats.js` — 新增 3 case（N1 key 修复防回归） |
| 改 | `package.json` / `package-lock.json` — version 2.1.4 → 2.1.5 |
| 改 | `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` — 文档三件套 v2.1.5 段 + 顶部版本号 |
| 新 | `docs/iterations/v2.1.5/{PRD-v2.1.5,spec,tasks}.md` |
| 新 | 8 张 preview 重跑入库（main-page / module-cabinet / module-switcher-open / account-mapping / recon-id-fix-panel + business + gateway / scenario-config-c3） |

## ⚠️ 关联功能 review（check-vars 自动生成）

`npm run check:vars -- --since main` 命中：

- **Critical**：0
- **Important-skeleton**：0
- **Runtime-state 命中 1**：
  - `state`（`src/renderer.js`）— fix1.2 在 `reloadReconIdFixScenarios` 末尾自动设 `state.reconIdFixSelectedScenarioId = scenarios[0].id`（仅 ReconID 修复模块场景下拉初始化时序）；不涉及 模板列表 / 当前模块 / 导出可用性 三组联动；下游 `refreshReconIdFixStatus` 在末尾统一触发，副作用与用户手动选场景一致
- **可忽略**：
  - `dialog`（`src/renderer-dialogs.js`）— 渲染层局部变量 `const dialog = document.createElement(...)`，按 `rules/important-variables.md:262` 备注判定可忽略（**非 Electron 主进程 dialog**）。N3 在 `createScenarioConfigDialogC3` 内新增「条件」栏 DOM 与事件，仅作用于 C3 场景配置 dialog；不动其他 dialog 工厂；fix1.1 加专属 class `scenario-config-c3-cond-row` / `scenario-config-c3-cond-field` 不复用 `.scenario-config-multi-row` 避免影响 reconFields / billTypes 行
- **Risk-sensitive**：0

**潜在风险（清单外，dev 自评估）**：

- `runC3Scenario`（`src/main-process/scenario-engines/c3-gateway-recon-join.js`）— 资金对账引擎入口
  - 改动：入口新增 Step 0 — 按 `config.conditions` 拆分两侧 + 行级过滤 `gwRows` / `bankRows` 后传入既有循环；银行侧虚拟字段「发生额绝对值」由新增 `evalCondition(row, cd, { useC3BankValueGetter })` 走 `getBankRowValueForC3` 计算
  - **核心 join 循环零修改**：`gwMatchesBank` / `chosen[assign.gwField]` / `bankRow[assign.bankField]` 写值逻辑零改动（资金红线零修改）
  - **兼容**：v2.1.4 旧 scenario `config.conditions` 缺失 → 引擎兜底 `[]`（不过滤，全通过）→ 行为与 v2.1.4 完全一致（零回归）
  - **smoke 防回归**：`scripts/smoke/scenario-engines.js` 新增 8 case 覆盖 7 op + AND 多条件 + 0 条件兼容 + 银行侧虚拟字段；全 31 case 通过

## Test plan

### 自动测试

- [x] `npm run smoke` — 全绿（含 `scenario-engines 31/31` + `usage-stats 61/61` + 既有零回归）
- [x] `npm run preview` / `npm run preview:account` / `npm run preview:module-cabinet` / `npm run preview:module-switcher-open` / `npm run preview:recon-id-fix` / `npm run preview:scenario-config-c3` — 8 张 preview 重跑入库
- [x] `npm run check:vars -- --since main` — Critical 0 / Important-skeleton 0 / Runtime-state 1（`state`，已对齐）+ 1 可忽略（`dialog` 渲染层局部变量，按 `rules/important-variables.md:262` 判定）/ Risk-sensitive 0

### 手动验证（用户已验收）

- [x] 启动应用 → 主页面左上角模块切换菜单的「对账单 ReconID 修复」按钮显示 2 个空格（与 v2.1.4 无空格对比）
- [x] 进对账单 ReconID 修复模块跑 `导入文件` / `开始运行` / `导出文件` 各 1 次 → 关闭应用 → cat `.usage-stats.txt` → 存在 `[对账单 ReconID 修复]` section + 3 个 fnKey 各 ≥ 1（N1 bug 修验证）
- [x] 主面板「账单类别」选 `gateway` + DB 该类别下无场景 → 场景下拉显示真空白 + disabled（**不再显示「请先在场景管理中创建场景」**）
- [x] 主面板「账单类别」选 `gateway` + DB 有 ≥ 1 场景 → 场景下拉直接列 scenarios（**无「请选择场景」占位项**）+ **默认选中第 1 个**（fix1.2 验证）
- [x] 银行对账单处理 → 场景管理 → 新增「提取ReconId-From 网关」场景 → dialog 在「优先级」与「对账字段」之间显示「条件」label + 空容器 + 「+ 新增条件」按钮（默认 0 条）
- [x] 点「+ 新增条件」加 1 行 → 左一切「网关」时左二字段下拉为 `GATEWAY_RECON_FIELDS`（31 列）；切「银行」时为 `BANK_STATEMENT_FIELDS_FOR_C3`（45 项含虚拟「发生额绝对值」）
- [x] 左三选「空值」/「非空值」时右侧值输入框 `visibility:hidden`；切回其他操作时显示
- [x] 删完所有条件保存 → 通过校验（柔性 0 行）；≥ 1 行时 side/field 为空 / 非「空值/非空值」操作 value 为空 → alert 拦截
- [x] side='网关' 但 field='Currency'（不在 31 列网关字段集）→ alert 拦截（一致性校验）
- [x] 保存后再次打开同场景，「条件」栏正确回显（数量、各行字段值）
- [x] 旧 v2.1.4 创建的 C3 场景在 v2.1.5 打开 dialog 时，「条件」栏显示 0 条，可直接保存（DB 兼容）
- [x] 运行时：网关账单 2 行（HKD/USD），配置条件 `[网关, Currency, 等于, HKD]` → 引擎过滤后 gwRows 仅留 HKD 行进入比对；USD 行被过滤
- [x] 运行时：旧 DB scenario `config.conditions` 缺失 → 引擎兜底 `[]`，不过滤，行为与 v2.1.4 完全一致（零回归）
- [x] fix1.1 验证：C3 条件 row 在「网关 ↔ 银行」切换时 row 列宽不再跳变（左二字段固定 240px）；下拉打开时长字段名（`Type(0:1对1,...)`）option 完整可见
- [x] fix1.2 验证：进对账单 ReconID 修复模块即看到场景下拉已选中第 1 个，主面板「开始运行」按钮立即可用（无需先展开下拉）

### PR-CI 必跑

- [ ] CI 上 smoke 通过
- [ ] preview:all 全部生成（无新 preview 漏跑）

## OPEN ISSUES 拍板记录（详见 PRD §十）

| # | 议题 | 拍板 |
|---|---|---|
| Q1 | N1 业务OP数据核对是否一并改名 | 不改（用户撤回） |
| Q2 | N1 是否做 `.usage-stats.txt` 历史数据 migration | 不做（旧 key 历史从未成功累计；writeStatsFile 自动按 FUNCTION_REGISTRY 顺序输出新 key） |
| Q3 | N1 IPC channel name 是否改名 | 不改（preload + DB schema 依赖） |
| Q4 | N2 scenarios 为空时 select.disabled 是否保留 true | 保留（沿用现状） |
| Q5 | N2 有 scenarios 但用户未选时 select 默认显示 | v0.2 拍板 selectedIndex=-1；**fix1.2 撤回 → 默认选第 1 个** |
| Q6 | N3 v2.1.5 范围是否包含运行时引擎实现 | 包含 |
| Q7 | N3 校验严格程度 | 柔性（conditions 可 0 行） |
| Q8 | N3 字段枚举源歧义 | 无歧义（C3 既有的 GATEWAY_RECON_FIELDS / BANK_STATEMENT_FIELDS_FOR_C3 已与运行时字段名 byte-for-byte 对齐） |
| Q9 | N3 银行侧虚拟字段「发生额绝对值」是否走 `getBankRowValueForC3` 取值 | 走（新增包装函数 `evalCondition(row, cd, { useC3BankValueGetter })`） |
| Q10 | N3 side / field 一致性校验是否在 dialog 保存时弹 alert | 弹（防御左一切换未清空 bug + 防御手改 DB） |

## 风险提醒（⚠️ 人工复核要点）

- ⚠️ **N3 资金对账引擎改动**：`runC3Scenario` 入口新增 Step 0 行级过滤；核心 join 循环 / 写值逻辑 0 修改；smoke 8 case 覆盖（含 0 条件兼容用例）；旧 DB scenario 兜底 `[]` 不过滤
- ⚠️ **N1 字面替换非 IPC 协议改动**：`module.id` / `scenario.category` / IPC channel 不动；仅 UI 显示 + usage-stats 写盘 key 改字面
- ⚠️ **fix1.2 状态自动赋值**：`reloadReconIdFixScenarios` 末尾在 `state.reconIdFixSelectedScenarioId === null && scenarios.length > 0` 时自动赋第 1 个；副作用与用户手动选场景一致；不影响 selectedScenarioId 已有值的情况

## 关联文档

- `docs/iterations/v2.1.5/PRD-v2.1.5.md` — 产品需求文档（含 fix1.1 / fix1.2 修订记录，v0.3）
- `docs/iterations/v2.1.5/spec.md` — 技术规格（v0.2 — N3 重写到 C3，含 fix1 段）
- `docs/iterations/v2.1.5/tasks.md` — 任务拆分
- `rules/important-variables.md` — 本版无升格

## Reviewer 复核重点

1. **N3 资金红线**：`runC3Scenario` Step 0 是否真正不影响核心 join 循环 / 写值逻辑（建议看 `c3-gateway-recon-join.js` 全文 + 8 case smoke）
2. **`evalCondition` helper 银行侧虚拟字段处理**：`useC3BankValueGetter=true` 时走 `getBankRowValueForC3` 取值，与既有 reconFields 银行侧虚拟字段处理一致
3. **N3 柔性校验是否合理**：conditions 可 0 行（兼容旧场景免迁移）；dialog 保存时校验 vs 引擎兜底两层防御
4. **fix1.1 CSS 改两套主题**：`src/styles.css` + `src/styles-gemini-extra.css` 同步加规则；不复用 `.scenario-config-multi-row` flex
5. **fix1.2 状态副作用**：`reloadReconIdFixScenarios` 末尾自动赋第 1 个，下游 `refreshReconIdFixStatus` 是否需要在所有 caller 路径触发

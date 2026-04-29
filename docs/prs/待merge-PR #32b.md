---
status: 待 merge
integrated: false
---

# PR #32b（待 merge）

- **分支**：`v2.0.0` → `main`
- **版本**：`2.0.0-beta.3`（本 PR bump beta.2 → beta.3）
- **依赖**：PR #32a（已 merge `e21be0d`，5 IPC + dispatcher + IO）

---

## Summary

v2.0.0-beta.3「**银行对账单处理模块**」第 4 个 PR 切分后第二段（前端闭环 + 发版）。

PR #32a 已交付后端 5 IPC + dispatcher + IO，本 PR 把 4 个 dialog factory 串成"导入 → 运行 → 标黄输出"完整工作流：4 dialog（C1/C2/C3 配置 + 确认详情）+ PR #30 占位接入 + bankStatementModulePanel 4 按钮 binding + statusBox 5 状态 + E2E smoke + 8 项用户实测 UX 调整 + 文档三件套 + 版本 bump。

---

## ⚠️ 资金红线

**本 PR 是用户能真改 `FundType` / `ReconciliationId` 的关口**——前端接通后，一切在 dispatcher 里发生的覆盖都会被持久化到用户主输出 xlsx：

- C2 outbound 行 `FundType` → `outbound Fail`
- C1 / C3 写入 `ReconciliationId`
- first-match-wins 行锁错位 → 高优先级场景未命中、低优先级覆盖
- ⚠️ **本 PR 删除 C1 `overwrite-existing-recon-id` + C3 `overwrite-existing-value` warning**（用户 UX 决策 2026-04-29）：原值非空被覆盖时不再产生 error-report 记录，需依赖主输出黄底 + modifications 列表追踪

**E2E smoke 覆盖**（新增 23 用例）：
- E1: 三类场景同时命中（C1/C2/C3 不同行 + 黄底验证 + ReconciliationId/FundType 写入）
- E2: first-match-wins（C1 优先级 3 > C3 优先级 1，不重复入 modifiedRows）
- E3: gwRows=null 启用 C3 → skippedC3Count=1
- E4: error-report 路径独立（C1 多字段值不一致 → 不写入 + warn xlsx 落盘）

**用户样例 dry-run（PRD §13.1 P0-1 ~ P0-11）**：用户 GUI 实测中（截至本 PR 草稿，已通过工作流主路径 + 8 轮 UX 反馈循环）。

---

## ⚠️ 关联功能 review（check-vars）

`/check-vars` 软流程命中 1 Risk-sensitive + 1 Runtime-state（知会）：

- **Risk-sensitive · 数据库迁移**：新增 `ensureBuiltinScenarioNamesUpdate`（`src/backend/database/migrations.js`）
  - review：✅ 幂等（UPDATE WHERE oldName + category，重复运行 no-op）✅ 不 DROP / 不破坏 ALTER ✅ 仅修改 `scenarios.name` 字段
  - 触发场景：内置 3 场景重命名（PR #32b 改名："调拨ReconId自提取" → "从银行对账单的信息里提取对账ID" 等）
- **Runtime-state · `state`**：新增 5 字段（`bankStatementSession` / `gatewayReconSession` / `processingResult` / `bankStatementExport` / `scenarioDraft`）
  - review：全新增字段，不破坏既有 state 字段语义；renderer-side 缓存，不持久化

Critical / Important-skeleton / Minor：未命中（v1.5.3 基线变量，本 PR 改动集中在 v2.0.0-beta.3 新增模块）。

**必跑**：
- [x] `npm run smoke`（78/78 PASS）
- [x] 老版本库（v2.0.0-beta.2 用户机）启动验证 builtin 重命名生效（用户 GUI 实测已通过）
- [ ] 用户样例文件 dry-run（PRD §13.1 P0-1 ~ P0-11）

---

## 关键决策

### 4 dialog factory（共 +1500 行）

- **D1 实施顺序**：C3（最简，4 行）→ C1（互斥，5 行 + 7 操作下拉）→ C2（最复杂，5 行 + 序号自动 + 类型联动）→ 确认详情（共享）
- **D2 跨弹窗状态**：`state.scenarioDraft` 单一来源；仅"返回"按钮保留；"完成"成功落库 / "取消" / 关闭 / 模块切换都清空
- **D3 view 模式**：编辑/查看/新建三模式共用 dialog factory，仅 disabled 视觉差异（用户能否分辨待 dry-run 反馈）
- **D4 多选下拉风格统一**：C1 筛选字段下拉沿用「维护大账号」模块的币种多选浮层（避免风格分裂）

### 8 项用户实测 UX 调整（reverse-sync）

按 GUI 实测反馈循环修改：

1. **场景类别命名**：`提取ReconId-From Self` / `账单打标` / `提取ReconId-From 网关`（用户原意 vs 内部分类一致化）
2. **3 个内置场景重命名**：从银行对账单的信息里提取对账ID / outbound改标为outbound Fail / 与网关对账单根据金额币种一对一匹配对账ID
3. **场景管理表布局**：6 列宽 5%/22%/30.94%/10%/19.06%/13%；序号列与"场景管理"标题左对齐；优先级/执行操作列向右移
4. **资金对账文件提示时机**：从"点开始运行才弹"挪到"导入银行单后立即弹"
5. **状态框文案**：「资金对账」→「不平账结果表」；命中场景以序号显示「（场景 1、3）」；导入双文件分行；已导入/已导出标签后内容换行
6. **去掉运行成功 + 导出成功 alert**：内容直接写状态框
7. **导出文件支持另存为**：原生 saveDialog 选保存路径
8. **导出命名规则**：`银行对账单-YYYYMMDDHHmm-处理结果.xlsx`（统一格式，不含场景名，分钟级时间戳）

附带删除：C1/C3 `overwrite-existing-*` warning（资金红线，已上文）。

---

## 改动文件

### 4 dialog + 接入

| 文件 | 改动 |
|---|---|
| `src/renderer-dialogs.js` | +1500 — 4 dialog factory + PR #30 占位 3 处接入（view-or-modify / 类别选择"继续" / 管理按钮）+ `SCENARIO_CATEGORY_LABELS` 重命名 |
| `src/renderer.js` | +400 — `state.bankStatementSession` / `gatewayReconSession` / `processingResult` / `bankStatementExport` / `scenarioDraft` 5 字段；`refreshBankStatementStatus` / `updateBankStatementUi`（5 状态 + skipC3 文案 + 命中场景序号）；4 按钮 binding；`maybePromptGatewayReconImport` 导入后立即弹 |
| `src/renderer-previews.js` | +200 — 4 张新 preview state（c1/c2/c3 配置 + 确认详情） |
| `src/preload.js` | +20 — Electron sandbox preload 内联常量（BANK_STATEMENT_FIELDS 44 + GATEWAY_RECON_FIELDS 31 + 虚拟字段）+ `appConstants` namespace |
| `index.html` | +30 — bankStatementModulePanel section + 4 按钮 + statusBox |

### 数据 / 算法 / IO（PR #32a 增量）

| 文件 | 改动 |
|---|---|
| `src/backend/database/migrations.js` | +30 — `ensureBuiltinScenarioNamesUpdate` 一次性迁移（builtin 场景名同步） + builtin seed 名称更新 |
| `src/backend/database.js` | +5 — facade 暴露同名方法 |
| `src/backend/database/scenarios-repository.js` | +20 — `calculateNextScenarioId`（gap-filling 最小未用 ID）+ `createScenario` 改用显式 INSERT |
| `src/main-process/scenario-dispatcher.js` | +10 — stats 加 `hitScenarioIds` 字段 |
| `src/main-process/bank-statement-io.js` | +30 / -40 — `buildTimestampMinute`（YYYYMMDDHHmm）；`buildMainOutputFileName` 改新规则（统一格式）；`writeBankStatementMainOutput` 签名 `exportRootDir` → `mainFilePath`（saveDialog 后用户选路径）|
| `src/main-process/scenario-engines/c1-extract-recon-id.js` | -10 — 删除 `overwrite-existing-recon-id` warning |
| `src/main-process/scenario-engines/c3-gateway-recon-join.js` | -10 — 删除 `overwrite-existing-value` warning |
| `src/main.js` | +30 — `bank-statement:export` handler 加 `dialog.showSaveDialog` |

### CSS 双风格

| 文件 | 改动 |
|---|---|
| `src/styles.css` | +250 — 场景配置弹窗 + 多选下拉浮层 + 表格列宽 + bank-statement-board 状态框 white-space pre-line |
| `src/styles-gemini-extra.css` | +250 — 同步 Clear 风格样式 |

### Smoke

| 文件 | 改动 |
|---|---|
| `scripts/smoke/scenario-end-to-end.js` | 新（约 240 行，23 用例）— E1/E2/E3/E4 全链路 |
| `scripts/smoke/scenarios-repository.js` | 新（5 用例）— `calculateNextScenarioId` gap-filling |
| `scripts/smoke/bank-statement-io.js` | W1/W2/F1 用例改新文件名规则 + writeBankStatementMainOutput 签名 |
| `scripts/smoke/scenario-engines.js` | C1-8/C3-4 反向断言：不应再有 overwrite warn |
| `scripts/smoke/scenario-dispatcher.js` | D1/D3/D5 加 hitScenarioIds 断言 |
| `scripts/smoke-test.js` | 接入 `runScenarioEndToEndSmokeTests` |

### 文档 + 配置

| 文件 | 改动 |
|---|---|
| `package.json` | version 2.0.0-beta.2 → 2.0.0-beta.3 + exceljs ^4.4.0 + 4 张新 preview script |
| `CHANGELOG.md` | 加 ## 2.0.0-beta.3 - 2026-04-29 完整段（4 PR 产物 + 8 项 UX + 资金红线高亮） |
| `docs/VERSION_FEATURE_HISTORY.md` | 加 ## 2.0.0-beta.3 段 |
| `docs/USER_GUIDE.md` | 加 1.4 银行对账单处理章节（工作流 + 5 状态 + 内置场景 + 资金红线） |
| `.gitignore` | 加 `银行对账单.xlsx` / `资金对账导出不平.xlsx` 用户样例文件 |
| `docs/previews/scenario-config-c1.png` 等 | 4 张新 preview |
| `changes/v2.0.0-beta3-pr32b-ui-docs-bump/` | spec 三件套 + 实施 log |

---

## smoke 结果

```
scenario-engines: 23/23 PASS
scenarios-repository: 5/5 PASS
scenario-dispatcher: 11/11 PASS
exceljs-writer: 3/3 PASS
bank-statement-io: 13/13 PASS
scenario-end-to-end: 23/23 PASS  ← 本 PR 新增
smoke test passed (78/78)
```

PR #32a 50 用例 + PR #32b 28 用例（5 repository + 23 E2E），加既有 v1.x 业务 smoke = 78 全 PASS。

---

## Test plan

- [x] `npm run smoke` 78/78 PASS
- [x] GUI 实测 8 轮 UX 调整循环（导入 / 运行 / 导出 / 状态框 / 命中场景显示 / saveDialog 等）
- [x] 用户样例文件 in-process dry-run（`scripts/dryrun-user-sample.js`）— 见下文 P0 矩阵
- [ ] `npm run preview:bank-statement-panel` / `:scenarios-manager` / `:scenario-config-c1/c2/c3` / `:scenario-confirm-detail` 重生成 4+2 张 png（已生成，本 PR 提交后截图入库）
- [ ] 老版本库（v2.0.0-beta.2 用户机）启动验证 `ensureBuiltinScenarioNamesUpdate` builtin 重命名生效（用户实测过）

### P0 用例矩阵（PRD §13.1）

样例：`Copy of 汇总测试.xlsx`（3625 行）+ `BBVA-调拨资金对账不平.xlsx`（25 行）

dry-run 结果：3625 行输入 → 58 行命中 → 35 modifications（23 C2 FundType 打标 + 12 C3 ReconciliationId 改写）→ 0 warning → 主输出 FundType 列 23 黄底 PASS。

| 用例 | 状态 | 来源 |
|---|---|---|
| P0-1 内置 C1 调拨自提取 | ❓ | 当前样例无 AFT/BFT 调拨行；smoke C1-1~C1-9 单测 9 用例覆盖算法 |
| P0-2 C1 多字段值不一致 → error-report | ❓ | 当前样例无该场景；smoke C1-5 单测覆盖（多字段不一致 → warn + 不写入）|
| P0-3 内置 C2 outbound Fail 打标 | ✅ | dry-run 23 modifications（FundType outbound → outbound Fail）|
| P0-4 C2 一对多 → error-report | ❓ | 当前样例无该场景；smoke C2-2 单测覆盖 |
| P0-5 默认 C3 关闭 | ⚠️ | GUI 行为，需用户在场景管理里确认 enabled=0 |
| P0-6 启用 C3 触发"导入资金对账"提示 | ⚠️ | GUI 行为，需用户启用 C3 后导入银行单确认 confirmDialog 弹出 |
| P0-7 C3 跳过（gwRows 未导入）| ✅ | smoke E3 自动（gwRows=null + C3 启用 → skippedC3Count=1）|
| P0-8 C3 join 命中 | ✅ | dry-run 12 modifications（ReconciliationId CIE-... → CFT260424...）|
| P0-9 first-match-wins | ✅ | smoke E2 自动（C1 优先级 3 > C3 优先级 1，同行只 C1 改）|
| P0-10 标黄 + 仅导修改行 | ✅ | dry-run 主输出 58 行 / 3625 行 + FundType 列 23 黄底验证 PASS |
| P0-11 空运行结果 → 不生成主输出 | ✅ | 空模板 dry-run 已验证（hitRowCount=0 → modifiedRows=[] → return status='empty'）|

7 项 ✅ + 2 项 ❓（样例无对应场景但 smoke 单测覆盖）+ 2 项 ⚠️ GUI 待用户确认。资金红线核心（C2 真打标 + C3 真改写 + 黄底正确性 + first-match-wins 不重锁）全部覆盖。

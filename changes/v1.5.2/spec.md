# Spec — v1.5.2

> status: propose（4 条 blocker 已拍板 2026-04-16；待进入 Dev 阶段）
> owner: PM + Dev
> created: 2026-04-16
> updated: 2026-04-16 Reverse Sync

## 1. 背景

- 为什么要做：
  - v1.5.1 引入主/子模板机制后，缺少对"子模板名 - 主模板名"从属关系的结构性校验，用户可能把子模板错挂到无关主模板下。
  - 大账号确认页目前是严格 1:1（一个文件/block 对应一个大账号），多文件共享同一大账号的场景必须重复勾选，效率低。
  - 用户有几十个模板时，导入每批文件都要手动切模板；需要"按文件名自动挑模板"的默认模式。
- 用户 / 业务价值：
  - 需求 1：在子模板入库前拦截错挂，避免 v1.5.1 的主/子模板匹配流程产生错误解析结果。
  - 需求 2：显著降低"同大账号多文件"场景的操作成本（N 次勾选 → 一次配对）。
  - 需求 3：大幅降低多模板场景的导入切换成本；把"选模板"的决策从用户手工改为"文件名 + 表头双校验"。
- 当前问题：参见 PRD §二 2.1。

## 2. 代码现状（必须有出处）

- 相关文件：
  - `src/renderer-dialogs.js:1835-2624` `createMappingDialog`（映射关系管理）
  - `src/renderer-dialogs.js:565-1147` `createBigAccountSelectionDialog`（大账号确认页）
  - `src/main.js:5898-5953` `file:import` IPC handler
  - `src/main.js:6633-6801` `file:complete-big-account-selection`
  - `src/main.js:857-880` `buildBigAccountSelectionRows`
  - `src/backend/database/template-repository.js:9-168`（listTemplates / setParentStatus / setChildParent）
  - `src/backend/database/migrations.js:282-289` `ensureParentTemplateSupport`
- 当前行为：
  - 映射关系管理「完成」按钮（`:2542`）直接调用 `saveMappings → setParentStatus / setChildParent`，**无**名称校验。
  - 大账号确认页强 1:1：`doneBtn` 要求 `checkedOrder.length === currentFileRows.length`（`:1106-1109`），后端 `complete-big-account-selection` 校验 `assignments.length === expectedRows.length`（`main.js:6658`）。
  - 导入入口 `file:import` 必须传合法 `templateId`，否则返回 `TEMPLATE_REQUIRED`（`main.js:5915-5921`）。
  - v1.5.1 主模板分支（`main.js:5976-6068`）用表头精确匹配子模板，`matchFileToTemplate` 在 `main.js:5273-5303`。
  - Bundle 版本 `SUPPORTED_BUNDLE_VERSION = 4`（`main.js:119`）。
- 已知限制：见 PRD §四表格"已知限制"列。
- 事实依据：以上所有文件路径 + 行号都在本仓 v1.5.x 分支（commit `6e5df3a` 基线）真实存在。

## 3. 目标

- 必做：
  - 需求 1：子模板入库前校验"子模板名包含主模板名字符串"（决策 D1），不通过则弹提醒不落库。
  - 需求 2：大账号确认页支持"单个账号匹多个文件"M:1 映射（决策 D2 / D3 / D4），完成后把分组展开为多条 assignments 发送给后端（后端协议不变）。
  - 需求 3：主页面下拉新增「按文件名映射模板」并设为默认（决策 D5）；在每个模板单元的映射关系管理中可配「文件名里的固定字段」（决策 D6，存在模板记录上）；导入时按该字段模糊匹配 + 表头校验（决策 D7，命中非唯一直接报错不 fallback，错误整批截断）。
- 可不做：
  - 主/子模板名校验的规范化（大小写、空格、全半角）。
  - "记住 M:1 映射"到数据库。
  - "文件名固定字段"的正则 / 通配符语法。
- 明确不做：
  - 超过 26 组（z 之后）的字母回卷。
  - v4 → v5 Bundle 升级（决策采用 v4 透明扩展）。
  - 任何产品源码改动（本 change 仅撰写文档）。

## 4. 功能点

### 功能点 1 — 主/子模板的模板名校验
- 说明：映射关系管理"完成"时，若勾了"设为子模板"且选中主模板，校验 `childName.includes(parentName)`。
- 输入：当前模板名、主模板下拉选中的主模板名。
- 输出：通过 → 正常落库；不通过 → 弹提醒「子模板与主模板模板名匹配不上，请检查。」，拦截落库。
- 边界：未勾子模板 or 未选主模板 → 不触发校验。
- 验收标准：PRD AC1-1 ~ AC1-4。

### 功能点 2 — 大账号确认页 M:1 映射（决策 ①B：block 粒度）
- 说明：「提取大账号顺序」按钮右侧新增"单个账号匹多个文件"勾选框 + 编辑/完成按钮；编辑态下左侧 **block 条目**的数字序号变勾选框、右侧大账号数字序号 `1.` 变字母 `a.b.c...`；左右互勾形成组；主完成时按 block 粒度展开为多条 assignments。
- 输入：用户在编辑态下的左右勾选操作（勾选单位 = block，非文件）。
- 输出：前端 `assignments` 展开后发给后端，每条 `{rowIndex, merchantId, currency}`；同组多 rowIndex 共享同一 MerchantId+Currency。**同文件多 block 可归不同组或不入组**（①B 核心）。
- 边界：取消勾选框清空所有组；与 fixed 模式的"记住顺序"互斥；字母序号每次"完成"后归零；同文件未被勾选的 block 保持原 MerchantId/Currency 不变。
- 验收标准：PRD AC2-1 ~ AC2-12（含新增 AC2-12 专门验证"同文件未勾选 block 保持原值"）。

### 功能点 3 — 主页面模板新增「按文件名映射模板」
- 说明：主页面下拉新增枚举值（默认）；映射关系管理新增「按文件名映射模板」模块；导入时按 `basename.includes(filenameFixedField)` 匹配 + 表头校验。
- 输入：用户在映射关系管理输入字段并点"完成"保存；主页面选「按文件名映射模板」+ 多选导入文件。
- 输出：
  - 唯一命中 + 表头通过 → 按该模板正常解析导出；
  - 唯一命中 + 表头不通过 / 0 命中 / 多命中 → 对应报错 + **整批截断**（所有文件不入库）。
- 边界：
  - 空串 `filename_fixed_field` 的模板**不参与**匹配；
  - 大小写敏感；
  - 按 `path.basename` 比对（不剥扩展名）；
  - 子模板独立持有字段，不继承主模板值。
- 验收标准：PRD AC3-1 ~ AC3-9。

## 5. 影响范围

- 前端 / 后端 / 脚本 / 配置 / 数据：
  - 前端：`src/renderer-dialogs.js`（映射关系管理 + 大账号确认页）、`src/renderer.js`（主页面下拉）、`src/styles.css`、`index.html`（可选）
  - 后端：`src/main.js`（file:import 分支、IPC 新增、buildBigAccountSelectionRows.fileIndex）、`src/preload.js`
  - 数据库：`src/backend/database/migrations.js`（新增迁移）、`template-repository.js`、`utils.js`、`database.js`
  - 配置：`package.json`（版本号）
  - 数据：`templates` 表新增 `filename_fixed_field` 列（默认 `""`）
- 对外接口影响：
  - IPC 新增：`template:save-filename-fixed-field`
  - IPC `file:import` 接收特殊值 `__FILENAME_MAPPING__` 走新分支（兼容旧调用）
  - IPC `file:complete-big-account-selection` 协议不变
  - Bundle v4 透明扩展 `filenameFixedField` 字段（向下兼容）
- 兼容性影响：
  - v4 bundle 可被 v1.5.1 正常导入（忽略未知字段）。
  - v1.5.1 → v1.5.2 升级：自动 migration 加列，旧模板字段 = `""`（不参与文件名匹配），旧行为完全保留。
  - v1.5.2 → v1.5.1 降级：SQLite 允许读旧列，不报错；新列被忽略。

## 6. 技术决策

- 方案：见 TechDoc §三 / §四 / §五。
- 为什么不用其他方案：
  - 需求 1 未选择"后端 `setChildParent` 加校验"——前端拦截可避免 mappings 已写成功、主/子关系写失败的不一致状态。
  - 需求 2 未选择"后端新协议表达 M:1"——展开成多条 assignments 复用现有 `applyBigAccountAssignmentsToFileEntries`，零后端改动。
  - 需求 3 未选择"集中的文件名映射配置表"——用户拍板决策 D6 要求"每个模板独立配"，不建集中表。
  - 需求 3 未选择"升级 Bundle v5"——保持 v4 透明扩展可向下兼容，避免破坏 v1.5.1 导入。
- 可能风险（2026-04-16 Reverse Sync 后更新）：
  - **风险提醒（资金/账务/数据迁移）**：需求 3 的 DB 迁移属于数据结构变更，新增列虽默认值为 `""` 低风险，但仍属于"数据迁移"范畴，**需人工复核**迁移脚本和 `saveTemplateFilenameFixedField` 的数据安全性。范围未变。
  - **需求 2 状态机改造（①B 决策后范围收窄）**：由"文件粒度 + fileIndex 联动勾选"简化为"block 粒度 + 单一 rowIndex key"，render 复杂度下降；但仍需 G2-0 前置 task 验证 `parentProvisionalEntries` 分支下 `matchedTemplateId` 不被 M:1 改写（决策 ②）。
  - **需求 3 整批截断的错误路径**：范围未变，仍需确保 `fileImportInProgress` 正确释放、session 零残留；由 G3-7 task 的验证点覆盖。
  - **虚拟 ID 扩散风险（决策 ④ 落地）**：`__FILENAME_MAPPING__` 是 UI-only 枚举，不对应真实 `templates` 记录；通过 G3-0 前置 task 统一加 `isFilenameMappingMode()` helper 并按清单覆盖所有调用点，避免"哪里报错哪里补 if"的散点修复。

## 7. 数据 / 状态 / 安全影响

- 数据结构：
  - `templates` 表新增 `filename_fixed_field TEXT NOT NULL DEFAULT ''`（需求 3）；需求 1、2 无数据变更。
- 状态流转：
  - 需求 2 新增**纯前端**状态机（multiMode × multiEditing × pendingGroup × multiGroups），其中 `multiGroups[i].leftBlockRowIndices:number[]` 存 block 粒度的 `rowIndex`（决策 ①B）；后端协议不变（按 block 粒度展开为多条 assignments）。
- 权限 / 安全：
  - 无鉴权 / 加密 / 敏感数据变更。
- 回滚策略：
  - 需求 1：回退前端 diff 即可。
  - 需求 2：回退前端 diff + `src/main.js:buildBigAccountSelectionRows` 的 `fileIndex` 字段回退即可。
  - 需求 3：SQLite 不支持 DROP COLUMN；回退版本后新列闲置不影响。Bundle v4 schema 透明扩展，前向兼容。

## 8. 待澄清问题（2026-04-16 拍板后更新 — 原 4 条 blocker 全部已决策）

- [x] 需求 2：单文件多 block 场景 M:1 语义 ✅ **已决策：①B — 只覆盖用户勾选的那个 block**；同文件其他未勾选 block 保持原值。PRD §6.2 / AC2-12 / TechDoc §4.1.2 ~ §4.1.3 同步。
- [x] 需求 3：Bundle 是否升级为 v5 ✅ **已决策：③A — 保持 v4 透明扩展**；已复核 `readTemplateBundleFile` 不做字段严格校验，v4 schema 增字段对 v1.5.1 透明。
- [x] 需求 2：与 v1.5.1 `parentProvisionalEntries`（主模板多文件）分支的兼容性 ✅ **已决策：②Dev 阶段前置排查** — tasks.md G2-0 task 验证 `matchedTemplateId` 不被 M:1 改写；如发现冲突停下来找 PM，不自作主张改方案。
- [x] 需求 3：虚拟 ID `__FILENAME_MAPPING__` 如何在所有按 ID 查表/IPC 调用点短路 ✅ **已决策：④Dev 前置 task** — tasks.md G3-0 task 统一加 `isFilenameMappingMode()` helper + 调用点清单（TechDoc §5.1.0 列出）集中处理。

### 非 blocker 的小问题（延后）

- [ ] 需求 2：M:1 编辑态下的"完成"按钮与对话框主"完成"按钮的文案/视觉区分（可在 Dev 实施过程中与 PM 对齐文案，不阻塞开发）。
- [ ] 需求 3：子模板命中文件名映射后，大账号选项是否继承其主模板的 bigAccounts（TechDoc §5.3 已建议复用 v1.5.1 `aggregatedBigAccounts` 聚合逻辑，Dev 在 G3-7 实现时如需调整再反馈）。

# Spec — v3.0.2 迭代（流水批量导入 + 模块改名 + 网关修复订单字段取值）

> 状态：**需求定稿，待实施**（4 项关键决策已确认，见下表）｜ 来源分支：`v3.0.1` → 新建 `v3.0.2` 开发分支 ｜ 目标版本：**3.0.2**
> 性质：🔴 含 2 处资金红线（需求1b 流水批量导入单事务合并 / 需求3 字段取值赋值）。
> 事实来源：已批准实施计划 `~/.claude/plans/3-0-2-1-op-3-0-1-immutable-flask.md`。
> **本 spec 为变更目录入口（简版）**，完整需求/AC/技术方案见：
> - 产品需求：`docs/iterations/v3.0.2/PRD-v3.0.2.md`（18 条 AC）
> - 技术设计：`docs/iterations/v3.0.2/TECH_DESIGN-v3.0.2.md`（含文件路径/函数名/行号、资金红线、测试方案）

---

## 一、本迭代 3 项需求

| # | 需求 | 一句话 | 性质 |
|---|------|--------|------|
| 1a | 回滚 v3.0.1 业务OP左列平移 | 删 `styles-gemini-extra.css:3373-3376` 的 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px); }` | 🟢 纯 CSS |
| 1b | 业务OP「导入流水表」批量多选导入 | 先选一个日期 → 多选多个流水表 → 单进程单事务合并到该日期 | 🔴 资金红线 |
| 2 | 「对账单 ReconID 修复」改名「对账单修复」 | 改 3 处 UI 字符串（模块名 + 2 个场景类别 label）去「ReconID」；内部 id/IPC/统计 key 不动 | 🟢 纯前端文案 |
| 3 | 网关对账单修复新增「修复订单字段取值」 | 「订单修复ID取值」改名「修复订单ID取值」+ 启用开关；新增「修复订单字段取值」（独立开关 + 多行规则）把从边渠道字段值赋给主边网关字段，叠加进订单修复导出 | 🔴 资金红线 |

---

## 二、已确认关键决策（实施计划已批准）

| 需求 | 决策 |
|------|------|
| 需求3 - ID取值/字段取值开关 | **两功能独立开关**（可同时启用）：`修复订单ID取值`（`output.idEnabled`）默认勾选保持现有必填，取消则跳过 Reference 赋值与校验；`修复订单字段取值`（`fieldValue.enabled`）是另一独立开关 |
| 需求3 - 字段取值输出 | **复用现有订单修复导出**：赋值叠加到 `fixedRows`，走「导出文件」+ 14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板（目标列落 14 列内才体现） |
| 需求1b - 批量导入日期 | **共享同一日期**：先选一个日期 → 多选文件 → 全部合并导入到该日期 |
| 需求2 - 改名范围 | **含场景类别 label**：模块显示名 + 用户可见 2 个类别 label；内部 id / IPC / usage-stats 统计 key 全部不动（沿用 v2.1.14 先例，零风险、统计连续） |

---

## 三、验收标准（共 18 条，详见 PRD §六）

- **需求1a**（1 条）：左列回到平移前位置；同段 `.gateway-recon-picker-card` / `.linked-table-delete-range-card` 不变。
- **需求1b**（6 条）：多文件合并行数累加（单次 clear、无丢失）；任一行失败整批 ROLLBACK + 聚合错误报告；单文件回归一致；状态「导入 N 个文件共 M 行」+「会替换该日期已有流水」；worker 与同步 fallback 同语义；`kind='bizOp'` 不变。
- **需求2**（4 条）：显示「对账单修复」「单据对账修复」「网关对账单修复」；usage-stats 计数连续；id/category/DB CHECK 不变。
- **需求3**（12 条）：改名 + idEnabled 开关默认勾选；取消勾选灰显 + Reference 取原值不报必填；fieldValue 开启校验；1v1/1v多/多v1 赋值正确；🔴 不污染原始行；🔴 seq 字符串经 `Number()` 归一命中；目标列超 14 列不体现不报错；两开关独立 + 分组过滤；旧场景兼容；`release-check` 全绿。

---

## 四、🔴 资金红线（实施 / 评审务必逐项复核，详见 TechDoc §六）

1. **需求1b**：流水批量导入**必须单进程单事务合并、单次 `clearByDate`**，禁止循环调用 `runFlowImport`（worker `import-worker.js:268` / 同步 fallback `biz-op-recon-session.js:491`）——否则文件互相覆盖丢数据。整批拒绝语义保持。
2. **需求3**：`applyFieldValueOverrides` 只写新建 overrides，**不污染** `mainRow`/`oppRow`（单测断言）；分组 seq **全程 Number**（类型不符 → `Set<Number>.has` 恒 false → 规则静默失效）；`idEnabled=false` → Reference **保留网关账单原值**（不清空）。

---

## 五、收尾约定

- **分支**：从 `v3.0.1` 或 `main` 切 `v3.0.2` 开发分支（No Spec No Code，spec 已落）。
- **顺序**：需求2（最简）→ 需求1 → 需求3（最复杂）；一 task 一 commit，commit 不加 AI 署名。
- **测试**：`npm run release-check`（unit + integration + smoke）全绿；前端改动重跑对应 `npm run preview:*`。
- **硬节点**：提 PR 前 / `package.json.version` bump 前必跑 `/check-vars` + `npm run scan:vars`（触及 fixedRows 输出 / Reference 取值 / 流水导入事务等重要变量）。
- **文档**：发版前统一更新三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）。
- **提 PR**：用户手动测试通过、明确说「提 PR」后才提。

---

## 六、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-10 | 初稿：依据已批准实施计划收口 3 项需求为 v3.0.2 变更入口；4 项关键决策已确认；指向 PRD（18 AC）+ TechDoc |

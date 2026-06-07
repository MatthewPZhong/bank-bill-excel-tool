# v2.1.15 迭代 PRD（索引 / 导读）

> 状态：已发布 stable `2.1.15`（2026-06-07）｜分支：`v2.1.15`（PR #60 → main）
> 本版本需求规格以 [`spec.md`](./spec.md)（迭代 Spec 总纲）承载；本文件为**统一入口（索引）**，对齐项目 `PRD-<版本>.md` 命名惯例，补齐归档结构。

---

## 一、范围总览（源：`spec.md`）

| 编号 | 内容 | 风险 | 关键文件 |
|---|---|---|---|
| W0 | 收单写差异文件提速（OFFSET 深分页 → 游标遍历）| 🔴 资金红线 | `run-repository.js`、`acquiring-bill-currency-writer.js`、`scripts/perf/` |
| W1 | C3「网关账单字段」枚举改读 `assets/网关对账单.xlsx` 表头 | 🔴 资金红线 + 破坏性 | `gateway-recon-headers-loader.js`(新)、`main.js`、`preload.js`、`renderer-dialogs.js`、`gateway-recon-fields.js` |
| W2 | C3 匹配成功后把差额写入银行行 `Extra Fee` 并标黄 | 🔴 资金红线 | `c3-gateway-recon-join.js`、`c3-gateway-recon-join.test.js` |
| W3 | 「场景管理」弹窗内加「网关对账单修复-管理」入口 | 低 | `renderer-dialogs.js` |
| W4 | 去掉调色盘「切换页面风格」+ 弃用 General 风格 | 低-中 | `index.html`、`renderer.js`、`preload.js`、`main.js`、`settings-repository.js`、`database.js` |

> 实施编排（按文件冲突）：W0/W2/W4 可并行（独立文件域）；W1 改 `main.js`/`preload.js` 与 W4 冲突 → W4 后；W3 改 `renderer-dialogs.js` 与 W1 冲突 → W1 后。

---

## 二、完整规格与验证

详见 [`spec.md`](./spec.md)：

- §2–6 各 W 详细设计
- §7 验证总览
- §8 风险（**W0/W1/W2 = 🔴 资金红线**，实施后提 PR 前必须跑 `/check-vars`）
- §9 实施记录（含 self-review 补强 W1·Important）

---

## 三、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-07 | 补建索引 PRD，统一归档结构。原始需求规格见 `spec.md`，本文件不改写其内容 |

# Spec — ADM 派生结果弹框过高、按钮被挤出视口

> 状态：**已实施（v3.0.0 PR-5 方案A）** ｜ 来源分支：`v2.1.16-beta.6` ｜ 目标版本：v3.0.0
> 性质：纯前端 UX / 弹框布局，不碰资金对账计算
> 缘起：导入「渠道账单_2026-05-20_568603-用例.xlsx」后弹出 ADM 派生「部分行未匹配」结果框，列了 57 行未匹配明细，弹框过高把底部「确认」按钮挤出可视区、看不到也点不到

---

## 一、问题

ADM 派生「部分成功未匹配」弹框（`buildAdmDeriveHtml`，`renderer-dialogs.js:6309`）把未匹配明细**逐行平铺**进 `createAlertDialog` 的消息体，最多渲染 50 行、每行约 2 视觉行（批次号/CustomerRef/BillDate/ChannelOrderNo + 错误码说明）。当未匹配行多（本例 57 行 → 显示前 50 行 ≈ 100+ 视觉行）时，弹框卡片高度远超视口，导致**底部「确认」按钮被挤出可视区、不可见不可点**，弹框无法关闭。

---

## 二、调查结论（实证）

| 环节 | 事实 | 出处 |
|------|------|------|
| 内容生成 | `unmatched.slice(0, 50)`，每条拼成 2 视觉行（`• 批次号 … ｜ …<br/>　　→ 错误码`） | `renderer-dialogs.js:6330` / `:6337-6339` |
| 显示上限 | `ADM_UNMATCHED_DISPLAY_LIMIT = 50`（超出仅加「仅显示前 50 行」注脚，**不限高**） | `renderer-dialogs.js:6305` / `:6341` |
| 弹框骨架 | `createAlertDialog`：`.alert-card > (.alert-body > .alert-icon + .alert-message) + .dialog-actions.center > 确认按钮`；**卡片无任何高度约束** | `renderer-dialogs.js:322-332` |
| 卡片 CSS | `.alert-card` 仅 `width: min(100%,420px)` + padding，**无 `max-height`、无 `overflow`、非 flex column** | `styles.css:1380` |
| 容器 CSS | `.modal-card` 同样**无 `max-height` / `overflow`** | `styles.css:863` |
| 居中行为 | `.modal-overlay` 为 `position:fixed; display:flex; align-items:center`（垂直居中）+ `padding:28px`，**自身不滚动** → 卡片超高时上下双向溢出视口、两端被裁切 | `styles.css:853-861` |
| 消息体 CSS | `.alert-message` 无 `max-height`/`overflow`；`.alert-body` 为 `display:contents`（图标与消息直接成为卡片 flow 子项） | `styles.css:1642` / `:2672` |
| 按钮 CSS | `.dialog-actions` 无 `flex-shrink:0`（当前非 flex 子项语境，但结构改造时需注意） | `styles.css:1649` |

**根因一句话**：消息体不限高 + 卡片不限高 + overlay 垂直居中不滚动 ⇒ 超高内容把按钮推出视口。

---

## 三、改造方案（二选一，需用户定）

### 方案 A — 结构性 CSS（通用，根治所有过高 alert 弹框）✅ 倾向
让告警卡片成为「头(图标) + 可滚动消息 + 固定按钮」的有界 flex 列：

```css
.alert-card {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 56px);     /* overlay 上下各 28px padding */
}
.alert-message {
  overflow-y: auto;
  min-height: 0;                       /* flex 子项可收缩、内部滚动的关键 */
}
.dialog-actions { flex-shrink: 0; }    /* 按钮永不被压缩/挤出 */
```
> 注：`.alert-body { display:contents }` 使图标/消息成为 `.alert-card` 的直接 flex 子项，上述规则可直接生效。

- **优点**：一次修复**所有**可能超高的告警/确认弹框（导入明细汇总 `buildImportSummaryHtml`、错误报告等同样走 `createAlertDialog`）。
- **影响面（blast radius）**：所有 `.alert-card` 弹框（`createAlertDialog` / `createConfirmDialog` / 导出范围框等）。需回归这些弹框在「短内容」时不被异常拉伸/留白。

### 方案 B — 定向（仅 ADM 弹框，低风险）
在 `buildAdmDeriveHtml` 把未匹配列表包进有界滚动容器，并下调显示上限：

```js
// items 外层包一层
`<div style="max-height:40vh; overflow-y:auto; text-align:left; ...">${items}</div>`
// 并 ADM_UNMATCHED_DISPLAY_LIMIT 50 → 20（或保留 50，靠容器滚动）
```
- **优点**：只动 ADM 一处，零影响其他弹框。
- **缺点**：治标；其他走 `createAlertDialog` 的长内容弹框仍可能超高。

### 推荐
倾向 **A**（结构性根治），因为 `createAlertDialog` 是全局共用弹框、其他长内容场景同样有溢出隐患；A 实施后 B 的截断/滚动可作为锦上添花（仍建议保留「仅显示前 N 行」注脚避免一次塞太多 DOM）。若优先最小风险、只解燃眉，则选 **B**。

---

## 四、验证计划

| 项 | 方法 |
|----|------|
| 复现 | 用本 spec 用例文件导入 → ADM「部分未匹配」框 → 确认按钮当前不可见 |
| 修复后 | 同场景下消息区内部滚动、「确认」按钮始终可见可点 |
| 回归（方案 A） | 短内容 alert / confirm / 导出范围框布局不变形；`npm run preview` 相关入口重渲染比对 |
| 跨视口 | 小窗口高度（如 700px）下按钮仍在视口内 |

---

## 五、风险提示

- 纯前端 UX，不碰资金对账计算逻辑 → 资金红线 ✅ 不涉及。
- 方案 A 改的是**全局共用弹框 CSS**，影响面广：按项目约定，改前端文件提 PR 前必须重跑对应 `npm run preview`（见 memory `workflow_frontend_previews`）。
- `renderer-dialogs.js` 属重要骨架文件，改后对照 `rules/important-variables.md` 跑 `/check-vars`。

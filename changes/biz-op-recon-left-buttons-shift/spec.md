# Spec — 业务OP数据核对模块「BU 下拉 + 导出差异按钮」整体右移

> 状态：**已实施（v3.0.1）→ v3.0.2 已回滚** ｜ 来源分支：`v3.0.0` ｜ 目标版本：**3.0.1**（2026-06-09 收口进 v3.0.1 迭代，见 `docs/iterations/v3.0.1/PRD-v3.0.1.md` 需求2）
> ✅ 回写 2026-06-15：原「待落源码」状态行已 stale。v3.0.1 commit 4294c20 落 `translateX(85.5px)`，后于 v3.0.2 commit 4ce4a58 刻意回滚（需求1a，CHANGELOG 3.0.2）；当前工作树已无该规则。
> 性质：🟢 纯 UI 布局微调（无业务逻辑 / 无资金数据 / 无状态机）。
> 缘起：用户 2026-06-09 要求把业务OP数据核对模块左列两个元素往右平移，靠近右列。效果图（`~/Desktop/业务OP核对-按钮右移-效果图.html`）已确认距离。

---

## 〇、需求（用户 2026-06-09 拍板）

把业务OP数据核对模块**左列的两个元素**（行1 的 BU 下拉、行2 的导出差异按钮）**整体向右平移**：

> **平移量 = D/2 + 12px**，其中 **D = 「导出差异按钮右缘 ↔ 状态框左缘」的间距**。

- 右列（导入文件 / 开始运行 / 状态框）**不动**。
- 经效果图 toggle 对比 + 参考线确认（导出差异右缘落在「两虚线正中再向右 12px」处）。

---

## 一、现状（代码事实，带出处）

### 1.1 DOM 结构（`index.html:185-214`）

```
#bizOpReconModulePanel.control-board.module-panel.pending-board
  .control-row（行1）
    .cell.left  → #bizOpReconBuRow（BU 下拉，.biz-op-recon-bu-row）
    .cell.right → .pending-action-pair[导入文件 | 开始运行]
  .control-row（行2）
    .cell.left  → #bizOpReconExportBtn（导出差异，.secondary-btn）
    .cell.right → #bizOpReconStatusBox（状态框，.status-box）
```

### 1.2 布局（真实生效的是 `styles-gemini.css` + `styles-gemini-extra.css`，**不是** `styles.css`）

- `.pending-board .control-row { grid-template-columns: 1fr 1.4fr; }`（`styles-gemini-extra.css:935`）—— 两列 grid。
- `.pending-board .cell.left { display:flex; justify-content:center; }`（`:937`）—— 左列内容**居中**（当前 BU 下拉 / 导出差异按钮就居中在左列轨道内）。
- `.pending-board .cell.right { display:flex; justify-content:center; }`（`:939`）。
- `.pending-board .cell.left .secondary-btn { min-width:180px; }`（`:941`）—— 导出差异按钮 180px。
- BU 行特殊（`styles-gemini-extra.css:3039-3058`）：`position:relative`，label「BU」用 `position:absolute; right:100%` 浮在容器左外侧。

### 1.3 容器宽度 → **D 是定值**（关键，决定可写死 px）

- `.workspace-shell { max-width: 960px }`（`styles-gemini.css:136`）。
- app 主窗口 `width:1240, minWidth:1080`（`main.js:2843-2846`）。
- ∵ **960 < 1080（minWidth）** ∴ 任何合法窗口尺寸下 workspace-shell 内容区**恒为 960px** → panel grid 列宽恒定 → **D 恒定**。
- ⇒ 落地用**固定 translateX px** 完全精确，无需运行时计算 / 自适应。

---

## 二、改动方案

仅在 `src/styles-gemini-extra.css` **追加一条专属规则**（用 `#bizOpReconModulePanel` ID 圈定）：

```css
/* 业务OP数据核对：左列（BU 下拉 + 导出差异）整体右移 = D/2 + 12px */
#bizOpReconModulePanel .cell.left > * {
  transform: translateX(<SHIFT>px);  /* <SHIFT> = D/2 + 12，实施时 preview 实测确定，见 §三 */
}
```

- `transform: translateX` 不改变 grid 轨道布局，**不挤压右列**（右列纹丝不动）。
- BU 行整体平移，其 absolute label「BU」跟随右移，相对位置不变（效果图已验证）。
- bizOpRecon **不是** `layout-mirrored`（`index.html:185` 无该 class），LTR 正常，左列在左。

---

## 三、落地 px 值的确定方式

D 恒定但其精确值由多层 CSS 叠加（grid 列宽 + `.control-row` gap + status-box 宽度），手算不可靠。**实施时**：
1. `npm run preview:biz-op-recon-panel-initial` 渲染真实 panel；
2. 用与效果图相同的测量法（`exportBtn.right` → `statusBox.left`）读出 D；
3. `<SHIFT> = D/2 + 12`，写入上面规则；
4. 重跑 preview 复核导出差异按钮右缘落在目标位置。

> 效果图（桌面 HTML）顶部实时显示当前 D 与 D/2+12 的 px，可直接读取参考。

---

## 四、关键风险（必须遵守）

| # | 风险 | 处置 |
|---|------|------|
| **R-1** | 🔴 `.pending-board` 布局被 **4 个模块共用**（`#pendingModulePanel` / `#bizOpReconModulePanel` / `#bankBuReconModulePanel` / `#vccOpCalcModulePanel`，`index.html:156/185/220/246`） | **必须**用 `#bizOpReconModulePanel` 专属选择器；**严禁**改 `.pending-board .cell.left` 等公共规则，否则另外 3 个模块跟着移位 |
| R-2 | 改前端必须回归 preview | 落地后跑 `npm run preview:biz-op-recon`（4 状态）对照（项目约定 workflow_frontend_previews） |

---

## 五、OPEN

| # | 问题 | 建议 |
|---|------|------|
| **OPEN-1** | ✅ **已定：3.0.1**（2026-06-09 与链接表需求、场景框样式、ADM 文案一起收口进 v3.0.1 迭代）。 | — |

---

## 六、验证

- `npm run preview:biz-op-recon` 渲染 4 状态，确认左列右移、右列不动、其余 3 个 pending-board 模块（pending / bank-bu-recon / vcc-op-calc）**无变化**。
- 人工复核 BU label 跟随、按钮无溢出/截断。

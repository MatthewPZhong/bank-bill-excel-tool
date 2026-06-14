# Spec — 网关对账单修复「场景选择弹框」样式修复

> 状态：**已实施（v3.0.1，已发版）** ｜ 来源分支：`v3.0.0` ｜ 目标版本：**3.0.1**（2026-06-09 收口进 v3.0.1 迭代，见 `docs/iterations/v3.0.1/PRD-v3.0.1.md` 需求3）
> ✅ 回写 2026-06-15：原「待落源码」状态行已 stale。实证落地 `src/renderer-dialogs.js:10670`（`gateway-recon-picker-card`）+ `src/styles-gemini-extra.css:3417-3426` + CHANGELOG v3.0.1 需求3。
> 性质：🟢 纯 UI 样式修复（无逻辑改动）。
> 缘起：用户 2026-06-09 反馈该弹框「样式错乱、标题字体大、文本贴框」，效果图（`~/Desktop/网关场景选择框-样式修复-效果图.html`）已确认。

---

## 〇、需求

修复 `createGatewayReconScenarioPickerDialog`（网关子模式 ≥2 个已启用场景时运行弹出的单选框）的视觉问题：
1. 标题字号过大；2. 文本/选项贴边（无内边距）；3. 整体排版错乱。

---

## 一、现状根因（代码事实，带出处）

弹框 DOM：`src/renderer-dialogs.js:10155-10163`。**混用两套弹框范式 + 漏了 `.alert-body` 包裹层**：

| 症状 | 根因 | 出处 |
|---|---|---|
| 标题字体大 | 用 `.dialog-title` = **22px**（为 940px 宽框设计），塞进 420px 窄 `alert-card` | `styles-gemini-extra.css:40-42`（22px）/ `:31`（alert-card 420px）|
| 文本贴框 | `.alert-message` 自身无左右 padding，正常靠 `.alert-body{padding:28px}` 包裹；此弹框**漏了 `.alert-body`** | `:861-866`（message 无 padding）/ `:850-852`（alert-body padding）|
| 样式错乱 | 同时混用 dialog 范式（`dialog-header` 带 border-bottom + 22px 标题）+ alert 范式（`alert-message`）+ 裸 `<div>` 列表 | DOM `:10155-10163` |

对比正确的 `createAlertDialog`（`renderer-dialogs.js:322-328`）：用 `alert-card > alert-body（提供 padding）> alert-message`，**无** `dialog-header/dialog-title`。

---

## 二、修复方案（对齐项目窄弹框范式）

参照 `pending-reconcile-card` / `pending-import-month-card`（`styles-gemini-extra.css:1231-1265`）——它们都有「专属 card class + 专属 CSS（dialog-title 改小 15px、header 去 border-bottom、内容容器加左右 padding）」。

### 改动 1：DOM（`src/renderer-dialogs.js:10145-10163`）
- `dialog.className`：`'modal-card alert-card'` → `'modal-card gateway-recon-picker-card'`
- 结构改为：`dialog-header > dialog-title` ＋ `gateway-recon-picker-body >（hint + list>items）` ＋ `dialog-actions`
- 单选项 `<label>` 去掉 inline style，改用 `.gateway-recon-picker-item` class
- 逻辑（escapeHtml / radioName / onPick / 取消确认事件）**完全不动**

### 改动 2：CSS（`src/styles-gemini-extra.css` 追加，即效果图里 ★ 那段）
```css
.gateway-recon-picker-card{width:min(100%,460px)}
.gateway-recon-picker-card .dialog-header{padding:22px 28px 6px;border-bottom:none}
.gateway-recon-picker-card .dialog-title{font-size:16px;font-weight:600;letter-spacing:0}
.gateway-recon-picker-body{padding:4px 28px 4px}
.gateway-recon-picker-hint{font-size:14px;color:var(--muted);text-align:left;margin-bottom:10px}
.gateway-recon-picker-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}
.gateway-recon-picker-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;cursor:pointer;font-size:14px;color:var(--text)}
.gateway-recon-picker-item:hover{background:var(--bg-soft)}
.gateway-recon-picker-item input{accent-color:var(--primary)}
.gateway-recon-picker-card .dialog-actions{border-top:none;background:transparent;padding:8px 28px 22px;gap:10px}
```

---

## 三、风险

🟢 **低**：专属 `gateway-recon-picker-card` class，不影响其它弹框；不碰 `alert-card`/`dialog-*` 公共规则（仅以专属 class 限定覆盖）。逻辑零改动。

---

## 四、验证

- 该弹框**疑无独立 preview 入口**（`package.json` preview 脚本里未见，需实施时确认；若无，考虑补一个 `preview:gateway-recon-scenario-picker` fixture）。
- 手动触发路径：网关子模式 → 启用 ≥2 个 `gateway-recon-id-fix` 场景 → 导入不平表 → 开始运行 → 弹框。
- 效果图 `~/Desktop/网关场景选择框-样式修复-效果图.html` 已确认。

---

## 五、OPEN

| # | 问题 | 建议 |
|---|------|------|
| OPEN-1 | ✅ **已定：3.0.1**（2026-06-09 与业务OP按钮右移等一起收口进 v3.0.1 迭代）。 | — |

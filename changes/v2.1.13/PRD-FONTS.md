# v2.1.13 增量需求：字体规范（Fonts）

> 状态：草稿（决策已确认，待实现）
> 并入 v2.1.13 迭代（2026-06-06 用户追加）
> 配套主 PRD：`PRD.md`

## 一、已确认决策（用户拍板 2026-06-06）

| # | 决策点 | 选择 |
|---|---|---|
| F-D1 | Noto Sans SC 字体来源 | **打包字体文件**（@font-face，随应用打包，保证 Win 端真生效）|
| F-D2 | 作用域：平台 + 主题 | **仅 Windows + 仅默认 Clear 主题**（需运行时判断 platform）|
| F-D3 | 下拉框英文 vs 全局 Noto 叠加 | **Courier 优先、中文走 Noto**（`font-family: "Courier New","Noto Sans SC",…`）|
| F-D4 | 版本归属 | **并入 v2.1.13** |

## 二、需求清单

### E1. 所有下拉框英文字体 → Courier New
- 范围：**所有模块所有下拉框**。
  - 原生 `<select>`：`.template-select` / `.mapping-select` / `.big-account-mode-select` / `.monthly-balance-*-select` / `.big-account-selection-account-select` 等（renderer-dialogs.js 内 75 处、renderer.js 2 处、index.html 5 处）。
  - 自定义浮动下拉：`.new-account-currency-*`、`.builtin-fixed-channel-floating-panel`（v2.1.13 T7 已窄实现一处）。
- 字体链：`font-family: "Courier New", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`（英文/数字等宽，中文 fallback）。
- **平台**：E1 不限平台（Courier New 是 Win/Mac 系统自带，无需打包）。中文 fallback 链含 Noto（Win 打包后生效）。

### E2. Win 端所有字体 → Noto Sans SC
- **仅 Windows 生效**：渲染层无法直接拿 platform，需 preload 暴露 → renderer 注入 `document.body.dataset.platform` → CSS 以 `body[data-platform="win32"]` 限定。
- **仅默认 Clear 主题**：改 `styles-gemini.css` / `styles-gemini-extra.css`；不改 `styles.css`（General 主题保持原样）。
- **打包字体**：Noto Sans SC（思源黑体，SIL OFL 1.1，可商用打包）woff2 放 `assets/fonts/`，`@font-face` 引入；`assets/**/*` 已在 electron-builder `build.files` → 自动打包。

### 等宽口径（⚠️ spec 假设，待用户确认）
"所有字体置换为 Noto" 与项目现有等宽场景（金额/数字列用 `Roboto Mono`、版本号用 `Courier New`、下拉框英文 E1 用 `Courier New`）存在张力。本 spec 采口径：
- **正文/标题/标签等比例字体** → Noto Sans SC（Win）。
- **明确等宽语义场景**（金额数字列 Roboto Mono、版本号、E1 下拉框英文）→ **保留等宽字体**，中文 fallback 接 Noto。
- 理由：把数字列换成比例字体会破坏对齐，违背等宽初衷。若用户要"连数字也强制 Noto"，需显式推翻本口径。

## 三、技术方案

| 步骤 | 落点 |
|---|---|
| 字体文件 | `assets/fonts/NotoSansSC-*.woff2`（来源见 §四风险）+ `@font-face`（建议独立 `src/fonts.css` 或并入 gemini CSS 顶部）|
| platform 暴露 | `src/preload.js` 暴露 `platform: process.platform`（contextBridge）|
| platform 注入 | `src/renderer.js` 启动时 `document.body.dataset.platform = desktopApi.platform`（与 3309/3314 dataset.style 同处）|
| 全局 Noto（Win+Clear）| `styles-gemini.css` body 规则加 `body[data-platform="win32"] { font-family: "Noto Sans SC", … }`（不破坏等宽口径）|
| 下拉 Courier（E1）| gemini CSS 统一 `select / .template-select / .mapping-select / 浮动下拉` 字体链 = Courier→Noto→fallback |
| 打包验证 | electron-builder 打包后确认 woff2 进包；`build.files` 已含 `assets/**/*` |

## 四、风险 / 已知障碍（人工复核）

1. **⚠️ 字体文件获取（最大障碍）**：agent 无法凭空生成 Noto Sans SC woff2 二进制（全字集 woff2 ~8-10MB）。备选：
   - (a) `npm i @fontsource/noto-sans-sc` → 拿到按 unicode-range 分片的 woff2，复制 subset 到 `assets/fonts/`；
   - (b) 下载单文件全字集 woff2（jsDelivr / Google Fonts）放 `assets/fonts/`；
   - (c) 用户提供字体文件。
   → 实现首步须先验证可行性，拿不到则 E2 阻塞。
2. **安装包体积**：Noto Sans SC 中文字集大，安装包将增大数 MB（subset 可压缩，但覆盖字符受限）。
3. **平台判断链路**：preload 暴露 platform 属 IPC/接口边界改动 → 命中 `important-variables` 需走 `/check-vars`。
4. **等宽口径**：见 §二，待确认。
5. **主题切换**：仅 Clear 主题改；用户切到 General 主题时字体不变（符合 F-D2）。

## 五、验收标准

1. 默认 Clear 主题下，Windows 端正文字体为 Noto Sans SC（打包字体生效，非 fallback）。
2. mac / 非 Win 端不受 E2 影响（仍原字体）；General 主题不受影响。
3. 所有模块所有下拉框英文/数字为 Courier New，中文正常显示（全平台）。
4. 等宽数字列（金额）仍等宽对齐。
5. `npm run release-check` 全绿；相关 `npm run preview:*` 回归；打包产物含字体文件。

## 六、任务拆分（增量）

| ID | 任务 | 依赖 | 状态 |
|---|---|---|---|
| **TF1** | 字体文件获取 + `@font-face` + 打包验证 | — | ✅ 完成（fontsource subset 6 woff2 ~3.5MB，wOF2 校验通过；`src/fonts.css`；`assets/**/*` 已在 build.files）|
| **TF2** | preload 暴露 platform + renderer 注入 body[data-platform] | — | ✅ 完成（preload.js `platform: process.platform` + renderer.js initialize 注入）|
| **TF3** | E2：Clear 主题 body Noto（`body[data-platform="win32"]`，仅 Clear）| TF1,TF2 | ✅ 代码完成（mac 不可视，**Win 端可视待手动测**）|
| **TF4** | E1：所有下拉框 Courier→Noto 字体链（全平台）| TF1 | ✅ 完成 + **可视验证**（币种下拉 preview：USD/CNY 等英文已 Courier 等宽）|
| **TF5** | 收尾：preview 回归 + check-vars（preload）+ release-check | TF1-4 | 🔶 部分（release-check exit 0✅；主界面+币种 preview✅；完整 preview/文档/bump 并入总收尾）|

## 七、进度日志

- 2026-06-06：落字体 spec（4 决策已确认）→ 趟通字体获取（fontsource chinese-simplified 1.1MB subset）→ 实现 TF1-TF4。
  - 改动：`assets/fonts/`（6 woff2）+ `src/fonts.css`（新）+ `index.html`（引入）+ `src/preload.js`（platform）+ `src/renderer.js`（注入 dataset.platform）+ `src/styles-gemini-extra.css`（E1+E2）。
  - 验证：JS 语法 OK；字体文件 wOF2 校验；主界面 preview 无破坏；**E1 币种下拉 Courier 可视确认**；release-check exit 0。
  - ⚠️ 关联：命中 `ipcRenderer`（preload）Important 层 — 已同步「preload 暴露 platform + renderer 读取」；总收尾走完整 `/check-vars`。
  - 待办：E2 Win 端可视手动测；TF5 并入 v2.1.13 总收尾（T10）。
- 2026-06-06（需求第 3 次精炼 → 统一策略）：用户重定义为「所有页面英文/数字 Courier New、仅中文 Noto Sans SC」。
  - **决策**：平台=仍仅 Windows（延续 F-D2）；彻底度=除大标题(page-title/dialog-title)外全部纳入（含原 Roboto Mono 标识符）。
  - **实现演进**：把分散的 E1(全平台下拉 Courier)+E2(Win 正文 Noto) **重构为一条 win32 全局规则** —— `body[data-platform="win32"] *` 字符级 fallback（英文数字 Courier + 中文 Noto），`:not` 思路改为 `* 覆盖 + .eo-idx 高特异性补足 + 大标题及子元素恢复 Google Sans`。E1 由全平台收敛为 win32-only（mac 恢复原字体）。
  - **验证**：独立 win32 模拟页 Electron 截图，6 验证点全过（大标题保留比例字体 / 正文中英分流 / 下拉 Courier / 原 Roboto Mono 归 Courier / 数字等宽对齐）；mac preview 确认隔离（不受影响）；release-check exit 0。
  - 改动收敛为：`index.html` + `src/fonts.css` + `src/preload.js` + `src/renderer.js` + `src/styles-gemini-extra.css` + `assets/fonts/`（6 woff2）。

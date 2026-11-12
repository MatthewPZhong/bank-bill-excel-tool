# TechDoc — v3.2.17 外观设置：深色模式深浅度调节

> 目标版本：v3.2.17
> 适用分支：`feat/appearance-dark-lightness`（基线 `v3.2.16` → `8e027cb8`）
> 需求：同目录 `spec.md`
> 格式参考：`changes/v3.2.9/codex/v3.2.9-night-mode/techdoc.md`

## 配色机制

- `styles-dark-mode.css` 的 `:root[data-theme="dark"]` 不变，即深浅度 0。其他样式表没有 `data-theme` 选择器，组件只消费变量，所以改变变量即可覆盖全部页面与弹窗。
- `src/shared/dark-mode-schedule.js` 新增以下内容，Node 与浏览器共用：
  - `DARK_MODE_LIGHTNESS_PALETTE`：变量 → [最深, 最浅, 透明度]
  - `resolveDarkModePalette(level)`：sRGB 逐通道线性插值并取整，输出 hex 或 `rgba()`
  - `resolveDarkBackgroundColor`
  - `validate / normalizeDarkModeLightness`
- 调整的变量：底色、面板、输入、线条、header、行悬停、标签、`primary-soft` 及三种状态的 soft/border，加上 `--muted`、`--dim`（随底色提亮保持对比度）。`--text`、`--primary`、状态文字等不变。
- `renderer-dark-mode.js` 的 `paint(document, theme, lightness)` 只在深色且深浅度大于 0 时，把调色结果写成 `documentElement` 内联变量；浅色或 0 时逐项移除，因此默认外观与 v3.2.16 字节级一致。
- 插值在 JS 中完成，没有用 CSS `color-mix()`。原因是后者的计算值会序列化为 `color(srgb …)`，与现有按 `rgb()` 断言的脚本不兼容。
- `renderer.js` 中深色主背景原来写死 `#111419`，改为 `var(--bg)`，跟随深浅度变化。

## 持久化与 Main

- `app_settings.dark_mode_lightness` 以整数字符串保存。读取只接受 1–3 位数字且在 0–100 内，其他值回退为 0，不改写原记录。写入严格校验。与 `dark_mode_schedule` 互不影响，无迁移。
- `dark-mode-scheduler.js`：
  - 新增依赖 `readLightness / writeLightness`；快照新增 `darkModeLightness`。
  - 深浅度变化同样递增 `themeRevision`，并经现有 `settings:dark-mode-schedule-changed` 广播。
  - `setLightness` 先校验、写库，成功后才应用；失败不改快照、主题和窗口底色。
  - 原生窗口底色由 `resolveWindowBackgroundColor(theme, lightness)` 计算。
- `main.js` 新增 IPC `settings:set-dark-mode-lightness`，返回 `{status:'ok', ...snapshot}` 或 `{status:'failed', message}`。该 IPC 以 `ui-navigation` 登记到 `legacy-task-policies.js` 和 `task-policy-registry.js`。

## 首屏

- 窗口在 ready-to-show 首帧显示，此时 `app:get-info` 还没有返回。
- `createWindow` 以 `webPreferences.additionalArguments: ['--dark-mode-lightness=N']` 传入已保存值，同时用它计算 `backgroundColor`。
- Preload 在 sandbox 下解析 `process.argv`（只接受 0–100 整数），暴露 `settings.initialDarkModeLightness`。head 同步脚本在 CSS 前按该值绘制首帧。
- 已知限制：argv 在建窗时固定。保存后若同一窗口重载页面，首帧先用建窗时的值，随后由 `app:get-info` 校正。生产界面没有重载入口。

## 调节页

- `mountSettings(host, controller, { openLayer })` 在时间框之后、fieldset 之内渲染「深浅度调节」【调节】。未加载完成时随 fieldset 禁用；没有 `openLayer` 或保存中时禁用。
- `createLightnessAdjuster` 返回 modal-bridge 的 `{ overlay, dialog, dismiss, initialFocus, canClose, onMount }`，由 `app-settings.js` 经 `modalBridge.pushModal(设置句柄, layer)` 压栈，仅在设置为栈顶时打开。
- 隐藏父层：CSS `#modalRoot:has(> .dark-lightness-overlay) > :not(.dark-lightness-overlay) { visibility: hidden }`，不直接操作 modalRoot。父层由宿主标记 inert。
- 主界面交互由透明全屏 overlay 遮住。调节条宽 `min(760px, 100vw - 512px)`，在最小窗口下也不压住左下角工具按钮。
- 页面缩放后 CSS 视口窄于 1080px（最小窗口 125%/150% 时约 864/720px）时，让出两侧会把滑块挤没（Codex 审查 P2）。此时改用 `@media (max-width: 1079px)`：调节条接近满宽，并抬到工具按钮上方（底部留 76px）。
- 控制器预览：
  - `startPreview / setPreviewLightness / stopPreview` 只改 `previewLightness`；非 null 时强制深色绘制，不改已保存快照。
  - 预览期间收到定时切换只更新快照，退出时按最新快照重绘。
  - 预览随层 `onMount` 开始，随 `scope.onDispose` 结束，所以取消、Esc、保存后关闭以及父层强制释放都会恢复。
- `saveLightness` 与 `save` 共用 `persist`，复用 `saving` 标志，设置弹窗现有的 `canClose` 自动阻止关闭。调节层 `canClose` 在保存中返回 false。失败时显示 Main 返回的原因，保留拖动值。

## 验证

| 层级 | 位置 | 覆盖 |
| --- | --- | --- |
| 单测 | `tests/unit/shared/dark-mode-schedule.test.js` | 校验与默认化；0 档与 CSS 深色块逐项相等；100 档端点与取整；0–100 每 5 档 WCAG 对比度 |
| 单测 | `tests/unit/main-process/dark-mode-scheduler.test.js` | 启动读取与坏值回退；写库失败与非法值不改状态；revision、广播、深色/浅色窗口底色；定时修改保留深浅度 |
| 单测 | `tests/unit/dark-mode-renderer.test.js` | paint 写入与移除；快照校验；预览强制深色与到点切换；saveLightness 的成功、失败与并发；【调节】启用条件 |
| 单测 | 登记测试 | IPC 登记与计数（301 / exclude 153） |
| 集成 | `scripts/integration/dark-mode-schedule-settings.js` | 真实 Preload → Main handler → 调度器 → AppDatabase：保存、推送、窗口底色、失败、重开读回；建窗 argv → Preload；损坏值读回 |
| GUI | `scripts/renderer-lifecycle/fixtures/dark-mode-lightness.js` | 真实 Electron DOM、index.html 主界面静态结构、生产样式、设置弹窗与模态宿主：入口位置；父层隐藏；底部居中；拖动实时变色；取消与 Esc；保存成功与失败；保存中锁定；预览中到点切换；1240×860、1080×760 及 1080×760 @125%/150% 的滑块宽度、与工具按钮不重叠并截图 |

GUI 截图在设置 `RENDERER_LIFECYCLE_EVIDENCE_DIR` 时输出，不入库。

未覆盖：完整 Main 启动的真实应用 GUI（本机开发版被 BizOP 预检卡住）、Windows 实机、2K 屏。缩放只在隔离 Electron 中验证。

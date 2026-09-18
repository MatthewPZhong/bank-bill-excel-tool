# Tasks — rpa-statement-fetch

> 关联 spec：`./spec.md`
> 分支：v3.0.0
> 状态约定：⬜ 待办 / 🔄 进行中 / ✅ 完成 / ⚠️ 阻塞

## 拆分原则

- 每个 task ≤ 5 文件改动（遵守 CLAUDE.md 小批次原则）
- 阶段串行（Phase N 完成后再进 Phase N+1）
- 阶段内 task 可并行（除非显式声明依赖）
- 每个 task 有可验证证据要求

---

## Phase 0 — 基建与骨架

### T0.1 ⬜ 新建模块目录骨架

- **改动**：
  - 新建 `src/backend/rpa/`
  - 新建 `src/backend/rpa/engine/`
  - 新建 `src/backend/rpa/scripts/icbc-enterprise/`
  - 新建 `src/main-process/rpa-session.js`（暂只 export 空类）
- **验收**：`tree src/backend/rpa src/main-process/rpa-session.js` 输出正确
- **依赖**：无

### T0.2 ⬜ preload 暴露 `rpa.*` 命名空间

- **改动**：
  - `src/preload.js` 追加 `rpa: { listChannels, startSession, userConfirm, cancel, onStatus, onResult }`
- **验收**：renderer 端 `window.desktopApi.rpa` 不为 undefined；`typeof window.desktopApi.rpa.startSession === 'function'`
- **依赖**：T0.1
- **风险**：preload 是核心安全边界，新增 API 不能破坏现有 contextBridge 隔离

### T0.3 ⬜ main.js 注册 RPA IPC handler（先 stub）

- **改动**：
  - `src/main.js` 追加 IPC 注册块（6 个 channel：`rpa:list-channels` / `rpa:start-session` / `rpa:user-confirm` / `rpa:cancel` / `rpa:status`(emit) / `rpa:result`(emit)）
  - handler 返回 stub 数据 `{ ok: true, todo: 'T1.x' }`
- **验收**：`npm start` 启动不报错；renderer 调用 `rpa.listChannels()` 能拿到 stub 响应
- **依赖**：T0.2

---

## Phase 1 — 引擎核心

### T1.1 ⬜ BrowserView 生命周期管理

- **文件**：`src/backend/rpa/engine/browser-view-engine.js`
- **功能**：
  - `createBrowserView({ partition, bounds }) → BrowserView`
  - `attachToWindow(mainWindow, view)`
  - `detachAndDestroy(view)` — cleanup hook
  - 强制 `partition` 以 `in-memory:` 开头
  - 默认禁用 DevTools
- **验收**：手测 `npm start` → 触发挂载 → BrowserView 加载 `about:blank` → 触发卸载 → 主界面恢复
- **依赖**：T0.1

### T1.2 ⬜ Step Runner（action-runner.js）

- **文件**：`src/backend/rpa/engine/action-runner.js`
- **功能**：
  - 支持 9 个 op（spec §6 列出）
  - 单 step 超时机制（默认 15s，可在 step 内 override）
  - 失败时收集上下文：当前 step idx、selector、page url、错误堆栈
- **验收**：
  - 单元级：用 `about:blank` + 注入 HTML 跑过 click/type/wait-for-selector 三件套
  - smoke：编一个 fake-icbc 测试页（HTML + JS），完整跑过 export-detail.steps.json
- **依赖**：T1.1

### T1.3 ⬜ Download Interceptor

- **文件**：`src/backend/rpa/engine/download-interceptor.js`
- **功能**：
  - 注册 `webContents.session.on('will-download')`
  - 强制 `item.setSavePath()` 到 `{userData}/rpa-downloads/<sessionId>/`
  - 白名单后缀：`.xls/.xlsx/.csv`，否则 `item.cancel()`
  - 大小上限 50 MB，超限 cancel
  - Promise 返回最终路径
- **验收**：
  - 用 data URL 触发下载，验证落点正确
  - 触发 .exe 后缀下载，验证被拒
- **依赖**：T1.1

### T1.4 ⬜ rpa-session.js 串起来

- **文件**：`src/main-process/rpa-session.js`
- **功能**：
  - `class RpaSession { start, runStep, confirm, cancel, on('status'), on('result') }`
  - 内部组合 engine + runner + interceptor
  - 状态机实现（spec §7 状态流转图）
  - 实例放入 `rpaSessions` 全局 Map
- **验收**：单测一个完整 session 跑完 9 个 step 全部 mock，状态正确流转
- **依赖**：T1.1, T1.2, T1.3

### T1.5 ⬜ main.js IPC handler 真实接线

- **文件**：`src/main.js`
- **功能**：替换 T0.3 的 stub，调用 `RpaSession`
- **验收**：renderer 调 `startSession` 能拿到 `sessionId`；`onStatus` 收到 phase 变更事件
- **依赖**：T1.4

---

## Phase 2 — 工行渠道脚本

### T2.1 ⬜ 工行 meta.json

- **文件**：`src/backend/rpa/scripts/icbc-enterprise/meta.json`
- **功能**：填写真实的工行企业网银 URL、partition 配置、显示名
- **验收**：JSON schema 通过；`rpa:list-channels` 能正确返回
- **依赖**：T0.1
- **阻塞点**：⚠️ 需要工行测试环境账号确认 URL（见 spec §8 待澄清）

### T2.2 ⬜ 工行 export-detail.steps.json

- **文件**：
  - `src/backend/rpa/scripts/icbc-enterprise/export-detail.steps.json`
  - `src/backend/rpa/scripts/icbc-enterprise/selectors.js`
- **功能**：
  - 录制 / 手写工行"导出昨日交易明细"全流程
  - selector 优先用 `id` / `name`，避免脆弱的 nth-child
- **验收**：在工行测试账号下端到端跑通一次
- **依赖**：T2.1, T1.5
- **阻塞点**：⚠️ 需要真实测试账号

### T2.3 ⬜ 渠道脚本 loader

- **文件**：`src/backend/rpa/script-loader.js`（新增）
- **功能**：
  - 扫描 `src/backend/rpa/scripts/*/meta.json`
  - 合并打包后路径（electron-builder 资源处理）
  - 提供 `loadChannel(channelId)` / `loadStepsFile(channelId, action)`
- **验收**：能正确加载工行渠道；扫描到 1 个渠道
- **依赖**：T0.1

---

## Phase 3 — UI 层

### T3.1 ⬜ 主界面新增"从网银抓取"入口

- **文件**：`src/renderer.js` + `index.html`
- **功能**：在主操作区加一个按钮"从网银抓取（实验性）"
- **验收**：按钮渲染正常；点击触发渠道选择对话框
- **依赖**：T3.2

### T3.2 ⬜ 渠道选择对话框

- **文件**：`src/renderer-dialogs.js`
- **功能**：
  - 调用 `rpa.listChannels()`
  - 渲染渠道列表（MVP 1 个）
  - 选择后 → 触发 `rpa.startSession({ channelId, action: 'export-detail', params: { dateRange: 'yesterday' } })`
- **验收**：能列出工行；点击后能拿到 sessionId
- **依赖**：T1.5, T2.3

### T3.3 ⬜ 渠道控制栏（顶部 56px）

- **文件**：`src/renderer.js` + `src/renderer-dialogs.js` + `index.html`
- **功能**：
  - BrowserView 挂载后，在主窗口顶部显示一个控制栏
  - 显示当前状态文案（loading/awaiting-user/running/...）
  - 提供"我已登录，开始抓取"按钮（在 phase=awaiting-user 时可点）
  - 提供"取消"按钮（任意时刻可点）
  - 接收 `rpa.onStatus` 更新文案
- **验收**：
  - 状态文案随 phase 实时更新
  - "开始抓取"按钮在正确时机激活
  - 取消能立即关闭 BrowserView
- **依赖**：T3.2

### T3.4 ⬜ 结果回流到主界面

- **文件**：`src/renderer.js`
- **功能**：
  - 监听 `rpa.onResult`
  - success → 关闭 BrowserView → 调用现有 import 流程（喂入下载路径）
  - error → 关闭 BrowserView → 弹错误对话框
- **验收**：
  - 成功路径：抓取完成后能直接进入现有大账号选择对话框
  - 失败路径：错误信息清晰可读
- **依赖**：T3.3, T4.1

---

## Phase 4 — 对接现有导入管线

### T4.1 ⬜ bridge-to-import.js

- **文件**：`src/backend/rpa/bridge-to-import.js`
- **功能**：
  - 把下载到的 Excel 路径直接喂给现有 `file-service/readers.js` 入口
  - 复用 `statementImportSessions` 状态机制
  - 不重写任何导入逻辑
- **验收**：抓取完成后能像选本地文件一样进入大账号选择对话框
- **依赖**：T1.5

### T4.2 ⬜ 模板自动匹配（可选）

- **文件**：`src/main.js` 或 `src/backend/rpa/bridge-to-import.js`
- **功能**：
  - 如果用户已为"工行企业网银"配过模板，自动套用
  - 否则提示用户选模板（走现有 UI）
- **验收**：已配过模板时能跳过模板选择直接进列映射
- **依赖**：T4.1
- **可裁剪**：MVP 阶段可不做，让用户每次手选

---

## Phase 5 — 收尾

### T5.1 ⬜ 安全审查 checklist

- **检查项**：
  - [ ] BrowserView partition 全部 `in-memory:` 开头
  - [ ] 下载白名单生效
  - [ ] 大小限制生效
  - [ ] 日志不含 cookie / token / URL query
  - [ ] 截图仅在调试模式下生成
  - [ ] DevTools 默认关闭
  - [ ] 同时只允许 1 个 RPA 会话（互斥锁）
- **验收**：逐项手测过 + 在 log.md 记录
- **依赖**：所有 Phase 1-4 task

### T5.2 ⬜ smoke 测试脚本

- **文件**：`scripts/smoke-test.js`（追加 RPA 用例）或新建 `scripts/smoke-rpa.js`
- **功能**：
  - 用 fake-icbc HTML 页面（本地 file://）端到端跑一遍
  - 验证：会话创建 → step 执行 → 下载拦截 → 路径返回
- **验收**：`npm run smoke` 通过
- **依赖**：所有功能 task

### T5.3 ⬜ 文档三件套

- **文件**：
  - `CHANGELOG.md`
  - `docs/VERSION_FEATURE_HISTORY.md`
  - `docs/USER_GUIDE.md`
- **功能**：按 v3.0.0 节奏更新
- **验收**：人工 review
- **依赖**：所有 task 完成

### T5.4 ⬜ 提 PR 前 check-vars

- 执行 `/check-vars`
- 在 PR body 追加「⚠️ 关联功能 review」段落
- **依赖**：T5.3

---

## 阻塞与待澄清

| 项 | 阻塞 task | 等待对象 |
|----|----------|---------|
| 工行测试账号 | T2.1, T2.2 | 用户/团队 |
| 法务/合规 review 用户文案 | T3.3 文案敲定 | 用户 |
| 默认模板预置 | T4.2 | 待定 |
| 同时单会话限制 | T5.1 | 待定（倾向：强制单会话） |

---

## 风险提醒（⚠️ 转载自 spec §6）

| 风险 | 等级 |
|------|------|
| 银行用户协议禁止自动化 | Critical（需法务 review） |
| 工行改版导致 selector 失效 | Important（脚本版本化） |
| 触发风控冻结账户 | Important（限频 + 延迟） |
| 凭证泄露 | Important（in-memory partition） |

**资金/认证/凭证场景，开工前需用户明确授权并指定测试环境账号。**

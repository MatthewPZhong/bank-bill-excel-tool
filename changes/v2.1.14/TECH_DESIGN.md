# v2.1.14 技术方案（TECH_DESIGN）

> 配套 `PRD.md`；性质：纯前端。涉及文件以 `index.html` / `src/renderer.js` / `src/renderer-dialogs.js` / `src/renderer-previews.js` / `src/styles*.css` / `package.json` / `assets/` 为主，**不动后端 IPC / main 进程 / database**。

## 0. 涉及文件总览

| 文件 | 改动 |
|---|---|
| `index.html` | 标题文案（A1）；`#bankStatementModulePanel` DOM 重构（B）；新增按钮节点 |
| `src/renderer.js` | 模块名（A2）；新增按钮事件绑定 + elements 缓存；占位 helper；refreshBankStatementStatus 兼容新按钮 |
| `src/renderer-dialogs.js` | 新增 `createLinkedTableManagerDialog`（C）|
| `src/renderer-previews.js` | 链接表弹窗 preview 工厂 + mock（B/C 回归）|
| `src/styles.css` / `src/styles-gemini-extra.css` | 新面板 3 行布局 CSS（B）；链接表弹窗样式（C）|
| `scripts/render-modal-preview.js` | 注册 `linked-table-manager` preview case |
| `package.json` | `version` bump；新增 `preview:linked-table-manager` 脚本 + 并入 `preview:all` |
| `assets/` | 新模板文件纳入 git 跟踪（D）|

## 1. A 文案变更（低风险）

- **A1 主标题**：`index.html:10` `<title>` + `index.html:30` `<h1>` 内 `<span class="gemini-gradient">` 文本；全局 grep `网银账单小助手` 二次确认无遗漏（window-bar / 任务栏 / footer）。
- **A2 模块名**：仅改 `src/renderer.js:55` `MODULES.bankStatementProcess.name = '资金对账数据处理'`。**绝不改 `id`**。改后 grep `'bank-statement-process'` 确认引用未受影响；模块切换菜单（`renderTopModuleSwitcher`）与功能收纳弹窗自动取 `name` 渲染。
- **A4 按钮文案**：`index.html:281` `开始运行` → `开始对账`；JS 内若有「开始运行」字样（状态提示）一并核查。
- **A3 功能说明文案**：本期仅记录于 PRD（无 UI 落点）。若用户后续指定显示位，再追加。

## 2. B 模块面板布局重构（核心）

### 2.1 现状

`index.html:273-298` `#bankStatementModulePanel.control-board.module-panel.bank-statement-board.layout-mirrored`，2 个 `.control-row`，每行 `.cell.left` / `.cell.right`。`layout-mirrored`（`styles-gemini-extra.css` `direction:rtl`）被 bankBuRecon/vccOpCalc 共享——**不能改该 class 本身**。

### 2.2 方案

1. **移除** `#bankStatementModulePanel` 的 `layout-mirrored`，新增专属 class `fund-recon-board`（语义：资金对账数据处理），新布局 CSS 写在该 class 作用域内，零外溢。
2. DOM 结构（建议 grid）：

```html
<section id="bankStatementModulePanel" class="control-board module-panel fund-recon-board" hidden>
  <div class="fund-recon-layout">          <!-- grid: [左区 1fr] [右区 auto] -->
    <div class="fund-recon-main">          <!-- 左区，grid 3 行 -->
      <div class="fund-recon-group">       <!-- 组1：银行对账单预加工 -->
        <button id="bankStatementImportBtn" class="primary-btn">导入对账单</button>
        <button id="bankStatementExportBtn" class="secondary-btn" disabled>导出文件</button>
      </div>
      <div class="fund-recon-group">       <!-- 组2：资金对账不平校验 -->
        <button id="bankStatementGatewayReconImportBtn" class="primary-btn">导入不平表</button>
        <button id="bankStatementGatewayReconExportBtn" class="secondary-btn" disabled>导出文件</button>
      </div>
      <div id="bankStatementStatusBox" class="status-box"> … </div>  <!-- 状态框：保留原 id + spark svg -->
    </div>
    <div class="fund-recon-actions">        <!-- 右区，flex column -->
      <button id="bankStatementRunBtn" class="primary-btn" disabled>开始对账</button>
      <button id="bankStatementScenarioBtn" class="secondary-btn">场景管理</button>
      <button id="bankStatementLinkedTableBtn" class="secondary-btn">链接表管理</button>
    </div>
  </div>
</section>
```

### 2.3 必须保留（回归红线）

- 原有 id 全部保留：`#bankStatementImportBtn`、`#bankStatementRunBtn`、`#bankStatementExportBtn`、`#bankStatementScenarioBtn`、`#bankStatementStatusBox`（含内部 `.status-spark` svg + `.status-box-text`，`refreshBankStatementStatus` 依赖它们）。
- `refreshBankStatementStatus`（`renderer.js:3373`）末尾对 3 个按钮的 disabled 控制逻辑不变；新增的 GatewayReconImport/Export/LinkedTable 按钮的 disabled 另行管理（见 2.4）。

### 2.4 新增按钮事件绑定（renderer.js）

| 元素 | 绑定 | 说明 |
|---|---|---|
| `#bankStatementGatewayReconImportBtn` | `handleBankStatementImportGatewayRecon`（已存在，`renderer.js:3467`）| [复用真实] 提供主动入口；可常驻 enabled（其内部已自校验） |
| `#bankStatementGatewayReconExportBtn` | `() => showComingSoon('资金对账不平校验导出')` | [占位] |
| `#bankStatementLinkedTableBtn` | `() => openModal(createLinkedTableManagerDialog())` | 打开链接表弹窗 |

- elements 缓存：在 `elements` 初始化处补 3 个新 id 的 `getElementById`。
- 事件绑定：在现有 bankStatement 按钮绑定区（`renderer.js:5140-5151` 附近）补 3 行 `addEventListener`。

## 3. 占位策略（统一）

新增 helper（renderer.js）：

```js
// v2.1.14：纯前端占位——功能 UI 就位但后端未接入，统一提示「后续版本开放」，不报错、不伪装成功
function showComingSoon(featureName) {
  openModal(createAlertDialog(`「${featureName}」功能将在后续版本开放，敬请期待。`));
}
```

- 适用：资金对账不平校验导出、链接表批量导入、中台退款订单/入账原始文件识别、回填/剔除模板导出、资金性质校验导出。
- 严禁：写任何数据、调用 run/export 真实 IPC 伪装成功、static success toast。

## 4. C 链接表管理弹窗（renderer-dialogs.js 新增）

`createLinkedTableManagerDialog()`：

- 复用现有 modal 工厂风格（参考 `createScenariosManagerDialog` 的 header/body/footer 结构与 class）。
- **表清单（静态常量）**：
  ```js
  const LINKED_TABLES = [
    { key: 'mid-allocation', name: '中台调拨订单表' },
    { key: 'gateway-bill',   name: '网关对账单' },
    { key: 'fx-option',      name: '期权表' },
    { key: 'fx-settlement',  name: '外汇交割表vPayment' },
  ];
  ```
- **表格**：列 = `表名 | 数据日期范围 | 表更新日期`；每行日期占位显示「—」或「未导入」。
- **footer**：右下 `[导入][退出]`。
  - `导入` → `showComingSoon('链接表批量导入')`（或：弹多选文件框做前端表头识别预览后提示占位；本期默认走 showComingSoon，按用户偏好可升级）。
  - `退出` → `closeModal()`。
- 表格状态数据本期不持久化、不读 DB。

## 5. D assets 模板

- 将已存在的未跟踪模板纳入 git：`入账原始订单.xlsx`、`中台退款订单.xls`、`中台调拨订单.xlsx`、`外汇交割表vPayment.xls`、`中台加款单剔除模板.xlsx`、`中台退款订单回填模板.xlsx`（`git add assets/...`）。
- **阻塞项（待用户答 PRD §D 决策点）**：`外汇期权订单.xlsx` 缺失；`.xls`/`.xlsx` 口径；「网关对账单」是否复用 `银行对账单.xlsx`。这些不阻塞 A/B/C 的 UI 实现，可并行推进，模板待定项最后补。
- 本期模板仅作「资源就位」，**无代码读取/解析**（边界内）。

## 6. E preview 回归

- 新增 `scripts/render-modal-preview.js` case `linked-table-manager` + `renderer-previews.js` 对应工厂 + mock（参考 `scenarios-manager` preview 实现）。
- `package.json`：新增 `"preview:linked-table-manager": "node scripts/render-modal-preview.js linked-table-manager linked-table-manager.png"`，并入 `preview:all`。
- 改前端后必跑：`npm run preview:bank-statement-panel`（面板布局回归）+ `npm run preview:linked-table-manager`（新弹窗）。

## 7. 版本与校验

- `package.json.version`: `2.1.13` → `2.1.14-beta.1`（触发 `/check-vars` 硬节点）。
- 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）**转正时**才统一更新（memory `workflow_docs_update`），beta 阶段不动。
- 收口：`npm run release-check` 全绿 + 相关 preview 回归。

## 8. 未决问题（需用户答复后才能完成对应部分）

1. PRD §D 决策点（外汇期权订单.xlsx / 扩展名口径 / 网关对账单模板）。
2. A3 模块功能说明文案是否需要 UI 显示位（默认否）。
3. C3「导入」占位深度：纯 Toast 占位 vs 弹文件框 + 前端表头识别预览（默认纯 Toast）。

> 上述未决项**不阻塞** A1/A2/A4 文案 + B 面板布局 + C 弹窗骨架 + 占位 helper 的实现；可先交付主体，待定项后补。

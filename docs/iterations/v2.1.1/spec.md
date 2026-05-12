# spec — v2.1.1 patch 迭代

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.1` |
| 关联 PRD | `PRD-v2.1.1.md` |
| 关联 tasks | `tasks.md` |
| 起草日期 | 2026-05-12 |
| 起草人 | team-lead（PM 角色） |
| 基线 | `main` HEAD = `363fee6`（PR #40 合并后，含 v2.1.0-beta.3 全部内容） |

> 本文档落到文件级 + 符号级 + 行号级（基线：main HEAD `363fee6`）。
> 行号在 Dev 实施过程中可能小幅漂移（±5 行）；漂移后以符号名/上下文为准。

---

## 一、改动文件清单

### 1.1 删除（1 个文件 + 4 个依赖 + N 个函数）

| 文件 | 描述 |
|---|---|
| `src/backend/file-service/pdf-worker.js` | 整文件删除（子进程 PDF 解析） |

**依赖移除**（`package.json` line 117-123 dependencies 段）：

- `@tesseract.js-data/chi_sim`（line 118，OCR 中文训练数据）
- `@tesseract.js-data/eng`（line 119，OCR 英文训练数据）
- `pdfjs-dist`（line 122，PDF.js 库）
- `tesseract.js`（line 123，OCR 主库）

### 1.2 修改

| 文件 | 改动要点 | 涉及 R |
|---|---|---|
| `package.json` | 删 4 个 deps（line 118/119/122/123） + version bump 2.1.0-beta.3 → 2.1.1 | R1 / R6 |
| `package-lock.json` | `npm install` 重生成（删 deps 后） | R1 |
| `src/backend/file-service/readers.js` | 删 `readPdfRows` (L21) + PDF 分支 (L108-110) + `shouldStopPdfMatchedRows` (L184) + `shouldSkipPdfMatchedRow` (L202) + 函数参数 `isPdfFile` 及内部分支 (L217/L248-253/L326) | R1 |
| `src/backend/file-service/common.js` | `SUPPORTED_EXTENSIONS` 删 `.pdf`（line 1）— **Critical 变量改动** | R1 |
| `src/main.js` | 删 PDF filter（line 2584-2585）；保留 line 6415 注释（历史信息，无碍） | R1 |
| `src/renderer-dialogs.js` | C4 dialog 改名 + 新增 BillDate 区 + tooltip（line 5851 / 6824-6855 / SubBizType 区不动） | R2-1 / R2-2 / R3 |
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | `billDateMatches` / `tryOneToOne` / `tryOneToManyPool` 等接受 `days` 参数（取代 hardcoded `±1day`） | R2-2 |
| `src/main-process/recon-id-fix-engine.js` | `runReconIdFix` 内从 `scenario.config.billDateRange` 解出 days 传给 C4 引擎 | R2-2 |
| `src/renderer.js` | `middleText: '跳过 C3 直接运行'` → `'直接运行'`（line 3299） | R4 |
| `docs/USER_GUIDE.md` | 删 line 21 "pdf 类型文件导入" + 加 BillDate ±N 章节 | R1 / R2-2 |
| `CHANGELOG.md` | 新增 v2.1.1 段落（BREAKING + 新功能） | 全 |
| `docs/VERSION_FEATURE_HISTORY.md` | 补 v2.1.1 一行 | 全 |
| `scripts/smoke/recon-id-fix-engine.js` | 新增 BillDate ±N 用例（business 子模式） | R2-2 |
| `scripts/smoke/recon-id-fix-engine-gateway.js` | 新增 BillDate ±N 用例（gateway 子模式） | R2-2 |

---

## 二、详细设计

### 2.1 R1：PDF 整体移除

#### 2.1.1 `src/backend/file-service/pdf-worker.js`

整文件删除。该文件唯一被 `readers.js:21` 通过 `spawn` 调用，删除后 readers 也要同步清。

#### 2.1.2 `src/backend/file-service/readers.js`

```diff
- function readPdfRows(filePath) {
-   const workerScriptPath = path.join(__dirname, 'pdf-worker.js');
-   // ... ~30 行子进程交互逻辑
- }
```

```diff
- if (path.extname(filePath).toLowerCase() === '.pdf') {
-   const rows = readPdfRows(filePath);
-   return blankrows ? rows : rows.filter((row) => isRowMeaningful(row));
- }
```

```diff
- function shouldStopPdfMatchedRows(cells) { /* ... */ }
- function shouldSkipPdfMatchedRow(cells, expectedHeaderCount) { /* ... */ }
```

`readMatchedRows` 函数签名：
```diff
- function readMatchedRows({
-   ...
-   isPdfFile = false
- }) {
+ function readMatchedRows({
+   ...
+ }) {
```

```diff
-   if (index > 0 && isPdfFile) {
-     if (shouldStopPdfMatchedRows(normalizedCells)) {
-       break;
-     }
-     if (shouldSkipPdfMatchedRow(normalizedCells, expectedHeaderCount)) {
-       continue;
-     }
-   }
```

调用点（L326）：
```diff
- isPdfFile: path.extname(filePath).toLowerCase() === '.pdf'
```

#### 2.1.3 `src/backend/file-service/common.js`

```diff
- const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.pdf']);
+ const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
```

⚠️ **Critical 变量改动** — `SUPPORTED_EXTENSIONS` 在 `rules/important-variables.md` Critical 层；改动后必须同步：
- reader 实现（已删 PDF 分支 ✓）
- UI 提示文案（main.js 文件 dialog filter / USER_GUIDE）

#### 2.1.4 `src/main.js`

```diff
@@ -2583,7 +2583,7 @@
   filters: [{
-    name: 'Excel / CSV / PDF',
-    extensions: ['xlsx', 'xls', 'csv', 'pdf']
+    name: 'Excel / CSV',
+    extensions: ['xlsx', 'xls', 'csv']
   }]
```

line 6415 的注释（"其他异常（如 PDF 解析失败）也抛出"）保留为历史记录，不删 — 后续修代码时再清。

#### 2.1.5 `package.json` deps 删除

```diff
   "dependencies": {
-    "@tesseract.js-data/chi_sim": "^1.0.0",
-    "@tesseract.js-data/eng": "^1.0.0",
     "@xmldom/xmldom": "^0.9.10",
     "csv-parse": "^6.1.0",
     "exceljs": "^4.4.0",
     "open": "^10.2.0",
-    "pdfjs-dist": "^5.5.207",
-    "tesseract.js": "^7.0.0",
     "xlsx": "^0.18.5"
   }
```

之后跑 `npm install` 重生成 `package-lock.json`。

#### 2.1.6 `docs/USER_GUIDE.md`

```diff
- - 支持 `xlsx` / `xls` / `csv` / `pdf` 类型文件导入；
+ - 支持 `xlsx` / `xls` / `csv` 类型文件导入；
```

---

### 2.2 R2-1：C4 dialog "匹配模式" 区文案改名

#### 2.2.1 `src/renderer-dialogs.js:6824`

```diff
- <span class="scenario-config-label">匹配规则</span>
+ <span class="scenario-config-label">匹配模式</span>
```

#### 2.2.2 `src/renderer-dialogs.js:6828, 6832, 6836`

```diff
- <span>${isGatewayMode ? '网关 1 v 1 渠道' : '主边单据 1 v 1 从边单据'}</span>
+ <span>${isGatewayMode ? '网关 1 v 1 渠道' : '主边 1 v 1 从边'}</span>
```

类似 line 6832 / 6836（`1 v 多` / `多 v 1`）。

**不改**：
- line 5851 error toast `'单据匹配规则至少勾 1 项'` — 用户拍：仅改"匹配模式"标签与 3 个勾选框
- line 5958-5962 / 7042-7047 SubBizType 区"主边单据 SubBizType 值" / "从边单据 SubBizType 值" — 保留
- line 7393 confirm dialog `'匹配规则：'` — 保留

---

### 2.3 R2-2：BillDate ±N 可配置

#### 2.3.1 UI 新增（`src/renderer-dialogs.js`）

在 line 6824 附近"匹配模式"标签同行右侧，新增一个 column：

```html
<div class="scenario-config-row">
  <!-- 左半：匹配模式 -->
  <div class="scenario-config-col">
    <span class="scenario-config-label">匹配模式</span>
    <label><input type="checkbox" data-mode="1v1"> <span>主边 1 v 1 从边</span></label>
    <!-- 等 -->
  </div>
  <!-- 右半：BillDate 日期范围（新增） -->
  <div class="scenario-config-col">
    <span class="scenario-config-label">
      BillDate 日期范围
      <span class="tooltip-icon" title="...（见 §2.3.4 tooltip 文案）">ⓘ</span>
    </span>
    <label>
      <input type="checkbox" id="billDateRangeEnabled">
      <span>BillDate ±</span>
      <input type="number" id="billDateRangeDays" min="1" max="999" value="3" style="width: 3ch">
      <span>Days</span>
    </label>
  </div>
</div>
```

`style="width: 3ch"` 即"3 个字符宽"。

#### 2.3.2 验证 / 校验逻辑

```js
function validateBillDateRange(config) {
  if (!config.billDateRange || !config.billDateRange.enabled) return null;
  const days = Number(config.billDateRange.days);
  if (!Number.isInteger(days) || days < 1 || days > 999) {
    return 'BillDate 日期范围必须是 1-999 的正整数';
  }
  return null;
}
```

加入 `validateScenarioConfig` 现有校验链（dialog 保存时调用）。

#### 2.3.3 引擎接入（`src/main-process/scenario-engines/c4-recon-id-fix.js`）

现状 line 152-162：

```js
function billDateMatches(leftRaw, rightRaw, mode) {
  if (mode === 'strict') {
    // ...
    return L === R;
  }
  // mode === '±1day'
  const lDate = parseBillDateMs(L);
  const rDate = parseBillDateMs(R);
  return Math.abs(lDate - rDate) <= 86400000; // hardcoded 1 day
}
```

改为：

```js
function billDateMatches(leftRaw, rightRaw, mode, days = 1) {
  // mode='strict' 严格相等
  if (mode === 'strict') {
    // ... 同现状
    return L === R;
  }
  // mode='±Nday' 容错；days 来自 scenario.config.billDateRange.days，默认 1（兼容老 config）
  const lDate = parseBillDateMs(L);
  const rDate = parseBillDateMs(R);
  const windowMs = days * 86400000;
  return Math.abs(lDate - rDate) <= windowMs;
}
```

`tryOneToOne` / `tryOneToManyPool` 等函数签名加 `days` 形参，沿调用链传给 `billDateMatches`。

`runC4Scenario` 入口（line ~1010-1020 附近）：

```js
function runC4Scenario(scenario, sheets, subMode) {
  // 已有 subMode 推导...
  const billDateRange = scenario.config?.billDateRange || { enabled: false, days: 1 };
  const days = billDateRange.enabled ? Number(billDateRange.days) : 1;
  // 把 days 传给下层 Step 2/3.2/3'.2 调用
  // ...
}
```

**关键设计**：
- 不勾选 → `enabled=false` → `days=1`（与现状 ±1day 等价，零回归）
- 勾选 + N → `enabled=true` → `days=N`（替换 Step 2/3.2/3'.2 的容错窗口）

#### 2.3.4 tooltip 文案

> "默认 BillDate 容错范围 ±1 天（先严格匹配，再 ±1 天容错）。勾选后可调整容错窗口为 ±N 天（N=1-999），用于跨日扎单场景。严格匹配阶段不受影响。"

#### 2.3.5 smoke 用例新增（`scripts/smoke/recon-id-fix-engine.js` + `-gateway.js`）

每个子模式新增 3 用例：

- **Case BD-1**：`billDateRange.enabled=false` + 跨 1 天 → 命中（与现状一致）
- **Case BD-2**：`billDateRange.enabled=true, days=5` + 跨 4 天 → 命中
- **Case BD-3**：`billDateRange.enabled=true, days=1` + 跨 3 天 → 不命中

新增 6 个用例（2 子模式 × 3 用例）。

---

### 2.4 R3：tooltip 两处（"修复结果输出" + "订单修复ID取值"）

#### 2.4.1 `src/renderer-dialogs.js:6855`

现状：

```js
<span class="scenario-config-label">${isGatewayMode ? '订单修复ID取值' : '修复结果输出'}</span>
```

改为：

```js
<span class="scenario-config-label">
  ${isGatewayMode ? '订单修复ID取值' : '修复结果输出'}
  <span class="tooltip-icon" title="${isGatewayMode ? GATEWAY_TOOLTIP : BUSINESS_TOOLTIP}">ⓘ</span>
</span>
```

`GATEWAY_TOOLTIP` / `BUSINESS_TOOLTIP` 在文件顶部定义为常量：

```js
const BUSINESS_TOOLTIP = '指定 ReconID 修复结果写到哪一侧的单据：仅写主边 / 仅写从边 / 主从都写。Type 字段会自动标记（1=主边, 2=从边, 3=双向）。';
const GATEWAY_TOOLTIP = '指定网关账单与渠道账单两侧的修复 ID 取自哪一侧的 reconciliationId（可选追加 suffix）。"两侧都修复" 时会同时写入两侧。';
```

复用项目现有 tooltip CSS class（如有），否则用原生 `title` 属性（不需新 CSS）。

---

### 2.5 R4："跳过 C3 直接运行" → "直接运行"

#### 2.5.1 `src/renderer.js:3299`

```diff
-     middleText: '跳过 C3 直接运行',
+     middleText: '直接运行',
```

`message`（line 3297）保持不变，因为已经把 C3 译成"资金对账不平"了。

---

## 三、Migration / 数据兼容

### 3.1 BillDate ±N 老 config 兼容

- 老 scenario.config 无 `billDateRange` 字段 → 路由层 default `{ enabled: false, days: 1 }`
- 不持久化 default（避免老 config 被无意义覆盖写）
- DB schema 不变（config_json 是 BLOB）
- 不需要 SQL migration

### 3.2 PDF 移除后用户数据

- 用户 `Documents/网银账单生成小助手/` 下不存在 PDF 缓存
- tesseract 训练数据可能曾下载到 `~/.cache/`（OCR 库行为）— 不主动清，保守原则
- `tool-data.sqlite` 不存 PDF 相关数据 → 不需 migration

---

## 四、风险与回归

### 4.1 资金红线（CLAUDE.md 永久规则 #7）

- R2-2 BillDate ±N 是**资金对账核心算法改动** — 必须人工复核
- smoke 必跑：不勾选回归到 ±1day（与现状一致）+ N=5 / N=1 / 跨月（28→2）三档
- 老场景零回归（不勾选场景的 ranAt → 与 main 基线一致）

### 4.2 兼容性破坏（PDF）

- 任何 v2.1.0 及之前的用户若用 PDF 导入会被破坏 — CHANGELOG `BREAKING` 标记
- USER_GUIDE 删 PDF 章节
- 旧 USER_GUIDE 截图若提及 PDF，也要更新（待 dev 时核查）

### 4.3 Critical 变量改动（SUPPORTED_EXTENSIONS）

按 `rules/important-variables.md` Critical 层 review 要点：

- ✅ reader 实现已删 PDF 分支
- ✅ UI 提示文案（main.js dialog filter / USER_GUIDE）已同步
- ⚠️ check-vars 提 PR 前必跑（硬节点）

---

## 五、preview 回归

按 memory [[workflow_frontend_previews]]：

| preview | 是否需要重跑 |
|---|---|
| `scenario-config-c4.png`（business） | ✅ 必（T2-1 改名 + T2-2 新增 BillDate 区） |
| `scenario-config-c4-gateway.png`（gateway） | ✅ 必（T2-2 新增 BillDate 区） |
| `scenario-config-c4-gateway-1vN.png` | ✅ 必 |
| `scenario-config-c4-both.png` | ✅ 必 |
| `recon-id-fix-panel{,-business,-gateway}.png` | ⚠️ 视情况（若 main 主面板未改可不重跑） |

T2-1 文案改 + T2-2 BillDate 区新增，使得"匹配模式" + "BillDate 日期范围" 同行；建议 4 张 C4 截图全跑。

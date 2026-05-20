# spec — v2.1.6 实施规格

| 字段 | 值 |
|---|---|
| 文档版本 | v0.17（2026-05-20 — PR #50 reviewer F1+F2+F3 修复：F1 smoke cleanup helper 解 Windows CI EBUSY / F2 账单日期 YYYY/MM/DD 入库归一化为 YYYY-MM-DD + writer sanitize 防御 / F3 USER_GUIDE.md 同步 fix5/11/13/14 口径）；v0.16 = fix15 月份选择弹窗标题三分支；v0.15 = fix14 UI 镜像布局；v0.14 = fix11/12/13 联合调整；v0.13-v0.1 起草 |
| 关联 PRD | `PRD-v2.1.6.md` |
| 关联 tasks | `tasks.md` |
| 工作分支 | `v2.1.6`（基于 `v2.1.5`） |
| 起草人 | team-lead |

---

## 一、本规格的边界

- **Module A 改动**：跨 8 个 writer 入口注入元数据 + main.js 启动期 + package.json + 新建 watermark helper + 新建 build-info 生成脚本。
- **Module B 改动**：新增独立模块「收单单据币种校验」（IPC `acquiringBillCurrency:*`、SQLite 4 张表前缀 `acquiring_bill_currency_*`、前端面板 `acquiringBillCurrencyModulePanel`）。
- **不动**：v2.1.5 已发布的 7 个老模块的任何业务逻辑（仅元数据注入 + 共用 helper 引入）。
- **复用**：bankBuRecon（v2.1.2）模块的文件目录结构 / IPC 命名风格 / dialog 样式 / 月份组织方式。

---

## 二、Module A — 个人痕迹技术规格

### 2.1 watermark helper 实现

**文件**：`src/main-process/workbook-watermark.js`（新建，~20 行）

```js
const WATERMARK_AUTHOR = 'pzhong';

function applyWatermark(workbook) {
  if (!workbook) return workbook;
  // ExcelJS workbook：实例有 lastModifiedBy 可枚举属性 + _worksheets 内部 map
  if (typeof workbook.lastModifiedBy !== 'undefined' || workbook._worksheets) {
    workbook.lastModifiedBy = WATERMARK_AUTHOR;
    return workbook;
  }
  // SheetJS workbook：纯对象，有 SheetNames / Sheets
  if (workbook.SheetNames || workbook.Sheets) {
    workbook.Props = workbook.Props || {};
    workbook.Props.LastAuthor = WATERMARK_AUTHOR;
    return workbook;
  }
  return workbook;
}

module.exports = { applyWatermark, WATERMARK_AUTHOR };
```

**调用约定**：
- 紧贴所有 `*.writeFile(...)` 之前
- 仅设置 `lastModifiedBy` / `LastAuthor`，**不动** `creator` / `Author`（保持自然，避免显得像水印）

### 2.2 8 个 writer 接入点（grep 出处）

| # | 文件 | 函数 / 行号 | 库 | 改动 |
|---|---|---|---|---|
| 1 | `src/backend/file-service/writers.js` | `writeBalanceWorkbook` 等所有 `XLSX.writeFile` 前 | xlsx-js-style | + 1 `applyWatermark(wb)` |
| 2 | `src/main.js` | 6104 `XLSXStyle.writeFile(baseWb, ...)` 前 | xlsx-js-style | + 1 行 |
| 3 | `src/main-process/pending-session.js` | 94 `XLSX.writeFile(wb, archivePath)` 前 | xlsx | + 1 行 |
| 4 | `src/main-process/pending-session.js` | 268 `XLSX.writeFile(wb, savePath)` 前 | xlsx | + 1 行 |
| 5 | `src/backend/pending-export/writer.js` | `XLSX.writeFile` 前 | xlsx-js-style | + 1 行 |
| 6 | `src/main-process/recon-id-fix-io.js` | 259 `XLSXStyle.writeFile(wb, savePath)` 前 | xlsx-js-style | + 1 行 |
| 7 | `src/main-process/recon-id-fix-io.js` | 300 同上 | xlsx-js-style | + 1 行 |
| 8 | `src/main-process/exceljs-writer.js` | 63 `workbook.xlsx.writeFile(savePath)` 前 | ExcelJS | + 1 行 |
| 9 | `src/main-process/exceljs-writer.js` | 89 同上 | ExcelJS | + 1 行 |
| 10 | `src/main-process/bank-bu-recon-writer.js` | 110 同上 | ExcelJS | + 1 行 |
| 11 | `src/main-process/bank-bu-recon-writer.js` | 158 同上 | ExcelJS | + 1 行 |
| 12 | `src/main-process/biz-op-recon-writer.js` | 68 / 139 / 209 / 234 同上 | ExcelJS | + 4 行 |
| 13 | `src/main-process/acquiring-bill-currency-writer.js`（Module B 新建） | — | ExcelJS | + 1 行（写入时） |

**Module B 自带 watermark**：新模块的 writer 在创建时直接 import 并 apply。

### 2.3 log 头实现

**改动位置**：`src/main.js` 启动期，紧贴现有 `appendActivityRecord(... '应用启动 | 版本：...')` 之后

**新增代码**（伪代码示意，实际位置需 grep `应用启动` 字面量定位）：

```js
const pkg = require('../package.json');
let buildInfo = { commit: 'dev' };
try { buildInfo = require('./build-info'); } catch (_) { /* dev 期文件不存在 */ }

appendActivityRecord(activityLogPath, {
  level: 'INFO',
  message: `crafted by ${pkg.author.name} (${pkg.author.email}) · build ${buildInfo.commit}`
});
```

**输出样例**（log 文件中）：
```
[11:32:25] [INFO] 应用启动 | 版本：2.1.6
[11:32:25] [INFO] crafted by pzhong (pzhong1212@gmail.com) · build a1b2c3d
[11:32:25] [INFO] 启动耗时 | 进程启动到可见：170.8ms...
```

### 2.4 build 戳生成脚本

**文件**：`scripts/gen-build-info.js`（新建）

```js
const fs = require('node:fs');
const { execSync } = require('node:child_process');

let commit = 'dev';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch (_) { /* 无 git 环境 */ }

const content = `// 构建时自动生成，勿手改\nmodule.exports = ${JSON.stringify({ commit }, null, 2)};\n`;
fs.writeFileSync('src/build-info.js', content, 'utf8');
console.log('[gen-build-info] wrote src/build-info.js:', { commit });
```

**package.json scripts 改动**：

```json
{
  "scripts": {
    "prebuild:meta": "node scripts/gen-build-info.js",
    "dist:win": "npm run prebuild:meta && electron-builder --win",
    "dist:win:portable": "npm run prebuild:meta && electron-builder --win --x64 -c.win.target=portable",
    "dist:win:setup": "npm run prebuild:meta && electron-builder --win --x64 -c.win.target=nsis"
  }
}
```

**`.gitignore` 加入**：`src/build-info.js`

### 2.5 package.json 元数据

```json
{
  "author": {
    "name": "pzhong",
    "email": "pzhong1212@gmail.com"
  },
  "build": {
    "copyright": "© 2024-2026 pzhong",
    "win": {
      "publisherName": "pzhong"
    }
  }
}
```

---

## 三、Module B — 模板字段定义

### 3.1 收单流水表（多 xlsx，每个 1 sheet，48 列）

按表头顺序（出处：`收单流水表_Example.xlsx` 探查结果）：

| # | Excel 表头 | DB 列名 | 类型 | 用途 |
|---|---|---|---|---|
| 1 | 账单日期 | bill_date_raw | TEXT | 月份归属来源（提取 `YYYY-MM`） |
| 2 | originBizId | origin_biz_id | TEXT | — |
| 3 | 主体大账号 | main_account | TEXT | — |
| 4 | 公司主体 | company_entity | TEXT | — |
| 5 | 流水类型 | flow_type | TEXT | — |
| 6 | 业务部门 | bu_dept | TEXT | — |
| 7 | **对账主Id** | **recon_main_id** | TEXT NOT NULL | **★ 关联 key**（落库唯一索引，重复 → 整批拒绝） |
| 8 | 出入方向 | direction | TEXT | — |
| 9 | 流水单号 | flow_no | TEXT | — |
| 10 | 用户编号 | user_no | TEXT | — |
| 11 | 账户编号 | account_no | TEXT | — |
| 12 | 拆分类型 | split_type | TEXT | — |
| 13 | 对账金额 | — | TEXT | v0.7 起**仅留底**，落 raw_json 不入库独立列（v0.6 前曾入 recon_amount 参与对账） |
| 14 | 币种 | — | TEXT | v0.7 起**仅留底**（v0.6 前曾入 currency 参与对账） |
| 15-28 | 账户类型 / 流水开始时间 / ... / MID | … | TEXT | 不参与对账，落 raw_json 留底 |
| **29** | **通道清算金额** | **settle_amount** | TEXT NOT NULL | **★ 取 ABS 后参与对账**（v0.7 起）；新增列 `流水_通道清算金额` = ABS(此值)。v0.9 fix6：**允许为空**（业务上 4 种非清算流水子类型 ~0.6% 行无值）；空值入库 `settle_amount=''` / `settle_amount_abs=''`；非空值仍走 parseAmountAbs 校验数值合法性 |
| **30** | **通道清算币种** | **settle_currency** | TEXT | **★ 与单据表币种比较（LOWER+TRIM）**（v0.7 起）；新增列 `流水_通道清算币种` = 此值；允许为空（实测 30,057 行空） |
| 31-48 | 交易订单号 / 关联渠道 / ... / 客资账户余额 | … | TEXT | 不参与对账，落 raw_json 留底 |

**v0.7 字段切换说明（fix4）**：
- 用户实测发现 v0.6 用「币种」+「对账金额」（订单视角）做对账时，单据全 100% match（462 万行零差异）—— 这是**字段语义错位**，不是真实业务"零差异"
- 真实对账应该用流水侧「通道清算币种」+「通道清算金额」（**清算视角**，与单据表「对账币种」的语义对齐），实测改完后能正确抓出约 56% 行的币种不一致（订单 USD 收款 → 通道 EUR 清算等真实场景）
- 历史数据：v0.6 已入库的 466 万行 `currency_norm` 存的是订单币种，**必须清月 + 重导**

**导入校验**（v0.7 修订）：
- 表头必须完全匹配（列数 48 + 列名 + 顺序），否则整批拒绝
- `对账主Id` 不能为空 / 不能跨同月多 xlsx 重复（重复 → 整批拒绝 + error_report）
- `通道清算金额` **v0.9 fix6：允许为空**（业务上 4 种非清算流水子类型 ~0.6% 行无值，spec §3.1 第 29 列备注）；非空时必须可解析为数值否则整批拒绝
- `通道清算币种` 允许为空（实测 30,057 行空，spec §5.2 行为：空 vs 单据有值 → diff_type='currency_mismatch'）

### 3.2 收单流水单据表（多 xlsx，每个 1 sheet，26 列）

按表头顺序（出处：`收单流水单据表_Example.xlsx` 探查结果）：

| # | Excel 表头 | DB 列名 | 类型 | 用途 |
|---|---|---|---|---|
| 1 | 账单日期 | bill_date_raw | TEXT | 月份归属来源 |
| 2 | originBillBizId | origin_bill_biz_id | TEXT | — |
| 3 | ReconBillBizId | recon_bill_biz_id | TEXT | — |
| 4 | 公司主体 | company_entity | TEXT | — |
| 5 | 业务部门 | bu_dept | TEXT | — |
| 6 | 对手部门 | opp_dept | TEXT | — |
| 7 | 订单创建来源 | order_source | TEXT | — |
| 8 | 财务BU | fin_bu | TEXT | — |
| 9 | 账单类型 | bill_type | TEXT | — |
| 10 | 单据类型 | doc_type | TEXT | — |
| 11 | 业务子类型 | biz_sub_type | TEXT | — |
| 12 | 交易类型 | trade_type | TEXT | — |
| 13 | 对账子类型 | recon_sub_type | TEXT | — |
| 14 | 单据状态 | doc_status | TEXT | — |
| 15 | **主对账Id** | **recon_main_id** | TEXT NOT NULL | **★ 关联 key**（与流水 `对账主Id` 关联，1:1） |
| 16 | 业务订单号 | biz_order_no | TEXT | — |
| 17 | 用户编号 | user_no | TEXT | — |
| 18 | 账户号 | account_no | TEXT | — |
| 19 | 对账金额 | recon_amount | TEXT | 仅落库留底，**不参与对账** |
| 20 | **对账币种** | **currency** | TEXT | **★ 与流水币种比较（LOWER+TRIM）** |
| 21 | 账户类型 | account_type | TEXT | — |
| 22 | valueDate | value_date | TEXT | — |
| 23 | channel | channel | TEXT | — |
| 24 | remark | remark | TEXT | — |
| 25 | 创建时间 | created_at | TEXT | — |
| 26 | 完成时间 | finished_at | TEXT | — |

**导入校验同 3.1**。

### 3.3 月份归属规则（v0.8 fix5 重构）

**v0.8 fix5 决策**：从 v0.7 "自动从 xlsx 账单日期提月份"反转为「**用户弹窗主动选择月份 + xlsx 内账单日期必须与选的月份完全一致，否则整批拒绝**」。

理由：用户实测发现 v0.7 流程缺少"用户声明月份"的主动确认，跨月份/选错文件场景没有 UI 层防护，全靠 reader 内部逻辑判断；fix5 把月份输入提到 UI 流程入口。

**新流程**：
1. 用户点「导入流水表」/「导入单据表」→ 弹「**请选择导入文件的月份**」单选弹窗（v0.16 fix15：标题文案；v0.15 之前是「选择对账月份」与开始运行共享）（结构 + 样式同 bankBuRecon `createBankBuReconMonthPickerDialog`：年份下拉 + 月份下拉，按钮文字 `下一步` 改为 `导入`）
2. 用户选月份（如 `2026-03`）+ 点「导入」→ 弹 dialog.showOpenDialog 多选 xlsx
3. peek 首文件 → 取出 xlsx 内首行账单日期解析的 monthKey
4. **校验**：xlsx 内 monthKey 必须严格等于用户选的月份；否则返回 error `"文件月份 X 与所选月份 Y 不一致"`
5. peek 结果是否需要覆盖确认（fix1 流程）→ 弹覆盖确认（保留 fix1）
6. import：reader 把用户选的月份当 `expectedMonthKey` 传入，所有行 monthKey 不等于即累积错误（沿用现有"跨月份混杂"语义）

**月份枚举（用户选月份的下拉范围）**：
- 年份：当前年 ± 1（参考 bankBuRecon 范式）
- 月份：1-12 全列出
- **不依赖 DB 已有月份**（v0.7 之前的「月份下拉枚举 DB 已导入月份」机制 v0.8 完全删除）

**`spec §3.4 fix1 covered scenario`**：peek 检测到「该月份已有数据」时仍走 fix1 覆盖确认弹窗。fix5 只是把月份输入提前到 UI 流程入口，不改变覆盖确认逻辑。

**spec §八面板**（v0.8）：删 `acquiringBillCurrencyMonthSelect` 月份下拉 + label；面板仅保留 4 按钮（导入流水/单据/开始运行/导出差异）+ 状态栏。

### 3.4 重复导入检测（fix1）

**背景**：UNIQUE `(month_key, recon_main_id)` 是资金红线（spec §4.1 / §4.2），但 v0.3 落地缺失"该月已有数据"的预检与引导，用户重新导入相同月份时第一行即撞 UNIQUE → 整批 ROLLBACK，且错误信息不明确导致用户困惑。

**fix1 解决**：导入前**先 peek monthKey**（只读首文件首行 + 表头校验，不 INSERT），主动查 DB 已有行数。若 > 0 则要求 renderer 二次确认后再触发"清月+导入"。

**流程**（流水表 / 单据表 **对称处理**）：

```
1. 用户点「导入流水表」/「导入单据表」
2. dialog 弹窗多选 xlsx → 用户选定 filePaths
3. reader.peekMonthKeyFromFile(filePaths[0]) → 解析首文件首行账单日期 → monthKey
   - 表头不匹配 → 直接抛错（沿用现有 ImportValidationError 行为）
   - 首行账单日期无法解析 → 直接抛错
4. importRepo.getMonthReadiness(db, monthKey) → 取 { flowCount, billCount }
5. 决策：
   - kind=flow 且 flowCount === 0 → 直接 importFlowFiles（事务）
   - kind=flow 且 flowCount > 0 → 返回 { status: 'overwrite-required', monthKey, existingCount: flowCount, filePaths }
   - kind=bill 且 billCount === 0 → 直接 importBillFiles（事务）
   - kind=bill 且 billCount > 0 → 返回 { status: 'overwrite-required', monthKey, existingCount: billCount, filePaths }
6. renderer 收到 overwrite-required → confirm 弹窗 → 用户确认 → 二次调 importFlow/importBill({ filePaths, confirmOverwrite: true })
7. 后端二次调用：先 clearMonth(monthKey) 清该 kind 对应数据（仅清流水或仅清单据，**不连带清 runs/diff_rows**），再 importXxxFiles
```

**清月范围（关键）**：

- 流水覆盖导入 → 只 `DELETE FROM acquiring_bill_currency_flow_imports WHERE month_key=?`
- 单据覆盖导入 → 只 `DELETE FROM acquiring_bill_currency_bill_imports WHERE month_key=?`
- **不连带清 runs / diff_rows**（保留历史 run 记录；新数据导入完用户重跑 run 时，run-repository.clearRunsByMonth 自然覆盖）

> 与 §七 `clearMonth` IPC 的差异：`clearMonth` 清 4 张表（用户主动全清）；本处的覆盖导入只清单侧数据表（流水或单据），保留 runs/diff_rows。

**Peek 性能（fix2 修订）**：yauzl 流式打开 ZIP + sax 流式解析 XML，遇到首条 `<row r="N">`（N≥2）且解析出"账单日期"cell 时立即停 sax + 释放 yauzl。**O(1) 早退出**，单文件 peek < 100ms（不与文件大小成正比）。

**并发防御（fix3 — 嵌套事务防御）**：v0.5 fix2 完成后，用户实测发现"多次快速点击导入按钮"会触发 `cannot start a transaction within a transaction`。根因：Electron 单线程但 async IPC handler 在 `await dialog.showOpenDialog` / `await importFn` 时让出 event loop，第二个 click 触发的 handler 进入 `sessionOverwrite.BEGIN`，与第一个 click 流程中已开启的事务嵌套。

**fix3 双重保护**：
- **后端 handler 级 mutex**：`acquiringBillCurrencyImportLock.inFlight` 全局 flag；handler 入口检查，若已 inFlight 立即返回 `{ status: 'error', message: '当前已有导入任务在执行...' }`；try/finally 保证释放。
- **前端按钮禁用**：renderer `runAcquiringBillCurrencyImport(kind)` 入口禁用 4 个按钮（importFlow / importBill / run / export），finally 恢复 + 调 `refreshAcquiringBillCurrencyStatus` 按当前状态重置 Run/Export 启用。
- **session.js 鲁棒化**（容错性补强）：`safeRollback` 吞掉"no active txn"错；`safeBegin` 不主动清理（会破坏正在进行的事务），仅作为常规 `db.exec('BEGIN')` 的别名。所有 catch 块用 `safeRollback` 避免 ROLLBACK 异常丢主错。

---

### 3.5 Reader 实现（fix2 — yauzl + sax 流式）

**fix2 背景**：v0.3 spec 假设 SheetJS dense 模式可读单文件 100w 行 1-1.5GB。用户实测 16 个 xlsx（每个 30w 行 / **解压 800MB**）失败：
- ❌ **SheetJS dense**：fflate（SheetJS 内嵌 ZIP 解压器）严格校验 local file header 的 `uncompressedSize` 字段，POI 流式写入 xlsx 用 ZIP **data descriptor** 模式（local header size 字段写 0，size 在 entry 数据后 / central directory 中给出），fflate 直接抛 `Bad uncompressed size: N != 0` → `workbook.Sheets[name]` 为 undefined → `sheet_to_json` 返回 `[]` → 错误提示"xlsx 内无数据"误导
- ❌ **ExcelJS streaming**：依赖 `unzipper` 库，同样不支持 data descriptor → `invalid signature: 0x41d`
- ✅ **yauzl**：纯 JS ZIP 流式库（Node 生态最稳定，明确支持 data descriptor + ZIP64），单文件 < 100ms 解压头 entry / sheet1.xml 可流式读取

**实际数据规模**（用户 2026-05-18 提供）：
- 单文件：30 万行 × 48 列，cell 用 `t="inlineStr"` 格式（内联字符串，不走 sharedStrings），单文件解压 832 MB
- 单月：16 个 xlsx → ~480 万行
- sharedStrings.xml：空（`count="0"`）

**新选型 = yauzl + sax**：

```
filePath
  │
  └─ yauzl.open() → entries listing
       │
       └─ openReadStream('xl/worksheets/sheet1.xml') → Readable stream
            │
            └─ pipe → sax.SAXStream (event-based)
                 ├─ on <row r=N> → 新建当前行 buffer
                 ├─ on <c r="A1" t="inlineStr"> → 记列号 + 类型
                 ├─ on <t> text → 写入当前 cell
                 ├─ on </c> → 写入当前行 values 数组
                 └─ on </row> → 调 insertRow（prepared INSERT）→ 释放行 buffer
```

**关键不变量**：
- yauzl `lazyEntries: false` 默认；listing 找到 `xl/worksheets/sheet1.xml` 后 openReadStream
- sax 同步 event-driven，prepared INSERT 同步 `.run()`，**无背压问题**（SQLite INSERT 阻塞拉取速度等于解压速度）
- 内存常驻：当前行 buffer（48 cell × 平均 30 字节 ≈ 1.5 KB）+ sax 状态机 ≈ 几 MB
- 单文件总 RAM：< 50 MB
- 跨平台：yauzl + sax 纯 JS，无 native 编译；Windows / macOS / Linux 一致

**Cell 类型识别**：

| `<c t="?">` 值 | 含义 | 取值路径 |
|---|---|---|
| `inlineStr` | 内联字符串（**本次数据用此格式**） | `<is><t>VALUE</t></is>` |
| `s` | sharedStrings 引用 | `<v>INDEX</v>` → 查 sharedStrings.xml |
| `str` | 公式结果字符串 | `<v>VALUE</v>` |
| `b` | 布尔 | `<v>0|1</v>` |
| `e` | 错误 | `<v>#REF!</v>` |
| 默认（无 t） | 数字 | `<v>VALUE</v>` |

**空 cell 补齐**：xlsx 可能跳过空 cell（如 `<c r="A1"/><c r="C1">...`），按 `r` 属性的列号补齐空字符串到正确位置。

**错误处理**：
- yauzl 打开失败（非 xlsx / 损坏）→ `ImportValidationError` `${file}：xlsx 解析失败：${msg}`
- 找不到 `xl/worksheets/sheet1.xml` → `ImportValidationError`
- sax 错误（XML 损坏）→ `ImportValidationError`
- 单行业务校验失败（账单日期 / 主对账Id / 金额）→ 累积到 errors[]，最多 100 条，最终 ROLLBACK + 整批拒绝（与 v0.3 行为一致）

---

## 四、SQLite DDL

### 4.1 表 1：`acquiring_bill_currency_flow_imports`（流水表数据，v0.7 字段重命名）

```sql
CREATE TABLE IF NOT EXISTS acquiring_bill_currency_flow_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month_key TEXT NOT NULL,                  -- YYYY-MM
  source_file TEXT NOT NULL,                -- 源 xlsx 文件名（多文件场景区分）
  source_row_index INTEGER NOT NULL,        -- 源 xlsx 内行号（1-based，含表头偏移）
  recon_main_id TEXT NOT NULL,              -- 对账主Id（关联 key，不变）
  settle_amount TEXT NOT NULL,              -- v0.7：通道清算金额（v0.6 名为 recon_amount，取 Excel 第 13 列「对账金额」）
  settle_amount_abs TEXT NOT NULL,          -- v0.7：ABS(settle_amount)（v0.6 名为 recon_amount_abs）
  settle_currency TEXT,                     -- v0.7：通道清算币种原值（v0.6 名为 currency，取 Excel 第 14 列「币种」）
  settle_currency_norm TEXT,                -- v0.7：LOWER+TRIM 归一值（v0.6 名为 currency_norm）
  raw_json TEXT NOT NULL,                   -- 其余 44 列 JSON 序列化，留底用
  imported_at TEXT NOT NULL,                -- ISO 时间戳
  UNIQUE (month_key, recon_main_id)         -- ★ 月内主Id 唯一约束（重复 → INSERT 失败 → 整批 rollback）
);

CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_month
  ON acquiring_bill_currency_flow_imports (month_key);
CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_join
  ON acquiring_bill_currency_flow_imports (month_key, recon_main_id);
```

**v0.7 字段重命名映射**：
| v0.6 列名 | v0.7 列名 | Excel 列号变化 | 备注 |
|---|---|---|---|
| recon_amount | **settle_amount** | 第 13 列「对账金额」→ **第 29 列「通道清算金额」** | 入库取值列号 `values[12]` → `values[28]` |
| recon_amount_abs | **settle_amount_abs** | — | 同上派生 |
| currency | **settle_currency** | 第 14 列「币种」→ **第 30 列「通道清算币种」** | 入库取值列号 `values[13]` → `values[29]` |
| currency_norm | **settle_currency_norm** | — | LOWER+TRIM 归一逻辑不变 |

### 4.2 表 2：`acquiring_bill_currency_bill_imports`（单据表数据，v0.7 同步重命名）

```sql
CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month_key TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_row_index INTEGER NOT NULL,
  recon_main_id TEXT NOT NULL,
  settle_currency TEXT,                     -- v0.7：单据「对账币种」原值（v0.6 名为 currency；语义本就是清算视角，列号不变 values[19]）
  settle_currency_norm TEXT,                -- v0.7：LOWER+TRIM 归一值（v0.6 名为 currency_norm）
  raw_json TEXT NOT NULL,                   -- 其余 25 列 JSON 序列化，导出时还原
  imported_at TEXT NOT NULL,
  UNIQUE (month_key, recon_main_id)
);

CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_month
  ON acquiring_bill_currency_bill_imports (month_key);
CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join
  ON acquiring_bill_currency_bill_imports (month_key, recon_main_id);
```

### 4.3 表 3：`acquiring_bill_currency_runs`（运行记录）

```sql
CREATE TABLE IF NOT EXISTS acquiring_bill_currency_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month_key TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  total_bill_rows INTEGER NOT NULL,
  matched_rows INTEGER NOT NULL,
  mismatch_rows INTEGER NOT NULL,       -- 币种不一致行数（新增列有值的行）
  unmatched_rows INTEGER NOT NULL,      -- 单据有但流水无的行数
  status TEXT NOT NULL                  -- 'success' | 'failed'
);
```

### 4.4 表 4：`acquiring_bill_currency_diff_rows`（差异结果，运行后写入）

```sql
CREATE TABLE IF NOT EXISTS acquiring_bill_currency_diff_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  bill_import_id INTEGER NOT NULL,      -- 关联 bill_imports.id
  flow_currency TEXT,                   -- ★ 新增列 1 值（v0.7：来自 flow.settle_currency 即「通道清算币种」）
  flow_amount_abs TEXT,                 -- ★ 新增列 2 值（v0.7：来自 flow.settle_amount_abs 即「通道清算金额绝对值」）
  diff_type TEXT NOT NULL,              -- 'currency_mismatch' | 'bill_currency_missing'
  FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
  FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
);

CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_diff_run
  ON acquiring_bill_currency_diff_rows (run_id);
```

> v0.7：`diff_rows.flow_currency` / `flow_amount_abs` 列名保持（避免 schema 二次变更），但**存储语义指向通道清算**（不再是订单视角）。writer 输出 xlsx 第 28/29 列标签同步改为「流水_通道清算币种」/「流水_通道清算金额」明示语义。

### 4.5 migration 入口

- v0.1-v0.6：`migration_v2_1_6_acquiring_bill_currency`（4 张表 IF NOT EXISTS 建表，**幂等**）
- v0.7 新增：`migration_v2_1_6_fix4_rename_settle_columns`（ALTER TABLE RENAME COLUMN 重命名 6 列，**幂等**：先 PRAGMA table_info 检查是否已重命名再决定是否执行）

---

## 五、算法（运行对账核心）

### 5.1 函数签名

**文件**：`src/main-process/acquiring-bill-currency-session.js`（新建）

```js
async function runAcquiringCurrencyCheck({ db, monthKey, runAt }) {
  // 1. 校验月份内 flow_imports / bill_imports 都已就绪
  // 2. 一次 SQL：JOIN flow ↔ bill 按 (month_key, recon_main_id)，比较 settle_currency_norm（v0.7）
  // 3. 不一致行写入 diff_rows（含 flow_currency = f.settle_currency / flow_amount_abs = f.settle_amount_abs）
  // 4. 写 runs 记录
  // 5. 返回 { runId, totalBillRows, matchedRows, mismatchRows, unmatchedRows }
}
```

### 5.2 核心 SQL（一次 JOIN 完成对账，v0.7 字段名更新）

```sql
INSERT INTO acquiring_bill_currency_diff_rows (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
SELECT
  ?,                                   -- run_id 由 caller 传入
  b.id,
  f.settle_currency,                   -- v0.7：通道清算币种（v0.6 是 f.currency）
  f.settle_amount_abs,                 -- v0.7：通道清算金额绝对值（v0.6 是 f.recon_amount_abs）
  CASE
    WHEN b.settle_currency_norm IS NULL OR b.settle_currency_norm = '' THEN 'bill_currency_missing'
    ELSE 'currency_mismatch'
  END
FROM acquiring_bill_currency_bill_imports b
INNER JOIN acquiring_bill_currency_flow_imports f
  ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
WHERE b.month_key = ?
  AND COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '');
```

v0.7 说明：
- WHERE 条件直接比较入库时归一好的 `settle_currency_norm`（不在 SQL 里跑 LOWER+TRIM），节省 466 万行 × 2 次函数调用开销
- diff_rows.flow_currency 存原值（`f.settle_currency`）而非归一值，writer 输出时给财务展示原文

⚠️ 资金红线：写入 `flow_amount_abs` 时必须确保 `recon_amount_abs` 在入库时已 ABS（spec §3.1 + reader 实现）。

### 5.3 归一函数

```js
function normalizeCurrency(value) {
  return String(value || '').trim().toLowerCase();
}
```

### 5.4 启动期孤儿数据 cleanup（fix10）

**问题来源**：fix8 + fix9 保证「run 成功完成后」清原始数据，但 **run 中途闪退/异常退出**（典型：fix7 之前 OOM，或用户 force quit）时 — `diff_rows` 已 INSERT 部分 + `flow_imports` / `bill_imports` 完整 + `runs` 状态停在 `'running'`，且重启后无人清理。用户实测此场景把 DB 撑到 15 GB，磁盘 97% 满，下次 INSERT 直接 `database or disk is full`。

**契约**：

| 维度 | 行为 |
|---|---|
| 触发时机 | `app.whenReady()` 完成 + DB migration 完成后，`setImmediate` 后台异步触发，不阻塞窗口 ready |
| 检测口径 | `acquiring_bill_currency_runs` 中 `status != 'success'` 的所有 run（包括 `'running'` / `'failed'` / `'error'`），及其关联 `diff_rows`（按 run_id）+ `flow_imports`/`bill_imports`（按 month_key） |
| 清理范围 | 复用 fix9 的 `cleanupAfterRunBackground`：分批 DELETE 每批 50,000 + `setImmediate` 让出 event loop；最后 DELETE 孤儿 run 记录本身 |
| 并发安全 | cleanup 期间持有 `acquiringBillCurrencyOperationLock` operation = `'cleanup'`；用户点击导入/对账/导出按钮 → 提示「正在清理上次未完成的对账数据，请稍后再操作」 |
| 用户感知 | 主面板状态栏（acquiringBillCurrencyStatus 文案）显示「清理上次未完成的对账数据中…」；cleanup 完成自动清状态 + 释放 lock |
| 失败容忍 | cleanup 抛错只记 log（`logActivity`），不阻塞应用使用（用户可手动后续操作触发新 run，新 run 完成后 fix8 会再清一次） |

**函数签名**：

```js
// src/main-process/acquiring-bill-currency-session.js
async function cleanupOrphanData({ db, onProgress }) {
  // 1. SELECT run_id, month_key FROM acquiring_bill_currency_runs WHERE status != 'success'
  // 2. for each orphan run:
  //    a. cleanupAfterRunBackground({ db, monthKey: run.monthKey, runId: run.id, onProgress })
  //    b. DELETE FROM acquiring_bill_currency_runs WHERE id = run.id
  // 3. 额外兜底：清没有 run 关联的孤儿 imports（month_key 存在 imports 但没任何 success run record）
  // 4. return { orphanRunCount, deletedRows: { flow, bill, diff, runs } }
}
```

**main.js 启动钩子**：

```js
app.whenReady().then(async () => {
  await runMigrations(db);
  // ... 其他启动逻辑 ...
  createWindow();

  // fix10：后台异步 cleanup 孤儿数据，不阻塞 UI
  setImmediate(async () => {
    const lock = tryAcquireOpLock('cleanup', null);
    if (!lock.acquired) return; // 不应该发生（启动时无其他操作）
    try {
      await cleanupOrphanData({ db, onProgress: (msg) => emitStatus(msg) });
    } catch (err) {
      logActivity('[acquiring-bill-currency] startup cleanup failed: ' + err.message);
    } finally {
      releaseOpLock();
    }
  });
});
```

**与 fix9 的差异**：
- fix9 cleanup 时机 = run 正常完成后；fix10 cleanup 时机 = 应用启动时
- fix9 知道精确的 `runId` + `monthKey`；fix10 要先查表找出所有"孤儿"
- 两者共用 `cleanupAfterRunBackground` 底层分批逻辑

---

## 六、Writer（流式输出修改后单据 xlsx）

### 6.1 函数签名

**文件**：`src/main-process/acquiring-bill-currency-writer.js`（新建）

```js
async function writeDiffWorkbook({ db, monthKey, runId, sourceBillFile, savePath }) {
  // 1. SQL 查 diff_rows JOIN bill_imports：
  //    SELECT b.raw_json, d.flow_currency, d.flow_amount_abs
  //    FROM acquiring_bill_currency_diff_rows d
  //    JOIN acquiring_bill_currency_bill_imports b ON b.id = d.bill_import_id
  //    WHERE d.run_id = ? AND b.source_file = ?
  //    ORDER BY b.source_row_index ASC
  // 2. ExcelJS streaming writer 写入 29 列：
  //    - 第 1-26 列：JSON.parse(b.raw_json) 还原原单据值
  //    - 第 27 列：单据_对账币种 = raw_json['对账币种']
  //    - 第 28 列：流水币种 = d.flow_currency
  //    - 第 29 列：流水金额绝对值 = d.flow_amount_abs
  // 3. 若该 source_file 无 diff_rows → 仅写入表头
  // 4. apply watermark（Module A helper，lastModifiedBy='pzhong'）
}
```

### 6.2 输出列约定（29 列，仅差异行，v0.7 列名更新）

**输出文件性质**：差异表（**仅含币种不一致 + 单据币种缺失的行**），不是单据全表。

**列结构**：

| 列号 | 列名 | 来源 |
|---|---|---|
| 1-26 | 单据表原 26 列（列名 / 顺序 / 值完全保留，含原"对账金额"在第 19 列、"对账币种"在第 20 列） | bill_imports.raw_json 还原 |
| **27** | **`单据_对账币种`** | 单据 raw 第 20 列 copy 到末尾对比区（v0.7 不变） |
| **28** | **`流水_通道清算币种`**（v0.7，原名「流水币种」） | 流水侧 `settle_currency` 原值（不归一），来自 Excel 第 30 列「通道清算币种」 |
| **29** | **`流水_通道清算金额`**（v0.7，原名「流水金额绝对值」） | `settle_amount_abs` = ABS(流水侧第 29 列「通道清算金额」) |

**v0.7 列名变更说明**：
- 用户拍板：输出标签明示"清算视角"，避免财务误以为是订单视角
- DB 字段 `diff_rows.flow_currency` / `flow_amount_abs` 名字不变（避免 schema 二次变更），仅 writer 写表头时映射

**列名解释**：
- copy 列加 `单据_` 前缀与右侧 `流水_通道清算币种` 形成"单据 vs 流水"对称（仅币种 copy，金额不 copy — 用户决策）
- 末尾 3 列构成"单据.币种 / 流水.通道清算币种 / 流水.通道清算金额"对比区，财务一眼判币种差异；原"对账金额"在第 19 列保持不变可作辅助参考

**行选择规则**：
- ✅ 入表：`diff_type IN ('currency_mismatch', 'bill_currency_missing')`
- ❌ 不入表：币种一致行（即便 INNER JOIN 上）
- ❌ 不入表：单据有 ID 但流水无对应 ID 的行（unmatched，仅在 `runs.unmatched_rows` 计数；本迭代不输出 unmatched 单独报告）

### 6.3 输出规则（v0.14 fix11 + fix13 联合调整）

**演进历史**：
- v0.3 拍板「1 对 1 多文件输出」
- v0.8 fix5 反转为「单文件单 sheet 合并」
- **v0.14 fix11 + fix13 再调整**：单文件 **N+1 个 sheet** = N 个差异 sheet（按账单日期切分 ≤ 1,048,575 行/sheet）+ 1 个末尾 sheet「运行结果汇总」（fix13 把 report 嵌入）

**触发 fix11 的根因**：用户 v0.13 实测 2026-03 单月 **2,596,169** 差异行 → 单 sheet 写入 xlsx 文件物理上可以承载（实测 sheet1.xml 含 2596170 row 标签），但 **Excel / WPS / Numbers 单 sheet 显示上限 = 1,048,576 行（含表头）= 2^20**（Microsoft 自 Excel 2007 起的硬限制）。用户打开看到「100 万出头」实际是被应用层截断。

**触发 fix13 的根因**：用户希望「运行结果汇总在差异表的最后一个 sheet」，独立的 `report.xlsx` 用户难记得去 `report/` 子目录找。

**v0.14 新规则**：

- 跑「开始运行」时**同步产出 1 个文件**到 `Documents/网银账单生成小助手/exports/{date}/acquiring-bill-currency/`：
  - **`{date}/acquiring-bill-currency/{filename}-diff-{HHMMSS}.xlsx`** — 唯一输出文件：
    - **Sheet 1..N**：差异表（每 sheet ≤ 1,048,575 数据行，命名 `YYYY-MM-DD~MM-DD` 按账单日期升序，详见 §6.3.1）
    - **Sheet N+1**：「运行结果汇总」（嵌入 11 区块 report，详见 §6.4）
- ❌ **不再生成独立 report.xlsx**（fix13）；旧 runs 表中 `report_file_path` 字段保留兼容（值 = `diff_file_path`，指向同文件）
- 「导出差异」= 弹月份选择 → 弹 saveDialog → **fs.copyFile** 已生成的 diff.xlsx 到用户选的路径（不重新生成）
- **0 差异行场景**：仍输出 diff.xlsx（含表头 29 列 + 0 数据行 + 1 sheet 「运行结果汇总」），report 显示 mismatch=0
- 输出文件名 `{filename}` = `acquiring-bill-currency-{monthKey}`，例 `acquiring-bill-currency-2026-03-diff-094355.xlsx`

#### 6.3.1 差异 sheet 按账单日期切分（fix11）

**算法**：
1. **Pass 1**：SQL 统计每个 bill 账单日期的差异行数（JOIN bill_imports 拿 raw_json '账单日期' 字段）
2. **贪心切分**：按账单日期升序遍历，累计行数超过 1,048,575 时切到下一 sheet（同一日期内的行不切开）
3. **Sheet 命名**：`{YYYY-MM-DD}~{MM-DD}` 格式（start 含完整年月日，end 用 MM-DD），例 `2026-03-01~03-13`
4. **Pass 2**：SQL `SELECT ... ORDER BY 账单日期 ASC + LIMIT/OFFSET 5000` 流式分批拉，按账单日期路由到对应 sheet 的 `addRow().commit()`

**资金红线 ⚠️**：
- `sum(sheet.dataRowCount) == runs.mismatch_rows` 必须严格相等，否则报 sanity check 错（数据丢失）
- 行级 cell 内容不变（仅分布到不同 sheet）

**fix11 vs fix7 关系**：fix7 已用 ExcelJS streaming writer + SQL LIMIT/OFFSET 分批；fix11 在此基础上加「按账单日期分桶到不同 worksheet」+ 「per-batch 路由」。

#### 6.3.2 运行结果汇总 sheet（fix13）

末尾固定 1 个 sheet，名 `运行结果汇总`，内容与原 report.xlsx 完全一致（§6.4 的 11 区块）。

writer 实现：在 §6.3.1 末尾追加 `wb.addWorksheet('运行结果汇总')`，写 11 区块完成后 commit。整个 workbook 用同一个 streaming writer 一次 commit 产出（避免独立 report.xlsx 文件）。

### 6.4 结果表 report 输出（v0.8 fix5 新增；v0.14 fix13 嵌入 diff 末尾 sheet）

跑「开始运行」时自动生成「运行结果汇总」sheet，内容是 11 区块汇总（用户拍板「越详细越好」）。

**v0.14 fix13 路径变更**：
- 旧（v0.8 - v0.13）：独立文件 `Documents/网银账单生成小助手/exports/{date}/acquiring-bill-currency/report/{filename}-report-{HHMMSS}.xlsx`
- **新（v0.14+）**：嵌入 diff xlsx 的末尾 sheet「运行结果汇总」，不再独立文件

**Sheet 内容（按区块布局，单元格用 `key | value` 二列）**：

| 区块 | 内容 |
|---|---|
| **① 基础统计** | run 时间戳 / 月份 / 状态 / 单据总数 (total_bill_rows) / matched_rows / mismatch_rows / unmatched_rows |
| **② 流水侧统计** | 流水总数 / 流水 distinct recon_main_id 数 / 流水多于单据行数（orphan flow） |
| **③ 单据侧统计** | 单据总数 / 单据 distinct recon_main_id 数 |
| **④ 流水币种分布** | 各币种行数（按 settle_currency_norm 分组，DESC，前 20）|
| **⑤ 单据币种分布** | 各币种行数（按 settle_currency_norm 分组，DESC，前 20）|
| **⑥ diff_type 分布** | currency_mismatch 行数 + bill_currency_missing 行数 |
| **⑦ 差异行币种对比 top 10** | (单据币种, 流水币种, 行数) 三元组按行数 DESC |
| **⑧ 文件清单** | 流水侧每个 source_file + 行数（含每月汇总）|
| **⑨ 文件清单（单据）** | 单据侧每个 source_file + 行数 |
| **⑩ 性能数据** | run 总耗时（s）/ 差异行写入耗时 / DB 大小（KB）|
| **⑪ 元信息** | app 版本（package.json.version）/ git short SHA（build-info）/ 生成时间 / 作者「pzhong」（Module A 痕迹）|

**写入实现（v0.14 fix13）**：在 fix11 的 streaming writer 末尾 `addWorksheet('运行结果汇总')`，11 区块用 `sheet.addRow({...}).commit()` 流式写入。不再独立 Workbook。

**v0.14 fix12 时区修复**：① 写入「运行时间」字段前，把 `runs.ran_at`（ISO 8601 带 Z 后缀 / 兼容旧的 SQLite UTC 字符串）解析为 Date → `toLocaleString` 转本地时区显示（格式 `YYYY-MM-DD HH:MM:SS`）；② run-repository.insertRun 显式传 `ranAt = new Date().toISOString()`（带 Z）保证语义明确；③ 兼容：DB 里旧的无 Z 字符串（fix12 之前的 record）被 writer 当 UTC 解析。

### 6.6 时区显示（v0.14 fix12）

**问题**：v0.8 - v0.13 阶段 `acquiring_bill_currency_runs.ran_at` 字段依赖 SQLite schema `DEFAULT CURRENT_TIMESTAMP`，`CURRENT_TIMESTAMP` 返回 **UTC 时间字符串**（格式 `YYYY-MM-DD HH:MM:SS` 无时区标记）。writer 把 `run.ran_at` 直接写到 report sheet，用户看到「运行时间」是 UTC 时间（北京时区差 8h）。

**修复**：

| 层 | 改动 |
|---|---|
| `run-repository.js insertRun` | 接 `ranAt` 参数（默认 `new Date().toISOString()` 带 Z 后缀），INSERT 时显式传值；schema DEFAULT 保留作 fallback |
| `session.js runCheck` | 调 `insertRun` 时显式传 `ranAt: new Date().toISOString()` |
| `writer.js 「运行时间」` 字段 | 解析 `run.ran_at` → 转本地时区 → 格式化为 `YYYY-MM-DD HH:MM:SS`（本地） |
| 兼容 | 旧数据无 Z 后缀（fix12 前的 record）→ writer 按 UTC 解析（`new Date(s + 'Z')`）|

**时区解析函数**：

```js
function formatRanAtLocal(ranAt) {
  if (!ranAt) return '';
  // 兼容 ISO 8601 带 Z 后缀（fix12 后新数据） + 无 Z 字符串（fix12 前旧数据，按 UTC 解析）
  const hasTz = /Z$|[+-]\d{2}:\d{2}$/.test(ranAt);
  const d = new Date(hasTz ? ranAt : ranAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return ranAt;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

⚠️ 不命中 important-variables；不影响差异表内容；仅 report sheet 「运行时间」显示行。

### 6.5 error_report 输出（v0.6 沿用）

仅在以下情形产出，**走现有 `src/backend/file-service/error-causes.js` 体系**：
- 流水表导入：主对账Id 重复
- 单据表导入：主对账Id 重复
- 表头不匹配
- 跨月份混杂（v0.8：包含「文件月份与用户选月份不一致」）

路径：`Documents/网银账单生成小助手/error-reports/{date}/`，文件名沿用 `logger.js writeErrorReport` 规范。

---

## 七、IPC schema

| IPC channel | 入参 | 出参 | 说明 |
|---|---|---|---|
| `acquiringBillCurrency:importFlow` | v0.8：`{ monthKey, filePaths?, confirmOverwrite? }`（monthKey 必填，来自前端弹窗） | 成功：`{ status:'success', monthKey, fileCount, totalImported }`；需确认：`{ status:'overwrite-required', monthKey, existingCount, filePaths }`；取消：`{ status:'cancelled' }`；月份冲突：`{ status:'error', message:'文件月份 X 与所选月份 Y 不一致' }` | 流水表导入（v0.8：用户先选月份再选文件） |
| `acquiringBillCurrency:importBill` | 同上（existingCount 对应单据表行数） | 同上 | 单据表导入 |
| `acquiringBillCurrency:listMonths` | 无 | `string[]` | 已导入月份列表（仅供「导出差异」弹窗的「最近 run 月份」回显，v0.8 月份下拉删后部分场景仍可调）|
| `acquiringBillCurrency:run` | `{ monthKey }` | v0.14：`{ runId, totalBillRows, matchedRows, mismatchRows, unmatchedRows, diffFilePath, reportFilePath }`（v0.14 fix13：`reportFilePath === diffFilePath`，指向同一文件；renderer 兼容字段名保留）| 跑对账 + **同步产出 1 个 diff.xlsx**（含 N 个差异 sheet + 1 个「运行结果汇总」sheet；spec §6.3 / §6.4）|
| `acquiringBillCurrency:export` | v0.8：`{ monthKey, savePath? }`（无 savePath 时弹 saveDialog）| `{ savedPath, sourceDiffPath }` | **另存为**最近一次 run 的 diff.xlsx 到用户选路径（不重新生成；fs.copyFile）|
| `acquiringBillCurrency:sessionStatus` | `{ monthKey? }` | `{ monthKey, flowReady, billReady, latestRun }` | UI 刷新 |
| `acquiringBillCurrency:clearMonth` | `{ monthKey }` | `{ ok }` | 清空某月数据（用户主动；清 4 张表） |

合计 **7 个 IPC**。

**importFlow / importBill 行为细节（fix1）**：

- 无入参（renderer 第 1 次调用）：
  - 弹 dialog.showOpenDialog 多选 xlsx
  - 取消 → `{ status: 'cancelled' }`
  - 选定 → peek 首文件首行 → 取 monthKey
  - peek 失败（表头/账单日期错） → `{ status: 'error', message, detailLines }`
  - 查 DB 该月份已有行：`getMonthReadiness(db, monthKey)`
  - 已有行 > 0 且未带 `confirmOverwrite` → `{ status: 'overwrite-required', monthKey, existingCount, filePaths }`
  - 已有行 === 0 → 直接进 `importXxxFiles` 大事务 → `{ status: 'success', ...result }`
- 带 `{ filePaths, confirmOverwrite: true }`（renderer 二次调用）：
  - **跳过 dialog**（直接用入参 filePaths）
  - **跳过 peek 复查**（信任 renderer 已确认）
  - 先 `DELETE FROM acquiring_bill_currency_xxx_imports WHERE month_key=?`（仅清单侧）
  - 再进 `importXxxFiles` 大事务 → `{ status: 'success', ...result }`

**preload.js 暴露**：

```js
contextBridge.exposeInMainWorld('desktopApi', {
  // ... 现有 ...
  acquiringBillCurrency: {
    importFlow: (payload) => ipcRenderer.invoke('acquiringBillCurrency:importFlow', payload),
    importBill: (payload) => ipcRenderer.invoke('acquiringBillCurrency:importBill', payload),
    listMonths: () => ipcRenderer.invoke('acquiringBillCurrency:listMonths'),
    run: (payload) => ipcRenderer.invoke('acquiringBillCurrency:run', payload),
    export: (payload) => ipcRenderer.invoke('acquiringBillCurrency:export', payload),
    sessionStatus: (payload) => ipcRenderer.invoke('acquiringBillCurrency:sessionStatus', payload),
    clearMonth: (payload) => ipcRenderer.invoke('acquiringBillCurrency:clearMonth', payload)
  }
});
```

---

## 八、前端面板设计

### 8.1 主面板骨架（v0.15 fix14：以 bank-statement-board 为模板左右镜像）

**v0.15 fix14 决策**：参考已有 `bankStatementModulePanel`（v1.x「网银账单生成助手」主模块）布局，**左右镜像**作为收单单据币种校验的新结构，让用户视觉上区分两个模块但保持设计语言一致。映射关系：

| 原（v0.8-v0.14 简单 2 行 4 按钮）| 新位置（bank-statement 镜像后）|
|---|---|
| 导入流水表（primary）| Row 1 / 左 cell / pair 左 1（对应 bank-statement「导入文件」镜像）|
| 导入单据表（primary）| Row 1 / 左 cell / pair 右 1（对应 bank-statement「开始运行」镜像）|
| 开始运行（primary）| Row 1 / 右 cell 独占（对应 bank-statement「场景管理」镜像）|
| 状态框 | Row 2 / 左 cell 独占（对应 bank-statement 状态框镜像）|
| 导出差异（secondary）| Row 2 / 右 cell 独占（对应 bank-statement「导出文件」镜像）|

```html
<section id="acquiringBillCurrencyModulePanel" class="control-board module-panel acquiring-bill-currency-board" hidden>
  <div class="control-row">
    <div class="cell left">
      <div class="pending-action-pair">
        <button id="acquiringBillCurrencyImportFlowBtn" class="primary-btn" type="button">导入流水表</button>
        <button id="acquiringBillCurrencyImportBillBtn" class="primary-btn" type="button">导入单据表</button>
      </div>
    </div>
    <div class="cell right">
      <button id="acquiringBillCurrencyRunBtn" class="primary-btn" type="button">开始运行</button>
    </div>
  </div>
  <div class="control-row">
    <div class="cell left">
      <div id="acquiringBillCurrencyStatusBox" class="status-box">...</div>
    </div>
    <div class="cell right">
      <button id="acquiringBillCurrencyExportBtn" class="secondary-btn" type="button">导出差异</button>
    </div>
  </div>
</section>
```

**CSS 关键规则**（`.acquiring-bill-currency-board`，在 `src/styles-gemini-extra.css`）：
- `.acquiring-bill-currency-board .control-row { grid-template-columns: 1.4fr 1fr; }`（**bank-statement 原版是 1fr 1.4fr，镜像后调换**：左变宽 1.4fr，右变窄 1fr）
- `.acquiring-bill-currency-board .cell.left, .cell.right { display: flex; justify-content: center; }`（cell 内容居中）
- `.acquiring-bill-currency-board .pending-action-pair { display: flex; gap: 12px; justify-content: center; }`
- **按钮尺寸严格镜像 bank-statement**：
  - **pair 内 primary**（导入流水表 / 导入单据表）= `min-width: 140px; height: 48px`（对齐 bank-statement 的「导入文件 / 开始运行」）
  - **独占 right cell**（开始运行 primary / 导出差异 secondary）= `min-width: 180px; height: 48px`（对齐 bank-statement 的「场景管理 / 导出文件」secondary 180px 规则）
  - 所有独占 cell 按钮加 `flex: none` 覆盖 styles-gemini.css 全局 `.cell.right .primary-btn { flex: 1 }`（否则被 stretch）
- **状态框**：加入 `.pending-board, .bank-statement-board, .acquiring-bill-currency-board` 共享规则（max-width 360px / min-height 110px / 圆角 18 / 白底 / 左对齐多行）

**v0.15 fix14 vs v0.8 fix5 变更**：
- 旧（v0.8-v0.14）：简单 2 行 + 状态框第 3 行 + 按钮等宽撑满（无 cell 概念，按钮在 panel-row 内 flex）
- **新（v0.15）**：2 行 × 2 cell grid（1.4fr : 1fr）；按钮 min-width 140px 居中；从 `.pending-board` 类切换到 `.acquiring-bill-currency-board` 类（自己的命名空间，不再共享 pending-board CSS）
- **按钮 ID 全部保留**：`acquiringBillCurrencyImportFlowBtn` / `ImportBillBtn` / `RunBtn` / `ExportBtn` / `StatusBox`，renderer 监听零改动
- 删 month picker dialog：保留（v0.8 fix5 引入的「按钮 click 触发月份选择弹窗」逻辑不变）
- 4 按钮均默认 enabled（v0.8 fix5 沿用）

### 8.2 状态机

| 状态 | 触发 | 按钮启用情况 |
|---|---|---|
| 初始 | 模块打开 | 仅导入按钮可用 |
| 流水已导 / 单据未导 | 流水导入完成 | 同上 + 当前月份选中后状态显示「待导单据表」 |
| 两者均导入 | 单据导入完成 | `开始运行` 启用 |
| 已运行 | run 完成 | `导出差异` 启用，含结果数 |
| 错误 | 任何阶段失败 | 状态栏红色提示 + 可触发 error_report 导出 |

### 8.3 状态文案

| 场景 | 文案 |
|---|---|
| 初始 | `欢迎使用小助手` |
| 流水导入中 | `导入流水表中（{X}/{Y} 个文件）...` |
| 单据导入中 | `导入单据表中（{X}/{Y} 个文件）...` |
| 运行中 | `对账中（已处理 {N} 行）...` |
| 运行完成 | `对账完成：共 {M} 条单据，{N} 条币种不一致，{K} 条未匹配上流水` |
| 错误 | `错误：{原因}（点击查看 error_report）` |
| 覆盖确认（fix1） | `检测到月份 {monthKey} 已有 {existingCount} 行 {流水/单据} 数据，是否覆盖重导？` |

### 8.4 覆盖确认弹窗（fix1）

**触发**：renderer 调用 `importFlow()` 或 `importBill()` 后，收到 `{ status: 'overwrite-required', monthKey, existingCount, filePaths }`。

**弹窗形态**：原生 `window.confirm`（项目内现有简单确认场景沿用 `confirm`，参考 `src/renderer.js` 中 reconIdFix / bizOpRecon 的覆盖确认）。

**弹窗文案**：

```
检测到月份 {monthKey} 已有 {existingCount} 行{流水表/单据表}数据。
点击「确定」将先清空该月份的{流水表/单据表}数据，再导入本次选择的 {filePaths.length} 个文件。
（仅清单侧数据，不影响该月份对账历史 / 差异结果）

继续？
```

**确认后**：renderer 调用 `importFlow({ filePaths, confirmOverwrite: true })` 或 `importBill({ filePaths, confirmOverwrite: true })`，UI 显示导入中状态，等成功后刷新月份下拉 + 状态栏 + 弹"导入成功 N 行"toast。

**取消**：直接走 `cancelled` 分支，状态栏回到原状，不动 DB。

---

## 九、smoke 用例

| Case | 场景 | 验证点 |
|---|---|---|
| **A** | Happy path：流水 100 行 + 单据 100 行，10 行币种不一致 | 输出 xlsx 含 **29 列**（含 3 个新增列）；**仅 10 行差异行**（不含 90 行一致行）；3 列对比区值正确 |
| **B** | 主对账Id 重复 | 整批拒绝；error_report 含重复 ID 列表；DB 无任何行写入 |
| **C** | 单据币种缺失 | 缺失行 diff_type = 'bill_currency_missing'；第 27 列 = 单据 raw 对账币种（为空字符串）；第 28/29 列 = 流水侧币种/金额绝对值 |
| **D** | 跨多 xlsx 文件（流水 3 个 + 单据 3 个） | 输出 3 个 1 对 1 的差异 xlsx（即使某文件 0 差异行也输出仅表头版）；跨文件 ID 重复整批拒绝 |
| **E** | 币种大小写归一（`usd` vs `USD`） | 视为一致，不写入 diff_rows |
| **F** | 表头不匹配（流水表列数错） | 整批拒绝；error_report 含原因 |
| **G**（可选） | 单据有 ID，流水无对应 ID | 不写入 diff_rows（不命中 INNER JOIN）；run 结果 `unmatched_rows` 字段计数 |
| **H1**（fix1） | 流水/单据已导入 + 二次导入相同月份 + `confirmOverwrite=undefined` | 返回 `{ status:'overwrite-required', monthKey, existingCount, filePaths }`；DB 行数不变；不进事务 |
| **H2**（fix1） | 同 H1 + 二次调用带 `{ filePaths, confirmOverwrite: true }` | 先清该月对应单侧（流水或单据）数据，再 INSERT 新数据；DB 行数 = 新数据行数；不动 runs / diff_rows |
| **H3**（fix1） | 流水/单据 peek 时表头不匹配 | 返回 `{ status:'error', message, detailLines }`；DB 行数不变；不进事务 |
| **I**（fix2） | inlineStr 格式 + ZIP data descriptor 模式 xlsx（用 yazl 构造） | yauzl + sax 解析正确；reader 入库值精度正确 |
| **J**（fix4） | flow.「币种」=USD + flow.「通道清算币种」=EUR + bill.「对账币种」=EUR | matched=1, mismatch=0（按 settle_currency 比对，订单币种不影响） |
| **K**（fix4） | flow.「通道清算币种」=USD + bill.「对账币种」=EUR | mismatch=1, diff_rows.flow_currency='USD'（来自流水 settle_currency 原值） |
| **L**（fix4） | flow.「通道清算币种」='' + bill.「对账币种」=EUR | mismatch=1（spec §5.2 COALESCE 比较，空 ≠ 'eur'）；diff_type='currency_mismatch' |
| **M**（fix5） | xlsx 内月份与弹窗选月份不一致 | reader peek 整批拒绝；error_report.detailLines 含「跨月份混杂」 |
| **N**（fix5） | run 完成 | 返回 `{ diffFilePath, reportFilePath }` 双文件存在 + report sheet 含 11 区块 |
| **O**（fix6） | 流水「通道清算金额」单元格为空 | reader 入库 `settle_amount=''`/`settle_amount_abs=''`，不整批拒绝；run JOIN 跳过空金额行 |
| **P**（fix8/fix9） | run 成功后调 `cleanupAfterRunBackground` | flow/bill/diff_rows 按月清空；runs 保留 + 路径完整；分批 DELETE 不卡 event loop |
| **Q**（fix10） | 人造孤儿 run（status='running' + 关联 imports/diff_rows）+ 调 `cleanupOrphanData` | 孤儿 run 关联表全清；该 run 记录被 DELETE；其他正常 run（status='success'）+ 关联数据不受影响 |
| **R**（fix11） | 跑 run 产生 ≥ 1,048,575 行差异（fixture 用账单日期跨多天 + 大量不一致币种行触发多 sheet）| diff xlsx ≥ 2 个差异 sheet + 每 sheet ≤ 1,048,575 行 + sheet 名格式 `YYYY-MM-DD~MM-DD` + 按起始日升序 + `sum(sheet.dataRowCount) == runs.mismatch_rows`（资金红线对账）|
| **S**（fix12） | 跑 run 后断言 ran_at 时区 | `runs.ran_at` 含 'Z' 后缀（ISO 8601）+ writer report sheet 「运行时间」字段格式 `YYYY-MM-DD HH:MM:SS` 是本地时间（不含 Z）+ `formatRanAtLocal` 函数对带 Z / 不带 Z 输入都正确处理 |
| **T**（fix13） | 跑 run 后断言输出形态 | diff xlsx 末尾 sheet name = `运行结果汇总` + 含 11 区块（行数 ~119）+ exports/ 目录**不再生成** `report/` 子目录 + 不存在独立 report.xlsx + `runs.report_file_path == runs.diff_file_path` |
| **A1**（Module A） | 任意模块导出 xlsx | 文件属性 LastAuthor / lastModifiedBy = `pzhong` |
| **A2**（Module A） | 应用启动 | app_activity_log.txt 含 `crafted by pzhong (pzhong1212@gmail.com) · build {sha}` |

⚠️ 资金红线 Case：B / C / D / **H1 / H2** / **J / K / L** / **Q** / **R**（sum(sheet rows) == mismatch_rows 对账）必须覆盖；A 必须 happy path 通过。

---

## 十、重要变量与受影响范围

### 10.1 新增 Critical 级条目（`rules/important-variables.md`）

| 变量名 | 层级 | 关联功能 | 变更 review 要点 |
|---|---|---|---|
| `acquiring_bill_currency_diff_rows.flow_currency` | **Critical** | Module B 输出 | 写入路径 = SQL `INSERT...SELECT` + writer 第 28 列；任何修改必须复跑 smoke A/C/E/J/K/L（v0.7 内容指向 settle_currency）|
| `acquiring_bill_currency_diff_rows.flow_amount_abs` | **Critical** | Module B 输出 | ABS 逻辑在 reader 入库阶段；与 settle_amount_abs 同源；任何符号/精度调整必须更新 spec §3.1 + §5.2 + 复跑 smoke A |
| `acquiring_bill_currency_flow_imports.settle_amount_abs` | **Critical** | Module B 入库 | v0.7 字段名（v0.6 = recon_amount_abs）；reader 入库时 ABS(values[28])；改 reader 必须复跑 smoke J |
| `acquiring_bill_currency_*.recon_main_id` | **Important-skeleton** | Module B 关联 | 1:1 假设的唯一保证；UNIQUE 约束 + reader 主动校验 |
| `acquiring_bill_currency_flow_imports.settle_currency` / `settle_currency_norm` | **Critical** | Module B 对账核心 | v0.7 新增：对账比对字段；任何字段名/取值列号修改必须更新 spec §3.1 + §4.1 + §5.2 + 复跑 smoke J/K/L |
| `acquiring_bill_currency_bill_imports.settle_currency` / `settle_currency_norm` | **Critical** | Module B 对账核心 | v0.7 字段名（v0.6 = currency）；语义未变（仍是单据「对账币种」），仅 DB 命名同步 |

### 10.2 不命中 important-variables 的部分

Module A 全部不命中（纯元数据）。

### 10.3 提 PR 前必须执行

```bash
npm run check:vars     # 跑 check-vars skill 产出「⚠️ 关联功能 review」段
npm run scan:vars      # 重新生成 docs/analysis/var-reference-stats.md
```

---

## 十一、preview 入口

| 截图 | 触发场景 | 命令 |
|---|---|---|
| acquiring-bill-currency-init.png | 初始进入模块 | `npm run preview:acquiring-bill-currency` |
| acquiring-bill-currency-importing.png | 导入中状态 | 同上 |
| acquiring-bill-currency-result.png | 运行完成态 | 同上 |
| acquiring-bill-currency-export.png | 导出对话框 | 同上 |

`scripts/preview/preview:all` 必须加入新模块的 preview。

---

## 十二、文档变更记录

| 版本 | 日期 | 修订 |
|---|---|---|
| v0.1 | 2026-05-18 | 起草 |
| v0.2 | 2026-05-18 | ① 命名 acquiring-currency → acquiring-bill-currency；② §6.1 writer 函数签名重写为 SQL JOIN diff_rows → bill_imports 输出 30 列；③ §6.2 输出列约定 28 列全表 → 30 列仅差异行（新增 4 列对比区）；④ §6.3 输出文件名 `-checked-` → `-diff-`，加 0 差异行保留表头规则；⑤ §九 Case A/C/D 同步新设计 |
| v0.3 | 2026-05-18 | 用户决策：去掉「单据_对账金额」copy 列。①§6.1 writer 注释 30 列 → 29 列（删第 27 行）；②§6.2 列表 4 行 → 3 行 + 列号重排（27 单据_对账币种 / 28 流水币种 / 29 流水金额绝对值）；③§6.3 表头 30 列 → 29 列；④§九 Case A "30 列/4 列" → "29 列/3 列"；Case C 列号映射同步 |
| v0.4 | 2026-05-18 | **fix1**：用户实测发现"二次导入相同月份 → UNIQUE constraint failed 整批拒绝"UX 漏洞（spec §七 IPC `clearMonth` 已存在但 UI 未接）。新增 §3.4「重复导入检测」+ §七 IPC 入参 `{ filePaths?, confirmOverwrite? }` + 出参 `overwrite-required` 状态 + §8.3 状态文案补「覆盖确认」+ §8.4「覆盖确认弹窗」+ §九 Case H1/H2/H3。流水/单据**对称处理**，覆盖导入只清单侧数据（不连带清 runs/diff_rows）|
| v0.5 | 2026-05-18 | **fix2 reader 选型变更**：用户实测发现 v0.3 SheetJS dense 假设对真实数据（30w 行/文件 + inlineStr 格式 + 800MB 解压 + POI 流式写 ZIP data descriptor）完全不可行。新增 §3.5「Reader 实现（fix2 — yauzl + sax 流式）」详述选型决策 + 实施方式。§3.4 fix1 peek 性能段同步修订为 O(1) 早退出。§九 smoke 加 Case I（inlineStr 解析）+ Case J（data descriptor ZIP）|
| v0.6 | 2026-05-18 | **fix3 嵌套事务防御**：用户实测多次快速点击导入按钮触发 `cannot start a transaction within a transaction`。根因 = async IPC handler 让出 event loop 时 concurrent BEGIN。§3.4「并发防御（fix3）」新增章节：① main.js handler 级 mutex（acquiringBillCurrencyImportLock）② renderer 按钮禁用 ③ session.js safeRollback/safeBegin 命名包装（不主动清理，仅吞 ROLLBACK 二次错）|
| v0.7 | 2026-05-19 | **fix4 对账字段切换**：用户实测 v0.6 用「币种」+「对账金额」（订单视角）做对账时单据全 100% match（466 万行零差异）= 字段语义错位。改用流水侧第 30 列「通道清算币种」+ 第 29 列「通道清算金额」（清算视角），预估抓出 ~259 万行真实差异。DB 字段重命名 recon_amount/recon_amount_abs/currency/currency_norm → settle_amount/settle_amount_abs/settle_currency/settle_currency_norm（流水+单据双侧对称）。§3.1 ★ 标移位，§4.1/4.2 schema 重命名，§5.2 SQL 字段名同步，§6.2 输出列「流水币种」→「流水_通道清算币种」、「流水金额绝对值」→「流水_通道清算金额」。§九 smoke 新增 J/K/L 三个 case。§十 important-variables 字段名同步。⚠️ 用户机器历史 466 万行数据需清月 2026-03 + 重导 |
| v0.8 | 2026-05-19 | **fix5 UX 重构 + 输出形态反转**：① 删除月份下拉，导入/导出按钮 click 触发月份选择弹窗（复用 bankBuRecon 范式，按钮文字「下一步」→「导入」/「导出」）；② §3.3 月份归属规则改为「用户弹窗选 + xlsx 内月份必须一致，不一致整批拒绝」；③ §6.3 决策反转：1 对 1 → **单文件单 sheet 合并输出**（v0.3 拍板作废）；④ §6.4 新增「结果表 report」极详细规范（11 区块单 sheet）；⑤ §七 IPC：run 出参补 diffFilePath + reportFilePath，export 入参 { monthKey, savePath? } 走 fs.copyFile 另存为；⑥ §九 smoke 新增 M（月份冲突拒绝）+ N（run 同步产出 diff/report）。`acquiringBillCurrencyMonthSelect` UI 元素删除 |
| v0.9 | 2026-05-19 | **fix6 通道清算金额允许为空**：用户实测 466 万行中 30,057 行（0.6%）「通道清算金额」为空（4 种非清算流水子类型 S10010706/703/S10030403/406）。fix4 沿用 v0.6「对账金额必填」错；reader 改造：空值入库 `settle_amount=''`/`settle_amount_abs=''`，非空仍走 parseAmountAbs。§3.1 第 29 列备注 + §3.1 导入校验同步；smoke 加 Case O |
| v0.10 | 2026-05-19 | **fix7 diff writer OOM 修复**：用户实测点「开始运行」V8 OOM 闪退（`Ineffective mark-compacts near heap limit`）。根因 = `listAllDiffRowsByRun.all()` 把 259w 差异行 × raw_json ~3KB ≈ 7-8GB 全 load 内存 + ExcelJS 默认 in-memory Workbook。改造：① `writeDiffWorkbook` 改用 `ExcelJS.stream.xlsx.WorkbookWriter`（每行 commit 立即落盘 + `useStyles:false` + `useSharedStrings:false`）；② SQL 用 prepared statement + `LIMIT N OFFSET M` 分批拉取（每批 5000 行）。内存常驻 < 100MB；smoke A 自动覆盖（fixture 小不分批）|
| v0.11 | 2026-05-19 | **fix8 run 后自动清原始数据**：用户实测 DB 累积到 15.2 GB（多次覆盖导入 + 多次 schema 改动 + 未 VACUUM）。决策：DB 里 flow_imports/bill_imports 是临时中转，跑 run 成功生成 diff+report 落盘后自动 DELETE。`session.runCheck` 在 writeRunOutputs + updateRunPaths 后 `fs.existsSync` 校验双文件 → 单独事务 DELETE flow_imports + bill_imports + diff_rows（按 month_key + run_id）。**保留 runs**（含路径 + 统计）供「导出差异」用。同月份重跑 run 须重新导表（getMonthReadiness 看不到 flow/bill 数据 → 报错）。smoke 加 Case P |
| v0.12 | 2026-05-19 | **fix9 cleanup 异步后台 + 通用 operation lock**：用户实测 fix8 同步 cleanup 在 466w+462w+259w 行下耗时几分钟，期间 UI not responding。改造：① `session.runCheck` 不再调 cleanup，改返回 `cleanupNeeded` 标识 + diff/report 路径；② 新增 `session.cleanupAfterRunBackground({ db, monthKey, runId })` — 分批 DELETE（每批 50,000 行）+ `await new Promise(r => setImmediate(r))` 让出 event loop，UI 全程响应；③ main.js handler 通用 `acquiringBillCurrencyOperationLock` 替代 fix3 的 import-only lock，operation 字段 {'import','run','export','cleanup'} 互斥；④ run handler return success 前释放 'run' lock、acquire 'cleanup' lock、setImmediate 启动后台 cleanup，handler return 即时；⑤ cleanup 进行中用户点其他按钮 → 提示「上一次对账后清理 {monthKey} 数据中，请稍后再操作」；smoke 加 Case P fix9 适配（cleanupAfterRunBackground 显式调用） |
| v0.13 | 2026-05-19 | **fix10 启动期孤儿数据 cleanup**：用户实测前一轮 OOM 闪退（fix7 之前）+ fix9 之前的 run 未完成，导致重启后 DB 残留 4.6M 流水 + 4.6M 单据 + 2.6M diff_rows ≈ 15 GB，磁盘 97% 满，下次 INSERT 触发 `database or disk is full`。fix8/fix9 只覆盖「run 成功后」清理路径，闪退/中断场景无人善后。改造：① `session.cleanupOrphanData({ db, onProgress })` — 扫 `runs WHERE status != 'success'` 找孤儿 run + 兜底扫没 success run 关联的孤儿 imports，复用 fix9 `cleanupAfterRunBackground` 分批 DELETE；② main.js `app.whenReady` + migration 完成后 `setImmediate` 后台异步触发，acquire `'cleanup'` lock 期间 UI 显示「清理上次未完成的对账数据中…」；③ cleanup 抛错只记 log 不阻塞应用；smoke 加 Case Q（人造孤儿 run + 验证 cleanupOrphanData 清空所有关联表）；新增 §5.4 章节。⚠️ 同步打救急 SQL：DROP 4 表 + VACUUM 释放 14.56 GB |
| v0.14 | 2026-05-20 | **fix11 + fix12 + fix13 联合调整**：用户实测 v0.13 跑出 2,596,169 差异行写到单 sheet xlsx，但 Excel/WPS 单 sheet 显示上限 1,048,576 行（含表头）→ 用户「只看到 100 万行」误以为数据丢失。同时发现 ① `runs.ran_at` 是 UTC 时间未转本地（writer report 显示 14:51 实际本地 22:51 北京时间）；② 用户希望「运行结果汇总」直接附在差异表末尾 sheet 而非独立 `report.xlsx`。改造：① **fix11**：writer 按账单日期升序贪心切分 N 个差异 sheet（≤ 1,048,575 行/sheet）+ sheet 名 `YYYY-MM-DD~MM-DD`；run-repository 加 `getBillDateCounts` / `listDiffRowsByDateRange` 辅助查询；行数对账资金红线（sum(sheet rows) == mismatch_rows）；② **fix12**：`insertRun` 接 `ranAt` 参数（默认 `new Date().toISOString()` 带 Z）+ writer 调 `formatRanAtLocal` 转本地时区显示；兼容旧无 Z 字符串当 UTC 解析；③ **fix13**：writer 不再独立 `report.xlsx`，把 11 区块 report 写到 diff xlsx 末尾 sheet「运行结果汇总」；`runs.report_file_path` 字段语义改为 = `diff_file_path`（向后兼容 renderer）；exports 目录去掉 `report/` 子目录。§6.3 / §6.4 / §6.6 / §七 IPC schema 联动更新；smoke 新增 Case R/S/T。临时脚本 `scripts/split-diff-xlsx-by-date.js` 验证了多 sheet + 嵌入 summary + 时区转换实现可行 |
| v0.15 | 2026-05-20 | **fix14 UI 镜像布局**：用户拍板「以 bank-statement-board 为模板左右镜像」+ 给定映射关系（5 元素一一对位 bank-statement 镜像后的格子）。改造：① index.html `acquiringBillCurrencyModulePanel` 从简单 2 panel-row + flex 撑满 改为 2 control-row × 2 cell grid 结构；class 从 `.pending-board` 切到 `.acquiring-bill-currency-board`（自己的命名空间）；② styles-gemini-extra.css 新增 `.acquiring-bill-currency-board` 规则段（grid 1.4fr:1fr 镜像 + cell 居中 + pair 内按钮 140px + 独占 cell 按钮 180px 严格镜像 bank-statement secondary 规则；flex:none 覆盖全局 stretch；状态框加入 `.pending-board, .bank-statement-board, .acquiring-bill-currency-board` 共享规则 max 360 × min 110 白底圆角 18 左对齐多行卡片样式）；③ 按钮 ID 全部保留（renderer 零改动）；§8.1 主面板骨架重写 + 变更记录。先做 HTML mockup 给用户视觉确认（`~/Desktop/acquiring-bill-currency-panel-mockup.html`）→ 用户首次「OK」后实施 4 按钮 140px → 用户复盘映射尺寸差异后改为「严格镜像」pair 140 / 独占 180 + 状态框同 bank-statement |
| v0.16 | 2026-05-20 | **fix15 月份选择弹窗标题三分支**：renderer-dialogs.js `createAcquiringBillCurrencyMonthPickerDialog` 标题文案从原 2 分支（'导出' → '选择导出差异的月份' / 其他 → '选择对账月份'）改为 3 分支：'导入' → '**请选择导入文件的月份**'（流水/单据导入按钮点击触发）/ '导出' → '选择导出差异的月份'（导出差异点击）/ 其他（含'运行'）→ '选择对账月份'（开始运行点击）。用户反馈语义更准确：导入文件场景不应用「对账」这个开始运行才用的词 |
| v0.17 | 2026-05-20 | **PR #50 reviewer findings F1+F2+F3 修复**：① **F1 [P1]** smoke setupTmpDb 加 cleanup helper（先 `db.db.close()` 再 `fs.rmSync`），21 处 case finally 统一用 `cleanup()`，解决 Windows CI `EBUSY: resource busy or locked` 失败；② **F2 [P1]** validator.js 新增 `normalizeBillDate(raw)` 归一化「账单日期」格式（`YYYY-MM-DD` / `YYYY/M/D` / 含时间部分 / 无时间部分），import-repository insertFlowRow/insertBillRow 写 raw_json 前对索引 0「账单日期」字段归一化；writer fmtSheetName 加 `sanitizeSheetName` 兜底防御非法 sheet 字符；smoke 加 Case F2（16 个 assert）；③ **F3 [P2]** USER_GUIDE.md §1.8.2 / §1.8.3-1.8.9 同步 fix5/fix11/fix13/fix14 最终口径（删月份下拉 / 月份选择弹窗 / 单文件多 sheet / 末尾「运行结果汇总」/ 镜像布局 / 性能基线 fix2/fix7/fix11 实测数据 / 启动期 cleanup）。smoke 161/161 全过 |

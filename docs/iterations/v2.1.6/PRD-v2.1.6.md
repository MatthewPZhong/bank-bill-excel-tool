# PRD — v2.1.6 迭代：个人痕迹 + 新增模块「收单单据币种校验」

| 字段 | 值 |
|---|---|
| 文档版本 | v0.9（2026-05-20 — fix14 UI 镜像布局：以 bank-statement-board 为模板左右镜像，2 行 × 2 cell grid，4 按钮 min-width 140px 统一，renderer 零改动）；v0.8 = fix11/12/13 联合调整；v0.7 = fix5-fix10 集中追溯；v0.6 = fix4；v0.5 = fix2；v0.4 = fix1；v0.3-v0.1 起草 |
| 目标版本 | `v2.1.6`（patch） |
| 起始版本 | `v2.1.5`（当前 main 状态：`423c218 [v2.1.5] docs(reviewer-findings)`） |
| 起草日期 | 2026-05-18 |
| 起草人 | team-lead（PM 角色） |
| 状态 | 起草中（v0.1）— 13 项 spec 已用户拍板，等 PRD 终稿审 |
| 关联文档 | `spec.md` / `tasks.md`（同目录） |
| 涉及模块 | Module A（个人痕迹元数据，跨 8 个 writer + main 启动期 + 构建脚本） + Module B（新增第 8 个主模块「收单单据币种校验」） |
| 工作分支 | `v2.1.6`（基于 `v2.1.5` 切出，PR 向 `v2.1.6 → main`） |
| 依赖 | v2.1.5（含 7 个主模块完整骨架，Module B 复用 v2.1.2「月度银行对账单BU回填校验」骨架） |

---

## 一、需求概述

v2.1.6 包含 **两块独立改动**：

1. **Module A — 个人痕迹元数据**：在不影响业务/UI 的前提下，跨 8 个 Excel writer + 启动 log + Windows 文件属性 + 构建产物注入作者元数据（`pzhong` / `pzhong1212@gmail.com`），每次发布后自动随版本携带个人痕迹。
2. **Module B — 新增模块「收单单据币种校验」**：在主导航中新增第 8 个独立模块。按月导入收单流水表（多 xlsx）+ 收单流水单据表（多 xlsx），对比两表币种，输出**差异表**（仅含币种不一致 + 单据币种缺失的行）。差异表 = 原 26 列 + 末尾 3 列对比区（`单据_对账币种` / `流水币种` / `流水金额绝对值`）。前端 UI 复用 v2.1.2「月度银行对账单BU回填校验」骨架。

两块改动**完全独立**，无相互依赖，可并行落地。

---

## 二、Module A — 个人痕迹元数据

### 2.1 背景与目标

- **背景**：本工具是个人作品，希望每次发版后软件本身、产出的 Excel、日志均自动携带个人署名（作者 + 邮箱 + 构建 SHA），不依赖手动维护。
- **目标**：100% 覆盖 7 个主模块的所有 Excel 导出 + 应用启动 log + Windows 文件属性 + 构建产物元数据。
- **非目标**：不做加固（不上代码签名、bytenode、asar.integrity，不关 DevTools）；不做用户态保护（不阻止他人修改）。

### 2.2 子任务（4 项 = 用户拍板的 1+3+4+6）

| 子任务 | 内容 |
|---|---|
| **A1 — 元数据（方案 1）** | `package.json` 加 `author` 字段；`build.copyright` 加版权；`build.win.publisherName = 'pzhong'`，注入到 NSIS exe 文件属性 |
| **A2 — Excel watermark（方案 3）** | 新建 `src/main-process/workbook-watermark.js` 跨库 helper，跨 ExcelJS（`workbook.lastModifiedBy`）+ SheetJS（`wb.Props.LastAuthor`）。8 个 writer 入口（详见 §2.3）紧贴 `writeFile` 前调用 `applyWatermark(wb)` |
| **A3 — log 头（方案 4）** | 在 `src/main.js` 启动期，紧贴现有"应用启动 \| 版本：x.x.x" 日志后追加一条 `[INFO] crafted by pzhong (pzhong1212@gmail.com) · build {commit}` |
| **A4 — build 戳（方案 6）** | 新建 `scripts/gen-build-info.js`，prebuild 钩子注入 `src/build-info.js`（git short SHA + 构建时间）；`.gitignore` 加入；main.js require 后用于 log 头与"关于"对话框 |

### 2.3 Module A 影响范围（8 个 writer 入口表）

| 文件 | 行号（参考） | 所用库 | watermark 调用次数 |
|---|---|---|---|
| `src/backend/file-service/writers.js` | `writeBalanceWorkbook` + `XLSX.writeFile` 前 | xlsx-js-style | 1（多处导出统一走此 writer） |
| `src/main.js` | 6104（`XLSXStyle.writeFile`） | xlsx-js-style | 1 |
| `src/main-process/pending-session.js` | 94, 268 | xlsx | 2 |
| `src/backend/pending-export/writer.js` | `XLSX.writeFile` 前 | xlsx-js-style | 1 |
| `src/main-process/recon-id-fix-io.js` | 259, 300 | xlsx-js-style | 2 |
| `src/main-process/exceljs-writer.js` | 63, 89 | ExcelJS | 2 |
| `src/main-process/bank-bu-recon-writer.js` | 110, 158 | ExcelJS | 2 |
| `src/main-process/biz-op-recon-writer.js` | 68, 139, 209, 234 | ExcelJS | 4 |

**合计：8 个文件 + ~15 个 writeFile 调用点 = 100% 模块覆盖**。

### 2.4 关键决策（用户已拍板）

| # | 决策点 | 拍板值 |
|---|---|---|
| A-Q1 | author.name | `pzhong` |
| A-Q2 | author.email | `pzhong1212@gmail.com` |
| A-Q3 | 是否加 url | **不加**（保持简洁） |
| A-Q4 | win.publisherName | `pzhong` |
| A-Q5 | log 头文案 | `crafted by pzhong (pzhong1212@gmail.com)` |
| A-Q6 | build 戳格式 | `build {git-short-sha}`（**不加**构建时间） |
| A-Q7 | watermark 用哪个字段 | 仅 `lastModifiedBy` / `LastAuthor`（**不动** `creator`/`Author`，更"自然"） |

### 2.5 风险与缓解

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | 8 个 writer 接入点遗漏 → 部分导出不带署名 | tasks T3 必须 grep `writeFile` 全量过一遍，验收时 1 个 smoke 用例覆盖每个模块至少 1 次导出 |
| 🟢 低 | watermark 影响数据正确性 | 纯元数据字段，不影响 sheet 内容；A2 helper 仅修改 `lastModifiedBy` / `LastAuthor` 一个属性 |
| 🟢 低 | prebuild 在开发期报错 | `gen-build-info.js` try/catch git 命令失败时写 `commit: 'dev'` |
| 🟢 低 | `.gitignore` 漏配 | tasks 显式列入 `src/build-info.js` 防止入库 |

⚠️ Module A **不命中** `rules/important-variables.md` 任何条目（纯元数据，与业务字段/状态机无关）。

---

## 三、Module B — 新增模块「收单单据币种校验」

### 3.1 业务背景

- **业务场景**：财务需要核对每月收单流水表与收单流水单据表的币种一致性。流水表是清结算系统出账记录，单据表是入账侧记录；理论上同一笔（按 `对账主Id ↔ 主对账Id` 关联）的币种应一致；若不一致，通常是单据侧币种登记缺失或错误，需要拿流水侧补齐。
- **数据特征**：
  - 流水表（48 列）：关键字段 `对账主Id` / `对账金额` / `币种`
  - 单据表（26 列）：关键字段 `主对账Id` / `对账金额` / `对账币种`
  - 数据量：每月每表 500w 行级，多个 xlsx 文件（每 xlsx 1 sheet ≤ 104w 行，受 Excel 规范限制）
- **关联方式**：流水 `对账主Id` ↔ 单据 `主对账Id`，**严格 1:1**（任一侧重复即数据错误）
- **历史依赖**：本模块前端骨架与 v2.1.2「月度银行对账单BU回填校验」一致（按月组织、导入文件 / 开始运行 / 导出差异 3 个主按钮），但对账规则完全不同。

### 3.2 用户价值

| 维度 | 改善 |
|---|---|
| 大批量自动比对 | 500w × 2 行级别的币种校验，原本完全无法手工处理 |
| 一致性补齐 | 不一致的单据行自动附带流水侧的币种 + 金额绝对值，供财务快速判断/修正 |
| 数据质量发现 | 主对账Id 重复 → 整批拒绝 + error_report，主动暴露数据源问题 |

### 3.3 必做 / 不做对照

| 必做 | 不做 |
|---|---|
| ✅ 主导航新增第 8 个模块 `acquiringBillCurrency`，独立面板 | ❌ 不动现有 7 个模块的任何逻辑 |
| ✅ 主按钮 = `导入流水表` + `导入单据表` + `开始运行` + `导出差异`（4 按钮，参照 v2.1.3 bizOpRecon 的双导入按钮模式） | ❌ 不引入规则管理 / 场景配置 UI |
| ✅ 按月组织（月份单选下拉框，位于状态栏上方），月份枚举动态来自已导入数据 | ❌ 不引入按日维度 / 跨月对账 |
| ✅ 流水表导入：流式 reader + 主对账Id 唯一性校验（重复 → 整批拒绝 + error_report） | ❌ 不在流水/单据表上做行级数值校验（不做双重校验） |
| ✅ 单据表导入：流式 reader + 主对账Id 唯一性校验（同上） | ❌ 不主动修复源数据（仅校验+整批拒绝） |
| ✅ 运行对账：1:1 JOIN，币种不一致（含单据缺失）的行入差异表 | ❌ **不替换**原单据 `对账金额` / `对账币种` 字段（用户明确：写新列，不动原列） |
| ✅ 差异表新增 3 列：`单据_对账币种`（左侧 copy 1 列）+ `流水币种` + `流水金额绝对值`（右侧流水 2 列），构成"单据 vs 流水"币种对比区 | ❌ 不输出全表 xlsx（差异表**仅含差异行**，不含一致行）；❌ 不 copy 单据「对账金额」（用户决策，金额信息已在原第 19 列） |
| ✅ 输出形态：**1 对 1**（每个输入单据 xlsx → 1 个修改后单据 xlsx） | ❌ 不合并多 xlsx 为单文件（避开 104w 单 sheet 限） |
| ✅ 币种判定口径：`LOWER + TRIM` 后比较（`usd` ≡ `USD`） | ❌ 不做 NFC/NFD Unicode 归一化（暂无需求） |
| ✅ 流水金额：**先取 ABS** 后再写入对应字段 | ❌ 不保留原符号（用户拍板：丢弃符号） |
| ✅ 技术方案 C：ExcelJS 流式 reader + SQLite 临时表 + SQL JOIN + ExcelJS 流式 writer | ❌ 不用纯内存 Map（500w × 2 OOM） |
| ✅ smoke 测试新增 ≥ 3 用例（基本流程 / 主Id重复整批拒绝 / 单据币种缺失） | ❌ 不强制覆盖 500w 行真实压测（manual test 兜底；dryrun 脚本单独提供） |
| ✅ version bump 2.1.5 → 2.1.6 + 三件套（CHANGELOG / VFH / USER_GUIDE） | — |
| ✅ 新模块 preview 入口 4 张截图（初始 / 导入中 / 运行结果 / 差异导出） | — |

### 3.4 关键规则（用户已拍板）

| # | 规则点 | 拍板值 |
|---|---|---|
| B-Q1 | 关联键 + 关系基数 | 流水 `对账主Id` ↔ 单据 `主对账Id`；严格 **1:1** |
| B-Q2 | 触发与赋值方式 | 流水币种 ≠ 单据币种（含单据币种缺失）→ 该单据行入差异表；差异表 = 原 26 列 + 末尾 3 列对比区（单据币种 copy 1 列 + 流水侧 2 列）；**不替换**原列 |
| B-Q3 | 金额绝对值口径 | 流水侧金额**全量取 ABS 后参与对账**；新增列 `流水金额绝对值` = ABS(流水.对账金额)；原符号丢弃 |
| B-Q4 | 不一致判定口径 | 两侧币种 `LOWER + TRIM` 后比较；`usd` ≡ `USD`、`USD ` ≡ `USD` |
| B-Q5 | diff 报告形态 | **差异表 = 仅差异行 + 末尾 3 列对比区**（单据币种 copy 1 列 + 流水侧 2 列）；不输出独立报告文件、不输出全表 xlsx；某文件 0 差异行 → 仍输出仅表头版本以保留 1 对 1 对应 |
| B-Q6 | UI 入口 | 新独立功能页，前端骨架同「月度银行对账单BU回填校验」（bankBuRecon），按月组织 |
| B-Q7 | 多 xlsx 表头一致性 | 同一类型的多个 xlsx 表头**完全一致**（列数 / 列名 / 列顺序）；不一致 → 整批拒绝 |
| B-Q8 | 主对账Id 跨文件唯一性 | 不允许重复；重复 → 整批拒绝 + 输出 error_report |
| B-Q9 | 输出形态 | **1 对 1**：每个输入单据 xlsx → 1 个修改后单据 xlsx；不合并不拆 sheet |
| B-Q10（fix1） | 重复月份导入处理 | 流水/单据**对称**：导入前先 peek monthKey → 若该月份已有数据则弹窗"覆盖确认"；用户确认后**只清单侧**数据（流水或单据）再导入；不连带清 runs/diff_rows；详 spec §3.4 |
| B-Q11（fix4） | 对账字段语义校正 | 流水侧对账字段从第 14 列「币种」+ 第 13 列「对账金额」（订单视角）**切换为**第 30 列「通道清算币种」+ 第 29 列「通道清算金额」（清算视角，与单据「对账币种」语义对齐）。原因：用户实测 v0.6 用订单币种对账时 466 万行 100% match = 字段语义错位，改清算视角后能正确抓出约 56% 行的真实币种差异（订单 USD 收款 → 通道 EUR 清算）。详 spec §3.1（★ 标移位）+ §4.1/4.2（DB 重命名 recon_amount → settle_amount 等 6 列）+ §5.2（SQL 比对字段）+ §6.2（输出列名加「_通道清算」前缀） |

### 3.5 模块定位

| 项 | 设计 |
|---|---|
| 模块 id | `acquiring-bill-currency`（"收单"= acquiring，"单据"= bill，沿用项目 `BUSINESS_BILL_FIELDS` 系列命名一致术语；"币种"= currency check） |
| 模块中文名 | 收单单据币种校验 |
| 主导航位置 | 第 8 个 nav-module-btn `data-module="acquiring-bill-currency"` |
| 面板 id | `acquiringBillCurrencyModulePanel` |
| 主按钮 4 个 | `acquiringBillCurrencyImportFlowBtn` = `导入流水表` / `acquiringBillCurrencyImportBillBtn` = `导入单据表` / `acquiringBillCurrencyRunBtn` = `开始运行`（默认 disabled）/ `acquiringBillCurrencyExportBtn` = `导出差异`（默认 disabled） |
| 月份下拉框 | `acquiringBillCurrencyMonthSelect`，位于状态栏上方；选项动态来自 SQLite 中已导入数据的月份字段 DISTINCT |
| 状态栏 | `acquiringBillCurrencyStatusBox`（参照 `bankBuReconStatusBox`） |
| 数据持久化 | 4 张 SQLite 表落主 DB（`tool-data.sqlite`）：`acquiring_bill_currency_flow_imports` / `acquiring_bill_currency_bill_imports` / `acquiring_bill_currency_runs` / `acquiring_bill_currency_diff_rows`（详见 spec.md §四） |
| IPC 命名空间 | `acquiringBillCurrency:*`（与现有 7 模块完全独立） |

### 3.6 风险与缓解 ⚠️ 资金红线

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🔴 **HIGH（资金红线）** | 币种 + 金额绝对值写入单据表新增列，财务可能据此调整账务；列名/值若误写会引发账务事故 | tasks 必须含：① 列名 hardcode 常量 ② smoke 验证 happy path + 不一致 path + 缺失 path 各至少 1 用例 ③ 至少 1 个 100w 量级 dryrun ④ `rules/important-variables.md` 添加 Critical 级条目 |
| 🔴 **HIGH（资金红线）** | 主对账Id 重复未被检出 → 1:1 假设破坏，JOIN 出错乱数据 | tasks T6/T7 reader/validator 必须含主Id 唯一性校验，重复立即整批拒绝；smoke Case B 强制覆盖 |
| 🟡 中 | 500w 行级数据量，全内存爆 | **fix2 解决**：reader 重写为 yauzl + sax 流式，单文件 RAM < 50MB（spec §3.5）；fix2 前的 SheetJS dense 方案失败（POI data descriptor + inlineStr 不兼容）|
| 🟡 中 | xlsx sharedStrings 表对大文件解析时一次性加载 → 内存炸 | **fix2 实测**：清结算导出用 `t="inlineStr"` 不依赖 sharedStrings；reader 解析 inlineStr 直接从 cell 内联 `<is><t>` 取值，不读 sharedStrings.xml |
| 🔴 **HIGH（资金红线）** | **v0.7 fix4 字段切换** → 历史已入库数据语义错位（recon_amount/currency 列存的是订单视角值，但 SQL 已改成读 settle_currency_norm） | ① 强制清月重导（spec §3.1 v0.7 字段切换说明）② migration ALTER COLUMN 重命名（保留数据 + 改列名，但**值仍是订单视角**必须配合清月才正确）③ smoke J/K/L 覆盖 settle_currency 入库 + 比对正确性 |
| 🟡 中 | 币种判定误判（大小写/空格） | 统一 `LOWER + TRIM` 归一函数 + smoke Case 覆盖 `USD ` / `usd` / `Usd` 多种形态 |
| 🟢 低 | 输出 xlsx 写入时新增列顺序错乱 | 列名 hardcode 在文件末尾 3 列（第 27 `单据_对账币种` / 第 28 `流水币种` / 第 29 `流水金额绝对值`）；spec §6.2 明确 |

⚠️ Module B **命中** `rules/important-variables.md` —— 新增字段属 Critical 级（资金/币种）；本迭代 PR 提交前必须执行 `/check-vars` skill 并在 PR body 附「⚠️ 关联功能 review」段。

### 3.7 性能预估（v0.5 fix2 修订）

**fix2 前的错误预估**（v0.1-v0.4，已废弃）：
| 数据规模 | 端到端时间 | 峰值内存 |
|---|---|---|
| ~~单月 100w × 2~~ | ~~3-5 min~~ | ~~200MB~~ |
| ~~单月 500w × 2~~ | ~~10-20 min~~ | ~~300-500MB~~ |
| ~~单月 1000w × 2~~ | ~~20-40 min~~ | ~~500MB-1GB~~ |

上述预估**严重失实**：假设单文件 100w 行 ≈ 1-1.5GB 解压，但实际清结算导出用 **inlineStr 格式** + **30w 行/文件 = 800MB 解压**（cell 不复用 sharedStrings，每个 cell 内嵌完整 `<is><t>...</t></is>` 标签 → 内存膨胀 ~8 倍）。SheetJS dense 全 load 完全跑不动。

**fix2 后的实测预估**（基于 yauzl + sax 流式 reader）：

| 数据规模 | 端到端时间（预估） | 峰值内存 |
|---|---|---|
| 单月 ~480w × 2（用户真实样本 16+? 文件 × 30w 行）| 8-15 min | < 200MB（流式） |
| 单月 ~1000w × 2 | 20-30 min | < 200MB（流式） |
| 单月 ~5000w × 2（极限）| 1.5-3 h | < 200MB（流式） |

**fix2 实测后填充实际值**（T-fix2.5 完成时回填）。

UI 必须显示进度（按"第 X/Y 个文件 + 当前文件 N 万行"粒度）。

---

## 四、版本号 + 文档三件套

| 文档 | 改动 |
|---|---|
| `package.json.version` | 2.1.5 → 2.1.6 |
| `CHANGELOG.md` | 新增 v2.1.6 段：Module A 元数据 + Module B 收单币种校验 + 风险声明 |
| `docs/VERSION_FEATURE_HISTORY.md` | 同上 |
| `docs/USER_GUIDE.md` | 新增章节"收单单据币种校验"使用说明（导入流程 / 对账规则 / 输出说明） |
| `rules/important-variables.md` | 新增 Critical 级条目：`acquiring_bill_currency_diff_rows.flow_currency` / `flow_amount_abs` |

---

## 五、Task 高阶清单（详细见 `tasks.md`）

| Task | 内容 | 风险 | 预估工时 |
|---|---|---|---|
| T0 | 起 PRD / spec / tasks 三件套（本 task） | 🟢 | 0.5d |
| T1 | Module A — package.json + electron-builder 元数据 | 🟢 | 0.5h |
| T2 | Module A — workbook-watermark helper + 8 writer 接入 | 🟢 | 2h |
| T3 | Module A — log 头 + build 戳（含 gen-build-info.js + prebuild） | 🟢 | 1h |
| T4 | Module B — SQLite migration（4 张表 + 索引） | 🟡 | 2h |
| T5 | Module B — reader（流式 ExcelJS）+ validator（主Id 唯一性 + 表头一致性） | 🔴 | 1d |
| T6 | Module B — session + 算法（关联 + 币种比对 + 新增列写回）⚠️ 资金红线 | 🔴 | 1.5d |
| T7 | Module B — writer（流式 ExcelJS 输出差异表，29 列 + 仅差异行） | 🔴 | 1d |
| T8 | Module B — 前端面板 + dialog（复用 bankBuRecon 骨架） | 🟡 | 1d |
| T9 | Module B — IPC handlers + preload | 🟡 | 0.5d |
| T10 | smoke 测试（A/B 两块共 ≥ 4 用例） | 🟡 | 0.5d |
| T11 | preview 截图 + 接入 `preview:all` | 🟢 | 0.5h |
| T12 | 文档三件套 + version bump + important-variables 同步 | 🟢 | 1h |
| T13 | self-review + `/check-vars` + PR 草稿入 `docs/prs/` | 🟢 | 0.5d |
| **合计** | | | **~7-8 工作日** |

---

## 六、OPEN ISSUE

无（13 项 spec 用户已全部拍板，详见 §2.4 与 §3.4）。

---

## 七、文档变更记录

| 版本 | 日期 | 修订 |
|---|---|---|
| v0.1 | 2026-05-18 | 起草；13 项 spec 用户拍板（Module A 6 项 + Module B 9 项）；Task 高阶清单成型 |
| v0.2 | 2026-05-18 | 用户反馈两处：① 命名 `acquiring-currency` → `acquiring-bill-currency`（加 bill 显式标识"单据"，与项目内 `BUSINESS_BILL_FIELDS` 等一致术语对齐）；② 输出差异表设计修订 — 28 列全表（含一致行）→ 30 列仅差异行（含 4 列对比区 `单据_对账金额 / 单据_对账币种 / 流水币种 / 流水金额绝对值`）；输出文件名 `-checked-` → `-diff-`；spec §6 + §九 smoke + PRD §1/§3.3/§3.4/§3.6 全套同步 |
| v0.3 | 2026-05-18 | 用户决策：去掉「单据_对账金额」copy 列（金额信息已在原第 19 列）。差异表 30 列 → 29 列 / 末尾 4 列对比区 → 末尾 3 列对比区（单据_对账币种 / 流水币种 / 流水金额绝对值）；PRD §1/§3.3/§3.4(B-Q2/B-Q5)/§3.6/§5(T7) + spec §6.1/§6.2/§6.3/§九/变更记录 + tasks T7 全套同步 |
| v0.4 | 2026-05-18 | **fix1**：用户实测发现"二次导入相同月份 → UNIQUE 整批拒绝 + 无引导"。新增 B-Q10（重复月份导入处理：流水/单据对称 peek + 覆盖确认）；spec §3.4 / §七 IPC 入参 / §8.3-8.4 / §九 Case H1-H3 全套同步；tasks 加 T-fix1.1/1.2/1.3/1.4 子任务 |
| v0.5 | 2026-05-18 | **fix2 reader 选型变更**：用户实测 16 个 xlsx（30w 行/文件 + inlineStr 格式 + 800MB 解压 + POI 流式写 ZIP data descriptor）发现 v0.3 SheetJS dense 假设完全错（SheetJS/ExcelJS 双双拒解）。§3.7 性能预估全部废弃重写（实际数据规模 + 流式内存基线）；§3.6 风险表更新（fix2 解决方案 = yauzl + sax 流式）；spec 新增 §3.5「Reader 实现（fix2）」；tasks 加 T-fix2.1-2.6 |
| v0.6 | 2026-05-19 | **fix4 对账字段语义校正**：用户实测 v0.6 用「币种」+「对账金额」（订单视角）对账时 466 万行 100% match = 字段语义错位；改用「通道清算币种」+「通道清算金额」（清算视角，与单据「对账币种」语义对齐），预估抓出 ~259 万行真实差异。新增 B-Q11 拍板项；§3.6 风险表加「字段切换 → 历史数据强制清月重导」；spec §3.1/§4.1/§4.2/§5.2/§6.2 联动更新；tasks 加 T-fix4.1-4.6 |
| v0.7 | 2026-05-19 | **fix5-fix10 集中追溯**（前期 fix5-fix9 PRD/tasks 未同步，本次一并 catch-up + 加 fix10）：① **fix5** UX 重构 — 删月份下拉、导入/导出按钮触发月份选择弹窗、输出形态从「1 对 1 多 sheet」反转为「单文件单 sheet 合并 + 结果表 report」；② **fix6** 通道清算金额允许为空（30,057 行 / 0.6% 非清算流水子类型）；③ **fix7** diff writer OOM 修复（259w × 3KB ≈ 7-8GB 全 load 内存 → ExcelJS streaming + SQL 分批 LIMIT/OFFSET）；④ **fix8** run 成功后自动清原始数据（flow/bill/diff_rows，保留 runs，释放 DB 空间）；⑤ **fix9** cleanup 异步后台 + 通用 operation lock（替代 fix3 import-only lock，cleanup 期间 UI 显示「清理中」）；⑥ **fix10** 启动期孤儿数据 cleanup — 应对 OOM 闪退/异常退出后 DB 残留 15 GB 撑爆磁盘（database or disk is full），`app.whenReady` + migration 后 setImmediate 后台扫 `runs WHERE status != 'success'` + 复用 fix9 分批 DELETE 逻辑；§3.6 风险表加「闪退/异常退出后孤儿数据 → 启动期自动 cleanup 兜底」；tasks 加 T-fix5/T-fix6/T-fix7/T-fix8/T-fix9/T-fix10 系列；spec 加 §5.4 启动期 cleanup 章节 + smoke Case Q |
| v0.8 | 2026-05-20 | **fix11 + fix12 + fix13 联合调整**：用户 v0.13 实测跑出 2,596,169 差异行单 sheet 写入 xlsx → 但 Excel/WPS 单 sheet 显示硬上限 1,048,576 行（含表头）→ 用户「只看到 100 万行」误以为 writer 漏 150 万。同步发现两个相关问题：`ran_at` 字段是 UTC 未转本地（差 8 小时）；用户希望「运行结果汇总」直接附在差异 xlsx 末尾 sheet。改造：① **fix11** writer 按账单日期升序贪心切分 N 个差异 sheet（≤ 1,048,575 行/sheet）+ sheet 名 `YYYY-MM-DD~MM-DD`；新增 `run-repository.getBillDateCounts` / `listDiffRowsByDateRange`；资金红线 = `sum(sheet rows) == mismatch_rows`；② **fix12** `insertRun` 接 `ranAt` 参数 = `new Date().toISOString()`（ISO 8601 带 Z）+ writer 调 `formatRanAtLocal` 转本地显示；兼容无 Z 字符串当 UTC 解析；③ **fix13** writer 不独立 `report.xlsx`，把 11 区块 report 写到 diff xlsx 末尾 sheet「运行结果汇总」；`runs.report_file_path` 改为 = `diff_file_path`；exports 去掉 `report/` 子目录。临时脚本 `scripts/split-diff-xlsx-by-date.js` 验证多 sheet + 嵌入 summary + UTC→Local 转换可行；spec §6.3 / §6.4 / §6.6 / §七 IPC 联动；smoke Case R/S/T |
| v0.9 | 2026-05-20 | **fix14 UI 镜像布局**：用户拍板「以 bank-statement-board（v1.x 网银账单生成助手主模块）为模板左右镜像」+ 给定 5 元素映射关系。改造：index.html 重写 acquiringBillCurrencyModulePanel 为 2 control-row × 2 cell grid 结构（左 1.4fr / 右 1fr，原 bank-statement 是 1fr / 1.4fr 镜像 = 调换比例）；按钮位置 = [导入流水表+导入单据表]（左 pair）/ 开始运行（右独占）/ 状态框（左独占）/ 导出差异（右独占）；4 按钮统一 min-width 140px（覆盖 secondary 默认 180px）；styles-gemini-extra.css 新增 `.acquiring-bill-currency-board` 规则段；按钮 ID 全保留 renderer 零改动；spec §8.1 重写。先做 HTML mockup 视觉确认后再改代码 |

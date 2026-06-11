# PRD - 网银账单小助手 v3.0.4（六块迭代：JSZip 止血 / 引擎第二波迁移 / 银行对账输出修复 / BOC 调拨订单修复 / Payment 线下调拨回填）

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.4 |
| 日期 | 2026-06-11 |
| 作者 | PM |
| 状态 | 定稿 |
| 模块 | 挂账 pending 导入 · 业务OP 对账 biz-op flow 导入 · 银行对账单输出 · BOC 链接表与修复引擎 · Payment R5s2b 回填 · 大表导入引擎扩展包 |
| 依赖 | `main` 分支（PR #70 已合并）→ 开发分支 `v3.0.4`（已切出）；目标版本 3.0.4 |

> **来源 spec（唯一事实源）**：
> 1. `changes/v3.0.4/spec.md`（六块编排入口；块 A/B/C 详设 + §三引擎扩展包 E1-E5 + §七风险 + §八 OPEN-1/2/3 拍板）
> 2. `changes/bank-recon-output-fixes/spec.md`（块 D 详设）
> 3. `changes/boc-dispatch-order-fix/spec.md`（块 E 详设）
> 4. `changes/payment-offline-allocation-backfill/spec.md`（块 F 详设）
>
> 本 PRD 以上述 spec 为唯一事实源，所有标 ✅ 拍板的结论原样转述，不自行发明语义。

---

## 一、需求概述

本次迭代统筹**六块**需求：

1. **块 A · JSZip 崩点止血 + 链接表报错可见性** —— 入口预检 ≥2^31（2147483648）字节抛明确中文错误（不再「uncompressed data size mismatch」天书）+ 修「链接表导入报错全链路零落盘」。
2. **块 B · 挂账 pending 导入迁移大表引擎** —— JSZip→yauzl 引擎、child_process→worker_threads 拓扑统一、多文件并行，解锁 300 万行设计目标；落库语义 byte-for-byte 平移。
3. **块 C · 业务OP 对账 biz-op flow 流水导入迁移引擎** —— 流水（flow）侧切引擎（多文件并行 + 崩点解除）；业务OP（bizOp）侧不迁（✅ OPEN-1 拍板）。
4. **块 D · 银行对账单输出三点修复** —— C3 Extra Fee 写盘取相反数 / 错误报告与命中场景行报表存放目录互换 / error report 第 3 列「行号」换「对账ID」。
5. **块 E · BOC 调拨订单修复** —— 第 2 个内置写死场景「BOC调拨订单修复」+ 两张隐藏链接表派生管线（外汇交割分组 / 中台匹配 / 银行单回填）+ 整组匹配从严修复引擎；bank-deposit 落库白名单 13→14。
6. **块 F · Payment 线下调拨订单回填处理** —— R5 场景2 的 config 子开关 + ISO 8601 周数匹配引擎 R5s2b（网关回填优先互斥）+ 弹窗三输入框（银行渠道 / 地区 / 大账号）。

> 集成形态：全部任务块按「一块一/多 commit」串到 `v3.0.4` 分支（commit 前缀 `[v3.0.4]`），最终**单 PR 合入 main**（沿 v3.0.3 PR #70 模式）。

---

## 二、背景与目标

### 2.1 背景

| 块 | 为什么要做 | 用户 / 业务价值 | 当前问题 |
|----|-----------|----------------|----------|
| A | JSZip 3.10.1 `DataReader.js:64` `readInt` 用有符号 32 位累加，entry 解压尺寸 ≥ 2^31（2.147GB）被读成负数 → 解压校验必不等 → 抛 `Bug : uncompressed data size mismatch`（链接表 98w 行 ≈2.56GB 实证撞崩）。 | 用户导入超大表时得到可执行中文指引（拆分文件），不再面对天书报错；链接表导入失败有日志可查。 | 撞崩报「天书」英文；链接表 per-file 失败报错全链路零落盘（三处丢失点），用户完全无感。 |
| B | pending 300w×31 列设计目标（sheet ≈3-4GB）在现 JSZip 基座必然不可达（崩点约 170-200w 行）；child_process 拓扑与引擎 worker_threads 拓扑不统一。 | 解锁 300 万行导入、多文件并行（实测 4-worker 3.06x）、导入期 UI 流畅（W4 属性）。 | 共用 JSZip 基座（`streaming-xlsx-reader.js:17`）有 2.147GB 硬上限；无多文件并行。 |
| C | biz-op flow 侧单日量级大（历史曾撞 SheetJS 512MB 上限催生流式 reader），多文件 multiSelections（v3.0.2 需求1b）。 | flow 侧崩点解除 + 多文件并行收益；与 pending 共享引擎扩展包。 | flow 仍走 JSZip 基座、无多文件并行。 |
| D | 三个对账输出修复点（资金对账数据处理 / 银行对账单生成模块）。 | F1 Extra Fee 符号修正语义正确；F2 出错统一去 error-reports 找；F3 第 3 列从无意义内部行号换成可定位的对账ID。 | F1 写盘符号与语义相反；F2 错误报告与命中场景行报表目录名实错位；F3 第 3 列写引擎内部 `_rowId`（形如 `row_37`，多文件合并后全局重编号，与任何 Excel 行号无关）对用户无意义。 |
| E | 「JPM调拨订单修复」（v2.1.16-beta.5 需求4）与「ADM 隐藏派生表」（同版本 §5.3）两套既有范式的 BOC 镜像。 | 新增 BOC 渠道的调拨订单自动修复能力；外汇交割表导入后自动分组、匹配、回填对账ID。 | 无 BOC 内置场景；无 BOC 链接表；bank-deposit 落库白名单不含 Payment Detail（无法提取银行单交易编号）。 |
| F | 中台调拨订单对账ID回填（R5 场景2）扩展，处理 Payment 线下调拨。 | 自动把订单「渠道流水号」回填到对账单 ReconciliationId 并标黄；按 ISO 周数 + 就近匹配，差错池二轮兜底。 | R5s2 现仅网关回填语义；src/ 与 scripts/ 周数/FTA 引擎区零既有实现。 |

### 2.2 目标（必做）

- **块 A**：A1 入口尺寸预检（3 落点）拦截「中央目录尺寸 ≥2^31」并抛中文 `FileValidationError`；A2 链接表导入失败 → activity log 出现 error 条目 + 三处入口消费返回值。
- **块 B**：pending 契约模块 + 共享 dispatch + session 接线 + 回退开关 + parity 集成脚本；落库语义（6 表覆盖删除 / 跨文件去重 / 整批拒绝 / 月元数据原子）逐字平移。
- **块 C**：biz-op flow 契约模块 + session 接线 + 回退开关 + parity 集成脚本；bizOp 侧旧链路不动。
- **块 D**：F1 写盘取反；F2 目录互换（错误报告 → `error-reports/{date}/`，命中场景行 → `bank-statement-process/{date}/`）；F3 第 3 列换「对账ID」+ 空值三级回退链。
- **块 E**：F1 BOC 内置场景种子；F2 两张隐藏表 + 派生管线 + 弹框引导 + 日志（含 BANK_DEPOSIT_FIELDS 13→14）；F3 BOC 修复引擎 + 分流注入 + 运行反馈改造。
- **块 F**：F1-F7（UI 勾选与条件展开行 / config 持久化 / 周数+FTA 纯函数地基 / run 数据接线与缓存失效 / 匹配引擎 / 输出链收口 / 测试文档守卫）。
- **收尾**：版本 bump 3.0.4 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ `npm run scan:vars` + `/check-vars` 硬节点 + `npm run release-check` 全绿。

### 2.3 明确不做（非目标）

- **B9 方案 B**（streaming-xlsx-reader zip 层整体换 yauzl）：被「pending/biz-op 直接迁引擎 + 块 A 护栏」组合替代。链接表与 vcc 留在 JSZip 基座，由块 A 护栏明确报错。
- **链接表迁移引擎**：独立迭代（缺口=引擎需加表头扫描定位 + 多表混选分组 dispatch + B8 合并语义）。
- **vcc 迁移引擎**：架构不匹配，不上引擎。
- **业务OP（bizOp）侧迁移**：✅ OPEN-1 拍板不迁（E6 扩展整体裁剪，PR-D 范围 = flow 侧）；重启条件 = bizOp 量级出现真实痛点时另立迭代。
- **收单 dispatch 收编共享模块**：✅ OPEN-2 拍板本迭代不收编（收单 `dispatchEngineImport` 保持原样，三方收敛留后续迭代）。
- 引擎 PRAGMA 清单收敛为单一导出模块（继续不做）；B8（链接表多选多文件互相覆盖，留 backlog）。
- **块 D**：不动匹配语义（`c3-gateway-recon-join.js:69-75`）；不动 `config.extraFee` schema（无 DB migration）；不改任何引擎 warning push 点；不迁移历史产物文件；不动 `main.js:3675` exportRootDir 本体。
- **块 E**：不动 JPM 引擎与 C4 通用算法；不动 `listScenarios` 排序机制（序号 2 靠 priority=3 + id 序自然成立）；不动导出 writer 与 `recon-id-fix:export`（零改动复用）；中台调拨订单表导入不触发 BOC 重算（U4 拍板）；BOC 两张隐藏表不进链接表管理 UI、不可导出；不迁移/回补存量 bank-deposit 缺失的 Payment Detail 数据（引导重导）。
- **块 F**：不改 R5s2 既有网关回填语义（directions/容差/覆盖规则零改动）；不动 ADM 派生与 JPM 链路；不改 `createInsertContext` 4 列共用 INSERT；不顺手改 ADM_FUND_TYPES 小写 t 既有疑点（记 backlog）；周数号不进 44 列输出契约。

---

## 三、代码现状（必须有出处）

| 块 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| A | `src/backend/pending-import/streaming-xlsx-reader.js:17`（JSZip require）；`vcc-op-calc-import/reader.js`；`biz-op-recon-import/reader-streamed.js:35` | 共用 JSZip 基座，四方消费（pending worker / linked-table 流式 / biz-op fallback / vcc）。 | entry 解压 ≥2^31 撞崩报英文天书；无尺寸预检。 |
| A | `src/main.js:11273`（`linked-table:import` handler）/ `renderer-dialogs.js:6399`（弹窗 `skipLogReport:true`）/ `renderer.js:3738`、`:3885`（C3/运行前提醒入口） | per-file 失败仅进返回值不写 activity log；弹窗 UI 显示但绕开日志；两入口返回值直接丢弃。 | 报错全链路零落盘，用户无感、无日志可查。 |
| B | `src/main.js:10322`（`pending:import:start`）→ `pending-session.js:40-46`（utilityProcess.fork 8GB 堆）→ `worker.js`；`month-repository.js:77-93`（deleteMonth 6 表顺序敏感）；`worker.js:118-132`（跨文件 sha 去重 + 重复行整批拒绝） | 单大事务 BEGIN → deleteMonth → 跨文件去重 → 33 参 INSERT → 任一错误整批 ROLLBACK → upsertMonthMeta → COMMIT。 | JSZip 基座 2.147GB 上限；硬编码 `xl/worksheets/sheet1.xml`；小样本走主进程同步兜底；child_process 拓扑独立。 |
| C | `biz-op-recon-import/reader-streamed.js`；`import-worker.js:46`（错误上限 1000 + rawRow）；flow clear = `clearRunsAndDiffsByDate(date)` + `clearByDate(date)`（2 条，参数=入参 date） | flow/bizOp 共用 import-worker；flow clear 语义简单与行内容无关。 | flow 仍走 JSZip 基座；无多文件并行；错误报告 xlsx 需整行 rawRow。 |
| D-F1 | `c3-gateway-recon-join.js:89`（fee 解析）/ `:69-75`（匹配语义）/ `:210-221`（写盘点，全 src/ 唯一写入点） | 匹配成功且 fee!==null 时 `normalizeCellValue(fee)` 写 `bankRow['Extra Fee']` + 标黄。 | 写盘值与输入框同号；语义应取相反数。 |
| D-F2 | `main.js:3675`（exportRootDir=bank-statement-process）/ `:3683-3697`（错误报告落盘）/ `scenario-hit-rows-writer.js:43`（DEFAULT_REPORT_SUBDIR='error-reports'） | 错误报告落 `bank-statement-process/{date}/`；命中场景行落 `error-reports/{date}/`。 | 两类产物目录名实错位。⚠️ `main.js:3675` 本体被 R5 场景3/4 兜底依赖（`:3782/:3807`），不能改本体。 |
| D-F3 | `exceljs-writer.js:179,189`（第 3 列写 `w.rowId ?? ''`）；`bank-statement-io.js:88-90`（_rowId 注入）；`main.js:11481-11484,11566-11571`（多文件合并全局重编号） | 第 3 列表头「行号」写引擎内部 `row_N`。 | row_N 与任何 Excel 行号无关，对用户无意义。 |
| E-F1 | `migrations.js:1771-1779`（JPM 写死场景）/ `:1800-1883`（`ensureJpmDispatchOrderScenarioSeed`）；`scenarios-repository.js:170-222`（listScenarios 按 priority DESC, id ASC） | 已有 1 个 gateway 内置场景（JPM）；排序天然成立。 | 无 BOC 内置场景；序号 2 非强保证（老库 priority=3 用户场景可插队）。 |
| E-F2 | `migrations.js:2806-2828`（ADM 隐藏表范本）；`linked-table-repository.js:31-34`（BANK_DEPOSIT_FIELDS 仅 13 字段）；`readers.js:254-273`（数组路径保留 rowNumbers）；`linked-table-stream-source.js:44`（流式不透传 rowIdx）；`table-type-detector.js:293-307`（.xls 一律非流式） | bank-deposit 落库白名单 13 字段不含 Payment Detail；流式路径丢物理行号。 | 🔴 存量 bank-deposit 行 raw_json 无 Payment Detail 无法 migration 补；单 sheet .xlsx 交割表会命中流式丢行号。 |
| E-F3 | `recon-id-fix-engine.js:26-35`（按 subCategory 分流）；`main.js:3994-4055`（run handler）；`c4-recon-id-fix.js:588-604`（buildOutputRow 14 列）；`jpm-dispatch-order-fix.js:226-237`（overrides 注入 Type/Reference）；`renderer.js:4445-4474`（运行反馈） | JPM 引擎按 subCategory 分流；运行反馈只显示警告条数不显示文案，0 命中兜底硬编码 JPM merchantId。 | 无 BOC 引擎分支；前端反馈不显示 warning 文案。 |
| F | `migrations.js:1500-1515`（R5 场景2 builtin-fixed seed）；`renderer-dialogs.js:7256-7443`（`createBuiltinFixedChannelManageDialog`，9 个 builtin-fixed 共用）；`r5-fund-transfer-backfill.js:65-84,126,142-150,162,186-197`（R5s2 匹配/标黄/方向池）；`linked-table-repository.js:69-79`（linked_mid_allocation）；`main.js:11448-11454`（mid-allocation 导入不清 processingResult） | R5s2 网关回填：direction 池 + 金额分级精确 + Phase1 同日→Phase2 ±容差 + 命中即覆盖标黄；弹窗仅银行渠道多选 + 优先级、完全不读不写 config。 | 弹窗 564px 三组 label+input 单行放不下；周数/FTA 零既有实现；mid-allocation 导入不清 processingResult（stale 缺口，本功能改变该前提）。 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| JSZip 2^31 崩点 | JSZip 3.10.1 有符号 32 位 readInt，entry 解压尺寸 ≥ 2147483648 字节被读成负数 → 解压校验失败抛天书；本迭代上限值 ✅ OPEN-3 拍板 = 2^31 整（2147483648） |
| yauzl 引擎 | big-table-import `zip-reader.js:22` 基于 yauzl（无符号读取 + 正解 zip64），带 W4 worker 拓扑 / 多文件并行 / row-scanner / cancel / 内存闸 |
| fail-open | A1 预检自身失败（zip 打不开/找不到 entry）时放行，让原链路报原错（只拦「确定超限」） |
| 契约 hook E1-E5 | 引擎扩展包的可选契约项；铁律「契约不声明 ⇒ 引擎行为与 v3.0.3 完全一致」 |
| pending 6 表覆盖删除链 | deleteMonth 顺序敏感的 6 条 DELETE（pending_removal_matches → diff_rows → diff_runs → removed_pending_rows → pending_rows → pending_months），含 Codex PR #55 Finding 1 红线 |
| parity 集成脚本 | legacy 旧链路 vs 引擎新链路同 fixture 双跑、byte-for-byte 逐字段对比的回归锁脚本 |
| Extra Fee 取反 | C3「金额不一致」输入框值写入输出 Extra Fee 列时取相反数（匹配语义不变） |
| BOC 隐藏链接表 | `linked_boc_fx_settlement`（外汇交割派生表）/ `linked_boc_bank_deposit`（BOC 银行对账单派生表）；两表不进 ALL_TABLE_KEYS、不写 linked_table_meta、前端不可见 |
| 整组匹配从严 | BOC 引擎组级任一校验失败 → 整组失败：不产出、不消耗渠道行、记 log+warning（比 JPM「取第一」更严，资金红线宁缺勿错） |
| weekTag（ISO 8601） | `YYWW` 周数标签，✅ Q2 拍板口径 = ISO 8601（周一为周首、含首个周四的周为 W1）、YY 取 ISO week-year（非日历年） |
| weekTagPlusOne | 「+1」用日期语义实现 = 判断日期 +7 天所在周的 weekTag（禁 YYWW 数字加法，年末必错） |
| 差错池 | Payment 引擎主轮未命中（金额币种相等但 BillDate 早于交易时间）的对账单二轮匹配池，✅ Q5 拍板放宽周数约束 |
| excludeBankRowIds | ✅ Q3「网关回填优先」不变量：R5s2 已消费/已回填的 bank `_rowId` 集合，R5s2b 构建银行池时剔除，两引擎零互相覆盖 |

---

## 五、功能详细描述

### 5.1 块 A：JSZip 崩点止血 + 报错可见性（PR-A）

#### 5.1.1 说明

- **A1 入口尺寸预检（止血）**：
  - 输入：导入文件（pending / linked-table / biz-op / vcc 四方）。
  - 处理：用 yauzl 读中央目录的无符号 entry 尺寸，检查目标 sheet XML 与 `xl/sharedStrings.xml` 的 `uncompressedSize`。
  - 输出：`≥ 2^31` → 抛 `FileValidationError`，中文文案（要素必含）：「文件数据量过大：表格内容解压后约 X.XX GB，超出当前导入通道单文件上限（2GB）」+「请将文件拆分为多个较小文件分批导入（参考：约 80 万行以内/文件）」，detailLines 带 entry 名与字节数。
  - 边界条件：预检自身失败（zip 打不开/找不到 entry）→ **fail-open 放行**，让原链路报原错（预检只拦「确定超限」，不引入新误伤面）。上限值 ✅ OPEN-3 拍板 = **2147483648（2^31 整）**。
  - 调用落点 3 处：`readXlsxStreamed` 入口、`vcc-op-calc-import/reader.js`、`biz-op-recon-import/reader-streamed.js`（实施时逐一核实是否独立持有 JSZip `loadAsync`，独立则各自加调用）。
- **A2 链接表报错可见性**（修「报错全链路零落盘」三处丢失点）：
  - 输入：`linked-table:import` 多文件导入结果。
  - 处理：① handler（`main.js:11273`）循环结束后若存在 `read-error / write-error / ambiguous / unrecognized` → `appendActivityLogEntry`（error 级，message 含 N/M 失败计数，details 列 per-file `fileName + status + message`）；② 弹窗（`renderer-dialogs.js:6399`）保留 `skipLogReport`（日志改由 #1 权威落盘，避免双写）；③ C3/运行前提醒两入口（`renderer.js:3738`/`:3885`）消费返回值，存在失败项 → 弹 alert 列 per-file 失败明细。
  - 输出：链接表导入失败 → activity log 出现 error 条目 + UI 弹明细。

#### 5.1.2 影响范围

- 后端：`streaming-xlsx-reader.js`（或同目录新小模块）、`vcc-op-calc-import/reader.js`、`biz-op-recon-import/reader-streamed.js`、`main.js`（A2 #1）。
- 前端：`renderer-dialogs.js`（A2 #2 注释）、`renderer.js`（A2 #3）。
- 对外接口影响：无（不改任何落库语义）。
- 兼容性影响：无（纯防御护栏 + 可观测性）。

#### 5.1.3 UI Mockup（如适用）

```
[导入超大文件] →（A1 预检命中）→ 错误弹框：
  「文件数据量过大：表格内容解压后约 2.56 GB，超出当前导入通道单文件上限（2GB）。
   请将文件拆分为多个较小文件分批导入（参考：约 80 万行以内/文件）。」

[链接表导入部分失败] →（A2 #3）→ alert：
  「以下文件导入失败：
   - 渠道A.xlsx：unrecognized（无法识别表类型）
   - 渠道B.xlsx：read-error（…）」
```

---

### 5.2 块 B：挂账 pending 导入迁移大表引擎（PR-C）🔴🔴

#### 5.2.1 说明

- 输入：pending 多文件导入（单月 `yearMonth` 由 UI 入参，行内无月份列）。
- 处理：JSZip→yauzl 引擎、child_process→worker_threads、多文件并行；落库语义**全部逐字平移**：
  1. 单大事务 BEGIN → `deleteMonth`（6 表，顺序敏感）→ 逐行 `computeRowHash` 跨文件去重 → 33 参 INSERT → 任一错误（含单条重复行）→ **整批 ROLLBACK** → 全通过 → `upsertMonthMeta` → COMMIT。
  2. 错误协议 `{severity: fatal|row, file, sheetRow, message, cells}`，row 级上限 **1000** 条带 cells（供导报错 xlsx）。
- 输出：`pending_rows` / `pending_months` 入库，与旧链路 byte-for-byte 一致。
- 边界条件：跨文件重复行文案 `发现重复行（hash xxxxxxxx...）` 逐字平移（单条重复行 = 全量 ROLLBACK）；空文件（仅表头）整批拒绝；错误超 1000 条截断。
- 回退开关：`USE_BIG_TABLE_IMPORT_ENGINE_PENDING`，默认 true；测试经 env `PENDING_FORCE_LEGACY_IMPORT=1` 强制旧路径做对照。
- **R-6 行为收紧（intentional divergence）**：旧 pending 硬编码 `sheet1.xml`（多 sheet 静默读第一个）→ 引擎 rels 正解多 sheet **报错**（防静默读错表，方向正确，CHANGELOG 注明）。

#### 5.2.2 影响范围

- 后端：新建 `src/backend/pending-import/contract-pending.js`、`src/main-process/big-table-import-dispatch.js`；改 `pending-session.js`、`main.js`（session 接线）。
- 旧链路保留：`worker.js` / `month-repository.js` / 旧 reader 一字不改保留（回退开关 false 时走全旧链路）。
- 对外接口影响：`pending:error:export-report` 与 UI 弹窗**零改动**（引擎错误对象还原为现行 `lastImportErrors` 形态）。
- 兼容性影响：除 R-6 多 sheet 报错外行为不变。

#### 5.2.3 UI Mockup（如适用）

无（导入进度与错误弹窗形态零改动，仅底层引擎切换；大文件导入期 UI 流畅由 W4 属性保证）。

---

### 5.3 块 C：业务OP 对账 biz-op flow 导入迁移引擎（PR-D）🔴

#### 5.3.1 说明

- **范围裁定（✅ OPEN-1）**：只迁 flow（流水）侧；bizOp（业务OP）侧不迁。
- 输入：flow 多文件 multiSelections（28 列表头）。
- 处理：契约 `contract-flow.js`（FLOW_HEADERS 28 列）；clear 语义 = 2 条 SQL（`clearRunsAndDiffsByDate(date)` + `clearByDate(date)`，参数=入参 date、与行内容无关）→ E1 即可表达；多文件「清一次后续累加」= 引擎 overwrite 天然（事务头清一次）。
- 输出：流水表入库 + 错误报告 xlsx 内容（需 rawRow），与旧链路逐字段一致。
- 边界条件：错误上限 1000 + captureRowValues（错误报告需整行 cells）；行内 date 与入参 date 一致性校验若存在则实施时核实平移（调研未见、待核）。
- 回退开关：`USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW`（旧 import-worker 全保留；bizOp 侧继续走旧 worker 不动）。

#### 5.3.2 影响范围

- 后端：新建 `src/backend/biz-op-recon-import/contract-flow.js`；改 session 接线（走 §六共享 dispatch 模块）。
- 对外接口影响：错误报告 xlsx 形态不变。
- 兼容性影响：bizOp 侧旧链路零改动（既有集成脚本全绿即可）。

#### 5.3.3 UI Mockup（如适用）

无（导入交互形态零改动）。

---

### 5.4 块 D：银行对账单输出三点修复

#### 5.4.1 说明

**F1 — Extra Fee 写盘取相反数（🔴 资金红线）**

- 输入：C3 场景「金额不一致」输入框值。
- 处理：写盘点 `c3-gateway-recon-join.js:216` `normalizeCellValue(fee)` → `normalizeCellValue(-fee)`（1 行 + 注释重写）。
- 输出：输出 Extra Fee 列 = 输入框相反数（**匹配语义不变**，DS1-DS9 匹配语义断言一行不改全过）。
- 边界条件（✅ 拍板）：**D2 负输入对称取反**（输入 -3 → 写 '3'，无特判）；fee=0 → `String(-0)='0'` 不出 '-0'；「原值=newFee 不标黄」语义自动平移；enabled 但 amount 非数 → fee=null 整段跳过。
- 风险声明：存量已配置 extraFee 的场景升级后同一输入产出符号相反的文件；取反值同时出现在主输出、命中明细文本、命中场景行报表三个出口；链接表 `extra_fee` 列新旧符号数据混存（仅 passthrough 无计算消费）。

**F2 — 存放目录互换**

- 处理：① `scenario-hit-rows-writer.js:43` `DEFAULT_REPORT_SUBDIR = 'error-reports'` → `'bank-statement-process'`；② `main.js:3675` 之后新增 `errorReportRootDir = path.join(ensureStorageRoot(), 'error-reports')`，`:3695` 实参改用之（**严禁动 `:3675` 本体**，R5 场景3/4 兜底依赖）。
- 终态路径（✅）：错误报告 `…/error-reports/{YYYY-MM-DD}/{14位ts}-error-report.xlsx`；命中场景行 `…/bank-statement-process/{YYYY-MM-DD}/命中场景行-{basename}-{ts}.xlsx`。
- 边界条件：cancel 路径（saveDialog 前已落盘）同落新目录且 UI 无提示（**验收只能查文件系统**）；empty 分支同落新目录；historical 文件原地保留（CHANGELOG 显式说明）。

**F3 — 「行号」列换「对账ID」**

- 处理：① `exceljs-writer.js:179` 表头 `'行号'` → `'对账ID'`（✅ D3 命名「对账ID」）；`:189` 取值改**三级回退链**（✅ D4 单列三级回退，✅ D5 顺手认 reconId）：`reconciliationId`（String+trim 非空）→ `w.reconId`（R1 专用字段）→ `w.rowId` → `''`。② `bank-statement-io.js:246` `writeErrorReportOutput` 签名加可选 `bankRows`，写前 enrich `Map(_rowId → ReconciliationId)`。③ `main.js:3693-3696` 调用点加入参 `bankRows: [...modifiedRows, ...unmatchedRows]`（**unmatchedRows 必含**，R5s4 warning 行依赖它）。
- 语义说明（spec 固化）：展示值=导出时**最终** ReconciliationId（warning 产生后可能被 C1/R5s2 改写），与主输出文件可交叉定位；rowId=null 的 config 类 warning 列值仍 `''`；同一 reconid 多行（R1 multi-bank-match）无法唯一定位行。

#### 5.4.2 影响范围

- 生产代码 5 文件全部小改：`c3-gateway-recon-join.js`、`scenario-hit-rows-writer.js`、`exceljs-writer.js`、`bank-statement-io.js`、`main.js`。
- **对外契约变更（🔴 需 CHANGELOG 显式标注，三条）**：① Extra Fee 列数值符号翻转；② 两类产物路径互换（外部 VBA/pandas 脚本按旧路径读取需适配）；③ error report 第 3 列「行号」→「对账ID」（按列名解析需适配）。
- 零改动面：renderer / preload / IPC 字段、DB schema（无 migration）、引擎匹配与 warning 逻辑、44 列表头契约（列名 Extra Fee 不变只变值）。
- 实施约束：F2 与 F3 都改 `main.js:3693-3696` 同一调用表达式 → 两 commit 必须串行（顺序见 §6 实施记录；commit 顺序 F1→F3→F2→docs）。

#### 5.4.3 UI Mockup（如适用）

```
error report（错误报告）第 3 列：
  旧：| 时间戳 | 场景名 | 行号   | 原因 | 可能原因 |
                          row_37
  新：| 时间戳 | 场景名 | 对账ID | 原因 | 可能原因 |
                          R20260601xxxx（空则回退 row_N）
```

---

### 5.5 块 E：BOC 调拨订单修复

#### 5.5.1 说明

**F1 — BOC 内置写死场景种子（需求1）**

- 处理：`migrations.js` 紧跟 JPM 种子之后新增 `BOC_DISPATCH_ORDER_SCENARIO`（category='gateway-recon-id-fix'、name='BOC调拨订单修复'、priority=3、config={subCategory:'boc-dispatch-order-fix', channelName:'BOC'}）+ `ensureBocDispatchOrderScenarioSeed`（逐条复刻 JPM 种子：CHECK 前置/独立 marker/LIKE 定位/enabled=0/is_builtin=1/channel_id=1/UNIQUE 冲突跳过/事务+marker）。`database.js` init 链在 JPM 种子之后调用。
- 输出：场景管理列表序号 2 / 功能类别=网关对账单修复 / 默认未启用 / 只读行（零前端改动）。
- 边界条件：老库存在用户自建 gateway 场景 priority=3 且 id 更小时会插队（序号 2 非强保证，与 JPM 同口径，不扩置顶机制）。

**F2 — BOC 链接表派生管线（需求2，两张隐藏表）**

外汇交割表导入后的派生流程（2.1~2.5）：

- **2.1 / Step1（scanFxGroups）**：从 A3 按物理行序扫描「交易编号」连续段分组；「交易编号」归一化为空（含合计/页脚等非数字行）→ 关当前组、该行不入表；`rowNumbers` 断档（被过滤的全空行）→ 关组；连续纯数字段成组，组号 1,2,3… 仅在非空段递增。
- **2.2（matchBocToMidAllocation 前段）**：候选 = 中台「付款渠道」='BOC' 行（预解析交易时间取日期、收款金额取分，解析失败剔候选 + warning）；按中台行序遍历，找「分组非空 ∧ 到期日=候选日期 ∧ 货币2金额(分)=收款金额(分)」的 BOC 行；多命中行序优先取首 + log；命中行「分组」清空，该中台行消耗（不进 2.3）。
- **2.3（matchBocToMidAllocation 后段）**：剩余组按分组汇总货币2金额（组内任一行金额非数值→整组放弃 + warning；组内到期日不一致→warning + 取首行）；与未消耗中台候选（同日期对齐）匹配；命中→「调拨单号」回填**组内所有行**，一组配一单（消耗）；多候选行序优先 + log；无命中组调拨单号留空。
- **2.4（buildBocBankRows）**：✅ U2 拍板——**先查链接表库 bank-deposit 已有 BOC 数据，有则直接派生回填不弹框；缺数据才弹「导入/取消」引导框**。availability 三态：候选 0 行=`no-boc-rows`；候选有行但全无 Payment Detail 自有键（旧 13 字段时代导入）=`missing-payment-detail`；否则 `ok` 并按 `地区='CN' ∧ Currency='USD' ∧ Credit Amount 转分=0` 过滤，Payment Detail 含「无折存款借记交易」→提取**最长连续数字串**（✅ U3，并列取最先 + log；含关键词但无数字→'' + warning）赋「银行单交易编号」。派生第二张隐藏表 BOC调拨银行对账单表。
- **2.5（backfillBocReconLinkIds）**：交易编号↔银行单交易编号匹配，命中→「资金对账不平表链接ID」=该行 ReconciliationId，未命中→''；幂等全量重算（旧值被覆盖）；`unlinkedCount>0` → 写 warning 级 activity log（含行号/交易编号明细，**前端不显示**——需求 2.5 末句）。

整组匹配从严语义补充：2.2/2.3 为一对一消耗匹配（全部多解记 warning 不抛错）；✅ O3 Amount/金额取值「货币1金额」原值透传；✅ O4 金额匹配不附加币种校验（仅金额+日期）。

✅ U1 拍板：中台调拨订单表无「交易日期」列 → 用「交易时间」取日期部分（与 `linked_mid_allocation.transaction_date` 现状口径一致）。

✅ U4 拍板：重算触发时机 = 外汇交割表导入→全量重建 BOC链接表（2.2~2.5 全跑）；银行对账单表导入→重派生 BOC调拨银行对账单表 + 对现有 BOC链接表补做 2.5 回填；**中台调拨订单表导入不触发**（调拨单号 stale 风险记文档）。

🔴 **bank-deposit 落库白名单 13→14**：插入 `'Payment Detail'`（需求 2.4 提取依赖；存量已导入行无此字段无法 migration 补，识别后引导重导）。

弹框链（✅ O1 拍板，bank-deposit 导入触发的补回填成功时静默；✅ O2 报错落运行结果弹框 + activity log）：

| 条件 | 行为 |
|---|---|
| `bocDerive.created && total>0 && !needBankImport` | 弹「BOC链接表已生成」提示（skipLogReport） |
| `needBankImport`（U2） | 弹 confirm「…无法回填资金对账不平表链接ID。是否现在导入 BOC 银行对账单？」导入→复用链接表管理导入流程；取消→关闭。`missing-payment-detail` 时提示**重新导入** |
| `total===0` | 静默（仿 ADM 0 行拍板） |
| `created:false` / `bocBankDerive` 失败 | 错误弹框 |
| bank-deposit 导入触发的补回填成功 | 静默（✅ O1） |

**F3 — BOC 调拨订单修复引擎（需求3）**

导入资金对账不平表（gateway 模式）后运行该场景，渠道账单 channelName=BOC 行的 reconciliationId ↔ BOC链接表「资金对账不平表链接ID」整组匹配；全组命中后用组「调拨单号」找网关账单 OrderId 同值行，复制 N 份（N=组行数）写修复模板，Type=2 / Reference=组内行链接ID / Amount=组内行「货币1金额」；可导出另存为；匹配失败记 log + 前端展示。

匹配语义决策表（✅ 全部拍板，资金红线从严）：

| # | 决策点 | 拍板 |
|---|---|---|
| D1 | 渠道 BOC 行 ↔ 链接表行 1v1 消耗 | 是；组内同链接ID 出现 k 次须有 k 条同 reconId 渠道行 |
| D2 | 链接ID 为空的链接表行 | 不可匹配，所在组必然整组失败 |
| D3 | 组失败粒度 | 整组失败：不产出、不消耗已试配渠道行、记 log+warning |
| D4 | 网关 OrderId 命中数 | 唯一命中才生成；0/≥2 命中整组失败 |
| D5 | channelName 比较 | trim 后精确等值（大小写敏感），值从 config 读、常量兜底 |
| D6 | 渠道 BOC 行未命中链接表 | 只计数不告警 |
| D7 | 同链接ID 跨多组 | 数据异常，相关组全失败 |
| D8 | 两组共享调拨单号 | 第二组失败（同一网关行复制两轮属资金风险） |
| D9 | Type 写值 | number 2 |
| D10 | Amount 取值 | 「货币1金额」原值透传，不 parseNumber 改写 |
| D11 | 网关匹配加 MerchantId 过滤 | 不加（OrderId 等值唯一判据） |

前端反馈改造：结果弹框逐条显示前 5 条 warning 中文 message（手工 escape 后拼，防注入），超 5 条尾缀「等 N 条，详见操作日志」；0 命中兜底文案去 JPM merchantId 硬编码改通用文案；有警告时弹框带 logLevel:'warning' 上报。报错落**运行结果弹框 + activity log**（✅ O2，不动 bankStatementStatusBox 禁写决策）。

#### 5.5.2 影响范围

- 新建 7 文件：`boc-fx-link-fields.js`、`boc-dispatch-order-fields.js`、`boc-fx-link-builder.js`、`scenario-engines/boc-dispatch-order-fix.js`、4 个单测文件、`scripts/integration/v3.0.4-boc-dispatch-order-fix.js`、`docs/iterations/v3.0.4/manual-test-checklist.md`。
- 修改 7 文件：`migrations.js`、`database.js`、`linked-table-repository.js`（白名单 🔴 + defs + 6 函数）、`src/main.js`（import 钩子×2 + 数组路径守卫 + WithMeta + run 注入与日志，含 NUL 须 `grep -a`）、`recon-id-fix-engine.js`、`renderer-dialogs.js`、`renderer.js`。
- 对外契约变更（CHANGELOG 标注）：银行对账单表落库字段 +1（Payment Detail，需重导才生效）；新增隐藏表 2 张。
- 与同迭代关系：与块 D（C3/error-report 域）零代码文件交叉（除 main.js 不同 hunk）。

#### 5.5.3 UI Mockup（如适用）

```
[场景管理 · 网关对账单修复]
  1  JPM调拨订单修复   [未启动] [管理]（只读）
  2  BOC调拨订单修复   [未启动] [管理]（只读）  ← 新增

[导入外汇交割表后] →（needBankImport）→ confirm：
  「BOC链接表已生成分组与调拨单号，但链接表库无可用的 BOC 银行对账单数据，
   无法回填资金对账不平表链接ID。是否现在导入 BOC 银行对账单？」 [导入] [取消]

[运行 BOC 修复引擎后] → 结果弹框：
  「BOC调拨订单修复：成功 X 组 / 失败 Y 组，Z 条警告
   - [group-allocation-inconsistent] 组 2 调拨单号不一致…
   - …（前 5 条，超出尾缀「等 N 条，详见操作日志」）」
```

---

### 5.6 块 F：Payment 线下调拨订单回填处理

#### 5.6.1 说明

挂载方式（✅ D3）：R5 场景2 的 config 子开关 + 新引擎文件 + 编排器 R5s2b 步骤（不新建独立场景）。

**F1 — UI 勾选行 + 条件展开行**

- 在「请选择适用的银行渠道」页面（被全部 9 个 builtin-fixed 场景共用）银行渠道下拉框下侧新增勾选框「Payment线下调拨订单回填处理」（按 `config.subCategory==='fund-transfer-backfill'` 条件渲染）。
- 勾选后另起多行显示三组 label+input（✅ Q1）：**银行渠道[如 BGL] / 地区 / 大账号[如 202782001]**，无第四组；独立多行布局（564px 约束）；显隐联动照 C3 extraFee 范式（取消勾选保留输入值）。
- 校验：勾选时三项**全必填**；**inline 校验不关弹窗**（替代 alert+reopen 丢草稿）；输入框不预填生产值，placeholder 给示例（✅ D7）。

**F2 — 配置持久化与契约守卫（🔴）**

- schema：`config.paymentOfflineBackfill = { enabled, bankChannel, region, bigAccount }`（老库无字段 fallback enabled=false）。`region` **参与银行侧筛选**（✅ Q1），非仅记录展示。
- 保存：把 `update(scenarioId,{priority})` 扩为 `{priority, config:{...cachedConfig, paymentOfflineBackfill}}` 读-改-写浅合并（维持两段 IPC 不加第三段）。
- 🔴 红线：合并**严禁丢失** funcCategory/subCategory/roundPhase/directions/dateToleranceDays（丢任一字段场景静默掉出 r5s2 桶或引擎漂移）。守卫双层：① main 进程对 builtin-fixed config 更新加「必含 funcCategory/subCategory」最小校验；② 单测断言「注入 paymentOfflineBackfill 后 bucketScenarios 分桶不变」。

**F3 — 周数工具 + FTA 解析 + 字段常量（纯函数地基）**

- 新模块 `engine-week-utils.js`（独立于 engine-date-utils，日期解析复用其 `toDate`）：
  - `parseFtaDate(调拨单号)`：`/^FTA(\d{8})/` 提取 + 合法日期校验，失败返回 null。
  - `weekTag(date) → 'YYWW'`：订单侧/银行侧共用同一实现；✅ Q2 拍板 ISO 8601（周一为周首、含首个周四的周为 W1），YY 取 ISO week-year。基准断言四元组写死：2026-06-02→`2623`、2026-01-01→`2601`、**2025-12-29→`2601`**、**2027-01-01→`2653`**。
  - `weekTagPlusOne(date)`：✅ D2「+1」用日期语义 = 判断日期 +7 天所在周的 weekTag（禁 YYWW 数字加法，年末必错）。
- 新建 `payment-offline-allocation-fields.js`（启动期断言）锁死中台列名（**收款账户（卡号）idx6 全角括号**、付款渠道、调拨单号、交易时间、收款金额、收款币种、渠道流水号）与银行列名（MerchantId/FundType='FundTransfer-in' 大写 T/BillDate/'Credit Amount'/Currency/ReconciliationId）。

**F4 — 数据接线与缓存失效（🔴）**

- `bank-statement:run`：仅当 r5s2 场景 enabled **且** `config.paymentOfflineBackfill.enabled` 时 `workingMidRows = structuredClone(database.readLinkedTableRows('mid-allocation'))`（gating 防整表无谓载入）。
- `runReconciliation` 新入参 `midAllocationContext`；编排器 R5s2b 显式接线（gating = r5s2Bucket 非空 ∧ paymentOfflineBackfill.enabled ∧ midRows 非空），显式传 `{bigAccount, bankChannel, region, excludeBankRowIds}`（✅ Q3 网关回填优先，excludeBankRowIds = R5s2 已消费/已回填 bank `_rowId` 集合）。
- 🔴 **mid-allocation 导入补清 processingResult**（独立于 ADM try 块）；验收项「先 run → 重导中台表 → 直接导出被拒」。
- ✅ Q4：「订单对账周数号/银行对账周数号」run 时现算不持久化（纯内部匹配中间值，不进导出/弹窗）。

**F5 — 匹配引擎 `r5-payment-offline-allocation-backfill.js`（🔴 资金红线核心）**

纯函数 `(bankRows, midAllocationRows, options) → { modifications, warnings }`，骨架照搬 R5s2：

🔒 引擎不变量（✅ Q3 网关回填优先）：R5s2 先跑；本引擎构建银行池时剔除 excludeBankRowIds——两引擎零互相覆盖。

1. **订单池**：收款账户（卡号）===bigAccount ∧ 付款渠道===bankChannel；逐行 parseFtaDate → 订单周数号；FTA 不合规的筛中行计 warning（✅ D4 不静默消失），未筛中行跳过。
2. **银行池**（✅ Q1 三条件）：MerchantId===bigAccount ∧ FundType==='FundTransfer-in' ∧ 地区列===region；构池前剔除 excludeBankRowIds；BillDate → 银行周数号。
3. **周数 join**：订单按周数号 Map 分组；银行行按「其周 = 订单周+1」查桶（weekTagPlusOne 日期语义）。
4. **主轮匹配**：'Credit Amount'↔收款金额（`Math.round(*100)` 分级精度）∧ Currency↔收款币种 ∧ BillDate 晚于交易时间（✅ Q6 **日粒度、同日算晚于**：BillDate 取日 ≥ 交易时间取日）→ 候选按 |BillDate−交易时间| 天数差升序稳定排序贪心取最近（tie=原序 first-wins）；严格 1v1 usedSet。
5. **差错池**（✅ Q5）：金额币种相等但 BillDate（日）**严格早于**交易时间（日）→ 入差错池；主轮后二轮匹配：**范围 = 全部未被消费的订单（放宽周数约束，不限「周数+1」）**，条件 = 金额+币种相等 ∧ BillDate 晚于交易时间（Q6 同口径）∧ 就近贪心；usedSet 与主轮共享防重复消费；匹配成功同样回填+标黄。
6. **回填**：订单['渠道流水号'] → bank.ReconciliationId，`nv=normalizeCellValue(...)`、`old!==nv` 才写 + record（自动标黄）；命中即覆盖（✅ D6）。
7. **warning**：code 连字符风格（payment-offline-no-order-match / payment-offline-multi-candidate / payment-offline-invalid-fta…）；**银行侧 warning 必带 _rowId**（供块 D F3 终态对账ID enrich 反查）。

**F6 — 输出链收口**：标黄/写盘零改动；`error-causes.js` CAUSE_MAP 补全部新 code；error-report 形态按块 D 终态书写（error-reports/{date}/ + 对账ID列）。

**F7 — 测试/文档/守卫**：见 §六、§七。

#### 5.6.2 影响范围

- 新增 3 文件：`r5-payment-offline-allocation-backfill.js`、`engine-week-utils.js`、`payment-offline-allocation-fields.js`。
- 改 6 文件：`renderer-dialogs.js`、`styles-gemini-extra.css`、`main.js`（run 注入 + 导入清缓存 + config 校验）、`reconciliation-orchestrator.js`、`error-causes.js`、`renderer-previews.js`/`package.json`（preview 入口）。
- 零 migration、零新表、零新 IPC。
- 多组配置（多渠道×大账号）先单组，schema 留数组升级空间（✅ D8）。

#### 5.6.3 UI Mockup（如适用）

```
[请选择适用的银行渠道 · R5 场景2]
  银行渠道：[多选下拉]              优先级：[ ]
  ☑ Payment线下调拨订单回填处理        ← 勾选行（新增）
  ┌─（勾选后展开）──────────────────────┐
  │ 银行渠道：[如 BGL]  地区：[____]      │
  │ 大账号：[如 202782001]               │
  └──────────────────────────────────────┘
  [保存]（三项全必填，inline 校验不关弹窗）
```

#### 5.6.4 块 F 修订 R2（2026-06-12）— 匹配方向翻转 + 阶梯式放宽 + 核对 sheet（🔴 资金红线）

> 来源：`changes/payment-offline-allocation-backfill/spec.md` 文件头「修订 R2（2026-06-12）」段（R2.1 实证背景 / R2.2 拍板表 Q9-Q14 / R2.3 终态匹配规则 / R2.4 真实数据验收基准）。
> 本小节为 §5.6.1 块 F 初版规则的增量修订；凡与初版描述冲突处均在下文逐条标注「修订 R2 取代」，初版原文保留作历史记录。

**A. 背景（为什么改）**

用真实业务文件复盘初版规则（调拨单 5618 行 / CITI-LU 渠道账单 159 行，配置大账号=202782001 / 银行渠道=CITI / 地区=LU），初版几乎零命中（仅 1 行）。逐级诊断确认两处方向性错误：

1. **匹配方向反了**：初版口径是「银行周 = 订单周 + 1」（§5.6.1 F5 步骤 3「银行行查订单周+1 桶」），但线下调拨的真实业务是**钱先动、单后补**——81/101 笔订单的「交易时间」与银行 BillDate 同日，FTA 调拨单号上的日期在其后约一周（后台周二批量补录），因此正确方向应为「**银行周 + 1 = 订单周**」。**（修订 R2 取代 §5.6.1 F5 步骤 3 的 join 方向）**
2. **渠道筛选列错了**：线下订单的「付款渠道」是出款行（如 BGL），真正标识账单所属渠道的是「**收款渠道**」（如 CITI）。初版按「付款渠道===银行渠道」筛选在线下场景得 0 行（命中的几十笔全是线上 CFT 单，归网关回填管辖）。**（修订 R2 取代 §5.6.1 F5 步骤 1 的订单池筛选条件）**

**B. 新业务规则（用户视角）**

- **核心语义**：线下调拨 = 钱先动、单后补 → 订单周 = 银行周 + 1（用户不需感知周数计算，仍照常勾选并填三项配置）。
- **订单池筛选**：收款账户（卡号）= 大账号 ∧ **付款方式 = 线下** ∧ **收款渠道 = 银行渠道输入值**（UI 仍填账单所属渠道如 CITI；初版按「付款渠道」筛选作废）。
- **三轮阶梯匹配**（依次放宽，匹配成功的行不再进入下一轮）：

| 轮次 | 范围 | 条件 | 救回场景 |
|------|------|------|---------|
| 第 1 轮（主轮） | 同周桶（订单周 = 银行周+1） | 金额币种相等 ∧ 银行 BillDate ≥ 订单交易时间（日粒度，同日算晚于） | 标准命中（实证 87 笔） |
| 第 2 轮（日期容差） | 同周桶 | 金额币种相等 ∧ BillDate ≥ 交易时间 − **2 天** | 录单滞后（晚 1 天/晚 2 天，实证 7 笔） |
| 第 3 轮（不限周兜底） | **全部未匹配订单（不限周）** | 金额币种相等 ∧ \|BillDate − 交易时间\| ≤ **7 天**，按天数差就近 | 跨周界错位（实证 6 笔） |

- **规则上限**：三轮合计达 100/101；最后 1 笔（4.5M EUR，交易时间 05-29）全池最近可用同额行差 25 天，属真实数据缺口（对应银行行不在本期账单），**不为凑 100% 继续放宽窗口**——剩余未匹配行维持三态 warning，落未匹配报告供人工核对。**（修订 R2 取代 §5.6.1 F5 步骤 4-5「主轮 + 差错池」两阶段设计：初版 Q5 差错池——「金额币种相等但严格早于交易时间」入差错池再放宽周数二轮——整体由三轮阶梯取代并作废）**

**C. 新增产物：3 个核对 sheet**

勾选本功能**且有命中时**，导出主处理文件追加 3 个核对 sheet（便于人工逐笔复核回填结果）：

| sheet | 内容 | 列说明 |
|-------|------|--------|
| 匹配对照 | 每笔配对的银行行↔订单行关键字段对照 + **匹配轮次** | 15+1 列（含配对序号、匹配轮次） |
| 银行行-原始 | 命中的银行行原始 44 列内容 | 剥除内部字段，带配对序号 |
| 订单行-原始 | 命中的订单行原始 26 列内容 | 签名列序，带配对序号 |

三个 sheet 通过**配对序号互查**（同序号即同一笔配对）。**无命中时主文件形态零变化**（不追加 sheet）。

**D. UI 变化**

银行渠道输入框的 placeholder 示例从「如 BGL」改为「如 CITI」（语义 = 账单所属渠道 / 收款渠道）。**（修订 R2 取代 §5.6.1 F1 与 §5.6.3 UI Mockup 中的「银行渠道[如 BGL]」示例文案——填写语义不变，仍是账单所属渠道，仅示例值纠正）**

**E. 真实数据验收基准（回放断言）**

两份真实文件直跑引擎：匹配对 = **100**（第 1 轮 87 / 第 2 轮 7 / 第 3 轮 6）、回填数 = 100、银行侧未匹配 = **51 行**（49 行线上已有 ReconciliationId + 05-22 一笔 3M + 05-04 一笔 4.5M）、唯一未消费订单 = **FTA202606021000465**。

---

## 六、验收标准

> 本章节按块列 AC。

### 6.1 块 A AC

| AC 编号 | 验收条件 |
|---------|---------|
| ACa-1 | 预检函数对「正常 / ≥2^31 构造样本 / 损坏 zip（fail-open）/ zip64」四态断言通过 |
| ACa-2 | 导入 ≥2^31 文件弹明确中文错误（含解压尺寸 GB + 拆分指引），detailLines 带 entry 名与字节数 |
| ACa-3 | 链接表导入失败路径 → activity log 出现 error 条目（含 N/M 失败计数 + per-file 明细） |
| ACa-4 | C3/运行前提醒两入口部分失败时弹 alert 列 per-file 失败明细（不再静默丢弃） |
| ACa-5 | preview 回归无布局回归（A2 不动 dialog 结构） |

### 6.2 块 B AC

| AC 编号 | 验收条件 |
|---------|---------|
| ACb-1 | parity 脚本双跑（legacy env vs 引擎）断言 `pending_rows`/`pending_months` 全表 dump byte-for-byte |
| ACb-2 | 错误路径（文案/计数/cells/截断标志）逐字段一致；fixture 含多文件、跨文件重复行、表头错、空文件、小文件、错误超 1000 条截断 |
| ACb-3 | 覆盖重导后 diff_runs/removed_pending_rows 联动清理（含「覆盖重导后关联表清空」断言） |
| ACb-4 | 重复行文案 `发现重复行（hash xxxxxxxx...）` 逐字一致；单条重复行 = 全量 ROLLBACK |
| ACb-5 | 中途失败月元数据不残留（upsertMonthMeta 在 COMMIT 前事务内执行） |
| ACb-6 | 多 sheet 文件引擎报错（R-6 intentional divergence，文案可读，CHANGELOG 注明） |
| ACb-7 | 回退开关 false（`PENDING_FORCE_LEGACY_IMPORT=1`）走全旧链路 |

### 6.3 块 C AC

| AC 编号 | 验收条件 |
|---------|---------|
| ACc-1 | parity 脚本双跑流水表 dump + 错误报告 xlsx 内容 + rejected 路径文案逐字段一致；fixture 含多文件合并、行级校验错、整批拒绝 |
| ACc-2 | bizOp 侧旧链路回归不动（既有集成脚本全绿） |
| ACc-3 | 回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW` false 走旧 import-worker |

### 6.4 块 D AC

| AC 编号 | 验收条件 |
|---------|---------|
| ACd-1 | F1：unit 全矩阵通过；DS1-DS9 匹配语义断言一行不改全过；输入 -3 写 '3'、0 写 '0'（不出 '-0'） |
| ACd-2 | F1：取反值同时正确出现在主输出、命中明细文本、命中场景行报表三个出口 |
| ACd-3 | F2：错误报告落 `error-reports/{date}/`、命中场景行落 `bank-statement-process/{date}/`；常量保护断言 `DEFAULT_REPORT_SUBDIR === 'bank-statement-process'` |
| ACd-4 | F2：cancel 路径错误报告落新目录（查文件系统，UI 无提示） |
| ACd-5 | F3：error report 第 3 列表头='对账ID'；三态回退（reconid 非空/空回退 rowId/全空 ''）；unmatchedRows 行可被 enrich 覆盖 |

### 6.5 块 E AC

| AC 编号 | 验收条件 |
|---------|---------|
| ACe-1 | F1：场景管理列表序号 2 / 只读行 / 默认未启用；种子单测 6 案 + 排序案（JPM→BOC 顺序 = [JPM, BOC]） |
| ACe-2 | F2：两张隐藏表 migration 幂等；不进 ALL_TABLE_KEYS、listLinkedTableMeta 不返回（隐藏红线断言） |
| ACe-3 | F2：BANK_DEPOSIT_FIELDS=14 断言（含 'Payment Detail'）；既有 13 字段断言同步更新 |
| ACe-4 | F2：scanFxGroups（分隔行/空行断档/尾部合计排除/组号递增）；2.2/2.3 一对一消耗回填；buildBocBankRows availability 三态；backfill 幂等重算 |
| ACe-5 | F2：单 sheet .xlsx 交割表走数组路径（不丢行号）；缺银行数据弹引导框（导入/取消两路）；missing-payment-detail 重导引导；unlinked 明细落 activity log 且前端无感 |
| ACe-6 | F3：组全配（Type===2 number / Reference/Amount 行级 / 11 列同源行）；组半配不消耗渠道行；OrderId 0/多命中整组失败；1v1 消耗（k 行同链接ID 需 k 条渠道行）；两组共享调拨单号第二组失败 |
| ACe-7 | F3：分流回归（boc/jpm/无 subCategory/business 四路）；入参不可变快照；集成脚本断言 14 列表头 + Type=2 + Reference/Amount 行级值 |

### 6.6 块 F AC

| AC 编号 | 验收条件 |
|---------|---------|
| ACf-1 | F3：weekTag 基准四元组写死断言（2026-06-02→2623 / 2026-01-01→2601 / 2025-12-29→2601 / 2027-01-01→2653）；FTA202606021000477→2623、FTA202604280200028 解析；+1 年末进位（日期语义） |
| ACf-2 | F2：注入 paymentOfflineBackfill 后 bucketScenarios 分桶不变；config 合并不丢 funcCategory/subCategory/roundPhase/directions/dateToleranceDays |
| ACf-3 | F5：Q6 同日算晚于边界断言（BillDate=交易日期当日 → 算晚于、可匹配）；主轮金额+币种+晚于+就近贪心 1v1 |
| ACf-4 | F5：差错池放宽周数约束二轮匹配；usedSet 跨两轮共享防重复消费 |
| ACf-5 | F5：双引擎互斥断言（excludeBankRowIds 剔除后 R5s2 命中行绝不被 R5s2b 触碰）；网关回填优先 |
| ACf-6 | F4：先 run → 重导中台表 → 直接导出被拒（mid-allocation 导入补清 processingResult） |
| ACf-7 | F1：勾选三项全必填 inline 校验不关弹窗；preview 截图（既有入口 + 新增展开态 `preview:builtin-fixed-channel-manage-payment`） |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| A 大文件止血 | 98w 行实证文件（≈2.56GB） | 块 A 已落地 | 弹明确中文错误 + 日志可查 |
| B pending 大文件导入 | 合成 300w fixture / 121w 实证档 | 引擎开关 true | UI 流畅（W4 不回退）、可取消、RSS/heap 留档 |
| B 覆盖重导 | 同月二次导入 | 已有该月数据 | diff_runs/removed_pending_rows 联动清理 |
| D 三点终态 | 同时产生 warnings + C3 extraFee 命中的样本 | 块 D 已落地 | error-report 落 error-reports/{date}/ 第 3 列=对账ID；命中场景行落 bank-statement-process/{date}/ Extra Fee=取反值；主输出 Extra Fee 取反+标黄；cancel 路径查文件系统确认 error report 落新目录 |
| E BOC 全链 | fx→bank→fx 三序导入 + 真实不平表 | 块 E 已落地、场景启用 | 三序收敛一致；运行弹框含失败文案；导出文件 14 列/Type=2/Reference/Amount 人工核对一份真实样本 |
| E 单 sheet .xlsx 交割表 | 单 sheet .xlsx 外汇交割表 | — | 确认走数组路径（不丢行号、分组正确） |
| F 回填全链 | 勾选 → 导中台表+对账单 → run → 导出 | 块 D 终态、块 F 落地 | 标黄/差错池/error-report 三出口正确；先 run 后重导中台表 → 直接导出被拒 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| A 链接表部分失败 | 多文件含坏文件 | — | activity log error 条目 + UI alert per-file 明细 |
| C biz-op flow 多文件 | flow multiSelections | 引擎开关 true | 流水表 + 错误报告 xlsx 与旧链路一致；bizOp 侧不受影响 |
| E 缺银行数据引导 | 仅外汇交割表（库无 BOC 银行数据） | — | 弹「导入/取消」引导框；missing-payment-detail 提示重导 |
| E activity log | 链接ID 有空值 | — | unlinked 明细落 log 且前端无感 |
| F 差错池 | BillDate 早于交易时间的样本 | — | 入差错池二轮匹配（放宽周数）成功回填 |
| F 跨年周边界 | 2025-12-29 / 2027-01-01 样本 | — | weekTag = 2601 / 2653（ISO week-year） |
| 场景管理序号 | — | 块 E 种子 | 序号 2 / 只读行 / 默认休眠 |

### 7.3 不测项与原因

- 块 D F2 `main.js:3695` 传参无任何自动化断言（IPC handler）→ 只能靠手测（已列 P0 cancel 路径）。
- vcc 迁移引擎：本迭代非目标，不测。
- bizOp 侧引擎迁移：✅ OPEN-1 不迁，不测（既有集成脚本回归即可）。
- 多组（多渠道×大账号）payment 配置：✅ D8 先单组，schema 留升级空间，本迭代不测多组。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 块 E 新增 2 张隐藏 SQLite 表 `linked_boc_fx_settlement` / `linked_boc_bank_deposit`（纯新增 DDL，不进 ALL_TABLE_KEYS/meta）；`BANK_DEPOSIT_FIELDS` 13→14（+ 'Payment Detail'，存量数据无法补需重导）。块 F：`config.paymentOfflineBackfill={enabled,bankChannel,region,bigAccount}`（零 migration，老库 fallback enabled=false）。块 B/C：无 schema 变更（落库语义逐字平移）。 |
| 状态流转变更 | 块 F：mid-allocation 导入由「不清 processingResult」改为「补清 processingResult」（前提被本功能改变）。块 E：外汇交割表/银行对账单表导入触发派生重算（U4 时机）。块 B：child_process→worker_threads 拓扑迁移（落库事务状态机不变）。 |
| 权限 / 安全 | 无鉴权变更。前端 warning 文案直插弹框须手工 escape 防 innerHTML 注入（块 E F3 / 块 F warning 含表格数据值）。 |
| 回滚策略 | 块 B/C：回退开关（`USE_BIG_TABLE_IMPORT_ENGINE_PENDING` / `..._BIZOP_FLOW`）置 false 即走全旧链路（旧 worker/reader/repository 一字不改保留）。块 E：两张隐藏表为纯新增 DDL（可弃用不影响既有表）；BANK_DEPOSIT_FIELDS 回退需注意加载期断言。块 D/F：代码级回退（无 DB 破坏性变更）。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 引擎扩展包铁律「契约不声明 ⇒ 引擎行为与 v3.0.3 完全一致」；收单契约（contract-flow/bill）一字不改，`acquiring-engine-migration.js` 全链对比脚本（34 断言）全绿为合并门。块 D 三项对外契约变更（符号/路径/列名）CHANGELOG 显式标注供外部脚本适配。 |
| 性能 | 块 B：解锁 300 万行设计目标；多文件并行（实测 4-worker 3.06x）；W4 属性不回退；dispatch `resourceLimits.maxOldGenerationSizeMb=4096`（dedupe Set 300w≈360MB）。块 F：mid 全表载入由勾选 gating 控制（防整表无谓载入）。 |
| 鲁棒性 | 块 A：A1 预检仅拦「中央目录尺寸 ≥2^31」，预检自身异常 fail-open（不误伤正常文件）；zip64/data-descriptor fixture 覆盖。块 B/C：任一错误整批 ROLLBACK。块 E：整组失败宁缺勿错（D1-D11 全从严，失败不产出）。 |

---

## 十、待澄清问题

- 本迭代决策点**全部已拍板**，无未决问题：
  - 入口：✅ OPEN-1（bizOp 不迁）/ OPEN-2（不收编收单）/ OPEN-3（上限 2^31 整）。
  - 块 D：✅ D2 负输入对称取反 / D3「对账ID」/ D4 单列三级回退 / D5 顺手认 reconId / D6 USER_GUIDE 加注记。
  - 块 E：✅ U1-U4 + D1-D11 + O1-O4（详见 §5.5 决策表）。
  - 块 F：✅ Q1-Q6 + D1-D8（详见 §5.6）。
- 实施期待核（非决策）项：块 C flow 行内 date 与入参 date 一致性校验是否存在（调研未见，实施时核实平移）；块 F「导入完成时」按数据就绪语义解释已按 Q4 拍板纯内部中间值实现。

---

## 十一、风险提示（人工复核）

> 资金敏感区逐条列。等级：🔴🔴 双红线 / 🔴 资金红线 / 🟡 中 / 🟢 低。

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| R-1 | pending 覆盖删除 6 表顺序/范围错 → 对账数据污染（Codex PR #55 Finding 1 同款：removed_pending_rows 残留让 reconcile 用陈旧归档错标核对结论） | 🔴🔴 | E1 逐字平移 6 条 SQL + 顺序；parity 脚本含「覆盖重导后关联表清空」断言；人工复核 deleteForOverwrite diff |
| R-2 | pending 去重/整批拒绝语义漂移（单条重复行=全量 ROLLBACK；文案逐字） | 🔴 | E5 写侧 Set + 按文件序单写保证确定性；parity 错误路径逐字段断言 |
| R-3 | upsertMonthMeta 脱出事务 → 崩溃中间态（有行无月元数据） | 🔴 | E2 finalizeForCommit 在 COMMIT 前事务内执行；单测断言中途失败月元数据不残留 |
| R-4 | 引擎扩展回归收单已迁链路 | 🔴 | 扩展全部契约可选 + 收单契约零改动 + 34 断言全绿为合并门 |
| R-5 | worker_threads 堆 vs 旧 child 8GB：dedupe Set 300w≈360MB + 写批缓冲 | 🟡 | dispatch `maxOldGenerationSizeMb=4096`；121w 实证档 + 合成 300w fixture 实测 RSS/heap 留档 |
| R-6 | pending 多 sheet 静默读第一个 → 引擎 rels 正解多 sheet 报错（行为收紧） | 🟡 | 记 intentional divergence（防静默读错表）；fixture 验证报错文案可读；CHANGELOG 注明 |
| R-7 | biz-op flow 错误报告 rawRow / 1000 上限 parity | 🔴 | E4 captureRowValues + maxCollectedErrors=1000；报告 xlsx 对比断言 |
| R-8 | A1 预检误伤正常文件 | 🟡 | 仅「中央目录尺寸 ≥2^31」拦截；预检自身异常 fail-open；zip64/data-descriptor fixture 单测 |
| R-9 | pending 小文件同步兜底移除 → 引擎统一路径 spawn 开销与 smoke 兼容 | 🟢 | worker 启动 ~百 ms 级可接受；smoke/集成全走引擎路径过一遍验证 |
| R-D1 | 块 D F1 Extra Fee 输出金额符号翻转（存量已配置场景升级后同一输入产出符号相反文件） | 🔴 | F1 仅改写盘 1 行；DS1-DS9 语义断言一行不改全过；人工核对一份真实样本三个出口符号；CHANGELOG 标注 |
| R-D2 | 块 D F2/F3 双重契约变更（路径互换 + 列名换） | 🔴 | 同 hunk 串行（commit F1→F3→F2→docs）；常量保护断言；CHANGELOG 合并成一段适配提示 |
| R-E1 | 块 E BANK_DEPOSIT_FIELDS 13→14（raw_json 字段集变化、ADM 行连带、存量数据缺字段） | 🔴 | 加载期断言 + missing-payment-detail 重导引导 + `/check-vars` + 更新既有断言单测 |
| R-E2 | 块 E 单 sheet .xlsx 交割表误入流式路径丢行号 | 🔴 | `repoKey!=='fx-settlement'` 显式守卫 + 手测专项 |
| R-E3 | 块 E 修复行生成属资金对账输出 | 🔴 | D1-D11 全从严（失败不产出）+ 全量 warning 审计 + 人工核对样本 |
| R-E4 | 块 E 中台重导后 BOC 调拨单号 stale（U4 不触发） | 🟡 | CHANGELOG/USER_GUIDE 注明「中台更新后请重导交割表」 |
| R-F1 | 块 F 写错资金对账ID（周数口径/FTA 解析/就近 tie-break 任一错 → 整批写错 ReconciliationId） | 🔴 | 基准断言矩阵（四元组）+ 字段常量锁死 + 人工核对样本 |
| R-F2 | 块 F config 整包覆盖丢 seed 字段 → 场景静默掉桶 | 🔴 | F2 双层守卫（main 最小校验 + 分桶不变单测） |
| R-F3 | 块 F stale 资金数据（mid-allocation 导入不清 processingResult） | 🔴 | F4 补清 + 验收项「先 run → 重导 → 导出被拒」 |
| R-F4 | 块 F FundType 拼写（取大写 T，资产表实证） | 🟡 | 上线前对真实导入数据抽样核对；不顺手改 ADM 小写 t 疑点（记 backlog） |

---

## 十二、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-11 | 初稿/定稿（基于 `changes/v3.0.4/spec.md` 六块编排入口 + 块 D/E/F 三子 spec；所有 ✅ 拍板结论原样转述） |

---

## 十三、实施记录

> 由 PR merged + 归档后追加，PM 不需要手动填写。

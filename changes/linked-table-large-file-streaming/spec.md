# Spec — 链接表导入复用流式引擎（支持 65 万行级大文件）

> 状态：**已确认（待实施）** ｜ 来源分支：`v2.1.16-beta.6` ｜ 目标版本：v3.0.0（块 B，PR-7+）
> 性质：🔴 **资金红线 + 数据红线**（链接表整表覆盖落库 / bank-deposit 派生 ADM）
> 缘起：用户导入 `渠道账单_2026-06-08_319151.xlsx`（147MB / 65.7 万行）报"成功 0 失败 1：文件为空或不可读"。
> 决策：用户 2026-06-08 已就 O-1 ~ O-6 **按推荐采纳**（见 §五 OPEN 表），spec 定稿可进入实施；前置 spec①（列名迁移）方案已定，详见 `changes/linked-mid-allocation-date-column-migration/spec.md`。
> ✅ 实施硬前提已清：O-2 值口径验证 **2026-06-09 在真实文件全量通过**（657,757 行逐列类型同质 + 生产引擎 readXlsxStreamed 全读；详见 §四 R-1 实测结论 / §附）。可进入主体实施。

---

## 一、问题与根因（已查实 + 实测）

**现象**：链接表导入报"文件为空或不可读"，但文件不空。

**根因**：
- 文件实为 **657,758 行 × 44 列（A1:AR657758）**，sheet1.xml 解压后 **≈ 1.72 GB**。
- 链接表导入 `linked-table:import`（`main.js:11151`）的读取链路全用 SheetJS `XLSX.readFile`**全量读进内存**（`readers.js:111` dense / `:367` listSheetNames）。
- 1.72GB sheet / 2900 万单元格 → 撞 V8 字符串长度上限/堆上限抛异常。
- `detectTableType` 把异常 catch 后统一返回 `status:'read-error'`（`table-type-detector.js:208/221/244`）→ handler 硬编码报"文件为空或不可读"（`main.js:11184`）→ **误报**。

**实测对比**（用项目现成流式引擎读同一文件）：

| 指标 | SheetJS 全量读（现状） | `readXlsxStreamed`（流式） |
|------|----------------------|---------------------------|
| 结果 | ❌ 读不出 | ✅ 657,758 行 |
| 耗时 | — | 12.4 s |
| 峰值 RSS | 撞上限 | 385 MB |
| 结束堆 | — | 19 MB（恒定） |

> 旁证：`vcc-op-calc-import/reader.js` 注释记录同类问题——78.7 万行 / 811MB worksheet，流式 7.8s / 778MB。本方案是已验证范式的复用。

---

## 二、现成可复用资产

| 资产 | 位置 | 能力 |
|------|------|------|
| **通用流式读** | `src/backend/pending-import/streaming-xlsx-reader.js` → `readXlsxStreamed(filePath, onRow, {colCount})` | JSZip + nodeStream + StringDecoder 增量解码，逐行回调 `onRow(rowArray, rowIdx)`，内存恒定。导出 `parseRowXml/parseCellBody/readSharedStrings/lettersToIndex` 原语 |
| **使用范式** | `src/backend/vcc-op-calc-import/reader.js` → `streamFlowFile` | 列 sheet + 逐 sheet 找表头匹配 + onDataRow 流式落库 + onProgress |
| **落库骨架** | `linked-table-repository.js:187` `replaceLinkedTable` | **已是「事务内 DELETE 全表 + 逐行 prepared INSERT + 边插边算日期范围 + upsert meta」** —— 天然流式友好，只是现在喂的是全量数组 |

**瓶颈精确定位**：
- ❌ 瓶颈在「**读**」：`readLinkedRowsAsObjects`（`main.js:11218`）全量读 → 数组。
- ✅ 「**写**」侧 `replaceLinkedTable` 逐行 INSERT，几乎不用改算法，只需把数据来源从「数组」换成「流式回调」。

---

## 三、改造方案（两个改造点）

### 改造点 1 — detector 表头识别（第一道坎）

**问题**：65 万行在 detector 阶段（`detectInSheet → readSheetMeaningfulRows → readRowsWithMetadata` 全量读）就 OOM，根本走不到落库。

**改造**：表头识别只需前几行。两条路线（见 O-1）：
- (a) **统一流式**：detector 用 `readXlsxStreamed` 读前 N 行（读到表头/前 ~20 行即 `throw` 终止流），做 L1 表头匹配 + L2 列宽守卫 + ambiguous 判定。
- (b) **阈值分支**：文件 > 阈值走流式头部识别，否则维持 SheetJS（双路径）。

**注意**：`readXlsxStreamed` 硬编码只读 `sheet1.xml`；detector 现扫所有 sheet。需确认链接表是否保证单 sheet，或给流式引擎补多 sheet 支持（vcc 的 `streamFlowFile` 已有多 sheet 遍历可参考）。

### 改造点 2 — 落库链路（main.js:11214-11224 + repository）

**现状**：`readLinkedRowsAsObjects(全量)` → 裁列 → `replaceLinkedTable(rows数组)`。

**改造**：新增「流式 replace」路径——
```
事务开始
  DELETE FROM <table>                       // 复用 replaceLinkedTable 事务骨架
  readXlsxStreamed(filePath, onRow, {colCount: signature列数}):
    idx===1（表头行）→ 校验 44 列表头匹配 signature（替代现 expectedHeaders zip 校验）
    idx>=2（数据行）  → 列索引→字段名对象 → 裁列(bank-deposit: pickBankDepositFields) → INSERT.run(...)
                      → 边插边算 dataDateMin/Max
事务提交
  upsert linked_table_meta
```
`linked-table-repository.js` 需新增一个接受「行迭代/回调」的 `replaceLinkedTableStreaming`（或重构 `replaceLinkedTable` 抽出事务骨架），因现版只吃完整数组。

---

## 四、🔴 关键风险（实施前必须正视）

| # | 风险 | 说明 | 缓解 |
|---|------|------|------|
| R-1 | **值口径一致性**（最高） | 流式 `parseCellBody` 解析的单元格值必须与 SheetJS 现状逐格一致。⚠️ 原担心"日期序列号 / numFmt 格式化数字 / 长 ID 精度"分叉——**实测均不成立**（见下方实测结论） | ✅ **已验证（2026-06-09）**：harness 全量比对，真实文件 657,757 行逐列同质、值口径一致 |
| R-2 | **整表覆盖原子性**（数据红线） | `replaceLinkedTable` 先 DELETE 全表；流式落库中途失败 → 表已清空只插一半 = 数据损坏 | 全程单事务，失败整体回滚；确认 65 万行单事务的 WAL/内存/锁可行性（见 O-4） |
| R-3 | **bank-deposit 派生 ADM 次生 OOM** | 落库后 `readLinkedTableRows('bank-deposit')`（`main.js:11242`）从 DB **全量读回 65 万行** + `buildAdmRows` 全内存计算 → 又一处 OOM | 评估 buildAdmRows 流式化/分批，或另案（见 O-3） |
| R-4 | reconIdFixResult 清空 / JPM 失效 | bank-deposit 重导触发 `reconIdFixResult=null`（`main.js:11248`）—— 行为不变，但大文件下要确保派生链路整体不崩 | 回归验证 |

> **R-1 实测结论（2026-06-09，推翻原假设）**：
> - 原 R-1 担心 SheetJS `raw:false` 会按 numFmt 格式化（如 `"1,234.50"`）而流式不会 → 分叉。**实测发现现状读取链路 `readers.js` 用了 `raw:false` 但未开 `cellStyles`** → SheetJS 根本不解析 numFmt、返回原始数值 `.v`，过 `normalizeCell=String(v).trim()` 后与流式 `String(parseFloat(<v>))` 殊途同归。**numFmt 对两条链路都惰性，格式化分叉不会发生。**
> - **真正的值口径分叉点是特殊 cell 类型**：`t="str"`（公式缓存，流式 `<v xml:space>` 可能读不出）/ `b` 布尔 / `e` 错误 / `d` ISO 日期 —— 流式 `parseCellBody` 对这些处理不同。
> - 真实文件 `渠道账单_2026-06-08_319151.xlsx` 全量 deep scan：657,757 行**每列 cell 类型 100% 同质**（全 `inlineStr` 文本或 `n` 数字）、`cellXfs` 整表只有 `0:General`、**单 sheet**、每行恰 **44 列**、长 ID（19 位）以 `inlineStr` 文本存（**零精度丢失**）→ **无任何分叉点，O-2 通过**。
> - 兜底：harness 固化 `--deep` 模式，未来任何链接表落流式前应复跑确认无危险 cell 类型（见 §附）。

---

## 五、影响面 / 测试 / 待确认

### 影响文件（预估）
- `src/main-process/table-type-detector.js`（表头识别）
- `src/main.js`（`linked-table:import` 落库链路）
- `src/backend/database/linked-table-repository.js`（流式 replace 接口）
- `src/backend/file-service/readers.js`（可能加流式变体）
- 可能小改 `src/backend/pending-import/streaming-xlsx-reader.js`（多 sheet / 提前终止）

### 重要变量
- 命中：链接表导入、`replaceLinkedTable`（数据红线整表覆盖）、ADM 派生、`reconIdFixResult`。
- **实施前必须跑 `/check-vars`**（CLAUDE.md 硬节点）。

### 测试
- 单测：值口径双跑 diff（R-1）；流式落库行数守恒；表头不匹配/空文件/多 sheet 边界。
- 集成：真实大文件（用户样本）端到端导入 → 落库行数 = 657,757（去表头）→ ADM 派生。
- 手测：🔴 资金红线，记入 manual-test-checklist。

### OPEN 定稿（用户 2026-06-08 **按推荐采纳**）
| 编号 | 问题 | **定稿（按推荐采纳）** |
|------|------|------------------------|
| O-1 | 统一流式 vs 大文件阈值分支 | **统一流式**（值口径验证通过后），免双路径维护。 |
| O-2 | 值口径一致性验证策略 | ✅ **已验证（2026-06-09，闸门已清）**：harness（probe / diff / `--deep`）真实文件全量比对通过。因 SheetJS 读不动大文件无法"中等文件双跑"，改用四层证据：styles 证明全 General + 全量类型同质 + 生产引擎全读 + safe-fixture diff=0。 |
| O-3 | ADM 派生的 65 万行内存（R-3） | **ADM 派生内存评估**，覆盖 **bank-deposit + mid-allocation 双触发**（PR#65 后 `main.js:11244-11259` 改为两源任一变更都全量重建 ADM）。单列评估、可能拆另案。 |
| O-4 | 65 万行单事务 INSERT vs 分批（与整表覆盖原子性冲突） | **单事务** + **确认 SQLite 承受力**（WAL/内存/锁）。 |
| O-5 | detector 多 sheet vs 流式引擎单 sheet | **确认链接表单 sheet 约定**；若非单 sheet 则**补多 sheet 支持**（`readXlsxStreamed` 现硬编码只读 sheet1.xml）。旁证：真实样本 deep scan 确认**单 sheet**（仅 sheet1.xml），但仍需确认是否所有链接表导出都保证单 sheet。 |
| O-6 | 顺带修误导报错文案（read-error 细分） | **顺带修「文件为空」误报文案**（区分"真空文件"与"OOM/读失败"）。 |

---

## 六、待办（实施前置）

1. [x] 用户定 O-1 ~ O-6（2026-06-08 **按推荐采纳**，见 §五 OPEN 定稿）
2. [x] 确认目标版本号：v3.0.0（块 B，PR-7+）；前置 spec① 列名迁移方案已定
3. [x] R-1/O-2 值口径验证（2026-06-09 真实文件全量通过；harness：`scripts/test-v3.0.0-linked-streaming-parity.js --deep`）
4. [ ] 拆 PR（前置 spec① 列名迁移 → detector → 落库/repository → ADM，至少分 3-4 PR）
5. [ ] 实施 → 单测 → `/check-vars` → 大文件手测 → PR

---

## 附：验证 harness（永久，O-2 闸门，可复跑）
- `scripts/test-v3.0.0-linked-streaming-parity.js` — probe（前 40 行）/ diff（SheetJS↔流式逐格）/ `--deep`（全量流式类型同质性扫描）三模式 + 无参自验证。
- `scripts/test-v3.0.0-make-linked-fixture.js` — 生成 safe/risky 自测 fixture（证明 harness 该报能报、该过能过）。
- 真实文件实测（2026-06-09，`渠道账单_2026-06-08_319151.xlsx`）：`--deep` 全量 657,757 数据行 / ~12s / O(列)内存 / exit 0；生产引擎 `readXlsxStreamed` 全读 657,758 行（含表头）/ ~14s / 2GB 堆够用 / 每行恰 44 列 / 长 ID 文本零丢失。表头 `账户主体,账户BU,BizId,BillDate,ValueDate,Channel,地区,MerchantId,Currency,Credit Amount,Debit Amount,ReconciliationId...`。

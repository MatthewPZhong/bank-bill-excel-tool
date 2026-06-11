# TechDoc - 网银账单小助手 v3.0.4（六块迭代：JSZip 止血 / 引擎第二波迁移 / 银行对账输出修复 / BOC 调拨订单修复 / Payment 线下调拨回填）

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.4 |
| 日期 | 2026-06-11 |
| 作者 | Dev |
| 状态 | 定稿 |
| 关联 PRD | `docs/iterations/v3.0.4/PRD.md` |
| 依赖 | `main` 分支（PR #70 已合并）→ 开发分支 `v3.0.4`（已切出）；PR-C/PR-D 依赖 PR-B；块 F 依赖块 D 终态 |

> **来源 spec（唯一事实源）**：
> 1. `changes/v3.0.4/spec.md`（六块编排入口 + §三引擎扩展包 E1-E5 + §四 pending + §五 biz-op + §七风险 + §八 OPEN 拍板）
> 2. `changes/bank-recon-output-fixes/spec.md`（块 D）
> 3. `changes/boc-dispatch-order-fix/spec.md`（块 E）
> 4. `changes/payment-offline-allocation-backfill/spec.md`（块 F）
>
> 本 TechDoc 以上述 spec 为实现侧事实源；所有 SQL/DDL/算法/决策表与 spec 逐字对齐，不自行发明语义。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 块 A 预检 | yauzl 已是依赖、正解 zip64 与中央目录无符号尺寸；3 落点各自加调用、fail-open，技术可行无新依赖 |
| §5.2/5.3 块 B/C 引擎迁移 | 复用 big-table-import 引擎 W4 拓扑 + PR-H contract-flow 契约范式；E1-E5 全部契约可选，对收单零影响，可行 |
| §5.4 块 D 三修复 | 5 文件全小改（F1 1 行 + F2 2 文件 3 处 + F3 3 文件）；enrich 落 io 层可单测；可行 |
| §5.5 块 E BOC | ADM 隐藏表 + JPM 引擎双范式镜像；builder 纯函数可单测；数据层先行可行 |
| §5.6 块 F payment | R5s2 config 子开关 + 新引擎文件 + 编排器 R5s2b；零 migration/零新表/零新 IPC；可行 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | pending 6 表覆盖删除顺序敏感（资金红线） | E1 函数式 deleteForOverwrite 逐字平移 6 条 SQL+顺序；见 §六、§十一 |
| R-2 | pending 去重/整批拒绝语义漂移 | E5 写侧 Set + 按文件序单写确定性；见 §五 E5、§六 |
| R-3 | upsertMonthMeta 脱出事务 | E2 finalizeForCommit 在 COMMIT 前事务内执行；见 §五 E2 |
| R-4 | 引擎扩展回归收单 | 契约不声明=零变化铁律 + 收单 34 断言回归锁；见 §五 |
| R-5 | worker_threads 堆 4096MB | dispatch resourceLimits 显式设置；见 §六、§十一 |
| R-6 | pending 多 sheet 报错（行为收紧） | intentional divergence，见 §1.3 + CHANGELOG |
| R-7 | biz-op flow rawRow/1000 上限 | E4 captureRowValues + maxCollectedErrors；见 §五 E4、§七 |
| R-8 | A1 预检误伤 | 仅 ≥2^31 拦截 + fail-open；见 §四 |
| R-9 | pending 小文件同步兜底移除 | 引擎统一路径，smoke 全走引擎验证；见 §六 |
| R-E1 | BANK_DEPOSIT_FIELDS 13→14 | 加载期断言 + 既有断言单测更新；见 §九 |
| R-E2 | 单 sheet .xlsx 交割表流式丢行号 | `repoKey!=='fx-settlement'` 守卫；见 §九 main.js 钩子 |
| R-F2 | config 整包覆盖丢 seed 字段 | F2 双层守卫；见 §十 |
| R-F3 | mid-allocation 导入不清 processingResult | F4 补清；见 §十 |

### 1.3 与 PRD 的差异

- 块 B 行为收紧 R-6：旧 pending 硬编码 `sheet1.xml`（多 sheet 静默读第一个），引擎 rels 正解多 sheet 时 **报错**——属 **intentional divergence**（方向正确，防静默读错表），CHANGELOG 注明。除此外，与 PRD 无技术实现差异。

---

## 二、涉及的文件清单

> 按块分组。块 A/B/C 来自入口 spec §二~§五；块 D/E/F 来自各子 spec §6 影响范围。

### 块 A（PR-A）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/pending-import/streaming-xlsx-reader.js`（或同目录新小模块） | 修改/新增 | A1 yauzl 中央目录尺寸预检函数 + `readXlsxStreamed` 入口调用 |
| `src/backend/vcc-op-calc-import/reader.js` | 修改 | A1 第 2 落点调用 |
| `src/backend/biz-op-recon-import/reader-streamed.js` | 修改 | A1 第 3 落点调用 |
| `src/main.js` | 修改 | A2 #1 `linked-table:import` handler 循环后写 activity log |
| `src/renderer-dialogs.js` | 修改 | A2 #2 保留 skipLogReport + 注释 |
| `src/renderer.js` | 修改 | A2 #3 两入口消费返回值弹 alert |

### 引擎扩展包（PR-B）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main-process/big-table-import/`（引擎目录，具体文件实施时定） | 修改 | E1-E5 契约可选扩展（deleteForOverwrite/finalizeForCommit/rejectEmptyFiles/maxCollectedErrors+captureRowValues/dedupeKeyOf） |
| 引擎单测 | 新增 | E1-E5 各扩展声明/不声明两态 |

### 块 B · pending（PR-C）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/pending-import/contract-pending.js` | 新增 | pending 契约模块（PR-H contract-flow 范式） |
| `src/main-process/big-table-import-dispatch.js` | 新增 | 共享 dispatch（平移收单 dispatchEngineImport + resourceLimits） |
| `src/main-process/pending-session.js` | 修改 | 改调共享 dispatch + 移除小样本主进程同步兜底 + 引擎错误还原 lastImportErrors |
| `src/main.js` | 修改 | pending session 接线 |
| `scripts/integration/pending-engine-migration.js` | 新增 | parity 集成脚本 |
| `worker.js` / `month-repository.js` / 旧 reader | 保留 | 回退开关 false 时全旧链路，一字不改 |

### 块 C · biz-op flow（PR-D）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/biz-op-recon-import/contract-flow.js` | 新增 | flow 契约模块（FLOW_HEADERS 28 列） |
| biz-op session（接线点） | 修改 | 走共享 dispatch + 回退开关 |
| `scripts/integration/bizop-flow-engine-migration.js` | 新增 | parity 集成脚本 |
| 旧 import-worker | 保留 | bizOp 侧继续走旧 worker 不动 |

### 块 D · recon-fixes

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main-process/scenario-engines/c3-gateway-recon-join.js` | 修改 | F1 `:216` `-fee` + `:210-213` 注释重写 |
| `src/main-process/scenario-hit-rows-writer.js` | 修改 | F2 `DEFAULT_REPORT_SUBDIR` 'error-reports'→'bank-statement-process' |
| `src/main-process/exceljs-writer.js` | 修改 | F3 `:179` 表头'对账ID' + `:189` 三级回退链 |
| `src/main-process/bank-statement-io.js` | 修改 | F3 `writeErrorReportOutput` 加可选 bankRows + enrich Map |
| `src/main.js` | 修改 | F2 新增 errorReportRootDir + `:3695` 实参；F3 `:3693-3696` 加 bankRows 入参 |
| 单测/smoke（见 §十四） | 新增/修改 | exceljs-writer-error-report.test.js 等 |

### 块 E · BOC

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/constants/boc-fx-link-fields.js` | 新增 | 跨表 FIELD_MAP + 加载期断言（单一真相） |
| `src/constants/boc-dispatch-order-fields.js` | 新增 | 引擎字段 FIELD_MAP + 对齐断言 |
| `src/main-process/boc-fx-link-builder.js` | 新增 | 派生纯函数（scanFxGroups / matchBocToMidAllocation / buildBocBankRows / backfillBocReconLinkIds） |
| `src/main-process/scenario-engines/boc-dispatch-order-fix.js` | 新增 | BOC 修复引擎（8 步状态机，从严） |
| `migrations.js` | 修改 | 两表 DDL（ensureBocFxLinkSupport）+ BOC 种子 |
| `database.js` | 修改 | init 链 + repository wrapper |
| `linked-table-repository.js` | 修改 | 🔴 白名单 13→14 + 2 defs + 6 函数 |
| `src/main.js` | 修改 | import 钩子×2 + 数组路径守卫 + readLinkedRowsAsObjectsWithMeta + run 注入与日志 |
| `recon-id-fix-engine.js` | 修改 | 分流分支 boc-dispatch-order-fix |
| `src/renderer-dialogs.js` | 修改 | 弹框链（接 ADM 链之后） |
| `src/renderer.js` | 修改 | 运行反馈改造（warning 文案逐条显示） |
| 4 单测 + 1 集成 + 手测清单 | 新增 | 见 §十四 |

### 块 F · payment

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js` | 新增 | 匹配引擎（纯函数，R5s2 骨架） |
| `src/main-process/scenario-engines/engine-week-utils.js` | 新增 | parseFtaDate / weekTag（ISO 8601） / weekTagPlusOne |
| `src/constants/payment-offline-allocation-fields.js` | 新增 | 中台/银行列名锁 + 启动期断言 |
| `src/renderer-dialogs.js` | 修改 | F1 勾选行 + 条件展开行 + inline 校验 |
| `src/styles-gemini-extra.css` | 修改 | 展开区多行布局（564px 约束） |
| `src/main.js` | 修改 | run 注入 workingMidRows + 导入清 processingResult + config 最小校验 |
| `src/main-process/reconciliation-orchestrator.js` | 修改 | R5s2b 显式接线 + midAllocationContext |
| `src/main-process/error-causes.js` | 修改 | CAUSE_MAP 补新 code |
| `renderer-previews.js` / `package.json` | 修改 | preview 入口 `preview:builtin-fixed-channel-manage-payment` |
| 单测/集成/smoke（见 §十四） | 新增/修改 | week-utils 基准 + 引擎 + orchestrator 等 |

---

## 三、架构 / 模块改动地图（文字版）

```
Renderer（index.html + renderer.js + renderer-dialogs.js）
  ├─[A2 #3] renderer.js:3738/:3885 消费 linkedTable.import 返回值弹 alert
  ├─[A2 #2] renderer-dialogs.js:6399 保留 skipLogReport（注释）
  ├─[E F3] renderer.js runGatewayReconScenario warning 文案逐条显示
  ├─[E F2] renderer-dialogs.js BOC 弹框链（接 ADM 链之后）
  └─[F F1] renderer-dialogs.js createBuiltinFixedChannelManageDialog 勾选+展开行
        │  ipcRenderer.invoke()
        ▼
Preload（src/preload.js）— 本迭代无改动（块 D 列举的 preload 命中均非写入点）
        │
        ▼
Main Process（src/main.js）— 🔴 串行编辑窗口（NUL 二进制不可文本合并，见 §十三）
  ├─[A2 #1] linked-table:import handler 写 activity log
  ├─[B] pending session 接线（big-table-import-dispatch）
  ├─[D F2/F3] :3675 后新增 errorReportRootDir + :3693-3696 调用点（同 hunk 串行）
  ├─[E] import 钩子×2 + 数组路径守卫 + run 注入与日志
  └─[F] run 注入 workingMidRows + 导入清 processingResult + config 校验
        │
        ├── src/backend/database.js（AppDatabase facade）
        │   ├─[E] init 链 + BOC repo wrapper
        │   └── database/
        │       ├─[E] migrations.js（两表 DDL + BOC 种子）
        │       └─[E] linked-table-repository.js（白名单 13→14 + defs + 6 函数）
        ├── src/backend/file-service/ ……（readers/normalizers，块 E readLinkedRowsAsObjectsWithMeta）
        ├── src/backend/pending-import/
        │   ├─[A1] streaming-xlsx-reader.js 预检
        │   └─[B] contract-pending.js（新）
        ├── src/backend/biz-op-recon-import/
        │   ├─[A1] reader-streamed.js 预检
        │   └─[C] contract-flow.js（新）
        ├── src/backend/vcc-op-calc-import/reader.js [A1] 预检
        ├── src/main-process/big-table-import/（引擎，[PR-B] E1-E5 扩展）
        ├── src/main-process/big-table-import-dispatch.js（[B] 新，共享 dispatch）
        ├── src/main-process/scenario-engines/
        │   ├─[D F1] c3-gateway-recon-join.js
        │   ├─[E F3] boc-dispatch-order-fix.js（新）
        │   ├─[F F5] r5-payment-offline-allocation-backfill.js（新）
        │   ├─[F F3] engine-week-utils.js（新）
        │   └─[E] recon-id-fix-engine.js（分流）
        ├── src/main-process/boc-fx-link-builder.js（[E] 新）
        ├── src/main-process/reconciliation-orchestrator.js（[F] R5s2b 接线）
        ├── src/main-process/exceljs-writer.js [D F3] / scenario-hit-rows-writer.js [D F2] / bank-statement-io.js [D F3] / error-causes.js [F F6]
        └── src/constants/（[E] boc-fx-link-fields.js / boc-dispatch-order-fields.js；[F] payment-offline-allocation-fields.js）
```

---

## 四、块 A：JSZip 止血（A1 预检 + A2 报错可见性）

### 4.1 实现方案

- **A1**：用 yauzl 读中央目录无符号 entry 尺寸（中央目录恒有真值、正解 zip64 与 data descriptor），检查目标 sheet XML 与 `xl/sharedStrings.xml` 的 `uncompressedSize`；`≥ 2147483648` 抛 `FileValidationError`（中文文案要素必含，detailLines 带 entry 名与字节数）；预检自身失败 fail-open 放行原链路。
- **A2**：日志权威落盘改由 main 侧 #1 handler（避免双写）；弹窗 #2 保留 skipLogReport 仅加注释；两入口 #3 消费返回值弹明细。
- **为什么不用其他方案**：B9 方案 B（zip 层整体换 yauzl）成本高且与「pending/biz-op 直接迁引擎」组合重复；护栏方案最小、不动落库语义。

### 4.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `streaming-xlsx-reader.js`（或新小模块） | 入口 | A1 预检函数 + `readXlsxStreamed` 调用 |
| `vcc-op-calc-import/reader.js` | `:326` 注释处 | A1 调用 |
| `biz-op-recon-import/reader-streamed.js` | `:35` | A1 调用 |
| `main.js` | `:11273` | A2 #1 循环后 appendActivityLogEntry（error 级，N/M 计数 + per-file 明细） |
| `renderer-dialogs.js` | `:6399` | A2 #2 保留 skipLogReport + 注释 |
| `renderer.js` | `:3738`/`:3885` | A2 #3 消费返回值弹 alert |

### 4.3 注意事项

- 3 落点逐一核实是否独立持有 JSZip `loadAsync`，独立则各自加调用。
- ≥2^31 fixture：高重复内容生成（压缩后几十 MB）或脚本直改中央目录尺寸字段，取实施时成本低者。
- A2 #3 走默认 error 日志路径或依赖 #1，实施时统一（避免双写）。

---

## 五、引擎扩展包（PR-B，块 B/C 共同前置）

### 5.1 铁律

**所有扩展均为契约可选项——契约不声明 ⇒ 引擎行为与 v3.0.3 完全一致**。收单契约（contract-flow/bill）一字不改，`acquiring-engine-migration.js` 全链对比脚本（34 断言）必须全绿（回归锁）。

### 5.2 E1-E5 契约 hook（E6 已裁剪，OPEN-1 拍板 bizOp 不迁）

| 编号 | 扩展 | 契约声明 | 引擎行为 |
|------|------|---------|---------|
| E1 | 多语句覆盖删除 | `deleteForOverwrite(deleteKey) => Array<{sql, params}>`（函数式，替代单串 `deleteSqlForOverwrite`） | 大事务内按返回顺序逐条 prepare+run；与既有 string 互斥共存，优先函数式；`deletedCount` 取各语句 changes 之和 |
| E2 | 事务内收尾 | `finalizeForCommit({totalImported, sourceFiles}) => Array<{sql, params}>` | 引擎在 COMMIT 前执行；纯声明式不暴露 db 句柄；archivePath/importedAt 经 contractOptions 闭包注入 |
| E3 | 空文件整批拒绝 | `rejectEmptyFiles: true` + `formatEmptyFileError(sourceFile)` | writer 侧按 sourceFile 统计数据行数，0 行记批级错误（与行级错误同走整批 ROLLBACK） |
| E4 | 行级错误捕获增强 | `maxCollectedErrors`（覆盖默认 100）+ `captureRowValues: true` | cells 从 batch 行内已有数据取（whitelist=null 时 values 即全列），仅错误行复制 |
| E5 | 写侧跨文件去重 | `dedupeKeyOf({values}) => string` + `formatDuplicateError({key}) => message` | key 在解析 worker 算（并行摊销）随 batch 传递；Set 在 import-worker 写循环（按文件序单写 ⇒ 确定性与旧串行一致）；命中记行级错误不 INSERT |

### 5.3 PR-B 验收

引擎单测覆盖 E1-E5 各扩展（声明/不声明两态）；`npm run release-check` 全绿；收单全链对比脚本（34 断言）全绿 = 回归锁。

---

## 六、块 B：pending 迁移引擎（PR-C）🔴🔴

### 6.1 现状基线（已查实，file:line）

- 拓扑：`pending:import:start`（`main.js:10322`）→ pending-session **utilityProcess.fork**（8GB 堆，`pending-session.js:40-46`）→ `worker.js`（stdout JSON 行协议，exit 0/1/2）。
- 读取：`readXlsxStreamed`（JSZip，硬编码 `xl/worksheets/sheet1.xml`）；表头物理第 1 行 31 列严格校验；小样本走主进程同步兜底（`pending-session.js:37`）。
- 落库语义（全部逐字平移）：单大事务 BEGIN → deleteMonth（6 表顺序敏感，`month-repository.js:77-93`）→ 逐行 computeRowHash 跨文件去重 → 33 参 INSERT → 任一错误整批 ROLLBACK → upsertMonthMeta → COMMIT。
- 错误协议：`{severity:fatal|row, file, sheetRow, message, cells}`，row 级上限 1000 带 cells。

### 6.2 迁移设计

1. **契约模块** `contract-pending.js`（复制 SQL/逻辑不 require 仓储，parity 锁防漂移）：
   - `expectedHeaders` = PENDING_COLUMNS（31 列）；`valueColumnWhitelist: null`；`requiredColumns` = 全列索引。
   - `validateHeaders` 复用 `pending-import/validator`（纯函数）。
   - `mapRow` → 33 参 params（yearMonth 经 contractOptions 闭包 + rowHash 由 E5 路径产出；dedupeKeyOf 与 mapRow 共算一次 hash，避免双算）。
   - `insertSql` = `createRowInserter` 的 INSERT 逐字平移。
   - `monthKeyOf: () => null`（跨月校验旁路；引擎 `monthKey` 参数不传）。
   - `deleteForOverwrite`（E1）= deleteMonth 6 条 SQL+参数逐字平移（闭包 yearMonth）。
   - `finalizeForCommit`（E2）= upsertMonthMeta SQL（rowCount=totalImported、sourceFiles、archivePath、importedAt 闭包注入）。
   - `rejectEmptyFiles: true`（E3）+ `maxCollectedErrors: 1000` + `captureRowValues: true`（E4）+ `dedupeKeyOf/formatDuplicateError`（E5，sha 算法与 `computeRowHash` 同源）。
2. **dispatch**：新建 `big-table-import-dispatch.js`（平移收单 dispatchEngineImport：engine-worker-entry + jobId + progress/log/done/error 协议 + serialize-error 还原），增加 `resourceLimits` 选项。pending-session 改调它；**移除小样本主进程同步兜底分支**（引擎统一处理大小文件）。
3. **回退开关** `USE_BIG_TABLE_IMPORT_ENGINE_PENDING`，默认 true；false = 原 utilityProcess + worker.js 全旧链路。测试经 env `PENDING_FORCE_LEGACY_IMPORT=1` 强制旧路径对照。
4. **session 适配**：引擎错误对象 → 还原 `lastImportErrors`（severity/file/sheetRow/message/cells），`pending:error:export-report` 与 UI 弹窗零改动；进度事件由引擎 `{sourceFile, importedCount}`（每 1w 行）适配为现行 renderer payload。

### 6.3 验收

- parity 脚本 `scripts/integration/pending-engine-migration.js`：同 fixture 双跑（legacy env vs 引擎），断言 `pending_rows`/`pending_months` 全表 dump byte-for-byte + 错误路径逐字段一致。fixture 必含：多文件、跨文件重复行、表头错、空文件、小文件、错误超 1000 条截断。
- release-check 全绿；手测大文件导入 UI 流畅、取消、覆盖重导联动清理。

---

## 七、块 C：biz-op flow 迁移引擎（PR-D）🔴

### 7.1 范围裁定（✅ OPEN-1）

- **flow 侧（迁）**：多文件 multiSelections、单日量级大、clear 语义简单（2 条 SQL、参数=入参 date、与行内容无关）→ E1 即可表达；多文件并行收益真实。
- **bizOp（业务OP）侧（不迁）**：单文件、清理参数 firstBu 由第一个数据行内容决定、逐行 BU 一致校验 + bu_name 改写 + firstBuEmpty 特例——与引擎「参数先于解析」覆盖模型冲突，需 E6 才能 byte 平移，量级无痛点扩展成本不成比例。

### 7.2 迁移设计（flow）

1. 契约 `contract-flow.js`：`expectedHeaders` = FLOW_HEADERS（28 列）；whitelist 实施时评估（保守先 null + useWhitelist 对照）；`validateHeaders/validateFlowRow` 复用 validator 纯函数（mapRow 三态表达行级校验错误）；`monthKeyOf: () => null`；`deleteForOverwrite` = 2 条 clear SQL 平移（闭包 date）；`maxCollectedErrors: 1000` + `captureRowValues: true`（错误报告 `writeFlowErrorReportXlsx` 需 rawRow）；多文件「清一次后续累加」= 引擎 overwrite 天然。
2. dispatch 走 §六共享模块 + 回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW`（旧 import-worker 全保留；bizOp 侧继续走旧 worker 不动）。
3. 行内 date 与入参 date 一致性校验（若存在）实施时核实并平移进 mapRow（标注：调研未见、待核）。

### 7.3 验收

- parity 脚本 `scripts/integration/bizop-flow-engine-migration.js`：legacy vs 引擎双跑，流水表 dump + 错误报告 xlsx 内容 + rejected 路径文案逐字段一致；fixture 含多文件合并、行级校验错、整批拒绝。
- release-check 全绿；bizOp 侧旧链路回归不动。

---

## 八、块 D：recon-fixes 三修复

### 8.1 实现方案

- **F1**（资金红线）：写盘点取相反数 + 注释重写（匹配语义不变）。
- **F2**：错误报告另引新根 `error-reports`，命中场景行常量改值 `bank-statement-process`（**严禁动 `main.js:3675` 本体**，R5 兜底依赖）。
- **F3**：第 3 列表头换名 + 三级回退链；enrich 放 io 层（可单测）。

### 8.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `c3-gateway-recon-join.js` | `:216` | `normalizeCellValue(fee)` → `normalizeCellValue(-fee)` |
| `c3-gateway-recon-join.js` | `:210-213` | 注释块重写（匹配语义不变/写盘=输入框相反数/-0 边界/负输入对称） |
| `scenario-hit-rows-writer.js` | `:43` | `DEFAULT_REPORT_SUBDIR` 'error-reports'→'bank-statement-process'（头注释 `:5/:10/:128` 同步） |
| `main.js` | `:3675` 之后 | 新增 `errorReportRootDir = path.join(ensureStorageRoot(), 'error-reports')`（不动 `:3675` 本体） |
| `main.js` | `:3695` | 错误报告实参改 `exportRootDir: errorReportRootDir` |
| `exceljs-writer.js` | `:179` | 表头 '行号'→'对账ID' |
| `exceljs-writer.js` | `:189` | 三级回退链：reconciliationId（String+trim 非空）→ w.reconId → w.rowId → '' |
| `bank-statement-io.js` | `:246` | `writeErrorReportOutput` 加可选 bankRows + enrich Map(_rowId→ReconciliationId) |
| `main.js` | `:3693-3696` | 调用点加 `bankRows: [...modifiedRows, ...unmatchedRows]`（unmatchedRows 必含） |

### 8.3 注意事项

- **同 hunk 串行**：F2 与 F3 都改 `main.js:3693-3696` 同一调用表达式 → commit 顺序 **F1 → F3 → F2 → docs**（F2 插常量行使后续行号 +1，后做方以先做方落地后实际行号为准）。
- F3 enrich：ReconciliationId 可能是 number 类型，判空须 `String(v).trim()`；Map 必须含 unmatchedRows（R5s4 warning 行在 unmatchedRows）。
- 三条对外契约变更 CHANGELOG 合并成一段适配提示，不写三条孤立条目。
- main.js NUL 字节仅 `:3401/:3406` 两处，与本块编辑行不重叠，Edit 可直接用；review 须 `git diff --text` / `grep -a`。

---

## 九、块 E：BOC 调拨订单修复

### 9.1 两张隐藏表 DDL（`migrations.js` 新增 `ensureBocFxLinkSupport(db)`，幂等，仿 ADM）

```sql
CREATE TABLE IF NOT EXISTS linked_boc_fx_settlement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_no TEXT,   -- 「交易编号」归一化纯数字串（2.5 匹配热列）
  group_no TEXT,         -- 「分组」（'1','2'…；2.2 剔除后 ''）
  allocation_no TEXT,    -- 「调拨单号」（2.3 回填，可空）
  recon_link_id TEXT,    -- 「资金对账不平表链接ID」（2.5 回填，可空）
  maturity_date TEXT,    -- 「到期日」归一 YYYY-MM-DD（匹配热列）
  source_row INTEGER,    -- 原文件物理行号（诊断）
  raw_json TEXT NOT NULL, imported_at TEXT NOT NULL
);  -- + idx(transaction_no), idx(group_no)
CREATE TABLE IF NOT EXISTS linked_boc_bank_deposit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_txn_no TEXT,      -- 「银行单交易编号」
  reconciliation_id TEXT, bill_date TEXT,
  raw_json TEXT NOT NULL, imported_at TEXT NOT NULL
);  -- + idx(bank_txn_no)
```

两表均**不进 `ALL_TABLE_KEYS`、不写 `linked_table_meta`**（隐藏红线，单测断言）。纯新增无破坏性 DDL。

### 9.2 常量（新建 `src/constants/boc-fx-link-fields.js`，单一真相，仿 adm-bank-deposit-fields.js）

`BOC_CHANNEL_VALUE='BOC'`；`BOC_BANK_FILTER={地区:'CN', Currency:'USD', creditAmountCents:0}`；`BOC_PAYMENT_DETAIL_KEYWORD='无折存款借记交易'`；`BOC_LINK_EXTRA_FIELDS=['分组','调拨单号','资金对账不平表链接ID']`；`BOC_BANK_EXTRA_FIELD='银行单交易编号'`；`BOC_LINK_HEADERS=[...FX_DELIVERY_SIGNATURE.expectedHeaders, ...新3字段]`；跨表 FIELD_MAP + **模块加载期断言**（交割表表头含 交易编号/货币2金额/到期日；`BANK_DEPOSIT_FIELDS` 含 'Payment Detail'——防白名单回退漂移）。

### 9.3 builder（新建 `src/main-process/boc-fx-link-builder.js`，纯函数：不读 DB/不碰 FS/不依赖 Electron；logs 返回 caller 统一写）

- **工具**：`normalizeTransactionNo`（纯数字原样；`123.0`→`123`；空/含非数字/科学计数→''）、`toCents`（parseNumber 去千分位×100 四舍五入；非数值 null）、`toIsoDate`（复用 `normalizeDateExportValue` 取日期部分）、`extractLongestDigitRun`（最长连续数字串，并列取最先 + log）。
- **Step1 `scanFxGroups({objects, rowNumbers})`**（2.1）：物理行序遍历；交易编号归一为空（合计/页脚）→ 关组、行不入表；rowNumbers 断档（全空行）→ 关组；连续纯数字段成组，组号 1,2,3… 仅非空段递增。产出 = 原 33 命名字段 + 分组/调拨单号=''/链接ID='' + 内部辅助键（__txnNo/__maturityIso/__sourceRow，落库前剥到热列）。
- **Step2.2+2.3 `matchBocToMidAllocation(bocRows, midRows)`**（一对一消耗，多解记 warning 不抛错）：候选=中台「付款渠道」='BOC' 行（预解析交易时间取日、收款金额取分，失败剔候选+warning）。**2.2**：按中台行序找「分组非空 ∧ 到期日=候选日期 ∧ 货币2金额(分)=收款金额(分)」BOC 行；多命中行序优先取首+log；命中行分组清空、该中台行消耗（不进 2.3）。**2.3**：剩余组按分组汇总货币2金额（组内任一行金额非数值→整组放弃+warning；组内到期日不一致→warning+取首行）；与未消耗候选（同日期对齐）匹配；命中→调拨单号回填组内所有行、一组配一单（消耗）；多候选行序优先+log；无命中组留空。
- **Step2.4 `buildBocBankRows(candidates)`**：availability 三态——0 行=`no-boc-rows`；有行但全无 Payment Detail 自有键（旧 13 字段时代）=`missing-payment-detail`；否则 `ok` 并过滤 `地区='CN' ∧ Currency='USD' ∧ Credit Amount 转分=0`，Payment Detail 含关键词→提取最长数字串赋「银行单交易编号」（含关键词但无数字→''+warning）。
- **Step2.5 `backfillBocReconLinkIds(rowsWithIds, bankRows)`**：bank_txn_no 索引（重复键留 id 最小行+warning）；逐行以归一化交易编号查表，命中→链接ID=该行 ReconciliationId，未命中→''；**幂等全量重算**；`unlinkedCount>0` → caller 写 warning 级 activity log（含行号/交易编号明细，前端不显示）。

### 9.4 repository（`linked-table-repository.js` + `database.js` wrapper）

- 🔴 **`BANK_DEPOSIT_FIELDS` 13→14：插入 'Payment Detail'**。影响：bank-deposit raw_json 字段集扩大；ADM 派生行 `{...r}` 浅拷贝连带多带该字段（JPM 引擎全程 FIELD_MAP pick，核验无副作用）；**更新既有 13 字段断言单测**。
- 新增 defs：`'boc-fx-settlement'`（keyColumn=transaction_no, dateColumn=maturity_date）、`'boc-bank-deposit'`（keyColumn=bank_txn_no, dateColumn=bill_date），注释「绝不进 ALL_TABLE_KEYS」。
- 新增 6 函数（仿 ADM）：`readBankDepositBocCandidates`（json_extract 下推 Channel='BOC' 超集）、`replaceBocFxLink`（整表覆盖，8 列 INSERT）、`readBocFxLinkRows`（ORDER BY id ASC，供引擎）、`readBocFxLinkRowsWithIds`、`writeBocFxLinkReconIds`（事务内按 id UPDATE raw_json+recon_link_id）、`replaceBocBankDeposit`、`readBocBankDepositRows`。

### 9.5 main.js 导入钩子（`linked-table:import` handler，4 处）

1. **交割表强制数组路径**：`useStreamingPath = detected.streamingEligible && repoKey !== 'fx-settlement'`（🔴 守卫注释：BOC 分组依赖物理行号断档，流式 feed 过滤空行且不透传 rowIdx；交割表行数小无 OOM）。
2. `readLinkedRowsAsObjects` 拆出 `readLinkedRowsAsObjectsWithMeta → {objects, rowNumbers}`（既有调用方零行为变化）。
3. **fx-settlement 派生块**（okResult 构造后，独立 try/catch）：scanFxGroups → matchBocToMidAllocation（中台经 `readLinkedTableRows('mid-allocation')`；无数据则 2.2/2.3 跳过+info log）→ replaceBocFxLink → readBankDepositBocCandidates → buildBocBankRows → replaceBocBankDeposit（无数据也重建空表防 stale）→ readBocFxLinkRowsWithIds → backfillBocReconLinkIds → writeBocFxLinkReconIds → 汇总 logs 写 appendActivityLogEntry → `okResult.bocDerive = {created, total, groupCount, step22Removed, step23MatchedGroups, step23UnmatchedGroups, backfilled, unlinkedCount, needBankImport: availability!=='ok', bankMissingReason}`；异常 → `bocDerive={created:false, error}`。
4. **bank-deposit 派生块**（现有 ADM 块之后，独立 try/catch）：重派生 BOC调拨银行对账单表；若 `linked_boc_fx_settlement` 有行 → 补做 2.5 全量回填 → `okResult.bocBankDerive = {created, bankRowCount, backfilled, unlinkedCount}`。

### 9.6 前端弹框链（`renderer-dialogs.js`，仿 findAdmDerive 接 ADM 链之后）

见 PRD §5.5.1 弹框链表（✅ O1 静默 / ✅ O2 报错落弹框+log）。

### 9.7 引擎（新建 `boc-dispatch-order-fix.js`）

`runBocDispatchOrderFix({sheets, bocLinkRows, scenario}) → {fixedRows, warnings, stats}`——纯函数：不读 DB/不写日志/不依赖 Electron；**入参只读**（sheets 三数组与 bocLinkRows 不被修改，单测快照断言）；链接表只读不回写。复用 engine-utils + buildOutputRow（c4）。

8 步算法（渠道账单驱动）：

```
1. bocChannels = 渠道账单中 trim(channelName)===config.channelName||'BOC' 的行
   0 行 → warn boc-channel-not-found 早返回；bocLinkRows 空 → warn boc-link-table-empty 早返回
2. 建索引：linkGroups（仅分组非空行按组聚合）；linkByReconId；channelByReconId
3. 按渠道行原序遍历：reconciliationId 空→计数跳过；未命中链接表→channelUnlinked++（不告警，D6）；
   命中多组→warn link-id-ambiguous 相关组全失败（D7）；命中组已处理→跳过
4. 组级校验（任一失败→整组失败：warn + 不产出 + 不消耗任何渠道行）：
   组内调拨单号一致且非空（group-allocation-inconsistent / group-allocation-missing）；
   调拨单号未被其他组用过（group-allocation-reused，D8 从严）
5. 组内逐行 1v1 试配：每行链接ID 非空（空→group-link-id-empty 整组失败）且能在渠道 BOC 行中找到
   未消耗未被本组占用的同 reconciliationId 行（找不到→group-partial-match 整组失败）
6. 网关账单 OrderId===调拨单号 须唯一命中（0/多→gw-orderid-not-found/gw-orderid-multi-match 整组失败，D4 从严）
7. 提交：网关命中行复制 N 份（N=组行数），buildOutputRow overrides 注入
   Type=2(number) / Reference=组内对应行链接ID / Amount=组内对应行「货币1金额」（原值透传，D10）；
   消耗渠道行与调拨单号
8. 返回 fixedRows / warnings（每条带 code + 中文 message 供前端直显）/ stats
```

stats：`channelTotal/channelBocTotal/channelEmptyReconId/channelUnlinked/linkRowTotal/linkGroupTotal/groupTouched/groupMatched/groupFailed/fixedRowCount`（`fixedRowCount` 键名必须保留，`renderer.js:4462` 消费）。

匹配语义决策表 D1-D11 见 PRD §5.5.1（资金红线从严）。

### 9.8 输出 14 列映射（ORDER_REPAIR_FIELDS_GATEWAY）

每组 N 份 = 同一网关命中行复制 N 份，仅 3 列经 overrides 行级注入：**Type**=2（源行只有超长列名 `'Type(0:...'`，短名取不到必须 override）、**Reference**=组内对应链接表行「资金对账不平表链接ID」、**Amount**=组内对应行「货币1金额」；其余 11 列（BillDate/Bank/MerchantId/OrderId/DataSource/OppBu/OriginBillSource/BillType/Currency/OriginBillBizId/ReconBillBizId）从网关源行同名复制。

### 9.9 分流 / 注入 / 日志 / 前端

- `recon-id-fix-engine.js`：JPM 分支后并列 `config.subCategory==='boc-dispatch-order-fix'` → `runBocDispatchOrderFix({sheets, bocLinkRows: opts.bocLinkRows||[], scenario})`。
- `main.js` run handler（`:4026-4051` 区段）：`isBocScenario` 判定 → `runOpts={bocLinkRows: database.readBocFxLinkRows()}`；run 后 warnings 非空 → `appendActivityLogEntry({level:'warning', domain:'boc-dispatch-order-fix', message:'[BOC调拨订单修复] 成功 X 组/失败 Y 组，Z 条警告', details: warnings.map(w=>w.message||w.code)})`。
- 导出零改动；新增字段常量 `boc-dispatch-order-fields.js`（chChannelName/chReconId/gwOrderId/link 三字段/货币1金额 FIELD_MAP + 加载期对齐断言）。
- **前端唯一改动**（`renderer.js` runGatewayReconScenario 约 10 行）：①逐条显示前 5 条 warning 中文 message（手工 escape 后拼 `<br>`，防注入）超 5 条尾缀「等 N 条，详见操作日志」；②0 命中兜底文案去 JPM merchantId 硬编码；③有警告时弹框带 logLevel:'warning' 上报。落运行结果弹框 + activity log（✅ O2，不动 bankStatementStatusBox 禁写）。

---

## 十、块 F：Payment 线下调拨订单回填

### 10.1 config schema（F2，🔴）

`config.paymentOfflineBackfill = { enabled: boolean, bankChannel: string, region: string, bigAccount: string }`（老库无字段 fallback enabled=false；不改 seed 常量）。`region` 参与银行侧筛选（✅ Q1）。

- 保存：`update(scenarioId,{priority})` → `{priority, config:{...cachedConfig, paymentOfflineBackfill}}` 读-改-写浅合并（维持两段 IPC）。
- 🔴 守卫双层：① main 对 builtin-fixed config 更新加「必含 funcCategory/subCategory」最小校验（`main.js:3113-3124` handler 内）；② 单测断言「注入 paymentOfflineBackfill 后 bucketScenarios 分桶不变」。**严禁丢失** funcCategory/subCategory/roundPhase/directions/dateToleranceDays。

### 10.2 周数工具（F3，`engine-week-utils.js`，ISO 8601）

- `parseFtaDate(调拨单号)`：`/^FTA(\d{8})/` 提取 + 合法日期校验，失败 null（特征码 Object.freeze 常量）。
- `weekTag(date) → 'YYWW'`：✅ Q2 ISO 8601（周一为周首、含首个周四的周为 W1），YY 取 **ISO week-year**（非日历年）；基准断言四元组写死：`2026-06-02→'2623'`、`2026-01-01→'2601'`、`2025-12-29→'2601'`、`2027-01-01→'2653'`；订单侧/银行侧共用同一实现。
- `weekTagPlusOne(date)`：✅ D2「+1」= 判断日期 +7 天所在周的 weekTag（**禁 YYWW 数字加法**，年末必错）。
- 内部周数比较用 number（YY*100+WW），展示零填充 String；日期解析复用 engine-date-utils `toDate`（文件头明令禁自写解析）。

### 10.3 数据接线（F4，🔴）

- `bank-statement:run`（`main.js:3617` 旁）：仅当 r5s2 场景 enabled **且** `config.paymentOfflineBackfill.enabled` 时 `workingMidRows = structuredClone(database.readLinkedTableRows('mid-allocation'))`（gating 防整表无谓载入）。
- `runReconciliation` 新入参 `midAllocationContext = { midAllocationRows }`（仿 refundContext）。
- 编排器 **R5s2b 显式接线**（R5s2 块 `:210-222` 之后）：gating = r5s2Bucket 非空 ∧ `config?.paymentOfflineBackfill?.enabled===true` ∧ midRows 非空；显式传 `{bigAccount, bankChannel, region, excludeBankRowIds}`（excludeBankRowIds = R5s2 已消费/已回填 bank `_rowId` 集合，✅ Q3 网关回填优先；⚠️ 现状编排器只拣 directions/dateToleranceDays 两 key，**config 加 key 不会自动流入引擎**，须显式传）；mergeMods + allWarnings + stats.r5s2bBackfilledCount + rounds.r5s2b。
- 🔴 **mid-allocation 导入补清 processingResult**（`main.js:11405` 分支内、独立于 ADM try 块）；同步改写守卫注释 `:11450-11451`。

### 10.4 匹配引擎（F5，`r5-payment-offline-allocation-backfill.js`，🔴 核心）

纯函数 `(bankRows, midAllocationRows, options) → { modifications, warnings }`，骨架照搬 `r5-fund-transfer-backfill.js:98-205`。

🔒 引擎不变量（✅ Q3）：构池前剔除 `options.excludeBankRowIds`——两引擎零互相覆盖；单测含双引擎互斥断言。

7 步（见 PRD §5.6.1）：①订单池（收款账户(卡号)===bigAccount ∧ 付款渠道===bankChannel；FTA 不合规筛中行计 warning）→ ②银行池（MerchantId===bigAccount ∧ FundType==='FundTransfer-in' 大写 T ∧ 地区列===region；剔除 excludeBankRowIds）→ ③周数 join（银行行查「订单周+1」桶，weekTagPlusOne 日期语义）→ ④主轮（'Credit Amount'↔收款金额 Math.round*100 ∧ Currency↔收款币种 ∧ BillDate 晚于交易时间，✅ Q6 日粒度同日算晚于；候选 |天数差| 升序稳定排序贪心 tie=原序 first-wins；严格 1v1 usedSet）→ ⑤差错池（✅ Q5 BillDate 日严格早于交易时间→二轮放宽周数约束匹配全部未消费订单；usedSet 跨两轮共享）→ ⑥回填（渠道流水号→ReconciliationId，`nv=normalizeCellValue`、`old!==nv` 才写+record 自动标黄；命中即覆盖 ✅ D6）→ ⑦warning（code 连字符风格；**银行侧 warning 必带 _rowId** 供块 D F3 enrich 反查）。

### 10.5 输出链收口（F6）

标黄/写盘零改动（mergeMods→_modifiedColumns Set→exceljs-writer）；`error-causes.js` CAUSE_MAP 补全部新 code；error-report 形态按块 D 终态（error-reports/{date}/ + 对账ID列）。

### 10.6 字段常量（`payment-offline-allocation-fields.js`，启动期断言）

锁死中台列名（**收款账户（卡号）idx6 全角括号**、付款渠道、调拨单号、交易时间、收款金额、收款币种、渠道流水号）与银行列名（MerchantId/FundType='FundTransfer-in' 大写 T/BillDate/'Credit Amount'/Currency/ReconciliationId）；禁止引擎手敲。

---

## 十一、关键数据结构汇总

1. **两张 BOC 隐藏表 DDL**：见 §9.1（`linked_boc_fx_settlement` 8 列 + 2 索引；`linked_boc_bank_deposit` 5 列 + 1 索引；均不进 ALL_TABLE_KEYS/meta）。
2. **paymentOfflineBackfill config schema**：见 §10.1（`{enabled, bankChannel, region, bigAccount}`，零 migration，老库 fallback enabled=false）。
3. **引擎扩展 E1-E5 契约 hook**：见 §5.2（deleteForOverwrite / finalizeForCommit / rejectEmptyFiles / maxCollectedErrors+captureRowValues / dedupeKeyOf；铁律契约不声明=零变化）。
4. **FIELD_MAP 常量（单一真相 + 加载期断言）**：`boc-fx-link-fields.js`（§9.2）/ `boc-dispatch-order-fields.js`（§9.9）/ `payment-offline-allocation-fields.js`（§10.6）。
5. **BANK_DEPOSIT_FIELDS 13→14**：插入 'Payment Detail'（§9.4，🔴 加载期断言防回退漂移）。
6. **okResult 派生字段**：`bocDerive`（§9.5 #3）/ `bocBankDerive`（§9.5 #4），供前端弹框链消费。

---

## 十二、数据流图（文字版）

### 12.1 块 A 预检流

```
导入文件 → [A1 预检] yauzl 读中央目录 uncompressedSize（目标 sheet + sharedStrings）
  ├─ ≥2^31 → 抛 FileValidationError（中文 + GB + 拆分指引 + detailLines）
  ├─ <2^31 → 放行原 JSZip/引擎链路
  └─ 预检自身异常 → fail-open 放行（报原错）
链接表导入失败 → [A2 #1] handler 循环后 appendActivityLogEntry(error) → [A2 #3] 两入口弹 alert
```

### 12.2 块 B pending 引擎流

```
pending:import:start → big-table-import-dispatch（worker_threads, resourceLimits 4096MB, 多文件并行）
  → contract-pending.mapRow（33 参 + yearMonth 闭包 + E5 dedupeKeyOf 同算 hash）
  → 引擎大事务：E1 deleteForOverwrite(6 表顺序) → 逐行去重(E5 Set 按文件序) → INSERT
     → 任一错误(含重复行/空文件 E3) 整批 ROLLBACK
     → 全通过 → E2 finalizeForCommit(upsertMonthMeta) → COMMIT
  → 错误对象 → 还原 lastImportErrors → pending:error:export-report / UI 弹窗（零改动）
回退开关 false → 原 utilityProcess + worker.js 全旧链路
```

### 12.3 块 E BOC 派生流（2.1~2.5）

```
外汇交割表导入（强制数组路径 repoKey!=='fx-settlement'）→ readLinkedRowsAsObjectsWithMeta{objects, rowNumbers}
  → [2.1 scanFxGroups] 物理行序分组（交易编号连续段/空行断档关组）
  → [2.2 matchBocToMidAllocation 前段] 中台 BOC 候选 单行金额匹配剔除（清分组、消耗）
  → [2.3 后段] 剩余组汇总金额匹配 → 回填调拨单号(组内所有行，一组一单)
  → replaceBocFxLink
  → [2.4 buildBocBankRows] availability 三态 → 筛 CN/USD/Credit=0 + Payment Detail 最长数字串
     → replaceBocBankDeposit（无数据也重建空表防 stale）
  → [2.5 backfillBocReconLinkIds] 交易编号↔银行单交易编号 → 回填链接ID(幂等全量)
     → writeBocFxLinkReconIds → unlinked 明细写 activity log（前端不显示）
  → okResult.bocDerive → 弹框链（needBankImport 引导 / 已生成提示 / 静默）

运行 BOC 引擎：导入不平表(gateway) → runOpts.bocLinkRows=readBocFxLinkRows()
  → runBocDispatchOrderFix 8 步（整组从严）→ fixedRows → 导出另存(14 列, Type=2)
     → warnings 非空 → activity log + 运行结果弹框逐条文案
```

### 12.4 块 F payment run 流

```
UI 勾选+三输入(F1) → scenarios.update 浅合并 config(F2，自动清 processingResult)
→ 导入中台调拨单（F4 补：导入成功清 processingResult）
→ bank-statement:run：按勾选 gating 读 mid 全表(structuredClone, F4)
→ runReconciliation(midAllocationContext) → 编排器 R5s2(先跑,产 excludeBankRowIds) → R5s2b(F4)
→ 引擎(F5)：订单池/银行池(剔 excludeBankRowIds) → 周数现算(F3) → 周+1 join
   → 主轮(金额+币种+晚于+就近贪心 1v1) → 命中回填 ReconciliationId+标黄(F6)
   → 差错池二轮(放宽周数, usedSet 共享) → 未匹配 warnings(银行侧带 _rowId)
→ 导出：黄底主输出 + error-report(按块 D 终态 error-reports/{date}/ + 对账ID列)
```

---

## 十三、main.js 串行集成约束

🔴 `src/main.js` 含 NUL 字节、git 视为二进制 **不可文本合并**——所有触及 main.js 的子任务必须在主工作区**串行编辑**，纯新文件与互不相交文件的子任务并行。

- **串行窗口清单**（同一文件 main.js，必须排队编辑）：
  - A2 #1（`linked-table:import` handler 写 log，`:11273`）
  - 块 D F2/F3（`:3675` 后新增常量 + `:3693-3696` 同 hunk，commit F1→F3→F2 串行）
  - 块 E（import 钩子×2 + 数组路径守卫 + WithMeta + run 注入与日志）
  - 块 F（run 注入 workingMidRows + 导入清 processingResult `:11405` + config 校验 `:3113-3124`）
  - 块 B（pending session 接线 `:10322` 区段）
- **可并行**（纯新文件或互不相交）：引擎扩展包目录、contract-pending.js、contract-flow.js、big-table-import-dispatch.js、boc-fx-link-*.js、boc-dispatch-order-fix.js、r5-payment-*.js、engine-week-utils.js、各 constants、parity 脚本。
- **NUL 字节注意**：块 D 编辑行（`:3675/:3693-3696/:179/:189/:216`）与 main.js NUL（`:3401/:3406`，块 E spec 实测同口径）不重叠，Edit 可直接用；review 须 `git diff --text` / `grep -a`；若需改含 NUL 行须 `perl -i -pe 's/\x00/.../g'`（本迭代各块编辑行均不含 NUL）。

---

## 十四、测试策略

### 14.1 Unit（`npm run test:unit`）

- **块 A**：预检函数四态（正常/≥2^31/损坏 zip fail-open/zip64）。
- **PR-B**：引擎单测 E1-E5 各扩展声明/不声明两态。
- **块 D**：`c3-gateway-recon-join.test.js` 改约 15 处期望值（W2-V2 `:445,446` 负输入对称核心，DS1-DS9 与 W2-3 一行不改）+ 新增 2 条迁移边界用例；新增 `exceljs-writer-error-report.test.js` 三态回退链 + 5 列表头；`scenario-hit-rows-writer.test.js` 常量保护断言。
- **块 E**：`boc-fx-link-builder.test.js`（normalizeTransactionNo/extractLongestDigitRun/scanFxGroups/2.2/2.3/buildBocBankRows/backfill）；`linked-table-boc.test.js`（migration 幂等 + 隐藏红线 + 按 id 回写 + json_extract 三态 + **BANK_DEPOSIT_FIELDS=14**）；`boc-dispatch-order-fix.test.js`（~17 案，组全配/半配/OrderId 命中数/1v1 消耗/跨组同链接ID/两组共享调拨单号/入参不可变快照/分流四路/stats）；`migrations-boc-dispatch-order-seed.test.js`（镜像 JPM 6 案 + 排序案 [JPM, BOC]）。
- **块 F**：week-utils 基准（四元组写死 + FTA 解析 + +1 年末进位）；引擎仿 `r5-fund-transfer-backfill.test.js`（1v1/tie-break/三态审计 + 双引擎互斥 + Q6 同日算晚于边界）；orchestrator 行数守恒 + midAllocationContext 注入；config 合并不掉桶；renderer-dialogs 源码字符串断言锁 gating。

### 14.2 parity / Integration（`npm run test:integration` 自动发现）

- `pending-engine-migration.js`（legacy vs 引擎 byte-for-byte，块 B）。
- `bizop-flow-engine-migration.js`（块 C）。
- `v3.0.4-boc-dispatch-order-fix.js`（仿 v3.0.1-linked-gateway-upsert 自跑：种子→写 BOC链接表 fixture→造 4 sheet 不平表→runReconIdFix→断言 fixedRows/stats/warnings→writeReconIdFixOutput 读回 14 列/Type=2/Reference/Amount，块 E）。
- `bank-statement-hit-scenario-report.js` 新增 `bank-statement-process` 子目录断言（块 D F2）。
- 块 F：linked-table:import 清 processingResult 断言。

### 14.3 Smoke（`npm run smoke`）

- `scenario-dispatcher.js` I2 表头第 3 列 '行号'→'对账ID' + reconciliationId 断言 + 回退断言（块 D F3）。
- `bank-statement-io.js` W3 重写（传 bankRows 断言第 3 列=ReconciliationId）+ W3b（缺省/空回退 rowId）（块 D F3）。
- `scenario-end-to-end.js` E4（C1 多值不一致空 reconid 回退端到端，块 D）+ payment 扩展（块 F）。
- pending/biz-op 引擎路径 smoke 全走引擎过一遍（R-9）。

### 14.4 手测

见 PRD §七 + `docs/iterations/v3.0.4/manual-test-checklist.md`（块 E 新建）。重点：块 D 三点终态一次 /verify（含 cancel 路径查文件系统）；块 E fx→bank→fx 三序 + 单 sheet .xlsx 数组路径 + 14 列人工核对；块 F 三出口 + stale 拒导出 + 跨年周边界。

### 14.5 守卫（收尾硬节点）

`npm run release-check` 全绿（unit + integration + smoke 三层）+ 收单 34 断言全绿 + `npm run scan:vars` + `/check-vars`（命中 linked-table 域 / scenarios 域 / recon-id-fix 域 / runAllScenarios / unmatchedRows 反向 filter 契约 / processingResult / bankStatementSession / INTERNAL_FIELDS / writeBankStatementOutput 等）+ 动 renderer* → `npm run preview` 回归（含新增 `preview:builtin-fixed-channel-manage-payment`）。

### 14.6 不测项与原因

- 块 D F2 `main.js:3695` 传参无自动化断言（IPC handler）→ 手测覆盖。
- vcc 迁移 / bizOp 引擎迁移 / payment 多组配置：本迭代非目标，不测。

---

## 十五、任务分解

> 引用入口 spec §六实施编排表。每 task 尽量小、可验证、可独立完成。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| PR-A | 块 A：A1 预检（3 落点）+ A2 报错可见性（3 改点） | streaming-xlsx-reader/vcc reader/biz-op reader/main.js/renderer*/renderer-dialogs | 预检四态单测 + 链接表失败 log 集成 + 98w 手测 + preview | todo |
| PR-B | 引擎扩展包 E1-E5 + 单测 + 🔴 收单回归锁 | big-table-import 引擎目录 | E1-E5 两态单测 + 34 断言全绿 | todo |
| PR-C | pending 契约 + 共享 dispatch + session 接线 + 回退开关 + parity | contract-pending/big-table-import-dispatch/pending-session/main.js | pending-engine-migration.js byte-for-byte + 手测 | todo |
| PR-D | biz-op flow 契约 + session 接线 + 回退开关 + parity | contract-flow/session/main.js | bizop-flow-engine-migration.js + bizOp 回归 | todo |
| 块 D | recon-fixes：F1 取反 → F3 对账ID列 → F2 目录互换 → docs | c3/exceljs-writer/bank-statement-io/scenario-hit-rows-writer/main.js | unit + smoke + 集成 + 手测 | todo |
| 块 E | BOC：数据层 → 接线 → 种子 → 引擎 → 收口 | boc-fx-link-*/boc-dispatch-order-*/migrations/database/linked-table-repository/main.js/recon-id-fix-engine/renderer* | 4 单测 + 集成 + 手测清单 + preview | todo |
| 块 F | payment：PR-1 地基 → PR-2 引擎 → PR-3 UI | engine-week-utils/payment-offline-allocation-fields/r5-payment-*/renderer-dialogs/css/main.js/orchestrator/error-causes | week-utils 基准 + 引擎 + orchestrator + 手测 + preview | todo |
| 收尾 | 版本 bump 3.0.4 + 文档三件套 + scan:vars + check-vars + release-check | CHANGELOG/VERSION_FEATURE_HISTORY/USER_GUIDE/package.json | release-check 全绿 | todo |

依赖：PR-A 完全独立可先行；PR-C/PR-D 依赖 PR-B（可并行）；块 D 先行（块 F 依赖其 error-report 终态）；块 E 独立；触及 main.js 子任务串行（§十三）。

---

## 十六、实施计划（Commit 粒度）

> commit 前缀统一 `[v3.0.4]`；一 task 一/多 commit；最终单 PR 合入 main。

| 序号 | Commit message | 涉及文件 | 块 |
|------|---------------|---------|------|
| 1 | `[v3.0.4] feat(块A): JSZip 入口尺寸预检 + 链接表报错可见性` | A 全部 | A |
| 2 | `[v3.0.4] feat(块B PR-B): 引擎扩展包 E1-E5 + 收单 34 断言回归锁` | 引擎目录 | B/C 前置 |
| 3 | `[v3.0.4] feat(块B PR-C): pending 迁移引擎(契约+dispatch+session+parity)` | pending 全部 | B |
| 4 | `[v3.0.4] feat(块C PR-D): biz-op flow 迁移引擎(契约+session+parity)` | flow 全部 | C |
| 5 | `[v3.0.4] fix(块D): C3 Extra Fee 取反` | c3-gateway-recon-join | D F1 |
| 6 | `[v3.0.4] fix(块D): error report 行号列换对账ID(三级回退)` | exceljs-writer/bank-statement-io/main.js | D F3 |
| 7 | `[v3.0.4] fix(块D): 错误报告/命中场景行目录互换` | scenario-hit-rows-writer/main.js | D F2 |
| 8 | `[v3.0.4] feat(块E commit1): BOC 数据层(常量+builder+DDL+repo, 白名单 13→14)` | boc-fx-link-*/migrations/database/linked-table-repository | E F2 |
| 9 | `[v3.0.4] feat(块E commit2): BOC 导入钩子接线 + 弹框链` | main.js/renderer-dialogs | E F2 |
| 10 | `[v3.0.4] feat(块E commit3): BOC 内置场景种子` | migrations/database | E F1 |
| 11 | `[v3.0.4] feat(块E commit4): BOC 修复引擎 + 分流 + 运行反馈` | boc-dispatch-order-*/recon-id-fix-engine/main.js/renderer | E F3 |
| 12 | `[v3.0.4] feat(块F PR-1): payment 后端地基(week-utils+常量+接线+缓存失效)` | engine-week-utils/payment-fields/main.js/orchestrator | F F3/F2/F4 |
| 13 | `[v3.0.4] feat(块F PR-2): payment 匹配引擎 + 输出收口` | r5-payment-*/error-causes | F F5/F6 |
| 14 | `[v3.0.4] feat(块F PR-3): payment UI 勾选+展开行 + preview` | renderer-dialogs/css/renderer-previews/package.json | F F1 |
| 15 | `[v3.0.4] release+docs: bump 3.0.4 + 三件套 + 集成脚本 + 手测清单 + scan:vars` | CHANGELOG/VERSION_FEATURE_HISTORY/USER_GUIDE/package.json/scripts | 收尾 |

---

## 十七、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。由 Dev 在实施时填写。

### 2026-06-11

- 动作：基于六块编排 spec + 三子 spec 产出 PRD/TechDoc 文档（PM/Dev 文档阶段）。
- 证据：四份 spec 全部 ✅ 拍板（OPEN-1/2/3、块 D D2-D6、块 E U1-U4/D1-D11/O1-O4、块 F Q1-Q6/D1-D8）。
- 风险：见 §一.2 R-1~R-9 + 块 D/E/F 子风险（§十一 PRD）。
- 决策：流程 = PRD/TechDoc → dev agent coding（team-lead 不亲码）→ 单 PR → self-review → codex review → 无 P3+ finding 即 merge。

### 可沉淀知识

- [ ] 引擎扩展契约「不声明=零变化」铁律 + parity byte-for-byte 锁，是大表迁移的可复用范式（已沉淀 PR-H contract-flow）。
- [ ] 「+1」周数年末必须用日期语义（+7 天所在周），YYWW 数字加法在 ISO 53 周年末必错——可回写 knowledge。

---

## 十八、Open Technical Questions

- 无。本迭代决策点全部拍板（详见 PRD §十）。
- 实施期待核（非决策）：块 C flow 行内 date 与入参 date 一致性校验是否存在（调研未见，实施时核实平移，见 §七 7.2 #3）。

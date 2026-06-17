# TechDoc - 网银账单小助手 v3.0.8（7 需求：工具箱 / 场景管理体验 / 资金对账运行不阻塞+内存尖峰修复 / 未命中 sheet 布局 / BOC 调拨 Type / R5s3 两级 fallback）

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.8 |
| 日期 | 2026-06-16 |
| 作者 | Dev |
| 状态 | 定稿 |
| 关联 PRD | `docs/iterations/v3.0.8/PRD.md` |
| 实施方式 | team-lead 拆分委托 dev 分 W1~W6 工作流实施 |
| 质量门 | `npm run release-check` 全绿（unit + integration + smoke）；🔴 资金红线需求 3/4/5/6/7 须 `/check-vars` + 人工复核 |
| 依赖 | 当前 `v3.0.7` 分支 → 第一步切 `v3.0.8` 并 bump `package.json.version → 3.0.8`；需求 3 与需求 6 改同一 `bank-statement:run` handler，**必须合并工作流（W4）先 6 后 3 顺序实施** |

> **来源 spec / plan（唯一事实源）**：
> 1. 已批准 plan：`/Users/pzhong/.claude/plans/3-0-8-3-0-8-1-xlsx-toasty-wozniak.md`（7 需求整体方案 + 资金红线汇总 + W1~W6 拆分）
> 2. spec A（需求6）：`changes/v3.0.7-run-linked-memory-fix/spec.md`（bank-deposit 门控 + gateway 按 Channel 过滤读，含三陷阱 §四 + 等价测试 §五）
> 3. spec B（需求7）：`changes/r5s3-channelorderno-fallback-inbound-substring/spec.md`（D-1~D-3 / D-2~D-2c 伪代码 §三 + 改3新增7单测 §四）
>
> 本 TechDoc 以上述为实现侧事实源；所有 SQL / 谓词 / 算法 / 决策表与 spec 逐字对齐，不自行发明语义。两份 spec 原标 `v3.0.7`，并入本迭代后版本 tag / commit / 注释统一用 `v3.0.8`。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 需求1 工具箱（合表/拆表） | 全新轻量工具，脱离对账流程；复用既有 `extractHeaders`/`readRows`/`writeWorkbookRows`（file-service）+ `openModal/closeModal`（renderer-dialogs）+ `createModuleCabinetDialog` 弹框范式；3 个新 IPC 走 `trackedIpcHandle`，对现有链路零侵入，可行 |
| §5.2 需求2 场景管理（退役 C3 + 分组折叠） | C3 退役为「**纯前端过滤**」（实施期决策；`migrations.js` 零改动，引擎/dispatcher case/CHECK 约束/seed/已有库记录全保留 → 更可回滚、零 migration 风险）；分组折叠是 `refreshTable` 纯前端重排，零后端改动，可行 |
| §5.3 需求3 运行不阻塞 | handler 改 async + 阶段边界 `await setImmediate` 让出 + 进度事件，仿 `createRunProgressForwarder`（main.js:12302）已验证范式；**轮次顺序/引擎入参/数据逻辑零改动**，golden 字节一致，可行 |
| §5.4 需求4 未命中 sheet 布局 | `exceljs-writer.js` sheet1 仅列右移（`idx+1→idx+2`、`colIdx+1→colIdx+2`），A1 提醒不变；最小改动、仅 sheet1，可行 |
| §5.5 需求5 BOC 调拨 Type | `boc-dispatch-order-fix.js:238` 单值 `2→1`；src/ 内无按 `Type==2` 过滤逻辑（Type 仅落输出 Excel 给下游），可行（**须用户确认 Type=1 业务语义**） |
| §5.6 需求6 内存尖峰修复 | bank-deposit 门控（字节级不变）+ gateway 按 Channel 过滤读（带业务不变量优化）；新仓储 `readGatewayBillRowsByChannels` 仿 `readBankDepositAdmCandidates`（line 940）范式，可行 |
| §5.7 需求7 R5s3 两级 fallback | 唯一引擎 `r5-platform-inbound-cleanup.js` 三处改动；helper 抽取后两级桶按严格优先级各调一次，O-1/O-4 口径不变，可行 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | 🔴🔴 需求3 + 需求6 改同一 `bank-statement:run` handler（main.js:3644+），分开各改必撞接缝（gwRows/depositRows 读取行 + 异步化在同一函数体） | **合并工作流 W4，先 6 减载入、后 3 异步化**，单 agent 顺序实施；见 §五·协同顺序与接缝契约 |
| R-2 | 🔴 需求6 修复2 gateway 按 Channel 过滤读是「带业务不变量的优化」（非纯字节不变），三陷阱（空/缺 Channel、归一化口径、跨轮越界）任一漏实现 → 漏匹配 = 漏对账 | 仓储单测覆盖边界 + 全表 vs 过滤等价集成测试逐字节相等 + 网关只读不变量；见 §七 |
| R-3 | 🔴 需求6 修复1 bank-deposit 门控谓词必须与 orchestrator `bucketScenarios` r5s4 分桶条件逐字等价，否则退款场景启用时漏读 → 漏退款回填 | 谓词逐字镜像 + 门控谓词断言钉死同源（断言 `bucketScenarios(...).r5s4.length>0` 一致）；见 §六·6.2 |
| R-4 | 🔴 需求7 fallback 误命中（ChannelOrderNo 与 ReconciliationId 业务含义不同）；触发方向写反（含子串是「不产」）；1v1 跨两级重复消费 | D-1a（仅 empty 才 fallback）+ D-1b（二级同跑 Credit 消歧）+ D-3（消歧失败不 fallback）+ usedBankRowId 跨两级共享；新增用例 1/2/6/7 守护；见 §九 |
| R-5 | 需求3 异步化后 handler 内 `processingResult` 全局赋值时机：必须 run 全程完成后再写，中途 yield 期间不可有并发 run 改写 | handler 入口已有 session 守卫；不引入新并发入口；进度事件只读不写 `processingResult`；见 §八·8.4 |
| R-6 | 需求1 工具箱合表「表头全相同」校验口径：`extractHeaders` 已 `normalizeCell`（trim），但需明确大小写/顺序敏感 | 校验用 `JSON.stringify(headers)` 全等（顺序+大小写敏感），不同即 `FileValidationError`；见 §三·3.4 |
| R-7 | 需求1 拆表多选值 → 单文件：plan 决策「含所有选中值的行进同一文件」，文件名 sanitize | 多选值用分隔符拼接 + `sanitizeFileName`；过滤 `row[field] ∈ values`；见 §三 |
| R-8 | 需求2 退役 C3 后已有库记录（enabled=0 的 C3）仍在 DB，前端过滤 `category==='gateway-recon-join'` 不显示即可；不动 CHECK/case | 仅 `refreshTable`/`renderRow` 过滤 + seed 不插，可回滚；见 §四 |
| R-9 | 需求4/5 golden 更新：确认仅 sheet1 右移（sheet2 命中场景首列「命中明细」不涉及）、Type 落输出给下游 | golden 回归 + 单测断言更新；需求5 须用户确认语义；见 §八 |
| R-10 | main.js 含 NUL 字节（`reference_mainjs_nul_grep`）：本迭代编辑行（3677/3682 区段、12302 区段）须确认不与 NUL 行重叠；review 用 `git diff --text` / `grep -a` | 编辑前 `grep -an $'\x00'` 定位 NUL 行，避开；见 §十一 |

### 1.3 与 PRD 的差异

无。所有技术实现与 PRD 描述一致；需求6 gateway 过滤读的「跨渠道误匹配消失」属业务不变量背书的 intentional 行为（见 §六·6.4），PRD §8 已列为对外行为变更。

---

## 二、涉及的文件清单

> 按需求分组。W1 需求5 / W2 需求4 / W3 需求7 / W4 需求6+3 / W5 需求1 / W6 需求2。

### 需求 1：工具箱（W5）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `index.html` | 修改 | `#backgroundTool .background-tool-actions`（行 402-435）加 `<button id="toolboxBtn" class="palette-trigger">🧰</button>` |
| `src/renderer.js` | 修改 | ~5990-6032 绑 `toolboxBtn` click → `openModal(createToolboxDialog())` |
| `src/renderer-dialogs.js` | 修改 | 新增 `createToolboxDialog()` 主弹框 + `createSplitFieldPickerDialog({headers, valuesByField, onComplete, onCancel})` 拆表选字段弹框 |
| `src/preload.js` | 修改 | 暴露 `desktopApi.toolbox = { merge, splitRead, splitExport }`（3 IPC） |
| `src/main.js` | 修改 | `trackedIpcHandle` 加 3 handler：`toolbox:merge` / `toolbox:split:read` / `toolbox:split:export` + 12 位时间戳 helper |
| `src/backend/file-service.js`（facade，**复用**） | 不改/读 | `extractHeaders` / `readRows` / `writeWorkbookRows` 已暴露（行 10/12/35/810/885），直接复用 |
| `src/styles-gemini-extra.css` | 修改 | `.toolbox-card` 等弹框样式（**Clear 主题唯一生效表**，见 `reference_active_css_theme`） |
| `renderer-previews.js` / `package.json` | 修改 | 新弹框补 preview 入口（4 处约定）：`preview:toolbox` |
| `tests/unit/...` + `scripts/integration/toolbox-roundtrip.js` | 新增 | 合并/拆分纯逻辑单测 + 跨接缝端到端集成 |

### 需求 2：场景管理（W6）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/renderer-dialogs.js` | 修改 | `createScenariosManagerDialog` 的 `refreshTable`（6746+）：① 过滤 `category==='gateway-recon-join'` 不显示（实现 7045 `scenariosRaw.filter`）；② 按 `config.funcCategory` 分组渲染分组标题行 + ▶/▼ 三角，两组默认 collapsed；③ 序号列严格用 `scenario.displayIndex`（7071-7079，N3-1 红线，分组不串号） |
| ~~`src/backend/database/migrations.js`~~ | **不改**（实施期决策） | **退役方式改为纯前端过滤**：`migrations.js` 一行不改，新库照常 seed C3（378-379），仅前端隐藏。决策原因：更可回滚、零 migration 风险。 |
| `src/styles-gemini-extra.css` | 修改 | `.scenario-group-header` / `.scenario-group-toggle` / `.collapsed` |
| `renderer-previews.js` / `docs/previews/scenarios-manager.png` | 修改 | 场景管理 preview 重跑（折叠态 + C3 消失） |
| `tests/unit/renderer-dialogs-scenario-group-collapse.test.js` | 新增 | 分组折叠 + C3 过滤 + displayIndex 序号断言（实测 commit 9e67b56 新建此测，182 行） |
| **不动** | — | c3 引擎 `c3-gateway-recon-join.js` / dispatcher case / CHECK 约束（migrations.js:409/518/571）/ **seed（migrations.js:378，新库照常 seed）** / 已有库 C3 记录（可回滚红线） |

### 需求 3：运行不阻塞（W4，与需求6 合并）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main.js` | 修改 | `bank-statement:run` handler（3644）改 `async`；阶段边界 `await new Promise(r=>setImmediate(r))`；新增 `createBankStatementRunProgressForwarder`（仿 12302）+ handler 内订阅 `event` 转发 `bank-statement:run:progress` |
| `src/main-process/reconciliation-orchestrator.js` | 修改 | `runReconciliation`（271）改 async / 注入 `onProgress`；轮次边界插 yield + 进度上报，实际边界为 R1→R2(dispatcher)→R3.5→R4→R5（R5 内细分子轮 s2@359 / s2b@404 / s3@423 / s4@448），R2 在 R1 与 R3.5 之间（轮次顺序/引擎入参/数据逻辑零改动） |
| `src/preload.js` | 修改 | `bankStatement` 命名空间加 `onRunProgress(listener)`（仿 acquiring `onRunProgress`，preload:377） |
| `src/renderer.js` | 修改 | `runBankStatementInternal`（4101）订阅进度更新状态框（仿 `handleAcquiringBillCurrencyRun` 5340-5387 的 onRunProgress + finally unsubscribe） |
| `tests/unit/main-process/reconciliation-orchestrator*.test.js` | 修改 | 异步化后结果不变断言（golden 字节一致）+ onProgress 调用顺序断言 |

### 需求 4：未命中 sheet 布局（W2）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main-process/exceljs-writer.js` | 修改 | `writeBankStatementOutput` sheet1（236-256）：表头 `headerRow2.getCell(idx+1)→idx+2`（251）、数据 `r.getCell(colIdx+1)→colIdx+2`（255）；A1 提醒不变 |
| golden + 单测 | 修改 | bank-statement 未命中 sheet golden 更新（仅 sheet1，确认 sheet2 不涉及） |

### 需求 5：BOC 调拨 Type（W1）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main-process/scenario-engines/boc-dispatch-order-fix.js` | 修改 | `:238` `Type: 2` → `Type: 1` + 同步注释（`:5`/`:20` 文案「Type=2 / D9」、`:238` 行内注释） |
| 单测 + golden | 修改 | boc-dispatch-order-fix 输出断言 `Type===1` |

### 需求 6：内存尖峰修复（W4，与需求3 合并）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main.js` | 修改 | `:3682` bank-deposit 加 `refundBackfillEnabled` 门控；`:3677` gateway 改 `readGatewayBillRowsByChannels(bankChannels)`（删 structuredClone） |
| `src/backend/database/linked-table-repository.js` | 修改 | 新增 `readGatewayBillRowsByChannels(db, channels)`（仿 `readBankDepositAdmCandidates`，~line 940） |
| `src/backend/database.js` | 修改 | facade 暴露 `readGatewayBillRowsByChannels(channels)`（仿 1318 `readBankDepositAdmCandidates`） |
| `tests/unit/backend/database/gateway-channel-filter.test.js` | 新增 | 仓储单测（空/缺 Channel、归一化、空集边界） |
| `scripts/integration/gateway-channel-filter-equivalence.js` | 新增 | 全表读 vs 过滤读喂同一 `runReconciliation`，产物逐字节相等 |
| `tests/unit/main-process/reconciliation-orchestrator.test.js` | 修改 | 「网关行只读」不变量断言（run 前 snapshot / run 后 deepEqual） + bank-deposit 门控谓词断言 |

### 需求 7：R5s3 两级 fallback（W3）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main-process/scenario-engines/r5-platform-inbound-cleanup.js` | 修改 | 三处：① 建双键索引（替换 :72-79）；② 匹配循环抽 `pickFromCandidates` helper + 两级优先级（替换 :84-133）；③ 触发条件改子串判定（替换 :130） + 注释/版本 tag → v3.0.8 |
| `tests/unit/main-process/scenario-engines/r5-platform-inbound-cleanup.test.js` | 修改 | 改 3（:153/:162/:373）+ 新增 7（fixture `bankRow` 加可选 `channelOrderNo`） |
| **不动** | — | `buildCleanupRow`（:34-47）/ 配置 seed（migrations.js:1544-1556）/ `CLEANUP_COPY_HEADERS` |

### 需求 8：使用手册补全 + 全册去技术术语（第二轮追加，纯文档）

> 详见 §十七。文档侧需求，**不碰业务代码 / 接口 / 数据**。

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `docs/USER_GUIDE.md` | 修改 | ① 1.4 新增「中台订单数据处理」总览导航小节（行 604+）；② 全册技术术语清理为业务白话（约 567 处替换）；③ 1.6.1 加银行对账单 46 列兼容说明 |
| `knowledge/user-guide-dejargon-playbook.md` | 新增 | 去术语 SOP（核心原则 / 禁用词清单 / 保留清单 / 统一译法表 / ultracode 执行流程 / 易错点），供后续每次写改手册复用 |
| **不动** | — | `src/**`（任何业务代码 / 接口 / 数据），纯文档措辞改造 |

### 需求 9：银行对账单 44→46 列（第二轮追加，🔴 资金红线，识别 + 字段可选 + BU 兼容导入不落库）

> 详见 §十八。`assets/银行对账单.xlsx`「渠道对账单」sheet 在 `'Transaction Description'` 后插「合并单号」「合并状态」，44→46。

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/constants/bank-statement-fields.js` | 修改 | `BANK_STATEMENT_FIELDS` 44→46（「合并单号」:26 /「合并状态」:27 插在 `'Transaction Description'`:25 后） |
| `src/preload.js` | 修改 | 暴露给渲染进程的 inline 副本（:11）逐项同步「合并单号」「合并状态」，与 bank-statement-fields 逐列一致 |
| `src/constants/table-signatures.js` | 修改 | 注释 44→46（:36 / :179）；`expectedHeaders:[...BANK_STATEMENT_FIELDS]`（银行对账单 :41 / 入金表 :188）自动跟随；`signatureHeaders` 指纹列不变（:44） |
| `src/backend/bank-bu-recon-import/validator.js` | 修改 | `buildHeaderValidator` 加 `options.allowSupersetColumns`（:24-25 + 宽容超集分支 :39-78）；`validateBankHeaders` 启用 `{allowSupersetColumns:true}`（:117）；`validatePendingGuanliHeaders` 保持严格（:115） |
| `src/backend/bank-bu-recon-import/reader.js` | 修改 | `buildRowMapper` 改按列名定位取值（`headerIndexMap`，:59-65；注释 :37-40），防后移列错位 |
| `src/backend/bank-bu-recon-db/columns.js` | **不改** | `BANK_HEADERS` 保持 44 列（不含合并单号 / 合并状态）= DB 列结构不动 = 不落库（🔴） |
| `tests/unit/constants/bank-statement-fields.test.js` | 修改 | 断言 `BANK_STATEMENT_FIELDS` = 46 + 含两列 |
| `tests/unit/backend/bank-bu-recon-import/validator.test.js` | 修改 | 宽容超集契约（46 列文件通过 / 乱序失败 / 缺列失败 / Pending 严格零回归） |
| `tests/unit/backend/bank-bu-recon-import/header-superset-mapping.test.js` | 新增 | 按列名映射（46 列文件取值不错位、忽略两列、不落库） |

### 文档发版（全需求）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` | 修改 | 三件套统一更新（工具箱用法、场景折叠、资金对账异步提示、内存优化、R5s3 规则） |
| `docs/iterations/v3.0.8/PRD.md` + 本 TechDoc | 新增 | 本迭代 PRD/TechDoc |
| `changes/v3.0.7-run-linked-memory-fix/` + `changes/r5s3-channelorderno-fallback-inbound-substring/` | 归档 | spec A/B 实施后 `/archive` |

---

## 三、架构 / 模块改动地图（文字版）

```
Renderer（index.html + renderer.js + renderer-dialogs.js）
  ├─[需求1] index.html:402-435 加 #toolboxBtn 🧰
  ├─[需求1] renderer.js ~5990-6032 绑 click → openModal(createToolboxDialog())
  ├─[需求1] renderer-dialogs.js: createToolboxDialog() + createSplitFieldPickerDialog()
  ├─[需求2] renderer-dialogs.js: createScenariosManagerDialog.refreshTable 过滤 C3 + 分组折叠
  └─[需求3] renderer.js:4101 runBankStatementInternal 订阅 onRunProgress 更新状态框
        │  ipcRenderer.invoke() / ipcRenderer.on()
        ▼
Preload（src/preload.js）
  ├─[需求1] desktopApi.toolbox = { merge, splitRead, splitExport }
  └─[需求3] desktopApi.bankStatement.onRunProgress(listener)（仿 acquiring:377）
        │
        ▼
Main Process（src/main.js）— 🔴 NUL 二进制（grep -a / git diff --text）
  ├─[需求1] trackedIpcHandle: toolbox:merge / toolbox:split:read / toolbox:split:export
  ├─[需求3] createBankStatementRunProgressForwarder（仿 12302）
  └─[需求3+6] bank-statement:run handler（3644）：
       ├─[需求6 先] :3682 bank-deposit 门控 / :3677 gateway 按 Channel 过滤读
       └─[需求3 后] handler 改 async + 阶段 yield + onProgress 注入 runReconciliation
        │
        ├── src/backend/file-service.js（facade，需求1 复用 extractHeaders/readRows/writeWorkbookRows）
        │     └── file-service/{readers,writers}.js
        ├── src/backend/database.js（facade，需求6 加 readGatewayBillRowsByChannels）
        │     └── database/
        │         └─[需求6] linked-table-repository.js: readGatewayBillRowsByChannels（+json_valid 守卫）
        │         （需求2 不再改 migrations.js —— 纯前端过滤退役，C3 seed 保留）
        └── src/main-process/
            ├─[需求3] reconciliation-orchestrator.js: runReconciliation async + onProgress
            ├─[需求4] exceljs-writer.js: writeBankStatementOutput sheet1 列右移
            └─[需求5/7] scenario-engines/{boc-dispatch-order-fix.js, r5-platform-inbound-cleanup.js}
```

### 3.4 需求1 全链路接缝契约（renderer ↔ preload ↔ main ↔ file-service）

> 🔴 跨接缝盲区（`feedback_multiagent_seam_gap`）：工具箱前端弹框与后端 IPC 可拆两段实施，但 **3 个 IPC 的入参/返回结构是跨接缝契约，必须补端到端测试**。

**IPC 1 — `toolbox:merge`（合表，导入即一气呵成到另存为）**

| 项 | 契约 |
|----|------|
| 入参 | 无（handler 内 `dialog.showOpenDialog` 多选） |
| 流程 | `showOpenDialog`(多选 xlsx/csv) → 各文件 `extractHeaders`（readers.js:364，返回 trim 后表头数组）→ 校验全相同（`JSON.stringify(headers)` 全等，顺序+大小写敏感）→ 不同则抛 `FileValidationError`（前端 alert 停止）→ 各文件 `readRows`（readers.js:148，返回 aoa 含表头行）→ 合并 aoa = `[首文件表头行, ...各文件数据行(切掉各自表头行)]` → `writeWorkbookRows({rows: aoa, outputFilePath, sheetName})`（经 file-service facade `file-service.js:810` 调用——main.js 实际 require 入口，facade 内部再补 formatters 转调 writers.js:223 实现，工具箱不直接 require writers.js）→ `showSaveDialog`(默认名 `合并-{YYYYMMDDHHmm}.xlsx`) |
| 返回 | `{ status: 'success', filePath }` / `{ status: 'cancelled' }` / `{ status: 'failed', message, detailLines }`（实现按 house 约定用 `'success'/'cancelled'/'failed'` 三态，**非** `'ok'`；见 main.js:12907/12886/12858） |
| 前端 | `createToolboxDialog` 合并行 = 单 `[导入文件]` 按钮 → invoke → 成功 toast/alert 路径、失败 alert detailLines |

**IPC 2 — `toolbox:split:read`（拆表第一步：读源 + 算去重值）**

| 项 | 契约 |
|----|------|
| 入参 | 无（handler 内 `showOpenDialog` 单选） |
| 流程 | `showOpenDialog`(单选) → `extractHeaders` + `readRows` → 按列算各字段去重值 `valuesByField`（`{ [header]: string[] }`，值 normalize + 去重 + 保留首现序） |
| 返回 | `{ status:'success', sourceFilePath, headers: string[], valuesByField }` / `{ status:'cancelled' }` / `{ status:'failed', message }`（三态字面量同上，成功态为 `'success'`） |
| 前端 | 拆表行 `[导入文件]` → invoke split:read → 成功则 `openModal(createSplitFieldPickerDialog({headers, valuesByField, onComplete, onCancel}))` |

**IPC 3 — `toolbox:split:export`（拆表第二步：过滤 + 写）**

| 项 | 契约 |
|----|------|
| 入参 | `{ sourceFilePath, field, values: string[] }` |
| 流程 | `readRows(sourceFilePath)` → 定位 `field` 列索引 → 过滤数据行 `normalizeCell(row[colIdx]) ∈ values`（**多选值 → 单文件**，含所有选中值的行）→ `writeWorkbookRows`（aoa = `[表头行, ...命中行]`）→ `showSaveDialog`(默认名 `拆分-{values 分隔符拼接 sanitizeFileName}-{YYYYMMDDHHmm}.xlsx`) |
| 返回 | `{ status:'success', filePath }` / `{ status:'cancelled' }` / `{ status:'failed', message, detailLines }`（三态字面量同上，成功态为 `'success'`；split:export 失败态也带 `detailLines`） |
| 前端 | `createSplitFieldPickerDialog` 单选下拉（=表头）+ 多选下拉（=该字段去重值，随单选刷新）+ `[完成][取消]`；完成 → invoke split:export |

**接缝陷阱**：
- `readRows` 返回 **aoa（二维数组，第 0 行 = 表头）**，不是对象数组；合并/过滤须按列索引操作，不能假设对象键。
- 工具箱经 file-service facade `writeWorkbookRows({rows, outputFilePath, sheetName})`（file-service.js:810，单参 aoa）调用——facade 内部已注入默认 formatters 再转调 writers.js:223 实现；工具箱侧不直接 require writers.js、无需也无法自传 formatters。
- `extractHeaders` 已 `normalizeCell`（trim）→ 合表「表头相同」比对口径天然 trim；空文件 `extractHeaders` 抛 `FileValidationError('FILE_READ', ...)`，前端须捕获展示。
- 12 位时间戳 helper（`YYYYMMDDHHmm`）放 main 侧，三 handler 共用。

---

## 四、需求 2：场景管理（退役 C3 + 分组折叠）

### 4.1 实现方案

- **退役 C3（`gateway-recon-join`）= 纯前端过滤隐藏，后端完全不动**（实施期决策；可回滚红线）：
  - 前端：`createScenariosManagerDialog` 的 `refreshTable`（renderer-dialogs.js:6746+）过滤 `category==='gateway-recon-join'` 不渲染（实现落 renderer-dialogs.js:7045 `const scenarios = scenariosRaw.filter((s) => s.category !== 'gateway-recon-join')`）。
  - **后端 `migrations.js` 一行不改**（原 TechDoc 草案的「新库不 seed C3」未采用）。**决策原因**：纯前端过滤更可回滚（回滚只撤一行 filter）、零 migration 风险（不动 seed/不引入 migration 顺序依赖）；新库照常 seed C3，仅前端隐藏。
  - **不动**：c3 引擎、dispatcher case、CHECK 约束（migrations.js:409/518/571 含 `'gateway-recon-join'` 枚举）、**seed（migrations.js:378，新库照常 seed C3）**、已有库 C3 记录（enabled=0，R2 可选场景，与 R1 强制匹配无关）。
  - **已知取舍（OPEN-2）**：退役仅作用于「场景管理列表展示」；新建场景下拉（renderer-dialogs.js:8005 `{ value: 'gateway-recon-join', ... }`）仍含 C3、`createScenarioConfigDialogC3()`（renderer-dialogs.js:238）仍可达 → 用户仍能新建 C3 场景。本迭代不封新建入口。
- **分组折叠**：现状扁平表格，改 `refreshTable` 按 `config.funcCategory` 分组：
  - 「资金性质校验」组 = `funcCategory ∈ {fund-nature-check, dbs-charge-fund-check}`；
  - 「中台订单数据处理」组 = `funcCategory === 'platform-order'`；
  - 映射见 `renderer-dialogs.js:5621` `FUNC_CATEGORY_LABELS`（已存在，复用作组名；renderer.js:5621 是无关的 setBizOpReconStatus 代码）。
  - 插分组标题行（含 ▶/▼ 三角 + 组名）+ 子场景行按折叠态显隐；两组**默认 collapsed**。
- **为什么不用其他方案**：C3 物理删除会破坏 CHECK 枚举与已有库记录、不可回滚，且 R2 dispatcher case 仍引用。原草案「UI 隐藏 + migrations 不 seed」需改 `migrations.js`（引入 migration 改动 + 新库与旧库行为分叉）；实施期收窄为**纯前端 UI 过滤**（`migrations.js` 零改动）—— 回滚面更小、零 migration 风险、新旧库一致，是最小可回滚改动。

### 4.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `renderer-dialogs.js` | 7045 `refreshTable` | 过滤 C3（`scenariosRaw.filter(s => s.category!=='gateway-recon-join')`）+ 按 funcCategory 分组渲染（分组标题行 + 三角 + 折叠态显隐，默认 collapsed）+ 序号列用 `displayIndex`（7071-7079，分组不串号） |
| ~~`migrations.js`~~ | — | **不改**（实施期决策：纯前端过滤退役，seed 保留、零 migration 风险） |
| `styles-gemini-extra.css` | 新增 | `.scenario-group-header` / `.scenario-group-toggle` / `.collapsed` |

### 4.3 注意事项

- 退役只过滤显示，**老库已 enabled 的 C3 不强制禁用**（理论上老库 C3 默认 enabled=0；如有手动开启的，运行时 dispatcher case 仍在 → 行为不变，仅 UI 不可见）。新库照常 seed C3（migrations.js:378 不动），同样仅前端隐藏。如需更强收纳可后续讨论；本迭代按「纯前端过滤、后端零改动」最小实现。
- 🔴 **序号红线（displayIndex）**：分组折叠重排列表时序号列必须用 `scenario.displayIndex`（派发口径，renderer-dialogs.js:7071-7079 标注 N3-1 一致性红线），不能用分组后的列表位次，否则同一场景在分组前后序号会串号；`displayIndex` 缺失才回退位次（兜底）。命中 `rules/important-variables.md` displayIndex 软约束。
- 分组组名复用 `FUNC_CATEGORY_LABELS`，避免硬编码漂移。
- 折叠态是前端临时状态（不持久化），每次打开弹框默认 collapsed。
- preview 回归：场景管理新增折叠态 + C3 消失，重跑对应 `npm run preview:*`（commit 9e67b56 已更新 `docs/previews/scenarios-manager.png`）。

---

## 五、需求 3 + 需求 6：协同改造同一 `bank-statement:run` handler（🔴🔴）

> **两需求改同一 handler（main.js:3644+），必须由同一工作流 W4 顺序实施，先 6 后 3，禁止拆开各改 handler。** 这是本迭代最高风险接缝。

### 5.1 协同顺序（强约束）

```
第一步（需求6 修复1）：:3682 bank-deposit 加 refundBackfillEnabled 门控
第二步（需求6 修复2）：:3677 gateway 改 readGatewayBillRowsByChannels(bankChannels)（删 structuredClone）
        ── 至此数据准备阶段内存尖峰削掉（bank-deposit 不再无谓 clone、gateway 只读子集且不深拷）──
第三步（需求3）：handler 签名改 async；在数据准备 → R1-R5 各阶段边界插 await setImmediate yield
第四步（需求3）：createBankStatementRunProgressForwarder + handler 订阅 event 转发 + runReconciliation 注入 onProgress
        ── 至此 R1-R5 执行让出事件循环，窗口可响应、进度更新 ──
```

**为何先 6 后 3**：需求6 改的是 handler 内同步读取行（3677/3682），需求3 改的是 handler 签名（async）+ 整体控制流。若先做 3（async 化），3677/3682 的读取行已被 async 重构包裹，再做 6 的精确行替换会因上下文漂移失配；先做 6 在稳定的同步上下文里完成精确行替换，再做 3 整体异步化，6 的改动随之被 yield 边界自然分隔。

### 5.2 跨模块接缝契约（handler ↔ orchestrator ↔ repository）

| 接缝 | 契约 | 不变量 |
|------|------|--------|
| handler → orchestrator | `runReconciliation` 新增 async + `onProgress` 入参；**轮次顺序、引擎入参（bankRows/gwRows/scenarios/deps/各 context）、数据逻辑零改动**；返回结构不变 | golden 字节一致（需求3 只插 yield/进度，不改结果） |
| handler → repository（需求6 修复2） | `workingGwRows = database.readGatewayBillRowsByChannels(bankChannels)` 替换 `structuredClone(readLinkedTableRows('gateway-bill'))`；`bankChannels` = `bankStatementSession.rows.map(r => r.Channel!=null ? String(r.Channel).trim() : '')` | gwRows 全程只读（R1/R2/R3.5/R5s2/R5s3 仅建索引/比对，modifications 只写 bankRows）→ 删 structuredClone 安全；银行行 `structuredClone(bankStatementSession.rows)` **必须保留**（常驻 session、引擎原地改它） |
| handler → repository（需求6 修复1） | `workingDepositRows = refundBackfillEnabled ? structuredClone(readLinkedTableRows('bank-deposit')||[]) : []` | 谓词逐字镜像 orchestrator r5s4 分桶条件；退款场景关时编排器本就 no-op，注入 `[]` 字节级等价 |
| handler → renderer（需求3） | 新通道 `bank-statement:run:progress`（仿 `acquiringBillCurrency:run:progress`，main.js:12305）；preload `bankStatement.onRunProgress`；renderer `runBankStatementInternal` 订阅 + finally unsubscribe | 进度事件只读不写 `processingResult`；`processingResult` 仍在 run 全程完成后一次性赋值（3775） |

### 5.3 协同后效果

需求6 削掉数据准备阶段内存尖峰 → 需求3 让 R1-R5 执行让出事件循环 → Windows「开始运行」卡顿 / 未响应被根治。两者治同一痛点的「内存」与「事件循环」两面，缺一不可。

---

## 六、需求 6：内存尖峰修复（spec A，🔴 资金红线）

> spec 全文：`changes/v3.0.7-run-linked-memory-fix/spec.md`。两处修复。

### 6.1 现状基线（file:line）

- `main.js:3677`：`const workingGwRows = structuredClone(database.readLinkedTableRows('gateway-bill'));`
- `main.js:3682`：`const workingDepositRows = structuredClone(database.readLinkedTableRows('bank-deposit') || []);`
- `readLinkedTableRows`（linked-table-repository.js:916）整表读回；自标注 line 933「实测 65.7 万行 → ~1.2GB RSS 尖峰」。
- `workingDepositRows` 唯一消费者：`refundContext.depositRows`（main.js:3767）→ orchestrator `r5s4Bucket.length` 门控（orchestrator.js:443）；退款场景关 → 读了+深拷了一行没用。
- 旁边三处大表读取均已有消费方门控（`paymentOfflineEnabled`/`reconSourceMidEnabled`/`dbsChargeScenarioEnabled`，main.js:3696/3746/3755），唯独 bank-deposit 无门控。

### 6.2 修复 1：bank-deposit 加消费方门控（`main.js:3682`）

谓词**逐字镜像** orchestrator `bucketScenarios` r5s4 分桶**判断行**（`reconciliation-orchestrator.js:173`「builtin-fixed + platform-order + refund-order-backfill」；:142 是函数头 JSDoc 注释、非判断行）：

```js
// v3.0.8 修复：bank-deposit 入金表（65.7万行~1.2GB 尖峰）消费方门控，防整表无谓载入。
//   depositRows 仅 R5 场景4（退款回填）消费（编排器 r5s4Bucket.length 门控）；
//   谓词与 orchestrator bucketScenarios r5s4 条件逐字等价（builtin-fixed + platform-order + refund-order-backfill）。
const refundBackfillEnabled = dispatchScenarios.some(
  (s) => s && s.category === 'builtin-fixed'
    && s.config && s.config.funcCategory === 'platform-order'
    && s.config.subCategory === 'refund-order-backfill'
);
const workingDepositRows = refundBackfillEnabled
  ? structuredClone(database.readLinkedTableRows('bank-deposit') || [])
  : [];
```

- `dispatchScenarios` 已是 enabled 过滤后集合（main.js:3669），无须再判 enabled（与 `paymentOfflineEnabled` 同范式）。
- **结果字节级不变**：退款场景关时编排器本就 no-op，注入 `[]` 与现状等价；启用时照常读。

### 6.3 修复 2：gateway-bill 按 Channel 过滤读 + 不深拷（`main.js:3677`）

**业务不变量（业务负责人已确认，load-bearing 前提）**：跨渠道对账永远不存在——Channel=X 的银行行只匹配 Channel=X 的网关行。

**6.3a 新增仓储 `readGatewayBillRowsByChannels(db, channels)`**（linked-table-repository.js，仿 `readBankDepositAdmCandidates` ~line 940）：

```js
// v3.0.8：按 Channel 集合下推过滤读网关账单表（防 300 万行全量载入尖峰）。
//   业务不变量：对账永远同 Channel → 只需 Channel∈channels 的网关行。
//   channels 含空值时一并匹配「Channel=空串」与「缺 Channel 字段（json_extract→NULL）」两种网关行。
//   🔴 实施期增强（spec 外防御）：WHERE 先 json_valid(raw_json) 短路守卫，把坏 JSON 行排除在
//      json_extract 求值之外，防单条坏行的 json_extract 报错崩整轮对账 run（linked-table-repository.js:992-995）。
function readGatewayBillRowsByChannels(db, channels) {
  const def = getDef('gateway-bill');
  if (!def.supported) return [];
  const set = Array.from(new Set((channels || []).map((c) => (c == null ? '' : String(c).trim()))));
  if (set.length === 0) return [];
  const hasBlank = set.includes('');
  const nonBlank = set.filter((c) => c !== '');
  const conds = [];
  const params = [];
  if (nonBlank.length) { conds.push(`json_extract(raw_json,'$.Channel') IN (${nonBlank.map(() => '?').join(',')})`); params.push(...nonBlank); }
  if (hasBlank) { conds.push(`json_extract(raw_json,'$.Channel') IS NULL`); conds.push(`json_extract(raw_json,'$.Channel') = ''`); }
  // json_valid 守卫先短路，坏 JSON 行不进 json_extract（实现：WHERE json_valid(raw_json) AND (<conds>)）
  const rows = db.prepare(`SELECT raw_json FROM ${def.table} WHERE json_valid(raw_json) AND (${conds.join(' OR ')}) ORDER BY id ASC`).all(...params);
  const out = [];
  for (const r of rows) { try { const o = JSON.parse(r.raw_json); if (o && typeof o === 'object') out.push(o); } catch (_e) { /* 损坏行跳过 */ } }
  return out;
}
```

`database.js` facade 暴露（仿 1318）：

```js
readGatewayBillRowsByChannels(channels) {
  return linkedTableRepository.readGatewayBillRowsByChannels(this.db, channels);
}
```

**6.3b `main.js:3677` 改按 Channel 过滤读（不深拷）**：

```js
// v3.0.8 修复：网关账单表（可达数百万行）按 Channel 过滤读，根治内存尖峰。
//   业务不变量（已确认）：对账永远同 Channel → 只读本批银行单出现过的 Channel 子集，绝不漏合法匹配。
//   gwRows 全程只读（R1/R2/R3.5/R5s2/R5s3 仅建索引/比对，modifications 只写 bankRows）+ 每次新解析 → 无需深拷。
//   ⚠️ 银行行 structuredClone(bankStatementSession.rows) 必须保留（常驻 session、引擎原地改它）。
const bankChannels = bankStatementSession.rows.map((r) => (r && r.Channel != null ? String(r.Channel).trim() : ''));
const workingGwRows = database.readGatewayBillRowsByChannels(bankChannels);
```

### 6.4 三陷阱（spec §四，必须实现，否则漏匹配）

1. **空 / 缺 Channel**：银行行 Channel 空时 S 含空值；SQL `json_extract` 对「缺字段」返回 NULL，`NULL IN (...)` 恒 false → 当 S 含空值时额外 `OR json_extract IS NULL` + `OR json_extract = ''`，覆盖「网关行缺 Channel 字段」与「Channel=空串」两种。
2. **归一化一致**：S 内 Channel 值与网关 raw_json 存值同口径（`String().trim()`，大小写敏感），与引擎 `normalizeCell` 对齐（落库时已 normalizeCell → raw_json 内为已 trim 字符串，`json_extract` 精确等于与之一致），否则 IN 比对失配。
3. **跨轮不需越界网关行**：逐轮确认无哪一轮用「银行单未出现的 Channel」的网关行。
   - R1 reconid 匹配键不含 Channel，但业务不变量下合法对手必同 Channel（gwRows 子集含全部本批 Channel）；
   - R2 dispatcher 按渠道批处理；
   - R3.5 DBS-Charge：`dbsBankRows = bankRows.filter(Channel===DBS)`，无 DBS 银行行即整体 no-op（DBS 必在 S 内）；
   - R5s2/R5s3 匹配键（reconciliationid / ReconciliationId / ChannelOrderNo）不含 Channel，但合法对手同 Channel。
   - 结论：业务不变量下子集完备，不漏合法匹配；唯一被滤掉的「跨渠道匹配」业务确认不存在。

### 6.5 注意事项

- 修复2 是「带业务不变量的优化」，**非纯字节级不变**：若数据真有跨渠道键碰撞，现引擎会产「跨渠道误匹配」，过滤后消失（按业务定义本就是错配，过滤结果才对）。须等价测试 + 业务不变量双重背书。
- 「不深拷」天然包含在过滤读里（每次新解析 + gwRows 全程只读）；删 structuredClone 由「网关行只读」不变量断言守护（§七）。

---

## 七、需求 6 测试矩阵（核心护栏）

| 测试 | 文件 | 覆盖 | 类型 |
|------|------|------|------|
| 仓储单测 | `tests/unit/backend/database/gateway-channel-filter.test.js`（新建） | ① 只回指定 Channel 行；② channels 含空值 → 回「空串 + 缺字段」行、不含空值 → 不回；③ 归一化（前后空格/大小写）口径与引擎一致；④ 空集 → `[]` | unit |
| 等价测试（终极安全网） | `scripts/integration/gateway-channel-filter-equivalence.js`（新建） | 代表性数据（覆盖 R1/R2-C3/R3.5/R5s2/R5s3 命中、多 Channel、空 Channel 行）灌网关表，「全表读」vs「过滤读」喂同一 `runReconciliation`，断言 modifiedRows/modifications/stats/unmatchedRows **逐字节相等** | integration |
| 网关只读不变量 | `tests/unit/main-process/reconciliation-orchestrator.test.js`（加 1 例） | run 前 `structuredClone` 快照 gwRows、run 后 `deepEqual`，证明全程未改写 → 删深拷安全 | unit |
| bank-deposit 门控谓词断言 | unit 或 integration（沿用 `scripts/integration/bank-statement-universal-import-routing.js` 镜像 handler 决策范式） | 构造「含/不含 refund-order-backfill 场景」两组 `dispatchScenarios`，断言谓词 true/false 且与 `bucketScenarios(...).r5s4.length>0` 一致（钉死同源，防分桶条件改了门控漏更新） | unit/integration |
| 既有回归 | `tests/unit/main-process/reconciliation-orchestrator-refund.test.js:212-233 / :135-164` | 空 bucket no-op `depositRows=[]` 安全；退款启用 + depositRows 传参回填正常 | unit（回归不改） |
| GUI 手测 | — | 见 §十二 P0-②③④ | manual |

---

## 八、需求 3：运行不阻塞（主进程异步 + 进度事件，不上 worker）

### 8.1 实现方案

- `bank-statement:run` handler（main.js:3644）改 `async`；数据准备 → R1-R5 各阶段边界插 `await new Promise(r => setImmediate(r))` 让出事件循环。
- `runReconciliation`（orchestrator.js:271）改 async / 注入 `onProgress`，**在轮次边界**插 yield + 进度上报，实际边界顺序为 **R1→R2(dispatcher)→R3.5→R4→R5**，其中 R5 内细分多子轮（s2@359 / s2b@404 / s3@423 / s4@448）须逐子轮边界各插一次；R2(dispatcher) 位于 R1 与 R3.5 之间（轮次顺序、引擎入参、数据逻辑零改动）。
- 进度转发仿 `createRunProgressForwarder`（main.js:12302）；新通道 `bank-statement:run:progress`；preload `bankStatement.onRunProgress`；renderer `runBankStatementInternal`（4101）订阅更新状态框（仿收单 `handleAcquiringBillCurrencyRun` 5340-5387）。
- **为什么不上 worker**：worker_threads 需序列化大数组跨线程（gwRows/bankRows 可达数百万行，结构化克隆成本反而高）+ 引擎大量原地改 bankRows 引用，worker 化需重构数据回传；主进程 async + setImmediate yield 让窗口可响应已足够消除「未响应」，配合需求6 削峰即根治。

### 8.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `main.js` | 3644 | handler 签名加 `async (event) =>`（取 event 供 forwarder）；阶段边界插 `await setImmediate` |
| `main.js` | 12302 旁 | 新增 `createBankStatementRunProgressForwarder(event)`（仿 12302，send `bank-statement:run:progress`，try/catch swallow） |
| `main.js` | 3644 handler 内 | `const onProgress = createBankStatementRunProgressForwarder(event)`；传入 `runReconciliation({ ..., onProgress })` |
| `orchestrator.js` | 271 `runReconciliation` | 签名加 `onProgress`；改 async；边界 `await yield + onProgress({ round, ... })`，实际边界 R1→R2(dispatcher)→R3.5→R4→R5（R5 子轮 s2@359 / s2b@404 / s3@423 / s4@448 各插一次） |
| `preload.js` | 178 `bankStatement` | 加 `onRunProgress(listener)`（仿 acquiring:377：`ipcRenderer.on('bank-statement:run:progress', wrapped)` + 返回 removeListener） |
| `renderer.js` | 4101 `runBankStatementInternal` | run 前订阅 onRunProgress 更新状态框、finally unsubscribe（仿 5340-5387） |

### 8.3 代码示例

main 侧 forwarder（仿 12302）：

```js
function createBankStatementRunProgressForwarder(event) {
  if (!event || !event.sender) return null;
  return (ev) => {
    try { event.sender.send('bank-statement:run:progress', { ...ev, phase: 'run' }); }
    catch (_e) { /* swallow — 窗口已销毁等 */ }
  };
}
```

orchestrator 轮次边界 yield（示意，每轮后）：

```js
async function runReconciliation({ bankRows, gwRows, scenarios, deps, refundContext, midAllocationContext, fundTransferReconContext, dispatchReconContext, onProgress } = {}) {
  const yieldTick = async (round) => {
    if (typeof onProgress === 'function') { try { onProgress({ round }); } catch (_e) {} }
    await new Promise((r) => setImmediate(r));
  };
  // ... R1 ...
  await yieldTick('R1');
  // ... R2 ...
  await yieldTick('R2');
  // ... R3.5 / R4 / R5s2 / R5s2b / R5s3 / R5s4 同理 ...
}
```

renderer 订阅（仿 5356-5361 + finally）：

```js
let unsubscribe = null;
const api = window.desktopApi && window.desktopApi.bankStatement;
if (api && typeof api.onRunProgress === 'function') {
  unsubscribe = api.onRunProgress((ev) => { updateStatusBox(elements.bankStatementStatusBox, formatRunProgress(ev), 'info'); });
}
try { const result = await window.desktopApi.bankStatement.run(); /* ... */ }
finally { if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_e) {} } }
```

### 8.4 注意事项

- 🔴 **结果字节一致**：需求3 只插 yield/进度，**绝不改轮次顺序/引擎入参/数据逻辑**；golden（bank-statement 主输出 + 命中明细 + 未命中 sheet）须字节不变。
- `processingResult` 仍在 run 全程完成后一次性赋值（main.js:3775），yield 期间不改写它；handler 入口 `bankStatementSession` 守卫不变，不引入新并发 run 入口。
- async 化后 handler 的 try/catch（3645/3802）须包住整个 await 链，失败仍 return `{status:'failed', message}`。
- `bankStatement.run()` 现无 payload，preload 调用处（preload.js:178 区段）不变；仅加 `onRunProgress` 订阅 API。
- 进度事件无节流（仿 createRunProgressForwarder 注释）；轮次仅 ~6 个事件，无抖动风险。

---

## 九、需求 4：未命中 sheet 提醒 A1 + 数据右移 B 列（🔴 输出口径）

### 9.1 实现方案

`exceljs-writer.js` `writeBankStatementOutput` sheet1「未命中场景」（行 236-256）：A1 提醒不变；表头第 2 行、数据第 3 行均从 B 列起（A 列除 A1 留空）。效果 = 仅右移列、行不变（最小改动）。

### 9.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `exceljs-writer.js` | 251 | `headers.forEach((h, idx) => { headerRow2.getCell(idx + 1)... })` → `getCell(idx + 2)` |
| `exceljs-writer.js` | 255 | `headers.forEach((h, colIdx) => { r.getCell(colIdx + 1)... })` → `getCell(colIdx + 2)` |

### 9.3 注意事项

- 范围**仅 sheet1**：sheet2「命中场景」首列是 `HIT_DETAIL_HEADER`（「命中明细」，行 263-264）已占 A 列、标黄 `colIdx+2`（291-296）不涉及，绝不改。
- A1 `SHEET1_A1_NOTICE`（行 239-241）+ 字体不变；排序逻辑（markFirst/others，243-247）不变。
- golden 回归更新（确认仅 sheet1 列右移）。

---

## 十、需求 5：BOC 调拨修复行 Type 改 1（🔴 资金红线）

### 10.1 实现方案

`boc-dispatch-order-fix.js:238` `Type: 2` → `Type: 1` + 同步注释。Type 落输出 Excel 给下游，src/ 内无按 `Type==2` 过滤逻辑（仅 override 注入网关命中行复制份）。

### 10.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `boc-dispatch-order-fix.js` | 238 | `Type: 2,` → `Type: 1,` + 行内注释 `number 2（D9...）` 改 `number 1` |
| `boc-dispatch-order-fix.js` | 5 / 20 | 头注释「Type=2 / D9」措辞同步为 Type=1 |
| 单测 / golden | — | 输出断言 `Type===1` |

### 10.3 注意事项

- 🔴 **须用户最终确认 Type=1 业务语义**（plan §需求5 标注「需用户最终确认」）；确认后再改单测断言 + golden。
- src/ 全局搜 `Type == 2` / `Type === 2` 确认无过滤依赖（plan 已核实「无按 Type==2 过滤逻辑」），改值不影响 src 内控制流，仅改输出给下游。

---

## 十一、需求 7：R5s3 两级 fallback + FundType 子串（spec B，🔴 资金红线，独立）

> spec 全文（含 D-1~D-3 / D-2~D-2c 伪代码）：`changes/r5s3-channelorderno-fallback-inbound-substring/spec.md`。唯一引擎改动 `r5-platform-inbound-cleanup.js` 三处。

### 11.1 现状基线（file:line）

- 引擎 `runRound5PlatformInboundCleanup(gwRows, bankRows, options)`；调用 orchestrator.js:421-431（R5 场景3，R4 之后，透传 `gwTradeType`/`excludeFundType`）。
- 建索引 `:72-79`：银行行**只**按 `ReconciliationId` 建单 Map（空键跳过）。
- 匹配循环 `:84-133`：逐网关行用 `gw.reconciliationid` 取候选；单候选直取（O-4），多候选按 Credit Amount 方向消歧（O-1：`parseNumber !== null && !== 0`）；0/≥2 条 Credit → `no-credit-match`/`multi-credit-match` 警告 + 跳过（仅警告不阻断）；严格 1v1 `usedBankRowId`。
- 触发条件 `:130`：`normalizeCellValue(bankRow.FundType) !== excludeFundType`（精确判等 `'Inbound'`）。
- 关键字段事实：银行 `BANK_STATEMENT_FIELDS` 同含 `ReconciliationId`(:21) + `ChannelOrderNo`(:22)；网关链接表只有 `reconciliationid`（小写）无独立渠道订单号 → fallback 两级都用 `gw.reconciliationid` 这一个值；`ChannelOrderNo` 不在 `CLEANUP_COPY_HEADERS`（漂移守卫单测不受影响）；`FundType` 12 枚举仅 `'Inbound'` 含 "Inbound" 子串（变更2 对现有数据零变化）。

### 11.2 改动 1 — 建双键索引（替换 `:72-79`）

```js
const bankByReconId = new Map();        // key = normalizeCellValue(bank.ReconciliationId)，空键跳过
const bankByChannelOrderNo = new Map(); // key = normalizeCellValue(bank.ChannelOrderNo)，空键跳过
for (const bank of safeBankRows) {
  const rk = normalizeCellValue(bank && bank.ReconciliationId);
  if (rk !== '') { if (!bankByReconId.has(rk)) bankByReconId.set(rk, []); bankByReconId.get(rk).push(bank); }
  const ck = normalizeCellValue(bank && bank.ChannelOrderNo);
  if (ck !== '') { if (!bankByChannelOrderNo.has(ck)) bankByChannelOrderNo.set(ck, []); bankByChannelOrderNo.get(ck).push(bank); }
}
```

桶 value 保持「bank 对象数组、按 bankRows 插入序」，不引入 ordOf。同一行两列都有值会同时进两桶，重复消费由 `usedBankRowId` 兜底。

### 11.3 改动 2 — 匹配循环抽 helper + 两级优先级（替换 `:84-133`）

把现有「单/多候选 + Credit 方向消歧」抽成 `pickFromCandidates(cand)`（不改任何 O-1/O-4 口径，返回 `{row}|{skip:'empty'}|{skip:'no-credit'}|{skip:'multi-credit'}`）；两级桶按严格优先级各调一次：

```js
function pickFromCandidates(cand) {
  if (cand.length === 0) return { skip: 'empty' };
  if (cand.length === 1) return { row: cand[0] };            // O-4 单候选维持现状
  const creditCand = cand.filter((b) => {
    const v = parseNumber(b['Credit Amount']);
    return v !== null && v !== 0;                            // O-1 口径不变
  });
  if (creditCand.length === 1) return { row: creditCand[0] };
  if (creditCand.length === 0) return { skip: 'no-credit' };
  return { skip: 'multi-credit' };
}

for (const gw of gwPool) {
  const key = normalizeCellValue(gw && gw.reconciliationid);
  if (key === '') continue;

  // ① 一级 ReconciliationId
  const candR = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
  const resR = pickFromCandidates(candR);

  let bankRow = null;
  if (resR.row) {
    bankRow = resR.row;
  } else if (resR.skip === 'empty') {
    // ② 仅「查无此行」才 fallback 到 ChannelOrderNo（D-1a）
    const candC = (bankByChannelOrderNo.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
    const resC = pickFromCandidates(candC);
    if (resC.row) { bankRow = resC.row; }
    else if (resC.skip === 'no-credit' || resC.skip === 'multi-credit') {
      pushDisambigWarning(resC.skip, key, candC, 'ChannelOrderNo'); continue; // D-1b 复用同名 code + 来源标记（全角「（按 ChannelOrderNo 匹配）」）
    } else { continue; } // 两级都 empty → 静默跳过（现状一致）
  } else {
    pushDisambigWarning(resR.skip, key, candR, 'ReconciliationId'); continue; // 一级消歧失败不 fallback（D-3）
  }

  usedBankRowId.add(bankRow._rowId); // 严格 1v1，跨两级共享（D-1c）
  // 触发条件见改动3
}
```

`pushDisambigWarning(skip, key, cand, via)` 封装现两条 warning，code = `no-credit-match`/`multi-credit-match`、severity `warning`、message 末按 `via==='ChannelOrderNo'` 追加**全角**「（按 ChannelOrderNo 匹配）」（实现 r5-platform-inbound-cleanup.js:127 用全角括号，统一中文文案风格；`via==='ReconciliationId'` 不加，保持原文案）。

**不重复消费不变量**：只有一级 `empty`（candR 过滤后 0 条）才走二级；二级 candC 也过滤 usedBankRowId。某行两列都=key 且未消费 → candR 必非空 → resR 不会 empty → 不进二级；已消费则二级 filter 也排除。

### 11.4 改动 3 — 触发条件子串判定（替换 `:130`）

```js
const ft = normalizeCellValue(bankRow.FundType).toLowerCase();
const ex = normalizeCellValue(excludeFundType).toLowerCase();
if (ex !== '' && ft.includes(ex)) {
  // FundType 含 excludeFundType 子串（大小写不敏感）→ 入金，不产剔除行（D-2/D-2a）
} else {
  cleanupRows.push(buildCleanupRow(gw, bankRow)); // 含 ex==='' 兜底全产（D-2c）
}
```

### 11.5 不动的部分

- `buildCleanupRow`（:34-47）一行不改（附言中文标点、加款单号取 `gw.orderid`、C~O 拷贝同名字段）。
- 配置 / migrations seed 不动（D-2b，`migrations.js:1544-1556` `excludeFundType:'Inbound'` 保持）；`migrations-recon-round-seed.test.js` 断言仍成立。
- 顶部注释（:4-7 / :50-53 / :128-129）措辞同步为「两级 fallback：ReconId 主、ChannelOrderNo 兜底」+「FundType 不含 excludeFundType 子串(大小写不敏感)才剔除」，bump 文件版本 tag → v3.0.8。

### 11.6 测试矩阵（改 3 + 新增 7）

fixture `bankRow(...)`（:40-63）加可选 `channelOrderNo` 入参（默认不写入/空），现有用例零回归。

**改 3：**
1. `:153-160`（FundType=Inbound 不产）——断言不变，文案改「含 Inbound 子串」。
2. `:162-172`（excludeFundType 可配化 'outbound'）——重写「包含」语义：`'outbound'` 含子串不产、`'Inbound'` 不含 `'outbound'` 子串则产、补 `'outbound-VA'` 含子串也不产。
3. `:373-389`（混合用例）——`'Inbound'` 那条仍不产，断言不变。

**新增 7：**
1. `FundType:'Inbound-VA'` 命中 → 0 条（变更2 核心：子串非等值）。
2. 大小写不敏感：`'inbound'`/`'INBOUND'` 命中 → 0 条；负向 `'outbound'` → 产（锁 D-2a）。
3. ReconId 不上、ChannelOrderNo 上 → 产 1 条 + 加款单号=gw.orderid（变更1 fallback 命中）。
4. 两级都不上 → 0 条且无警告（静默 empty）。
5. ChannelOrderNo 桶多候选方向消歧：ReconId 桶空 + ChannelOrderNo 桶 2 行(1 Credit 1 Debit) → 取 Credit 产 1 条；变体 2 行都 Credit → `multi-credit-match`（带 ChannelOrderNo 标记）+ 不产。
6. 1v1 跨两级不重复消费：两条 gw 同 key；一条 bank `ReconciliationId=key ∧ channelOrderNo=key` → 第一条 gw 一级消费、第二条 gw 二级捞不到 → 1 条（守 D-1c）。
7. 🔴 红线锁：一级消歧失败不 fallback —— ReconId 桶 2 行都 Credit(multi-credit) + 一条 `channelOrderNo=key` 干净行 → 仍 0 条 + `multi-credit-match`（证不退到 ChannelOrderNo，锁 D-3）。

回归（不改）：`reconciliation-orchestrator.test.js` 用该场景 seed，bank 行不带 ChannelOrderNo、走一级匹配，行为不变，跑一遍确认。

---

## 十七、需求 8：使用手册补全 + 全册去技术术语（第二轮追加，纯文档）

> 对应 PRD §5.8 / §6.8。文档侧需求，**零业务代码改动**。SOP 沉淀 `knowledge/user-guide-dejargon-playbook.md`。

### 17.1 实现方案

- **1.4 新增总览导航小节**：在 `docs/USER_GUIDE.md` 1.4 区域插入「中台订单数据处理」总览（4 个子场景一句话作用 + 何时用 + 指向各详解小节），与「资金性质校验」组并列点出，建立「这是一组同类场景」的用户认知；零术语。
- **全册去术语（ultracode workflow，3 步）**：
  1. **6 段并行只读审查**：USER_GUIDE 按大节（`##`）切 ~6 段，每段一个只读 agent 产出精确 `old→new` 替换对（`old` 取完整行 / 连续几行原文含足够上下文保证全文件唯一，可能多处出现的标 `uniqueRisk`），约 567 处。
  2. **单 agent 串行应用**：一个写者收全部替换对逐个 Edit，跨段同词统一译法，`uniqueRisk` / 多匹配补上下文或 `replace_all`、无法安全定位则跳过并报告，保 markdown 结构。**禁止多 agent 并行写同一文件**（会互相覆盖）。
  3. **grep 验证**：全册扫禁用词清零（排除保留清单 + 已配解释）；对比改前后 `##` / `###` 标题数（零丢失）、代码围栏数（偶数配对）、总行数（无大段丢失）。
- **1.6.1 加 46 列兼容说明**：与需求 9 用户侧体感对应。
- **为什么这样做**：读者是业务 / 财务非工程师，工程术语让人对不上软件操作；并行审查提速、串行应用防并发覆盖、grep + 标题 / 围栏数双校验防误删信息。

### 17.2 改动点

| 文件 | 位置 | 改动内容 |
|------|------|---------|
| `docs/USER_GUIDE.md` | 1.4（行 604+） | 新增「📦 中台订单数据处理总览」小节 |
| `docs/USER_GUIDE.md` | 全册 | 约 567 处术语 → 业务白话；保留软件界面名 / Excel 列名 / 渠道真值 + 配中文解释；历史 changelog 不洗 |
| `docs/USER_GUIDE.md` | 1.6.1 | 加银行对账单 46 列兼容用户白话说明 |
| `knowledge/user-guide-dejargon-playbook.md` | 新增 | 去术语 SOP（禁用词 / 保留 / 译法 / 流程 / 易错点） |

### 17.3 注意事项

- 🔴 **只去术语、不删功能信息**：替换措辞，不删功能说明 / 不改资金敏感口径（对账 / 退款 / 剔除 / 余额 / Type 章节信息完整、口径不被洗改变义）。
- **保留清单**：软件界面真实按钮 / 弹窗 / 场景名、Excel 真实列名（`Credit Amount` / `Remark-BU` / `Type` 等）、渠道数据真值（`ADM` / `BOC` / `Inbound-VA` / `FundType` 取值等）、给维护人员的真实命令（`sqlite3` / `jq` / settings-key，用括注隔离）——删了用户对不上屏幕 / 对不上数据。
- **统一译法**（全册一致，节选）：sheet→工作表；字段→列；FundType→资金性质；Channel→渠道；fallback→对不上时再用…兜一道；golden / 字节一致→和以前结果一样；raw_json→原始数据。
- **易错点**：FAQ 问题 ↔ 答案要一起改（别漏改问题行）；巨长行可顺带拆 bullet；审查 agent 只看自己段 → 给的 `old` 可能全局不唯一 → 应用阶段必须处理多匹配；team-lead 必须审 diff 兜底（标题数 / 围栏 / grep + 人眼抽查资金敏感章节）。
- **验证证据**：`##`=20（改前后一致）、`###`=135→136（仅 1.4 新增 +1）、代码围栏=26（偶数）。

---

## 十八、需求 9：银行对账单 44→46 列（第二轮追加，🔴 资金红线，spec B 风格）

> 对应 PRD §5.9 / §6.9。用户决策：识别 + 字段下拉可选 + BU 回填兼容导入忽略两列、**不落库**（不碰 `bank_bu_recon_bank_imports` 列结构）。

### 18.1 现状基线（file:line）

- `assets/银行对账单.xlsx`「渠道对账单」sheet：在 `'Transaction Description'` 后插入「合并单号」「合并状态」，44→46 列（旧版 44 列文件仍在用）。
- `src/constants/bank-statement-fields.js`：`BANK_STATEMENT_FIELDS` 银行对账单固定字段数组（识别 `expectedHeaders` + 字段下拉的单一来源）。
- `src/constants/table-signatures.js`：银行对账单 / 入金表两处 `expectedHeaders: [...BANK_STATEMENT_FIELDS]` 复用该数组（L1 锚点）；`signatureHeaders` 是 3-6 个指纹列（L2 模糊匹配）。
- `src/backend/bank-bu-recon-import/validator.js`：`buildHeaderValidator(expectedHeaders, label)` 原为严格校验（列数相等 + 逐列名相等）；`validateBankHeaders` / `validatePendingGuanliHeaders` 各调一次。
- `src/backend/bank-bu-recon-import/reader.js`：行映射原按固定列索引取值。
- `src/backend/bank-bu-recon-db/columns.js`：`BANK_HEADERS` 44 列、`bank_bu_recon_bank_imports` DB 列结构（落库口径）。

### 18.2 改动 1 — 字段定义 44→46 + 识别自动跟随 + 下拉自动跟随

- `bank-statement-fields.js`：`BANK_STATEMENT_FIELDS` 在 `'Transaction Description'`（:25）后插「合并单号」（:26）「合并状态」（:27），共 46。
- `preload.js:11`：暴露给渲染进程的 inline 副本逐项同步两列，**与 bank-statement-fields 逐列一致**（两处口径分叉会让渲染进程下拉与主进程不一致）。
- `table-signatures.js`：注释 44→46（:36 / :179）；`expectedHeaders: [...BANK_STATEMENT_FIELDS]`（银行对账单 :41 / 入金表 :188）**自动跟随**到 46；**`signatureHeaders` 指纹列保持不变**（`ReconciliationId` / `Credit Amount` / `Debit Amount` / `拆分信息` / `关联大账号`，均非新增两列）。
  - 🔴 **新旧文件均可识别的原理**：指纹列在新版 46 列与旧版 44 列文件里都存在（新增两列不在指纹里）→ L2 模糊匹配对两版都命中；L1 锚点 `expectedHeaders` 跟随到 46 不影响旧版命中（识别按指纹列 minScore，不要求列数全等）。
- 字段下拉复用 `BANK_STATEMENT_FIELDS` 全枚举 → 自动多出两个可选项。

### 18.3 改动 2 — BU 回填校验加 `allowSupersetColumns`（宽容超集）

`validator.js` `buildHeaderValidator` 加第三参 `options.allowSupersetColumns`（:24-25）：

```js
function buildHeaderValidator(expectedHeaders, templateLabel, options = {}) {
  const allowSupersetColumns = options.allowSupersetColumns === true;
  return function validate(actualHeaders) {
    // ...
    if (allowSupersetColumns) {
      // 宽容超集：模板列必须全部命中，且保持相对顺序（有序子序列），多余列忽略。
      const normalizedActual = actualHeaders.map(normalizeHeaderCell);
      let cursor = 0;            // 只前进游标，保证相对顺序
      const missing = [];
      let orderBroken = false;
      for (let i = 0; i < expectedHeaders.length; i++) {
        const expected = expectedHeaders[i];
        const foundAt = normalizedActual.indexOf(expected, cursor);
        if (foundAt === -1) {
          const earlierAt = normalizedActual.indexOf(expected);
          if (earlierAt === -1) missing.push(expected);
          else { orderBroken = true; missing.push(expected); }
        } else cursor = foundAt + 1;
      }
      if (missing.length > 0) return { ok:false, error: orderBroken ? '…顺序错乱或缺失…' : '…缺失模板列…', detailLines:[…] };
      return { ok: true };
    }
    // 严格模式（Pending 用）：列数必须相等 + 逐列名相等（行为完全不变、零回归）
    // …
  };
}
const validatePendingGuanliHeaders = buildHeaderValidator(PENDING_GUANLI_HEADERS, 'Pending 数据管理');                       // 严格
const validateBankHeaders = buildHeaderValidator(BANK_HEADERS, '银行对账单', { allowSupersetColumns: true });                // 宽容超集
```

- `allowSupersetColumns=false`（默认，**Pending 用**）：列数必须相等 + 逐列名相等 —— **行为完全不变、零回归**（🔴 Pending 不受波及）。
- `allowSupersetColumns=true`（**银行对账单用**）：不要求列数相等；要求模板列（`BANK_HEADERS` 44 列）每个都在文件表头出现、且是文件表头的**有序子序列**（按模板顺序游标只前进 `indexOf(expected, cursor)`，保持相对顺序、防乱序文件；找不到再全局 `indexOf` 判断是缺失还是错序）；多出的列（合并单号 / 合并状态）忽略。

### 18.4 改动 3 — BU 回填取值改按列名定位（防后移列错位）

`reader.js` `buildRowMapper`（:59-65）改为按列名 → 文件表头索引（`headerIndexMap`）定位取值，**不再按固定列索引**：

```js
function buildRowMapper(expectedHeaders, dbColumns, headerIndexMap) {
  return function mapRow(cells) {
    const obj = {};
    for (let i = 0; i < expectedHeaders.length; i++) {
      const colIndex = headerIndexMap.get(expectedHeaders[i]); // 按列名取该列在文件中的真实位置
      // validateHeaders 已保证每个模板列都命中；colIndex===undefined 兜底→''
      obj[dbColumns[i]] = normalizeCell(colIndex === undefined ? undefined : cells[colIndex]);
    }
    return obj;
  };
}
```

- 🔴 **为何必须按列名**：46 列文件在中间（`'Transaction Description'` 后）插了两列，若仍按固定索引取值，`Extra Information` / `Remark-BU` 等后移列会整体错位 —— **资金对账错列 = 红线事故**。按列名定位则两列插在哪都不影响其余列取值。
- 校验阶段（`validateBankHeaders` 宽容超集）已保证每个模板列都能在文件表头找到，故 `headerIndexMap.get(expected)` 必命中（兜底 `undefined→''` 仅防御）。

### 18.5 改动 4 — 不落库（columns.js 不动）

- `src/backend/bank-bu-recon-db/columns.js` 的 `BANK_HEADERS` **保持 44 列**（不含合并单号 / 合并状态）、`bank_bu_recon_bank_imports` DB 列结构不动。
- 取值阶段 `dbColumns` 仍是 44 列对应的 DB 列名 → 合并单号 / 合并状态即使在文件里读得到也不会被写入 DB。
- 🔴 **不落库不变量**：合并单号 / 合并状态不进 `bank_bu_recon_bank_imports`；旧版 44 列文件落库行为完全不变。

### 18.6 测试矩阵

| 测试 | 文件 | 覆盖 |
|------|------|------|
| 字段数 | `tests/unit/constants/bank-statement-fields.test.js`（改） | `BANK_STATEMENT_FIELDS` = 46 + 含「合并单号」「合并状态」+ 位于 `'Transaction Description'` 之后 |
| 宽容超集契约 | `tests/unit/backend/bank-bu-recon-import/validator.test.js`（改） | 银行：46 列文件通过 / 乱序失败（orderBroken）/ 缺模板列失败；Pending：严格（列数不等失败、逐列名校验）零回归 |
| 按列名映射 | `tests/unit/backend/bank-bu-recon-import/header-superset-mapping.test.js`（**新增**） | 46 列文件按列名取值不错位（后移列 `Remark-BU` 等取对）+ 忽略两列 + 不落库（DB 仍 44 列口径） |
| release-check | — | 全绿（lint + unit + integration + smoke） |

### 18.7 注意事项

- 🔴 **两处字段副本必须逐列一致**：`bank-statement-fields.js` 与 `preload.js:11` inline 副本任一漏同步 → 渲染进程下拉与主进程识别口径分叉。
- 🔴 **`signatureHeaders` 不能动**：指纹列若误加新增两列，旧版 44 列文件会因缺指纹列而识别不到（回归）。当前指纹列均为新旧两版共有列 → 安全。
- 🔴 **columns.js `BANK_HEADERS` 不能升到 46**：一旦升列就会落库，违反用户「不落库」决策、且改 DB 列结构 = 资金对账数据结构变更。
- Pending 路径全程走 `allowSupersetColumns=false`（默认）严格分支，本次改动对其零行为变化。

---

## 十二、资金红线汇总 + GUI 手测清单

### 12.1 资金红线护栏（必须人工复核 + 回归）

| 需求 | 红线点 | 护栏 |
|------|--------|------|
| 6 修复1 | bank-deposit 门控谓词 | 逐字镜像 orchestrator r5s4 条件 + 门控谓词断言钉死同源 |
| 6 修复2 | gateway 按 Channel 过滤（带不变量优化，非纯字节不变） | 仓储单测（含空/缺 Channel 边界）+ 全表 vs 过滤等价集成逐字节相等 + 网关只读不变量 |
| 3 | 改 orchestrator 控制流 | 只插 yield/进度，结果 golden 字节一致 |
| 4 | 改未命中 sheet 列布局 | golden 更新，确认仅 sheet1 |
| 5 | 改 BOC 修复行 Type 值 | 用户确认语义 + golden/单测更新 |
| 7 | fallback 误命中 / 触发方向写反 / 1v1 重复消费 | D-1a/D-1b/D-3 压误命中；新增用例 1/2 防方向反；用例 6/7 守 1v1 与不 fallback |
| 2 | 退役 C3 | **纯前端 UI 过滤**（`migrations.js` 零改动，引擎/数据/约束/seed 全保留），可回滚、零 migration 风险 |
| 9（第二轮） | 银行对账单 44→46 列 BU 回填兼容导入：①宽容超集校验须只放宽银行、不波及 Pending；②取值须按列名定位防后移列错位；③合并单号/合并状态不落库 | ①`allowSupersetColumns` 默认 false（Pending 严格零回归）；②`reader.js` 按列名 `headerIndexMap` 取值（防 `Extra Information`/`Remark-BU` 错位）；③`columns.js` `BANK_HEADERS` 保持 44 列不动；`signatureHeaders` 指纹列不变保新旧文件识别；validator/字段数/按列名映射三层单测 + release-check 全绿（详见 §十八） |
| BUG3（第二轮收尾） | `streaming-xlsx-reader.js` `V_CONTENT_RE` 读值正则修复 —— **该读取器被银行对账单导入复用**，修复后含首尾空格 / `xml:space` 列由「读空」改为读到真实值，对账 / 校验输入可能随之变化 | 改正则容忍 `<v>` 任意属性（裸 `<v>` 仍匹配、向后兼容，绝大多数无空格列不受影响）；**🔴 必须用真实银行对账单数据回归银行对账单导入读值**（见 §12.2 GUI 手测 ⑨）；工具箱合并/拆分输出 by-name 格式与现状 `writeWorkbookRows` 一致（单一真理来源 `writers.js applyExportFieldFormats`）+ 30 万行大文件流式不撞 OOM（详见 §12.5 / 本日志 2026-06-17 第二轮收尾） |

### 12.2 GUI 手测（IPC 自动化盲点，必补）

| # | 优先级 | 场景 |
|---|------|------|
| ① | P0 | 工具箱合表（多文件表头相同合并 + 表头不同 alert）/ 拆表（选字段 + 多选值 → 单文件）端到端 |
| ② | P0 | 准备大 bank-deposit 入金表 → 关退款场景 + 只留 BOSH-CN → 导入 → 「开始运行」**秒回不卡**、结果与修复前一致 |
| ③ | P0 | 启用退款场景 → 「开始运行」→ 退款回填仍正常命中 |
| ④ | P0 | 大网关账单表（多 Channel）→ 导入 BOSH 对账单 → 「开始运行」→ 对账结果（R1/R2 命中数、ReconciliationId 回填、unmatched）与修复前完全一致、峰值内存大幅下降；全程窗口可响应 + 进度更新 |
| ⑤ | P1 | 场景管理两组默认收纳 / 可展开 / **自带** C3 消失（BUG2：在 BOSH-CN 等渠道自建一个 C3 场景 → 自建 C3 仍可见可启停可管理、不被退役误删） |
| ⑥ | P1 | 未命中 sheet：A1 提醒 + 表头第 2 行 B 列起 + 数据第 3 行 B 列起 |
| ⑦ | P1 | BOC 修复行 Type=1（导出 Excel 核对） |
| ⑧ | P0 | R5s3 构造「网关 reconciliationid 只与银行 ChannelOrderNo 对得上」样例 → 导出 → 生成 `中台加款单剔除模板-*.xlsx` 且加款单号/附言/C~O 正确（资金红线，留样本） |
| ⑨ | P0 | **🔴 BUG3 资金红线**：用真实银行对账单数据回归**银行对账单导入读值**（`streaming-xlsx-reader.js V_CONTENT_RE` 修复后）—— 重点核对含首尾空格 / `xml:space` 的字符串列由「读空」改为读到真实值后，对账 / 校验输入与修复前一致、无非预期口径变化（绝大多数无空格列不受影响） |
| ⑩ | P0 | BUG3 工具箱合并 / 拆分**约 30 万行大文件**（.xlsx）→ 不再闪退 / 不再误报「文件为空」（超量改「文件过大」真实文案）；输出 by-name 格式与现状一致；合并合计 > 104 万行自动分 sheet (2)(3)；.csv 大文件回退路径正常 |

---

## 十三、N+2、任务分解

> 每 task 尽量小、可验证、可独立完成。按 plan W1~W6 风险/依赖排序。

| 序号 | 工作流 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|------|---------|---------|------|
| 0 | — | 切 v3.0.8 分支 + bump version 3.0.8 + `npm run scan:vars` | `package.json` | `git branch` / `npm run scan:vars` | todo |
| 1 | W1 | 需求5 BOC Type 2→1 + 注释 | `boc-dispatch-order-fix.js` | 单测 `Type===1` + golden | todo |
| 2 | W2 | 需求4 未命中 sheet 列右移 | `exceljs-writer.js` | golden（仅 sheet1）+ 单测 | todo |
| 3 | W3 | 需求7 双键索引（改动1） | `r5-platform-inbound-cleanup.js` | 单测改3+新增7 | todo |
| 4 | W3 | 需求7 helper + 两级优先级（改动2） | 同上 | 用例 3/4/5/6/7 | todo |
| 5 | W3 | 需求7 子串触发条件（改动3） | 同上 | 用例 1/2 | todo |
| 6 | W4 | 需求6 修复1 bank-deposit 门控 | `main.js:3682` | 门控谓词断言 + 回归 | todo |
| 7 | W4 | 需求6 修复2 新仓储 + facade | `linked-table-repository.js` / `database.js` | 仓储单测（空/缺 Channel/归一化/空集） | todo |
| 8 | W4 | 需求6 修复2 main.js 改过滤读（不深拷） | `main.js:3677` | 等价集成 + 网关只读不变量 | todo |
| 9 | W4 | 需求3 handler async + yield + forwarder | `main.js`（3644 / 12302 旁） | golden 字节一致 | todo |
| 10 | W4 | 需求3 orchestrator async + onProgress | `orchestrator.js:271` | 异步结果不变 + onProgress 顺序断言 | todo |
| 11 | W4 | 需求3 preload onRunProgress + renderer 订阅 | `preload.js` / `renderer.js:4101` | GUI 手测 ④ | todo |
| 12 | W5 | 需求1 main 3 IPC + file-service 复用 + 时间戳 helper | `main.js` / `preload.js` | 集成 `toolbox-roundtrip.js` | todo |
| 13 | W5 | 需求1 弹框 createToolboxDialog + createSplitFieldPickerDialog | `renderer-dialogs.js` / `renderer.js` / `index.html` | preview:toolbox + GUI 手测 ① | todo |
| 14 | W5 | 需求1 CSS + preview 入口（4 处） | `styles-gemini-extra.css` / `renderer-previews.js` / `package.json` | preview 截图 | todo |
| 15 | W6 | 需求2 退役 C3（**纯前端过滤**，migrations.js 不动） | `renderer-dialogs.js`（7045 filter） | 折叠/过滤/displayIndex 单测 + preview | done（9e67b56） |
| 16 | W6 | 需求2 分组折叠 + CSS | `renderer-dialogs.js` / `styles-gemini-extra.css` | preview（折叠态） | todo |
| 17 | — | 文档三件套 + PRD/TechDoc 实施记录 + spec 归档 | `CHANGELOG.md` / `VERSION_FEATURE_HISTORY.md` / `USER_GUIDE.md` / `changes/` | — | todo |
| 18 | — | `npm run release-check` 全绿 + `npm run check:vars` | — | PASS/FAIL 源 | todo |

---

## 十四、N+3、实施计划（Commit 粒度）

> 一 task 一 commit，message `[v3.0.8] <简述>`；W3/W4/W5 完成后 team-lead 自行 `git diff`+`release-check`+`/check-vars` 核实（不轻信 agent 汇报，`feedback_background_agent_unreliable`）。

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `[v3.0.8] BOC调拨修复行 Type 2→1（资金红线，用户确认语义）` | `boc-dispatch-order-fix.js` + 单测/golden | 5 |
| 2 | `[v3.0.8] 银行未命中 sheet 提醒留 A1、数据右移 B 列` | `exceljs-writer.js` + golden | 4 |
| 3 | `[v3.0.8] R5s3 ChannelOrderNo 两级 fallback + FundType 子串判定（改3新增7单测）` | `r5-platform-inbound-cleanup.js` + 单测 | 7 |
| 4 | `[v3.0.8] run 入口 bank-deposit 消费方门控（防整表无谓载入）` | `main.js:3682` + 门控断言 | 6 |
| 5 | `[v3.0.8] 网关账单表按 Channel 过滤读（业务不变量：对账同渠道；根治 300 万行尖峰）` | `linked-table-repository.js` / `database.js` / `main.js:3677` + 仓储单测/等价集成 | 6 |
| 6 | `[v3.0.8] 资金对账「开始运行」主进程异步 + 进度事件（不阻塞窗口）` | `main.js` / `orchestrator.js` / `preload.js` / `renderer.js` | 3 |
| 7 | `[v3.0.8] 工具箱🧰 合表/拆表（renderer↔preload↔main↔file-service 全链路 + 3 IPC）` | `index.html` / `renderer.js` / `renderer-dialogs.js` / `preload.js` / `main.js` / CSS / preview | 1 |
| 8 | `[v3.0.8] 场景管理 退役自带场景 C3（隐藏保留后端）+ 两组三角折叠默认收纳` | `renderer-dialogs.js` / `migrations.js` / CSS / preview | 2 |
| 9 | `[v3.0.8] 文档三件套 + 迭代 PRD/TechDoc 实施记录 + spec 归档` | docs / changes | 全 |

---

## 十五、N+4、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。

### 2026-06-16（TechDoc 定稿）

- 动作：读 plan + spec A/B + 关键源码（bank-statement:run 3644-3805、orchestrator runReconciliation 271-529、r5-platform-inbound-cleanup 全文、linked-table-repository readBankDepositAdmCandidates/readLinkedTableRows、exceljs-writer 未命中 sheet 230-300、boc-dispatch :238、preload/renderer 进度转发接缝 12302/5340、file-service readers/writers 签名），落 TechDoc。
- 证据：
  - 需求3+6 同 handler 确认：`main.js:3644` handler、`:3677` gwRows、`:3682` depositRows 同一函数体。
  - 需求6 谓词同源确认：orchestrator `bucketScenarios` r5s4 判断行 `:173`（:142 为函数头 JSDoc 注释）= builtin-fixed + platform-order + refund-order-backfill；r5s4 门控 `:443`。
  - 需求6 仓储范式确认：`readBankDepositAdmCandidates`（:940-956）json_extract 下推 + ORDER BY id ASC + 损坏行跳过；facade :1318。
  - 需求3 forwarder 范式确认：`createRunProgressForwarder`（:12302）+ acquiring:run async handler（:12470）+ renderer onRunProgress（:5356-5361）+ finally unsubscribe（:5382）。
  - 需求1 file-service 签名确认：`readRows` 返回 aoa（readers.js:148-156）、`extractHeaders` 返回 trim 表头数组（:364-381）、`writeWorkbookRows({rows,outputFilePath,sheetName},formatters)` 接 aoa（writers.js:223）。
  - 需求7 字段确认：R5 引擎现状（:72-79 单键 / :84-133 匹配 / :130 触发）；`buildCleanupRow`（:34-47）不改。
  - 需求4 确认：未命中 sheet1（236-256）vs 命中 sheet2（259-299）独立，仅 sheet1 右移。
- 风险：
  - 🔴🔴 需求3+6 同 handler 接缝最高危——必须先 6（稳定同步上下文精确行替换）后 3（整体 async）；分开各改会失配。
  - 🔴 需求6 修复2 是带不变量优化（非字节不变），三陷阱漏一即漏对账；等价测试是终极安全网。
  - 🔴 需求7 fallback 误命中——D-1a/D-3 边界与用例 7 是核心红线锁。
  - 🔴 需求5 Type 语义须用户最终确认后才动单测/golden。
  - main.js NUL 字节：编辑前 grep -an 定位避开（`reference_mainjs_nul_grep`）。
- 决策：
  - v3.0.8 沿用最新单主题约定：`docs/iterations/v3.0.8/` 裸文件名 PRD.md + TECHDOC.md（与 v3.0.4/v3.0.6 一致；v3.0.6 PRD 引用 TECHDOC 但实际无该文件，本迭代补齐）。
  - 工具箱 file-service 走 facade 复用（extractHeaders/readRows/writeWorkbookRows），不新建 reader/writer。

### 2026-06-16（实施完成 — 回填实施日志，PM Reverse Sync）

- **Commit 清单**（`git log 28dab32..HEAD`，7 条，逆序列出 / 倒序即实施顺序）：
  1. `4afd20f` `[v3.0.8] bump 3.0.8 + PRD/TechDoc + 纳入 2 份资金红线 spec（运行内存尖峰 / R5s3 规则）` —— 切分支 / bump version / 纳 spec A·B / scan:vars。
  2. `faf05b3` `[v3.0.8] 需求5 BOC 调拨修复行 Type 2→1`（W1）。
  3. `0d64d03` `[v3.0.8] 需求4 银行未命中 sheet 数据右移到 B 列`（W2）。
  4. `94a5170` `[v3.0.8] 需求7 R5s3 两级 fallback（ReconId 主+ChannelOrderNo 兜底）+ FundType 子串判定`（W3）。
  5. `fdf5635` `[v3.0.8] 需求6+3 开始运行卡顿根治：bank-deposit 消费方门控 + gateway 按 Channel 过滤读（删深拷）+ 资金对账异步化（轮次 yield + 进度事件，golden 字节不变）`（W4 合并工作流，先 6 后 3，单 commit）。
  6. `304c90a` `[v3.0.8] 需求1 工具箱🧰 合表/拆表（3 IPC + 工具箱/选字段弹框 + 端到端测试 + preview）`（W5；落地新增 `src/main-process/toolbox.js` 模块承载纯变换，handler 仅做 dialog+IO）。
  7. `9e67b56` `[v3.0.8] 需求2 场景管理：退役 C3（前端隐藏，后端保留可回滚）+ 资金性质校验/中台订单两组三角折叠默认收纳`（W6）。
- **实施期取舍 / 增强（spec 外，4 项）**：
  1. **C3 退役边界（OPEN-2）**：退役方式由本 TechDoc 草案「migrations 不 seed」改为**纯前端过滤**（renderer-dialogs.js:7045，`migrations.js` 零改动）。退役仅作用于场景管理列表展示 —— 新建场景下拉（renderer-dialogs.js:8005）+ `createScenarioConfigDialogC3()`（:238）仍可达，**用户仍能新建 C3**（已知取舍，本迭代不封新建入口）。决策原因：纯前端过滤更可回滚、零 migration 风险。
  2. **需求6 加 `json_valid` 守卫（防御性增强）**：`readGatewayBillRowsByChannels` 的 SQL 在 `json_extract` 求值前 `json_valid(raw_json) AND (...)` 短路（linked-table-repository.js:992-995），防单条坏 JSON 行的 `json_extract` 报错崩整轮对账 run。原 §6.3a 草案未含此守卫。
  3. **W6 displayIndex 序号红线修复**：分组折叠重排列表时序号列严格用 `scenario.displayIndex`（派发口径，renderer-dialogs.js:7071-7079，N3-1 红线），分组不串号；命中 `rules/important-variables.md` displayIndex 软约束。
  4. **R5s3 二级标记用全角括号**：需求7 二级（ChannelOrderNo）消歧警告 message 后缀用全角「（按 ChannelOrderNo 匹配）」（r5-platform-inbound-cleanup.js:127），与本 TechDoc §11.3 草案的半角不同，统一中文文案全角风格。
- **测试落地**：commit 9e67b56 新建 `tests/unit/renderer-dialogs-scenario-group-collapse.test.js`（182 行）；304c90a 新建 `tests/unit/main-process/toolbox.test.js` + `tests/unit/renderer-dialogs-toolbox.test.js` + `scripts/integration/toolbox-roundtrip.js`；fdf5635 新建 `tests/unit/backend/database/gateway-channel-filter.test.js` + `scripts/integration/gateway-channel-filter-equivalence.js`。

### 2026-06-17（第二轮追加：需求 8 手册去术语 + 需求 9 银行对账单 44→46 列 — 实施后 Reverse Sync 回填）

- **范围**：PR #77 合入 main 后第二轮迭代，分支 `v3.0.8-userguide-bank-2cols`（基于 main）。两需求代码 / 手册已实施完成、`release-check` 全绿、用户手测通过；本次为实施后回填 spec（PRD §5.8/§5.9·§6.8/§6.9·§12.4，TechDoc §二·§十七·§十八·§12.1）。
- **需求 8（文档）**：`docs/USER_GUIDE.md` 1.4 新增「中台订单数据处理」总览导航小节（行 604+）+ 全册约 567 处技术术语清理（6 段并行只读审查 → 单 agent 串行应用 → grep 验证）+ 1.6.1 加 46 列兼容说明；SOP 沉淀 `knowledge/user-guide-dejargon-playbook.md`。零业务代码改动。
- **需求 9（🔴 资金红线）**：`bank-statement-fields.js` `BANK_STATEMENT_FIELDS` 44→46（合并单号:26/合并状态:27 插在 'Transaction Description':25 后）+ `preload.js:11` inline 副本逐项同步；`table-signatures.js` 注释 44→46、`expectedHeaders` 复用自动跟随、`signatureHeaders` 指纹列不变（:36/:41/:44/:179/:188）；`validator.js` 加 `allowSupersetColumns`（:24-25/:39-78/:117，Pending :115 保持严格）；`reader.js` 改按列名 `headerIndexMap` 取值（:37-40/:59-65）；`columns.js` `BANK_HEADERS` 保持 44 列**不动**=不落库。
- **证据**：当前分支工作树 `git diff --stat HEAD` 实测改动文件 = `docs/USER_GUIDE.md`（~2331 行）/ `src/constants/{bank-statement-fields,table-signatures}.js` / `src/preload.js` / `src/backend/bank-bu-recon-import/{validator,reader}.js` / `tests/unit/constants/bank-statement-fields.test.js`（改）/ `tests/unit/backend/bank-bu-recon-import/validator.test.js`（改）/ `tests/unit/backend/bank-bu-recon-import/header-superset-mapping.test.js`（新增，untracked）；`src/backend/bank-bu-recon-db/columns.js` **不在改动清单**（= 不落库已落实）；USER_GUIDE `##`=20 / `###`=136 / 代码围栏=26（偶数）。
- **风险**：
  - 🔴 需求 9 宽容超集只放宽银行（`allowSupersetColumns:true`）、Pending 默认严格零回归 —— validator.test.js 双向覆盖。
  - 🔴 需求 9 取值按列名定位是核心红线（防后移列 `Extra Information`/`Remark-BU` 错位 = 资金对账错列）—— header-superset-mapping.test.js 守护。
  - 🔴 需求 9 `columns.js` 不升列 = 不落库 / 不改 DB 结构；`signatureHeaders` 不动 = 新旧文件均识别。
  - 需求 8 资金敏感章节去术语须只改措辞不改口径 —— team-lead 审 diff + 人眼抽查兜底。
- **决策**：需求 9 按用户拍板「识别 + 字段下拉可选 + BU 回填兼容导入忽略两列、不落库」实现，未碰 `bank_bu_recon_bank_imports` 数据库结构；需求 8 历史 changelog 不洗（用户拍板，仅洗正文）。

### 2026-06-17（第二轮收尾：BUG2 自建 C3 / BUG3 工具箱大文件流式 / 工具箱弹窗尺寸 — 实施后 Reverse Sync 回填）

- **范围**：与需求 8/9 同属第二轮（分支 `v3.0.8-userguide-bank-2cols`）。三项均已实施完成、`release-check` 全绿（unit **3040/3040** + 34 集成脚本 + smoke 全模块 PASS）、用户手测 BUG2/BUG3 通过；本次为实施后回填 spec（PRD §12.5，TechDoc 本日志 + §12.1 资金红线汇总新增一行）。版本号并入 3.0.8 不 bump。
- **BUG2（场景管理自建 C3 误消失，🟢 体验回归）**：`renderer-dialogs.js:7051` 退役过滤由一刀切 `s.category!=='gateway-recon-join'` 收窄为 `!(s.category === 'gateway-recon-join' && s.isBuiltin)` —— 只隐藏自带 C3（`isBuiltin=true`）、保留用户自建 C3 可见可管理。运行口径 `hasC3Enabled` **未动**；后端 C3 引擎 / dispatcher case / CHECK 约束 / 已有库记录全保留。是 §12.2① OPEN-2「退役只针对自带 C3」边界的精确落实（原实现误伤自建 C3）。
- **BUG3（工具箱合并/拆分 30 万行 OOM 闪退 / 误报「文件为空」，🔴 涉资金红线复用文件）**：
  - 新增 `src/main-process/toolbox-stream-io.js`——读侧 `.xlsx` 复用自研 `readXlsxStreamed`（内存恒定，:117）、`.csv`/`.xls` 回退全量 `readRows`（:124）；写侧 `ExcelJS.stream.xlsx.WorkbookWriter` 逐行 `addRow().commit()`（:322），决策① by-name 格式输出与 `writeWorkbookRows` 完全一致（与 `writers.js applyExportFieldFormats` 同源），决策② 超 `MAX_DATA_ROWS_PER_SHEET=1048575`（:55）自动开 sub-sheet (2)(3)（照搬 `acquiring-bill-currency-writer.js`）。
  - `main.js` 三 IPC（`toolbox:merge`:12860 / `toolbox:split:read`:12908 / `toolbox:split:export`:12929）改走流式（handler 仅 dialog + IO，纯变换委托模块）。
  - `readers.js` 新增 `isMemoryError`（:158-164）+ 内存类错误回「文件过大」真实文案（:144-154），不再统一吞成「文件为空或不可读」。
  - 🔴 **顺带修 `src/backend/pending-import/streaming-xlsx-reader.js` `V_CONTENT_RE`**（:58，注释 :54-57）：`/<v>...<\/v>/` → `/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/`，修复「`<v>` 带 `xml:space="preserve"` 的含首尾空格字符串单元格被旧裸标签正则漏匹配 → 隐性丢值（读空）」（裸 `<v>` 仍匹配，向后兼容）。
- **工具箱弹窗尺寸微调（🟢 纯样式）**：`styles-gemini-extra.css` `.toolbox-card width` 230→`min(94vw, 246px)`（左右各 +8，:3287）+ `.toolbox-body padding-bottom` 12→27（:3298）+ `.toolbox-card transform: translateY(7.5px)`（:3291）—— 口径 B：上沿不动、下沿净 +15、卡片高净 +15。preview 回归。
- **风险**：
  - 🔴🔴 **BUG3 `V_CONTENT_RE` 修复是资金红线**：该读取器被**银行对账单导入复用**（Pending / BU 回填等大文件流式读路径）→ 修复后此前被读空的「含首尾空格 / `xml:space`」列会读到真实值，对账 / 校验输入可能随之变化（绝大多数列无首尾空格、不受影响）。**必须用真实银行对账单数据回归银行对账单导入读值**——见 §12.1 资金红线汇总新增行。
  - 🔴 BUG3 流式写须 by-name 格式与现状 `writeWorkbookRows` 一致（单一真理来源 `writers.js applyExportFieldFormats`）—— 任一格式分组分叉会让工具箱输出与主链路不一致。
  - BUG2 仅改前端列表过滤误伤面，不碰 migration / 引擎 / 运行口径（`hasC3Enabled` 未动）—— 零资金口径影响。
  - main.js NUL 字节：编辑前 grep -an 定位避开（`reference_mainjs_nul_grep`）。
- **决策**：BUG2 退役收窄为「只隐藏自带 C3」（按用户拍板保留自建 C3）；BUG3 流式读写沿用 `readXlsxStreamed` + `WorkbookWriter` 既有范式（不引入新依赖），输出 by-name 格式与现状一致（决策①），超单页上限自动分 sheet（决策②）；`V_CONTENT_RE` 容忍属性而非改读取主流程（最小改动、向后兼容裸 `<v>`）。

### 可沉淀知识

- [ ] 需求3+6 同 handler 协同顺序「先减载入后异步化」可沉淀为 `knowledge/`「同函数体多需求实施顺序」经验（稳定同步上下文先做精确行替换，再做整体控制流重构）。
- [ ] gateway 按 Channel 过滤读「业务不变量优化 + 等价测试 + 只读不变量」三件套是「带行为变更优化」的标准护栏范式（继 v3.0.0 ADM Channel 下推之后第二例）。
- [x] 手册去技术术语 SOP 已沉淀 `knowledge/user-guide-dejargon-playbook.md`（核心原则 / 禁用词清单 / 保留清单 / 统一译法表 / ultracode 6 段并行审查→串行应用→grep 验证流程 / 易错点）。
- [ ] 固定列模板「中间插列」兼容套路：识别端 `signatureHeaders` 指纹列保持不变（新旧均识别）+ 校验端宽容超集（有序子序列、多余列忽略）+ 取值端按列名定位（防后移列错位）+ 落库端 `columns.js` 不动（不落库）—— 可沉淀为「Excel 模板加列向后兼容且不落库」标准做法。

---

## 十六、N+5、Open Technical Questions

| # | 问题 | 处理 |
|---|------|------|
| OPEN-1 | 需求5 BOC 修复行 Type=1 的下游业务语义 | 🔴 **须用户最终确认**（plan 明确标注）；确认前不改单测断言/golden |
| OPEN-2 | 需求2 退役 C3 后：①老库中手动 enabled=1 的 C3 是否需强制禁用；②新建场景下拉仍可建 C3 是否需封 | **实施期取舍（已落地）**：本迭代退役收窄为「纯前端列表过滤」（`migrations.js` 零改动，新库照常 seed C3）；①老库已开启的运行时仍生效（dispatcher case 保留）；②新建场景下拉（renderer-dialogs.js:8005）+ `createScenarioConfigDialogC3()`（:238）仍可达，用户仍能新建 C3。即本迭代仅退役「列表展示」，不封「新建入口」/不强制禁用。如需更强收纳可后续讨论，不在本迭代范围 |
| OPEN-3 | 需求1 工具箱合表的文件格式：是否支持 csv 与 xlsx 混合合并 | `readRows`/`extractHeaders` 底层支持 xlsx/csv；合表表头相同校验对两者统一适用；实施时确认 `showOpenDialog` filters 包含 csv，混合时以首文件格式输出 xlsx |
| OPEN-4 | 需求3 进度事件文案粒度（轮次名 vs 百分比） | 轮次边界上报 `{round}`，renderer 展示「正在处理 R1/R2/...」；不做百分比（轮次内无细粒度进度）。实施时定文案 |

# TechDoc - 网银账单小助手 v3.0.0

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.0 |
| 日期 | 2026-06-08 |
| 作者 | Dev |
| 状态 | 初稿 |
| 关联 PRD | `docs/iterations/v3.0.0/PRD-v3.0.0.md`（37 条 AC） |
| 依赖 | 已合并 PR#65（基线 `cf7edec`）；分支从 `main`（含 v2.1.16-beta.6） |
| 原则 | **最大化复用现成、最小化改动**——需求 1 复用 `channel-enum-repository` 拼接口径、需求 2b/3 复用 `createConfirmDialog` + `getLinkedTableMeta`、块 B 复用 `readXlsxStreamed` + `replaceLinkedTable` 事务骨架 |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 状态框前缀 | 可行。`channel-enum-repository.js:54 recordFromBankStatementRows` 已有 `Channel-地区` 拼接口径，抽纯函数 `extractChannelRegionCombos(rows)` 即可复用；session-status 增字段是增量。 |
| §5.2 去框 + issues 并入状态框 | 可行。难点在"去框丢副作用"（退款触发要迁移）+ 纯失败批次分支 + 清除时机，已在改动点逐条覆盖。 |
| §5.3 C3 改向链接表 | 可行且安全。`gatewayReconSession` 经 B 调查确认为死路径（无引擎消费），改判据不误伤 C3 对账（仍用链接表）。新 IPC 仿 `linked-table:list`，复用 `getLinkedTableMeta`。 |
| §5.4 退款对齐 + 预检 + 运行点编排 | 可行。`createConfirmDialog` 三按钮现成；运行点链式编排抽 `proceedToGwCheck` 解决"退款 vs C3 互不吞"；PR#65 收紧 `refundOrderSession` 生命周期让 `hasRefundOrder` 判就绪可靠。 |
| §5.5 块 B 流式导入 | 可行但风险最高。`readXlsxStreamed` 实测 12.4s/385MB 读出 65.7 万行；`replaceLinkedTable` 已逐行 INSERT。**但值口径一致性（R-1）是硬前提，且 ADM 派生次生 OOM（R-3）须先解**。建议独立 PR 组、先过 OPEN。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | 🔴 块 B 值口径：流式 `parseCellBody` 与 SheetJS 逐格必须一致（日期序列号 vs 字符串、数字精度、前导零、空格、合并单元格）。实测样本看似一致但需系统比对。 | 中等链接表 SheetJS↔流式逐格 diff 入单测（块 B OPEN O-2）；**实施硬前提**，见 §七测试矩阵。 |
| R-2 | 🔴 块 B 整表覆盖原子性：`replaceLinkedTable` 先 DELETE 全表，流式落库中途失败 → 半表损坏。 | 全程单事务，失败整体回滚（块 B OPEN O-4 确认 65 万行单事务可行性）。 |
| R-3 | 🔴 块 B ADM 次生 OOM：PR#65 后 `main.js:11244-11259` bank-deposit **或** mid-allocation 任一变更都触发 ADM 全量重建（两表全量读回内存 + `buildAdmRows`）。块 B 流式落库后，两条路径都会触发 → 又一处 OOM。 | 块 B OPEN O-3 单列评估（buildAdmRows 流式化/分批 或 另案）；O-3 须覆盖 mid-allocation 入口（原 spec 只标 bank-deposit）。 |
| R-4 | 🔴 C3/退款"就绪"判据写反 = 静默漏对账（最高危逻辑风险）。 | gateway-bill / 退款判据严格 `>0` / `!==null`；IPC 异常按"未就绪"保守处理。grep 断言 + 手测矩阵双覆盖。 |
| R-5 | 需求 2a 去框丢副作用：退款优先互斥触发在原明细框 onConfirm 里（renderer.js:3576-3577）。 | 迁移到 `handleBankStatementBatchImport` 成功路径末尾（状态框刷新后再弹）。 |
| R-6 | 换行陷阱：`updateStatusBox`（renderer.js:584）对全角「：」自动换行。 | 需求 1 前缀用半角 `:`、组合间用 `、`；`renderer-status-box-text.test.js` 护栏。 |
| R-7 | Runtime-state 红线：`bankStatementSession`/`gatewayReconSession`/`refundOrderSession` 在 `important-variables.md`（refundOrderSession 待升格）。 | 本迭代只读不改其写入/清空时机；每个 PR 提交前跑 `/check-vars`。 |

### 1.3 与 PRD 的差异

- **退款提醒现状**：PRD §三已据实标注——`maybePromptRefundOrderImport`（renderer.js:3611-3614）现为 `createAlertDialog` 单按钮（带 `{ logLevel:'info', skipLogReport:true }`），需求 3 将其改为 `createConfirmDialog`。与 plan 描述一致，无实现差异。
- 其余无差异。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 | 需求 |
|------|---------|------|------|
| `src/backend/database/channel-enum-repository.js` | 修改 | 抽纯函数 `extractChannelRegionCombos(rows)`（复用现拼接口径 + 去重 + sort） | 1 |
| `src/backend/database.js` | 修改 | facade 透传 `extractChannelRegionCombos` | 1 |
| `src/main.js` | 修改 | ⚠️NUL（grep 加 `-a`）：session-status 增 `bankStatementChannelRegions` / `hasRefundOrder`；新 IPC `linked-table:row-count` / `bank-statement:refund-candidate-count`；抽 `countRefundBankCandidates`；块 B 落库链路流式化 | 1/2b/3/B |
| `src/preload.js` | 修改 | 暴露 `linkedTable.rowCount(key)` / `bankStatement.refundCandidateCount()` | 2b/3 |
| `src/renderer.js` | 修改 | 需求 1 拼前缀；2a 去框+issues+迁移副作用；2b 判据改向+文案+onConfirm；3 退款改框+预检+运行点编排+抽 `proceedToGwCheck` | 1/2a/2b/3 |
| `src/main-process/table-type-detector.js` | 修改 | 块 B：表头识别改流式（前 N 行终止） | B |
| `src/backend/database/linked-table-repository.js` | 修改 | 块 B：新增 `replaceLinkedTableStreaming`（或重构 `replaceLinkedTable` 抽事务骨架） | B |
| `src/backend/file-service/readers.js` | 修改（可能） | 块 B：流式读变体 | B |
| `src/backend/pending-import/streaming-xlsx-reader.js` | 修改（可能） | 块 B：多 sheet / 提前终止支持 | B |
| `src/renderer-dialogs.js` | **不改** | 复用 `createConfirmDialog`（:341，已支持 middleText 三按钮） | 2b/3 |
| `src/styles.css` | 修改 | PR-5：`.alert-card` 加 flex column + `max-height`；`.alert-message` 加 `overflow-y:auto` + `min-height:0`；`.dialog-actions` 加 `flex-shrink:0`（全局弹框有界滚动 + 固定按钮） | PR-5 |
| `src/backend/database/migrations.js` | 修改 | 块 B 前置（spec①）：`ensureLinkedTableSupport` 内 `linked_mid_allocation` 建表前加幂等 `RENAME COLUMN business_date TO transaction_date` 防御迁移 | B |
| `src/styles.css` | 修改 | PR-7（块 D）：`.scenarios-table` 各列宽百分比重算（勾选列百分比化 + 其余列按 97/100 补偿，含勾选列时总和=100%） | 块 D |
| `src/renderer-dialogs.js` | 修改 | PR-7（块 D）：勾选列 th/td 内联 `width:32px`→百分比（`:6468`/`:6560`）；方案 A 静态补偿时其余列 th 内联宽度（`:6422-6430`）同步 | 块 D |
| `src/styles-gemini-extra.css` | 修改 | PR-7（块 D）：删除重复且取值冲突的 `.scenarios-col-name`（`:2251` `30.94% !important` / `:2265` `27.96%`），统一为单一值 | 块 D |
| `tests/unit/**` | 新增 | `extractChannelRegionCombos` / `buildImportIssuesSummary` / `countRefundBankCandidates` 单测 + 块 B 值口径 diff + 块 B 前置迁移幂等单测 + grep 断言 | 全 |

---

## 三、需求 1：状态框「渠道-地区」前缀

### 3.1 实现方案

main 端从 `bankStatementSession.rows` 提取唯一 `Channel-地区` 组合 → session-status IPC 透传 → 前端拼前缀。复用 `channel-enum-repository.js:54 recordFromBankStatementRows` 的拼接口径（Channel 空跳过；地区空只产出 `Channel`），抽成纯函数便于复用 + 单测。

**为什么不用其他方案**：不在前端拼组合（前端无完整 rows、合并语义在 main 侧）；不新建 IPC（session-status 已是状态出口，增字段最省）。

### 3.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `channel-enum-repository.js` | :54 附近 | 抽 `extractChannelRegionCombos(rows): string[]`（去重 + `sort()` 稳定序；Channel 空跳过；地区空只产出 `Channel`） |
| `database.js` | facade | 透传 `extractChannelRegionCombos` |
| `main.js` | :3839（session-status） | 增 `bankStatementChannelRegions: bankStatementSession ? database.extractChannelRegionCombos(bankStatementSession.rows) : []` |
| `renderer.js` | :3333-3339（state 接收） | state 接 `channelRegions` |
| `renderer.js` | :3398-3400（拼前缀） | 0 个→无前缀兜底原文案；1 个→`CITI-HK:`；多个→`CITI-HK、JPM-US:`（半角 `:`、顿号 `、`） |

### 3.3 代码示例

```javascript
// channel-enum-repository.js — 纯函数（复用现拼接口径）
function extractChannelRegionCombos(rows) {
  const set = new Set();
  for (const r of rows || []) {
    const channel = normalizeCell(r['Channel']);     // 第 15 列
    if (!channel) continue;                            // Channel 空跳过
    const region = normalizeCell(r['地区']);           // 第 16 列
    set.add(region ? `${channel}-${region}` : channel); // 地区空只产出 Channel
  }
  return Array.from(set).sort();                       // 去重 + 稳定序
}

// renderer.js — 拼前缀（半角冒号避开 updateStatusBox 全角换行）
const combos = state.channelRegions || [];
const prefix = combos.length === 0 ? '' : `${combos.join('、')}:`;
text = fileCount > 1
  ? `已导入：${prefix}${bs.sourceFileCount} 个文件合并（${bs.rowCount} 行）`
  : `已导入：${prefix}${bs.fileName}（${bs.rowCount} 行）`;
```

### 3.4 注意事项

- 🔴 **半角冒号**：前缀分隔用半角 `:`，组合间用顿号 `、`，避开 `updateStatusBox`（renderer.js:584）对全角「：」的自动换行。`renderer-status-box-text.test.js` 护栏须通过。
- 复用 `normalizeCell`（`file-service/common.js`，Important-skeleton 数据清洗基础设施）保持口径一致。
- 多文件合并：rows 是合并全集，组合天然按全集去重。

---

## 四、需求 2a：去明细框 + 失败信息并入状态框

### 4.1 实现方案

删 `handleBankStatementBatchImport` 成功后的明细确认框；抽纯函数 `buildImportIssuesSummary(results)` → **纯文本**（状态框是 `textContent`，不能 HTML），存独立 state `state.bankStatementImportIssues`；`updateBankStatementUi` 主文案后追加摘要。原明细框 onConfirm 的退款触发副作用迁移到成功路径末尾。

**为什么不用其他方案**：不保留明细框（与状态框信息重合，正是要去掉的）；不把 issues 塞回 HTML 弹框（状态框常驻、信息不丢更优）。

### 4.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `renderer.js` | :3570-3580 | **删** `createAlertDialog(buildBatchImportSummaryHtml(...))` 调用 |
| `renderer.js` | :3576-3577 → :3534 末尾 | 退款优先互斥触发**迁移**到 `handleBankStatementBatchImport` 成功路径末尾（状态框刷新后） |
| `renderer.js` | 新增纯函数 | `buildImportIssuesSummary(results)` → 纯文本「跳过 N 个：…／失败 N 个：…」 |
| `renderer.js` | 新增 state | `state.bankStatementImportIssues` |
| `renderer.js` | :3364（updateBankStatementUi） | 主文案后追加 issues；`failed.length>0` 时 tone 升 `error` |
| `renderer.js` | :3555 附近 | 🔴 纯失败批次（无 bank ok）新增分支：也调 `updateBankStatementUi()` 渲染 issues（不改 mode/不清 export） |
| `renderer.js` | 开头 + run/export/导网关成功路径 | 清旧 issues（进入新动作置 `null`） |

### 4.3 代码示例

```javascript
// 纯函数（可单测）
function buildImportIssuesSummary(results) {
  const skipped = (results || []).filter(r => r.status === 'skipped' || r.status === 'disabled');
  const failed  = (results || []).filter(r => r.status === 'invalid' || r.status === 'failed');
  const parts = [];
  if (skipped.length) parts.push(`跳过 ${skipped.length} 个：${skipped.map(r => r.fileName).join('、')}`);
  if (failed.length)  parts.push(`失败 ${failed.length} 个：${failed.map(r => r.fileName).join('、')}`);
  return { text: parts.join('\n'), hasFailed: failed.length > 0 };
}
```

### 4.4 注意事项

- 🔴 **去框丢副作用**（R-5）：退款触发必须迁移，否则去框后退款提醒永不弹。
- 🔴 **纯失败批次**：现 :3555 才刷状态框，去框后无 bank ok 的批次也要渲染 issues（但不改 mode、不清 export，因为没有有效数据）。
- `buildBatchImportSummaryHtml` 删调用后变 dead code，本迭代**保留**（避免牵连）；`escapeHtml` 保留（多处用）。
- issues 用纯文本（`\n` 分隔），靠 CSS `.status-box-text { white-space: pre-wrap; }` 换行。

---

## 五、需求 2b：C3 提醒改向链接表网关对账单

### 5.1 实现方案

把两处提醒（`maybePromptGatewayReconImport` / `shouldPromptGatewayReconAtRun`）的「数据就绪判据」从 `gatewayReconSession` 改向链接表 `gateway-bill rowCount`；"导入文件"onConfirm 改调 `linkedTable.import()`。新 IPC `linked-table:row-count` 复用 `getLinkedTableMeta('gateway-bill').rowCount`（单行 meta 不读全表）。

**为什么不用其他方案**：不读全表（65 万行场景读盘）；不删死链（`gatewayReconSession`/`gateway-recon:import`）——避免一次动太多 Runtime-state（O-2(a)）；C3 框结构不动（复用 createConfirmDialog）。

### 5.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `main.js` | 仿 :11139（linked-table:list） | 新 IPC `linked-table:row-count`，调 `database.getLinkedTableMeta(key).rowCount`（异常返回 `{status:'failed'}`） |
| `preload.js` | :382（linkedTable） | 暴露 `rowCount: (key) => ipcRenderer.invoke('linked-table:row-count', key)` |
| `renderer.js` | :3589（maybePromptGatewayReconImport） | 判据 `if (state.gatewayReconSession) return` → 查 `gateway-bill rowCount>0 则 return`；文案改"请在链接表管理导入网关对账单"；onConfirm 改 `linkedTable.import()` |
| `renderer.js` | :3712（shouldPromptGatewayReconAtRun） | 同上判据改向；`c3CandidateCount` 预检保留 |
| `renderer.js` | :3683-3702（运行点 C3 框，2b 改造后纳入 `proceedToGwCheck`） | 文案改向；"导入文件"onConfirm 改 `linkedTable.import()`；三选一保留 |

### 5.3 代码示例

```javascript
// 新判据（严格 >0；IPC 异常按"未就绪"保守处理）
async function isGatewayBillReady() {
  try {
    const r = await window.desktopApi.linkedTable.rowCount('gateway-bill');
    return !!(r && r.status === 'ok' && r.rowCount > 0);  // 严格 >0
  } catch (e) {
    console.warn('gateway-bill rowCount failed:', e);
    return false;  // 🔴 异常按"未就绪"→ 仍提醒（保守防漏对账）
  }
}

// maybePromptGatewayReconImport 改造（节选）
if (!hasC3Enabled) return;
if (await isGatewayBillReady()) return;          // 链接表有数据→不提醒（替代 gatewayReconSession 门控）
const cc = await window.desktopApi.bankStatement.c3CandidateCount();
if (!cc || cc.status !== 'ok' || !(cc.candidateCount > 0)) return;  // 预检保留
openModal(createConfirmDialog({
  message: '已启用「资金对账不平」类场景，C3 需要网关对账单。<br>请在「链接表管理」导入网关对账单。',
  confirmText: '导入文件',
  cancelText: '稍后再说',
  onConfirm: async () => { closeModal(); await window.desktopApi.linkedTable.import(); }  // 改调链接表导入
}));
```

### 5.4 注意事项

- 🔴 判据**严格 `>0`**（R-4）：链接表空才提醒；IPC 异常按"未就绪"。判据写反 = 静默漏对账。
- `c3CandidateCount`（main.js:3856）保留——判的是"本批银行数据有无 C3 候选行"，与网关数据源无关。
- `gatewayReconSession` / `gateway-recon:import` 死链**不删**（O-2(a)）。
- `linkedTable.import()` 返回结果是否需在调用方反馈/刷新状态框 —— 待 Dev 确认（PRD §十待澄清）。

---

## 六、需求 3：退款提醒对齐 C3 + 候选预检 + 运行点编排

### 6.1 实现方案

- 退款候选预检：抽 `countRefundBankCandidates(rows)` = 数 `normalizeCellValue(FundType)==='Ach Return'`；新 IPC `bank-statement:refund-candidate-count`（仿 c3-candidate-count）。
- 导入后提醒：`createAlertDialog` → `createConfirmDialog`（导入文件/稍后再说）；加预检门控；"导入文件"→ `handleBankStatementBatchImport()`。
- 运行点提醒：新 `shouldPromptRefundAtRun()`（仿 `shouldPromptGatewayReconAtRun`）；就绪信号 = `refundOrderSession`（经 session-status 新增 `hasRefundOrder` 透出）。
- 运行点编排：改 `handleBankStatementRun`，抽 `proceedToGwCheck`，退款先于 C3 但互不吞。

**为什么不用其他方案**：不在前端数候选（前端无完整 rows）；编排不内联（抽 `proceedToGwCheck` 让"退款直接运行→继续查 C3"清晰）。

### 6.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `main.js` | 仿 :3856 | 新 IPC `bank-statement:refund-candidate-count`；抽 `countRefundBankCandidates(rows)` |
| `main.js` | :3839（session-status） | 增 `hasRefundOrder: refundOrderSession !== null` |
| `preload.js` | bankStatement | 暴露 `refundCandidateCount: () => ipcRenderer.invoke('bank-statement:refund-candidate-count')` |
| `renderer.js` | state | 接 `hasRefundOrder` |
| `renderer.js` | :3611（maybePromptRefundOrderImport） | `createAlertDialog` → `createConfirmDialog`（导入文件/稍后再说）；加预检门控；"导入文件"→ `closeModal()`+`handleBankStatementBatchImport()` |
| `renderer.js` | 新增 | `shouldPromptRefundAtRun()`（退款 enabled + `!hasRefundOrder` + 候选>0） |
| `renderer.js` | :3675（handleBankStatementRun） | 改编排：退款三选一 → `proceedToGwCheck`；抽出 `proceedToGwCheck`（承载原 C3 dialog#2 逻辑） |

### 6.3 代码示例（运行点链式编排 — 退款→proceedToGwCheck→C3 伪代码）

```javascript
async function handleBankStatementRun() {
  if (!state.bankStatementSession) { openModal(createAlertDialog('请先导入银行对账单')); return; }
  try {
    // —— 退款运行点（先于 C3，但互不吞）——
    if (await shouldPromptRefundAtRun()) {
      openModal(createConfirmDialog({
        message: '已启用「中台退款订单回填」场景但未导入「中台退款订单表」。<br>继续运行将跳过退款回填。',
        confirmText: '导入文件', middleText: '直接运行', cancelText: '取消',
        onConfirm: async () => { closeModal(); await handleBankStatementBatchImport(); },  // 不续跑
        onMiddle:  async () => { closeModal(); await proceedToGwCheck(); }                  // ★只跳退款，继续查 C3
        // onCancel 默认仅 closeModal
      }));
      return;
    }
    await proceedToGwCheck();
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`运行失败：${error.message || error}`));
  }
}

// 抽出：承载原 C3 dialog#2 逻辑（2b 改造后调 linkedTable.import）
async function proceedToGwCheck() {
  if (await shouldPromptGatewayReconAtRun()) {   // 2b 已改向 gateway-bill rowCount
    openModal(createConfirmDialog({
      message: '已启用「资金对账不平」类场景但未导入网关对账单（链接表）。<br>继续运行将跳过该类场景。',
      confirmText: '导入文件', middleText: '直接运行', cancelText: '取消',
      onConfirm: async () => { closeModal(); await window.desktopApi.linkedTable.import(); },  // 不续跑
      onMiddle:  async () => { closeModal(); await runBankStatementInternal(); }
    }));
    return;
  }
  await runBankStatementInternal();
}

// 退款候选预检（main 侧纯函数）
function countRefundBankCandidates(rows) {
  let n = 0;
  for (const r of rows || []) if (normalizeCell(r['FundType']) === 'Ach Return') n++;
  return n;
}
```

### 6.4 注意事项

- 🔴 就绪判据 `hasRefundOrder = refundOrderSession !== null`（R-4/R-7）：依赖 PR#65 已收紧的生命周期（单文件导入清 main.js:3492、batch 本批未导退款表清 :11422）→ 严格绑定"本批有效导入"。
- 🔴 候选预检：本批无 `Ach Return` 候选 → 不弹（导入框 + 运行点都不弹）。
- 退款"直接运行"调 `proceedToGwCheck`（**不是** `runBankStatementInternal`）——这是"只跳退款、C3 仍单独提醒"的关键。
- 导入后互斥（退款优先于 C3，迁移自 :3576-3577）保持。

---

## 七、块 B：链接表大文件流式导入

> 🔴 **本块 OPEN（O-1~O-6）已按推荐定稿**（用户 2026-06-08 按推荐采纳，见 §N+5 + PRD §5.5）。🔴 **O-2 值口径逐格 diff 为实施硬前提**（diff 未过不得落流式落库）；O-3 ADM 派生内存评估须覆盖 **bank-deposit + mid-allocation 双触发**；O-6 顺带修「文件为空」误报文案。建议作为独立 PR 组实施。

### 7.0 前置（spec①）：`linked_mid_allocation` 列名迁移 business_date → transaction_date

> **块 B 实施第一步**——大文件 mid-allocation 流式落库依赖 `transaction_date` 列存在，否则撞同一报错 `table linked_mid_allocation has no column named transaction_date`。

- **触及代码点（仅一处）**：`src/backend/database/migrations.js` `ensureLinkedTableSupport`（`:2656`）内，`linked_mid_allocation` 建表语句（`:2685/2687`，`CREATE TABLE IF NOT EXISTS`）**之前**插入幂等防御迁移。
- **实现**：用既有 `hasColumn(db, table, col)` helper（`migrations.js:10`，项目内 `ALTER TABLE ... ADD COLUMN`/`RENAME` 迁移既有范式 `:20/58/84/234`），做**严格双条件门控**：

```js
// 残留旧列名迁移：中间 beta 构建曾用 business_date，已改名 transaction_date；
//   CREATE TABLE IF NOT EXISTS 不会迁移已存在表 → 显式 RENAME COLUMN（幂等：仅当旧列在、新列不在时执行）。
if (hasColumn(db, 'linked_mid_allocation', 'business_date')
    && !hasColumn(db, 'linked_mid_allocation', 'transaction_date')) {
  db.exec('ALTER TABLE linked_mid_allocation RENAME COLUMN business_date TO transaction_date;');
}
```

- **幂等性**：每次启动跑幂等迁移链；正常 DB（已 `transaction_date`）双条件不满足 → no-op 不报错。SQLite `RENAME COLUMN`（3.25.0+）自动同步索引 `idx_linked_mid_allocation_date` 引用，无需重建索引（开发机已实测）。
- **为什么写代码侧 schema 已对（`migrations.js:2690` 建表 = `transaction_date`、`linked-table-repository.js:74/:200` `dateColumn`）还要迁移**：committed 代码从 beta.1 起就是 `transaction_date`（`git log -S transaction_date` 仅命中 `051f004`，全程无 `business_date`），但跑过中间 beta 构建并导入过中台调拨订单表的机器本地表残留旧列名 → `CREATE TABLE IF NOT EXISTS` 不迁移已存在表（`migrations.js:2654` 自述「幂等 no-op」）→ 必须显式 RENAME。`main` 线上从未发布 `business_date`，正式版用户不受影响。
- **不做**：不动其余 4 张链接表（schema 均正常）；不改 INSERT/读取逻辑（代码侧已是目标态）；旧 17 行测试数据无需保留（整表 DELETE+INSERT，`linked-table-repository.js:221` 下次导入覆盖）。
- 🔴 **资金红线**：本表是 JPM 调拨订单修复 + ADM 派生数据源（`readLinkedTableRows('mid-allocation')` / `buildAdmRows`）；列名对齐后下游读取链路不变。迁移在幂等启动迁移中运行，**严格双条件门控**（旧列在 ∧ 新列不在）避免对正常 DB 误操作。详见 `changes/linked-mid-allocation-date-column-migration/spec.md`。

### 7.1 实现方案

复用 `readXlsxStreamed`（实测 65.7 万行 12.4s/385MB）。瓶颈在"读"（`main.js:11222 readLinkedRowsAsObjects` 全量）；写侧 `replaceLinkedTable`（`linked-table-repository.js:187`）已逐行 INSERT，喂流式回调即可。两个改造点：

**改造点 1 — detector 表头识别**（第一道坎）：65 万行在 detector 阶段就 OOM。表头识别只需前几行 → 用 `readXlsxStreamed` 读前 N 行（读到表头/前 ~20 行即 throw 终止流），做 L1 表头匹配 + L2 列宽守卫 + ambiguous 判定。

**改造点 2 — 落库链路**（`main.js:11214-11224` + repository）：新增"流式 replace"路径。

### 7.2 改动点

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `migrations.js`（**前置 §7.0**） | :2685 前 | spec①：`linked_mid_allocation` 建表前加 `hasColumn` 双条件门控 `RENAME COLUMN business_date TO transaction_date`（幂等防御迁移，块 B 实施第一步） |
| `table-type-detector.js` | :208/221/244 | 表头识别改流式（前 N 行终止）；read-error 细分（O-6：区分真空文件 vs OOM） |
| `main.js` | :11214-11224 | `readLinkedRowsAsObjects(全量)` → 流式 replace 路径 |
| `linked-table-repository.js` | :187 | 新增 `replaceLinkedTableStreaming(key, rowIterator, opts)`（或重构 `replaceLinkedTable` 抽事务骨架） |
| `readers.js` | :111/:367（可能） | 流式读变体 |
| `streaming-xlsx-reader.js` | （可能） | 多 sheet / 提前终止支持（现硬编码只读 sheet1.xml） |
| `main.js` | :11244-11259 | 🔴 ADM 派生次生 OOM 缓解（O-3，bank-deposit + mid-allocation 两入口） |

### 7.3 代码示例（流式落库骨架）

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

### 7.4 注意事项

- 🔴 **R-1 值口径**（最高风险）：流式 `parseCellBody` 与 SheetJS 逐格一致性必须双跑 diff 验证（O-2，实施硬前提）。
- 🔴 **R-2 原子性**：全程单事务，失败整体回滚（O-4）。
- 🔴 **R-3 ADM 次生 OOM**：PR#65 后 bank-deposit **或** mid-allocation 任一变更都触发 ADM 全量重建（main.js:11244-11259）；O-3 须覆盖两入口。
- **R-4 reconIdFixResult 清空**：bank-deposit 重导触发 `reconIdFixResult=null`（行为不变，但大文件下确保派生链路整体不崩）。
- **多 sheet**：`readXlsxStreamed` 硬编码只读 sheet1.xml，detector 现扫所有 sheet → 确认链接表单 sheet 约定 / 补多 sheet（vcc 的 `streamFlowFile` 已有多 sheet 遍历可参考）。

---

## 七B、PR-5：ADM 派生弹框溢出修复（方案 A 全局弹框 CSS）

> 🔴 **纯前端 UX，不碰资金对账计算逻辑（资金红线不涉及）**；但改的是**全局共用弹框 CSS**，影响面 = 所有 `.alert-card` 弹框，提 PR 前必须重跑 `npm run preview`（memory `workflow_frontend_previews`）。

### 7B.1 实现方案（方案 A — 结构性 CSS 根治）

把告警卡片改成「头(图标) + 可滚动消息 + 固定按钮」的**有界 flex 列**，根治所有走 `createAlertDialog` / `createConfirmDialog` 的过高弹框。只改 `src/styles.css` 三处规则，**不改 `renderer-dialogs.js`**（弹框骨架 `.alert-card > (.alert-body > .alert-icon + .alert-message) + .dialog-actions` 不变）。

**根因复盘**：内容生成侧 `buildAdmDeriveHtml`（`renderer-dialogs.js:6309`）`unmatched.slice(0,50)` 逐行平铺（每条约 2 视觉行，`:6330/:6337-6339`，`ADM_UNMATCHED_DISPLAY_LIMIT=50` `:6305`，超出只加注脚不限高 `:6341`）；CSS 侧 `.alert-card`（`styles.css:1380`）无 `max-height`/`overflow`/非 flex，`.modal-overlay`（`styles.css:853`）`position:fixed; display:flex; align-items:center` 垂直居中 + `padding:28px` 自身不滚动 ⇒ 超高内容把 `.dialog-actions` 确认按钮挤出视口。

**为什么选方案 A 而非方案 B（定向只改 ADM）**：`createAlertDialog` 是全局共用弹框，导入明细汇总 `buildImportSummaryHtml`、错误报告、以及本迭代块 A 新增的 C3/退款提醒框同样走该路径、长内容时同有溢出隐患；方案 A 一次根治。方案 B 治标（仅 ADM 包有界滚动容器 + 下调上限），其他长内容弹框仍可能超高。

### 7B.2 改动点

| 文件 | 选择器 | 改动内容 |
|------|--------|---------|
| `styles.css` | `.alert-card`（:1380） | 加 `display:flex; flex-direction:column; max-height:calc(100vh - 56px);`（56px = overlay 上下各 28px padding） |
| `styles.css` | `.alert-message`（:1642） | 加 `overflow-y:auto; min-height:0;`（`min-height:0` 是 flex 子项可收缩、内部出现滚动条的关键） |
| `styles.css` | `.dialog-actions`（:1649） | 加 `flex-shrink:0;`（按钮永不被压缩/挤出） |

> **规则生效前提**：`.alert-body { display:contents }`（`styles.css:2672`，现状即如此，无需改）使图标 `.alert-icon` 与消息 `.alert-message` 成为 `.alert-card` 的**直接 flex 子项**，上述 `.alert-message` 内部滚动 + `.dialog-actions` 固定才能在同一 flex column 语境下生效。

### 7B.3 代码示例

```css
.alert-card {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 56px);   /* overlay 上下各 28px padding */
}
.alert-message {
  overflow-y: auto;
  min-height: 0;                     /* flex 子项可收缩、内部滚动的关键 */
}
.dialog-actions { flex-shrink: 0; }  /* 按钮永不被压缩/挤出 */
```

### 7B.4 注意事项

- 🔴 **影响面 = 全局 alert 弹框**（`createAlertDialog` / `createConfirmDialog` / 导出范围框 + 块 A 新增的 C3/退款提醒框）。回归重点：**短内容弹框不被异常拉伸/留白/变形**（`max-height` 是上限不是固定高，短内容卡片高度仍由内容撑开）。
- **排期**：作为 **PR-5**，**块 A 弹框改造（PR-1~PR-4）之后**做——块 A 新增提醒框落地后，一次 `npm run preview` 覆盖所有弹框（含新提醒框）的短/长内容回归。
- 跨视口：小窗口高度（如 700px）确认按钮仍须在视口内（`max-height:calc(100vh-56px)` + 消息区滚动保证）。
- 保留 `buildAdmDeriveHtml` 的「仅显示前 N 行」注脚（避免一次塞太多 DOM）。
- `renderer-dialogs.js` 属重要骨架文件，本次**不改**其 JS；但 `styles.css` 改动同样按约定提 PR 前跑 `npm run preview` + `/check-vars` 对照 `rules/important-variables.md`。

---

## 七C、PR-7：场景管理批量操作 CSS 偏移修复（块 D — 勾选列百分比化 + 列宽补偿）

> 纯前端 UX / 表格列布局，**不碰资金计算 / 对账逻辑（资金红线不涉及）**。**pre-existing**——勾选列由 v2.1.9（commit `2df26f6`）批量操作功能引入，非 v3.0.0 新增。改 `renderer-dialogs.js`（重要骨架）+ 全局 CSS，提 PR 前必跑 `npm run preview:scenarios-manager`（`package.json:56` 专属入口）+ `/check-vars`。

### 7C.1 实现方案（方案 A — 勾选列百分比化 + 其余列按比例补偿）

**根因复盘**：`.scenarios-table { table-layout: fixed; width: 100% }`（`styles.css:2825-2828`）。fixed 布局下列宽由首行单元格静态决定；其余列宽用**百分比**（非 compact：id 5%+category 22%+name 30.94%`!important`+priority 10%+actions 19.06%+enabled 13% = **100%**，`styles.css:2843/2862/2868/2876/2882/2904`），而批量模式新增的勾选列 `scenarios-col-checkbox` 用**固定 32px**（th `renderer-dialogs.js:6468` / td `:6560` 内联 `width:32px`）。`setBatchMode`（`:6575-6593`）显示勾选列时只切 `display`、**未让出对应列宽**。固定 px 列先占 32px、剩余宽按百分比分配，32px + 百分比≈100% 叠加**溢出容器约 32px（`.scenarios-manager-card` 上限 1140px 下 ≈2.8%）** → 全列等比压缩、相对表头集体左移错位。

**为什么选方案 A**：把勾选列改成与其余列**同口径的百分比**，从根上消除"px+% 混用在 fixed 布局下溢出"；批量/普通模式列宽统一百分比口径、回归面集中在"列宽百分比"一处。备选 B（`setBatchMode` 时 JS 动态重算所有列宽）使列宽逻辑散落 JS、与 CSS 双份维护、且 th 内联宽度已分三套视图模式（`:6422-6430`）易遗漏；备选 C（`table-layout:auto`）放弃 fixed 稳定列宽，会破坏 `styles.css:2843-2912` 大量像素级精调（序号 margin-left:21px、category/name 左对齐、actions 按钮间距），回归面更大。

**落地三步**：
1. **勾选列百分比化**：`scenarios-col-checkbox` th/td 内联 `width:32px` → **~3%**（32/1140 ≈2.8%，向上取整 3% 更稳）。
2. **其余列补偿**：批量模式显示勾选列时其余列总和从 100% 降到 ~97%——各百分比列按 **97/100 等比缩放**，使含勾选列时总和回到 100%、不含勾选列时仍为既有 100%（普通模式不变形）。
   - 实现取舍：因勾选列 th/td 是 `renderer-dialogs.js` 内联渲染、其余列宽混用 th 内联（`:6422-6430`，分三套视图）+ CSS class（`styles.css`），补偿落点须与 Dev 确认——倾向把勾选列 3% 做成内联、其余列在批量模式下统一 ×0.97（可由 `.scenarios-table` 加一个批量态 class 钩子 CSS 实现，避免逐列改 JS）。
3. **清理重复定义**：删 `styles-gemini-extra.css` 重复且取值冲突的 `.scenarios-col-name`（`:2251` `30.94% !important` 与 `:2265` `27.96%`），统一单一值，消除 name 列宽口径混乱（`renderer-dialogs.js:6425-6427` 注释自承 th 内联 `nameWidth` 被 `!important` 钉死失效）。

### 7C.2 改动点

| 文件 | 行号 / 选择器 | 改动内容 |
|------|--------------|---------|
| `renderer-dialogs.js` | :6468（th）/ :6560（td） | 勾选列 `scenarios-col-checkbox` 内联 `width:32px` → 百分比 `~3%` |
| `styles.css` | `.scenarios-table` 各列（:2843-2912） | 其余列百分比按 97/100 补偿（批量态总和=100%）；可加批量态 class 钩子统一 ×0.97 |
| `styles-gemini-extra.css` | :2251 / :2265 | 删除重复 `.scenarios-col-name`，保留单一值 |
| `renderer-dialogs.js` | :6422-6430（如走静态补偿） | 三套视图 th 内联宽度（`idWidth`/`categoryWidth`/`nameWidth`/`actionsWidth`）与补偿口径对齐 |

> **关键约束**：`name` 列被 `styles-gemini-extra.css .scenarios-col-name{width:30.94% !important}` 强制锁定，th 内联 `nameWidth`（compact 40%/30.94%）在多数模式失效（`:6425-6427` 注释）。清理重复定义后须验证 compact 模式 name 列宽不反向变化。`styles.css:2843-2912` 像素级精调（序号 margin-left:21px 等）只随宽度百分比微调、不动精调本身。

### 7C.3 代码示例（方案 A — 批量态 class 钩子补偿，避免逐列改 JS）

```css
/* 勾选列百分比化（替代内联 32px；内联改 3% 或移到 class） */
.scenarios-table .scenarios-col-checkbox { width: 3%; }

/* 批量态：表格加 .is-batch-mode（setBatchMode 时 toggle），其余列统一 ×0.97 让出 3% */
.scenarios-table.is-batch-mode .scenarios-col-id       { width: 4.85%; }   /* 5% × 0.97 */
.scenarios-table.is-batch-mode .scenarios-col-category { width: 21.34%; }  /* 22% × 0.97 */
.scenarios-table.is-batch-mode .scenarios-col-name     { width: 30.01% !important; } /* 30.94% × 0.97 */
.scenarios-table.is-batch-mode .scenarios-col-priority { width: 9.7%; }    /* 10% × 0.97 */
.scenarios-table.is-batch-mode .scenarios-col-actions  { width: 18.49%; }  /* 19.06% × 0.97 */
.scenarios-table.is-batch-mode .scenarios-col-enabled  { width: 12.61%; }  /* 13% × 0.97 */
/* 含勾选列：3 + (4.85+21.34+30.01+9.7+18.49+12.61) = 3 + 97 = 100% ✓ */
```

```javascript
// setBatchMode（renderer-dialogs.js:6577）补一行：批量态 class 钩子
function setBatchMode(next) {
  inBatchMode = !!next;
  // ...现有 display 切换不变...
  tableEl.classList.toggle('is-batch-mode', inBatchMode);  // ★新增：驱动 CSS 列宽补偿
}
```

> 上为示意数值（按非 compact 100% 拆分）；compact / gateway-recon-id-fix compact 两套视图的列和也须各自 ×0.97 校验（其 th 内联宽度不同，见 `:6427-6430`）。最终落点（class 钩子 vs 逐列内联）由 Dev 实施时定，原则是**含勾选列时总和=100%、不含时维持既有 100%**。

### 7C.4 注意事项

- 🔴 **盲点：preview 默认非批量态**。`npm run preview:scenarios-manager`（`package.json:56`）渲染普通态（勾选列 `display:none`），**看不到批量态偏移** → 批量态回归须 Electron 实跑，或为 preview 脚本补"批量态"变体（建议新增 `scenarios-manager-batch` 入口、`render-modal-preview.js` 渲染时调 `setBatchMode(true)`）。
- 三套视图模式都要验证不变形：① 非 compact（含优先级+启用）② compact 普通（无优先级/无启用）③ gateway-recon-id-fix compact（无优先级、有启用）（`renderer-dialogs.js:6413-6430`）。
- 清理 `.scenarios-col-name` 重复定义后验证 compact 模式 name 列宽不反向变化（th 内联 vs 单一 CSS 值优先级）。
- `renderer-dialogs.js` 属重要骨架文件 → 提 PR 前 `/check-vars` 对照 `rules/important-variables.md` + 重跑 `npm run preview:scenarios-manager`（memory `workflow_frontend_previews` / `workflow_important_vars_check`）。
- **排期**：作为 **PR-7**，独立于块 A/B/C，无依赖（仅改场景管理弹框列宽，不触碰资金对账提醒/流式/引擎链路）。

---

## 七D、PR-9：R5 场景3 Credit/Debit 方向匹配（块 C — 中台加款单脏数据按 Credit Amount 消歧）

> 🔴 **资金红线**：剔除清单错位 = 导出错误的财务清单。来源 spec：`changes/r5s3-credit-debit-direction-match/spec.md`（状态：已确认/待实施，用户 2026-06-08 逐条拍板 O-1~O-6）。
> **唯一改动文件**：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`（+ 同名单测）。引擎不动其他链路，**O-3 定稿后所有异常分支仅收集警告、不阻断导出**，改动收敛回"单文件改"。
> ⚠️ spec 头部历史引用此方案为「TechDoc §七C」；因 §七C 已被 CSS 偏移占用，本方案在 TechDoc 落为 **§七D / PR-9**（编号以本 TechDoc 为准）。

### 7D.1 背景与现状（代码出处）

引擎 `runRound5PlatformInboundCleanup()`（`r5-platform-inbound-cleanup.js`），由 `reconciliation-orchestrator.js:228` 在 R5 场景3 调用（R4 之后运行）。现状候选匹配（`:84-106`）对同 `ReconciliationId` 的多候选**无脑取 `cand[0]`**（按 `bankRows` 数组顺序，编排器不重排 —— `orchestrator.js:15`），**从不读 `Credit Amount`/`Debit Amount`**。同 reconid 一行 Credit 一行 Debit 时取哪条不可控。现状对多候选仅 push `multi-bank-match-inbound` 警告后照常取第一条。

### 7D.2 需求规则（用户 2026-06-08 拍板，权威 truth）

| 编号 | 规则定稿 |
|------|---------|
| **R-1** | 同 ReconciliationId 候选多行时，取 **`Credit Amount` 有值**的那一行（替换 `cand[0]`）。 |
| **R-2** | 同 ReconciliationId 有 **≥2 行 Credit Amount 都有值** → 不再"取第一条+警告"，改为**跳过该 reconid + 收集警告**（经 O-3 降级为仅警告、不阻断）。 |
| **O-1** | 「Credit Amount 有值」判据 = `parseNumber(b['Credit Amount'])` **可解析（`!== null`）且 `!== 0`**。空 / `0` / `0.00` / 不可解析字符串 → 一律视为"无值"。复用 `engine-utils.parseNumber`（`engine-utils:20`）。 |
| **O-2** | 候选里 **0 行** Credit 有值（全 Debit / Credit 全空）→ **跳过该 reconid 不产剔除行 + push 警告码 `no-credit-match`**，**不阻断导出**。 |
| **O-3** | "报错"语义统一降级：所有异常分支只 push `severity:'warning'`，进 `warnings`/`errorReport` 让用户在报告里看，**不 abort 导出**。 |
| **O-4** | 方向规则**仅在 `cand.length > 1` 路径生效**。`cand.length === 1`（单候选）维持现状取 `cand[0]`，不强制单行 Debit 也筛/报。 |
| **O-5** | 业务确认**不存在「多 gw + 多 bank」场景** → 不处理多 gw 抢同一批 bank。现有单测 `:181-199`「2 gw 各配 1 bank」与该确认冲突，**必须删除/改写**（见 7D.5）。 |
| **O-6** | 按 reconid 收集警告（沿用现有 `warningCollector.push` 模式），新增 `no-credit-match` / `multi-credit-match` 两个码；warning 带 `reconid` + 冲突的 N 行标识（`_rowId` / 金额）。 |

### 7D.3 实现方案（最小改法，替换 `:88-104` 候选选择块）

候选选择按以下顺序（据 O-1~O-6 定稿）：

1. `cand = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId))`；`cand.length === 0` → `continue`（同现状）。
2. `cand.length === 1` → `bankRow = cand[0]`（**O-4**：单候选维持现状，不强制 Credit 筛选）。
3. `cand.length > 1` → 方向消歧：
   - `creditCand = cand.filter((b) => { const v = parseNumber(b['Credit Amount']); return v !== null && v !== 0; })`（**O-1**）。
   - `creditCand.length === 1` → `bankRow = creditCand[0]`（**R-1**：唯一 Credit 行）。
   - `creditCand.length === 0` → `warningCollector.push({ code:'no-credit-match', severity:'warning', ... })` + `continue`（**O-2/O-3**，不阻断）。
   - `creditCand.length >= 2` → `warningCollector.push({ code:'multi-credit-match', severity:'warning', ... })` + `continue`（**R-2/O-3**，不阻断）。
4. 选中 `bankRow` 后仍按现逻辑 `normalizeCellValue(bankRow.FundType) !== excludeFundType` 决定是否 `cleanupRows.push(buildCleanupRow(gw, bankRow))`（**不变**）。

```js
const { parseNumber } = require('./engine-utils'); // 顶部补 import（复用 engine-utils:20）

// ...循环内：
const cand = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
if (cand.length === 0) continue;

let bankRow;
if (cand.length === 1) {
  bankRow = cand[0];                       // O-4：单候选维持现状
} else {
  const creditCand = cand.filter((b) => {
    const v = parseNumber(b['Credit Amount']);
    return v !== null && v !== 0;          // O-1 判据
  });
  if (creditCand.length === 1) {
    bankRow = creditCand[0];               // R-1
  } else if (creditCand.length === 0) {
    warningCollector.push({                // O-2/O-3：跳过 + 警告，不阻断
      rowId: null, code: 'no-credit-match', severity: 'warning',
      message: `网关 reconciliationid=${key} 的 ${cand.length} 行候选均无 Credit Amount，跳过剔除（数据异常）`,
    });
    continue;
  } else {
    warningCollector.push({                // R-2/O-3：跳过 + 警告，不阻断
      rowId: null, code: 'multi-credit-match', severity: 'warning',
      message: `网关 reconciliationid=${key} 命中 ${creditCand.length} 行 Credit Amount 有值，无法唯一定位，跳过剔除（数据异常）`,
    });
    continue;
  }
}
usedBankRowId.add(bankRow._rowId);
if (normalizeCellValue(bankRow.FundType) !== excludeFundType) {
  cleanupRows.push(buildCleanupRow(gw, bankRow));
}
```

### 7D.4 改动点

| 文件 | 行号 / 符号 | 改动内容 |
|------|------------|---------|
| `r5-platform-inbound-cleanup.js` | 顶部 import | 新增 `const { parseNumber } = require('./engine-utils')`（复用 `engine-utils:20`） |
| `r5-platform-inbound-cleanup.js` | `:88-104`（候选选择块） | `cand[0]` 无脑取 → 按 7D.3 方向消歧（cand===1 取 cand[0] / cand>1 按 creditCand 数量分支） |
| `r5-platform-inbound-cleanup.js` | 警告码 | 新增 `no-credit-match` / `multi-credit-match`；旧 `multi-bank-match-inbound`（"取第一条+警告"语义）被取代，可保留兼容或一并清理（实施时定） |
| `r5-platform-inbound-cleanup.test.js` | `:181-199` | **删除/改写**「2 gw 各配 1 bank」case（O-5：业务确认无多 gw+多 bank） |

### 7D.5 ⚠️ 与现有逻辑的冲突点（必须连带处理）

现有单测 `r5-platform-inbound-cleanup.test.js:181-199`「2 条 gw（同 reconid）+ 2 条同 reconid bank → 各配一条，产 2 条剔除行」的设计前提是"多 bank 各配一条"。新规则下：仅 1 行 Credit 有值时只能配 1 条（第二 gw 落 O-2）；2 行 Credit 都有值则触发 R-2。**O-5 已定稿业务不存在「多 gw + 多 bank」** → 该 case 设计前提与业务确认冲突，**必须删除或改写**（改写方向：删该 case，或改成"多候选 + 单 Credit 行 → 取 Credit 行"的新语义 case）。这是实施时硬动作，非待确认项。

### 7D.6 注意事项

- 🔴 **资金红线**：换行后 `buildCleanupRow` 的附言 FundType、C~O 13 列拷贝都来自新选中的 Credit 行 → 导出内容随之变化，**须人工复核真实样本**，记入 `manual-test-checklist`。
- 方向筛选只替换「选哪条候选行」；选中后 `FundType !== excludeFundType` 触发过滤（`:103`）保持不变，作用在选中行上。
- O-3 定稿仅警告不阻断：导出主链路不变，"正常无冲突"样本照常导出（无 abort 风险）。
- `runRound5PlatformInboundCleanup` / `buildCleanupRow` 为资金红线函数；`rules/important-variables.md` 当前无 R5 场景3 直接条目（spec 已 grep 核对），但实施前仍须按 CLAUDE.md 硬节点跑 `/check-vars`（提 PR / 版本 bump / 合并前）。
- **排期**：作为 **PR-9**（块 C，资金红线引擎修复），独立于块 A/B/D，无依赖（仅改 R5 引擎单文件 + 单测，不触碰提醒框/流式/列宽链路）。

### 7D.7 测试点（单测增删，`r5-platform-inbound-cleanup.test.js`）

| 类型 | case | 断言 |
|------|------|------|
| 删/改 | `:181-199` multi-bank case | 删除或改写（O-5） |
| 增 | 2 行同 reconid（1 Credit 1 Debit） | 取 Credit 行（断言加款单号/附言来自 Credit 行） |
| 增 | 2 行 Credit 都有值 | 跳过 + `code:'multi-credit-match'` + `severity:'warning'`，**导出未被阻断** |
| 增 | 0 行 Credit 有值（全 Debit / Credit 全空） | 跳过 + `code:'no-credit-match'`，导出未阻断 |
| 增 | 单候选（`cand.length===1`） | 维持现状取它（不因 Debit 被筛掉） |
| 增 | `Credit Amount` = `0` / `''` / `'0.00'` / `'1,234.5'` | 按 O-1（`!== null && !== 0`）验证边界 |
| 手测 | 🔴 真实样本（资金红线） | 记入 `manual-test-checklist` |

---

## 八、新增 / 修改 IPC 清单

| IPC channel | 类型 | main 端 | preload 暴露 | 用途 | 需求 |
|-------------|------|---------|-------------|------|------|
| `linked-table:row-count` | 新增 | 仿 :11139，调 `getLinkedTableMeta(key).rowCount` | `linkedTable.rowCount(key)` | C3 就绪判据（不读全表） | 2b |
| `bank-statement:refund-candidate-count` | 新增 | 仿 :3856，调 `countRefundBankCandidates(bankStatementSession.rows)` | `bankStatement.refundCandidateCount()` | 退款候选预检 | 3 |
| `bank-statement:session-status` | 修改（增字段） | :3839 增 `bankStatementChannelRegions: string[]` + `hasRefundOrder: boolean` | 已有 | 需求 1 前缀 + 退款运行点就绪 | 1/3 |
| `linked-table:import` | **不改签名** | 内部读取改流式（块 B） | 已有 `linkedTable.import()` | 链接表导入（C3/退款"导入文件"复用 + 块 B 大文件） | 2b/3/B |

> 所有新增/修改均为增量，向下兼容；前端 state 接新字段按缺省兜底。

---

## 九、PR 拆分（每 PR 3-6 文件，串行减少 renderer.js 同区冲突）

| PR | 范围 | 主要文件 | 测试 | 依赖 |
|----|------|---------|------|------|
| **PR-1** | 需求 1 地区前缀 | `channel-enum-repository.js`、`database.js`、`main.js`、`renderer.js`、+单测 | unit `extractChannelRegionCombos` + preview | 无 |
| **PR-2** | 需求 2a 去框 + issues 并入状态框 | `renderer.js`、+单测 | unit `buildImportIssuesSummary` + preview | 无 |
| **PR-3** | 需求 2b C3 改向链接表 | `main.js`、`preload.js`、`renderer.js` | grep 断言（不读 gatewayReconSession 改读 rowCount）+ 手测矩阵 + preview | PR-2（同改 batch-import/renderer 区） |
| **PR-4** | 需求 3 退款对齐 + 预检 + 运行点编排 | `main.js`、`preload.js`、`renderer.js`、+单测 | unit `countRefundBankCandidates` + grep（退款用 createConfirmDialog；run 退款先于 C3）+ 手测矩阵 + preview | 🔴 **PR-3 必须先于 PR-4**（两者同改 `handleBankStatementRun`/`proceedToGwCheck`/`handleBankStatementBatchImport`） |
| **PR-5** | ADM 派生弹框溢出修复（方案 A 全局弹框 CSS，见 §七B） | `styles.css` | 手测（ADM 超高框确认按钮可见可点 + 短内容弹框不变形）+ `npm run preview`（一次覆盖所有弹框含块 A 新提醒框） | 🔴 **块 A 弹框改造（PR-1~PR-4）之后做**——块 A 新提醒框落地后一次 preview 回归全部弹框 |
| **PR-6+**（块 B 组） | 块 B 大文件流式（**独立组，先过 OPEN**） | **前置：`migrations.js`（spec① 列名迁移，见 §7.0）** → `table-type-detector.js`、`linked-table-repository.js`、`main.js`、可能 `readers.js`/`streaming-xlsx-reader.js` | 前置迁移幂等单测 + unit 值口径 diff + 行数守恒 + 边界 + 集成真实大文件 + 手测 | 独立；**实施第一步先做 spec① 前置迁移**；块 B 内部至少拆 2-3 PR（迁移+detector / 落库 / ADM） |
| **PR-7**（块 D） | 场景管理批量操作 CSS 偏移修复（见 §七C） | `renderer-dialogs.js`、`styles.css`、`styles-gemini-extra.css` | 手测（批量态三套视图列不偏移）+ `npm run preview:scenarios-manager`（批量态须 Electron 实跑或补 batch 变体）+ `/check-vars` | 独立，无依赖（仅改场景管理列宽） |
| **PR-9**（块 C） | 🔴 R5 场景3 Credit/Debit 方向匹配（见 §七D） | `r5-platform-inbound-cleanup.js`、+单测（删/改 `:181-199` + 增方向消歧 case） | unit（1C1D取Credit / 2C跳过warn / 0C跳过warn / 单候选维持 / O-1 边界，且导出未阻断）+ 🔴 真实样本手测 + `/check-vars` | 独立，无依赖（仅改 R5 引擎单文件）；**资金红线，须人工复核样本** |

**顺序**：PR-1 → PR-2 → PR-3 → PR-4（3 必须先于 4）→ **PR-5**（块 A 之后，一次 preview 回归全部弹框）；**PR-6+ 块 B 组独立**，启动前单独过 OPEN（O-1~O-6 用户拍板 + R-1 值口径 diff 验证），**块 B 实施第一步先做 spec① 列名迁移前置**；**PR-7（块 D CSS）/ PR-9（块 C R5 方向匹配）各自独立、无依赖**，可与块 A/B 并行，PR-9 为资金红线须人工复核样本。

---

## 十、测试矩阵

### 10.1 单元测试（`tests/unit/`）

| 测试对象 | case | 需求 |
|---------|------|------|
| `extractChannelRegionCombos` | 空 / Channel 空 / 地区空（只产出 Channel）/ 多组合去重 / 稳定序 | 1 |
| `buildImportIssuesSummary` | 纯失败 / 纯跳过 / 失败+跳过 / 全 ok（空摘要）/ hasFailed 标志 | 2a |
| `countRefundBankCandidates` | 0 候选 / N 候选 / FundType 归一（大小写、空格）/ 非 Ach Return | 3 |
| grep 断言 | 2b 判据不再读 `gatewayReconSession` 改读 `linkedTable.rowCount`；退款用 `createConfirmDialog`；`handleBankStatementRun` 退款先于 C3（`shouldPromptRefundAtRun` 在 `proceedToGwCheck` 之前） | 2b/3 |
| 块 B 值口径 diff | 🔴 中等链接表 SheetJS↔流式逐格一致（日期/数字精度/前导零/空格） | B |
| 块 B 行数守恒 | 流式落库行数 = 文件行数 - 表头 | B |
| 块 B 边界 | 表头不匹配 / 空文件 / 多 sheet | B |
| 块 B 前置迁移（spec①） | 🔴 残留 `business_date` 旧表 → RENAME 成 `transaction_date`；正常 DB（已 `transaction_date`）→ 双条件不满足 no-op；幂等（重复跑不报错） | B |

### 10.2 手测提醒矩阵（Electron 实跑，🔴 资金红线必手测）

| 场景 | 条件 | 预期 |
|------|------|------|
| C3 链接表空 | 启用 C3 + `gateway-bill` 空 + 有银行候选 | 导入后 & 运行点提醒（改向链接表文案） |
| C3 有数据 | `gateway-bill` rowCount>0 | 不弹 |
| C3 未启用 / 候选=0 | — | 不弹 |
| C3 导入文件 | 点"导入文件" | 调起 `linkedTable.import()` |
| C3 IPC 异常 | 模拟 row-count 失败 | 仍提醒（按未就绪） |
| 退款导入后两按钮 | 启用退款 + 未导表 + 有 Ach Return | 弹两按钮框 |
| 退款运行点三选一 | 同上 | 弹三选一框 |
| 退款导了表/无候选/未启用 | — | 不弹 |
| 退款导入文件 | 点"导入文件" | 调起批量导入 |
| 退款直接运行跳退款仍弹 C3 | 退款 + C3 都缺 | 跳退款后**仍弹 C3** |
| 状态框前缀 | 单/多渠道、多文件合并 | 半角冒号前缀、不换行 |
| 状态框摘要 | 含失败/跳过、纯失败批次 | 追加摘要、tone 升 error |
| 块 B 大文件 | 657,758 行样本 | 落库 657,757 行、不报"文件为空" |
| 块 B ADM 派生 | 块 B 落 bank-deposit + 已有 mid-allocation | ADM 重建不 OOM |
| 块 B 前置迁移（spec①） | 残留 `business_date` 旧表 DB 启动 + 用例文件重导 | 列改名 `transaction_date`、落库成功；正常 DB no-op 不报错 |
| PR-5 ADM 弹框溢出 | 导入用例触发 ADM「部分未匹配」框（≥50 行） | 确认按钮可见可点、消息区内部滚动、可关闭 |
| PR-5 短内容不变形 | 短 alert / confirm / 导出范围框 + C3/退款提醒框 | 布局不被拉伸/留白；小窗口（700px）按钮在视口内 |

### 10.3 preview（前端改动按约定）

| 命令 | 覆盖 | 需求 |
|------|------|------|
| `npm run preview` | 资金对账面板状态框（前缀 + 摘要）；PR-5 全局弹框 CSS 改造后**一次回归所有 `.alert-card` 弹框短/长内容**（含块 A 新增的 C3/退款提醒框）—— 故 PR-5 排在块 A 弹框改造之后 | 1/2a/PR-5 |
| — | 提醒框为运行期 `openModal`，**无 preview script** → 靠手测 + 单测 grep 覆盖 | 2b/3 |

### 10.4 回归

- `npm run release-check`（unit + integration + smoke，PASS/FAIL 源）。
- 块 B 前置（spec①）：迁移相关单测 + 残留 `business_date` 旧表 DB 启动跑迁移不报错。
- 块 B 端到端：真实 65.7 万行样本导入 → 落库 657,757 行 → ADM 派生不崩。

---

## 十一、🔴 资金红线与 Runtime-state 清单（bump / 合并 / 提 PR 前必跑 `/check-vars`）

| 变量 / 风险 | 层级 | 本迭代涉及 | review 要点 |
|------------|------|-----------|------------|
| `bankStatementSession` | Runtime-state | 需求 1 读 rows 提取渠道-地区组合 | **只读**；不改 `_rowId` 全局唯一不变量、不改合并/清空时机 |
| `gatewayReconSession` | Runtime-state | 需求 2b 从判据移除其门控作用 | **不改写入/清空时机、不删 session**；仅 C3 提醒不再以它为就绪判据（改查链接表 rowCount） |
| `refundOrderSession` | Runtime-state（**待升格入表**） | 需求 3 经 session-status 透出 `hasRefundOrder` 判就绪 | **只读**；依赖 PR#65 收紧的生命周期（单文件导入清 :3492、batch 未导退款表清 :11422）；建议本迭代升格入 `important-variables.md` |
| 🔴 判据写反致漏对账 | 风险（最高危） | 需求 2b/3 | gateway-bill 严格 `rowCount>0`、退款 `refundOrderSession!==null`；IPC 异常按"未就绪"保守处理 |
| `replaceLinkedTable` / 链接表整表覆盖 | Risk-sensitive（数据红线） | 块 B | DELETE 全表 + 逐行 INSERT 全程单事务，失败整体回滚（R-2） |
| ADM 派生次生 OOM | 风险 | 块 B | PR#65 后 bank-deposit **或** mid-allocation 任一变更触发 ADM 全量重建（main.js:11244-11259）；O-3 须覆盖两入口 |
| 块 B 值口径一致性 | 风险（最高，实施硬前提） | 块 B | 流式 `parseCellBody` ↔ SheetJS 逐格 diff（R-1/O-2）入单测 |
| `reconIdFixResult` | Runtime-state | 块 B | bank-deposit 重导触发清空（行为不变），确保大文件下派生链路整体不崩 |
| `linked_mid_allocation` schema（spec① 列名迁移） | Risk-sensitive（资金对账链接表 schema 迁移） | 块 B 前置（§7.0） | 🔴 本表是 JPM 调拨订单修复 + ADM 派生数据源；迁移在幂等启动迁移中跑，**严格双条件门控（旧列 `business_date` 在 ∧ 新列 `transaction_date` 不在）**避免对正常 DB 误操作；列名对齐后下游读取链路不变 |
| ADM 弹框 CSS（PR-5 方案 A） | Minor（纯前端 UX） | PR-5 | 🔴 不涉资金红线；改全局 `.alert-card`/`.alert-message`/`.dialog-actions` CSS，影响面 = 所有 alert 弹框，提 PR 前重跑 `npm run preview` 回归短内容不变形 |

> 每个 PR 提交前跑 `/check-vars`；bump 版本 / 合并到 `main` 前跑 `npm run scan:vars` + 完整 `/check-vars`。

---

## N+2、任务分解

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| 1 | 抽 `extractChannelRegionCombos` + facade 透传 | `channel-enum-repository.js`、`database.js` | unit | todo |
| 2 | session-status 增 `bankStatementChannelRegions` + 前端拼前缀 | `main.js`、`renderer.js` | 手测 + preview | todo |
| 3 | 删明细框 + `buildImportIssuesSummary` + 状态框追加摘要 + 迁移退款副作用 | `renderer.js` | unit + 手测 + preview | todo |
| 4 | 纯失败批次分支 + issues 清除时机 | `renderer.js` | 手测 | todo |
| 5 | 新 IPC `linked-table:row-count` + preload | `main.js`、`preload.js` | grep + 手测 | todo |
| 6 | C3 两处判据改向链接表 + 文案 + onConfirm 调 `linkedTable.import()` | `renderer.js` | grep + 手测矩阵 + preview | todo |
| 7 | 新 IPC `refund-candidate-count` + `countRefundBankCandidates` + session-status 增 `hasRefundOrder` + preload | `main.js`、`preload.js` | unit + grep | todo |
| 8 | 退款导入后改框 + 预检 + `shouldPromptRefundAtRun` + 运行点编排（抽 `proceedToGwCheck`） | `renderer.js` | grep + 手测矩阵 + preview | todo |
| 9 | PR-5：ADM 派生弹框溢出修复（方案 A 全局 `.alert-card` 有界滚动 + 固定按钮，见 §七B） | `styles.css` | 手测（超高框按钮可见 + 短内容不变形）+ `npm run preview` | todo（块 A 弹框改造后做） |
| 10 | 块 B 前置（spec①）：`linked_mid_allocation` 列名迁移 business_date→transaction_date（幂等 RENAME） | `migrations.js` | 前置迁移幂等单测 + release-check | todo（块 B 实施第一步） |
| 11 | 块 B-1：detector 表头识别流式 + read-error 细分 | `table-type-detector.js`、可能 `streaming-xlsx-reader.js` | unit 边界 | todo（先过 OPEN） |
| 12 | 块 B-2：落库链路流式 + `replaceLinkedTableStreaming` | `main.js`、`linked-table-repository.js` | unit 行数守恒 + 值口径 diff + 集成大文件 | todo（先过 OPEN） |
| 13 | 块 B-3：ADM 派生次生 OOM 缓解（O-3） | `main.js` | 集成大文件 ADM 派生不崩 | todo（先过 OPEN） |

---

## N+3、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `feat(v3.0.0 PR-1): 状态框渠道-地区前缀（抽 extractChannelRegionCombos + session-status 透传）` | `channel-enum-repository.js`、`database.js`、`main.js`、`renderer.js`、+unit | 1 |
| 2 | `feat(v3.0.0 PR-2): 去导入明细框 + 失败/跳过并入状态框（迁移退款触发副作用）` | `renderer.js`、+unit | 2a |
| 3 | `feat(v3.0.0 PR-3): C3 提醒改向链接表网关对账单（新 IPC row-count + 判据改向 + 导入文件调 linkedTable.import）` | `main.js`、`preload.js`、`renderer.js` | 2b |
| 4 | `feat(v3.0.0 PR-4): 退款提醒对齐 C3 + 候选预检 + 运行点链式编排` | `main.js`、`preload.js`、`renderer.js`、+unit | 3 |
| 5 | `fix(v3.0.0 PR-5): ADM 派生弹框溢出修复（方案 A 全局 .alert-card 有界滚动 + 固定按钮）` | `styles.css` | PR-5 |
| 6 | `fix(v3.0.0 PR-6 前置): linked_mid_allocation 列名迁移 business_date→transaction_date（幂等 RENAME）` | `migrations.js`、+unit | B |
| 7 | `feat(v3.0.0 PR-6): 链接表 detector 表头识别流式化` | `table-type-detector.js`、`streaming-xlsx-reader.js`、+unit | B |
| 8 | `feat(v3.0.0 PR-7): 链接表落库链路流式（replaceLinkedTableStreaming + 值口径 diff 单测）` | `main.js`、`linked-table-repository.js`、+unit | B |
| 9 | `fix(v3.0.0 PR-8): ADM 派生次生 OOM 缓解（bank-deposit + mid-allocation 双入口）` | `main.js` | B |
| 10 | `chore(v3.0.0): bump 版本 + 文档归档 + scan:vars` | `package.json`、`package-lock.json`、本 PRD/TechDoc | 收尾 |

> PR-3 必须先于 PR-4（同改 `handleBankStatementRun`/`handleBankStatementBatchImport`）；PR-5（ADM 弹框）在块 A 之后做、一次 preview 回归全部弹框；块 B 组（6-9）独立、启动前过 OPEN，**实施第一步先做 spec① 列名迁移前置（序号 6）**。

---

## N+4、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。

### 2026-06-08

- 动作：PM 基于已批准 plan `3-0-0-1-flickering-haven.md` + 两份 spec（c3-gateway-recon-prompt-fix / linked-table-large-file-streaming）+ beta.6 文档格式参照，产出 PRD + TechDoc。
- 证据：行号锚点逐一在 `cf7edec` 基线核验（renderer.js:3398-3400 状态框拼接、:584 updateStatusBox 全角换行、:3589/:3611/:3675/:3712 提醒函数；main.js:295 refundOrderSession、:3606 C3 取数、:3839 session-status、:3856 c3-candidate-count、:11222 readLinkedRowsAsObjects、:11244-11259 ADM 重建；createConfirmDialog renderer-dialogs.js:341；linkedTable.import preload.js:382）。
- 风险：块 B 值口径一致性（R-1）+ ADM 次生 OOM（R-3）为最高风险，OPEN 待拍板。判据写反致漏对账（R-4）为块 A 最高危逻辑风险。
- 决策：块 B 作为独立 PR 组、先过 OPEN；块 A 串行 PR-1→2→3→4。

### 2026-06-08（块 A 实施完成 + 纳入两个新决策）

- 动作：块 A（需求 1/2a/2b/3）已实施完成。team-lead 确认两个新决策入文档：①spec②「ADM 派生弹框溢出」定**方案 A**（全局 `.alert-card` CSS 改有界滚动 + 固定按钮，根治所有过高弹框）作为 **PR-5**（块 A 弹框改造后做、一次 `npm run preview` 覆盖所有弹框含新提醒框）；②spec①「`linked_mid_allocation` 列名迁移 business_date→transaction_date」**并入块 B 作前置步骤**（块 B 实施第一步先做幂等 `RENAME COLUMN` 防御迁移）。
- 文档改动：TechDoc 新增 §7.0（块 B 前置迁移）+ §七B（PR-5 方案 A 技术方案）；§二文件清单加 `styles.css`/`migrations.js`；§九 PR 拆分加 PR-5、块 B 改为 PR-6+ 且前置 spec①；§N+2/N+3 任务与 commit 顺延；§十测试矩阵补 PR-5 弹框 + 块 B 前置迁移单测；§十一红线清单加 `linked_mid_allocation` schema 迁移 + ADM 弹框 CSS 两条。PRD 同步新增 §5.6/§6.6/§5.5.4 + 前置说明 + AC ACB-6 + 手测场景。
- 证据：PR-5 行号锚点取自 `changes/adm-derive-dialog-overflow/spec.md`（`renderer-dialogs.js:6309 buildAdmDeriveHtml`、`:6305 ADM_UNMATCHED_DISPLAY_LIMIT`；`styles.css:1380 .alert-card`、`:1642 .alert-message`、`:1649 .dialog-actions`、`:853 .modal-overlay`、`:2672 .alert-body display:contents`）。spec① 行号取自 `changes/linked-mid-allocation-date-column-migration/spec.md`（`migrations.js:10 hasColumn`、`:2656 ensureLinkedTableSupport`、`:2685/2687/2690` 建表；`linked-table-repository.js:74/:200 dateColumn`、`:221` 整表 DELETE+INSERT）。
- 风险：spec① 触及资金对账链接表 schema 迁移 → 必须严格双条件门控、入 §十一红线清单；PR-5 纯前端 UX 不涉资金红线，但改全局弹框 CSS → 提 PR 前必重跑 `npm run preview` 回归短内容不变形。

### 可沉淀知识

- [ ] `gatewayReconSession` 是 C3 提醒专属、数据已废的僵尸 session（数据消费早切链接表 `gateway-bill`），改提醒不误伤 C3 对账——可回写 `knowledge/`。
- [ ] `readXlsxStreamed` 是已验证的大文件流式范式（vcc-op-calc-import 旁证 78.7 万行/811MB 流式 7.8s/778MB）；链接表/收单流水大文件导入均可复用——可回写 `knowledge/`。
- [ ] `refundOrderSession` 建议升格入 `rules/important-variables.md` Runtime-state 层（beta.6 已开通真实退款数据流，本迭代依赖其生命周期判就绪）。

---

## N+5、Open Technical Questions

### 块 B（🔴 实施前需用户逐条拍板，PM 不替用户定）

| 编号 | 问题 | 候选 / 推荐 |
|------|------|------------|
| O-1 | 统一流式 vs 大文件阈值分支 | 推荐统一流式（值口径验证通过后），免双路径维护 |
| O-2 | 值口径一致性验证策略 | 推荐中等文件 SheetJS↔流式逐格 diff 入单测（**实施硬前提**） |
| O-3 | bank-deposit / mid-allocation 派生 ADM 的 65 万行内存（R-3） | 单列评估，可能拆另案；🔴 PR#65 后须覆盖 mid-allocation 入口 |
| O-4 | 65 万行单事务 INSERT vs 分批 | 推荐单事务 + 确认 SQLite WAL/锁承受力 |
| O-5 | detector 多 sheet vs 流式引擎单 sheet | 确认链接表单 sheet 约定 / 补多 sheet（`readXlsxStreamed` 现硬编码只读 sheet1.xml） |
| O-6 | 顺带修误导报错文案（read-error 细分） | 一并做（区分"真空文件"与"OOM 读失败"） |

### 需 team-lead 决策

1. **`linkedTable.import()` 返回结果处理**：C3/退款"导入文件"复用该入口，需确认其返回结果（成功/失败/取消）是否需要在调用方反馈给用户、是否需要随后刷新状态框（现 C3 死链 `handleBankStatementImportGatewayRecon` 有 `refreshBankStatementStatus()`，改调 `linkedTable.import()` 后是否需要同等刷新）。
2. **`refundOrderSession` 升格入表**：建议本迭代将其升格入 `rules/important-variables.md` Runtime-state 层（当前未单独成条，但本迭代依赖其生命周期）。
3. **块 B 是否并入 3.0.0 同发**：plan 已拍板"并入 3.0.0"，但块 B OPEN 多、风险高，需确认是否与块 A 同一版本号发布，还是块 A 先发、块 B 作为 3.0.0 后续 beta。
</content>

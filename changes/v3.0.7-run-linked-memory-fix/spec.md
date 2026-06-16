# spec：修复「开始运行」链接表内存尖峰导致 Windows 卡死

> change-name：`v3.0.7-run-linked-memory-fix`
> 状态：spec 待评审（本轮仅落 spec，未动代码）
> 风险等级：🔴 资金红线（对账 run 路径，需人工复核）

---

## 一、背景与现象

用户在 Windows 导入 `渠道账单_2026-06-16_541685.xlsx`（2862 行 × 44 列、Channel=BOSH、地区=CN 的普通渠道对账单，712KB）后，点「开始运行」时系统极其卡顿、跑不动。场景管理里只启用了 BOSH-CN 相关渠道场景，其它 builtin 场景全关。

**已实测定位**：导入路径本身很快（本机串真实代码实测 detect 28ms + readBankStatement 184ms + merge 0.1ms，峰值 RSS 222MB）。卡顿发生在导入后点「**开始运行**」（`bank-statement:run`）阶段，不是导入。

---

## 二、根因（含 file:line 出处）

`bank-statement:run`（`src/main.js`）在每次运行时从 DB 全量读多张链接表喂编排器。两处无门控/无优化的大表读取是卡顿源：

### 2.1 bank-deposit 入金表「无谓载入」（主因）

`src/main.js:3682`：
```js
const workingDepositRows = structuredClone(database.readLinkedTableRows('bank-deposit') || []);
```
- `readLinkedTableRows('bank-deposit')` 整表读回内存。代码库自标注：`src/backend/database/linked-table-repository.js:933` ——「实测 65.7 万行 → ~1.2GB RSS 尖峰」。再 `structuredClone` 深拷一份。
- **该数据对本次运行无用**：`workingDepositRows` 仅经 `refundContext.depositRows`（`main.js:3767`）传入编排器，而编排器只在退款回填场景（R5 场景4）启用时才消费——`src/main-process/reconciliation-orchestrator.js:443 if (r5s4Bucket.length)`。用户关掉退款场景 → 这份 ~1.2GB **读了 + 深拷了，一行都没用**。
- **是门控漏洞，非 v3.0.7 新引入**：旁边三处大表读取均已有「消费方门控」（仅当对应场景启用才读，否则注入 `[]`），注释原话「防整表无谓载入（bank-deposit 65.7万行~1.2GB尖峰先例）」：
  - `workingMidRows`(`main.js:3696`) ← `paymentOfflineEnabled`
  - `workingReconRows`(`main.js:3746`) ← `reconSourceMidEnabled`
  - `workingDispatchReconRows`(`main.js:3755`) ← `dbsChargeScenarioEnabled`
  - 唯独 `workingDepositRows`(3682) 没门控，自 v2.1.16-beta.4（548d39b）起就是无条件读。

### 2.2 gateway-bill 网关账单表全量读（规模放大因素）

`src/main.js:3677`：
```js
const workingGwRows = structuredClone(database.readLinkedTableRows('gateway-bill'));
```
- **不可门控**（load-bearing）：R1 对账（`reconciliation-orchestrator.js:294`）无条件读 gwRows；R2 dispatcher（用户的 BOSH-CN 渠道场景走此路，`orchestrator:300-301`）也消费 gwRows。注入 `[]` 会让对账匹配静默丢失 = 漏对账。
- 若网关表达到 300 万行级别，即使修好 bank-deposit，本表全量读 + 深拷仍可能撑爆低配 Windows 内存。
- R1 匹配算法是 O(n+m) 哈希（`src/main-process/scenario-engines/r1-recon-id-match.js`），非 O(n×m) → 是内存占用问题，不是 CPU 问题。

---

## 三、方案（两处修复）

### 修复 1：bank-deposit 加消费方门控（`src/main.js:3682`）

在读取前加布尔门控，谓词**精确镜像**编排器 `bucketScenarios` 的 r5s4 分桶条件（`reconciliation-orchestrator.js:173`）：

```js
// v3.0.7 修复：bank-deposit 入金表（65.7万行~1.2GB 尖峰）消费方门控，防整表无谓载入。
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
- `dispatchScenarios` 已是 enabled 过滤后集合（`main.js:3669`），无须再判 enabled（与 `paymentOfflineEnabled`/`dbsChargeScenarioEnabled` 同范式）。
- **结果字节级不变**：退款场景关闭时编排器本就 no-op，注入 `[]` 与现状等价；退款场景启用时照常读、行为不变。

### 修复 2：gateway-bill 改「按 Channel 过滤读」（`src/main.js:3677`，含不深拷）

**业务不变量（业务负责人已确认，作为本优化 load-bearing 前提）**：
> 跨渠道对账永远不存在——一条 Channel=X 的银行行只会匹配 Channel=X 的网关行。

基于此：收集本批银行单出现的**全部** Channel 值集合 S，只读 `Channel ∈ S` 的网关行。安全性证明：任一银行行 B 的 Channel ∈ S，其合法网关对手 G 的 Channel = B.Channel ∈ S → G 必在子集内 → **不漏任何合法匹配**；唯一被滤掉的是「跨渠道匹配」，业务确认其不存在。规模：300 万行 → 仅导入涉及的渠道子集（全 BOSH 则只剩 BOSH 那几万行）。此手段天然包含「不深拷」（gwRows 全程只读 + 每次新解析，深拷无保护意义）。

**2a. 新增仓储函数**（`src/backend/database/linked-table-repository.js`，仿 `readBankDepositAdmCandidates` 范式 ~line 940，经 `database.js` facade 暴露）：
```js
// v3.0.7：按 Channel 集合下推过滤读网关账单表（防 300 万行全量载入尖峰）。
//   业务不变量：对账永远同 Channel → 只需 Channel∈channels 的网关行。
//   channels 含空值时一并匹配「Channel=空串」与「缺 Channel 字段（json_extract→NULL）」两种网关行。
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
  const rows = db.prepare(`SELECT raw_json FROM ${def.table} WHERE ${conds.join(' OR ')} ORDER BY id ASC`).all(...params);
  const out = [];
  for (const r of rows) { try { const o = JSON.parse(r.raw_json); if (o && typeof o === 'object') out.push(o); } catch (_e) { /* 损坏行跳过 */ } }
  return out;
}
```

**2b. `src/main.js:3677` 改为按 Channel 过滤读（不深拷）**：
```js
// v3.0.7 修复：网关账单表（可达数百万行）按 Channel 过滤读，根治内存尖峰。
//   业务不变量（已确认）：对账永远同 Channel → 只读本批银行单出现过的 Channel 子集，绝不漏合法匹配。
//   gwRows 全程只读（R1/R2/R3.5/R5s2/R5s3 仅建索引/比对，modifications 只写 bankRows）+ 每次新解析 → 无需深拷。
//   ⚠️ 银行行 structuredClone(bankStatementSession.rows) 必须保留（常驻 session、引擎原地改它）。
const bankChannels = bankStatementSession.rows.map((r) => (r && r.Channel != null ? String(r.Channel).trim() : ''));
const workingGwRows = database.readGatewayBillRowsByChannels(bankChannels);
```

---

## 四、风险与边界（🔴 资金红线）

### 修复 1
门控谓词必须与编排器消费条件 `r5s4Bucket.length` 逐字等价，否则退款场景启用时会漏读 → 漏退款回填。

### 修复 2（带业务不变量的优化，非纯字节级不变）
若数据真有跨渠道键碰撞，现引擎会产生「跨渠道误匹配」，过滤后会消失——按业务定义那本就是错配、过滤结果才是对的，但确实改变现状输出，须由等价测试 + 业务不变量双重背书。实现必须处理三个陷阱，否则漏匹配：

1. **空 / 缺 Channel**：银行行 Channel 为空时 S 含空值；SQL `json_extract` 对「缺字段」返回 NULL，`NULL IN (...)` 恒 false → 须额外 `OR json_extract(...) IS NULL`（当 S 含空值时），覆盖「网关行缺 Channel 字段」与「Channel=空串」两种。
2. **归一化一致**：S 内 Channel 值与网关 raw_json 存值须同口径（trim、大小写敏感），与引擎 `normalizeCell` 对齐，否则 IN 比对失配。
3. **跨轮不需越界网关行**：逐轮确认无哪一轮会用到「银行单未出现的 Channel」的网关行。初判：R3.5 先过滤 DBS 银行行、无 DBS 银行行即 no-op（安全）；C3 按渠道批处理；R1/R5s2/R5s3 匹配键不含 Channel，但在业务不变量下其合法对手必同 Channel。仍须实现时逐轮钉死。

---

## 五、测试口径

### 已有回归护栏（覆盖修复 1 编排器侧）
- `tests/unit/main-process/reconciliation-orchestrator-refund.test.js:212-233`：空 bucket（退款场景未启用）→ no-op、`depositRows=[]` 安全、行数守恒。
- 同文件 `:135-164`：退款场景启用 + depositRows 传参 → 回填正常流出。

### 需新增 — 修复 1
- 门控谓词断言（unit 或 integration，沿用 `scripts/integration/bank-statement-universal-import-routing.js` 的「镜像 handler 决策」范式）：构造「含/不含 refund-order-backfill 场景」两组 `dispatchScenarios`，断言谓词分别 true/false，且与 `bucketScenarios(...).r5s4.length>0` 一致（钉死同源，防分桶条件改了门控漏更新）。

### 需新增 — 修复 2（核心护栏）
- **仓储单测**（新建 `tests/unit/backend/database/gateway-channel-filter.test.js`）：临时 DB 灌多 Channel 网关行（含 Channel=空串、缺 Channel 字段两种边界），断言 `readGatewayBillRowsByChannels`：① 只回指定 Channel 行；② channels 含空值时回「空串 + 缺字段」行、不含空值时不回；③ 归一化（前后空格/大小写）口径与引擎一致；④ 空集 → `[]`。
- **等价测试（终极安全网）**（新建 `scripts/integration/gateway-channel-filter-equivalence.js`）：代表性数据（覆盖 R1/R2-C3/R3.5/R5s2/R5s3 命中、多 Channel、空 Channel 行）灌网关表，分别用「全表读 `readLinkedTableRows('gateway-bill')`」与「过滤读 `readGatewayBillRowsByChannels(银行单 Channel 集)`」喂同一 `runReconciliation`，断言两路产物（modifiedRows / modifications / stats / unmatchedRows）**逐字节相等**。
- **「网关行只读」不变量**（`tests/unit/main-process/reconciliation-orchestrator.test.js` 加 1 例）：run 前 `structuredClone` 快照 gwRows、run 后 `deepEqual`，证明全程未改写网关行 → 删深拷安全。

### GUI 手测（IPC 层自动化盲点，必补）
1. 准备已灌大量行的 bank-deposit 入金表（复现前置条件）。
2. 关闭退款场景、只留 BOSH-CN → 导入对账单 → 「开始运行」→ 应秒回、不卡；结果表/状态框与修复前一致。
3. 启用退款场景 → 「开始运行」→ 退款回填仍正常命中。
4. 有大网关账单表（多 Channel）时：导入 BOSH 对账单 → 「开始运行」→ 对账结果（R1/R2 命中数、ReconciliationId 回填、unmatched）与修复前完全一致、峰值内存大幅下降。

---

## 六、实施路线（spec 批准后执行；本轮不做）

1. 实现 `readGatewayBillRowsByChannels`（`linked-table-repository.js` + `database.js` facade）。
2. `src/main.js`：3682 加 bank-deposit 门控、3677 改按 Channel 过滤读。
3. 补测试：仓储单测 + 等价集成脚本 + 「网关行只读」不变量断言 + bank-deposit 门控谓词断言。
4. `npm run release-check`（unit + integration + smoke 三层全绿）。
5. `npm run scan:vars` → `npm run check:vars`（核对 `readLinkedTableRows`/`gateway-bill`/`BANK_DEPOSIT_FIELDS`/`refundOrderSession` 等关联 review，产出 PR body 追加段）。

**提交拆 2 个 commit**：
- `[v3.0.7] run 入口 bank-deposit 消费方门控（防整表无谓载入）`
- `[v3.0.7] 网关账单表按 Channel 过滤读（业务不变量：对账同渠道；根治 300 万行尖峰）`

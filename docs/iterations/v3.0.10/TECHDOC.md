# TechDoc - 网银账单生成小助手 v3.0.10（🔴 资金红线：R4 方向守卫 / R5s4 网关前置过滤 / 退款输出改造）

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.10 |
| 日期 | 2026-06-21 |
| 作者 | 架构师（实现侧事实源；定稿后交 Dev 评审 / 实施） |
| 状态 | 初稿（待评审） |
| 关联 PRD | `docs/iterations/v3.0.10/PRD.md` |
| 实施方式 | team-lead 不亲自小步写：**架构师 PRD/TECHDOC → spec（`/propose`）→ 按需求1/2/3 拆子任务委托 dev agent（worktree 隔离并行）**，team-lead 审 diff + `release-check` 兜底；跨接缝处（需求3.1 引擎记列→writer 标黄）重点 codex review（`feedback_multiagent_seam_gap` / `feedback_background_agent_unreliable`） |
| 质量门 | `npm run release-check` 全绿（unit + integration + smoke）；🔴 资金红线（R4 FundType 改写口径 + R5s4 退款筛选口径）须 team-lead 人工复核 + 跨接缝 E2E + `/check-vars` |
| 依赖 | 分支 `v3.0.10`（从 main 建）；`package.json.version` 3.0.9 → 3.0.10，bump 由收口阶段执行（本文档阶段不 bump） |

> **来源 plan（唯一事实源）**：本迭代已批准实施方案（plan）——Context + 全部已锁定决策表 + 需求1/2/3 file:line 级设计 + D8 修订 + 逐策略标黄映射表 + 测试与验收（产品层规范见 `docs/iterations/v3.0.10/PRD.md`）。
>
> 本 TechDoc 以 plan 为设计事实源；**所有改动点的 file:line 由架构师当面 Read 核实当前工作树**（出处优先）。与 plan 行号的出入见 §十二实施日志末「核实记录」。
>
> 🔴 **资金红线提醒**：本迭代改 R4 二次改写银行 `FundType` 的口径（加方向守卫）+ R5s4 退款回填筛选口径（加网关前置过滤），且需求3.1 是**跨接缝**改动（引擎记命中列 → writer 标黄）。按经验跨接缝最易出致命 bug —— 实现后必须补端到端测试 + codex review 兜底（见 §九、§十一）。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | 评审 |
|---------|------|
| 需求1 R4 方向守卫 | 引擎主循环 `runRound4FundNatureCheck`（`r4-fund-nature-check.js:138-153`）已是「关联命中 → 逐 handler 改写」结构，方向守卫插在 `applyHandler` 返回非空之后、原地改写之前即可；`parseNumber` 已由 `engine-utils.js:143` 导出、`makeWarningCollector` 已由 :140 导出（引擎已 import warningCollector，:38），落地无障碍 |
| 需求1 config schema | 4 个 R4 子场景 seed 已集中在 `migrations.js RECON_ROUND_BUILTIN_SCENARIOS`（:1457-1520），各加一行 `requireBankZeroField` 即可；既有 `applyHandler` 不读金额，新字段对老逻辑零副作用 |
| 需求1 老库迁移 | `ensureFundTypeAchReturnConfigMigration`（`migrations.js:2307-2346`）是现成的「精确定位 scenarios.config_json + 事务 + 幂等」范式，新增 `ensureR4DirectionGuardConfigMigration` 照搬即可；注册三点（database.js require/薄壳/调用 + migrations.js 导出）均有现成对位 |
| 需求1 warning 落盘 | 全链路已通：`r4.warnings` → `allWarnings`（`reconciliation-orchestrator.js:349`）→ `errorReport`（:491）→ `writeErrorReportOutput`（`bank-statement-io.js:252-278`，按 rowId enrich ReconciliationId）→ `writeErrorReport`（`exceljs-writer.js:338-361`）。新 warning 只需补 `error-causes.js` 一条 `CAUSE_MAP` |
| 需求2 网关前置过滤 | `r5-refund-order-backfill.js` 主函数已收 `options`（:569/:580），编排器 `safeGwRows` 已就绪（:279）；bankPool 筛选在单处（:590-592），追加第3道筛 + 建 `gwReconidSet` 即可，旁路引擎不破审计不变量 |
| 需求3.1 sheet1 标黄 | matcher 产 hit 处统一 `hits.push({...})`（9 处，:198/:216/:239/:324/:404/:424/:471/:522/:540），附 `_matchedColumns` + `buildBackfillRow`（:146）单点收口过滤即可；export 浅拷贝 `{...r}`（`main.js:4047-4048`）天然保 `_` 字段（既有 `_bridgeDepositBizId` 已走此路，:4069），writer 标黄循环可仿 `exceljs-writer.js:298-304` |
| 需求3.2 sheet2 改造 | `UNMATCHED_HEADERS`（`refund-backfill-writer.js:37-42`）+ `projectRow`（:45-47）投影逻辑改表头数组即生效；前缀单点加在 `buildUnmatchedBankRow`（:172），删 refund-only 两段循环（:674-683 / :850-858）边界清晰 |

### 1.2 技术意见 / 风险提醒

| 编号 | 评审 | 处理 |
|------|------|------|
| R-1 | 🔴 **资金红线（R4 改写口径收紧）**：方向守卫直接决定「命中后改不改 `FundType`」。守卫误判会把本该改写的行漏改（漏改 = 资金性质不准）或把不该改的误判方向不符（误拦）。守卫的「应为0」判据必须与全仓 `parseNumber(x) \|\| 0 === 0` 口径逐字一致 | §三需求1：守卫只用 `(parseNumber(bankRow[zf]) \|\| 0) !== 0` 判方向不符；空/garbage 当 0 = 满足、不拦截；4 子场景 `requireBankZeroField` 映射逐字对齐 PRD 原文（入账性质要求 Debit=0、出账性质要求 Credit=0）；补 §⑧ 全覆盖单测 + codex review |
| R-2 | 🔴 **守卫必须放主循环、不能放 `applyHandler`**：`applyHandler` 是纯函数、无 warningCollector 权，且**无法区分**「gwTradeType 没匹配（返回 null）」与「匹配了但方向不符」——只有后者才该 warn。放进 `applyHandler` 会把两种情形混淆，要么漏 warn、要么对未命中行误 warn | §三需求1：守卫放主循环 `applyHandler` 返回非空之后（:141-142 之间）；`applyHandler` 职责不变（不读金额），补单测断言 `applyHandler` 不读金额列的职责分离 |
| R-3 | 🔴 **老库守卫静默失效**：`ensureReconRoundBuiltinScenariosSeed`「已存在则跳过 + 全局 marker 短路」（marker `recon_round_builtin_scenarios_seeded`，:1456）→ 老库 4 个 R4 场景 config 拿不到新字段 `requireBankZeroField` → 守卫读到 `undefined` → 整层方向守卫静默不生效。这是资金红线必须堵的缝 | §三需求1：新增 `ensureR4DirectionGuardConfigMigration`（无 marker、每次启动幂等补缺失字段、**绝不覆盖用户已改值**、事务包裹、表不存在 no-op）；注册在 `retireChargeOutboundOrphans` 之后；新建 `migrations-r4-direction-guard.test.js` |
| R-4 | 🔴 **资金红线（R5s4 筛选口径收紧）**：网关前置过滤会把「命中网关 reconid 的 Ach Return 银行行」静默移出退款池。若匹配键大小写/字段名错位（网关 `reconciliationid` 小写 vs 银行 `ReconciliationId` 驼峰），会误移出本该退款回填的行（漏回填）或漏移出（无害 no-op 不闭合）。资金红线偏「漏回填」风险 | §三需求2：匹配键严格 `bank.ReconciliationId ∈ Set(网关 reconciliationid)`，引擎内定义局部常量 `GW_RECON_ID_FIELD='reconciliationid'`（小写）+ 注释；空键不参与；补「命中静默移出 / 大小写敏感 / 空键不参与 / 缺省退化」单测 |
| R-5 | 🔴 **跨接缝盲区（需求3.1）**：matcher 产候选列 → `buildBackfillRow` 单点过滤收口 → export 浅拷贝存活 → writer 标黄（列偏移 `colIdx+1`），4 段跨 3 文件。逐文件 review 看不见接缝，列偏移错 1 会标错列（资金审计误导）| §九：补**跨接缝 E2E**（引擎产 backfillRows 含 `_matchedColumns` → `{...r}` 浅拷贝 → `writeRefundBackfillOutput` → ExcelJS 读回断言标黄列正确）；逐策略 `_matchedColumns` 链断言；codex review |
| R-6 | **审计不变量收窄（需求2 + 需求3.2）**：需求2 被 drop 的银行行不进 bankPool（与「FundType≠Ach Return 不进池」同级，旁路不破行数守恒）；需求3.2 删 refund-only 收尾后，「每条 SUBMITTED refund 必落三者之一」不变量收窄为「银行侧全覆盖」。须文档化 + 重写 §⑩ 不变量组测试 | §三需求2/3.2：不变量论证落文档（:638-639 注释补 v3.0.10 收窄说明）；`r5-refund-order-backfill.test.js` §⑩ 不变量组重写（refund-only 不再产行）|
| R-7 | **YELLOW_FILL 单一真相**：退款 writer 标黄需 `YELLOW_FILL` 常量，但 writer 不应跨 main-process 模块 import `exceljs-writer.js`（耦合）| §三需求3.1：退款 writer 顶部**就地定义**同字面 `YELLOW_FILL`（`{type:'pattern',pattern:'solid',fgColor:{argb:'FFFFFF00'}}`）+ 注释指向 `exceljs-writer.js:24-28` 单一真相；测试断言 argb `FFFFFF00` |
| R-8 | **核兼容测试连带影响**：删 refund-only 行 + 文案加前缀会动到既有断言（`reconciliation-orchestrator-refund.test.js` 的 refund-only/结果类型断言、codex-fixes 文案断言）；`buildUnmatchedBankRow` 须**保留 row 上 `结果类型` key**（仅不进 sheet2 投影），以兼容引擎内部 `filter(x=>x['结果类型']===...)` | §九：核兼容测试按需微调（不放松资金断言）；`buildUnmatchedBankRow` 保留 `结果类型` key（前缀只加在 `报错/提示信息`）|

### 1.3 与 PRD 的差异

无。所有技术实现与 PRD 描述一致。PRD 关键决策表（含 D8 修订）= 本 TechDoc 设计前提，逐条落地。

---

## 二、涉及的文件清单

### 2.1 源码（8 个）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/database/migrations.js` | 修改 | (a) `RECON_ROUND_BUILTIN_SCENARIOS`（:1457-1520）4 子场景各加 `requireBankZeroField`；(b) 新增 `ensureR4DirectionGuardConfigMigration(db)`（范式照搬 `ensureFundTypeAchReturnConfigMigration`:2307-2346）；(c) `module.exports`（:3438 块）导出新函数 |
| `src/backend/database.js` | 修改 | require（:59 区）+ 薄壳方法（:1073 区）+ 调用（插在 :380 `retireChargeOutboundOrphans` 之后、:384 `ensureFundTypeAchReturnConfigMigration` 同段）|
| `src/main-process/scenario-engines/r4-fund-nature-check.js` | 修改 | 主循环（:138-151 内层）加方向守卫 + warning；顶部 import 加 `parseNumber`（:35-39 解构）|
| `src/backend/file-service/error-causes.js` | 修改 | `CAUSE_MAP`（:11-50）加 `'r4-fund-direction-mismatch'` 文案 |
| `src/main-process/reconciliation-orchestrator.js` | 修改 | R5s4 调用（:468-473）第4参由 `{ isFundTypeChanged }` → `{ isFundTypeChanged, gwRows: safeGwRows }`（safeGwRows :279 已就绪）|
| `src/main-process/scenario-engines/r5-refund-order-backfill.js` | 修改 | (a) 网关前置过滤（建 `gwReconidSet` + bankPool 第3道筛 :590-592）；(b) 各 matcher hit 附 `_matchedColumns` + `consumeAndBackfill`/`buildBackfillRow` 透传 + 单点过滤；(c) `buildUnmatchedBankRow`（:172）前缀；(d) 删 refund-only 两段循环（:674-683 / :850-858）|
| `src/constants/refund-backfill-fields.js` | 修改 | **退款输出细化**：`REFUND_BANK_COLUMNS` 10→12（按 `BANK_STATEMENT_FIELDS` 模板序插 `Extra Information`、`Drawee Name`），随之 `REFUND_TEMPLATE_HEADERS` 31→33；两列均 ∈ `BANK_STATEMENT_FIELDS`，启动期断言①（:159-166）自动通过；上方注释（O3）由 9→10 描述改 12 列、说明新增两列用途 |
| `src/main-process/refund-backfill-writer.js` | 修改 | (a) sheet1 写循环（:88-101）标黄（就地定义 `YELLOW_FILL`，sheet1 表头随常量自动 33 列）；(b) `UNMATCHED_HEADERS`（:44-47）= `[...REFUND_BANK_COLUMNS, '报错/提示信息']`：删「结果类型」+「退款单号」、银行段随常量补 2 列 → 13 列 |

### 2.2 无需改动（已验证）

| 文件 | 验证结论 |
|------|---------|
| `src/main.js` | 退款回填 export 浅拷贝 `processingResult.refundBackfillRows.map((r) => ({ ...r }))`（:4047-4048）天然保留 `_matchedColumns`（与既有 `_bridgeDepositBizId` 同路，:4069 已读取该路拷贝行）；`writeRefundBackfillOutput` 调用（:4093-4097）不变 → **一行不改** |
| `src/constants/refund-backfill-fields.js` | ~~需求3.2 不删 sheet1 列 → 不改~~。**退款输出细化已改**（见 §2.1）：`REFUND_BANK_COLUMNS` 10→12、`REFUND_TEMPLATE_HEADERS` 31→33；列序、断言、传播详见 §五。 |
| `src/main-process/bank-statement-io.js` | `writeErrorReportOutput`（:252-278）enrich + 落盘逻辑通用，新 warning 自动走通 → **不改** |
| `src/main-process/exceljs-writer.js` | 主错误报告 writer + `YELLOW_FILL`（:24-28）单一真相；退款 writer 就地复制常量而非 import 它 → **不改** |

### 2.3 测试

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `tests/unit/.../r4-fund-nature-check.test.js`（现有路径）| 修改 | 新增 §⑧ 方向守卫组 + `applyHandler` 不读金额职责分离断言 |
| `tests/unit/.../migrations-r4-direction-guard.test.js` | 新增 | 老库补字段 / 幂等 / 不覆盖用户值 / 不误伤 / 表不存在 |
| `tests/unit/.../migrations-recon-round-seed.test.js` | 修改 | EXPECTED 表 4 行加 `requireBankZeroField` 期望 |
| `tests/unit/.../error-causes.test.js` | 修改 | 新 code 文案断言 |
| `tests/unit/.../r5-refund-order-backfill.test.js` | 修改 | 网关前置过滤组 + `_matchedColumns` 逐策略链断言 + §⑩ 不变量组重写 + 文案前缀 |
| `tests/unit/.../refund-backfill-writer.test.js` | 修改 | sheet2 13 列（银行 12 + 信息，删结果类型/退款单号）/ sheet1 33 列 / 删旧 notice 行造型 / 标黄断言（含 Extra Information/Drawee Name/S4 八列）/ 空表头 |
| `scripts/integration/refund-backfill-yellow-fill-e2e.js`（或纳入现有退款集成）| 新增 | 跨接缝 E2E：引擎→浅拷贝→writer→ExcelJS readback 断言标黄列 |
| 核兼容（按需微调）| 修改 | `r5-refund-order-backfill-codex-fixes.test.js`（文案前缀）/ `-open7-hits.test.js`（确认 `_bridgeDepositBizId` 零破坏）/ `reconciliation-orchestrator-refund.test.js`（refund-only / 结果类型断言）|

> 测试文件具体目录以实施期 `find tests/unit -name '<name>'` 实测为准（现有命名约定）。

---

## 三、需求 1：R4 资金性质校验加方向守卫（🔴 资金红线）

### 3.1 实现方案

R4（`runRound4FundNatureCheck`）目前**方向不敏感**：命中网关 TradeType 即把关联银行行 `FundType` 改写为对应资金性质，不看银行行借贷方向。需求要求命中后再加一层**银行行借贷方向守卫**——若「应为0」的金额列实际非0（方向录反），则**不改写 + 记 warning**（B 决策：warning 进主错误报告文件）。

**为什么守卫放主循环、不放 `applyHandler`（R-2 的核心论证）**：
- `applyHandler`（:55-78）是纯函数，无 `warningCollector` 权。
- `applyHandler` 返回 `null` 有**两种语义**：① `config.gwTradeType` 与网关 TradeType 不匹配（根本没命中本子场景）；② 其它不命中。这两种都**不该 warn**（不是方向问题）。只有「命中了本子场景（`applyHandler` 返回非空 setFundType）但方向不符」才该 warn。
- 把方向判据塞进 `applyHandler` → 无法区分「没命中」和「命中但方向不符」，要么对未命中行误 warn、要么彻底丢失 warn。
- 故守卫必须放在主循环里 `applyHandler` 返回**非空**之后（拿到 `decision`），此时才有「确实命中」的事实 + warningCollector 在手。

**「应为0」口径**（与全仓一致）：`(parseNumber(x) || 0) === 0`。空/garbage 解析为 0 → 当作满足、不拦截；只有解析出真实非0数值才判方向不符。资金红线偏保守，但此口径与 R5/S4 等全仓 `parseNumber||0` 一致，不引入新口径分叉。

### 3.2 config schema：4 子场景加 `requireBankZeroField`

`migrations.js RECON_ROUND_BUILTIN_SCENARIOS`（:1457-1520）4 个 R4 子场景各加一行：

| subCategory | seed 行 | setFundType | 新增字段 | 方向语义 |
|---|---|---|---|---|
| ach-return | :1460-1473 | Ach Return | `requireBankZeroField: 'Credit Amount'` | 出账性质 → 要求 Credit=0 |
| wire-return | :1474-1487 | Wire Return | `requireBankZeroField: 'Debit Amount'` | 入账性质 → 要求 Debit=0 |
| hx-out | :1493-1506 | HX-out | `requireBankZeroField: 'Credit Amount'` | 出账性质 → 要求 Credit=0 |
| hx-in | :1507-1520 | HX-in | `requireBankZeroField: 'Debit Amount'` | 入账性质 → 要求 Debit=0 |

规律：**入账性质**（Wire Return / HX-in）要求 `Debit Amount=0`；**出账性质**（Ach Return / HX-out）要求 `Credit Amount=0`。逐字对齐 PRD 需求原文。每条 `config.function` 中文描述末补一句方向守卫语义（如「…命中后若银行行 Credit Amount 非0（方向录反）则不改写并记 warning」）。

### 3.3 一次性幂等迁移：`ensureR4DirectionGuardConfigMigration`（资金红线必需）

**为什么需要**（R-3）：`ensureReconRoundBuiltinScenariosSeed`（`migrations.js:1584`）凭「已存在跳过 + 全局 marker `recon_round_builtin_scenarios_seeded` 短路」(:1456)，老库 4 个 R4 场景 config 拿不到新字段 → 守卫读 `undefined` → 整层方向守卫静默失效。必须新增独立迁移补字段。

范式照搬 `ensureFundTypeAchReturnConfigMigration`（:2307-2346）：

```javascript
// v3.0.10 需求1：R4 方向守卫 config 字段补种（🔴 资金红线 — 老库 4 个 R4 场景缺 requireBankZeroField 则守卫静默失效）。
//   范式同 ensureFundTypeAchReturnConfigMigration：精确定位 scenarios.config_json + JSON.parse + 事务 + 幂等。
//   ⚠️ 无 marker（每次启动幂等补缺失字段）；🔴 绝不覆盖用户已改的值（已存在 requireBankZeroField → 跳过）。
const R4_DIRECTION_GUARD_FIELD = 'requireBankZeroField';
const R4_DIRECTION_GUARD_BY_SUBCATEGORY = Object.freeze({
  'ach-return': 'Credit Amount',
  'wire-return': 'Debit Amount',
  'hx-out': 'Credit Amount',
  'hx-in': 'Debit Amount'
});

function ensureR4DirectionGuardConfigMigration(db) {
  let updated = 0;
  let scanned = 0;
  const select = (() => {
    try {
      return db.prepare(`SELECT id, config_json FROM scenarios WHERE config_json LIKE ?`);
    } catch (_e) { return null; } // scenarios 表不存在（极早期启动）→ 跳过，下次启动重试
  })();
  if (!select) return { status: 'no-op', scanned: 0, updated: 0 };

  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const [subCat, zeroField] of Object.entries(R4_DIRECTION_GUARD_BY_SUBCATEGORY)) {
      const rows = select.all(`%"subCategory":"${subCat}"%`);
      for (const row of rows) {
        scanned += 1;
        let cfg;
        try { cfg = JSON.parse(row.config_json); } catch (_e) { continue; } // 非法 JSON 跳过（防御）
        if (!cfg || cfg.subCategory !== subCat) continue;                   // 精确匹配（LIKE 仅粗筛）
        // 🔴 已存在则跳过（绝不覆盖用户改值；唯有缺失才补）
        if (Object.prototype.hasOwnProperty.call(cfg, R4_DIRECTION_GUARD_FIELD)) continue;
        cfg[R4_DIRECTION_GUARD_FIELD] = zeroField;
        update.run(JSON.stringify(cfg), now, row.id);
        updated += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { status: updated > 0 ? 'migrated' : 'no-op', scanned, updated };
}
```

**注册三点**（对位现有 `ensureFundTypeAchReturnConfigMigration`）：
- `database.js` require：:59 区解构加 `ensureR4DirectionGuardConfigMigration`。
- `database.js` 薄壳方法：:1073 区加 `ensureR4DirectionGuardConfigMigration() { return ensureR4DirectionGuardConfigMigration(this.db); }`。
- `database.js` 调用：插在 :380 `this.retireChargeOutboundOrphans();` 之后（与 :384 `ensureFundTypeAchReturnConfigMigration` 同 scenarios 迁移段；前置 scenarios 表已存在、内置场景已 seed）。
- `migrations.js` 导出：:3438 `module.exports` 块加 `ensureR4DirectionGuardConfigMigration`。

**幂等性保证**：二次跑时所有 R4 场景 config 已含 `requireBankZeroField` → 全部命中「已存在跳过」分支 → `updated=0` → `status='no-op'`。表不存在 → `select` 构建失败 → 直接 no-op（下次启动重试）。**不覆盖用户值**：用 `hasOwnProperty` 判存在（即便用户把值改成空串 `''` 也保留，不补回）。

### 3.4 引擎改动：`r4-fund-nature-check.js` 主循环加守卫

改动点在主循环最内层（当前 :138-151）。原结构：

```javascript
for (const bankRow of relatedBankRows) {
  for (const scenario of scenariosSorted) {
    const decision = applyHandler(gwRow, bankRow, scenario.config); // 命中 → 目标 FundType；否则 null
    if (decision === null || decision === undefined) continue;
    // 原有改写逻辑（:144-149）...
  }
}
```

改为（守卫插在 `if (decision == null) continue;` 之后、原改写逻辑之前）：

```javascript
for (const bankRow of relatedBankRows) {
  for (const scenario of scenariosSorted) {
    const decision = applyHandler(gwRow, bankRow, scenario.config);
    if (decision === null || decision === undefined) continue;   // gwTradeType 没匹配 → 静默不 warn（R-2）

    // ===== v3.0.10 需求1：银行行借贷方向守卫（🔴 资金红线）=====
    //   命中本子场景后，若「应为0」的金额列实际非0（方向录反）→ 不改写 + 记 warning（B 决策）。
    //   口径 (parseNumber(x) || 0) === 0：空/garbage 当 0 = 满足、不拦截（与全仓一致）。
    const zf = scenario.config.requireBankZeroField; // 'Debit Amount' | 'Credit Amount' | undefined
    if (zf === 'Debit Amount' || zf === 'Credit Amount') {
      if ((parseNumber(bankRow[zf]) || 0) !== 0) {
        warningCollector.push({
          rowId: bankRow._rowId,
          code: 'r4-fund-direction-mismatch',
          message: `银行行(${bankRow._rowId}) 命中资金性质「${decision}」(${scenario.config.subCategory}) 但 ${zf} 非0，方向不符，跳过改写`
        });
        continue; // 不改写；叠加链下每 handler 各判各的（本 handler 跳过，不影响其它 handler）
      }
    }

    // ===== 原有改写逻辑（:144-149 零改动）=====
    const oldValue = normalizeCellValue(bankRow[BANK_FUND_TYPE_FIELD]);
    if (oldValue !== decision) {
      bankRow[BANK_FUND_TYPE_FIELD] = decision;
      modCollector.record(bankRow._rowId, BANK_FUND_TYPE_FIELD, oldValue, decision);
    }
    // 不 break —— 后续 handler 可在已改值基础上再改（R4 唯一允许二次改 FundType）
  }
}
```

- 顶部 import（:35-39 解构）加 `parseNumber`：`const { normalizeCellValue, makeModificationCollector, makeWarningCollector, parseNumber } = require('./engine-utils');`（`parseNumber` 已由 engine-utils.js:143 导出）。
- `warningCollector` 已存在（:91 `makeWarningCollector('R4', '资金性质校验')`），直接 push。

### 3.5 叠加链行为 + no-op 交互

- **叠加链**：某 handler 命中但方向不符 → 该 handler `continue`（不改、push warn），停在上一跳的值；后续 handler 仍各自判定（各判各的方向）。不是「一旦不符整行不再改」——是「该 handler 这一跳不改」。
- **no-op 交互**：方向满足但 `oldValue === decision`（已是目标值）→ 走原 no-op 分支，不 warn 不 record（既有语义不变；方向守卫只在「确实要改」前拦，不影响 no-op）。
- **空 `requireBankZeroField`**（老库未迁移、或被用户清空）→ `zf` 不等于两个合法值 → 跳过守卫、走原改写（守卫退化为「不生效」，但迁移已保证正常库不会到这分支）。

### 3.6 warning 落盘（已验证全链路）

`r4.warnings`（warningCollector.list()，:159）→ 编排器 `allWarnings.push(...(r4.warnings))`（`reconciliation-orchestrator.js:349`）→ return `errorReport: allWarnings`（:491）→ `writeErrorReportOutput({ warnings, ..., bankRows })`（`bank-statement-io.js:252-278`，:265-269 按 `rowId` enrich 出 `reconciliationId`）→ `writeErrorReport`（`exceljs-writer.js:338-361`）。

- **落位**：`Documents/网银账单生成小助手/error-reports/{YYYY-MM-DD}/{时间戳}-error-report.xlsx`，5 列 `时间戳 | 场景名 | 对账ID | 原因 | 可能原因`（`exceljs-writer.js:342`）。场景名 = "资金性质校验"（warningCollector 第2参，r4 引擎 :91）。「对账ID」列由 enrich 出的 ReconciliationId 经 `resolveReconIdCell`（:321-329）三级回退填。
- **新增 cause 映射**：`error-causes.js CAUSE_MAP`（:11-50）加：

```javascript
'r4-fund-direction-mismatch': '资金性质命中但银行行借贷方向不符（应为0的金额列非0），已跳过该行资金性质改写，请人工核对方向',
```

### 3.7 注意事项

- 守卫读的是银行行**原始列**（`bankRow['Debit Amount']` / `bankRow['Credit Amount']`），不是归一化后值；`parseNumber` 自带解析逻辑（千分位等由 engine-utils.js:20 处理）。
- warning message 用 `bankRow._rowId`（与全仓 warning 一致，落盘时 enrich 成 ReconciliationId）。
- 守卫只在 4 个有 `requireBankZeroField` 的子场景生效；其它无该字段的内置/用户场景（如 R5 platform-order）零影响。

---

## 四、需求 2：R5s4 退款回填加网关前置过滤（🔴 资金红线）

### 4.1 实现方案

R5s4（`runRound5RefundOrderBackfill`）目前筛银行候选只看 `FundType==='Ach Return' && !isFundTypeChanged`（:590-592）。需求要求：银行行先和网关单做一次 reconid 匹配，**命中网关的静默移出退款池**——这些行已能和网关对账，不该再走退款回填（顺手闭合已知的 no-op 缝隙）。

**匹配键**（D 决策：全新 reconid 集合命中）：`bank.ReconciliationId ∈ Set(网关所有 reconciliationid)`。
- 网关侧字段：`reconciliationid`（**小写**，真实表头）。
- 银行侧字段：`ReconciliationId`（**驼峰**），即 `M.backfill.fromBankReconId`（值 = `'ReconciliationId'`，`refund-backfill-fields.js:55`）。
- 大小写敏感（沿用 `normalizeCellValue` 仅 trim，不改大小写）。

**命中后**（决策：静默移出）：不回填、不进 sheet2、不留痕。

### 4.2 接线：编排器传 gwRows

`reconciliation-orchestrator.js` R5s4 调用（:468-473）：

```javascript
const r5d = runRound5RefundOrderBackfill(
  bankRows,
  (refundContext && refundContext.refundOrderRows) || [],
  (refundContext && refundContext.depositRows) || [],
  { isFundTypeChanged, gwRows: safeGwRows }   // v3.0.10 需求2：加 gwRows（safeGwRows 在 :279 已就绪）
);
```

`safeGwRows`（:279 `Array.isArray(gwRows) ? gwRows : []`）是网关全量行（R1 入参同源），含 `reconciliationid`。

### 4.3 引擎内：建集合 + bankPool 第3道筛

`r5-refund-order-backfill.js`：

```javascript
// 文件头（:6-8 业务语义段）注释补「v3.0.10 需求2：网关前置过滤——命中网关 reconid 的 Ach Return 行静默移出退款池」。

// 引擎内局部常量（显式映射，绝不假设同名；网关侧小写 reconciliationid）
const GW_RECON_ID_FIELD = 'reconciliationid'; // 网关行：真实表头小写（与 r4 引擎同名常量同值）

// 主函数 runRound5RefundOrderBackfill 内（:580 options 解构区之后、:582 后）：
const safeGwRows = Array.isArray(options.gwRows) ? options.gwRows : [];
const gwReconidSet = new Set(
  safeGwRows
    .map((g) => normalizeCellValue(g && g[GW_RECON_ID_FIELD]))
    .filter((k) => k !== '')
);

// bankPool 第3道筛（:590-592 现有筛后追加）：
const bankPool = safeBankRows.filter((b) => {
  if (normalizeCellValue(b[M.filter.bankFundType]) !== M.filter.achReturn) return false; // 道1：FundType
  if (isFundTypeChanged(b._rowId)) return false;                                          // 道2：未被 R4 改写
  // 道3（v3.0.10 需求2）：命中网关 reconid → 静默移出（已能与网关对账，不走退款回填）
  const bankRecon = normalizeCellValue(b[M.filter.bankReconId]); // = 'ReconciliationId'，见下
  if (bankRecon !== '' && gwReconidSet.has(bankRecon)) return false;
  return true;
});
```

> **字段引用**：银行侧 reconid 列名用 `M.backfill.fromBankReconId`（= `'ReconciliationId'`）或新增 `M.filter.bankReconId` 别名（实施期二选一，保证值 = `'ReconciliationId'` 即可）。空键（`bankRecon===''`）不参与命中判定（与网关空键 filter 对称）。

### 4.4 不破审计不变量论证

- 过滤发生在「**入池前**」——被 drop 的银行行根本没进 `bankPool`，与「`FundType ≠ Ach Return` 不进池」「被 R4 改写不进池」**同级**（都是入池前的筛选条件）。
- R5s4 是**退款引擎旁路**：不进 `modifiedRows` / `unmatchedRows` 分区（编排器 :453-478 明示「数据隔离，只读 bankRows，不改字段、不产 modifications」），故行数守恒 `modifiedRows + unmatchedRows === bankRows.length`（编排器 :456 注释）**不受影响**。
- 被 drop 的行既不进退款 sheet1 也不进退款 sheet2（静默移出，无 notice 行）——这正是「已能与网关对账，无需退款人工介入」的语义。

### 4.5 注意事项

- 缺省退化：`options.gwRows` 未传（旧调用方 / 测试）→ `safeGwRows=[]` → `gwReconidSet` 为空 → 道3 永不命中 → 退化为「无网关前置过滤」（与现状一致）。须有「缺省退化」单测锁。
- 大小写敏感：网关 `reconciliationid` 与银行 `ReconciliationId` 经 `normalizeCellValue` 仅 trim 后**严格等值**比对（不改大小写）。须有「大小写敏感（同字符不同大小写不命中）」单测。
- 被 drop 致三元组只剩 refund：某唯一值下银行行被全部 drop → 该组退化为 refund-only（需求3.2 已删 refund-only 收尾，故不产 notice，与需求3.2 一致）。须有联动单测。

---

## 五、需求 3.1：sheet1 标黄命中字段（交集标黄，跨接缝）

### 5.1 跨接缝传递链（matcher → buildBackfillRow → export → writer）

🔴 这是本迭代最高风险段（R-5）。完整链路（4 段跨 3 文件）：

```
matcher 产 hit（9 处 hits.push）
  → hit._matchedColumns = [候选比对列...]（诚实列出，可含不在 sheet1 的字段）
    → consumeAndBackfill(:955；backfillRows.push :964) 透传 hit._matchedColumns
      → buildBackfillRow(:164) 末位参 matchedColumns，单点收口过滤(:189-191) → row._matchedColumns（仅 sheet1 列、去重、非空才挂）
        → export 浅拷贝 {...r}（main.js:4048）自动保 _matchedColumns（不改 orchestrator/main.js）
          → writeRefundBackfillOutput → sheet1 写循环（refund-backfill-writer.js:88-101，getCell :97）标黄（colIdx+1）
```

### 5.2 matcher 产 `_matchedColumns`（候选）

各 matcher 在 `hits.push({...})`（:226/:245/:272/:360/:444/:464/:516/:571/:598）时附 `_matchedColumns`——**候选**比对列数组（诚实列出实际参与匹配的列，可含不在 sheet1 的字段，由下游单点过滤丢弃）。逐策略候选列与实际标黄列（★=不在 `REFUND_TEMPLATE_HEADERS`、过滤后丢弃）：

> **v3.0.10 退款输出细化**：`REFUND_BANK_COLUMNS` 由 10 → 12（按 `BANK_STATEMENT_FIELDS` 模板序插 `Extra Information`、`Drawee Name`），故这两列现已 ∈ sheet1（下表去掉它们的 ★）；各 matcher 候选逻辑**不动**，靠列加入 sheet1 让交集过滤自然保留 → 命中即标黄。S4 候选由 `[BillDate, valueDate]` 扩为按命中详情文案口径的 8 列。

| 策略 | matcher 函数:行 | `_matchedColumns` 行 | 候选比对列（★=不在 sheet1） | 实际标黄 sheet1 列 |
|---|---|---|---|---|
| S1 | `matchS1`:217 | :226 | 命中的 ChannelOrderNo 或 CustomerRef + 银行打款流水号 | 两者（ChannelOrderNo/CustomerRef ∈ 银行段，银行打款流水号 ∈ ro 段）|
| S2-MTX | `matchS2Mtx`:235 | :245 | Extra Information + 附言 | Extra Information + 附言（两列均 ∈ sheet1）|
| S2 JPM-HK | `matchJpmHk`:339 | :360 | 命中的 Payment Detail / Extra Information + 银行打款流水号 | 银行打款流水号 + 命中的 Payment Detail / Extra Information |
| S2 JPM-US / R3 二跳 | `matchCustomerRefTwoHop`:256 | :272 | CustomerRef + 入金 CustomerRef★ | CustomerRef |
| S2b | `matchMemoContainsDepositRef`:408 | :444 | 命中的 memoField（Payment Detail / Extra Information）+ 入金 CustomerRef★ | 命中的 memoField（两者均 ∈ sheet1）|
| S3 | `matchS3`:454 | :464 | Drawee Name / 卡号★ + 命中位 付款人名称/付款卡号/虚拟卡号 | 命中位 RO 列 +（命中位为付款人名称时）Drawee Name |
| S3b | `matchDraweeNameDate`:494 | :516 | Drawee Name（门）+ memoField + 入金 ValueDate★ | Drawee Name + 命中的 memoField |
| S3c | `matchMemoDateAmount`:540 | :571 | memoField + 入金 ValueDate★/Credit Amount★/Currency★ | 命中的 memoField |
| S4 | `matchS4`:582 | :598-601 | 按命中详情文案展开 8 列（bank `BillDate`/`MerchantId`/`Debit Amount`/`Currency` + ro `valueDate`/`银行大账号`/`退款金额`/`币种`，全 ∈ sheet1）| 同左 8 列（bank 4 + ro 4）|

> **零交集不会发生**：每命中至少标到一个 RO 侧锚点列 ∈ sheet1（S1/S3 命中 RO ID 列、S2 系命中 ro 附言/打款流水号、S4 标 8 列）。命中即停（`strategyChain` 逐层、命中 settle）→ 单行只来自单一策略，无需合并多策略列集。

> **REFUND_TEMPLATE_HEADERS 成员判定基准**（`refund-backfill-fields.js:144-148`，v3.0.10 33 列）：固定6（退款单号/状态/渠道流水号/渠道退款时间/命中类型/匹配命中详情）+ 银行**12**（BillDate/Channel/地区/MerchantId/Currency/Debit Amount/ReconciliationId/ChannelOrderNo/CustomerRef/**Extra Information**/Payment Detail/**Drawee Name**，`REFUND_BANK_COLUMNS`:125-132，按 `BANK_STATEMENT_FIELDS` 模板序 CustomerRef=idx13→Extra Information=idx18→Payment Detail=idx19→Drawee Name=idx22 排列）+ ro15（流水号/加款单号/渠道名称/银行大账号/虚拟卡号/原加款金额/退款金额/币种/付款人名称/付款卡号/附言/客户号/账户号/银行打款流水号/valueDate，:136-140）。
> → 故「附言」「银行打款流水号」「valueDate」「付款人名称/付款卡号/虚拟卡号」「BillDate」「ChannelOrderNo/CustomerRef」「Payment Detail」「**Extra Information**」「**Drawee Name**」「MerchantId」「Currency」「Debit Amount」「银行大账号」「退款金额」「币种」**∈ sheet1**；「Drawee CardNo」「Payee CardNo」「入金 CustomerRef/ValueDate/Credit Amount/Currency」**∉ sheet1**（★ 过滤丢弃）。

### 5.3 buildBackfillRow 单点收口过滤

`consumeAndBackfill`（:955-964）透传 `hit._matchedColumns` 给 `buildBackfillRow`；`buildBackfillRow`（:164）加末位参 `matchedColumns`，**单点收口过滤**（仿 `_bridgeDepositBizId` 非空才挂，:182-185）：

```javascript
// consumeAndBackfill（:964）：
backfillRows.push(buildBackfillRow(hit.refundRow, bankRow, hit.detail, hitType, bridgeBizId, hit && hit._matchedColumns));

// buildBackfillRow（:164 签名 + :186-192 交集过滤区）：
function buildBackfillRow(refundRow, bankRow, detailText, hitType, bridgeDepositBizId, matchedColumns) {
  const row = { /* ...固定6 + 银行12（含 Extra Information/Drawee Name）+ ro15 不变... */ };
  // OPEN-7 内部字段（:182-185 不变）
  if (bridgeDepositBizId !== undefined && bridgeDepositBizId !== null && bridgeDepositBizId !== '') {
    row._bridgeDepositBizId = bridgeDepositBizId;
  }
  // v3.0.10 需求3.1：交集标黄——只挂「既参与匹配、又在 sheet1 列」的字段（去重）；零交集不挂（仿 _bridgeDepositBizId 非空才挂）。
  if (Array.isArray(matchedColumns)) {
    const inSheet1 = [...new Set(matchedColumns.filter((c) => REFUND_TEMPLATE_HEADERS.includes(c)))]; // 去重：个别策略候选含同名不同来源列（如 TwoHop 银行/入金侧均叫 'CustomerRef'）
    if (inSheet1.length > 0) row._matchedColumns = inSheet1;
  }
  return row;
}
```

- `_matchedColumns` 用**数组**（JSON 友好、测试 `deepEqual` 直观）。
- 单点过滤收口在 `buildBackfillRow` 一处——matcher 端只管诚实记候选列，过滤口径单一真相在此（避免 9 处 matcher 各自过滤易漏）。
- 顶部需 `require` `REFUND_TEMPLATE_HEADERS`（`r5-refund-order-backfill.js` 已 require `refund-backfill-fields`，:39-45，加入解构即可）。

### 5.4 export 浅拷贝存活（不改 main.js）

`main.js:4047-4048`：`processingResult.refundBackfillRows.map((r) => ({ ...r }))` 浅拷贝**自动保留** `_matchedColumns`（与既有 `_bridgeDepositBizId` 同路——:4069 已从这些拷贝行读 `row._bridgeDepositBizId`，证明 `_` 字段经此浅拷贝存活）。`writeRefundBackfillOutput`（:4093-4097）直接收这些行。→ **orchestrator / main.js 一行不改**。

### 5.5 writer 标黄：`refund-backfill-writer.js`

```javascript
// 顶部就地定义（注释指向 exceljs-writer.js:24-28 单一真相；不跨 main-process 模块 import）
// v3.0.10 需求3.1：YELLOW_FILL 字面与 exceljs-writer.js:24-28 一致（单一真相在彼，此处就地复制避免模块耦合）。
const YELLOW_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' }
};

// sheet1 写循环（:88-101，getCell :97）仿 exceljs-writer.js:298-304，但列偏移 colIdx+1（退款 sheet1 无前导列；
//   对比主报告 sheet2 有「命中明细」前导列 → 那边是 colIdx+2）：
for (const row of backfillRows) {
  const r = backfillSheet.addRow(projectRow(REFUND_TEMPLATE_HEADERS, row));
  const m = row && row._matchedColumns;
  if (m && m.length) {
    REFUND_TEMPLATE_HEADERS.forEach((h, i) => {
      if (m.includes(h)) r.getCell(i + 1).fill = YELLOW_FILL; // colIdx+1：sheet1 第1列即 REFUND_TEMPLATE_HEADERS[0]
    });
  }
}
```

- **列偏移关键**（R-5）：退款 sheet1 第 1 列就是 `REFUND_TEMPLATE_HEADERS[0]`（无前导列）→ `getCell(i+1)`（ExcelJS 列 1-based）。对照 `exceljs-writer.js:302` 用 `colIdx+2` 是因主报告 sheet2 有「命中明细」前导列（:293 `[detail, ...headers.map]`）——两边偏移不同，**不可照抄数字**。
- `projectRow`（:50-52）已过滤 `_` 前缀字段（按 `REFUND_TEMPLATE_HEADERS` 投影，`_matchedColumns` 不在其中 → 不写入单元格），标黄只用它定位列、不写值。

### 5.6 S4 标黄范围（v3.0.10 细化：按命中详情文案口径标 8 列）

S4 命中详情是固定文案 `S4_DETAIL_TEXT`（:78「命中唯一值:退款提交日期+大账号+金额+币种」，业务展示叫法）。v3.0.10 退款输出细化把 S4 标黄从「只标 `BillDate`+`valueDate` 两列」扩为**按该文案口径展开为 8 列**（bank 侧 4 + ro 侧 4，全 ∈ sheet1）。`matchS4`（:582）`hits.push`（:598）的 `_matchedColumns`：

```javascript
// matchS4 :598-601（全用 REFUND_BACKFILL_FIELD_MAP 常量，不硬编码中文列名）
_matchedColumns: [
  M.s4.bankDate, M.uniqueKey.bankAccount, 'Debit Amount', M.uniqueKey.bankCurrency, // bank：BillDate / MerchantId / Debit Amount / Currency
  M.s4.roDate, M.uniqueKey.roAccount, M.uniqueKey.roAmount, M.uniqueKey.roCurrency   // ro  ：valueDate / 银行大账号 / 退款金额 / 币种
]
```

- 8 列与 `REFUND_BACKFILL_FIELD_MAP` 对应：`M.s4={bankDate:'BillDate', roDate:'valueDate'}`（:100）、`M.uniqueKey={bankAccount:'MerchantId', roAccount:'银行大账号', bankCurrency:'Currency', roCurrency:'币种', roAmount:'退款金额'}`（:45-52）。
- **底层比对字段仍是 `valueDate`**（:585 `signedDayDiff(bankRow[M.s4.bankDate], ro[M.s4.roDate])`，单向窗 0≤diff≤21）；文案口径「退款提交日期」= `valueDate` 的业务展示叫法（O2）。
- 🔴 **资金红线说明**：S4「金额」实际匹配口径是 `|Credit Amount − Debit Amount|` 绝对值（唯一值分组 / `bankAmountAbs`），**非单看 Debit Amount 列**；`_matchedColumns` 里的 `'Debit Amount'` 字面仅作 sheet1 银行金额**展示列**标黄（银行段只放 Debit Amount、无 Credit Amount——资金红线）。
- 8 列全 ∈ sheet1（`buildBackfillRow` 交集过滤全保留）；其他策略 `_matchedColumns` 不动。

### 5.7 注意事项

- 交集标黄语义：只标「既参与匹配、又在 sheet1 列」的字段；零交集不标（不退标详情列、不兜底全标）。
- 每行只来自单一策略（命中即停）→ `_matchedColumns` 单一来源，无需合并多策略。
- 空 `_matchedColumns`（理论不发生，但防御）→ writer `if (m && m.length)` 短路、不标黄。

---

## 六、需求 3.2：sheet2 改造

### 6.1 UNMATCHED_HEADERS（删冗余两列 + 银行段补 2 列 → 13 列）

`refund-backfill-writer.js UNMATCHED_HEADERS`（:44-47）删「结果类型」(A) +「退款单号」(B)；银行段随 `REFUND_BANK_COLUMNS` 10→12（v3.0.10 退款输出细化）→ 最终 **13 列**：

```javascript
// 原始（v3.0.10 前）：['结果类型', '退款单号', ...REFUND_BANK_COLUMNS(10), '报错/提示信息']（13 列：1+1+10+1）
// 需求3.2 删冗余两列：[...REFUND_BANK_COLUMNS(10), '报错/提示信息']（11 列：10+1）
// 退款输出细化：REFUND_BANK_COLUMNS 10→12（补 Extra Information / Drawee Name）→ 银行 12 + 信息 1 = 13 列
const UNMATCHED_HEADERS = Object.freeze([
  ...REFUND_BANK_COLUMNS,   // 银行 12 列（含 Extra Information / Payment Detail / Drawee Name）
  '报错/提示信息'
]);
```

- **列数随常量自动传播**：`UNMATCHED_HEADERS = [...REFUND_BANK_COLUMNS, '报错/提示信息']` 无硬编码列数，银行段 10→12 后 sheet2 自然 11→13。注意最终 13 列与原始 13 列**构成不同**（原始 = 结果类型+退款单号+银行10+信息；现 = 银行12+信息）。
- `projectRow`（:50-52）投影逻辑**不变**（按表头数组投影，缺 key → `''`）。
- 文件头注释（:7-12 sheet2 说明、:40-43 UNMATCHED_HEADERS 说明）已同步为 13 列、去「结果类型」「退款单号」描述、注明银行段 12 列。

### 6.2 报错/提示前缀单点（buildUnmatchedBankRow）

「报错/提示」区分并入「报错/提示信息」文案前缀（`【报错】`/`【提示】`），**单点加在 `buildUnmatchedBankRow`**（:199；落地后行号随细化位移，下方 push 点/循环行号为初稿估算，以函数名为准）：

```javascript
// v3.0.10 需求3.2：删 sheet2「结果类型」列后，报错/提示靠「报错/提示信息」前缀区分。
//   🔴 保留 row 上 '结果类型' key（仅不进 sheet2 投影），兼容引擎内部测试 filter(x=>x['结果类型']===...)。
function buildUnmatchedBankRow(bankRow, resultType, info) {
  const row = { '结果类型': resultType }; // 保留 key（不进 UNMATCHED_HEADERS 投影 → 不落 sheet2）
  for (const col of REFUND_BANK_COLUMNS) {
    row[col] = bankRow[col];
  }
  row['报错/提示信息'] = (resultType === RESULT_ERROR ? '【报错】' : '【提示】') + info;
  return row;
}
```

- 8 个 push 点里走 `buildUnmatchedBankRow` 的 bank 形状行**全部自动带前缀**（:647 bank-only NOTICE、:826/:837/:843 S4 三态、:863 `pushBankError` → :863 调 buildUnmatchedBankRow）。
- **保留 `结果类型` key**（R-8）：仅不进 sheet2 投影（`UNMATCHED_HEADERS` 已无该列 → `projectRow` 不取它），但 row 对象上仍有，兼容引擎内部/核兼容测试的 `filter(x => x['结果类型'] === RESULT_ERROR)`。

### 6.3 删 refund-only 两段循环

删除两整段（refund-only 组 = 有 SUBMITTED refund 但无对应银行行）：
- **:674-683**：`runRound5RefundOrderBackfill` 内「refund-only 组收尾」循环（`for (const [key, refundGroup] of refundGroups) { if (bankGroups.has(key)) continue; ... }`）。
- **:850-858**：`runStrategiesForGroup` 内「per-group refund 收尾」循环（`for (const ro of refundGroup) { if (usedRefundIdx.has(id) || lockedRefundIdx.has(id)) continue; ... }`）。

> 这两段产的是 refund 形状的 notice 行（`{ 结果类型, 退款单号, 报错/提示信息 }`，无银行段列）。删除后 sheet2 不再有 refund-only 噪声行。

**保留 bank-only NOTICE**（:645-648）——银行侧审计不变量不动（银行 Ach Return 行无对应 refund 仍产「未匹配-提示」，走 `buildUnmatchedBankRow`，是银行形状行、带前缀）。

### 6.4 审计不变量收窄说明

`r5-refund-order-backfill.js:711-715` 注释（「🔴 审计完整性不变量（PR#64 Finding 1）：每条筛后 SUBMITTED refund + 每条筛后 Ach Return（未改写）银行行都必须落 backfill/error/notice 三者之一」）已补一句（落地后行号随细化位移）：

```javascript
//   v3.0.10 需求3.2：refund-only（无对应银行行）的 refund 不再产 notice 行（完全静默删除，已确认），
//     不变量收窄为「银行侧全覆盖」——每条筛后 Ach Return（未改写、未被网关前置过滤）银行行仍必落
//     backfill/error/notice 之一；SUBMITTED refund 侧不再保证全覆盖（refund-only 静默）。
```

**完全静默删除，不留后台痕迹**（用户已确认）——删除两段循环即可，不加 activity log、不加任何记录。

---

## 七、跨接缝契约（需求3.1 引擎 ↔ main.js ↔ writer）

> 🔴 跨接缝盲区（`feedback_multiagent_seam_gap`）：需求3.1 跨 3 文件、4 段传递，逐文件 review 看不见接缝。**必须补跨接缝 E2E（§九）+ codex review**。

| 接缝 | 契约 | 不变量 |
|------|------|--------|
| matcher → hit | `hits.push({ refundRow, detail, [_matchedColumns: string[]] })` | `_matchedColumns` = 该策略**实际参与匹配的列**（候选，诚实列出，可含 ∉ sheet1 字段）|
| consumeAndBackfill → buildBackfillRow | 透传 `hit._matchedColumns` 给 `buildBackfillRow` 末位参 | 透传不过滤（过滤单点在 buildBackfillRow）|
| buildBackfillRow → row | `matchedColumns.filter(c => REFUND_TEMPLATE_HEADERS.includes(c))`，非空才挂 `row._matchedColumns` | 只挂交集；零交集不挂（仿 `_bridgeDepositBizId`）|
| 引擎 → main.js export | `processingResult.refundBackfillRows.map(r => ({...r}))`（:4048）| 浅拷贝保 `_matchedColumns`（与 `_bridgeDepositBizId` 同路存活）|
| main.js → writer | `writeRefundBackfillOutput(rows, ...)`（:4093）| writer 读 `row._matchedColumns` |
| writer → ExcelJS | `r.getCell(i+1).fill = YELLOW_FILL`（i = `REFUND_TEMPLATE_HEADERS` 下标）| **列偏移 +1**（sheet1 无前导列）；argb `FFFFFF00` |

**接缝陷阱**：
- 列偏移：sheet1 用 `colIdx+1`，主报告 sheet2 用 `colIdx+2`（有命中明细前导列）——**不可照抄**。
- `_matchedColumns` 必须用数组（非 Set）：JSON 友好 + 浅拷贝 `{...r}` 保引用 + 测试 `deepEqual` 直观。
- 过滤单点：matcher 端记候选（不过滤），buildBackfillRow 端过滤（单一真相）——避免双重过滤或漏过滤。

---

## 八、N+2、任务分解

> 按需求拆，每个可独立实现 + 测试。worktree 隔离并行；跨接缝处（需求3.1）重点 codex review。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| 0 | bump version 3.0.10 + `npm run scan:vars` | `package.json` | `npm run scan:vars` | todo（收口期）|
| 1 | 需求1 config schema：4 子场景加 `requireBankZeroField` | `migrations.js`（:1460-1520）| `migrations-recon-round-seed.test.js` | todo |
| 2 | 需求1 迁移：`ensureR4DirectionGuardConfigMigration` + 注册三点 | `migrations.js` + `database.js` | `migrations-r4-direction-guard.test.js` | todo |
| 3 | 需求1 引擎：主循环方向守卫 + import parseNumber | `r4-fund-nature-check.js` | `r4-fund-nature-check.test.js` §⑧ | todo |
| 4 | 需求1 cause：`error-causes.js` 加 code | `error-causes.js` | `error-causes.test.js` | todo |
| 5 | 需求2：编排器传 gwRows + 引擎建集合 + 第3道筛 | `reconciliation-orchestrator.js` + `r5-refund-order-backfill.js` | `r5-refund-order-backfill.test.js`（网关过滤组）| todo |
| 6 | 需求3.1：matcher `_matchedColumns` + buildBackfillRow 过滤 + writer 标黄 | `r5-refund-order-backfill.js` + `refund-backfill-writer.js` | `r5-...test.js`（链断言）+ `refund-backfill-writer.test.js`（标黄）| todo |
| 7 | 需求3.2：UNMATCHED_HEADERS 删冗余列（随 `REFUND_BANK_COLUMNS` 补 2 列后 13 列）+ 前缀 + 删 refund-only | `refund-backfill-writer.js` + `r5-refund-order-backfill.js` | `refund-backfill-writer.test.js` + `r5-...test.js` §⑩ | done |
| 8 | 跨接缝 E2E（需求3.1） | `scripts/integration/refund-backfill-yellow-fill-e2e.js` | `N/N PASS` | todo |
| 收尾-1 | 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）| docs | — | todo |
| 收尾-2 | `npm run release-check` 全绿 + `/check-vars` | — | PASS/FAIL 源 | todo |
| 收尾-3 | PRD/TechDoc 实施记录回填（Reverse Sync）| 本两文档 | — | todo |

---

## 九、测试计划

> Unit（隔离逻辑/边界）+ 跨接缝 E2E（需求3.1 最高价值）。release-check 全绿。预计净增 ~50-65 用例。

### 9.1 单元测试（必改/新增）

| 测试 | 覆盖 | 对应需求 |
|------|------|---------|
| `r4-fund-nature-check.test.js` 新增 §⑧ 方向守卫组 | 4 子场景满足/不满足；garbage/空/双零/负数（口径 `parseNumber\|\|0===0`）；叠加链中途不符（停上一跳、后续 handler 各判各）；no-op 交互（方向满足但已是目标值 → 不 warn 不 record）；warn code=`r4-fund-direction-mismatch` / rowId 断言；**`applyHandler` 不读金额的职责分离断言**（传方向不符行给 applyHandler 仍返回 setFundType）| 需求1 |
| `migrations-r4-direction-guard.test.js`（新建）| 老库补字段（4 子场景缺字段 → 补对应值）/ 幂等（二次跑 updated=0）/ **不覆盖用户值**（已存在 `requireBankZeroField` 含被用户改空 → 跳过）/ 不误伤（非 R4 场景 config 不动）/ 表不存在（no-op）| 需求1 |
| `migrations-recon-round-seed.test.js` | EXPECTED 表 4 行加 `requireBankZeroField` 期望（ach-return/hx-out→Credit Amount；wire-return/hx-in→Debit Amount）| 需求1 |
| `error-causes.test.js` | 新 code `r4-fund-direction-mismatch` 文案断言 | 需求1 |
| `r5-refund-order-backfill.test.js` 网关前置过滤组 | 命中静默移出（不进 backfill/sheet2）/ 大小写敏感（同字符不同大小写不命中）/ 空键不参与（银行或网关空 reconid 不命中）/ 缺省退化（`options.gwRows` 未传 → 无过滤）/ 被 drop 致三元组只剩 refund（联动需求3.2 不产 notice）| 需求2 |
| `r5-refund-order-backfill.test.js` `_matchedColumns` 链断言 | 逐策略（S1/S2-MTX/JPM-HK/JPM-US/S2b/S3/S3b/S3c/S4）命中行 `row._matchedColumns` = 过滤后 sheet1 列集（deepEqual）；★ 列被过滤丢弃；零交集不挂 | 需求3.1 |
| `r5-refund-order-backfill.test.js` §⑩ 不变量组**重写** | refund-only 不再产 notice 行（删两段循环后）；银行侧全覆盖仍成立；文案前缀（`【报错】`/`【提示】`）| 需求3.2 |
| `refund-backfill-writer.test.js` | sheet2 新表头 13 列（银行 12 + 信息，无「结果类型」「退款单号」）/ sheet1 33 列 / 删旧 refund notice 造型断言 / 标黄断言（argb `FFFFFF00`、仅命中列黄、含 Extra Information/Drawee Name/S4 八列、空 `_matchedColumns` 无黄、列偏移 colIdx+1 正确）/ 空表头（空 backfillRows 仍输出表头）| 需求3.1+3.2 |

### 9.2 跨接缝 E2E（最高价值，R-5）

`scripts/integration/refund-backfill-yellow-fill-e2e.js`（新增，遵循 `rules/integration-test-policy.md`：按模块命名、stdout 含 `N/N PASS`、exit 0/1、自建 tmp 跑完删）：

- 构造各策略命中的退款样例 → `runRound5RefundOrderBackfill` 产 `backfillRows`（带 `_matchedColumns`）。
- 模拟 export 浅拷贝 `backfillRows.map(r => ({...r}))`（验证 `_matchedColumns` 存活）。
- `writeRefundBackfillOutput` 写临时 xlsx。
- ExcelJS 读回断言：(a) sheet1 命中行的命中列单元格 `fill.fgColor.argb === 'FFFFFF00'`（含 S2-MTX/JPM-HK 标 Extra Information、S3 标 Drawee Name、S4 标 8 列）；(b) 非命中列无黄；(c) 列偏移正确（标的是 `REFUND_TEMPLATE_HEADERS[i]` 对应的第 `i+1` 列）；(d) sheet1 = 33 列、sheet2 = 13 列、带前缀、无 refund-only 行。
- **覆盖整链**：matcher 产列 → 收口过滤 → 浅拷贝存活 → writer 标黄。

### 9.3 核兼容与回归

| 锁 | 验证 |
|----|------|
| 核兼容测试微调 | `r5-refund-order-backfill-codex-fixes.test.js`（文案前缀）/ `-open7-hits.test.js`（确认 `_bridgeDepositBizId` 零破坏——`buildBackfillRow` 新增末位参不影响既有 `_bridgeDepositBizId` 断言）/ `reconciliation-orchestrator-refund.test.js`（refund-only / 结果类型断言按收窄调整，不放松资金断言）|
| 🔴 资金红线人工复核 | R4 改写口径（方向守卫）+ R5s4 筛选口径（网关前置过滤）由 team-lead 人工复核 + codex review |
| release-check | `npm run release-check` 全绿（unit + integration + smoke）；`npm run scan:vars`（bump 前）+ `/check-vars`（提 PR / 合并前，命中 FundType 改写口径 + Ach Return 筛选条件等重要变量，PR body 追加 review 段）|

---

## 十、N+3、实施计划（Commit 粒度）

> 一 task 一 commit，message `[v3.0.10] <简述>`。team-lead 自行 `git diff`+`release-check`+`/check-vars` 核实（不轻信 agent 汇报，`feedback_background_agent_unreliable`）。

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 0 | `[v3.0.10] bump 3.0.10 + PRD/TECHDOC（R4 方向守卫 / R5s4 网关前置过滤 / 退款输出改造）` | `package.json` + docs | — |
| 1 | `[v3.0.10] R4 方向守卫：4 子场景 seed 加 requireBankZeroField + 引擎主循环守卫 + warning + cause` | `migrations.js` / `r4-fund-nature-check.js` / `error-causes.js` + 单测 | 需求1 |
| 2 | `[v3.0.10] R4 方向守卫 config 老库补种：ensureR4DirectionGuardConfigMigration（无 marker 幂等不覆盖用户值）` | `migrations.js` / `database.js` + 单测 | 需求1 |
| 3 | `[v3.0.10] R5s4 网关前置过滤：编排器传 gwRows + bankPool 第3道筛（命中网关 reconid 静默移出）` | `reconciliation-orchestrator.js` / `r5-refund-order-backfill.js` + 单测 | 需求2 |
| 4 | `[v3.0.10] 退款 sheet1 命中字段标黄（交集标黄；matcher 记列 → buildBackfillRow 收口 → writer colIdx+1）` | `r5-refund-order-backfill.js` / `refund-backfill-writer.js` + 单测 | 需求3.1 |
| 5 | `[v3.0.10] 退款 sheet2 删冗余列 + 报错/提示前缀 + 删 refund-only 噪声行` | `refund-backfill-writer.js` / `r5-refund-order-backfill.js` + 单测 | 需求3.2 |
| 6 | `[v3.0.10] 退款输出细化：银行段补 Extra Information/Drawee Name（10→12，sheet1 31→33/sheet2 11→13）+ S4 标黄扩 8 列` | `refund-backfill-fields.js` / `r5-refund-order-backfill.js` + 单测 | 需求3.1 |
| 6 | `[v3.0.10] 退款回填标黄跨接缝 E2E（引擎→浅拷贝→writer→ExcelJS readback）` | `scripts/integration/refund-backfill-yellow-fill-e2e.js` | 需求3.1 |
| 7 | `[v3.0.10] 文档三件套 + PRD/TechDoc 实施记录` | docs | 收尾 |

---

## 十一、N+4、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。由 Dev/team-lead 在实施期填写。

### 2026-06-21（退款输出细化，代码已最终，本次同步文档）

- 动作：需求3.1 在已落地基础上做两处细化，更新 §一/§二/§5.2/§5.5(S4)/§5.6/§6.1/§七/§九/§十。
  1. **银行段补 2 列（`refund-backfill-fields.js`）**：`REFUND_BANK_COLUMNS` 10→12，按 `BANK_STATEMENT_FIELDS` 模板序插 `Extra Information`（CustomerRef 后、Payment Detail 前）+ `Drawee Name`（Payment Detail 后、银行段末位）。传播自动：`REFUND_TEMPLATE_HEADERS` 31→33（sheet1）、`UNMATCHED_HEADERS` 11→13（sheet2，`=[...REFUND_BANK_COLUMNS, '报错/提示信息']`）、`buildBackfillRow`/`buildUnmatchedBankRow` 遍历常量。两列均 ∈ `BANK_STATEMENT_FIELDS`（启动期断言①自动通过）。
  2. **标黄自动生效（不改 matcher 候选逻辑）**：S2-MTX/JPM-HK/S2b/S3b/S3c 早把 `Extra Information` 进 `_matchedColumns` 候选、S3 早把 `Drawee Name` 进候选，此前被 `buildBackfillRow` 的 `REFUND_TEMPLATE_HEADERS.includes` 交集过滤丢弃；现加入 sheet1 后过滤自然保留 → 命中即标黄。
  3. **S4 标黄扩 8 列（`r5-refund-order-backfill.js matchS4`）**：`_matchedColumns` 由 `[BillDate, valueDate]` 扩为按命中详情文案「退款提交日期+大账号+金额+币种」口径的 8 列——bank `BillDate`/`MerchantId`/`'Debit Amount'`/`Currency` + ro `valueDate`/`银行大账号`/`退款金额`/`币种`（全用 `REFUND_BACKFILL_FIELD_MAP` 常量，不硬编码中文）。8 列全 ∈ sheet1；其他策略 `_matchedColumns` 不动。
- 证据：`refund-backfill-fields.js REFUND_BANK_COLUMNS:125-132（12 列）/ REFUND_TEMPLATE_HEADERS:144-148（33 列）/ 启动断言①:159-166`；`refund-backfill-writer.js UNMATCHED_HEADERS:44-47（13 列）/ sheet1 标黄循环:88-101`；`r5-refund-order-backfill.js matchS4:582 / hits.push:598（_matchedColumns 8 列 :598-601）`。
- 风险：🔴 资金红线——S4「金额」实际匹配口径是 `|Credit−Debit|` 绝对值，`'Debit Amount'` 列仅作 sheet1 展示列标黄（银行段只放 Debit Amount、无 Credit Amount）；标黄列加多不影响匹配口径，仅影响可视审计。
- 决策：靠「列加入 sheet1」让交集过滤自动保留命中候选列，matcher 候选逻辑零改动（单一真相仍在 `buildBackfillRow` 交集过滤）。
- 注：下方「TechDoc 初稿」条目里的 file:line 为初稿快照（本次细化前），银行段相关行号已位移；以本条与 §二/§五 正文为准。

### 2026-06-21（TechDoc 初稿，架构师）

- 动作：通读本迭代已批准实施方案（plan）全文 + v3.0.9 TECHDOC 房屋风格 + 模板；当面 Read 核实全部改动点 file:line（出处优先），落 TechDoc。
- 证据（Read 核实，当前工作树）：
  - **需求1 R4**：`r4-fund-nature-check.js applyHandler:55-78 / 主循环:131-153（内层 :138-151）/ 原改写:144-149 / warningCollector:91 / import 解构:35-39`；`engine-utils.js parseNumber:20（导出 :143）/ makeWarningCollector 导出 :140`；`migrations.js RECON_ROUND_BUILTIN_SCENARIOS:1457-1520（ach-return:1460-1473 / wire-return:1474-1487 / hx-out:1493-1506 / hx-in:1507-1520）/ ensureFundTypeAchReturnConfigMigration:2307-2346 / 全局 marker:1456 / 导出块:3438`；`database.js require:59 / 薄壳:1073-1075 / 调用 retireChargeOutboundOrphans:380 + ensureFundTypeAchReturnConfigMigration:384`；`error-causes.js CAUSE_MAP:11-50`。
  - **warning 落盘链**：`reconciliation-orchestrator.js allWarnings:303 / r4.warnings push:349 / errorReport:491`；`bank-statement-io.js writeErrorReportOutput:252-278（enrich rowId→ReconciliationId :265-269）`；`exceljs-writer.js writeErrorReport:338-361 / 5 列表头:342 / resolveReconIdCell:321-329`。
  - **需求2 R5s4**：`reconciliation-orchestrator.js R5s4 调用:468-473（第4参 {isFundTypeChanged}）/ safeGwRows:279`；`r5-refund-order-backfill.js 主函数:569 / options.isFundTypeChanged 解构:580 / bankPool 筛:590-592（M.filter.bankFundType + achReturn + isFundTypeChanged）/ 文件头:6-8`。
  - **需求3.1 标黄链**：matcher hits.push 9 处 `:198/:216/:239/:324/:404/:424/:471/:522/:540`（函数起始 `matchS1:190/matchS2Mtx:207/matchCustomerRefTwoHop:227/matchJpmHk:308/matchMemoContainsDepositRef:374/matchS3:416/matchDraweeNameDate:454/matchMemoDateAmount:497/matchS4:535`）；`buildBackfillRow:146（_bridgeDepositBizId 非空才挂 :165-167）/ consumeAndBackfill:899-908（backfillRows.push :907）`；`main.js 浅拷贝 :4047-4048（既有 _bridgeDepositBizId 读取 :4069）/ writeRefundBackfillOutput 调用 :4093-4097`；`refund-backfill-writer.js sheet1 写循环:85-87 / projectRow:45-47`；`exceljs-writer.js YELLOW_FILL:24-28 / 标黄循环:298-304（colIdx+2，有命中明细前导列）`；`refund-backfill-fields.js REFUND_TEMPLATE_HEADERS:138-142 / REFUND_BANK_COLUMNS:121-126 / REFUND_RO_COLUMNS:130-134 / M.s4:100 / M.s1:61 / M.s2:63 / M.s2b:68 / M.s3:74-76 / M.backfill.fromBankReconId:55`。
  - **需求3.2 sheet2**：`refund-backfill-writer.js UNMATCHED_HEADERS:37-42（13→11 列）/ projectRow:45-47 / 文件头:9-13,:34-36`；`r5-refund-order-backfill.js buildUnmatchedBankRow:172 / refund-only 两段:674-683 + :850-858 / bank-only NOTICE:645-648 / 审计不变量注释:638-639 / RESULT_ERROR:53 / RESULT_NOTICE:54`。
- 风险：
  - 🔴 R-2 守卫放主循环不放 applyHandler（applyHandler 无 warning 权 + 无法区分「没命中」vs「命中但方向不符」）。
  - 🔴 R-3 老库守卫静默失效（全局 marker 短路）→ 必须新增无 marker 幂等迁移、绝不覆盖用户值。
  - 🔴 R-5 需求3.1 跨接缝（4 段跨 3 文件）+ 列偏移 colIdx+1 ≠ 主报告 colIdx+2 → 必须补 E2E + codex review。
- 决策：
  - v3.0.10 沿用单主题约定：`docs/iterations/v3.0.10/` 裸文件名 PRD.md + TECHDOC.md（与 v3.0.9 一致）。
  - 退款 writer 就地定义 YELLOW_FILL（不跨模块 import exceljs-writer.js）+ 注释指向 :24-28 单一真相。
  - `_matchedColumns` 用数组（JSON 友好 + 浅拷贝保引用 + deepEqual 直观）；过滤单点收口在 buildBackfillRow。
  - `buildUnmatchedBankRow` 保留 row 上 `结果类型` key（仅不进 sheet2 投影），兼容引擎内部测试 filter。

### 可沉淀知识

- [ ] 「资金红线 config 字段新增 → 必须配无 marker 幂等迁移」范式：内置场景 seed 有全局 marker 短路，新增 config 字段对老库静默失效；须仿 `ensureFundTypeAchReturnConfigMigration` 加独立无 marker 迁移（每次启动补缺、不覆盖用户值、事务）。
- [ ] 「引擎记命中列 → writer 标黄」跨接缝范式：matcher 端诚实记候选列 + 单点过滤收口（buildBackfillRow）+ 浅拷贝保 `_` 字段 + writer 列偏移按各 sheet 前导列数（sheet1 colIdx+1 / 有前导列 colIdx+2）——列偏移不可照抄，必须补端到端 readback 测试。

---

## 十二、N+5、Open Technical Questions

| # | 问题 | 处理 |
|---|------|------|
| OPEN-1 | 需求2 银行侧 reconid 列名引用：用现有 `M.backfill.fromBankReconId`（='ReconciliationId'）还是新增 `M.filter.bankReconId` 别名 | Dev 拍板。**推荐复用 `M.backfill.fromBankReconId`**（单一真相，值即 'ReconciliationId'）；若 `M.filter` 段更内聚则加别名、值必须 = 'ReconciliationId' |
| OPEN-2 | `requireBankZeroField` 字段值用列名字面（'Credit Amount'/'Debit Amount'）还是枚举常量 | 当前用列名字面（与 seed config 内 setFundType 等字面值风格一致、与银行行实际列名直接对应）；Dev 实施期若引入常量须保证 migration/引擎/测试三处同源 |
| OPEN-3 | 跨接缝 E2E 是独立脚本还是纳入现有退款集成脚本 | Dev 拍板。独立脚本更聚焦标黄链；若现有退款集成脚本已建退款 fixture 可加 case 复用 |
| OPEN-4 | 测试文件具体目录（`tests/unit/` 下子目录）| 实施期 `find tests/unit -name '<name>.test.js'` 实测现有命名约定；本文档只列文件名不锁路径 |

---

### 核实记录（与 plan 的出入）

> 架构师当面 Read 核实改动点，与 plan 的对照结论：

- **无重大出入**。plan 引用的所有改动点全部真实存在；行号与 plan 标注基本一致。
- **matcher hits.push 行号补正**（plan 标的是 matcher **函数起始行** `:190/:207/:227/:308/:374/:416/:454/:497/:535`，实际 `hits.push({...})` 语句在 `:198/:216/:239/:324/:404/:424/:471/:522/:540`）——两者均正确，plan 指函数、本文档同时给函数起始与 push 语句行，实施期附 `_matchedColumns` 在 push 处。
- **exceljs-writer 标黄循环偏移补充**（plan 已指出退款 sheet1 用 `colIdx+1`）：实测 `exceljs-writer.js:298-304` 主报告用 `colIdx+2`（:302），因 sheet2 有「命中明细」前导列（:293 `[detail, ...headers.map]`）；退款 sheet1 无前导列故 `colIdx+1`——本文档 §5.5/§七显式强调「不可照抄数字」。
- **main.js 浅拷贝路径已验证**（plan 称「不改 orchestrator/main.js」）：`main.js:4047-4048` 浅拷贝 `{...r}`，且 :4069 既有代码已从这些拷贝行读 `row._bridgeDepositBizId` —— 证明 `_matchedColumns` 经此浅拷贝存活、无需改 main.js，与 plan 一致。
- **migration 注册点已验证**：`database.js` require:59 / 薄壳:1073-1075 / 调用 :380（retireChargeOutboundOrphans）+ :384（ensureFundTypeAchReturnConfigMigration 同段），新迁移插在 :380 之后；`migrations.js` 导出块 :3438 —— 与 plan 标注（require :59 区 / 薄壳 :1073 区 / 调用在 retireChargeOutboundOrphans 之后 / 导出 :3438 块）吻合。

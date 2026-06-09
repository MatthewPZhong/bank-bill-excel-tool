# Spec — ADM 链接表派生：仅「派生出数据」时才弹「已创建」提醒

> 状态：**方案已定（OPEN-2=A），收口进 v3.0.1，待落源码** ｜ 来源分支：`v3.0.0` ｜ 目标版本：**3.0.1**（2026-06-09 与链接表批量导入等一起收口进 v3.0.1 迭代，见 `docs/iterations/v3.0.1/PRD-v3.0.1.md` 需求4）
> 性质：🟡 前端弹框文案/触发条件改动（无后端逻辑改动），但落在**资金对账派生链路**，需 `/check-vars`。
> 缘起：用户 2026-06-09 反馈——导入一张**不含 `Channel='ADM'`** 的银行对账单表后，系统仍弹「ADM银行对账单链接表已创建。」，但实际派生出 0 行。期望：**只有真正派生出有数据的 ADM 链接表时才弹该提醒**。

---

## 〇、需求

ADM 银行对账单链接表派生成功弹框（「ADM银行对账单链接表已创建。」）的触发条件，从「只要派生未异常」收紧为「**派生出 ≥1 行 ADM 数据**」。

- 派生出 0 行（本次银行表无 `Channel='ADM'` 调拨行）→ **不弹**该成功提醒（静默）。
- 派生异常（`created=false`）→ **保持**弹失败提示（错误必须暴露）。
- 派生出数据但部分未匹配中台 → **保持**弹「部分成功 + 未匹配明细」。

---

## 一、现状根因（代码事实，带出处）

### 1.1 后端：无论几行都回 `created:true`

`src/main.js:11336-11363`（`linked-table:import` handler 的 ADM 派生段）：

```js
const bankAdmCandidates = database.readBankDepositAdmCandidates(); // 无 Channel=ADM → []
const { admRows, unmatched, midEmpty } = buildAdmRows(bankAdmCandidates, midRows); // admRows=[]
database.replaceAdmBankDeposit(admRows);   // DELETE + 不插入 → 表清空重建
reconIdFixResult = null;                    // 🔴 旧 JPM 修复结果一并清空
okResult.admDerive = {
  created: true,            // ← 即使 0 行也为 true
  total: admRows.length,   // ← = 0
  matched: admRows.length - unmatched.length, // = 0
  unmatched: [...],        // = []
  midEmpty
};
```

`buildAdmRows`（`src/main-process/adm-bank-deposit-builder.js:154-192`）：空源 → `admRows=[]`、`unmatched=[]`（无行可匹配）、`midEmpty=midRows.length===0`。
> ∴ **`total===0` ⟹ `unmatched.length===0`**（0 行无从产生未匹配）。

### 1.2 前端：成功分支无 `total` 守卫

`src/renderer-dialogs.js:6309-6320` `buildAdmDeriveHtml(admDerive)`：

```js
if (!admDerive) return null;
if (!admDerive.created) { /* 失败提示 */ }
const unmatched = Array.isArray(admDerive.unmatched) ? admDerive.unmatched : [];
if (unmatched.length === 0) {
  return 'ADM银行对账单链接表已创建。';   // ← 现状：total===0 也走这里
}
/* 部分成功：列未匹配明细 */
```

调用链 `renderer-dialogs.js:6376-6385`：`admHtml = buildAdmDeriveHtml(...)` → 非 null 即在导入明细框确认后链式弹出。

### 现状行为矩阵

| created | total | unmatched | 现状弹框 | 期望 |
|---|---|---|---|---|
| false（异常） | — | — | 「派生失败」 | **不变** |
| true | **0** | 0 | 「已创建」 | **改：不弹（静默）** |
| true | >0 | 0 | 「已创建」 | 不变 |
| true | >0 | >0 | 「部分成功 + 未匹配明细」 | 不变 |

---

## 二、修复方案（最小改，前端单点）

仅在 `buildAdmDeriveHtml` 成功分支加 `total` 守卫，**不动后端**（后端仍照常重建表、清 `reconIdFixResult`——这是 PR#65 资金红线设计，本变更不碰）。

### 改动：`src/renderer-dialogs.js:6316-6320`

```js
const unmatched = Array.isArray(admDerive.unmatched) ? admDerive.unmatched : [];
if (unmatched.length === 0) {
  // 本次未派生出任何 ADM 行（银行表无 Channel='ADM' 调拨行）→ 表为空，不弹「已创建」成功提示。
  if (!admDerive.total) return null;          // total===0/undefined → 静默
  return 'ADM银行对账单链接表已创建。';
}
```

- 返回 `null` 后，`renderer-dialogs.js:6379` 的 `if (admHtml)` 为假 → 直接重开链接表管理弹窗（`createLinkedTableManagerDialog()`），无副作用。
- `admIsError`（6383）在 `if (admHtml)` 块内，不会被求值，无需改。

> 备选（更稳）：守卫写成 `if (!admDerive.total || admDerive.total === 0)`，语义等价；`!admDerive.total` 已覆盖 `0/undefined/NaN`。

---

## 三、风险

🟡 **资金对账派生链路相关**（Risk-sensitive）：

1. **改的是「是否提示」，不是「是否重建」**——后端 `replaceAdmBankDeposit([])` 仍会清空 ADM 表并置 `reconIdFixResult=null`。即：**导入无 ADM 行的银行表，旧 ADM 数据 + 旧 JPM 修复结果照样被清，现在还不弹任何提示**（见 OPEN-2，需用户拍板是否可接受这种「静默清空」）。
2. 前端单点改动，仅影响 `buildAdmDeriveHtml` 成功分支；失败/部分成功分支零改动。
3. 命中重要变量软约束：本次实际编辑 `src/renderer-dialogs.js`（前端），未触及 `rules/important-variables.md` 中 `reconIdFixResult` 等后端变量；但因落在资金链路，**提 PR 前须跑 `/check-vars`** 并在 PR body 附「⚠️ 关联功能 review」段。

---

## 四、验证

- **前端 preview**：`buildAdmDeriveHtml` / ADM 派生弹框是否有独立 preview 入口待实施时确认（`package.json` 现有 `preview` / `preview:account`）；若无对应入口，按 memory `workflow_frontend_previews` 评估是否补一个 fixture（4 处入口同步）。
- **手动回归路径**（3 条）：
  1. 导入**无 Channel=ADM** 的银行对账单表 → 期望：导入明细框正常，**不弹** ADM 框。
  2. 导入**有 Channel=ADM** 的银行对账单表（全匹配）→ 期望：仍弹「ADM银行对账单链接表已创建。」。
  3. 导入有 ADM 但部分未匹配 / 中台表空 → 期望：仍弹「部分成功 + 未匹配明细」（含「请先导入中台调拨订单表」）。
- 后端契约不变，`scripts/integration` ADM 相关脚本（若有）应保持 PASS。

---

## 五、OPEN

| # | 问题 | 决策 |
|---|------|------|
| OPEN-1 | 落地分支 / 版本？ | ✅ **已定：3.0.1**（2026-06-09 收口进 v3.0.1 迭代，与链接表批量导入 / 两处 UI 一起发） |
| OPEN-2 | 导入无 ADM 行的银行表 = **静默清空**旧 ADM 表 + 旧 JPM 修复结果，现在连提示都没有，是否可接受？ | ✅ **已定：方案 A**（2026-06-09 用户确认）——0 行完全静默，不弹任何提示。后端「静默清空」行为保持现状不改。 |
| OPEN-3 | 文案是否要做「0 行」专属提示而非完全静默？ | 随 OPEN-2=A → **完全静默**，不追加任何轻提示 |

---

## 六、决策记录

- 2026-06-09：用户确认 **OPEN-2 = 方案 A**（0 行完全静默）。落码方案锁定为「§二 前端单点改 `buildAdmDeriveHtml`，加 `if (!admDerive.total) return null;`，后端不动」。
- 2026-06-09：用户指示**暂停在 spec**，本变更**不进入代码实现**，等后续明确「开始」与目标版本后再走 `/apply`。
- 2026-06-09（同日晚些）：用户决定把本变更**收口进 v3.0.1 迭代**（与网关链接表批量导入、业务OP按钮右移、场景框样式修复一起）。已纳入 `docs/iterations/v3.0.1/PRD-v3.0.1.md`（需求4）+ `TECH_DESIGN-v3.0.1.md`。OPEN-1 版本据此定为 3.0.1。

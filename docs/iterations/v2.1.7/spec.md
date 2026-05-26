# spec — v2.1.7 实施规格

| 字段 | 值 |
|---|---|
| 文档版本 | v0.9（2026-05-21 — T14 收口反向同步 3 处：§4.1/§8.4.2/§13.4.1 styles.css→styles-gemini-extra.css 修正 + §9.8.4 F8 SheetJS/ExcelJS 双版本 + §11.3.8 新增 round 6 grid-template-rows:1fr 真根因补章）；v0.8 = round 5；v0.7 = round 4；v0.1-0.6 略 |
| 关联 PRD | `PRD-v2.1.7.md` v0.11 |
| 关联 tasks | `tasks.md` v0.8 |
| 工作分支 | `v2.1.7`（基于 `main`） |
| 起草人 | PM |
| 状态 | 定稿 — 6 项需求 + round 2 8 项 + round 3 6 项 + F8 + round 4 3 项 + round 5 2 项全部拍板可入 Dev；F4 单 billType 引擎语义按方案 A；R5 资金红线三层护栏（§8.6.5）；F8 资金红线护栏（§9.8.3）；B4 完整高度链 PM grep 真根因（§11.3.2）；B2 跟随 B4 修好后用户验证 |

---

## 一、本规格的边界

- **6 项需求**：F1（C1 AND/OR）/ F2（C3 1v1 方案 A）/ F3（CSS flex min-width:0）/ F4（C2 重命名 + 校验放宽 + 引擎放宽）/ F6（收单币种校验进度提示）/ **F7（SQL 调优 PRAGMA + 索引 + ANALYZE + Notification）**
- **round 2 8 项小修**：R1 F4 删按钮门槛 / R2 F6 fileCount / R3 状态框「：」换行（全局）/ R4 acquiring 切模块按钮误启（不扩散）/ R5 F1 默认 AND + 资金红线护栏 / R6a F3 multi 文件名 grid 3 列治本 / R6b 列表滚动 = R6a 副作用 / R6c extract-order-list 加 max-height + overflow-y
- **round 3 6 项小修 + F8**：B1 F1 radio 移回"条件"row / B2 multi 完成态字母列 / B3 extract-order-card 单 grid + 单滚动条（用户拍板方案 A）/ B4 ≥20 文件滚动调试 / **B5 R3 wiring 漏接审计 + smoke 加固** / F4 删空 / **F8 dispatcher 反向 filter unmatchedRows + writer 第 2 sheet 🚨 资金红线**
- **round 4 3 项小修**（用户手测 round 3 后反馈未通过）：**B1 Layout-1**（左列纵向"条件 + AND + OR"，radio label 13px 与"筛选字段"对齐）/ **B4 真根因 fix**（`.big-account-split-left/right` 加 `min-height: 0` 1 行 CSS 双写）/ **B2 双路径**（dev 修完 B4 后用 DevTools 选路径 A 修 letterSpan 或路径 B 改 grid minmax(24px,auto)）
- **round 5 2 项小修**（用户手测 round 4 后反馈）：**B1 round 5 微调**（去掉 radio 文本"（同时满足）/（满足任一）"，提示合到"条件" label tooltip — PM 推荐方案 B 单 tooltip 整合 + HTML `&#10;` 实体换行）/ **B4 round 5 真根因第 2 层 🚨**（PM 二次 grep 完整 3 层 flex/grid 嵌套链：第 3 层 file-list/order-list 也缺 `min-height: 0` + 防御性第 1 层 split-body 也加；一次性 2 行 CSS 双写修齐两层）/ B2 跟随 B4 用户实测决定 round 6 走路径 B 与否
- **⏸ F5 延期 v2.1.8**：详 PRD §十；本 spec 不实施任何 F5 相关改动；v2.1.6 现有 C4 smoke 必须保持通过（regression 保护，确保本迭代 6 项 + round 2 不误伤 C4 gateway 子模式）
- **不动**：C4 business / gateway 子模式（F5 整章不动）、Module A 个人痕迹、Module B 收单币种校验业务逻辑（仅 F6 加进度回调，F7 仅在 database 启动 + 加索引 + 加 Notification）、所有业务表 schema
- **F7 全局影响声明**：A1 PRAGMA 影响所有 3 套业务引擎共享同一 DB instance（bank-bu-recon / biz-op-recon / acquiring-bill-currency），spec §7.7 全 19 个 smoke suite 回归矩阵必须全过；A2 索引仅影响 acquiring-bill-currency-bill_imports 表
- **R3 全局影响声明**：updateStatusBox 是项目所有 setStatus 通路的最终入口，spec §8.4.3 同样要求全 19 suite 回归矩阵
- **R5 资金红线护栏**：spec §8.6.5 三层护栏不可缺一；引擎 fallback OR（§2.2）必须保留
- **共享前置**：所有改动需在 `npm start` 启动验证 + smoke 全套通过 + 涉及前端 dialog/CSS 需重跑 previews

---

## 二、F1 — C1 提取ReconId-From Self 加 AND/OR 开关

### 2.1 数据 schema（scenarios.config JSON）

**新增字段** `conditionsLogic`：

```js
// v2.1.6 形态
{
  conditions: [{ field, op, value }, ...],
  extractByFeature: { enabled, searchFields, featureCode, digitCount, totalLength } | null,
  extractByOtherField: { field } | null
}

// v2.1.7 形态（新增 conditionsLogic）
{
  conditions: [...],
  conditionsLogic: 'OR' | 'AND',  // ⭐ 缺失时引擎 fallback 'OR'（向下兼容旧 scenario）
  extractByFeature: ...,
  extractByOtherField: ...
}
```

**DB 兼容**：`scenarios.config` 列已是 JSON TEXT，新增字段无需 migration。旧 scenario 加载时 JSON.parse 出 `conditionsLogic === undefined` → 引擎按 OR 走 → 行为与 v2.1.6 完全一致。

### 2.2 引擎改动（`src/main-process/scenario-engines/c1-extract-recon-id.js`）

**改动点 1**：`rowMatchesAnyCondition` 改 `rowMatchesConditions` + 接收 logic 参数。

```js
// 现状 L36-42
function rowMatchesAnyCondition(row, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  return conditions.some((cond) => evaluateCondition(row, cond));
}

// 改后
function rowMatchesConditions(row, conditions, logic) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  const fn = (logic === 'AND') ? 'every' : 'some';
  return conditions[fn]((cond) => evaluateCondition(row, cond));
}
```

**改动点 2**：`runC1Scenario` 入口取 logic + 传给上述函数。

```js
// L95-103 附近
function runC1Scenario(scenario, bankRows) {
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const modCollector = makeModificationCollector();
  const config = scenario.config || {};
  const conditions = config.conditions || [];
  const conditionsLogic = (config.conditionsLogic === 'AND') ? 'AND' : 'OR';  // ⭐ 新增

  bankRows.forEach((row, index) => {
    const rowId = ensureRowId(row, index);
    if (!rowMatchesConditions(row, conditions, conditionsLogic)) return;  // ⭐ 改名 + 传参
    ...
  });
}
```

**改动点 3**：module.exports 保持向下兼容（保留 `rowMatchesAnyCondition` 旧名 alias 给 smoke 与未来 fallback，可选）。spec 推荐**不保留 alias**（直接重命名，smoke 同步改），diff 更干净。

### 2.3 Dialog 改动（`src/renderer-dialogs.js`）

**改动点 1**：`createDefaultScenarioConfig('extract-recon-id')` 加默认值（L5701-5708）。

```js
if (category === 'extract-recon-id') {
  return {
    conditions: [{ field: '', op: '等于', value: '' }],
    conditionsLogic: 'OR',  // ⭐ 新增默认值
    extractByFeature: null,
    extractByOtherField: null
  };
}
```

**改动点 2**：C1 dialog innerHTML 在条件多行容器下方追加 radio 组（L6288-6294 附近）。

```html
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    <button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>
    <!-- ⭐ 新增 radio 组 -->
    <div class="scenario-config-logic-row">
      <span class="scenario-config-logic-label">条件聚合：</span>
      <label><input type="radio" name="conditionsLogic" value="OR" ${config.conditionsLogic !== 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}> OR（满足任一）</label>
      <label><input type="radio" name="conditionsLogic" value="AND" ${config.conditionsLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}> AND（同时满足）</label>
    </div>
  </div>
</div>
```

**改动点 3**：事件绑定（L6388 附近 `add-condition` 旁）。

```js
dialog.querySelectorAll('input[name="conditionsLogic"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (isReadonly) return;
    if (radio.checked) config.conditionsLogic = radio.value;
  });
});
```

**改动点 4**：tooltip 文案更新（L6289）。原 `'满足任一条件即可进入提取'` 改成中性的 `'按下方选择的逻辑聚合条件'`。

**改动点 5**：confirm 预览（L7531-7532）+ 管理列表预览 — 按 logic 切换 OR/AND 文字。

```js
// L7531-7532 现状
if (draft.category === 'extract-recon-id') {
  html += `<div ...><span ...>条件（OR）：</span><ul>...`;
}

// 改后
if (draft.category === 'extract-recon-id') {
  const logicLabel = (c.conditionsLogic === 'AND') ? 'AND' : 'OR';
  html += `<div ...><span ...>条件（${logicLabel}）：</span><ul>...`;
}
```

### 2.4 smoke 用例

新建/扩展 `scripts/smoke/scenario-engines-c1.js`（如已存在则追加）：

| Case | 输入 | 期望 |
|---|---|---|
| F1-A | conditions=[A=true, B=false], logic='OR' | 命中 |
| F1-B | conditions=[A=true, B=false], logic='AND' | 不命中 |
| F1-C | conditions=[A=true, B=true], logic='AND' | 命中 |
| F1-D | scenario.config 无 conditionsLogic 字段（模拟老数据） | 引擎按 OR 跑，与 v2.1.6 一致 |

### 2.5 previews 回归

`scripts/preview/preview-scenario-c1.js` 或对应入口：新增 AND/OR radio 渲染截图（共 2 张：OR 默认 + AND 选中）。

### 2.6 风险与回归保护

- 🟢 conditionsLogic 字段向下兼容；旧 scenario fallback OR
- 🟡 smoke 必须覆盖 AND 模式 ≥ 2 用例；C1 旧 OR smoke 不动

---

## 三、F2 — C3 提取ReconId-From 网关 多笔等额改 1v1 ⚠️ 资金红线（方案 A）

### 3.1 引擎改动（`src/main-process/scenario-engines/c3-gateway-recon-join.js`）

**改动点**：`runC3Scenario` 主循环（L123-145）加 `usedGwRowIdx` Set 标记已用网关行。

```js
// 现状 L123-145（简化）
bankRowsFiltered.forEach((bankRow, index) => {
  const rowId = ensureRowId(bankRow, index);
  const matched = gwRowsFiltered.filter((gwRow) => gwMatchesBank(gwRow, bankRow, reconFields));
  if (matched.length === 0) return;
  if (matched.length > 1) { warningCollector.push(...) }
  const chosen = matched[0];
  ...
});

// 改后（方案 A — 网关候选池标记已用 + 顺序消费）
const usedGwRowIdx = new Set();  // ⭐ 新增：网关行已用索引集合

bankRowsFiltered.forEach((bankRow, index) => {
  const rowId = ensureRowId(bankRow, index);
  // ⭐ 候选筛选时排除已用 gwRow
  const matched = gwRowsFiltered
    .map((g, gIdx) => ({ row: g, gIdx }))
    .filter((x) => !usedGwRowIdx.has(x.gIdx) && gwMatchesBank(x.row, bankRow, reconFields));
  if (matched.length === 0) return;

  if (matched.length > 1) {
    warningCollector.push({
      rowId,
      code: 'multi-gateway-match',
      message: `bankRow 在网关账单中匹配到 ${matched.length} 行（未用），取第一条（数据脏）`
    });
  }
  const chosen = matched[0];
  usedGwRowIdx.add(chosen.gIdx);  // ⭐ 标记已用

  const newValue = normalizeCellValue(chosen.row[assign.gwField]);
  if (newValue === '') return;

  const oldValue = normalizeCellValue(bankRow[assign.bankField]);
  if (oldValue === newValue) return;

  bankRow[assign.bankField] = newValue;
  modCollector.record(rowId, assign.bankField, oldValue, newValue);
});
```

**关键不变量**：
- gwRowsFiltered **顺序稳定**（来自 reader 输入顺序）→ usedGwRowIdx 索引是确定的
- bankRowsFiltered **顺序稳定** → forEach 顺序与 v2.1.6 一致
- 同输入 → 同输出（deterministic）

**conditions filter / reconFields AND 比对 / 写值逻辑**全部不变。

### 3.2 边界场景说明（方案 A 退化为零命中的情况）

**情况 1：gw 池子被前面 bank 抢空**

```
输入：
  bank: [B1 amt=100, B2 amt=100, B3 amt=200]
  gw:   [G1 amt=100, G2 amt=200]

方案 A 流程：
  B1 → 候选 [G1(amt=100)]（G2 amt=200 不匹配）→ B1←G1, usedGwRowIdx={0}
  B2 → 候选 [] （G1 已用 + G2 amt 不匹配）→ **B2 未命中**
  B3 → 候选 [G2(amt=200)] → B3←G2, usedGwRowIdx={0,2}
```

**B2 未命中是预期行为**：方案 A 是 bank 单消费 gw 单 first-match-wins；同金额组 bank > 同金额组 gw 时多余 bank 行 unmatched，不抛错、不警告（与"匹配 0 条直接 continue"行为一致）。

**情况 2：多 candidates 时仍取 first**

```
输入：
  bank: [B1 amt=100]
  gw:   [G1 amt=100, G2 amt=100]  // reconFields 全等

方案 A 流程：
  B1 → 候选 [G1, G2] → matched.length > 1 → warning multi-gateway-match → B1←G1（first）, usedGwRowIdx={0}
```

后续 bank 行如果 reconFields 全等仍会获得 G2 候选 → first-match-wins 风格保留。

**情况 3：旧行为（前 bank 行无匹配）保持不变**

bank 行经 reconFields 比对无任何 gw 行匹配 → 跳过该行（与 v2.1.6 一致）。

### 3.3 smoke 用例

新建/扩展 `scripts/smoke/scenario-engines-c3.js`：

| Case | 输入 | 期望（方案 A）|
|---|---|---|
| F2-A | 3 笔等额 bank + 3 笔等额 gw | B1←G1, B2←G2, B3←G3（不再 B1/B2/B3 全部 ←G1）|
| F2-B | 3 笔等额 bank + 5 笔等额 gw | B1←G1, B2←G2, B3←G3；G4/G5 剩余（不写回，gw 不被改）|
| F2-C | 5 笔等额 bank + 3 笔等额 gw | B1-B3 命中；B4/B5 unmatched（不写回，不抛错）|
| F2-D | 2 笔不等额 bank（A=100, B=200）+ 2 笔不等额 gw（C=100, D=200）| BA←GC, BB←GD（旧行为，不受影响） |
| F2-E | 1 bank + 1 gw 匹配 | BA←GC（旧 baseline） |
| F2-F | first-match 防回归：旧 smoke 全部仍通过 | regression 保护 |
| **F2-G** ⭐ | **空 gw 不进候选**（round 9 反向同步 + v2.1.8 v2.1.7-minor I-9）：1 bank + 2 gw（第 1 个 reconciliationId 空 / 第 2 个非空）| bank 命中第 2 个非空 gw（不被脏空 gw 阻塞）|
| **F2-H** ⭐ | **已等值 gw 仍 lock + 消费**（round 9 单向消费红线，v2.1.8 v2.1.7-minor I-9）：bank1 已等于 gw1 + bank2 同金额 | bank1 保持原值（不重写）但 lock + 消费 gw1；bank2 取 gw2（gw1 已被消费）|

### 3.4 真实数据回测

PR 前必须用用户提供的 v2.1.6 反例样本（多笔等额场景）手测，断言：
- 命中数 ≠ 全部赋同一条 gwRow
- modifications 中 gwField 值出现多个 distinct value

### 3.5 不动的部分

- conditions / gwConditions / bankConditions 过滤逻辑（L108-121）
- reconFields AND 比对（`gwMatchesBank`，L56-62）
- virtual amount abs 计算（L25-33, L38-48）
- warning code（multi-gateway-match）/ rowId 字段
- ~~warning message 文案~~（**v2.1.8 v2.1.7-minor M-1 修订**：原"匹配到 N 行（未用 + 非空）"语义模糊，N 是 filter 后值；改"匹配到 N 行可用 gw（另有 M 行空 gw 已跳过）"，数据质量监控视角能看到原始匹配数）

### 3.8 round 9 反向同步补章（v2.1.8 v2.1.7-minor I-7 / I-8 ⚠️ 资金红线）

**背景**：spec §3.1 起草时仅含 round 1（v0.1）方案 A 骨架。PR #51 review 阶段 round 7 / round 9 加了 2 层关键修复，spec 当时未反向同步，由 v2.1.8 v2.1.7-minor I-7 / I-8 补回。

#### 3.8.1 round 7 修复 — usedGwRowIdx.add() 位置调整

原 spec §3.1 改后伪码 L214：`usedGwRowIdx.add(chosen.gIdx)` 在 chosen 选定后立即 add。round 7 移到"确认能写值 + record 之后"（避免 newValue 为空 / oldValue===newValue 时仍消费 gw 导致后续 bank 无 gw 可用）。

#### 3.8.2 round 9 修复 — 双方向修齐（PR #51 reviewer round 3 Finding 1）

**问题**：round 7 把 `usedGwRowIdx.add()` 移到写值后 → 引入新反向 bug：
- **空 gw 反复被选**：gw 字段为空时 `newValue === ''` → continue → 不 add usedGwRowIdx → 同一空 gw 反复被后续 bank 选中（matched[0] 永远是它）→ 永远轮不到有效 gw
- **已等值 gw 不消费**：`oldValue === newValue` → continue → 不 add usedGwRowIdx → 同一 gw 可被多个 bank 重复选中 → 违反方案 A 单向消费红线

**修复（candidates filter 加第 3 层 + 等值时 lock+消费）**：

```js
// candidates 三层过滤（v2.1.7 round 9 fix，c3-gateway-recon-join.js:155-170）
const rawMatched = gwRowsFiltered
  .map((g, gIdx) => ({ row: g, gIdx }))
  .filter((x) =>
    !usedGwRowIdx.has(x.gIdx)            // 第 1 层：未消费
    && gwMatchesBank(x.row, bankRow, reconFields)  // 第 2 层：reconFields AND
  );
const matched = rawMatched.filter((x) =>
  normalizeCellValue(x.row[assign.gwField]) !== ''  // 第 3 层：gw 字段非空（v2.1.8 v2.1.7-minor M-1 拆 2 步）
);
// ...
if (oldValue === newValue) {
  modCollector.lock(rowId);              // round 9：仍 lock（first-match-wins 红线）
  usedGwRowIdx.add(chosen.gIdx);         // round 9：仍消费 gw（单向消费红线）
  return;
}
```

#### 3.8.3 业务规则明示（资金红线）

| 红线 | 规则 |
|---|---|
| **首层过滤** | gw 字段空（脏数据）→ 不进 candidates；让出位置给有效 gw |
| **单向消费** | 即使 bank 已等值 gw（不重写），仍要 lock + 消费 gw → 防一 gw 被多 bank 重复选中 |
| **first-match-wins** | matched[0]（数组首个）—— 候选有多个时 warning，但仍取首个保持确定性 |
| **deterministic** | 同输入 → 同输出（bankRowsFiltered / gwRowsFiltered 顺序稳定 → usedGwRowIdx 添加顺序稳定）|

#### 3.8.4 smoke 反向 case（封死 round 7-9 回归）

- **F2-G**（v2.1.8 v2.1.7-minor I-9 补）：验证第 3 层 filter 排除空 gw（避免数据脏时空 gw 反复被选）
- **F2-H**（v2.1.8 v2.1.7-minor I-9 补）：验证 `oldValue === newValue` 时仍 lock + 消费 gw（first-match-wins + 单向消费红线）

详 §3.3 表 F2-G / F2-H 行 + `scripts/smoke/scenario-engines.js` 实现。

### 3.6 风险与回归保护 🚨 资金红线

- 🔴 资金红线：必须用真实数据回测 + smoke F2-A/B/C/F 全跑
- 🟡 多 candidates 时 `matched[0]` 仍是 first（保持 first-match-wins 风格）；将来若需"按某 tieBreak 选最优"再升级到方案 B
- 🟢 `usedGwRowIdx` Set lookup O(1)，对 1k-10k 行级数据无性能影响

### 3.7 重要变量检查

`runC3Scenario` 不在 `rules/important-variables.md`；本迭代结束 `/check-vars` 时**评估升格 `runC3Scenario` 进 Risk-sensitive**（与 `runC4Scenario` 同级）。

---

## 四、F3 — 大账号确认页 multiMode "PP..." CSS 修复

**Spec 范围说明**：本节按"CSS overflow 截断"方向实施（用户拍板 + 截图佐证根因 = `.big-account-file-item` flex 子项缺 `min-width:0`）。**不深挖 double-escape 路径**（L1052 textContent + L1056 innerHTML 混用）—— 用户截图视觉是 `text-overflow:ellipsis` 触发出来的省略号，不是字符转义产物；JS 截断 `truncateFileName` 保留不动。

### 4.1 CSS 改动（`src/styles.css` + `src/styles-gemini-extra.css`）

**改动点 1**：`src/styles.css:1022-1027` `.big-account-file-meta` 加 `min-width:0 + flex:1 1 auto`。

```css
/* 现状 */
.big-account-file-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

/* 改后 */
.big-account-file-meta {
  min-width: 0;       /* ⭐ flex 子项可缩小 */
  flex: 1 1 auto;     /* ⭐ 主轴占满剩余空间 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
```

**改动点 2**：`src/styles-gemini-extra.css:411-416` `.ba-file-name` 同步。

```css
/* 现状 */
.ba-file-name {
  font-family: "Roboto Mono", ui-monospace, monospace;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* 改后 */
.ba-file-name {
  min-width: 0;       /* ⭐ */
  flex: 1 1 auto;     /* ⭐ */
  font-family: "Roboto Mono", ui-monospace, monospace;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
```

**改动点 3**：检查并同步 `Clear/styles-gemini-extra.css` / `Clear/styles-gemini.css` 副本（如有同名 class，按 v2.1.6 编码规范保持 src/ ↔ Clear/ 一致）。spec 阶段 grep 命中点 → tasks 列入 T-F3。

### 4.2 不动的部分

- JS `truncateFileName` 截 20 字符逻辑保留（极长文件名 > ~80 字符仍会被 JS 截，让 CSS ellipsis 进一步兜底）
- `meta.title = fullMeta` tooltip 行为保留（hover 显示完整）
- 弹窗总宽 `.big-account-selection-split { width: min(100%, 1100px) }` 保留
- 左右 1fr/1fr grid 比例保留

### 4.3 smoke 用例

F3 是纯 CSS bug，**不写 smoke**（用 preview 截图 + 手测验证）。

### 4.4 previews 回归

**必跑**（按 memory `workflow_frontend_previews`）：

| preview 截图 | 验证点 |
|---|---|
| 大账号 dialog 初始态（无 multiMode）| 文件名完整显示（regression baseline）|
| 大账号 dialog multiMode 编辑态 | 文件名 + 字母列完整显示 |
| 大账号 dialog multiMode 完成态（grouped）| 文件名 + "→ 大账号" 完整显示，不显示纯 "PP..." |

spec 阶段确认 preview 入口位置；可能需要在 `scripts/preview/` 下追加新场景渲染脚本。

### 4.5 风险与回归保护

- 🟢 `min-width:0` 对非 multiMode 行无副作用（容器够宽，不触发 ellipsis）
- 🟢 极长文件名 → JS truncate 兜底 + tooltip 显示完整
- 🟡 `Clear/` 副本可能漏改 → grep `big-account-file-meta\|ba-file-name` 全量同步

---

## 五、F4 — 账单打标 → 银行对账单字段赋值（重命名 + 校验放宽 + 引擎放宽）

### 5.1 默认 config 改动（`src/renderer-dialogs.js:5709-5717`）

```js
// 现状
if (category === 'offset-bill-mark') {
  return {
    billTypes: [
      { seq: 1, field: '', op: '等于', value: '' },
      { seq: 2, field: '', op: '等于', value: '' }
    ],
    reconFields: [{ seq: 1, leftType: 1, leftField: '', rightType: 2, rightField: '' }],
    markValue: { type: 2, field: '', value: '' }
  };
}

// 改后
if (category === 'offset-bill-mark') {
  return {
    billTypes: [],         // ⭐ 默认空
    reconFields: [],       // ⭐ 默认空
    markValue: { type: null, field: '', value: '' }
  };
}
```

### 5.2 校验改动（`src/renderer-dialogs.js:5830-5842`）

```js
// 现状
} else if (draft.category === 'offset-bill-mark') {
  const c = draft.config || {};
  if (!Array.isArray(c.billTypes) || c.billTypes.length < 2) errors.push('账单类型至少需要 2 行');
  else if (c.billTypes.some(...)) errors.push('账单类型每行的字段不能为空；...');
  if (!Array.isArray(c.reconFields) || c.reconFields.length === 0) errors.push('对账字段至少需要 1 行');
  else if (c.reconFields.some(...)) errors.push('对账字段每行两端的字段都不能为空');
  const mv = c.markValue || {};
  const billTypeSeqs = (c.billTypes || []).map((b) => b.seq);
  if (!billTypeSeqs.includes(Number(mv.type))) errors.push('打标值的"账单类型"必须存在于上方账单类型列表中');
  if (!mv.field) errors.push('打标值的字段不能为空');
  if (mv.value === '' || mv.value === undefined) errors.push('打标值的写入值不能为空');
}

// 改后
} else if (draft.category === 'offset-bill-mark') {
  const c = draft.config || {};
  // ⭐ < 2 改 < 1
  if (!Array.isArray(c.billTypes) || c.billTypes.length < 1) errors.push('账单类型至少需要 1 行');
  else if (c.billTypes.some(...)) errors.push('账单类型每行的字段不能为空；...');
  // ⭐ 删除"对账字段至少需要 1 行"卡校验；保留对非空行的内容校验
  if (Array.isArray(c.reconFields) && c.reconFields.some((r) => !r.leftField || !r.rightField)) {
    errors.push('对账字段每行两端的字段都不能为空');
  }
  const mv = c.markValue || {};
  const billTypeSeqs = (c.billTypes || []).map((b) => b.seq);
  if (!billTypeSeqs.includes(Number(mv.type))) errors.push('赋值的"账单类型"必须存在于上方账单类型列表中');  // ⭐ 打标值 → 赋值
  if (!mv.field) errors.push('赋值的字段不能为空');                                                              // ⭐
  if (mv.value === '' || mv.value === undefined) errors.push('赋值的写入值不能为空');                            // ⭐
}
```

### 5.3 Dialog 入口强补逻辑删除（`src/renderer-dialogs.js:6585-6593`）

```js
// 现状
if (!Array.isArray(config.billTypes) || config.billTypes.length < 2) {
  config.billTypes = [
    { seq: 1, field: '', op: '等于', value: '' },
    { seq: 2, field: '', op: '等于', value: '' }
  ];
}
if (!Array.isArray(config.reconFields) || config.reconFields.length === 0) {
  config.reconFields = [{ seq: 1, leftType: 1, leftField: '', rightType: 2, rightField: '' }];
}
if (!config.markValue) config.markValue = { type: 2, field: '', value: '' };

// 改后
if (!Array.isArray(config.billTypes)) {
  config.billTypes = [];                            // ⭐ 仅保证是数组，不强补行
}
if (!Array.isArray(config.reconFields)) {
  config.reconFields = [];                          // ⭐ 同上
}
if (!config.markValue) config.markValue = { type: null, field: '', value: '' };
```

### 5.4 类别展示名（`src/renderer-dialogs.js:5392, 5641`）

```js
// L5392
const SCENARIO_CATEGORY_LABELS = {
  'extract-recon-id': '提取ReconId-From Self',
  'offset-bill-mark': '银行对账单字段赋值',     // ⭐ 改名
  'gateway-recon-join': '提取ReconId-From 网关',
  ...
};

// L5641
const ALL_CATEGORY_OPTIONS = [
  { value: 'extract-recon-id', label: '提取ReconId-From Self' },
  { value: 'offset-bill-mark', label: '银行对账单字段赋值' },  // ⭐ 改名
  { value: 'gateway-recon-join', label: '提取ReconId-From 网关' },
  ...
];
```

### 5.5 Dialog label（`src/renderer-dialogs.js:6629`）

```html
<!-- 现状 -->
<span class="scenario-config-label">打标值</span>

<!-- 改后 -->
<span class="scenario-config-label">赋值</span>
```

### 5.6 Confirm 预览（`src/renderer-dialogs.js:7544`）

```js
// 现状
html += `<div ...><span ...>打标：</span>类型#${mv.type} 的 ${escapeHtml(mv.field || '')} 写入 "${escapeHtml(String(mv.value || ''))}"</div>`;

// 改后
html += `<div ...><span ...>赋值：</span>类型#${mv.type} 的 ${escapeHtml(mv.field || '')} 写入 "${escapeHtml(String(mv.value || ''))}"</div>`;
```

### 5.7 引擎放宽（`src/main-process/scenario-engines/c2-offset-bill-mark.js:60-83`）⚠️ 衍生

**改动点 1**：billTypes 校验从 `< 2` 改 `< 1`。

```js
// 现状 L60-71
if (billTypes.length < 2) {
  warningCollector.push({ ..., message: '账单类型至少需要 2 行（PRD §7.2）' });
  return { ... };
}

// 改后
if (billTypes.length < 1) {
  warningCollector.push({ ..., message: '账单类型至少需要 1 行' });
  return { ... };
}
```

**改动点 2**：reconFields = 0 不再 return（衍生方案 A — 单 billType 无条件赋值）。

```js
// 现状 L72-83
if (reconFields.length === 0) {
  warningCollector.push({ ..., message: '对账字段至少需要 1 行' });
  return { ... };
}

// 改后（删除此卡 + 引擎主循环加分支）
// （删除原 L72-83 整个 if 块）

// runC2Scenario 主循环（L97-145 附近）改造：
classifyRowsByBillTypes(bankRows, billTypes);

if (reconFields.length === 0) {
  // ⭐ 衍生方案 A：无 reconFields → 凡是命中 markValue.type 的行直接写赋值
  bankRows.forEach((row, index) => {
    const types = row._c2Types || [];
    if (!types.includes(markValue.type)) return;
    const oldValue = normalizeCellValue(row[markValue.field]);
    const newValue = String(markValue.value || '');
    if (oldValue === newValue) return;
    row[markValue.field] = newValue;
    modCollector.record(row._rowId, markValue.field, oldValue, newValue);
  });
  bankRows.forEach((r) => { delete r._c2Types; });
  return { ... };
}

// 否则走原 reconFields ≥ 1 配对逻辑（L99-171 不动）
const primaryReconField = reconFields[0];
...
```

⚠️ **此衍生方案待用户拍板**（PRD §9.5）：spec 按方案 A 先实现；若用户回复方案 B（仍 warning 不跑），删除上面"无条件赋值"分支，恢复原 `if (reconFields.length === 0) { warning return }`（仅消息文案略改）。

### 5.8 文档改动

| 文件 | 改动 |
|---|---|
| `docs/USER_GUIDE.md:553` | `"账单打标（C2）：..."` → `"银行对账单字段赋值（C2）：..."`（仅当前章节）|
| `docs/VERSION_FEATURE_HISTORY.md` | 新增 v2.1.7 段（详 PRD §9.2.2）|
| `CHANGELOG.md` | 新增 v2.1.7 段 |

### 5.9 smoke 用例

`scripts/smoke/scenario-engines-c2.js`：

| Case | 输入 | 期望 |
|---|---|---|
| F4-A | 旧形态 2 billTypes + 1 reconFields + markValue | 旧 baseline 通过 |
| F4-B | 1 billType + 0 reconFields + markValue.type=billTypes[0].seq（**衍生方案 A**）| 凡命中 billType 的行写 markValue（无条件赋值）|
| F4-C | 0 billTypes（仅 markValue）→ dialog 校验拦截 | 引擎 warning + return |
| F4-D | 1 billType + 1 reconFields（左右 typeSeq 都 = 1，自己 vs 自己）| spec 阶段 PM 评估 — 推荐 warning 不跑（自配对无意义），可在 §15 衍生待澄清 |

### 5.10 previews 回归

C2 dialog 截图：新展示名 + 默认空状态（无预填行）。

### 5.11 风险与回归保护

- 🟡 dialog 校验放宽 + 引擎硬卡同步放开必须**同步发布**（否则 dialog 通过但 engine 不跑）
- 🟢 老 scenario（billTypes 2+ 行）100% 向下兼容
- 🟢 grep `账单打标\|打标值\|打标` 全文核对：3 处校验文案 + 2 处类别 label + 1 处 dialog label + 1 处 confirm 预览 + 3 处文档 = 共 ~10 处替换

---

## 六、F6 — 收单单据币种校验模块：状态框运行进度显示

### 6.1 IPC 通道命名

- `acquiringBillCurrency:import:progress`（main → renderer）
- `acquiringBillCurrency:run:progress`（main → renderer）

（命名对齐 `pending:import:progress` 范式：`<namespace>:<phase>:progress`）

### 6.2 Session 层：runCheck 加 onProgress（`src/main-process/acquiring-bill-currency-session.js:163-237`）

```js
// 现状
async function runCheck({ db, monthKey, storageRoot }) {
  if (!monthKey) throw new Error('runCheck：monthKey 必填');
  const { flowReady, billReady } = importRepo.getMonthReadiness(db, monthKey);
  if (!flowReady) throw new Error(`${monthKey}：流水表尚未导入`);
  if (!billReady) throw new Error(`${monthKey}：单据表尚未导入`);

  const runT0 = Date.now();
  let runId;
  let stats;
  let insertedDiffRows;

  safeBegin(db);
  try {
    runRepo.clearRunsByMonth(db, monthKey);
    stats = runRepo.computeRunStats(db, { monthKey });
    runId = runRepo.insertRun(db, { monthKey, ranAt: nowIso(), ... });
    insertedDiffRows = runRepo.insertDiffRowsByJoin(db, { runId, monthKey });
    db.exec('COMMIT');
    ...
  } catch (error) { safeRollback(db); throw error; }

  // 写盘 diff + report
  let diffFilePath = null;
  let reportFilePath = null;
  if (storageRoot) {
    try {
      const writer = require('./acquiring-bill-currency-writer');
      const out = await writer.writeRunOutputs({ ... });
      diffFilePath = out.diffFilePath;
      reportFilePath = out.reportFilePath;
      runRepo.updateRunPaths(db, { runId, diffFilePath, reportFilePath });
    } catch (writeError) { ... }
  }
  ...
}

// 改后
async function runCheck({ db, monthKey, storageRoot, onProgress }) {  // ⭐ 新增 onProgress
  if (!monthKey) throw new Error('runCheck：monthKey 必填');
  const { flowReady, billReady } = importRepo.getMonthReadiness(db, monthKey);
  if (!flowReady) throw new Error(`${monthKey}：流水表尚未导入`);
  if (!billReady) throw new Error(`${monthKey}：单据表尚未导入`);

  const runT0 = Date.now();
  let runId;
  let stats;
  let insertedDiffRows;

  safeBegin(db);
  try {
    if (onProgress) onProgress({ phase: 'run', stage: 'clearing-old-runs' });           // ⭐ 1
    runRepo.clearRunsByMonth(db, monthKey);

    if (onProgress) onProgress({ phase: 'run', stage: 'computing-stats' });             // ⭐ 2
    stats = runRepo.computeRunStats(db, { monthKey });

    if (onProgress) onProgress({ phase: 'run', stage: 'inserting-run' });               // ⭐ 3
    runId = runRepo.insertRun(db, { monthKey, ranAt: nowIso(), ... });

    if (onProgress) onProgress({ phase: 'run', stage: 'sql-joining', mismatchHint: stats.mismatchRows });  // ⭐ 4
    insertedDiffRows = runRepo.insertDiffRowsByJoin(db, { runId, monthKey });

    db.exec('COMMIT');
    ...
  } catch (error) { safeRollback(db); throw error; }

  let diffFilePath = null;
  let reportFilePath = null;
  if (storageRoot) {
    try {
      if (onProgress) onProgress({ phase: 'run', stage: 'writing-xlsx' });              // ⭐ 5
      const writer = require('./acquiring-bill-currency-writer');
      const out = await writer.writeRunOutputs({ ... });
      diffFilePath = out.diffFilePath;
      reportFilePath = out.reportFilePath;

      if (onProgress) onProgress({ phase: 'run', stage: 'updating-paths' });            // ⭐ 6
      runRepo.updateRunPaths(db, { runId, diffFilePath, reportFilePath });
    } catch (writeError) { ... }  // 不动
  }
  ...
}
```

**关键不变量**：
- onProgress 缺失时（旧 caller）所有 `if (onProgress)` 守护语句跳过 → 行为与 v2.1.6 一致
- 不改任何业务逻辑 / SQL JOIN / writer 调用
- 6 个埋点都是同步 nextTick 触发，不引入 await（不改控制流）

### 6.3 Main.js handler 接通（`src/main.js:10119-10126, 10182-10187, 10219`）

**改动点 1**：import handler 桥接（L10119-10126 sessionOverwrite 调用 + L10182-10187 sessionImport 调用）。

```js
// 现状（doHandleImportFlowOrBill 内）
const result = await sessionOverwrite({
  db: database.db,
  monthKey,
  filePaths: payload.filePaths
});

// 改后 — 需把 event 传入；当前 handler 签名是 (_event, payload)，
// 需在 trackedIpcHandle 回调里把 event 传到 handleImportFlowOrBill → doHandleImportFlowOrBill
trackedIpcHandle('acquiringBillCurrency:importFlow', '收单单据币种校验', '导入流水表', async (event, payload = {}) => {
  return handleImportFlowOrBill('flow', payload, event);  // ⭐ 传 event
});

// 内部链路把 event 透传到 sessionOverwrite / sessionImport
const result = await sessionOverwrite({
  db: database.db,
  monthKey,
  filePaths: payload.filePaths,
  onProgress: createImportProgressForwarder(event)  // ⭐
});

// helper（在 acquiringBillCurrency handler 注册块顶部）
function createImportProgressForwarder(event) {
  let lastSentAt = 0;
  const THROTTLE_MS = 100;
  return (ev) => {
    const now = Date.now();
    const isStageSwitch = ev.stage === 'reading';   // stage 切换事件必发
    if (!isStageSwitch && now - lastSentAt < THROTTLE_MS) return;
    lastSentAt = now;
    try { event.sender.send('acquiringBillCurrency:import:progress', { ...ev, phase: 'import' }); }
    catch (_e) { /* swallow */ }
  };
}
```

**改动点 2**：run handler 桥接（L10208-10248）。

```js
trackedIpcHandle('acquiringBillCurrency:run', '收单单据币种校验', '开始运行', async (event, payload = {}) => {
  if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
  const { monthKey } = payload || {};
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return { status: 'error', message: 'monthKey 格式错误（应为 YYYY-MM）' };
  const lock = tryAcquireOpLock('run', monthKey);
  if (!lock.acquired) return { status: 'error', message: lock.message };
  let result;
  try {
    const storageRoot = ensureStorageRoot();
    const onProgress = createRunProgressForwarder(event);  // ⭐
    result = await acquiringBillCurrencySession.runCheck({ db: database.db, monthKey, storageRoot, onProgress });  // ⭐ 传 onProgress
  } catch (err) {
    releaseOpLock();
    return { status: 'error', message: err && err.message ? err.message : String(err) };
  }
  releaseOpLock();
  ...
});

// run progress forwarder（stage 切换全发，无节流，因每 run 只 6 次事件）
function createRunProgressForwarder(event) {
  return (ev) => {
    try { event.sender.send('acquiringBillCurrency:run:progress', { ...ev, phase: 'run' }); }
    catch (_e) { /* swallow */ }
  };
}
```

### 6.4 Preload 暴露订阅接口（`src/preload.js:265-273`）

```js
// 现状
acquiringBillCurrency: {
  listMonths: () => ipcRenderer.invoke('acquiringBillCurrency:listMonths'),
  sessionStatus: (payload) => ipcRenderer.invoke('acquiringBillCurrency:sessionStatus', payload),
  importFlow: (payload) => ipcRenderer.invoke('acquiringBillCurrency:importFlow', payload),
  importBill: (payload) => ipcRenderer.invoke('acquiringBillCurrency:importBill', payload),
  run: (payload) => ipcRenderer.invoke('acquiringBillCurrency:run', payload),
  export: (payload) => ipcRenderer.invoke('acquiringBillCurrency:export', payload),
  clearMonth: (payload) => ipcRenderer.invoke('acquiringBillCurrency:clearMonth', payload)
}

// 改后（追加 2 个订阅 API + 返回 removeListener 句柄方便取消订阅）
acquiringBillCurrency: {
  ...原 7 个 invoke channel 不动...,
  // ⭐ 新增
  onImportProgress: (listener) => {
    const wrapped = (_event, ev) => listener(ev);
    ipcRenderer.on('acquiringBillCurrency:import:progress', wrapped);
    return () => ipcRenderer.removeListener('acquiringBillCurrency:import:progress', wrapped);
  },
  onRunProgress: (listener) => {
    const wrapped = (_event, ev) => listener(ev);
    ipcRenderer.on('acquiringBillCurrency:run:progress', wrapped);
    return () => ipcRenderer.removeListener('acquiringBillCurrency:run:progress', wrapped);
  }
}
```

### 6.5 Renderer 订阅 + 文案刷新（`src/renderer.js:4276-4377`）

**改动点 1**：文案格式化 helper（在 setAcquiringBillCurrencyStatus 附近新增）。

```js
function formatAcquiringBillCurrencyProgress(ev) {
  if (!ev || !ev.phase) return '';
  if (ev.phase === 'import') {
    if (ev.stage === 'reading') {
      const i = (typeof ev.fileIndex === 'number') ? ev.fileIndex + 1 : '?';
      const n = ev.fileCount || '?';
      const file = ev.filePath ? ev.filePath.split(/[\\/]/).pop() : '?';
      return `正在导入 ${file} 文件 (${i}/${n} 个文件)`;  // ⭐ 用户原话风格
    }
    if (ev.stage === 'inserting') {
      const i = (typeof ev.fileIndex === 'number') ? ev.fileIndex + 1 : '?';
      const n = ev.fileCount || '?';
      const file = ev.sourceFile || '?';
      const c = (ev.importedCount || 0).toLocaleString();
      return `正在写入 ${file}：已读取 ${c} 行 (${i}/${n} 个文件)`;
    }
  }
  if (ev.phase === 'run') {
    switch (ev.stage) {
      case 'clearing-old-runs': return '正在清理该月旧 run 数据...';
      case 'computing-stats':   return '正在统计行数...';
      case 'inserting-run':     return '正在创建 run 记录...';
      case 'sql-joining':       return '正在做 SQL JOIN 比对币种...';
      case 'writing-xlsx':      return '正在写入差异表 Excel...';
      case 'updating-paths':    return '正在回填文件路径...';
      default: return `运行中：${ev.stage}`;
    }
  }
  return '';
}
```

**改动点 2**：`runAcquiringBillCurrencyImport` 加 listener（L4276-4340）。

```js
async function runAcquiringBillCurrencyImport(kind) {
  const labelTable = kind === 'flow' ? '流水表' : '单据表';
  const apiCall = kind === 'flow'
    ? (payload) => window.desktopApi.acquiringBillCurrency.importFlow(payload)
    : (payload) => window.desktopApi.acquiringBillCurrency.importBill(payload);

  const monthKey = await pickAcquiringBillCurrencyMonth('导入');
  if (!monthKey) {
    setAcquiringBillCurrencyStatus('已取消导入', 'info');
    return;
  }

  setAcquiringBillCurrencyButtonsDisabled(true);
  setAcquiringBillCurrencyStatus(`正在导入${labelTable}（${monthKey}）...`, 'info');

  // ⭐ 订阅 import progress
  const unsubscribe = window.desktopApi.acquiringBillCurrency.onImportProgress((ev) => {
    const text = formatAcquiringBillCurrencyProgress(ev);
    if (text) setAcquiringBillCurrencyStatus(text, 'info');
  });

  try {
    const first = await apiCall({ monthKey });
    ...（原逻辑不变）
  } catch (e) {
    setAcquiringBillCurrencyStatus(`${labelTable}导入异常：${e.message || e}`, 'error');
  } finally {
    if (unsubscribe) unsubscribe();   // ⭐ 取消订阅防内存泄漏
    setAcquiringBillCurrencyButtonsDisabled(false);
  }
}
```

**改动点 3**：`handleAcquiringBillCurrencyRun` 加 listener（L4350-4377）。

```js
async function handleAcquiringBillCurrencyRun() {
  const monthKey = await pickAcquiringBillCurrencyMonth('运行');
  if (!monthKey) {
    setAcquiringBillCurrencyStatus('已取消运行', 'info');
    return;
  }
  setAcquiringBillCurrencyButtonsDisabled(true);
  setAcquiringBillCurrencyStatus(`正在对账（${monthKey}）...`, 'info');

  // ⭐ 订阅 run progress
  const unsubscribe = window.desktopApi.acquiringBillCurrency.onRunProgress((ev) => {
    const text = formatAcquiringBillCurrencyProgress(ev);
    if (text) setAcquiringBillCurrencyStatus(text, 'info');
  });

  try {
    const result = await window.desktopApi.acquiringBillCurrency.run({ monthKey });
    ...（原逻辑不变；最终 setStatus 成功/失败文案不变）
  } catch (e) {
    setAcquiringBillCurrencyStatus(`对账异常：${e.message || e}`, 'error');
  } finally {
    if (unsubscribe) unsubscribe();   // ⭐
    setAcquiringBillCurrencyButtonsDisabled(false);
  }
}
```

### 6.6 不动的部分

- session.importFlowFiles / importBillFiles / importFlowFilesWithOverwrite / importBillFilesWithOverwrite — onProgress 链路已就绪，不改
- reader.streamImportOneFile — onProgress 节流（每 10000 行）已就绪，不改
- 7 个原 IPC channel（listMonths / sessionStatus / importFlow / importBill / run / export / clearMonth）— 行为不变
- runCheck 错误处理 / `success-no-files` 路径 / cleanup 链路 — 不动
- writer.writeRunOutputs 内部分 sheet 行为 — 不动（spec §11.3.4 提到的"writer 按 sheet 分段触发进度"留 v2.1.8）

### 6.7 smoke 用例

`scripts/smoke/acquiring-bill-currency-progress.js`（新建）：

| Case | 输入 | 期望 |
|---|---|---|
| F6-A | importFlowFiles({ filePaths: 3 个 xlsx, onProgress: collector }) | onProgress 至少触发 3 次 `stage:'reading'` + 若每文件 ≥ 10000 行则触发 N 次 `stage:'inserting'` |
| F6-B | runCheck({ onProgress: collector }) | onProgress 按顺序触发 6 次：`clearing-old-runs` / `computing-stats` / `inserting-run` / `sql-joining` / `writing-xlsx` / `updating-paths` |
| F6-C | runCheck({ /* 无 onProgress */ }) | 不抛错；返回值与 v2.1.6 一致（regression baseline）|
| F6-D | main.js handler 层节流：模拟 reader 高频触发 `inserting` 事件（间隔 < 100ms）| renderer 收到事件总数 ≤ reader 触发数；`reading` 事件必发不丢 |

### 6.8 previews 回归

F6 仅运行时动态文案 → **默认不强制回归**；preview 默认走"欢迎使用小助手"初始态与 v2.1.6 一致。

### 6.9 性能保护

- 端到端 totalElapsedMs 增长 < 5%（与 v2.1.6 对比；用 v2.1.6 500w 行测试样本回测）
- IPC 事件总数 ≤ `fileCount × (1 + ceil(rowPerFile / 10000)) + 6 (run 阶段)`

### 6.10 风险与回归保护

- 🟡 listener 内存泄漏 → finally `if (unsubscribe) unsubscribe()` 显式取消
- 🟡 `webContents.send` 失败 / 窗口已销毁 → try/catch swallow（参考 `main.js:9520` 范式）
- 🟢 不改业务逻辑 → 资金红线零命中
- 🟢 旧 caller 无 onProgress 入参 → 守护语句保证行为不变

---

## 七、F7 — 收单单据币种校验 SQL 调优 + 完成系统通知

### 7.1 子任务划分（与 PRD §十二对齐）

| 子任务 | 性质 | 改动文件 | 改动量 |
|---|---|---|---|
| A1 PRAGMA 全局应用 | 性能（全局影响 3 套业务引擎）| `src/backend/database.js` | ~6 行 diff |
| A2 索引兜底 + ANALYZE | 性能（局部 acquiring-bill-currency）| `src/backend/database/migrations.js` + `src/backend/database.js`（ANALYZE 调用）| ~15 行 diff |
| B1 Electron Notification | UX（main 进程通知）| `src/main.js`（destructure + 2 处 return 前调用）| ~20 行 diff |

### 7.2 现状定位（PM 已 grep 验证）

| 文件:行号 | 现状 | F7 用途 |
|---|---|---|
| `src/backend/database.js:41-42` | `this.db = new DatabaseSync(this.dbPath); this.db.exec('PRAGMA foreign_keys = ON;');` | F7-A1 落点：紧贴 L42 追加 4 条 PRAGMA |
| `src/backend/database.js:39` | `init() { fs.mkdirSync(...); this.db = ...; this.db.exec('PRAGMA foreign_keys = ON;'); /* 后续是 CREATE TABLE 等 migration 入口 */ }` | F7-A2 ANALYZE 落点：init() **末尾**（所有 migration 跑完后）追加 |
| `src/backend/database/migrations.js:967-997` | 已有 `idx_acquiring_bill_currency_flow_join` + `idx_acquiring_bill_currency_bill_join` 覆盖 JOIN ON `(month_key, recon_main_id)`；UNIQUE 约束本身也自动建索引 | F7-A2 **JOIN ON 不需改**；真正需加的是 source_file 索引 |
| `src/backend/acquiring-bill-currency-db/run-repository.js:114, 130, 180` | writer 阶段 3 个高频按 `source_file` 查询 / ORDER BY 的函数，**当前无 source_file 索引** | F7-A2 加 `idx_acquiring_bill_currency_bill_source_file` |
| `src/backend/database/migrations.js:945` | `ensureAcquiringBillCurrencyTablesSupport(db)` helper 范式（事务包 CREATE TABLE/INDEX IF NOT EXISTS） | F7-A2 在此 helper 末尾追加 source_file 索引（或新建 ensureAcquiringBillCurrencySourceFileIndex helper）|
| `src/main.js:6` | `const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');` | F7-B1：destructure 加 `Notification` |
| `src/main.js:10240` | `trackedIpcHandle('acquiringBillCurrency:run', ..., async (event, payload) => { ... result = await runCheck(...); ... return { status: 'success', ...result } / { status: 'error', ... } })` | F7-B1：在 2 处 return 前各加一次 try/catch Notification 调用 |

### 7.3 改动 diff（A1 PRAGMA）

```js
// src/backend/database.js:41-42 现状
this.db = new DatabaseSync(this.dbPath);
this.db.exec('PRAGMA foreign_keys = ON;');

// 改后
this.db = new DatabaseSync(this.dbPath);
this.db.exec('PRAGMA foreign_keys = ON;');
// v2.1.7 F7-A1：全局 SQL 调优（影响 bank-bu-recon / biz-op-recon / acquiring-bill-currency 三套业务引擎）
this.db.exec('PRAGMA journal_mode = WAL;');        // 读写并发更好，崩溃恢复保留；切换后产生 *.sqlite-wal / *.sqlite-shm 旁文件
this.db.exec('PRAGMA synchronous = NORMAL;');      // WAL 模式下安全 + 性能 2-3 倍（顺序：必须在 WAL 之后设）
this.db.exec('PRAGMA cache_size = -65536;');       // 64MB 页缓存（负数 = KB 单位，-65536 = 65536KB = 64MB）
this.db.exec('PRAGMA mmap_size = 268435456;');     // 256MB 内存映射，SATA SSD 顺序读受益
```

**关键不变量**：
- 4 条 PRAGMA 顺序固定：foreign_keys → journal_mode(WAL) → synchronous(NORMAL) → cache_size → mmap_size；synchronous=NORMAL 必须在 WAL 模式之后（FULL 模式下 NORMAL 不安全）
- `db.exec` 幂等：多次 init 不会出错
- `journal_mode = WAL` 持久化在 DB 元数据，首次启动后即生效

### 7.4 改动 diff（A2 索引 + ANALYZE）

#### 7.4.1 新增 source_file 索引（`src/backend/database/migrations.js`）

**位置选择**：方案 A（推荐）在 `ensureAcquiringBillCurrencyTablesSupport` 内 bill_imports 块尾追加；方案 B 新建 `ensureAcquiringBillCurrencySourceFileIndex` 独立 helper（与 v2.1.6 fix4 风格一致）。**PM 推荐方案 A**（与同表索引就近放置，diff 最小）。

```js
// migrations.js:995-997 现状（bill_imports 已有 month_key 与 join 索引）
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join
    ON acquiring_bill_currency_bill_imports(month_key, recon_main_id);
`);

// 改后（在 join 索引后追加）
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join
    ON acquiring_bill_currency_bill_imports(month_key, recon_main_id);
`);
// v2.1.7 F7-A2：writer 阶段 listDiffRowsBySourceFile / listAllDiffRowsByRun ORDER BY source_file
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_source_file
    ON acquiring_bill_currency_bill_imports(source_file);
`);
```

#### 7.4.2 启动期 ANALYZE（`src/backend/database.js init()` 末尾）

ANALYZE 必须在所有 migration / CREATE TABLE/INDEX 跑完后调用（让规划器统计**最新的**索引）。当前 init() 结构：

```
init() {
  fs.mkdirSync(...);
  this.db = new DatabaseSync(...);
  this.db.exec('PRAGMA foreign_keys = ON;');
  this.db.exec(`CREATE TABLE IF NOT EXISTS templates ...`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS template_mappings ...`);
  ...更多 CREATE TABLE
  runMigrations(this.db);  // 触发 ensure* helpers
  // ⭐ F7-A2 ANALYZE 落点：在所有 migration 跑完后
  this.db.exec('ANALYZE;');
}
```

**关键不变量**：
- ANALYZE 幂等，可重复
- 启动期开销 < 100ms（v2.1.6 用户 DB 体量）
- 必须在 migration 之后（否则统计的是旧 schema）

### 7.5 改动 diff（B1 Electron Notification）

#### 7.5.1 destructure 加 Notification（`src/main.js:6`）

```js
// 现状
const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');

// 改后
const { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification } = require('electron');
```

#### 7.5.2 runCheck handler success / error 前弹通知（`src/main.js:10240-10260` 附近）

```js
// 现状（关键路径）
trackedIpcHandle('acquiringBillCurrency:run', '收单单据币种校验', '开始运行', async (event, payload = {}) => {
  ...
  let result;
  try {
    const storageRoot = ensureStorageRoot();
    const onProgress = createRunProgressForwarder(event);
    result = await acquiringBillCurrencySession.runCheck({ db: database.db, monthKey, storageRoot, onProgress });
  } catch (err) {
    releaseOpLock();
    return { status: 'error', message: err && err.message ? err.message : String(err) };
  }
  releaseOpLock();
  ...
  return { status: 'success', ...result };
});

// 改后（success / error 前各加一次通知调用 + helper 抽出）
function notifyAcquiringBillCurrencyResult(monthKey, kind, payload) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return;
    let title, body;
    if (kind === 'success') {
      title = '收单单据币种校验';
      body = `${monthKey} 对账完成（共 ${payload.mismatchRows || 0} 行差异）`;
    } else {
      title = '收单单据币种校验';
      const msg = payload && payload.message ? String(payload.message) : '未知错误';
      body = `对账失败：${msg}`.slice(0, 200);  // macOS 通知中心截断兜底
    }
    new Notification({ title, body }).show();
  } catch (_e) { /* swallow — 通知失败不影响 IPC return */ }
}

// 用法
} catch (err) {
  releaseOpLock();
  notifyAcquiringBillCurrencyResult(monthKey, 'error', { message: err && err.message });  // ⭐
  return { status: 'error', message: err && err.message ? err.message : String(err) };
}
releaseOpLock();
...
notifyAcquiringBillCurrencyResult(monthKey, 'success', { mismatchRows: result.mismatchRows });  // ⭐
return { status: 'success', ...result };
```

**关键不变量**：
- helper 内部 try/catch swallow，通知失败不影响业务 return
- `Notification.isSupported()` 兜底极端环境（如 SSH 无 GUI 头）
- body 限长 200 字符
- 通知前缀统一 `「收单单据币种校验」`（PRD §12.3.3 拍板）
- **不弹通知给"用户主动 cancel"路径**（仅 success + 真正 error）

### 7.6 smoke 用例

新建 `scripts/smoke/acquiring-bill-currency-pragma.js` 或追加到现有 progress.js / acquiring-bill-currency.js：

#### 7.6.1 PRAGMA 应用断言（F7-A1）

```js
// 用户 DB 启动后查询 PRAGMA 值
const journalMode = db.prepare("PRAGMA journal_mode;").get();         // 期望 'wal'
const synchronous = db.prepare("PRAGMA synchronous;").get();          // 期望 1 (NORMAL)
const cacheSize = db.prepare("PRAGMA cache_size;").get();             // 期望 -65536
const mmapSize = db.prepare("PRAGMA mmap_size;").get();               // 期望 268435456
assert.strictEqual(journalMode.journal_mode, 'wal');
assert.strictEqual(synchronous.synchronous, 1);
assert.strictEqual(cacheSize.cache_size, -65536);
assert.strictEqual(mmapSize.mmap_size, 268435456);
```

#### 7.6.2 索引存在断言（F7-A2）

```js
const indexes = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='index'
    AND name='idx_acquiring_bill_currency_bill_source_file'
`).all();
assert.strictEqual(indexes.length, 1);

// ANALYZE 已跑断言
const stat1 = db.prepare("SELECT COUNT(*) AS c FROM sqlite_stat1").get();
assert.ok(stat1.c > 0, 'ANALYZE should have populated sqlite_stat1');
```

#### 7.6.3 Notification 调用桩（F7-B1）

```js
// mock 'electron' Notification
const NotificationCalls = [];
const Notification = function (opts) {
  NotificationCalls.push(opts);
  return { show: () => {} };
};
Notification.isSupported = () => true;

// 触发 runCheck success / error
notifyAcquiringBillCurrencyResult('2026-05', 'success', { mismatchRows: 42 });
assert.strictEqual(NotificationCalls[0].title, '收单单据币种校验');
assert.strictEqual(NotificationCalls[0].body, '2026-05 对账完成（共 42 行差异）');

notifyAcquiringBillCurrencyResult('2026-05', 'error', { message: 'X'.repeat(300) });
assert.ok(NotificationCalls[1].body.length <= 200);

// isSupported = false 不抛错
Notification.isSupported = () => false;
notifyAcquiringBillCurrencyResult('2026-05', 'success', { mismatchRows: 0 });  // no-op，不抛
```

### 7.7 全 19 个 smoke suite 回归矩阵（F7-A1 PRAGMA 全局影响）

详 PRD §12.5。spec 强约束：T13.1（A1 PRAGMA） + T13.2（A2 索引）落地后**必须**跑完 19 个 suite 全过，才能进 T14 收口。

```bash
npm run smoke  # 涵盖全 19 个 suite
```

任一 suite 失败 → 必须在 spec 阶段定位回归原因（WAL 模式 / synchronous / cache_size / mmap_size 谁触发的）+ 修复。

### 7.8 不动的部分

- 收单单据币种校验业务逻辑（runCheck / insertDiffRowsByJoin SQL / 文件输出 / cleanup 链路）
- 现有 PRAGMA `foreign_keys = ON`（保留）
- 现有索引（`idx_acquiring_bill_currency_flow_join` / `idx_acquiring_bill_currency_bill_join` / `idx_acquiring_bill_currency_diff_run` 等）
- 现有 `acquiringBillCurrency:run` handler 的 IPC 入参 / 状态文本 / 错误处理逻辑（B1 仅在 return 前加通知）

### 7.9 性能保护

- F7-A1 期望 SQL JOIN 提速 1.5-2x（synchronous=NORMAL + 64MB cache + 256MB mmap）；但 stage 4 单条大 SQL 仍可能 5s+ 不让出 event loop —— **F7 是缓解，不是根治**；根治留 v2.1.8 A3 worker_threads
- F7-A2 ANALYZE 启动期开销 < 100ms
- F7-B1 Notification 调用开销 < 5ms（用户视感无延迟）

### 7.10 用户文档（USER_GUIDE）

`docs/USER_GUIDE.md` 加一段（位置：收单单据币种校验章节末尾或附录"DB 备份注意事项"）：

```markdown
### DB 备份注意事项（v2.1.7 起 WAL 模式）

v2.1.7 起 SQLite 启用 WAL（Write-Ahead Logging）模式，应用运行期间 DB 目录会出现 3 个文件：

- `tool-data.sqlite`（主文件）
- `tool-data.sqlite-wal`（写前日志）
- `tool-data.sqlite-shm`（共享内存索引）

**正常关闭应用时** wal 内容会 checkpoint 回主文件，3 个文件备份主文件即可。
**应用运行期间手动备份** 必须**同时备份 3 个文件**，否则备份可能丢失最近未 checkpoint 的事务数据。
```

### 7.11 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | PRAGMA `journal_mode = WAL` 改变所有 DB 持久化行为；3 套业务引擎共享同一 DB instance | 全 19 个 smoke suite 必跑；PR body 高亮"WAL 模式下事务回滚行为与 DELETE 模式有微妙差异（如 rollback 后 wal 文件保留 frame，下次启动自动清理）" |
| 🟡 中 | WAL 旁文件产生 `*.sqlite-wal` + `*.sqlite-shm`，用户手动备份 DB 时可能漏拷 | USER_GUIDE 加 §7.10 提示；CHANGELOG v2.1.7 段高亮 |
| 🟡 中 | `synchronous = NORMAL` 与 WAL 顺序颠倒 → 非 WAL 模式下 NORMAL 不安全 | spec §7.3 关键不变量已明确顺序；T13.1 task 描述强调 |
| 🟢 低 | `cache_size = -65536`（64MB）在低内存机器上占用 | 用户 16GB RAM 充裕；spec 不引入运行时探测 |
| 🟢 低 | `mmap_size = 268435456`（256MB）在 32-bit 环境受限 | 项目 Electron 36 全 64-bit |
| 🟢 低 | F7-A2 source_file 索引重复建 | `CREATE INDEX IF NOT EXISTS` 幂等 |
| 🟢 低 | ANALYZE 启动期开销 | 实测 < 100ms |
| 🟢 低 | F7-B1 Notification 在用户系统通知关闭时不展示 | `Notification.isSupported()` 兜底；现有状态栏文案不靠通知判定结果 |
| 🟢 低 | B1 通知文案过长截断 | body 限长 200 字符 |

⚠️ **重要变量检查**：F7 修改 `AppDatabase.init`（database.js 类入口，已是项目级 DB 单例门面）；建议本迭代结束 `/check-vars` 时**评估升格 `AppDatabase` / `AppDatabase.init` 进 Important-skeleton 层**（PRAGMA 配置点全局影响）

⚠️ **previews 不涉及**：F7 无 UI 改动

---

## 八、round 2 — 用户手测反馈修复（R1-R5）

### 8.1 子任务划分（与 PRD §十三对齐）

| 子任务 | 性质 | 改动文件 | 改动量 | 风险 |
|---|---|---|---|---|
| R1 F4 删按钮门槛 | 1 字符 diff | `src/renderer-dialogs.js` | 1 char | 🟢 极低 |
| R2 F6 fileCount 注入 | bug 修 | `src/main-process/acquiring-bill-currency-session.js` | ~2 行 | 🟢 低 |
| R3 状态框「：」换行（全局规则）| 全局 UX 🚨 | `src/renderer.js` (updateStatusBox + setBizOpReconStatus hack 清理) + `src/styles.css` | ~5 行 + ~3 CSS | 🟡 中（全局 setStatus 影响 19 suite）|
| R4 acquiring 切模块按钮误启 | bug 修（仅 acquiring）| `src/renderer.js` (acquiringBillCurrencyState + restorePanelState + 3 个 handler) | ~10 行 | 🟢 低 |
| R5 F1 默认 AND + dialog 纵向 + 资金红线护栏 | 默认值 + UI + 护栏 | `src/renderer-dialogs.js` (默认 config + dialog HTML + pickConditionsLogicChecked helper) | ~30 行 | 🟡 中（资金红线护栏） |

### 8.2 R1 — F4 billTypes 删按钮门槛改 `=== 1`

**现状**：`src/renderer-dialogs.js:6676`

```js
${isReadonly || config.billTypes.length <= 2 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
```

**对照基准**：`src/renderer-dialogs.js:6700` reconFields 已用 `=== 1`

**改动 diff**：

```js
// L6676 改后（仅改一个字符串运算符）
${isReadonly || config.billTypes.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
```

**smoke**：（可选，非强制）

```js
// 构造 billTypes = [bt1, bt2] 调 renderBillTypes → DOM 检查 2 行均有 remove 按钮
// 构造 billTypes = [bt1] → 该行无 remove 按钮
```

**风险**：🟢 极低；1 字符 diff，零回归概率。

### 8.3 R2 — F6 inserting payload 显式注入 fileCount

**现状定位**（PM 已 grep 验证）：

| 文件:行号 | 现状 | 问题 |
|---|---|---|
| `reader.js:371-372` | `onProgress({ sourceFile, importedCount });` | reader 内部 payload **不带 fileCount** |
| `session.js:62-64`（importFilesInTransaction）| `onProgress: (p) => { if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p }); }` | `...p` 在 fileIndex 后，**会覆盖**外层任何相同字段；当前没传 fileCount → 渲染端 fallback "?" |
| `session.js:113-115`（importFilesWithOverwrite）| 同上 | 同上 |
| `renderer.js:4264 formatAcquiringBillCurrencyProgress` | `const n = ev.fileCount \|\| '?';` | fileCount undefined → "?" |

**改动 diff**：

```js
// session.js L62-64 / L113-115 现状
onProgress: (p) => {
  if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p });
}

// 改后：fileCount 在 ...p 之后（顺序 = source-of-truth）；防 reader payload 偶然覆盖
onProgress: (p) => {
  if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p, fileCount: filePaths.length });
}
```

**关键不变量**：
- `fileCount` 必须在 `...p` **之后**（对象 spread 后置 = 覆盖前置）
- `fileCount = filePaths.length`（事务入参的稳定数）
- reader 内部不需要改动

**smoke 增强**（合并到 F6 progress smoke）：

```js
// 调 importFlowFiles({ ..., onProgress: collector })
// collector 收到的事件中 stage === 'inserting' 的全部应有 fileCount === filePaths.length
const insertingEvents = collected.filter((ev) => ev.stage === 'inserting');
insertingEvents.forEach((ev) => assert.strictEqual(ev.fileCount, filePaths.length));
```

**风险**：🟢 低；payload 加字段不破坏现有字段消费方。

### 8.4 R3 — 状态框「：」换行（全局规则） 🚨

#### 8.4.1 现状定位（PM 已 grep 验证）

| 文件:行号 | 现状 | 评估 |
|---|---|---|
| `src/renderer.js:519-538 updateStatusBox` | `textEl.textContent = message;` | 默认 `white-space: normal` 不识别 `\n` |
| `src/renderer.js:4131-4143 setBizOpReconStatus` | hack：调 updateStatusBox 后 `textEl.innerHTML = formatBizOpReconStatusHtml(message)` 覆盖 | 局部 hack 仅 bizOpRecon |
| `src/styles.css:344 .status-box` | 无 white-space | 默认 normal 不换行 |
| `src/styles.css:2725 #bankStatementStatusBox .status-box-text` | `white-space: pre-line;` 已设 | 仅 bank-statement |

#### 8.4.2 改动 diff

**updateStatusBox 入口替换**（`src/renderer.js:519`）：

```js
// 现状
function updateStatusBox(box, message, tone = 'info', options = {}) {
  const { errorReportReady = false, manualBalancePromptReady = false, idleTitle = '' } = options;
  const textEl = box.querySelector('.status-box-text');
  if (textEl) textEl.textContent = message;
  ...
}

// 改后
function updateStatusBox(box, message, tone = 'info', options = {}) {
  const { errorReportReady = false, manualBalancePromptReady = false, idleTitle = '' } = options;
  // R3：中文「：」后强制换行（仅作用于全角冒号；半角 ':' 不动，避开 URL/timestamp/账号 case）
  // null/undefined 兜底 → 空串（防 String(null) === 'null' 显示）
  const text = (message === null || message === undefined) ? '' : String(message).replace(/：/g, '：\n');
  const textEl = box.querySelector('.status-box-text');
  if (textEl) textEl.textContent = text;
  ...
}
```

**CSS 全局**（**T14 反向同步修正：active CSS 是 `src/styles-gemini-extra.css` 而非 `src/styles.css`**；index.html `cssGeneral` 被 disabled，仅 `cssClear` + `cssClearExtra` 生效。加在 `.status-box` 附近 line 358 附近）：

```css
.status-box-text {
  white-space: pre-wrap;  /* R3：识别 \n + 长行自动换 */
}
```

> **T14 反向同步说明**：spec §8.4.2 起草时误写"styles.css"，dev round 2 R3 实际改的是 `src/styles-gemini-extra.css`（commit bcabe29），与 active CSS 一致。本节误指路在 Dev round 3-6 多次 grep 时被发现，T14 收口修正。原 spec §4.1 / §8.4.1 / §8.4.2 / §13.4.1 等多处"styles.css"应全部理解为"styles-gemini-extra.css"。

**清理 bizOpRecon hack**（`src/renderer.js:4131-4143`）：

```js
// 现状（删 hack）
function setBizOpReconStatus(message, tone = 'info') {
  if (!elements.bizOpReconStatusBox) return;
  updateStatusBox(elements.bizOpReconStatusBox, message, tone, {
    idleTitle: '欢迎使用小助手'
  });
  // R3 清理：原 innerHTML 覆盖 + formatBizOpReconStatusHtml 调用全部删除
}
```

**关键不变量**：
- 只 `replace` 中文「：」（U+FF1A）；半角 `:`（U+003A）保留
- null/undefined 必须兜底空串
- `textEl.textContent` 仍是赋值入口（不切到 innerHTML，避免 XSS 风险）
- CSS `pre-wrap` 与 `pre-line` 共存无冲突；`#bankStatementStatusBox .status-box-text` 仍取 ID 优先级 `pre-line`，二者都识别 `\n`

#### 8.4.3 19 suite 回归矩阵

详 §7.7（F7-A1 已建立的全 19 suite 矩阵）。R3 同样必须 19 suite 全过；任一失败需定位是 updateStatusBox 还是 textContent 升级到 textEl 修改回的副作用。

#### 8.4.4 smoke 用例

`scripts/smoke/render-status-box.js`（新建或扩展现有 renderer 相关 smoke）：

```js
// 单测 updateStatusBox 入口转换
// 注：渲染端单测需用 jsdom 或 mock DOM
const fakeBox = createFakeStatusBox();  // 含 .status-box-text 子节点
updateStatusBox(fakeBox, '正在导入：xxx', 'info');
const textEl = fakeBox.querySelector('.status-box-text');
assert.strictEqual(textEl.textContent, '正在导入：\nxxx');

// null/undefined 兜底
updateStatusBox(fakeBox, null, 'info');
assert.strictEqual(fakeBox.querySelector('.status-box-text').textContent, '');

// 半角 ':' 不换行
updateStatusBox(fakeBox, 'GET http://example.com:8080', 'info');
assert.strictEqual(fakeBox.querySelector('.status-box-text').textContent, 'GET http://example.com:8080');

// 多个「：」全部换行
updateStatusBox(fakeBox, '导入失败：表头错：实际 27 列', 'info');
assert.strictEqual(fakeBox.querySelector('.status-box-text').textContent, '导入失败：\n表头错：\n实际 27 列');
```

#### 8.4.5 R3 文案审计（spec 阶段执行，半小时内完成）

PM 建议 spec 阶段 grep 一遍：

```bash
grep -rn "setStatus\|setBizOpReconStatus\|setBankBuReconStatus\|setAcquiringBillCurrencyStatus\|setNewAccountStatus" src/renderer.js | grep -v "function "
```

识别**含半角 `:`** 的调用方文案（如 detail 拼接 `result.message + ': ' + detail`），评估是否要换中文「：」。**本次 R3 只加规则不强制改文案**；少量必须换行的半角 `:` 调用方文案，spec 在审计后产出"候选改文案"清单，由 dev 阶段决定改不改（非阻塞）。

#### 8.4.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | 全局 setStatus 影响所有模块 | 19 suite 全跑 + 4 个模块手测各跑一遍含「：」文案 |
| 🟢 低 | bizOpRecon hack 删除后行为不一致 | R3 方案 A 覆盖了 hack 的所有场景；manual smoke bizOpRecon 状态框换行行为不变 |
| 🟢 低 | bankStatement `pre-line` 与新 `pre-wrap` 冲突 | CSS ID 优先级 > class，bankStatement 仍取 `pre-line`；二者都识别 `\n` 兼容 |

### 8.5 R4 — acquiring 切模块按钮误启用

#### 8.5.1 现状定位（PM 已 grep 验证）

| 文件:行号 | 现状 | 评估 |
|---|---|---|
| `src/renderer.js:4233 acquiringBillCurrencyState` | `{ latestMonth: null }` — **无 inflight flag** | 需加 inflightOperation 字段 |
| `src/renderer.js:4285 restoreAcquiringBillCurrencyPanelState` | `setAcquiringBillCurrencyButtonsDisabled(false);` — **无脑解禁** | 改为按 flag 决定 |
| `src/renderer.js:4292 setAcquiringBillCurrencyButtonsDisabled` | 工具函数现状不变 | 保留 |
| `src/renderer.js:3938 restoreBankBuReconPanelState` | 调 `applyBankBuReconButtonState()`（按 state） | **无问题** |
| `src/renderer.js:4225 restoreBizOpReconPanelState` | 调 `applyBizOpReconButtonState()` | **无问题** |

**衍生评估**：R4 仅 acquiring 模块需修；不扩散到 bankBuRecon / bizOpRecon / pending。

#### 8.5.2 改动 diff

```js
// renderer.js L4233 — acquiringBillCurrencyState 加 inflightOperation flag
const acquiringBillCurrencyState = {
  latestMonth: null,
  // R4：当前正在执行的操作（'import' | 'run' | 'export' | null）；切模块后 restorePanelState 据此决定按钮 disabled
  inflightOperation: null
};

// renderer.js L4285 — restoreAcquiringBillCurrencyPanelState 按 flag 决定
function restoreAcquiringBillCurrencyPanelState() {
  setAcquiringBillCurrencyStatus('欢迎使用小助手', 'info');
  // R4：有 inflight 任务时保持按钮禁用（防切回后用户重复点击触发并发 IPC）
  setAcquiringBillCurrencyButtonsDisabled(!!acquiringBillCurrencyState.inflightOperation);
}

// renderer.js L4317-4396 — runAcquiringBillCurrencyImport 加 flag 管理
async function runAcquiringBillCurrencyImport(kind) {
  ...
  const monthKey = await pickAcquiringBillCurrencyMonth('导入');
  if (!monthKey) {
    setAcquiringBillCurrencyStatus('已取消导入', 'info');
    return;
  }

  acquiringBillCurrencyState.inflightOperation = 'import';  // ⭐ R4
  setAcquiringBillCurrencyButtonsDisabled(true);
  setAcquiringBillCurrencyStatus(`正在导入${labelTable}（${monthKey}）...`, 'info');

  const unsubscribe = window.desktopApi.acquiringBillCurrency.onImportProgress(...);

  try {
    ...
  } catch (e) {
    setAcquiringBillCurrencyStatus(`${labelTable}导入异常：${e.message || e}`, 'error');
  } finally {
    acquiringBillCurrencyState.inflightOperation = null;   // ⭐ R4 — 防泄漏
    if (unsubscribe) unsubscribe();
    setAcquiringBillCurrencyButtonsDisabled(false);
  }
}

// handleAcquiringBillCurrencyRun 同范式：set 'run' → finally null
// handleAcquiringBillCurrencyExport 同范式：set 'export' → finally null
```

**关键不变量**：
- inflightOperation **必须** finally 清除（异常路径也要清）
- flag 仅设在按钮 disable 之前那一刻（用户主动 cancel 月份弹窗时不设，保持原行为）
- 与 main.js 的 `acquiringBillCurrencyOperationLock` 互补：main 端兜底防并发 IPC；renderer 端 UI 体感正确

#### 8.5.3 smoke（不强制；手测覆盖）

R4 是纯 UI 状态切换 + 跨模块切换；smoke 不易模拟"切模块"事件。**手测覆盖**即可：

- 手测 1：开始 import 大数据 → 切到其它模块 → 切回 acquiring → 4 按钮仍 disabled
- 手测 2：完成 import → 切走再切回 → 4 按钮 enabled
- 手测 3：失败 import → 切走再切回 → 4 按钮 enabled（错误已显示）
- 手测 4：开始 run（含 5 阶段进度）→ 切到其它模块 → 切回 → 4 按钮仍 disabled

#### 8.5.4 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 仅 acquiring 模块受影响 | 其它模块 PM 已 grep 验证用 apply*ButtonState 范式；不扩散 |
| 🟢 低 | 异常路径漏清 flag | spec §8.5.2 强制 finally 清；smoke 手测失败路径 |
| 🟢 低 | inflightOperation 字段名与 main.js `acquiringBillCurrencyOperationLock.operation` 重名 | 二者作用域不同（main 全局 lock / renderer state flag）；spec 已注明互补关系 |

### 8.6 R5 — F1 默认 AND（仅新建）+ dialog 纵向布局 + 资金红线护栏

#### 8.6.1 现状定位

| 文件:行号 | 现状 | 改动方向 |
|---|---|---|
| `src/renderer-dialogs.js:5707` | `conditionsLogic: 'OR'` 新建默认 OR | 改 `'AND'` |
| `src/main-process/scenario-engines/c1-extract-recon-id.js`（spec §2.2 已实现）| `config.conditionsLogic === 'AND' ? 'AND' : 'OR'` fallback OR | **不动**（资金红线护栏）|
| `src/renderer-dialogs.js:6294-6306` | radio 在"条件" row 内 wrap；横向；OR 在前 AND 在后 | 改：移到独立 row + 纵向 + AND 在上 OR 在下 |
| `src/renderer-dialogs.js:6314` | `<label>筛选字段：` 直接文本（无特殊 class） | 参考样式：标准 label |

#### 8.6.2 改动 diff（默认 config）

```js
// src/renderer-dialogs.js:5707 现状
conditionsLogic: 'OR',

// 改后
// v2.1.7 round 2 R5：新建默认 AND（用户日常 90% 用 AND）；老 scenario 无 logic 字段 → pickConditionsLogicChecked + 引擎 fallback OR（资金红线护栏，spec §8.6.5）
conditionsLogic: 'AND',
```

#### 8.6.3 改动 diff（dialog HTML 重写）

```html
<!-- 现状（横向 inline 在"条件" row 内） -->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    <button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>
    <div class="scenario-config-logic-row">
      <span class="scenario-config-logic-label">条件聚合：</span>
      <label class="scenario-config-logic-option"><input type="radio" name="conditionsLogic" value="OR" ...> OR（满足任一）</label>
      <label class="scenario-config-logic-option"><input type="radio" name="conditionsLogic" value="AND" ...> AND（同时满足）</label>
    </div>
  </div>
</div>

<!-- 改后：拆成独立 row + 纵向 AND 在上 OR 在下 + label 复用标准 scenario-config-label 样式 -->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
  </div>
</div>
<!-- ⭐ R5 新增独立 row -->
<div class="scenario-config-row">
  <span class="scenario-config-label">条件聚合</span>
  <div>
    <label style="display:block; margin-bottom:4px;">
      <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
      AND（同时满足）
    </label>
    <label style="display:block;">
      <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
      OR（满足任一）
    </label>
  </div>
</div>
```

#### 8.6.4 改动 diff（pickConditionsLogicChecked helper）

```js
// 在 C1 dialog 工厂 fn 顶部新增 helper
// ⚠️ R5 资金红线护栏：老 scenario（编辑路径 + DB 无 conditionsLogic 字段）必须显示 OR
//   防止用户在编辑老 scenario 时未察觉默认 AND，保存后把语义从 OR 翻成 AND（资金事故）
function pickConditionsLogicChecked(draft) {
  // 新建：使用 createDefaultScenarioConfig 注入的默认值（AND）
  if (draft.mode === 'create') return draft.config.conditionsLogic || 'AND';
  // 编辑：老 scenario undefined → OR；新 scenario 用本值
  return draft.config.conditionsLogic || 'OR';
}

// dialog 工厂 fn 顶部调用
const checkedLogic = pickConditionsLogicChecked(draft);
// HTML 用 checkedLogic === 'AND' / 'OR' 决定 radio checked
```

#### 8.6.5 资金红线护栏（三层）⚠️

**核心不变量**：

| 入口 | conditionsLogic 默认 |
|---|---|
| createDefaultScenarioConfig（仅 mode=create 走此） | `'AND'`（默认 + dialog UI checked） |
| pickConditionsLogicChecked(mode=edit, draft.config.conditionsLogic === undefined) | `'OR'`（dialog UI checked OR，符合老 scenario 引擎行为）|
| pickConditionsLogicChecked(mode=edit, draft.config.conditionsLogic === 'AND' \| 'OR') | 本值 |
| runC1Scenario fallback（spec §2.2 已实现） | undefined → OR（不依赖 dialog） |

**护栏目的**：用户编辑老 scenario（v2.1.6 / v2.1.7-round1 创建，DB 无 conditionsLogic 字段）→ dialog 显示 OR 选中 + 用户不动 → 保存后 conditionsLogic 写盘为 `'OR'`（与原引擎行为一致）。**绝不允许"老 scenario 加载时 UI 显示 AND"**，否则用户点保存（未察觉默认值变化）就把语义从 OR 翻成 AND，**资金事故**。

#### 8.6.6 confirm 预览 + 列表预览

R5 不改 confirm 预览与列表预览（spec §2.3 已实现 `c.conditionsLogic === 'AND' ? 'AND' : 'OR'` 切换）。新建场景 confirm 显示 `条件（AND）：` 即预期。

#### 8.6.7 smoke 用例

新增 / 增强 `scripts/smoke/scenario-engines-c1.js`：

| Case | 输入 | 期望 |
|---|---|---|
| R5-A | `createDefaultScenarioConfig('extract-recon-id')` 返回值 | `conditionsLogic === 'AND'` |
| R5-B | `pickConditionsLogicChecked({ mode: 'create', config: { conditionsLogic: 'AND' } })` | `'AND'` |
| R5-C | `pickConditionsLogicChecked({ mode: 'edit', config: { /* 老 scenario：无 conditionsLogic */ } })` | `'OR'`（资金红线护栏关键 case）|
| R5-D | `pickConditionsLogicChecked({ mode: 'edit', config: { conditionsLogic: 'AND' } })` | `'AND'`（新 scenario 用本值） |
| R5-E | `runC1Scenario({ scenario: { config: { conditions: [...] /* 无 logic */ } } })` | 引擎 fallback OR（spec §2.2 已实现，本 case 是回归保护）|

#### 8.6.8 dialog 工厂 fn 测试方法

`scripts/smoke/c1-dialog-fixture.js` 或 jsdom 单测：

```js
// mock state.scenarioDraft 模拟新建/编辑入口
state.scenarioDraft = { mode: 'create', config: createDefaultScenarioConfig('extract-recon-id') };
const dialog = createScenarioConfigDialogC1();
const andRadio = dialog.querySelector('input[name="conditionsLogic"][value="AND"]');
const orRadio = dialog.querySelector('input[name="conditionsLogic"][value="OR"]');
assert.ok(andRadio.checked);   // 新建：AND 选中
assert.ok(!orRadio.checked);

// 模拟编辑老 scenario（无 logic 字段）
state.scenarioDraft = { mode: 'edit', config: { conditions: [{...}], extractByFeature: null, extractByOtherField: null /* 缺 conditionsLogic */ } };
const dialog2 = createScenarioConfigDialogC1();
const andRadio2 = dialog2.querySelector('input[name="conditionsLogic"][value="AND"]');
const orRadio2 = dialog2.querySelector('input[name="conditionsLogic"][value="OR"]');
assert.ok(!andRadio2.checked);  // 老 scenario：AND 不选
assert.ok(orRadio2.checked);    // 资金红线护栏：OR 选中
```

#### 8.6.9 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | 默认 AND 改变用户新建场景体感 | dialog UI radio 明示两选项；用户可一键切；R5 已拍板 |
| 🔴 资金红线 | 老 scenario 静默从 OR 变 AND | §8.6.5 三层护栏：默认 config（仅 create）+ pickConditionsLogicChecked（按 mode 分支）+ 引擎 fallback OR（spec §2.2 不动）|
| 🟢 低 | radio 移到独立行 → preview 截图变化 | F1 preview 需重跑（PRD §14.3 矩阵已含） |

⚠️ **重要变量检查**：R5 改 `createDefaultScenarioConfig` 默认值 + dialog 渲染逻辑；引擎 fallback 不动。建议本迭代结束 `/check-vars` **评估升格 `conditionsLogic` 字段进 Critical 层**（业务契约锚点，影响 C1 行 → 1/N 命中率剧烈变化）。

### 8.7 R6a — F3 multi 模式文件名根因细化（grid 3 列适配）⏸ 等用户拍板方案

#### 8.7.1 用户已发截图 + PM 二次诊断

详 PRD §13.7.1-13.7.3。两层根因：
1. `.ba-file-name { flex:1 1 auto }` 对 grid 子项无效（用户分析）
2. `.ba-file-row { grid-template-columns: 28px 1fr }` 硬编码 2 列 vs multi 各分支 append 3 子项

#### 8.7.2 现状定位（PM 已 grep 验证）

| 文件:行号 | 现状 | 用途 |
|---|---|---|
| `src/styles-gemini-extra.css:391-401` | `.ba-file-row { display:grid; grid-template-columns: 28px 1fr; align-items:center; gap:10px; padding:10px 12px; ... }` | grid 2 列硬编码 |
| `src/styles-gemini-extra.css:411-419` | `.ba-file-name { min-width:0; flex:1 1 auto; font-family:...; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }` | round 1 b1ba84b 加 flex 对 grid 无效 |
| `src/styles-gemini-extra.css:190` | `.big-account-selection-card { width: min(100%, 1080px); min-height: 540px; }` | 弹窗宽度（方案 C 加宽到 1200）|
| `src/renderer-dialogs.js:1002-1053` | multi 3 个分支各 append 3 子项 | grid 不匹配源 |
| `src/renderer-dialogs.js:1054-1057` | 非 multi 分支 innerHTML 2 子项 | ✓ 与 grid 2 列匹配（兼容性关注点）|
| `src/renderer-dialogs.js:946-952 truncateFileName` | `maxLen=20`；fileName ≤ 20 直接返回原值 | 方案 B 改 maxLen 14 防御性 |

#### 8.7.3 ⭐ 推荐方案 C（grid 治本）— 精确 CSS sketch

```css
/* styles-gemini-extra.css L391-401 现状 */
.ba-file-row {
  display: grid;
  grid-template-columns: 28px 1fr;     /* ⚠️ 硬编码 2 列 */
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: transparent;
  cursor: default;
  font-size: 13px;
}

/* 改后（方案 C，3 列适配 multi 各分支）*/
.ba-file-row {
  display: grid;
  grid-template-columns: auto auto 1fr;  /* ⭐ marker/checkbox + letter/idx + meta */
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: transparent;
  cursor: default;
  font-size: 13px;
}
```

**普通模式（非 multi）2 子项兼容性**：
- 普通模式 `innerHTML = <span class="big-account-file-index ba-file-idx">...</span><span class="big-account-file-meta ba-file-name">...</span>` 2 子项
- grid 3 列 `auto auto 1fr` 时：
  - 第 1 子项（idx）→ col-1 占 auto
  - 第 2 子项（meta）→ col-2 占 auto，col-3 空白
  - 视觉：meta 文件名靠左对齐 + 右侧 1fr 空白
- ⚠️ **vs 原 grid 2 列 `28px 1fr` 视觉差异**：原 meta 占满右侧 → 改后 meta 收缩到 content size + 空白在右
- **缓解**：可考虑给非 multi 模式加 `.ba-file-row:not(.ba-multi-editing):not(.ba-multi-grouped) .ba-file-name { grid-column: 2 / -1 }`（让 meta 跨 col-2 到末尾）—— **spec 推荐**：先按简单 3 列实施，preview 截图回归验证；如发现普通模式视觉破版再加 `:not()` 限定

```css
/* styles-gemini-extra.css L411-419 现状 */
.ba-file-name {
  /* v2.1.7 F3：与 .big-account-file-meta 同步 — flex 子项缺 min-width:0 → ellipsis 触发不了导致 "PP..." */
  min-width: 0;
  flex: 1 1 auto;
  font-family: "Roboto Mono", ui-monospace, monospace;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* 改后（方案 C，删 flex，加 grid-column 兜底）*/
.ba-file-name {
  /* v2.1.7 R6a：grid 子项不接受 flex，靠 min-width:0 + ellipsis 即可 */
  min-width: 0;
  /* 删除 flex: 1 1 auto（grid 子项无效，round 1 b1ba84b 误加）*/
  font-family: "Roboto Mono", ui-monospace, monospace;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* styles-gemini-extra.css L190 弹窗加宽 */
.big-account-selection-card { width: min(100%, 1200px); min-height: 540px; }  /* 1080 → 1200 */
```

#### 8.7.4 备选方案 B（JS 阈值防御性下调）— 可与方案 C 组合

```js
/* renderer-dialogs.js:946-952 truncateFileName 不动；仅改调用方阈值 */

/* 现状 :999（multi 模式渲染 displayName）*/
const displayName = truncateFileName(fullName, 20) + rowSuffix;

/* 方案 C+B 改后（仅 multi 3 分支调用降阈值；非 multi + extract-order 保持 20）*/
/* 注：rowSuffix（如 " 第9行"）不算入 truncateFileName 长度 */
const displayName = truncateFileName(fullName, multiMode ? 14 : 20) + rowSuffix;
```

**spec 推荐**：先按方案 C 单独实施（不动 JS）；preview 截图验证后如发现极长文件名（> 60 字符）仍超 meta 列宽，再追加方案 B（JS 阈值 14）。

#### 8.7.5 不动的部分

- `truncateFileName` 函数实现（最多改一次调用方 maxLen 常量）
- 普通模式（非 multi）分支渲染（L1054-1057）
- `.ba-file-row` 子项 append 顺序
- `.big-account-split-body` / `.ba-scroll-container` / `.big-account-file-list/.big-account-order-list` 高度链 CSS（spec §8.8 R6b 已验证已通）
- `.ba-order-row` 右侧大账号列（已是 `grid-template-columns: auto auto 1fr` 3 列，结构 OK 不动）

#### 8.7.6 smoke 用例

R6a 是纯 CSS bug，**不写 smoke**（用 preview 截图 + 手测验证，见 §8.7.7）。

#### 8.7.7 preview 回归矩阵（必跑）

| preview 截图 | 验证点 |
|---|---|
| 大账号 dialog multi 关 + 普通态 | 文件名完整显示（regression baseline）+ 非 multi 兼容性（grid 3 列 vs 2 子项视觉不破）|
| 大账号 dialog multi 启 + 编辑态 | `[checkbox + letter + 文件名]` 3 子项 grid 3 列对齐；文件名完整显示 |
| 大账号 dialog multi 启 + grouped 闭合态 | `[✓ + a. + 文件名 → MERCHANT USD]` 3 子项 grid 3 列对齐；文件名 + 后缀完整显示 |
| 大账号 dialog multi 启 + uncovered 态 | `[空 letter + idx + 文件名]` 3 子项 grid 3 列对齐 |

如截图发现非 multi 模式视觉破版（meta 不靠左 + 右侧空白突兀），spec §8.7.3 已给出 `.ba-file-row:not(.ba-multi-editing):not(.ba-multi-grouped) .ba-file-name { grid-column: 2 / -1 }` 兜底；可在 dev 阶段视情况追加。

#### 8.7.8 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | grid 3 列改动影响非 multi 模式视觉 | preview 4 张图必跑；如视觉破版加 `:not()` 限定 |
| 🟢 低 | 弹窗加宽 1080→1200 在小屏（< 1280px）触发 width: min(100%,...) 100% 路径 | 弹窗本身 `width: min(100%, ...)` 自适应；min-height 不变 |
| 🟢 低 | `.ba-file-name` 删 `flex: 1 1 auto` 在某些 fallback 场景（如非 grid 父容器）影响 | grep 验证：`.ba-file-name` 仅在 `.ba-file-row` 内使用，全 grid 子项；删 flex 安全 |

#### 8.7.9 ⏸ 等用户拍板方案

PM 推荐方案 C（minimum viable）；用户可选：
- **方案 A**：文件名换行（`white-space: normal; word-break: break-all`）→ 行高变化，触发新的滚动需求
- **方案 B**：仅 JS truncateFileName 阈值 20→14
- **方案 C**：仅 CSS grid 3 列治本（**PM 推荐 MVP**）
- **方案 C+B**：grid 3 列 + JS 阈值 14（**PM 推荐 robust**）

**spec 默认按方案 C 实施**（如 preview 验证后 OK，方案 B 不启用）；用户拍板任一方案后 dev 直接照 spec §8.7.3-8.7.4 实施。

### 8.8 R6b — 大账号 multi-mode dialog 列表滚动条丢失（合并到 R6a 回归验证）

#### 8.8.1 PM 二次诊断（高度链已通）

PM grep 现状确认高度链完整：

```
.modal-card { display:flex; flex-direction:column; overflow:hidden; max-height: calc(100vh - 56px) }  ✓
└── .big-account-selection-card { width:min(100%,1080px); min-height:540px }  ✓
    └── .big-account-selection-split { min-height:600px }  ✓
        └── .dialog-header { ... }
        └── .big-account-split-body { flex:1; overflow:hidden }  ✓
            └── .ba-scroll-container { display:grid; grid-template-columns:1fr 1fr; height:100%; min-height:360px; max-height:52vh }  ✓
                ├── .big-account-split-left
                │   ├── .big-account-split-header
                │   └── .big-account-file-list { flex:1; overflow-y:auto }  ✓ 滚动条出口
                └── .big-account-split-right
                    ├── .big-account-split-header
                    └── .big-account-order-list { flex:1; overflow-y:auto }  ✓ 滚动条出口
        └── .dialog-actions { ... }
```

`ba-scroll-container` 类已在 `renderer-dialogs.js:879` dialog innerHTML 加 ✓。

#### 8.8.2 真实根因（合并到 R6a）

用户截图 2"滚动条丢失"真实原因 = R6a multi 各分支 3 子项 vs grid 2 列硬编码导致单行**水平 overflow 或被压缩**，列表内容总高度未达到 `max-height: 52vh` → 不需要滚动条（这是 CSS 正常行为）。

R6a CSS fix（方案 C grid 3 列）后：
- 单行高度恢复正常宽度分配
- 内容总高 < 52vh → 无滚动条（预期）
- 内容总高 > 52vh → 自动出现垂直滚动条（已有 `overflow-y: auto`）

#### 8.8.3 不独立修改

R6b **不需要独立 CSS 改动**。spec §8.8 仅作"R6a 修复后的回归验证":
- 手测 1：导入 5 个文件 + multi 模式 → 内容总高 < 52vh → **无滚动条**（OK）
- 手测 2：导入 ≥ 20 个文件 + multi 模式 → 内容总高 > 52vh → **自动出现垂直滚动条**
- 手测 3：弹窗不超屏（modal-card max-height: calc(100vh - 56px) 兜底生效）

#### 8.8.4 边界提示

`.big-account-selection-split { min-height: 600px }` 在极小屏（< 720px 高）可能与 modal-card max-height 冲突；spec 提示 dev 在小屏测试。如发现问题可微调为 `min-height: min(600px, 80vh)`，但本轮不强制。

#### 8.8.5 不动的部分

- 所有现有 CSS（高度链 4 层已通）
- `ba-scroll-container` 类应用逻辑

#### 8.8.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | R6a 修复后用户仍报告"滚动条不出现" | 手测 ≥ 20 文件场景；如仍异常 spec 阶段深挖（可能涉及 `.ba-scroll-container` ID 优先级或 styles.css 冲突）|

### 8.9 R6c — "确认大账号顺序" dialog 列表超屏不能滚

#### 8.9.1 现状定位（PM 已 grep 验证）

| 文件:行号 | 现状 | 评估 |
|---|---|---|
| `src/renderer-dialogs.js:1680-1700` | `.extract-order-card` modal-card 含 `.extract-order-body` + 2 个 `.extract-order-list` 子列表 + `.dialog-actions` | 结构 OK |
| `src/styles-gemini-extra.css:1285` | `.extract-order-card { width: min(100%, 760px) }` | 有宽度无 max-height（依赖 modal-card 兜底）|
| `src/styles-gemini-extra.css:1286-1289` | `.extract-order-body { padding:18px 28px 8px; display:grid; grid-template-columns: 1fr 1.15fr; gap:28px }` | grid 列宽 OK |
| `src/styles-gemini-extra.css:1294-1296` | `.extract-order-list { display:flex; flex-direction:column }` | ⚠️ **缺 max-height + 缺 overflow-y** |
| `src/styles-gemini-extra.css:1297-1315` | `.extract-order-row { display:grid; grid-template-columns: 24px 1fr auto; ... }` + `.eo-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis }` | 行结构 ✓（3 子项 vs 3 列对齐，文件名 ellipsis 正常）|
| `.modal-card` 兜底 | `overflow:hidden + max-height: calc(100vh - 56px)` | modal 切超屏 → 用户看不到底部，**且 .extract-order-list 不能滚** → 死区 |

#### 8.9.2 修复方案（精确 CSS sketch）

```css
/* styles-gemini-extra.css L1294-1296 现状 */
.extract-order-list {
  display: flex;
  flex-direction: column;
}

/* 改后 — 2 行 CSS */
.extract-order-list {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 280px);  /* ⭐ R6c：留 280px 给 modal header (~56px) + body padding (~26px) + dialog-actions (~64px) + col-header (~32px) + 余量 */
  overflow-y: auto;                  /* ⭐ R6c：自动出现垂直滚动条 */
}
```

#### 8.9.3 calc 余量推导

```
modal-card max-height = calc(100vh - 56px)         → ≈ 100vh - 56px ≈ 95vh 内容区
modal-card 内子项：
  ├── dialog-header              ≈ 56px (padding 22px+16px + 内容 ~18px)
  ├── extract-order-body         ≈ 18px+8px = 26px padding（list 在内）
  │   └── 2 × extract-order-list   ← 目标
  │       └── 各列内的 col-header  ≈ 32px (margin-bottom 8px + content ~24px)
  └── dialog-actions             ≈ 64px (margin/padding)

list 可用高度 = 95vh - 56 - 26 - 32 - 64 = 95vh - 178px ≈ 100vh - 234px
留余量 50px → max-height: calc(100vh - 280px)
```

实际开发可能微调（如 padding 测准后调到 `calc(100vh - 260px)`），spec 阶段先按 280px 安全值。

#### 8.9.4 不动的部分

- `.extract-order-card` 宽度（min(100%, 760px) 不变）
- `.extract-order-body` grid 列宽
- `.extract-order-row` 内部结构（grid 3 子项 vs 3 列 ✓ 对齐，eo-name ellipsis 正常）
- `truncateFileName` 调用（`renderer-dialogs.js:1715` `truncateFileName(fileName, 20)` 不动）
- modal-card 兜底（保留）

#### 8.9.5 smoke 用例

R6c 是纯 CSS bug，**不写 smoke**（手测覆盖）。

#### 8.9.6 preview 回归

`.extract-order-card` 当前可能没单独 preview 入口（PM 实际未在 v2.1.6 preview 列表中看到）；**spec 不强制新增 preview**；可在 dev 阶段视需求评估。

#### 8.9.7 验收

- 手测 1：导入 ≥ 30 个文件 + 点"提取大账号顺序" → 弹窗内列表自动出现垂直滚动条，能滚到底部
- 手测 2：导入 5 个文件 → 弹窗内列表无滚动条（内容少，预期）
- 手测 3：弹窗不超屏（modal-card 兜底）
- 手测 4：在弹窗内点"编辑"按钮展开 input，行高变化 → overflow-y:auto 自动适应

#### 8.9.8 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | `calc(100vh - 280px)` 在极小屏（< 400px 高，几乎不可能）算出负值 | CSS auto fallback；max-height 负值 = auto；不会破坏布局 |
| 🟢 低 | 编辑大账号时行高变化 | overflow-y:auto 自动适应；无副作用 |
| 🟢 低 | 用户在 1080p 全屏下 list 高度还是不够 | 280px 余量保守；如发现问题可缩到 220px |

---

## 九、round 3 — 用户手测反馈修复（B1-B5 + F4 删空 + F8）

### 9.1 子任务划分（与 PRD §十四 / §十五对齐）

| 子任务 | 性质 | 改动文件 | 风险 |
|---|---|---|---|
| B1 F1 radio 移回"条件"row | DOM 重组 | renderer-dialogs.js | 🟢 低 |
| B2 multi 完成态字母列 | CSS 副作用修（PM 推荐方案 A 1 行 CSS）| styles-gemini-extra.css | 🟢 低 |
| B3 extract-order-card 单 grid + 单滚动条 | DOM + CSS 重组 | renderer-dialogs.js + styles-gemini-extra.css | 🟡 中 |
| B4 ≥20 文件滚动调试 | CSS 调试 + 新 fixture | renderer-previews.js + styles-gemini-extra.css | 🟡 中 |
| **B5 R3 wiring 漏接审计** | renderer 全局 + smoke 加固 | renderer.js + smoke | 🟡 中 |
| F4 删空 | dialog handler 修 | renderer-dialogs.js | 🟢 低 |
| **F8 dispatcher 反向 filter + writer 第 2 sheet** 🚨 资金红线 | dispatcher + writer + main.js | scenario-dispatcher.js + writers.js + main.js | 🔴 资金红线 |

### 9.2 B1 — F1 radio 移回"条件"row 内部

#### 9.2.1 现状（PM grep 确认）

`renderer-dialogs.js:6325-6346`：当前 R5 落地为独立 `.scenario-config-row` + label "条件聚合" + `.scenario-config-logic-stack`

#### 9.2.2 改动 diff

```html
<!-- L6325-6346 现状 -->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
  </div>
</div>
<div class="scenario-config-row">  <!-- ⚠️ R5 独立 row 删除 -->
  <span class="scenario-config-label">条件聚合</span>
  <div class="scenario-config-logic-stack">
    ...
  </div>
</div>

<!-- 改后：radio 移到 .scenario-config-multi-wrap 末尾（紧贴 "+ 新增条件" 按钮）-->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
    <!-- B1 round 3：radio 移回"条件"row 内部；保留 R5 资金红线护栏 pickConditionsLogicChecked / 引擎 fallback OR -->
    <div class="scenario-config-logic-inline" style="margin-top:8px;">
      <label style="display:block; margin-bottom:4px;">
        <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        AND（同时满足）
      </label>
      <label style="display:block;">
        <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        OR（满足任一）
      </label>
    </div>
  </div>
</div>
```

#### 9.2.3 资金红线护栏（R5 三层不动）

- 默认 config 仅 create 用 'AND'（renderer-dialogs.js:5707）
- pickConditionsLogicChecked(draft) 按 mode 分支老 scenario fallback OR
- 引擎 c1-extract-recon-id.js fallback OR

B1 仅 DOM 重组，所有 JS 逻辑不动。

#### 9.2.4 smoke

无（DOM 重组，靠 preview screenshot regression + 手测）。

### 9.3 B2 — multi 完成态字母列丢失（方案 A：min-width 兜底）

#### 9.3.1 现状（PM grep）

| 文件:行号 | 现状 | 评估 |
|---|---|---|
| `src/styles-gemini-extra.css:1887` | `.big-account-order-index--alpha { color: var(--muted); }` 仅 color | letter 列无 min-width，靠 content size |
| `src/styles-gemini-extra.css:391-401 .ba-file-row` | R6a 改 `auto auto 1fr` | 第 2 列 letter auto = "a." ≈ 12px，可能被 marker(auto) 挤 |
| `src/renderer-dialogs.js:1027-1042 ba-multi-grouped` | append 3 子项 `[markerSpan + letterSpan + meta]` | 3 子项 vs grid 3 列对齐 |

#### 9.3.2 改动 diff（PM 推荐方案 A）

```css
/* styles-gemini-extra.css L1887 现状 */
.big-account-order-index--alpha { color: var(--muted); }

/* 改后（方案 A）*/
.big-account-order-index--alpha {
  color: var(--muted);
  min-width: 24px;       /* B2 round 3：letter 列宽兜底，防 R6a grid auto 收缩 */
  text-align: center;    /* 字母居中（与其它 letter 列视觉一致）*/
}
```

#### 9.3.3 备选方案 B/C（dev 实测后定）

- 方案 B：grid 扩 4 列 `auto 24px auto 1fr`（PM 不推荐，破坏 R6a 治本结构）
- 方案 C：letter 加 padding（与方案 A 类似但语义不同）

#### 9.3.4 smoke

无（纯 CSS，手测 + R6a 4 张 preview 截图覆盖）。

### 9.4 B3 — extract-order-card 单 grid + 单滚动条（用户拍板方案 A）

#### 9.4.1 用户拍板（详 PRD §14.4.1）

单一 grid 表格 + 每行横跨左右 + 外层单 overflow + 移除 `.extract-order-list` 内层 overflow。

#### 9.4.2 改动 diff（详 PRD §14.4.3）

**JS 渲染逻辑** `renderer-dialogs.js:1683-1701` + L1707-1779 全部重构：

```js
// 现状（精简版）
extractDialog.innerHTML = `
  <div class="extract-order-body">
    <div><div class="extract-order-col-header">文件顺序：</div><div class="extract-order-list extract-file-list"></div></div>
    <div><div class="extract-order-col-header">大账号信息：</div><div class="extract-order-list extract-account-list"></div></div>
  </div>
  ...
`;
const extractFileList = extractDialog.querySelector('.extract-file-list');
const extractOrderList = extractDialog.querySelector('.extract-account-list');
extractableRows.forEach((row, index) => { ... extractFileList.appendChild(item); });
extractedAccounts.forEach((account, index) => { ... extractOrderList.appendChild(item); });

// 改后（方案 A）
extractDialog.innerHTML = `
  <div class="extract-order-body">
    <div class="extract-order-col-header">文件顺序</div>
    <div class="extract-order-col-header">大账号信息</div>
    <!-- 每行 = 一对 [left cell, right cell]，dev 阶段循环 append -->
  </div>
  ...
`;
const extractBody = extractDialog.querySelector('.extract-order-body');
const maxRows = Math.max(extractableRows.length, extractedAccounts.length);
for (let i = 0; i < maxRows; i++) {
  const fileRow = extractableRows[i];
  const accountRow = extractedAccounts[i];

  // 左 cell：文件顺序
  const leftCell = document.createElement('div');
  leftCell.className = 'extract-order-row';
  if (fileRow) {
    const fullName = fileRow.fileName || '';
    const rowSuffix = fileRow.sourceRowNumber ? ` 第${fileRow.sourceRowNumber}行` : '';
    const displayName = truncateFileName(fullName, 20) + rowSuffix;
    leftCell.innerHTML = `<span class="eo-idx">${i + 1}.</span><span class="eo-name" title="${escapeHtml(fullName + rowSuffix)}">${escapeHtml(displayName)}</span><span></span>`;
  }
  extractBody.appendChild(leftCell);

  // 右 cell：大账号信息（含编辑按钮）
  const rightCell = document.createElement('div');
  rightCell.className = 'extract-order-row';
  if (accountRow) {
    rightCell.dataset.index = i;
    rightCell.dataset.merchantId = accountRow.merchantId;
    rightCell.dataset.currency = accountRow.currency;
    const indexSpan = document.createElement('span');
    indexSpan.className = 'eo-idx';
    indexSpan.textContent = `${i + 1}.`;
    const textSpan = document.createElement('span');
    textSpan.className = 'eo-name';
    textSpan.textContent = `${accountRow.merchantId} ${accountRow.currency}`;
    const editBtn = document.createElement('button');
    editBtn.className = 'text-action eo-edit';
    editBtn.type = 'button';
    editBtn.textContent = '编辑';
    const editContainer = document.createElement('div');
    editContainer.className = 'extract-edit-container';
    editContainer.hidden = true;
    editContainer.innerHTML = `
      <input class="mapping-text-input extract-edit-input extract-edit-merchant" type="text" placeholder="账户号" value="${escapeHtml(accountRow.merchantId)}" />
      <input class="mapping-text-input extract-edit-input extract-edit-currency" type="text" placeholder="币种" value="${escapeHtml(accountRow.currency)}" />
      <button class="secondary-btn small extract-edit-done" type="button">完成</button>
    `;
    // editBtn click + .extract-edit-done click handler 沿用原逻辑（renderer-dialogs.js:1754-1779）
    editBtn.addEventListener('click', () => { textSpan.hidden = true; editBtn.hidden = true; editContainer.hidden = false; });
    editContainer.querySelector('.extract-edit-done').addEventListener('click', () => { ... 原逻辑 ... });
    rightCell.append(indexSpan, textSpan, editBtn, editContainer);
  }
  extractBody.appendChild(rightCell);
}
```

**CSS 改造** `styles-gemini-extra.css:1286-1296`：

```css
/* 现状 */
.extract-order-body {
  padding: 18px 28px 8px;
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 28px;
}
.extract-order-list {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 280px);   /* R6c 已加 */
  overflow-y: auto;                   /* R6c 已加 */
}

/* 改后（方案 A 单 grid + 外层单 overflow）*/
.extract-order-body {
  padding: 18px 28px 8px;
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 0 28px;                       /* row gap 0（行边界由 border-bottom 提供）；col gap 28 */
  max-height: calc(100vh - 220px);   /* ⭐ 外层单 overflow */
  overflow-y: auto;
}
/* ⭐ 删除 .extract-order-list 整段（不再使用） */

/* col-header sticky 在顶部，跨 grid 第 1 / 2 列 */
.extract-order-col-header {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fff;
  font-size: 12px;
  color: var(--muted);
  font-weight: 500;
  padding: 0 0 8px;
}

/* extract-order-row 现在每个占 grid 1 列 */
.extract-order-row {
  display: grid;
  grid-template-columns: 24px 1fr auto;  /* idx | name | edit（右侧 cell 才有 edit）*/
  align-items: center;
  gap: 12px;
  padding: 10px 6px;
  border-bottom: 1px solid var(--line-soft);
}
.extract-order-row:last-child { border-bottom: none; }
.extract-order-row .eo-idx { color: var(--muted); text-align: right; font-family: "Roboto Mono", ui-monospace, monospace; }
.extract-order-row .eo-name { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.extract-order-row .eo-edit { font-size: 13px; }
```

#### 9.4.3 关键不变量

- grid auto row 自动对齐：左右 cell 按本 row 最大 height 取齐（用户期望"上下边界横线对齐"）
- 单 overflow：`.extract-order-body` 外层滚动，左右一起滚（用户期望"共用一个滚动条"）
- 编辑按钮逻辑保留不动，仅父容器从 `.extract-account-list` 改为右 cell

#### 9.4.4 smoke

无（DOM 重组，靠 preview screenshot regression + 手测）。

#### 9.4.5 preview 必跑

extract-order-card 视觉验证（详 PRD §16.3 矩阵）。

### 9.5 B4 — ≥20 文件场景滚动条不可用 ⏸ 待 dev 实测

#### 9.5.1 现状（PM grep）

- `.ba-scroll-container { height: 100%; min-height: 360px; max-height: 52vh }` 高度链已通
- preview fixture `applyBigAccountSelectionMultiPreviewState` 仅 5 文件
- 用户实测 ≥20 文件场景"滚动条不可用"

#### 9.5.2 spec 阶段步骤

1. **新增 preview fixture** `applyBigAccountSelectionMultiLargePreviewState`（`renderer-previews.js` 追加，rows[0..19]）：

```js
function applyBigAccountSelectionMultiLargePreviewState() {
  setCurrentModule(MODULES.statementGenerator.id);
  state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR', 'JPY', 'SGD'];
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ index: i, fileIndex: i, fileName: `HSBC-SG-2026-03-batch${i}.xlsx`, sourceRowNumber: 1 });
  }
  openModal(createBigAccountSelectionDialog({
    rows,
    rowsWithEmptyBlocks: rows,
    expandedBigAccountOptions: [
      { merchantId: '6222000000000001', currency: 'USD' },
      { merchantId: '6222000000000001', currency: 'HKD' },
      ...
    ],
    templateId: 'preview-template-4',
    templateName: 'HSBC-SG',
    canRemember: true,
    onDone: () => {},
    onCancel: closeModal
  }));
}
```

注册到 `renderer.js:5266` preview 路由。

2. **dev 阶段打开此 preview**：观察"不可用"具体表现：
   - 不出现滚动条？→ 高度链断
   - 出现但鼠标无法拖动？→ pointer-events / z-index 异常
   - 出现但滚轮无响应？→ event handler 被覆盖
   - 滚到一半卡住？→ overflow 父容器二次截断

3. **DevTools 检查**：computed style + height / max-height / overflow 实际值

4. **修复方向**：根据实测调试，可能：
   - `.big-account-selection-split { min-height: 600px }` 改 `min(600px, 80vh)`
   - `.ba-scroll-container { max-height: 52vh }` 改 `min(52vh, calc(100vh - 280px))`
   - 检查是否有 inactive styles.css 规则被 cascade 进来覆盖

#### 9.5.3 smoke

无（手测 + 新 fixture）。

### 9.6 B5 🚨 — R3 wiring 漏接审计

#### 9.6.1 PM 全局 grep 审计结果

| 函数 | 文件:行号 | 现状 | 漏接 |
|---|---|---|---|
| `setStatus` | renderer.js:545 | ✓ updateStatusBox | 接 |
| `setNewAccountStatus` | renderer.js:558 | ✓ updateStatusBox | 接 |
| `setBankBuReconStatus` | renderer.js:3911 | ✓ updateStatusBox | 接 |
| `setBizOpReconStatus` | renderer.js:4136 | ✓ updateStatusBox | 接 |
| **`updateBankStatementUi`** | **renderer.js:3330** | ❌ `textEl.textContent = text;` | **🚨 漏接** |
| **`updateReconIdFixUi`** | **renderer.js:3684** | ❌ `textEl.textContent = text;` | **🚨 漏接** |
| **`setAcquiringBillCurrencyStatus`** | **renderer.js:4248** | ❌ `text.textContent = message;` | **🚨 漏接（用户发现）** |
| `pendingStatusBox` | renderer.js:259 | 仅 element 引用，无 set 函数（PM grep `pending.*status.*update` / `renderPendingStatus` / `applyPendingStatus` 均无）| ✓ 无需修 |

#### 9.6.2 改动 diff — 3 处全部改走 updateStatusBox

```js
/* updateBankStatementUi @ renderer.js:3298-3331 现状 */
function updateBankStatementUi() {
  if (!elements.bankStatementStatusBox) return;
  const bs = state.bankStatementSession;
  ...
  let text;
  let tone = 'info';
  if (!bs) { text = '欢迎使用小助手'; tone = 'neutral'; }
  ...
  const textEl = elements.bankStatementStatusBox.querySelector('.status-box-text');
  if (textEl) textEl.textContent = text;          // ❌ B5 漏接
  elements.bankStatementStatusBox.dataset.tone = tone;
  // 按钮 disabled（L3334-3337 保留）
  if (elements.bankStatementImportBtn) ...
}

/* 改后 — 走 updateStatusBox（自动 R3 换行 + null 兜底）*/
function updateBankStatementUi() {
  if (!elements.bankStatementStatusBox) return;
  const bs = state.bankStatementSession;
  ...
  let text;
  let tone = 'info';
  if (!bs) { text = '欢迎使用小助手'; tone = 'neutral'; }
  ...
  // B5 round 3：走 updateStatusBox 入口（R3 wiring）
  updateStatusBox(elements.bankStatementStatusBox, text, tone);
  // 按钮 disabled（保留）
  if (elements.bankStatementImportBtn) ...
}

/* updateReconIdFixUi @ renderer.js:3647-3686 同样改造 */
/* setAcquiringBillCurrencyStatus @ renderer.js:4245-4252 同样改造（最简单，3 行 → 1 行）*/
```

`setAcquiringBillCurrencyStatus` 改造样例：

```js
/* 现状 */
function setAcquiringBillCurrencyStatus(message, tone = 'info') {
  const box = elements.acquiringBillCurrencyStatusBox;
  if (!box) return;
  const text = box.querySelector('.status-box-text');
  if (text) text.textContent = message;          // ❌ B5 漏接
  box.classList.remove('is-info', 'is-success', 'is-error', 'is-warn');
  if (tone) box.classList.add('is-' + tone);
}

/* 改后 — 走 updateStatusBox（注：updateStatusBox 用 dataset.tone，可能与 is-* class 风格不一致；dev 阶段实测如视觉破版需 spec 二次调整）*/
function setAcquiringBillCurrencyStatus(message, tone = 'info') {
  const box = elements.acquiringBillCurrencyStatusBox;
  if (!box) return;
  // B5 round 3：走 updateStatusBox 入口（R3 wiring）
  updateStatusBox(box, message, tone);
}
```

#### 9.6.3 ⚠️ dataset.tone vs is-* class 风格差异

PM 注意：`updateStatusBox`（L529）用 `box.dataset.tone = tone;`；但 `setAcquiringBillCurrencyStatus` 当前用 `box.classList.add('is-' + tone)`。改造后视觉可能不一致（CSS 选择器不同）。

**spec 决策**：dev 阶段先按上述改造跑 preview / 手测 5 模块状态框；如视觉破版（如 acquiringBillCurrency 模块状态框颜色丢失），按下方两选项之一处理：
- 选项 1：CSS 加 `[data-tone="success"] { ... }` 兼容（与 setStatus 等已存在风格一致）
- 选项 2：updateStatusBox 内部加 `box.classList.toggle('is-' + tone, true)` 双写（更稳但污染 updateStatusBox 通用逻辑）

#### 9.6.4 加固 smoke — wiring 审计断言

```js
// scripts/smoke/render-status-box.js（R3 已创建）追加
// 全局 grep 整个 src/renderer.js，所有 .querySelector('.status-box-text').textContent =
// 应只出现在 updateStatusBox 函数内
const fs = require('node:fs');
const rendererSource = fs.readFileSync('src/renderer.js', 'utf8');

// 匹配 .status-box-text 紧跟 .textContent = （允许中间空白）
// 例：textEl.textContent = ... / text.textContent = ...
const matches = rendererSource.match(/\.status-box-text['"`\)]?\.|status-box-text.*\)\.textContent\s*=/g) || [];

// 更精确：找 querySelector('.status-box-text') 后续 .textContent = 的直写
const lines = rendererSource.split('\n');
const directWriteLines = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(".querySelector('.status-box-text')")) {
    // 接下来 5 行内若有 .textContent = 则计直写
    for (let j = i; j < Math.min(i + 5, lines.length); j++) {
      if (lines[j].includes('.textContent =')) {
        directWriteLines.push(j + 1);
        break;
      }
    }
  }
}

// updateStatusBox 函数体内允许 1 次（L527-528）；其它直写视为 B5 漏接回归
// 注：updateStatusBox 函数大致位置 L519-538，对其内部直写允许，外部不允许
const allowedInUpdateStatusBox = directWriteLines.filter((ln) => ln >= 519 && ln <= 538);
const leakedOutside = directWriteLines.filter((ln) => ln < 519 || ln > 538);
assert.strictEqual(leakedOutside.length, 0,
  `B5 wiring 审计：发现 ${leakedOutside.length} 处 .status-box-text.textContent = 漏接（行号 ${leakedOutside.join(', ')}），应全部走 updateStatusBox`);
```

#### 9.6.5 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | dataset.tone vs is-* class 风格差异可能破视觉 | dev 阶段 5 模块手测 + 视觉破版按 §9.6.3 选项 1/2 处理 |
| 🟢 低 | smoke 审计可能误报 updateStatusBox 函数内的合法直写 | 行号范围限定（519-538）排除 |
| 🟢 低 | 未来扩展模块漏接 | smoke 持续守护；新加 setXxxStatus 函数必须走 updateStatusBox |

### 9.7 F4 删空 — R1 display + handler 同步 `>= 1`

#### 9.7.1 现状（PM grep 二次发现 R1 改了一半）

| 文件:行号 | 现状 | R1 状态 |
|---|---|---|
| `src/renderer-dialogs.js:6716` | `${isReadonly || config.billTypes.length === 1 ? '' : '<button remove>'}` | ✓ R1 已改 display |
| **`src/renderer-dialogs.js:6794`** | `if (Number.isFinite(idx) && config.billTypes.length > 2) { config.billTypes.splice(idx, 1); ... }` | ❌ **R1 漏改 handler** |
| `src/renderer-dialogs.js:5832` | `if (!Array.isArray(c.billTypes) \|\| c.billTypes.length < 1) errors.push('账单类型至少需要 1 行');` | ✓ 保存校验兜底已就绪 |

#### 9.7.2 改动 diff

```js
/* L6716 display 现状 */
${isReadonly || config.billTypes.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}

/* 改后 — 永远显示删除按钮（删空）*/
${isReadonly ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
```

```js
/* L6794 handler 现状 */
if (Number.isFinite(idx) && config.billTypes.length > 2) {
  config.billTypes.splice(idx, 1);
  // 重排 seq + 校正 reconFields / markValue 引用（L6797-6803）
  ...
  rerender();
}

/* 改后 — 允许删到 0 行 */
if (Number.isFinite(idx) && config.billTypes.length >= 1) {
  config.billTypes.splice(idx, 1);
  // 重排 seq + 校正 reconFields / markValue 引用（L6797-6803 保留不变）
  config.billTypes.forEach((b, i) => { b.seq = i + 1; });
  const validSeqs = config.billTypes.map((b) => b.seq);
  config.reconFields.forEach((r) => {
    if (!validSeqs.includes(Number(r.leftType))) r.leftType = validSeqs[0] || 1;
    if (!validSeqs.includes(Number(r.rightType))) r.rightType = validSeqs[1] || validSeqs[0] || 1;
  });
  if (!validSeqs.includes(Number(config.markValue.type))) config.markValue.type = validSeqs[validSeqs.length - 1] || 1;
  rerender();
}
```

#### 9.7.3 验收

- 手测 billTypes=2 → 删除成功（length=1）
- 手测 billTypes=1 → 删除成功（length=0）
- 手测 billTypes=0 → 保存校验报"账单类型至少需要 1 行"
- 手测 添加（"+ 新增账单类型"）→ length 恢复

#### 9.7.4 smoke

```js
// 简单单测（如果有 dialog 渲染测试 helper）
// 验证 billTypes 0 行时保存校验报错
const draft = { name: 'test', priority: 0, category: 'offset-bill-mark', config: { billTypes: [], reconFields: [], markValue: { type: null, field: '', value: '' } } };
const errors = validateScenarioDraft(draft);
assert.ok(errors.includes('账单类型至少需要 1 行'));
```

### 9.8 F8 — scenario-dispatcher 反向 filter + writer 第 2 sheet 🚨 资金红线

#### 9.8.1 现状（PM grep 已确认 dispatcher rowLockSet 已就绪）

| 文件:行号 | 现状 | F8 用途 |
|---|---|---|
| `src/main-process/scenario-dispatcher.js:122-123` | `const modifiedRows = bankRows.filter((r) => rowLockSet.has(r._rowId));` | ✓ rowLockSet 已就绪；F8 反向 filter |
| `src/main-process/scenario-dispatcher.js:138-151` | return `{ modifiedRows, modifications, errorReport, stats: { totalRows, hitRowCount, ... } }` | F8 加 `unmatchedRows` + `stats.unmatchedRowCount` |
| `src/main.js:5948-5957` | `writeWorkbookRows({ rows: detailExportRows, outputFilePath })` | F8 加可选 `unmatchedRows` 入参 |
| `src/backend/file-service/writers.js:223-260 writeWorkbookRows` | 单 sheet 接口 | F8 改造为可选 `unmatchedRows` 触发追加第 2 sheet |

#### 9.8.2 改动 diff — scenario-dispatcher.js（资金红线核心）

```js
// src/main-process/scenario-dispatcher.js:122-151 现状
const modifiedRows = bankRows
  .filter((r) => rowLockSet.has(r._rowId))
  .map((r) => {
    const meta = rowMeta.get(r._rowId) ?? { ... };
    return { ...r, _hitScenarioId: meta.scenarioId, _hitScenarioName: meta.scenarioName, _modifiedColumns: meta.modifiedColumns };
  });

return {
  modifiedRows,
  modifications: allModifications,
  errorReport: allWarnings,
  stats: {
    totalRows: bankRows.length,
    hitRowCount: modifiedRows.length,
    scenarioHitCount,
    hitScenarioIds,
    warningCount: allWarnings.length,
    skippedC3Count,
    skippedC4Count
  }
};

// 改后 — modifiedRows 完全不动；新增 unmatchedRows 字段
const modifiedRows = bankRows
  .filter((r) => rowLockSet.has(r._rowId))
  .map((r) => { ... });   // 完全不动

// ⭐ F8 round 3：反向 filter 得未命中 dispatcher 任何 scenario 的行
//    保留原始 bankRows 顺序（用户期望"原始行"）
//    不做 .map 转换（用户不要诊断列）
const unmatchedRows = bankRows.filter((r) => !rowLockSet.has(r._rowId));

return {
  modifiedRows,
  unmatchedRows,                            // ⭐ F8 新增
  modifications: allModifications,
  errorReport: allWarnings,
  stats: {
    totalRows: bankRows.length,
    hitRowCount: modifiedRows.length,
    unmatchedRowCount: unmatchedRows.length, // ⭐ F8 新增
    scenarioHitCount,
    hitScenarioIds,
    warningCount: allWarnings.length,
    skippedC3Count,
    skippedC4Count
  }
};
```

#### 9.8.3 关键不变量（资金红线护栏）

- `modifiedRows` filter 条件 `rowLockSet.has(r._rowId)` **完全不动**
- `unmatchedRows = bankRows - modifiedRows`（反向 filter）
- `modifiedRows.length + unmatchedRows.length === bankRows.length`（无遗漏）
- `modifiedRows ∩ unmatchedRows = ∅`（无重复，dispatcher first-match-wins 互斥保证）
- C4 走独立流水线（main.js:2858 注释），不进 dispatcher → 不影响 unmatchedRows

#### 9.8.4 改动 diff — writer（T14 反向同步：实际是 ExcelJS writer 不是 SheetJS）

> ⚠️ **T14 反向同步说明**：spec 起草时给了 SheetJS sketch（`src/backend/file-service/writers.js` `writeWorkbookRows`），但 dev 实施时按 **bank-statement-process 模块实际 writer = ExcelJS** 路径走（commit d289779 改的是 `src/main-process/exceljs-writer.js`）。两者差别：
> - SheetJS `xlsx-js-style`：用 `XLSX.utils.json_to_sheet` + `XLSX.utils.book_append_sheet` + `XLSX.writeFile`
> - **ExcelJS（dev 实际选）**：用 `workbook.addWorksheet` + 行循环 addRow + `workbook.xlsx.writeFile`
>
> 实际改动文件 `src/main-process/exceljs-writer.js`（commit d289779 改 29 行）。spec sketch 的 SheetJS 写法保留作为参考；实际落地 ExcelJS sketch 参见 commit d289779 diff。

```js
// PM spec 起草版（SheetJS 路径，未实施）— 仅作参考
function writeWorkbookRows({ rows, outputFilePath, sheetName = 'COMMON', unmatchedRows = null }, formatters) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  applyExportFieldFormats(ws, rows, formatters);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  // F8 第 2 sheet
  if (Array.isArray(unmatchedRows)) {
    const cleanedUnmatched = unmatchedRows.map((r) => stripInternalFields(r));
    let unmatchedWs;
    if (cleanedUnmatched.length > 0) {
      unmatchedWs = XLSX.utils.json_to_sheet(cleanedUnmatched);
    } else {
      const headerKeys = rows[0]
        ? Object.keys(rows[0]).filter((k) => !k.startsWith('_'))
        : [];
      unmatchedWs = XLSX.utils.aoa_to_sheet([headerKeys]);
    }
    XLSX.utils.book_append_sheet(wb, unmatchedWs, '未命中场景行');
  }

  applyWatermark(wb);
  XLSX.writeFile(wb, outputFilePath);
}

// stripInternalFields helper — 实际 dev 实施时放在 exceljs-writer.js 内
function stripInternalFields(row) {
  const cleaned = {};
  for (const k of Object.keys(row)) {
    if (!k.startsWith('_')) cleaned[k] = row[k];
  }
  return cleaned;
}
```

**Dev 实际落地（ExcelJS 路径，commit d289779 `src/main-process/exceljs-writer.js`）核心改造**：

```js
// exceljs-writer.js (~29 行 diff，详 commit d289779)
// 在 workbook.addWorksheet(sheetName) 后追加：
if (Array.isArray(unmatchedRows)) {
  const unmatchedSheet = workbook.addWorksheet('未命中场景行');
  const cleanedUnmatched = unmatchedRows.map((r) => stripInternalFields(r));
  if (cleanedUnmatched.length > 0) {
    // 第 1 行 header
    unmatchedSheet.addRow(Object.keys(cleanedUnmatched[0]));
    // 数据行
    cleanedUnmatched.forEach((row) => unmatchedSheet.addRow(Object.values(row)));
  } else {
    // 0 行仍输出 header（与 v2.1.6 acquiring-bill-currency 差异表"0 差异行仍输出"一致）
    const headerKeys = rows[0]
      ? Object.keys(rows[0]).filter((k) => !k.startsWith('_'))
      : [];
    unmatchedSheet.addRow(headerKeys);
  }
}
// applyWatermark / await workbook.xlsx.writeFile(outputFilePath) 沿用原逻辑
```

关键不变量两个 writer 一致：第 2 sheet 名 '未命中场景行' / 原始列 / strip `_` 前缀 / 0 行仍输出表头。

#### 9.8.5 改动 diff — main.js 调用方

```js
// src/main.js:5948-5957 现状
writeWorkbookRows({
  rows: detailExportRows,
  outputFilePath: detailOutput.outputFilePath
});

// 改后 — 把 dispatcher 返回的 unmatchedRows 传入
writeWorkbookRows({
  rows: detailExportRows,
  outputFilePath: detailOutput.outputFilePath,
  unmatchedRows: preparedBatch.unmatchedRows || []  // ⭐ F8 新增（来源 dispatcher，dev 阶段确认 preparedBatch 是否含 unmatchedRows，否则需新增传递）
});
```

**dev 阶段必查**：`preparedBatch` 在哪里组装？是否含 dispatcher 返回的 unmatchedRows？如未传递需补 main.js 中间层；spec 阶段 grep `preparedBatch` 与 `runScenarioDispatcher` 间组装点。

#### 9.8.6 sheet 命名 + 列结构（用户拍板）

| 项 | 值 |
|---|---|
| sheet 名 | `未命中场景行` |
| 列结构 | **保留原始银行对账单行所有列**（不映射，不加诊断列）|
| 空数据 | 即使 0 行也输出含表头 sheet |
| 内部字段过滤 | `_rowId` / `_hitScenarioId` / `_modifiedColumns` 等 `_` 前缀字段 strip |

#### 9.8.7 smoke 用例 🚨 资金红线

```js
// scripts/smoke/scenario-dispatcher.js（已有）追加 F8 case
// 或新建 scripts/smoke/dispatcher-unmatched.js

// Case F8-1：unmatchedRows = bankRows - modifiedRows
const result = runScenarioDispatcher(bankRows, [scenarioA, scenarioB]);
assert.ok(Array.isArray(result.unmatchedRows));
assert.strictEqual(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);

// Case F8-2：无重复（first-match-wins 互斥）
const modifiedIds = new Set(result.modifiedRows.map((r) => r._rowId));
const unmatchedIds = new Set(result.unmatchedRows.map((r) => r._rowId));
const intersection = [...modifiedIds].filter((id) => unmatchedIds.has(id));
assert.strictEqual(intersection.length, 0, 'modifiedRows ∩ unmatchedRows = ∅');

// 🚨 Case F8-3 资金红线：matchedRows count 与 v2.1.6 baseline 一致
// 跑 v2.1.6 既有 scenario-dispatcher.js smoke 全套，应全部通过（modifiedRows 行为不动）
// 此 case 由 "smoke scenario-dispatcher.js 全套 + scenario-engines.js 全套通过" 间接保证

// Case F8-4：writer 第 2 sheet
const tempPath = path.join(tempDir, 'test-unmatched.xlsx');
writeWorkbookRows({ rows: mainRows, outputFilePath: tempPath, unmatchedRows: unmatchedRows });
const wb = XLSX.readFile(tempPath);
assert.strictEqual(wb.SheetNames.length, 2);
assert.strictEqual(wb.SheetNames[0], 'COMMON');
assert.strictEqual(wb.SheetNames[1], '未命中场景行');
const sheet2 = XLSX.utils.sheet_to_json(wb.Sheets['未命中场景行']);
assert.strictEqual(sheet2.length, unmatchedRows.length);

// Case F8-5：内部 _ 前缀字段 strip
const sheet2Keys = sheet2.length > 0 ? Object.keys(sheet2[0]) : [];
assert.ok(!sheet2Keys.some((k) => k.startsWith('_')));

// Case F8-6：0 unmatched → 仍输出表头 sheet
writeWorkbookRows({ rows: mainRows, outputFilePath: tempPath2, unmatchedRows: [] });
const wb2 = XLSX.readFile(tempPath2);
assert.strictEqual(wb2.SheetNames.length, 2);
const sheet2Empty = XLSX.utils.sheet_to_json(wb2.Sheets['未命中场景行']);
assert.strictEqual(sheet2Empty.length, 0);
```

#### 9.8.8 风险与回归保护 🚨

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🔴 **资金红线** | dispatcher 行为变化影响 modifiedRows | `modifiedRows` filter 条件不动；smoke 强制 "scenario-dispatcher.js 全套 + scenario-engines.js 全套通过"（无 baseline 偏差） |
| 🟡 中 | preparedBatch 是否含 unmatchedRows？需 dev 阶段补传递链路 | spec §9.8.5 提示 dev grep；可能需 main.js 中间层加 unmatchedRows 字段 |
| 🟡 中 | 主功能 writer 改造影响所有 currency 文件 | smoke 混币种场景；旧 writer 单测全部回归 |
| 🟢 低 | xlsx 文件大小 | 0 unmatched 仅多表头 ~1KB；N 行线性增长 |
| 🟢 低 | `_` 前缀字段泄露 | `stripInternalFields` helper + smoke F8-5 |
| 🟢 低 | watermark 顺序 | 沿用 v2.1.6 Module A 范式 |

#### 9.8.9 重要变量检查

F8 修改 `runScenarioDispatcher` 返回 schema + `writeWorkbookRows` 加可选入参 + main.js 调用方；dispatcher 是 **C1/C2/C3 资金红线主路径**。建议 `/check-vars` 评估 `runScenarioDispatcher` 升格 Critical 层。

#### 9.8.10 ⏸ 待澄清子项（不阻塞 spec，dev 阶段可决策）

1. "处理结果文件"是否仅指明细文件？PM 推荐：**仅明细文件加 sheet**；余额文件不加（与未命中场景无关）
2. 每文件 vs 汇总文件？PM 推荐：**每个明细文件都加 sheet**（与文件本身上下文一致）

---

## 十、round 4 — 用户手测 round 3 后反馈修复（B1 + B2 + B4）

### 10.1 子任务划分（与 PRD §十六对齐）

| 子任务 | 性质 | 改动文件 | 风险 |
|---|---|---|---|
| B1（round 4）| DOM 重组 Layout-1 + CSS 字体一致性 | renderer-dialogs.js + styles-gemini-extra.css（双写）| 🟢 低 |
| **B4（round 4）真根因 fix** | 1 行 CSS（grid 子项 min-height: 0）| styles-gemini-extra.css + Clear/styles-gemini-extra.css | 🟢 低 |
| B2（round 4）| dev 实测后选路径 A 或 B | renderer-dialogs.js（路径 A）或 styles-gemini-extra.css（路径 B） | 🟢 低 |

### 10.2 B1（round 4）— F1 radio Layout-1（用户拍板）

#### 10.2.1 现状（PM grep 确认）

| 文件:行号 | 现状 | round 4 改动方向 |
|---|---|---|
| `src/renderer-dialogs.js:6325-6346` | dev round 3：radio 在 `.scenario-config-multi-wrap` 内部（右列末尾） | 移到左列 + 新增 `.scenario-config-label-stack` 容器 |
| `src/styles-gemini-extra.css:2274-2281` `.scenario-config-label` | `width: 120px; font-weight: 500; color: #3c4043;` 无 font-size（继承父 ~14px）| 不动 |
| `src/styles-gemini-extra.css:2477-2482` `.scenario-config-feature-grid label` | `font-size: 13px;` | 基准 — radio label 显式设 13px 对齐 |
| `src/styles-gemini-extra.css:2284-2286` `.scenario-config-row-multi .scenario-config-label` | `padding-top: 6px;` 多行 row label 顶端对齐 | label-stack 容器复用此效果 |

#### 10.2.2 改动 diff（HTML）

```html
<!-- L6325-6346 改后（Layout-1：左列纵向 label + AND + OR radio；右列 conditions）-->
<div class="scenario-config-row scenario-config-row-multi">
  <!-- ⭐ B1 round 4：新增左列容器 -->
  <div class="scenario-config-label-stack">
    <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>
    <div class="scenario-config-logic-inline">
      <label class="scenario-config-logic-option">
        <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        AND（同时满足）
      </label>
      <label class="scenario-config-logic-option">
        <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        OR（满足任一）
      </label>
    </div>
  </div>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
  </div>
</div>
```

#### 10.2.3 改动 diff（CSS）

`src/styles-gemini-extra.css` + `Clear/styles-gemini-extra.css`（双写）新增（约 L2287 后）：

```css
/* B1 round 4：scenario-config-label-stack 左列容器 — 纵向 label + radio 组 */
.scenario-config-label-stack {
  flex-shrink: 0;
  width: 120px;            /* 与 .scenario-config-label 同宽 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-self: flex-start;
  padding-top: 6px;        /* 对齐原 .scenario-config-row-multi .scenario-config-label padding-top */
}

/* B1 round 4：label-stack 内部 radio 容器 */
.scenario-config-logic-inline {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* B1 round 4：radio label 字体 13px（与 .scenario-config-feature-grid label "筛选字段" 对齐）*/
.scenario-config-logic-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;         /* ⭐ 字体一致性关键 */
  font-weight: normal;     /* 不复用 .scenario-config-label 的 font-weight: 500 */
  color: #3c4043;
  cursor: pointer;
}
.scenario-config-logic-option input[type="radio"] {
  margin: 0;
  cursor: pointer;
}

/* B1 round 4：清理 round 2 / round 3 留下的旧 class（如不被任何 HTML 引用）*/
/* .scenario-config-logic-stack / .scenario-config-logic-stack-option — dev 阶段 grep 确认无引用后可删 */
```

#### 10.2.4 关键不变量

- 资金红线护栏 R5 三层不动（默认 config / pickConditionsLogicChecked / 引擎 fallback OR）
- 仅 DOM 重组 + CSS 新规则；JS 逻辑不动
- label-stack 容器外宽度与原 .scenario-config-label 一致（120px），右列 .scenario-config-multi-wrap 视觉位置不变

#### 10.2.5 smoke + preview

- smoke 无（DOM + CSS 重组，靠 preview screenshot + 手测）
- F1 / R5 / B1 round 3 / B1 round 4 preview 必跑（dialog 视觉变化）

### 10.3 B4（round 4）— grid 子项 min-height: 0（真根因 fix）

#### 10.3.1 完整高度链 + 真根因（详 PRD §16.3）

```
.modal-card (max-height: calc(100vh - 56px))
  .big-account-selection-card (width 1200, min-height 540)
    .big-account-selection-split (min-height 600)
      .big-account-split-body (flex:1, overflow:hidden)
        .ba-scroll-container (display:grid, max-height:52vh, min-height:360px)
          .big-account-split-left/right (display:flex, overflow:hidden)
            ⚠️ 缺 min-height: 0 ⚠️
            .big-account-split-header (40px fixed)
            .big-account-file-list / .big-account-order-list (flex:1, overflow-y:auto)
```

**真根因**：`.big-account-split-left/right` 是 `.ba-scroll-container` 的 grid 子项，**grid item 默认 `min-height: auto = content size`**。20+ 文件时 content size ~840px > 52vh ~562px，**不让父 max-height: 52vh 收缩** → file-list `overflow-y: auto` 永不触发 → 用户看不到底部 + 没有滚动条。

#### 10.3.2 修复 diff

```css
/* styles-gemini-extra.css L369-376 现状 */
.big-account-split-left,
.big-account-split-right {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #fff;
}

/* 改后（B4 round 4 真根因 fix）*/
.big-account-split-left,
.big-account-split-right {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #fff;
  /* ⭐ B4 round 4：让 grid 子项允许收缩到 < content size，让父 .ba-scroll-container max-height:52vh 真正生效；
     不加这行 → grid item min-height: auto = content size 穿透 max-height → file-list overflow-y:auto 永不触发 */
  min-height: 0;
}
```

**双写**：`src/styles-gemini-extra.css` + `Clear/styles-gemini-extra.css`（与 R6a/R6c 一致的 Dev 双路径范式）。

#### 10.3.3 dev round 3 scrollbar 强制可见 CSS 保留

**不要删** dev round 3 加的 styles-gemini-extra.css:391-408（`scrollbar-width: thin + scrollbar-color + ::-webkit-scrollbar 8px`）：
- B4 round 4 修：`min-height: 0` → 滚动条**产生**
- B4 round 3 留存：`scrollbar-width: thin` → 滚动条**持续可见**（防 macOS overlay-style 仅 hover 显示）

#### 10.3.4 验收

- 手测打开 round 3 已建 `applyBigAccountSelectionMultiLargePreviewState` fixture（≥20 文件）→ 列表自动出现垂直滚动条
- 手测滚动到底 → 能看到最后一行
- 手测 5 文件 → 列表无滚动条
- DevTools：`.big-account-split-left clientHeight < scrollHeight`（被 max-height cap 在 52vh）

#### 10.3.5 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | min-height: 0 在小屏 / 极端 viewport 下让弹窗收缩过度 | `.ba-scroll-container min-height: 360px` floor 兜底 |
| 🟢 低 | 双侧对称改动可能影响 split-right 大账号顺序列表 | 双侧对称，行为一致；preview 验证 |

### 10.4 B2（round 4）— multi 完成态字母没显示（双路径 sketch）

#### 10.4.1 现状 + 候选根因

详 PRD §16.4。dev round 3 加 `min-width: 24px` 无效；用户原话 B2 测试**被 B4 阻塞**手测。

**候选 1：letterSpan textContent 为空**（renderer-dialogs.js:1030-1037 + findGroupByRowIndex pendingGroup 返回 groupIndex=-1）

**候选 2：grid track 宽度被压**（grid_template-columns `auto auto 1fr` 不保证第 2 列 ≥ 24px）

#### 10.4.2 路径 A — 修 letterSpan 渲染（候选 1 真根因时）

```js
// renderer-dialogs.js L1030-1037 改后
const groupInfo = findGroupByRowIndex(rowIndex);
let letterText = '';
if (groupInfo && groupInfo.source === 'closed' && groupInfo.groupIndex >= 0) {
  letterText = `${String.fromCharCode(97 + groupInfo.groupIndex)}.`;
} else if (groupInfo) {
  // 完成态命中 pending（边界 case）→ 警告 + '?' 占位
  console.warn(`B2 round 4: ba-multi-grouped 分支命中 pendingGroup row ${rowIndex}，字母用 '?' 占位`);
  letterText = '?.';
}
letterSpan.textContent = letterText;
```

#### 10.4.3 路径 B — 改 grid track minmax（候选 2 真根因时）

```css
/* styles-gemini-extra.css L398-400 现状 */
.ba-file-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  ...
}

/* 改后（路径 B）*/
.ba-file-row {
  display: grid;
  grid-template-columns: auto minmax(24px, auto) 1fr;
  ...
}
```

#### 10.4.4 dev 实施步骤

1. **先修 B4**（spec §10.3）让滚动条可用
2. 用 round 3 fixture 进入 multi 完成态
3. Chrome DevTools 选 grouped 行 letterSpan：
   - textContent 为空 → 候选 1 → 路径 A
   - textContent 有值但视觉看不见（看 Computed width）→ 候选 2 → 路径 B
4. 提交修复
5. 用户回归如仍不行 → round 5

#### 10.4.5 验收

- 手测 multi 完成态：字母 "a./b./c." 正常显示
- 手测 multi 编辑态：checkbox + letter + meta 3 列布局不破
- 手测非 multi 模式：idx + meta 不破（regression）
- preview R6a 4 张回归（含 grouped 闭合态）

#### 10.4.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 路径 A console.warn 太多 | 仅边界 case 触发 |
| 🟢 低 | 路径 B grid minmax 影响非 multi 2 子项 | idx span 自身宽度 ≥ 24px → 无视觉差异 |

---

## 十一、round 5 — 用户手测 round 4 后反馈修复（B1 微调 + B4 真根因第 2 层）

### 11.1 子任务划分（与 PRD §十七对齐）

| 子任务 | 性质 | 改动文件 | 风险 |
|---|---|---|---|
| B1（round 5）| DOM 微调 + tooltip 文案扩展 | renderer-dialogs.js | 🟢 低 |
| **B4（round 5）真根因第 2 层 🚨** | 2 行 CSS（第 3 层 flex item 主修 + 第 1 层 split-body 防御性兜底）| styles-gemini-extra.css + Clear/styles-gemini-extra.css | 🟢 低 |
| B2（round 5）跟随 | round 4 路径 A 已修；等用户实测；如失败 round 6 走路径 B | — | — |

### 11.2 B1（round 5）— 去掉 radio 文本 + tooltip 整合到"条件" label

#### 11.2.1 用户拍板

去掉 radio "（同时满足）/（满足任一）"括号文本；提示合到"条件" label tooltip。PM 推荐**方案 B 单 tooltip 整合**（vs 方案 A 每 radio 独立 ⓘ — 后者视觉杂乱）。

#### 11.2.2 现状（PM grep 确认）

`src/renderer-dialogs.js:6358-6368`（round 4 落地）：

```html
<span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>
<div class="scenario-config-logic-inline">
  <label class="scenario-config-logic-option">
    <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
    AND（同时满足）
  </label>
  <label class="scenario-config-logic-option">
    <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
    OR（满足任一）
  </label>
</div>
```

#### 11.2.3 改动 diff（HTML 微调）

```html
<!-- L6358 "条件" label tooltip 现状 -->
<span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>

<!-- 改后（B1 round 5 方案 B：tooltip 多行扩展含 AND + OR 各自语义）-->
<span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑：&#10;AND — 同时满足所有条件才命中&#10;OR — 满足任一条件即命中">ⓘ</span></span>

<!-- L6360-6367 radio label 现状（含括号）-->
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
  AND（同时满足）
</label>
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
  OR（满足任一）
</label>

<!-- 改后（B1 round 5：去掉括号文本）-->
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
  AND
</label>
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
  OR
</label>
```

#### 11.2.4 关键不变量

- `&#10;` HTML 实体换行符；浏览器 native tooltip 支持多行（macOS / Windows 兼容）
- 资金红线护栏 R5 三层不动（默认 config / pickConditionsLogicChecked / 引擎 fallback OR）
- B1 round 4 字体 13px font-weight:normal Layout-1 全部不动
- 仅 3 处微调：tooltip 文案 + radio 2 处文本

#### 11.2.5 smoke + preview

- smoke 无（DOM 微调）
- F1 preview 必跑（视觉变化）

### 11.3 B4（round 5）真根因第 2 层 🚨 — 第 3 层 flex item 也加 min-height: 0

#### 11.3.1 PM 完整高度链 grep 验证

详 PRD §17.3.2。3 层 flex/grid 嵌套：

| 层 | 元素 | 类型 | min-height 状态 |
|---|---|---|---|
| 1 | `.big-account-split-body` | modal-card 的 flex item | **缺 min-height: 0**（极小屏边界 case，防御性兜底）|
| 2 | `.big-account-split-left/right` | ba-scroll-container 的 grid item | ✓ round 4 已修 |
| 3 | `.big-account-file-list/order-list` | split-left/right 的 flex item | **缺 min-height: 0**（用户报告主路径） |

#### 11.3.2 真根因（经典 flex 嵌套坑）

**flex/grid item 默认 `min-height: auto = content size`**。每层 flex/grid 嵌套都需要显式 `min-height: 0`，否则**最内层 content size 会一路撑过所有父级 max-height 约束**。

round 4 修对了第 2 层但漏了第 3 层：
- file-list 自己 `min-height: auto = ~800px`（20+ 文件）
- 把父 split-left 撑到 800px（即使 split-left 加了 min-height: 0）
- 把祖父 ba-scroll-container 撑超 max-height: 52vh = 562px
- 自己 overflow-y: auto **永不触发**（scrollHeight = clientHeight）

#### 11.3.3 改动 diff（主修第 3 层 + 防御性第 1 层）

```css
/* styles-gemini-extra.css L390-400 现状（dev round 3 + dev round 4 累积状态）*/
.big-account-file-list,
.big-account-order-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  display: flex; flex-direction: column; gap: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 80, 60, 0.3) transparent;
}

/* 改后（B4 round 5 真根因第 2 层主修）*/
.big-account-file-list,
.big-account-order-list {
  flex: 1;
  overflow-y: auto;
  /* ⭐ B4 round 5：第 3 层 flex item 也需要 min-height: 0 — 与 round 4 给 .big-account-split-left/right 的 min-height: 0 配套
     默认 min-height: auto = content size → 即使父 split-left 加了 min-height: 0，file-list 自己仍把父撑到 content size 高
     → 祖父 ba-scroll-container max-height: 52vh 仍被穿透 → 自己 overflow-y: auto 永不触发
     经典 flex 嵌套坑：每层 flex item 都需要显式 min-height: 0，content size 才不会从最内层一路撑过所有父级约束 */
  min-height: 0;
  padding: 6px 8px;
  display: flex; flex-direction: column; gap: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 80, 60, 0.3) transparent;
}
```

```css
/* styles-gemini-extra.css L357-360 现状 */
.big-account-split-body {
  flex: 1;
  padding: 8px 12px 0;
  overflow: hidden;
}

/* 改后（B4 round 5 防御性第 1 层兜底）*/
.big-account-split-body {
  flex: 1;
  padding: 8px 12px 0;
  overflow: hidden;
  /* ⭐ B4 round 5 防御性兜底：modal-card 的 flex column 子项；1080p viewport 下 split-body flex:1 可用 ~944px >> ba-scroll-container max-height 52vh = 562px，主路径不触发
     极小屏（< 700px 高）边界 case 下可能 content size 撑超 modal-card max-height: calc(100vh - 56px)
     防御性加 min-height: 0 兜底（不影响主路径，纯极端 case 保护，与第 3 层 file-list min-height: 0 联合形成完整高度链）*/
  min-height: 0;
}
```

**双写**：`src/styles-gemini-extra.css` + `Clear/styles-gemini-extra.css`（与 R6a / R6c / round 4 B4 一致的 Dev 双路径范式）。

#### 11.3.4 dev round 3 scrollbar 强制可见 CSS 保留

**不要删** styles-gemini-extra.css:396-413（scrollbar-width:thin + scrollbar-color + ::-webkit-scrollbar）— 两阶段完整覆盖：
- B4 round 5 修：第 3 层 `min-height: 0` → 滚动条**产生**
- B4 round 3 留存：scrollbar-width:thin → 滚动条**持续可见**（防 macOS overlay-style）

#### 11.3.5 关键不变量

- round 4 加的 `.big-account-split-left/right min-height: 0` 保留不动
- dev round 3 加的 scrollbar CSS 保留不动
- 双写 src + Clear 与历史 Dev 范式一致
- 主修 file-list/order-list（用户报告主路径）+ 防御性兜底 split-body（极小屏 edge case）
- 不动其它高度链层（modal-card / selection-card / ba-scroll-container 等）

#### 11.3.6 smoke + 验收

- smoke 无（纯 CSS）
- 手测打开 round 3 已建 `applyBigAccountSelectionMultiLargePreviewState` fixture（≥20 文件）→ 列表自动出现滚动条
- 手测**鼠标滚轮 + trackpad** 在列表区域滚动到底（用户原话验证点）
- 手测 5 文件 → 列表无滚动条（regression）
- 手测大账号顺序列表（右列）同步出现滚动条（split-right 也修了）
- DevTools 检查：
  - `.big-account-file-list clientHeight < scrollHeight`（触发 overflow）
  - `.big-account-split-left clientHeight ≈ 562px = 52vh`（被父 max-height cap）

#### 11.3.7 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 第 3 层 min-height: 0 在小屏下让 file-list 收缩过度 | `.ba-scroll-container min-height: 360px` floor 兜底 |
| 🟢 低 | split-body 防御性 min-height: 0 影响 modal-card flex 计算 | 主路径下 split-body flex:1 撑大，min-height: 0 仅在 content 极小时起作用 |
| ⚠️ **round 6 实测发现** | spec §11.3.1 PM 推断的"3 层 min-height: 0 修齐就能滚"**不够** | round 6 真根因补 — `.ba-scroll-container` 缺 `grid-template-rows: 1fr` 让 grid row 不受父 max-height 约束。详 §11.3.8 round 6 补章 |

#### 11.3.8 B4 round 6 真根因补 — `.ba-scroll-container` 加 `grid-template-rows: 1fr`

> **PM T14 反向同步**：spec §11.3.2 PM 推断的 "3 层 flex item 都需要 min-height: 0" **不完整**。Dev round 5 修齐 3 层 min-height: 0 后用户实测仍不能滚（commit fb88040 + 3f72cfc）；dev round 6（commit a9cb2ad）用 Chrome DevTools 揭示**第 4 个根因层**：`.ba-scroll-container` 缺 `grid-template-rows` 让 grid row 跑出 max-height。

##### DevTools 实测数据（用户 viewport 860px）

```
splitLeft_h:           5952px  ❌ 是父 447 的 13 倍
scrollContainer_h:     447px   ✓ max-height: 52vh 生效
fileList_client:       5911
fileList_scroll:       5911    ❌ = client，overflow 永不触发

computed_fileList_minH:        "0px"   ✓ round 5 生效
computed_splitLeft_minH:       "0px"   ✓ round 4 生效
computed_splitBody_minH:       "0px"   ✓ round 5 生效
computed_scrollContainer_maxH: "447.2px" ✓ 生效
```

**所有 round 4/5 加的 `min-height: 0` 都 computed 生效**（确认是 PM round 5 推断完整高度链思路对的），**但 `splitLeft_h = 5952px`** 仍远超父 447 的 13 倍。

##### 真根因（grid 第 4 个坑）

`.ba-scroll-container { display: grid; grid-template-columns: 1fr 1fr }` **没设 `grid-template-rows`**。CSS Grid 默认 `grid-auto-rows: auto = content size`（不是 1fr）。

- grid row 高 = content size（splitLeft content 5952px）
- grid item splitLeft 跟随 row 高 = 5952px
- 即使 splitLeft `min-height: 0` 生效（允许收缩），**没 row 约束就不会收缩**
- 即使 ba-scroll-container `max-height: 52vh = 447px` 生效，**只 cap 容器自己高度**，**不向下传递给 row**
- splitLeft 跑出 ba-scroll-container 边界（visible，不被 overflow:hidden 切）→ file-list scrollHeight = clientHeight → overflow-y:auto 永不触发

##### round 6 修复（1 行 CSS 双写）

```css
/* styles-gemini-extra.css L361-368 现状（round 4/5 累积状态）*/
.ba-scroll-container {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  height: 100%;
  min-height: 360px;
  max-height: 52vh;
}

/* round 6 改后（commit a9cb2ad）*/
.ba-scroll-container {
  display: grid;
  grid-template-columns: 1fr 1fr;
  /* ⭐ B4 round 6 真根因 fix（DevTools 数据揭示）：grid-template-rows 缺失 → 默认 grid-auto-rows: auto = content size
     → grid item (split-left) 撑到 content 高度（实测 5952px）远超父 max-height: 52vh (实测 447px)
     → file-list 自身父级无限制 → overflow-y:auto 永不触发
     round 4/5 加的 split-left/right + file-list + split-body min-height: 0 全部 computed = "0px" 但不解决问题
     真 fix = grid-template-rows: 1fr 让 row 等于父高度，grid item 跟随 row 限到 447px */
  grid-template-rows: 1fr;
  gap: 16px;
  height: 100%;
  min-height: 360px;
  max-height: 52vh;
}
```

双写 `src/styles-gemini-extra.css` + `Clear/styles-gemini-extra.css`。

##### round 6 关键不变量

- round 3/4/5 加的所有规则**全部保留**（`min-height: 0` 三处 + scrollbar-width:thin + ::-webkit-scrollbar），组成完整多层防御
- round 6 仅追加 `grid-template-rows: 1fr` 1 行
- 22 个 smoke suite 全过

##### round 6 PM 经验沉淀（写到 knowledge/）

**flex/grid 嵌套穿透 max-height 必修两条线**：
1. **每层 flex/grid item 加 `min-height: 0`** — 破除 `min-height: auto = content size` 默认值（让子项允许收缩）
2. **grid 父容器加 `grid-template-rows: 1fr` 或 `grid-template-rows: 100%`** — 让 grid row 跟随父高度（不是 content size）

二者**不可缺一**。round 4-5 只修线 1（min-height: 0）不够；round 6 补线 2（grid-template-rows）才彻底。

PM 建议沉淀到 `knowledge/css-flex-grid-overflow-pitfalls.md`（v2.1.7 完整 4 round 历程 + DevTools 验证数据）。

### 11.4 B2（round 5）跟随 — 不在本 spec 范围

dev round 4 已走路径 A 修源码（renderer-dialogs.js:1030-1037 letterSpan textContent 显式判 source='closed'）；B4 round 5 修好后用户实测：

- ✓ 字母 a/b/c 显示 → 路径 A 成功 → B2 收尾
- ✗ 字母仍不显示 → round 6 走**路径 B**（改 `.ba-file-row grid-template-columns: auto minmax(24px, auto) 1fr`，spec §10.4.3 已有完整 sketch）

**round 5 不主动改 B2**。

### 11.5 ⏸ 待澄清子项

- [ ] **round 5 B4 修复后是否真能滚**：dev 修完后 spec §11.3.6 全套手测 + DevTools 必跑；如仍不行 → round 6 PM 深挖
- [ ] **B2 是否需 round 6 路径 B**：等用户 round 5 测试反馈

---

## 十二、附录 A：F2 方案 B/C 留档（未实施）

PRD §7.2 / §7.3 已详述方案 B（双向 1v1 + tieBreak）与方案 C（同金额分组 + zip 配对）。**v2.1.7 不实施**；若用户在 v2.1.7 发布后反馈方案 A 漏配，按以下提示在 v2.1.8 升级：

- 方案 B 升级：参考 `c4-recon-id-fix.js:611-665 tryOneToOne` 范式实现（已成熟），预估 1 天
- 方案 C 升级：重写 C3 主循环，预估 1.5 天 + 大量回归 smoke

---

## 十三、文档变更记录

| 版本 | 日期 | 修订 |
|---|---|---|
| v0.1 | 2026-05-20 | 起草；6 项需求覆盖（F1-F6）；F4 §5.7 引擎放宽含衍生方案 A（无条件赋值）；F5 §6.4 AC-F5-4 基线 ⏸ TBD 占位；F6 §7.3 main.js handler 100ms 节流 |
| v0.2 | 2026-05-20 | F5 整体延期 v2.1.8，删 §六 F5 章节；§六 改为 F6（原 §七）；§七 改为附录 A（原 §八）；§八 改为文档变更（原 §九）；§一边界说明改 6 项 → 5 项 + 加 F5 延期说明 + 加 v2.1.6 C4 smoke 回归保护要求；F2 §3.2 新增"边界场景说明"含 3 种退化为零命中的情况；F3 §四头部加"不深挖 double-escape"边界说明；版本表头 v0.3 → v0.4 |
| v0.3 | 2026-05-21 | **追加 §七 F7 — SQL 调优 + 系统通知**：含 7.1-7.11 全节（子任务划分 / 现状定位 / 3 段 diff [A1 PRAGMA / A2 索引 + ANALYZE / B1 Notification] / 3 个 smoke / 19 suite 回归矩阵 / USER_GUIDE WAL 旁文件提示 / 风险表）；§八 附录 A（原 §七）+ §九 文档变更（原 §八）顺延；F6 子节标号从 7.x 修正为 6.x（v0.2 删 F5 时漏改）；§一边界说明改 5 项 → 6 项 + 加 F7 影响所有 DB instance 说明；版本表头 v0.4 → v0.5 |
| v0.4 | 2026-05-21 | **追加 §八 round 2 — 用户手测反馈修复 R1-R5**：5 子节（R1 删按钮门槛 1 字符 diff / R2 fileCount 显式注入 / R3 状态框「：」换行全局规则 + 19 suite 矩阵 + 文案审计 / R4 acquiring inflightOperation flag 不扩散 / R5 默认 AND + dialog 纵向 + 资金红线三层护栏 + dialog 工厂 fn 测试方法 + 升格候选）；§九 附录 A（原 §八）+ §十 文档变更（原 §九）顺延；§一边界改 6 项 + round 2 5 项；版本表头 v0.5 → v0.6；**PM 关键发现**：R4 衍生评估其它模块用 apply*ButtonState 范式已无此问题，R4 仅修 acquiring 不扩散；R5 资金红线护栏必须三层（默认 config + dialog helper + 引擎 fallback），缺一不可 |
| v0.5 | 2026-05-21 | **§八 R6 ⏸ → 拆 R6a/R6b/R6c 三节**：① **R6a F3 multi 模式文件名根因细化** — PM 在 spec 阶段 grep 深挖发现两层根因：① `.ba-file-name { flex:1 1 auto }` 对 grid 子项无效（用户已分析）+ ② `.ba-file-row { grid-template-columns: 28px 1fr }` 硬编码 2 列 vs multi 各分支动态 append 3 子项（PM 发现）；spec §8.7 给精确 CSS sketch 方案 C（grid `auto auto 1fr` 3 列 + 弹窗加宽 1080→1200 + 删 `flex:1 1 auto`），方案 B 备选（JS 阈值 14）+ 普通模式 `:not()` 兜底；4 张 preview 必跑；② **R6b 滚动条丢失合并到 R6a 回归验证** — PM 二次诊断高度链已通 4 层（modal-card → split-body → ba-scroll-container max-height:52vh → file-list overflow-y:auto），真根因 = R6a 单行挤压副作用，R6a 修复后自动恢复，spec §8.8 仅作"R6a 后回归验证"+ 边界提示；③ **R6c `.extract-order-list` 加 2 行 CSS** — `max-height: calc(100vh - 280px)` + `overflow-y: auto`（含 280px 余量推导，含 modal-card 高度链分析）；版本表头 v0.6 → v0.7；**PM 关键发现**：用户描述"flex 对 grid 无效"正确但只是表层；真根因是 grid 列数硬编码 28px 1fr vs 子项数 3 不匹配；spec 推荐方案 C 兼非 multi 模式，preview 验证视觉是否破版决定是否加 `:not()` 兜底 |
| v0.6 | 2026-05-21 | **追加 §九 round 3 — B1-B5 + F4 删空 + F8**（共 7 子节 9.1-9.8）：① B1 F1 radio 移回"条件"row 内部（DOM 重组）；② B2 multi 完成态字母列方案 A（`min-width:24px + text-align:center` 1 行 CSS）；③ **B3 用户拍板方案 A** — extract-order-card 单 grid + 单 overflow + 移除 `.extract-order-list`；④ B4 ≥20 文件场景 ⏸ 待 dev 实测 + 新建 `applyBigAccountSelectionMultiLargePreviewState` fixture；⑤ **B5 R3 wiring 漏接审计** — PM grep 发现 3 处直写 statusBox（用户发现 1 处 + PM 再发现 2 处 `updateBankStatementUi:3330` + `updateReconIdFixUi:3684`），三处全部改走 updateStatusBox + render-status-box smoke wiring 审计断言（dataset.tone vs is-* class 风格差异需 dev 实测决定 CSS 兼容方式）；⑥ F4 删空 — R1 只改 L6716 display 没改 L6794 handler，同步两处为 `>= 1`；⑦ **F8 🚨 资金红线** — 用户 round 3 拍板定义 = dispatcher first-match-wins 后无任何 scenario 命中的行；PM grep 验证 `scenario-dispatcher.js:122-123 rowLockSet` 已就绪，**一行反向 filter** 得 unmatchedRows（modifiedRows filter 完全不动）+ writer 加可选 unmatchedRows 入参 + 第 2 sheet "未命中场景行"（原始列 + strip `_` 前缀）+ stripInternalFields helper；§十 附录（原 §九）+ §十一 文档变更（原 §十）顺延；版本表头 v0.7 → v0.8；**PM 关键发现**：① B5 用户发现 1 处 + PM grep 再发现 2 处漏接（很严重）；② F4 R1 只改一半（L6716 改了但 L6794 没改 → 按钮显示但点击无效）；③ F8 dispatcher rowLockSet 已就绪，反向 filter 改造极轻量；④ F8 wiring 链路 preparedBatch ↔ dispatcher unmatchedRows 传递需 dev 阶段补 grep 验证 |
| v0.7 | 2026-05-21 | **追加 §十 round 4 — B1 + B2 + B4**（用户 round 3 验证 3 项未通过）：① **B1 用户拍板 Layout-1**（左列纵向 label + AND + OR radio）+ PM grep 字体差异（14px vs 13px）+ 新增 `.scenario-config-label-stack` 容器 + `.scenario-config-logic-option` 字体 class（13px font-weight:normal）；② **B4 PM grep 真根因已锁定**（不需要等截图）= `.big-account-split-left/right` 是 `.ba-scroll-container` 的 grid 子项，缺 `min-height: 0` → grid item 默认 `min-height: auto = content size` 穿透父 `max-height: 52vh` → file-list `overflow-y:auto` 永不触发（经典 CSS 陷阱）；1 行 CSS 修复双写 src + Clear；dev round 3 scrollbar 强制可见 CSS 保留（双覆盖）；③ **B2 跟随 B4 验证**（用户原话 B2 测试被 B4 阻塞）；PM 双路径 sketch — 路径 A 修 letterSpan.textContent 显式判 source='closed'（防 pendingGroup 边界 case 空字母） / 路径 B 改 `.ba-file-row grid-template-columns: auto minmax(24px, auto) 1fr`；dev 修完 B4 后用 DevTools 现场判断选；§十一 附录 A（原 §十）+ §十二 文档变更（原 §十一）顺延；版本表头 v0.8 → v0.9；**PM 关键发现**：① B4 真根因不是 scrollbar 可见性而是 grid item 穿透 max-height（与 R6a flex/grid item 教训类似的 CSS 陷阱）；② B2 被 B4 阻塞手测（用户原话），需先修 B4 才能完整验证；③ B1 radio label 字体一致性需 `.scenario-config-logic-option` 显式 `font-size: 13px; font-weight: normal` 区别于 `.scenario-config-label` 14px+500 |
| v0.8 | 2026-05-21 | **追加 §十一 round 5 — B1 微调 + B4 真根因第 2 层 + B2 跟随**（用户 round 4 验证 B1 字号/Layout OK 但要求去括号文本 + B4 仍不能滚 + B2 跟随）：① **B1 round 5 微调**（用户拍板：去掉 radio "（同时满足）/（满足任一）"括号文本，提示合到"条件" label tooltip）；PM 推荐方案 B 单 tooltip 整合（vs 方案 A 每 radio 独立 ⓘ 更杂乱），spec §11.2.3 给完整 HTML diff（tooltip 用 `&#10;` HTML 实体多行）；② **B4 round 5 真根因第 2 层** — PM 二次 grep 完整 3 层 flex/grid 嵌套高度链（modal-card → split-body → split-left/right → file-list/order-list），确认 round 4 修对第 2 层 grid item 但漏修第 3 层 flex item file-list/order-list（默认 min-height: auto = content size ~800px 把父 split-left 撑超 ba-scroll-container max-height: 52vh = 562px）；round 5 spec §11.3.3 一次性 2 行 CSS 双写：主修第 3 层 file-list/order-list + 防御性兜底第 1 层 split-body（极小屏 < 700px 高 edge case），dev round 3 scrollbar 强制可见 CSS 保留；③ **B2 跟随 B4 用户实测**：round 4 路径 A 已 commit，B4 round 5 修好后用户验证字母显示 → 路径 A 成功 / 仍不显示 → round 6 走路径 B（spec §10.4.3 已有完整 sketch）；§十二 附录 A（原 §十一）+ §十三 文档变更（原 §十二）顺延；版本表头 v0.9 → v0.10；**PM 关键发现**：① B4 是经典 flex 嵌套坑 — 每层 flex/grid item 都需要显式 min-height: 0，round 4 只修第 2 层不够，round 5 修齐第 3 层（主修）+ 第 1 层（防御性）避免 round 6 再发现遗漏；② B1 tooltip 多行用 `&#10;` HTML 实体（原生浏览器支持，不需新 CSS）；③ round 5 严守 1-2 行 CSS 单行 commit 原则，dev 一次完成 |
| v0.9 | 2026-05-21 | **T14 收口反向同步 3 处**：① **§4.1 / §8.4.2 / §13.4.1 等styles.css误指路修正** — active CSS 是 `src/styles-gemini-extra.css`（index.html cssGeneral disabled，仅 cssClear + cssClearExtra 生效）；dev round 2 R3 commit bcabe29 实际改的是 gemini-extra.css；② **§9.8.4 F8 SheetJS sketch 与 dev 实际落地 ExcelJS 路径不一致** — bank-statement-process 模块 writer 实际是 ExcelJS（`src/main-process/exceljs-writer.js`），dev round 3 commit d289779 按真实 writer 选 ExcelJS sketch；spec sketch 改为标注PM 起草 SheetJS 路径 + Dev 实际 ExcelJS 路径双版本；③ **§11.3.8 新增 B4 round 6 真根因补章** — round 5 修齐 3 层 min-height: 0 后 dev 用 DevTools 实测仍不能滚（splitLeft_h=5952px 是父 447 的 13 倍），真根因 = `.ba-scroll-container` 缺 `grid-template-rows: 1fr` 让 grid row 默认 grid-auto-rows: auto = content size；commit a9cb2ad 加 1 行 CSS 双写修齐；**PM 经验**：flex/grid 嵌套穿透 max-height 必修两条线（min-height: 0 + grid-template-rows: 1fr），缺一不可，建议沉淀到 knowledge/css-flex-grid-overflow-pitfalls.md；版本表头 v0.10 → v0.11 |

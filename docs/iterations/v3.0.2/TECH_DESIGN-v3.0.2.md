# TechDoc - 网银账单小助手 v3.0.2

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.2 |
| 日期 | 2026-06-10 |
| 作者 | Dev |
| 状态 | 定稿（已实施，reverse-sync 用户修订 + 实施记录） |
| 关联 PRD | `docs/iterations/v3.0.2/PRD-v3.0.2.md`（21 条 AC，3 项需求；需求3 含用户修订「限定网关1v1渠道 + 垂直布局」） |
| 依赖 | v3.0.1 baseline；已批准实施计划 `~/.claude/plans/3-0-2-1-op-3-0-1-immutable-flask.md`（唯一事实来源）；变更目录 `changes/v3.0.2/spec.md` |
| 原则 | **最大化复用现成、最小化改动**；资金红线（需求1b 流水批量导入 / 需求3 字段取值赋值）严格遵守单事务合并、不污染原始行、seq 全程 Number、idEnabled=false 保留原值 |

> 本文件所有行号以核对实施计划时的当前工作树为准（个别为函数体内赋值点）；实施时若与工作树偏移，以函数名/锚点为准并 reverse-sync 回本文。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 需求1a 回滚平移 | 可行且极轻。删 `styles-gemini-extra.css:3373-3376` 一段（`#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px); }` 含注释 + `}`）；保留同段 `.gateway-recon-picker-card`(3362+) / `.linked-table-delete-range-card`(3379)。纯 CSS，无逻辑改动。 |
| §5.1 需求1b 流水批量导入 | 可行但 🔴 资金红线。`runFlowImport`（worker `import-worker.js:268`）已有 `cleared` 标志(271/295) → 首个数据行触发 `clearByDate` 只清一次。改为接收 `filePaths` 数组、单进程单事务遍历所有文件、累加 INSERT、聚合 errorRows 即可。**绝不能循环调用现有 `runFlowImport`**（每次都 clear → 互相覆盖）。 |
| §5.2 需求2 改名 | 可行且最小。3 处 UI 字符串（`renderer.js:66` + `renderer-dialogs.js:7553/7554`）。内部 id / 统计 key / IPC 标识不动，沿用 v2.1.14 先例，零风险。 |
| §5.3 需求3 字段取值 | 可行。`classifyRows`(97) 返回行浅克隆带 `_types:Set<Number>` + 全部原始字段；`buildOutputRow`(588) 只读 srcRow + overrides。config_json 自由 JSON，**无需 migration、无需 bump bundleVersion**（`scenarios-bundle-io.js` 既有「新增可选字段旧应用忽略」先例）。新增 helper + 三 apply 函数合并 overrides + UI/校验扩展即可。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | 🔴 需求1b：循环调用 `runFlowImport` → 第 2 个文件 `clearByDate`(import-worker.js:290) 清掉第 1 个文件已插入行 → 静默丢数据（资金事故） | 单进程单事务合并多文件：`BEGIN` → 首个数据行 `clearByDate` 只清一次（沿用 `cleared` 标志）→ 依次 `streamFlowFile` 累加 INSERT → 全通过 COMMIT，任一失败 ROLLBACK（§三 3.1） |
| R-2 | 🔴 需求3：`applyFieldValueOverrides` 若直接写 `mainRow[field]` 会污染分类后的行对象（`classifyRows` 浅克隆仍引用原值字段） | helper 只写新建 `overrides={}`，绝不触碰行对象；单测断言调用后行对象字段未变（§三 3.4 D3 + §七测试） |
| R-3 | 🔴 需求3：`mainTypeSeq`/`oppTypeSeq` 存字符串 → `Set<Number>.has('3')` 恒 false → 规则静默失效（最隐蔽资金 bug） | ①UI 初始化 + change 事件逐条 `Number()` 归一存盘；②引擎入口兜底；③`_types.has(Number(rule.xxx))` 双保险；④校验前置拦截（§三 3.3/3.4/3.5） |
| R-4 | 🔴 需求3：idEnabled=false 若清空 Reference 会丢原始对账号 | 不把 Reference 放进 overrides → `buildOutputRow` 取 srcRow 原值（网关账单 Reference 列，14 列模板成员）= 保留原始值（§三 3.4 D4） |
| R-5 | ⚠️ 需求3：1v多 目标列 = Amount 覆盖拆账值 | 用户显式配置语义，tooltip 标注，不阻断 |
| R-6 | 改前端（需求 1a/1b 前端 / 需求2 / 需求3 dialog）须回归 preview | 落地后跑对应 `npm run preview:*`（项目硬约定 workflow_frontend_previews） |
| R-7 | 需求1b worker 与同步 fallback 两条路径须语义一致 | 两条路径都改为多文件单次 clear + 累加；`runFlowImportAsync`(491) 无 dbPath 兜底路径保持与 worker 同语义（§三 3.1） |
| R-8 |（用户修订）🔴 需求3：字段取值若在 1v多 / 多v1 模式生效，「一对一取值」语义无明确对应、且可能覆盖拆账值 | 限定「网关1v1渠道」可用——UI 禁用+灰显+提示+自动取消 + 校验拦截 + 引擎入口 gate 强制关闭，三道防御（§三 3.3/3.4 D5/3.5） |

### 1.3 与 PRD 的差异

无。技术方案与 PRD §五一致。`scenarios-bundle-io.js` 实际路径为 `src/backend/scenarios-bundle-io.js`（实施计划简写为 `scenarios-bundle-io.js`，本文用全路径）。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 | 需求 |
|------|---------|------|------|
| `src/styles-gemini-extra.css` | 修改 | 删 `#bizOpReconModulePanel .cell.left > *` 平移规则（3373-3376），保留同段其它 v3.0.1 样式 | 1a |
| `src/renderer.js` | 修改 | ①需求2 模块名(66) `'对账单 ReconID 修复'`→`'对账单修复'`；②需求1b `importFlowStage`（pickFlowFile 取 filePaths、runFlowImport({date, filePaths})、状态文案 N 文件 M 行，约 5380/5392-5395） | 1b/2 |
| `src/renderer-dialogs.js` | 修改 | ①需求2 两类别 label(7553/7554)；②需求3 `createScenarioConfigDialogC4`(9096) UI（改名 + idEnabled 开关 + renderFieldValue 多行规则）；③`createDefaultScenarioConfig`(7611) 默认；④`validateScenarioDraft`(7726) idEnabled 跳过 + fieldValue 校验 | 2/3 |
| `src/main.js` | 修改 | 需求1b：`pick-flow-file`(10762-10770) 加 `multiSelections` 返回 filePaths；`run-flow`(10811-10838) 接收并校验非空数组传 worker | 1b |
| `src/main-process/biz-op-recon-session.js` | 修改 | 需求1b：`runFlowImportViaWorker`(721) + `spawnImportWorker`(569) jobMeta 带 filePaths；`runFlowImportAsync`(491) 同步 fallback 多文件合并单次 clear | 1b |
| `src/backend/biz-op-recon-import/import-worker.js` | 修改 | 需求1b：`runFlowImport`(268) 遍历 filePaths、单次 clear、累加 INSERT、聚合 errorRows；jobMeta 校验(391-397) filePath→filePaths | 1b |
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | 修改 | 需求3：新 helper `applyFieldValueOverrides`（导出供单测）；三 apply 函数 gateway 分支合并 overrides；`runC4Scenario`(1159) 入口兜底 idEnabled/fieldValue | 3 |
| `src/preload.js` | 修改（按需） | 需求1b：`bizOpRecon.pickFlowFile/runFlowImport` 若有参数白名单需放行 filePaths（透传则无需改） | 1b |
| `src/backend/usage-stats.js` | ❌ 不改 | 需求2：`FUNCTION_REGISTRY` key `'对账单 ReconID 修复'`(33) 保留（统计连续性） | 2 |
| `src/constants/gateway-bill-recon-fields.js` | 只读 | 需求3：`GATEWAY_BILL_FIELDS`/`CHANNEL_BILL_FIELDS` 字段枚举源，不改 | 3 |
| `src/backend/scenarios-bundle-io.js` | 不改 | 需求3：config 新字段自由 JSON 透传，既有先例，无需 migration/bump | 3 |
| `scripts/smoke/recon-id-fix-engine-gateway.js` | 修改 | 需求3：扩 `makeCfg` 注入 idEnabled/fieldValue，加端到端 case | 3 |
| `scripts/smoke/biz-op-recon.js` | 修改 | 需求1b：多文件合并 / 整批拒绝 / 单文件回归 case | 1b |
| `tests/unit/main-process/recon-id-fix-engine.test.js` | 修改 | 需求3：加 `applyFieldValueOverrides` 单测（不污染行 / seq 归一 / 空值赋空 / 分组过滤） | 3 |

---

## 三、需求 3：网关对账单修复「修复订单字段取值」（最复杂，资金红线，先述）

> 按实施计划顺序「需求2（最简）→ 需求1 → 需求3（最复杂）」实施；技术文档按复杂度倒序详述以便评审聚焦红线。需求3 是本迭代核心改造。

### 3.1 实现方案

在 gateway 子模式 C4 引擎（`c4-recon-id-fix.js`）现有「Reference（ID）赋值」基础上，新增「按规则把从边渠道字段值赋给主边网关字段」的能力：

- 数据结构扩 `config.output.idEnabled`（boolean，默认 true）+ `config.fieldValue`（`{enabled, rules[]}`），写入 config_json（自由 JSON）。**为何不做 migration / 不 bump bundleVersion**：config_json 是自由 JSON，`scenarios-bundle-io.js` 既有「新增可选字段旧应用忽略」先例；旧场景缺字段由 dialog 初始化 + 引擎入口 + `createDefaultScenarioConfig` 三处兜底默认。
- 引擎新增纯函数 helper `applyFieldValueOverrides(mainRow, oppRow, cfg)`，只产出新建 `overrides` 对象，**绝不触碰行对象**（R-2）；三 apply 函数 gateway 分支把它合并进现有 overrides（先 Type/Amount/Reference，再 `Object.assign` fieldValue）。
- 赋值叠加到 `fixedRows` → 走现有「导出文件」+ 14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板（目标列落在 14 列内才体现）。

**为何不复用现成赋值逻辑而新增 helper**：现有 `computeReferenceGateway`(616) 只算 Reference 单值；字段取值是「按 `_types` 分组过滤 + 多规则 + 从边任意字段→主边任意字段」的批量映射，语义不同，独立 helper 更清晰、可单测、可被三种匹配类型共用。

### 3.2 config 数据结构扩展

```js
// 新增字段（写入 scenario config_json，自由 JSON）
config.output.idEnabled        // boolean，默认 true（保持现有必填，零回归）
config.fieldValue = {
  enabled: false,              // 默认关
  rules: [
    { mainTypeSeq: Number, mainField: '', oppTypeSeq: Number, oppField: '' }
  ]
}
```

- 🔴 `mainTypeSeq` / `oppTypeSeq` **必须存 Number**（`_types` 是 `Set<Number>`，存字符串导致 `has` 恒 false → 规则静默失效，最隐蔽资金 bug）。
- 兼容缺省三处防御：
  1. **dialog 初始化**（renderer-dialogs.js:9204 后，进入 `createScenarioConfigDialogC4` 时）补 `idEnabled` / `fieldValue` 默认 + 逐条 `Number()` 归一。
  2. **引擎入口** `runC4Scenario`(1159) 浅克隆 cfg 后兜底 `idEnabled!==false`、`fieldValue={enabled:false, rules:[]}`（仿现有 `_subMode` / `_billDateDays` 注入先例）。
  3. **`createDefaultScenarioConfig`**(7611) 同步默认。

### 3.3 UI 改造（renderer-dialogs.js）

| 改动 | 位置 | 内容 |
|------|------|------|
| 文案改名 | HTML 约 9268 的 label + tooltip；校验文案约 7929 / 7934 | 「订单修复ID取值」→「修复订单ID取值」 |
| `修复订单ID取值` 开关 | 该 row label 内联 `<input data-c4-id-enabled>`（仅 gateway） | 把 `idEnabled` 纳入 `renderOutput()`：取消勾选 → 三选一 radio + commonId 子行 `disabled` + 容器加 `is-disabled` 灰显。事件绑 dialog 级（勾选框在 label span 内、非 outputEl 内）→ `renderOutput()` 重渲 |
| 新增 `修复订单字段取值` row | 仅 gateway，紧跟上面 row | label + tooltip + `<input data-c4-fv-enabled>` 开关 + `<div data-c4-field-value>` 容器 |
| 新增 `renderFieldValue()` | 仿 reconGroups fieldPair 增删模式（加入 `rerenderAll`） | 每行 = 下拉1(主分组seq) + 下拉2(`GATEWAY_BILL_FIELDS`) + 文本「取」+ 下拉3(从分组seq) + 下拉4(`CHANNEL_BILL_FIELDS`) + 行尾「新增」按钮（多行时「×」删除）。下拉1/3 枚举来自 `config.billTypes.filter(side==='main'/'opp').map(seq)`。字段常量 renderer-dialogs.js:38-39 已从 `appConstants` 取到 |
| 事件 | dialog 级委托 | `data-c4-fv-enabled` change → 重渲；`data-c4-field-value` 容器委托 change（seq 用 `Number()`）/ click（add/remove）。billType 增删/改 side 时（约 9536/9572/9614 附近 `rerenderAll`）自动刷新下拉 + 校正失效 seq（回退首个 main/opp seq） |
| **（用户修订）垂直布局** | 两个 gateway row 的 DOM 结构 | 「修复订单ID取值」「修复订单字段取值」两 row 改为**上下垂直**：第一行 = 标题（label + tooltip + `<input 启用开关>`），第二行 = 内容容器（三选一 radio / 4 下拉规则行）。原横向单行拆为「标题行 / 内容行」两层，配套 CSS（block 容器 + 标题行 flex 对齐开关靠右） |
| **（用户修订）字段取值限定 1v1** | `renderFieldValue()` + 匹配模式 radio change 联动 | 读当前匹配模式（`output.mode` / gateway 三选一）；**非「网关1v1渠道」时**：`data-c4-fv-enabled` 开关 `disabled` + 容器 `is-disabled` 灰显 + 渲染提示文案「仅"网关1v1渠道"模式可用」+ 若已 `enabled` 则置 `fieldValue.enabled=false`（自动取消）。匹配模式 radio change 时一并 `rerenderAll` 重算该联动 |

### 3.4 引擎改造（c4-recon-id-fix.js）

**D3 — 新 helper `applyFieldValueOverrides(mainRow, oppRow, cfg)`**（置于 `computeReferenceGateway`(616) 后）：

```js
// 遍历 cfg.fieldValue.rules，按分组 _types 决定生效；只写新建 overrides，绝不触碰行对象
function applyFieldValueOverrides(mainRow, oppRow, cfg) {
  const overrides = {};
  const fv = cfg && cfg.fieldValue;
  if (!fv || fv.enabled !== true || !Array.isArray(fv.rules)) return overrides;
  for (const rule of fv.rules) {
    if (!rule) continue;
    const mainSeq = Number(rule.mainTypeSeq);   // 🔴 Number 归一，防 Set<Number>.has 恒 false
    const oppSeq = Number(rule.oppTypeSeq);
    if (!mainRow._types.has(mainSeq) || !oppRow._types.has(oppSeq)) continue;  // 分组过滤
    const v = oppRow[rule.oppField];
    overrides[rule.mainField] = (v === null || v === undefined) ? '' : v;       // 空值→''，不阻断
  }
  return overrides;
}
// 需 module.exports 导出（已暴露引擎内部工具给 smoke + unit，见 module.exports 1301）
```

**三 apply 函数 gateway 分支合并 overrides**（顺序：先 Type/Amount/Reference，再 `Object.assign` fieldValue）：

| 匹配 | 函数:行 | mainRow(输出基行) | oppRow(取值源) |
|------|---------|------------------|----------------|
| 1v1 | `apply1v1Assignment`(908，赋值点约 913-921) | leftRow | rightRow |
| 1v多 | `apply1vNAssignment`(965，赋值点约 971-984) | leftRow（每笔同） | **每笔对应的 `matches[i]`（channelRow，逐笔不同）** |
| 多v1 | `applyNv1Assignment`(1033，赋值点约 1037-1046) | matches[i]（逐笔） | rightRow（共同） |

**D4 — idEnabled=false**：不把 `Reference` 放进 overrides → `buildOutputRow`(588) 取 srcRow 原值（网关账单 `Reference` 列，14 列模板成员）。语义 = 「保留原始对账号，不赋值」，比清空更安全（资金 R-4）。

**D5 —（用户修订）字段取值限定「网关1v1渠道」（引擎入口 gate，双重防御）**：

- `runC4Scenario`(1159) 入口兜底 `fieldValue` 后，**判断匹配模式**：若非「网关1v1渠道」（即 1v多 / 多v1），强制 `cfg.fieldValue.enabled = false`。
- 由此 `apply1vNAssignment`(965) / `applyNv1Assignment`(1033) 调 `applyFieldValueOverrides` 时 `fv.enabled !== true` 直接返回空 overrides（既有短路），**1v多 / 多v1 一定不做字段取值**。
- 双重防御：UI 已禁用 + 校验已拦截非 1v1 启用字段取值，引擎入口再 gate 一道（即便 config 被手工改 / bundle 导入带启用标记，也不生效），是资金红线兜底。

```js
// runC4Scenario 入口（兜底 fieldValue 之后）
if (isGwSubMode && cfg.output && cfg.output.mode !== '网关1v1渠道') {
  cfg.fieldValue = { ...(cfg.fieldValue || {}), enabled: false };  // 🔴 非 1v1 强制关闭字段取值
}
```

### 3.5 校验改造（validateScenarioDraft，7726；gateway output 段约 7900-7965）

- **idEnabled=false（仅 gateway）** → 跳过 output.mode 必填 / 1v多禁main / commonId 校验：用 `const idEnabled = !isGwSubMode || out.idEnabled !== false` 包裹约 7927-7950 段。SubBizType 块已被 `!isGwSubMode` gate，不受影响。
- **fieldValue.enabled===true（gateway）** → 校验：
  - **（用户修订）匹配模式必须 = 「网关1v1渠道」**：非 1v1 却 `fieldValue.enabled===true` → 拦截报错（与 UI 自动取消 + 引擎入口 gate 三道一致；正常经 UI 操作不会走到，作手工改 config / bundle 导入的兜底）；
  - 至少 1 条规则；每条四字段非空；
  - `mainField ∈ GATEWAY_BILL_FIELDS`、`oppField ∈ CHANNEL_BILL_FIELDS`；
  - `mainTypeSeq` 指向 `side==='main'` 的分组、`oppTypeSeq` 指向 `side==='opp'` 的分组（仿 reconGroups sideBySeq 校验，约 7904-7921）。

### 3.6 注意事项

- 🔴 `applyFieldValueOverrides` 只产出新建 `overrides`，绝不写 `mainRow`/`oppRow`（单测断言行对象未变）。
- 🔴 seq 全程 Number：UI 存盘归一 + 引擎 `Number()` 双保险 + 校验拦截，三道防线。
- 🔴 idEnabled=false → Reference 取 srcRow 原值（不清空）。
- 🔴 **（用户修订）字段取值限定「网关1v1渠道」**：UI 禁用+灰显+提示+自动取消 / 校验拦截 / 引擎入口 gate 强制 `enabled=false`，三道防御（`apply1vN`/`applyNv1` 不做字段取值）。由此「1v多 目标列 = Amount 覆盖拆账值」实际不触发（tooltip 语义说明保留）。
- **（用户修订）UI 垂直布局**：两 gateway row 标题行（label + tooltip + 启用开关）在上、内容（radio / 规则行）在下；前端改动落地后须重跑对应 `npm run preview:*`。
- business 子模式不消费 fieldValue（仅 `cfg._subMode==='gateway'` 读）。

---

## 四、需求 1：业务OP流水表批量导入 + 回滚 v3.0.1 平移

### 4.1 需求1a 回滚平移（实现方案）

删 `styles-gemini-extra.css:3373-3376`（含注释行）：

```css
/* v3.0.1 需求2：业务OP数据核对左列... 整体右移 = D/2 + 12px ... */
#bizOpReconModulePanel .cell.left > * {
  transform: translateX(85.5px);
}
```

保留同段其它 v3.0.1 样式（`.gateway-recon-picker-card` 3362+ / `.linked-table-delete-range-card` 3379）。`index.html` 面板结构、`renderer.js` 逻辑不改（纯 CSS）。

### 4.2 需求1b 流水批量导入（实现方案，🔴 资金红线）

**关键约束（已核实）**：`runFlowImport`（worker `import-worker.js:268-356`；同步 fallback `biz-op-recon-session.js:491-544`）对单个 date 的落库是「`clearRunsAndDiffsByDate(date)`(289) + `flowImportsRepository.clearByDate(date)`(290) 清空该日期跨所有 BU 旧流水 → 再 INSERT」，整个在一个事务内（`cleared` 标志 271/295 保证只清一次）。

🔴 **绝不能循环调用现有 `runFlowImport`**——否则第 2 个文件的 `clearByDate` 会清掉第 1 个文件刚插入的行，只剩最后一个文件（资金事故）。

**正确方案：单进程单事务合并多文件**

- worker `runFlowImport` 改为接收 `filePaths` 数组：`BEGIN` → 首个数据行触发 `clearByDate` **只清一次**（沿用现有 `cleared` 标志）→ 依次 `streamFlowFile` 遍历所有文件，边读边校验边 INSERT（累加）→ 任一行失败收集到聚合 `errorRows` → 全部读完后：有错 `ROLLBACK` + rejected，全通过 `COMMIT`。
- 语义：多文件合并 = 该 date 的完整流水快照（与「重导替换该 date」一致，须在状态/文档提示「批量导入会替换该日期已有流水」）。
- 业务OP 文件（`kind='bizOp'`）**不在本需求范围**，`runBizOpImport`(119) 不动。

### 4.3 改造链路（filePath 单数 → filePaths 数组）

| 层 | 文件:行 | 改动 |
|----|---------|------|
| 前端选择 | `renderer.js` `importFlowStage`（约 5380 / 5392-5395） | `pickFlowFile` 取 `filePaths`；`runFlowImport({date, filePaths})`；状态文案「导入 N 个文件共 M 行」 |
| 文件对话框 | `main.js:10762-10770` `pick-flow-file` | `properties:['openFile','multiSelections']`；返回 `filePaths` |
| 运行 handler | `main.js:10811-10838` `run-flow` | 接收 `filePaths`，校验非空数组，传 worker |
| worker 入口 | `biz-op-recon-session.js` `runFlowImportViaWorker`(721) + `spawnImportWorker`(569) | jobMeta 带 `filePaths` |
| worker 核心 | `import-worker.js` `runFlowImport`(268) + jobMeta 校验(391-397) | 遍历 filePaths，单次 clear，累加 INSERT，聚合 errorRows |
| 同步 fallback | `biz-op-recon-session.js` `runFlowImportAsync`(491) | 多文件合并后单次 clear + insert（无 dbPath 兜底路径，保持与 worker 同语义） |
| 错误报告 | `writeFlowErrorReportXlsx` 调用处 | errorRows 聚合多文件，建议标注来源文件名 |
| preload | `src/preload.js` `bizOpRecon.pickFlowFile/runFlowImport` | 若有参数白名单需放行 `filePaths`（透传则无需改） |

### 4.4 代码示例（worker 核心骨架）

```js
// import-worker.js: runFlowImport 改为 filePaths 数组（单事务、单次 clear、累加）
async function runFlowImport(db, { date, filePaths, maxRowErrors }) {
  let cleared = false;                 // 🔴 全程只清一次（首个数据行触发）
  const errorRows = [];                // 聚合多文件错误
  const insertOne = flowImportsRepository.makeRowInserter(db);
  db.exec('BEGIN');
  try {
    for (const filePath of filePaths) {              // 依次遍历所有文件
      await streamFlowFile(filePath, {
        onRow: (row, ctx) => {
          if (!cleared) {
            runRepository.clearRunsAndDiffsByDate(db, date);
            flowImportsRepository.clearByDate(db, date);   // 🔴 仅一次
            cleared = true;
          }
          // 逐行 validateFlowRow → 失败 push errorRows（标注来源文件名）→ 否则 insertOne 累加
        }
      });
    }
    if (errorRows.length) { db.exec('ROLLBACK'); /* rejected + 聚合错误报告 */ }
    else db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// jobMeta 校验(391-397)：filePath → filePaths（非空数组校验）
```

### 4.5 注意事项

- 🔴 单进程单事务合并、单次 `clearByDate`，禁止循环调用 `runFlowImport`（R-1）。
- 🔴 worker 与同步 fallback 两条路径语义必须一致（都多文件单次 clear + 累加，R-7）。
- 单文件场景（`filePaths` 长度 1）必须与现状行为完全一致（回归保护）。
- 整批拒绝语义保持（任一文件任一行失败全 ROLLBACK，不留半批）。
- 业务OP 文件（`kind='bizOp'`）不动。

---

## 五、需求 2：「对账单 ReconID 修复」模块改名「对账单修复」（最简，先做）

### 5.1 实现方案

仅改 3 处用户可见 UI 字符串，内部标识全部保留（沿用 v2.1.14「银行对账单处理→资金对账数据处理」先例，零风险、统计连续）。

### 5.2 改动点

| 文件:行 | 改动 |
|---------|------|
| `src/renderer.js:66` | `reconIdFix.name: '对账单 ReconID 修复'` → `'对账单修复'`（顶部模块切换器显示名） |
| `src/renderer-dialogs.js:7553` | `{ value: 'recon-id-fix', label: '单据对账 ReconID 修复' }` → `label: '单据对账修复'`（场景类别 label） |
| `src/renderer-dialogs.js:7554` | `{ value: 'gateway-recon-id-fix', label: '网关对账单 ReconID 修复' }` → `label: '网关对账单修复'`（场景类别 label） |

### 5.3 绝不改动（资金 / 统计连续性）

- `src/backend/usage-stats.js:33` `FUNCTION_REGISTRY` key `'对账单 ReconID 修复'`。
- `src/main.js` 中 `trackedIpcHandle('recon-id-fix:*', '对账单 ReconID 修复', ...)` 第二参（3 处，与上面 key 配对）。
- 模块 id `recon-id-fix` / scenario category `recon-id-fix` / `gateway-recon-id-fix` / DB schema CHECK 约束。

### 5.4 注意事项

- 实施时确认 `getCategoryDialogTitle`（renderer-dialogs.js:7689）及主面板其它可见文案不含「ReconID」（已知对话框标题为「新增场景/修改场景」，不受影响）。
- 注释内的「ReconID 修复」字样保留，不影响 UI。

---

## 六、资金红线汇总（提 PR / 版本 bump 前必查）

> 与 PRD §十一同步，置于技术文档显著位置。

🔴 **资金红线**

1. **需求1b**：流水批量导入**必须单进程单事务合并、单次 `clearByDate`**，禁止循环调用 `runFlowImport`（worker `import-worker.js:268` / 同步 fallback `biz-op-recon-session.js:491`）——否则文件互相覆盖丢数据。整批拒绝语义保持。
2. **需求3 - 不污染原始行**：`applyFieldValueOverrides` 只写新建 overrides，绝不触碰 `mainRow`/`oppRow`（单测断言）。
3. **需求3 - 分组 seq 全程 Number**：`mainTypeSeq`/`oppTypeSeq` 类型不符 → `Set<Number>.has` 恒 false → 规则静默失效（最隐蔽资金 bug）；UI 存盘归一 + 引擎 `Number()` + 校验拦截三道防线。
4. **需求3 - idEnabled=false 保留原值**：不把 Reference 放进 overrides → `buildOutputRow` 取网关账单 Reference 原值（不清空）。
5. **需求3（用户修订）- 字段取值限定「网关1v1渠道」**：1v多 / 多v1 模式下字段取值不可用——UI 禁用+灰显+提示+自动取消 / 校验拦截 / **引擎入口 gate 强制 `fieldValue.enabled=false`，`apply1vN`/`applyNv1` 不做字段取值（三道防御，config 残留启用标记也不生效）**。由此「1v多 目标列 = Amount 覆盖拆账值」实际不触发（tooltip 语义说明保留）。

⚠️ **兼容 / 跨子模式**：business 共用 config schema 但引擎/UI 不消费 fieldValue（仅 gateway 读）；bundle 新字段透传，旧 bundle 入口兜底默认；config_json 无需 migration、无需 bump bundleVersion。

🔴 **硬节点**：提 PR 前 / `package.json.version` bump 前必跑 `/check-vars` + `npm run scan:vars`（本迭代触及 fixedRows 输出、Reference 取值、流水导入事务等重要变量）。

---

## 七、任务分解

> 每个 task 尽量小、可验证、可独立完成。按实施计划顺序：需求2（最简）→ 需求1 → 需求3（最复杂）。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| 1 | 需求2 改名：模块名 + 2 类别 label（内部 id/统计 key/IPC 不动） | `renderer.js`、`renderer-dialogs.js` | preview（reconIdFix 相关）+ 手测模块切换器 + 类别下拉（AC2-*） | done |
| 2 | 需求1a 回滚平移：删 `#bizOpReconModulePanel .cell.left > *` CSS | `styles-gemini-extra.css` | `preview:biz-op-recon`（确认左列回位、另 3 模块与场景框样式不变）（AC1a-1） | done |
| 3 | 需求1b worker：`runFlowImport` filePaths 数组 + 单次 clear + 累加 INSERT + 聚合 errorRows + jobMeta 校验 | `import-worker.js` | 单测/smoke：多文件合并行数累加、整批 ROLLBACK（AC1b-1/2/5） | done |
| 4 | 需求1b session：`runFlowImportViaWorker`/`spawnImportWorker` jobMeta filePaths；`runFlowImportAsync` 同步 fallback 多文件单次 clear | `biz-op-recon-session.js` | 单测：同步路径与 worker 同语义（AC1b-5/7） | done |
| 5 | 需求1b handler：`pick-flow-file` 加 multiSelections；`run-flow` 校验非空数组 | `main.js`、`preload.js`（按需） | 集成/手测：多选对话框 → 合并导入（AC1b-1/4） | done |
| 6 | 需求1b 前端：`importFlowStage` 取 filePaths + 状态文案 N 文件 M 行 + 替换提示 | `renderer.js` | `preview:biz-op-recon` + 手测（AC1b-3/4） | done |
| 7 | 需求3 config + 兜底：dialog 初始化 / `createDefaultScenarioConfig` / 引擎入口 三处默认 + seq Number 归一 | `renderer-dialogs.js`、`c4-recon-id-fix.js` | 单测：旧场景缺字段加载不报错、seq 归一（AC3-11） | done |
| 8 | 需求3 引擎：`applyFieldValueOverrides` helper + 三 apply 函数合并 overrides + idEnabled=false 保留 Reference + **（用户修订）入口 gate 非 1v1 强制 `fieldValue.enabled=false`** | `c4-recon-id-fix.js` | 单测：不污染行 / 1v1·1v多·多v1 赋值 / 空值赋空 / 分组过滤 / **1v多·多v1 限定不生效**（AC3-2/4/5/6/7/8/10/14） | done |
| 9 | 需求3 UI：改名「修复订单ID取值」+ idEnabled 开关 renderOutput 灰显 + 新增「修复订单字段取值」row + `renderFieldValue()` 多行规则 + **（用户修订）垂直布局 + 非 1v1 时开关禁用/灰显/提示/自动取消** | `renderer-dialogs.js` | preview + 手测对话框（AC3-1/3/13/15） | done |
| 10 | 需求3 校验：idEnabled=false 跳过分支 + fieldValue 校验（规则非空 / 字段枚举 / side 匹配）+ **（用户修订）非 1v1 启用字段取值拦截** | `renderer-dialogs.js` | 单测/手测：缺规则/字段非法/非 1v1 启用拦截（AC3-3/13） | done |
| 11 | 测试：扩 smoke（gateway 引擎 + biz-op-recon）+ 单测（applyFieldValueOverrides） | `scripts/smoke/recon-id-fix-engine-gateway.js`、`scripts/smoke/biz-op-recon.js`、`tests/unit/main-process/recon-id-fix-engine.test.js` | `npm run release-check` 全绿（AC1b-*/AC3-*/AC3-12） | done |
| 12 | 文档三件套 + 本迭代实施记录（发版前统一更新） | CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE / `docs/iterations/v3.0.2/` | 发版前 | done |

> 🔴 task 3/4/8 触及流水导入事务 + fixedRows 输出 + Reference 取值（资金红线）——**提 PR 前必跑 `/check-vars` + `npm run scan:vars`**（项目硬节点）。

---

## 八、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `fix(v3.0.2/对账单修复): 模块名+场景类别 label 去 ReconID（内部标识不动）` | `renderer.js`、`renderer-dialogs.js` | 2 |
| 2 | `style(v3.0.2/业务OP): 回滚 v3.0.1 左列右移平移规则` | `styles-gemini-extra.css` | 1a |
| 3 | `feat(v3.0.2/业务OP): 流水导入 worker 支持 filePaths 多文件单事务合并+单次 clear` | `import-worker.js` | 1b |
| 4 | `feat(v3.0.2/业务OP): session worker 入口+同步 fallback 多文件合并语义对齐` | `biz-op-recon-session.js` | 1b |
| 5 | `feat(v3.0.2/业务OP): pick-flow-file 多选+run-flow 数组校验` | `main.js`、`preload.js` | 1b |
| 6 | `feat(v3.0.2/业务OP): importFlowStage 多文件选择+N 文件 M 行状态` | `renderer.js` | 1b |
| 7 | `feat(v3.0.2/网关修复): config idEnabled/fieldValue 三处兜底默认+seq Number 归一` | `renderer-dialogs.js`、`c4-recon-id-fix.js` | 3 |
| 8 | `feat(v3.0.2/网关修复): applyFieldValueOverrides 引擎赋值（不污染行）+三 apply 合并+idEnabled 保留原值` | `c4-recon-id-fix.js` | 3 |
| 9 | `feat(v3.0.2/网关修复): 修复订单ID取值开关+修复订单字段取值多行规则 UI` | `renderer-dialogs.js` | 3 |
| 10 | `feat(v3.0.2/网关修复): validateScenarioDraft idEnabled 跳过+fieldValue 校验` | `renderer-dialogs.js` | 3 |
| 11 | `test(v3.0.2): smoke 引擎/批量导入 + applyFieldValueOverrides 单测` | smoke、unit | 1b/3 |
| 12 | `docs(v3.0.2): 三件套 + 实施记录` | 三件套、iterations | 全部 |

> commit 不加 AI 署名（项目约定）。一 task 一 commit。

---

## 九、测试方案

### 9.1 需求3 引擎（先红后绿）

扩 `scripts/smoke/recon-id-fix-engine-gateway.js`（现有 gateway 端到端，扩 `makeCfg` 注入 `output.idEnabled`/`fieldValue`）：

- 回归基线（默认 idEnabled=true / fieldValue 关，现有 cases 全绿）
- idEnabled=false → Reference 取网关账单原值（非空串）
- fieldValue 1v1 / 1v多（逐笔 channelRow）/ 多v1（共同 rightRow）赋值正确
- 目标列超 14 列模板 → 导出不体现且不报错
- 规则按 `_types` 分组过滤
- idEnabled=false + fieldValue 同时启用（独立开关）
- 旧场景（无新字段）兼容

单测 `tests/unit/main-process/recon-id-fix-engine.test.js` 加 `applyFieldValueOverrides`：

- 🔴 断言调用后 `mainRow`/`oppRow` 字段未变（不污染原始行）
- seq 字符串 → Number 归一命中
- 空值（`null`/`undefined`）赋空串
- 分组过滤（不命中分组的行不赋值）

### 9.2 需求1b 批量导入

扩 `scripts/smoke/biz-op-recon.js`：

- 多文件合并到同一 date（单次 clear，累加行数 = 各文件之和）
- 多文件任一行校验失败 → 整批拒绝（聚合错误报告）
- 单文件回归与现状一致

### 9.3 需求2 改名

`npm run preview:*`（reconIdFix 相关 preview 截图）确认显示名；手动验证模块切换器 + 场景类别下拉。

### 9.4 整体

`npm run release-check`（unit + integration + smoke）必须全绿；前端改动重跑对应 `npm run preview:*`（见 memory「前端改造必须回归 previews」）。Electron 手动验证（`/run`）：新建 gateway 场景配规则 → 导入 → 跑对账 → 看订单修复导出体现赋值 + idEnabled 开关行为；业务OP 多选流水文件导入。

---

## 十、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识（由 dev 实施时追加）。

### 2026-06-10

- 动作：PM 依据已批准实施计划 `~/.claude/plans/3-0-2-1-op-3-0-1-immutable-flask.md` 产出 PRD + 本 TechDoc（未写代码）。核对全部引用行号/函数名与当前工作树一致（`classifyRows`(97)/`buildOutputRow`(588)/`computeReferenceGateway`(616)/三 apply(908/965/1033)/`runC4Scenario`(1159)/`runFlowImport`(268, clear 289-290, jobMeta 391-397)/CSS 平移(3373-3376)/模块名(66)/类别 label(7553/7554)/统计 key(33)）。
- 证据：字段常量源 `src/constants/gateway-bill-recon-fields.js` 存在（`GATEWAY_BILL_FIELDS`/`CHANNEL_BILL_FIELDS`）；smoke/unit 测试文件均存在；`c4-recon-id-fix.js` `module.exports`(1301) 已暴露引擎内部工具给 smoke+unit（`applyFieldValueOverrides` 可加入导出）；`runC4Scenario` 已有 `_subMode`/`_billDateDays` 注入先例可仿照兜底。
- 风险：需求1b（流水批量导入单事务合并）+ 需求3（不污染行 / seq Number / idEnabled 保留原值）为资金红线，实施前必读 §一 1.2 + §六；提 PR / 版本 bump 前必跑 `/check-vars` + `npm run scan:vars`。
- 决策：3 项需求一并发 v3.0.2（实施计划已批准）；config 新字段无需 migration / 不 bump bundleVersion（自由 JSON + 既有先例）。

### 2026-06-10（实施完成 + 用户修订 reverse-sync）

- 动作：3 项需求经 team-lead 拆 12 task 委托 dev 逐 task 实施、逐 task `release-check` 验收全绿（team-lead 自审 diff + 自跑测试兜底）。需求3 落地后用户追加两条修订并 reverse-sync 回 PRD/TechDoc：①「修复订单字段取值」限定「网关1v1渠道」模式；② 两功能区改垂直布局。
- 证据：质量门末态 **unit 2085 / integration 19 脚本（1011 断言）/ smoke 全过**；测试扩建——`recon-id-fix-engine-gateway.js` 20 case（含 1v多/多v1 限定不生效）、`applyFieldValueOverrides` 单测（不污染行/seq 归一/分组过滤/空值）、`biz-op-recon.js` 多文件合并/整批拒绝/单文件回归。
- 风险：需求1b（单事务合并）+ 需求3（不污染行 / seq Number / idEnabled 保留原值 / 字段取值限定 1v1 三道防御）资金红线均落地；提 PR / 版本 bump 前 `/check-vars` + `npm run scan:vars`。
- 决策：字段取值限定 1v1 采「UI 禁用 + 校验拦截 + 引擎入口 gate」三道防御（最末一道兜手工改 config / bundle 导入）；详见 §三 3.3/3.4 D5/3.5 + §十二实施记录。

### 可沉淀知识

- [ ] 「`Set<Number>.has` 误存字符串导致规则静默失效」是对账类配置的通用坑点，值得入 `knowledge/`（seq/枚举类配置须存盘归一 + 引擎归一双保险）。
- [ ] 「多文件合并单事务、单次 clear」与「逐文件覆盖」的语义陷阱，值得入 `knowledge/`（凡是「清+插」事务被循环调用都有互相覆盖风险）。

---

## 十一、Open Technical Questions

- OPEN-T1：需求1b 多选导入是否需补 `preview:biz-op-recon` 的多文件 fixture——现疑无（preview 主要验布局），实施 task 6 时确认。✅ 收口：走默认 `preview:biz-op-recon`，未新增 fixture。
- OPEN-T2：需求1b 聚合错误报告的「来源文件名」标注列名/格式——实施时按 `writeFlowErrorReportXlsx` 现有列结构补充，若需新增列再定。✅ 收口：聚合错误报告按来源文件名标注。
- OPEN-T3：需求3 `renderFieldValue()` 下拉1/3 的 seq 显示文案——用 `config.billTypes` 的 seq 还是带账单类型名称，实施 task 9 时按 reconGroups 现有范式对齐。✅ 收口：按 reconGroups 现有范式对齐。

---

## 十二、实施记录

> 2026-06-10 收口：3 项需求经 team-lead 拆 12 task 委托 dev 逐 task 实施、逐 task `release-check` 验收全绿（team-lead 自审 diff + 自跑测试兜底）。需求3 含本轮用户修订「限定网关1v1渠道」+「UI 垂直布局」，已 reverse-sync 回 §三 3.3/3.4 D5/3.5 + §一 1.2 R-8 + §六 + §七 task 8/9/10 + §十实施日志。质量门末态 **unit 2085 / integration 19 脚本（1011 断言）/ smoke 全过**。

### 12.1 最终落地文件清单

| 文件 | 改动类型 | 需求 | 落地概要 |
|------|---------|------|---------|
| `src/styles-gemini-extra.css` | 删 | 1a | 删 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px); }`（含注释），左列回位；同段 `.gateway-recon-picker-card`/`.linked-table-delete-range-card` 保留 |
| `src/backend/biz-op-recon-import/import-worker.js` | 改 | 1b | `runFlowImport` 收 `filePaths` 数组：单事务遍历所有文件、🔴 单次 `clearByDate`、累加 INSERT、聚合 errorRows（标来源文件名）、有错全 ROLLBACK；jobMeta 校验 `filePath`→`filePaths` |
| `src/main-process/biz-op-recon-session.js` | 改 | 1b | `runFlowImportViaWorker`/`spawnImportWorker` jobMeta 带 `filePaths`；同步 fallback `runFlowImportAsync` 多文件合并、单次 clear，与 worker 同语义 |
| `src/main.js` | 改 | 1b | `pick-flow-file` 加 `multiSelections` 返回 `filePaths`；`run-flow` 校验非空数组 |
| `src/renderer.js` | 改 | 1b/2 | ①`importFlowStage` 取 `filePaths` + 状态「导入 N 个文件共 M 行」+「会替换该日期已有流水」；②需求2 模块名 `'对账单 ReconID 修复'`→`'对账单修复'` |
| `src/preload.js` | 改 | 1b | `bizOpRecon.pickFlowFile`/`runFlowImport` 放行 `filePaths`（透传） |
| `src/renderer-dialogs.js` | 改 | 2/3 | ①需求2 两类别 label 去 ReconID；②需求3 `createScenarioConfigDialogC4`：改名「修复订单ID取值」+ idEnabled 开关灰显联动、新增「修复订单字段取值」row + `renderFieldValue()` 多行规则、**（用户修订）垂直布局 + 非 1v1 时开关禁用/灰显/提示/自动取消**；`createDefaultScenarioConfig` 默认；`validateScenarioDraft` idEnabled 跳过 + fieldValue 校验 + **（用户修订）非 1v1 启用拦截** |
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | 改 | 3 | 新 helper `applyFieldValueOverrides`（导出供单测，🔴 不污染行 + seq `Number()` 归一 + 空值→`''`）；三 apply 函数 gateway 分支合并 overrides；`runC4Scenario` 入口兜底 idEnabled/fieldValue + **（用户修订）非 1v1 强制 `fieldValue.enabled=false`（D5 双重防御）**；idEnabled=false 不放 Reference 进 overrides（取 srcRow 原值） |
| `src/backend/usage-stats.js` | ❌ 不改 | 2 | `FUNCTION_REGISTRY` key `'对账单 ReconID 修复'` 保留（统计连续） |
| `src/constants/gateway-bill-recon-fields.js` | 只读 | 3 | `GATEWAY_BILL_FIELDS`/`CHANNEL_BILL_FIELDS` 未改 |
| `src/backend/scenarios-bundle-io.js` | 不改 | 3 | config 新字段自由 JSON 透传，无 migration / 不 bump bundleVersion |
| `scripts/smoke/recon-id-fix-engine-gateway.js` | 改 | 3 | 扩到 20 case（idEnabled 开关 / fieldValue 1v1 生效 / **1v多·多v1 限定不生效** / 超 14 列不体现 / 旧场景兼容） |
| `tests/unit/main-process/recon-id-fix-engine.test.js` | 改 | 3 | 新增 `applyFieldValueOverrides` 单测（不污染行 / seq 归一 / 分组过滤 / 空值） |
| `scripts/smoke/biz-op-recon.js` | 改 | 1b | 扩多文件合并（单次 clear、行数累加）/ 整批拒绝（聚合错误报告）/ 单文件回归 |

### 12.2 资金红线落地核实

- 🔴 需求1b：worker / 同步 fallback 两条路径均单事务合并、单次 `clearByDate`，**绝不循环调用 `runFlowImport`**；任一文件任一行失败整批拒绝（全 ROLLBACK 不留半批）；单文件零回归；`kind='bizOp'` 未动。
- 🔴 需求3：`applyFieldValueOverrides` 只写新建 overrides 不污染 `mainRow`/`oppRow`（单测断言）；分组 seq 全程 Number（UI 归一 + 引擎 `Number()` + 校验，三道防线）；idEnabled=false → Reference 取 srcRow 原值（不清空）。
- 🔴（用户修订）需求3 字段取值限定「网关1v1渠道」：UI 禁用+灰显+提示+自动取消 + 校验拦截 + 引擎入口 gate 强制 `fieldValue.enabled=false`，三道防御。
- 🔴 硬节点：提 PR / 版本 bump 前 `npm run scan:vars` + `/check-vars`（触及 fixedRows 输出 / Reference 取值 / 流水导入事务等重要变量）。

### 12.3 收口

- config 新字段无需 DB migration、不 bump bundleVersion（自由 JSON + `scenarios-bundle-io.js` 既有先例），旧场景缺省 `idEnabled=启用`/`fieldValue=关` 零回归。
- 前端改动（需求 1a/1b 前端 / 需求2 / 需求3 dialog）重跑对应 `npm run preview:*`。
- 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）已同步更新 v3.0.2 条目（含需求3 用户修订）。

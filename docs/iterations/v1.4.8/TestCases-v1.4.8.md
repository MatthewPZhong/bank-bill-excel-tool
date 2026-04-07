# 测试用例文档 - 网银账单小助手 v1.4.8

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.8 |
| 日期 | 2026-04-07 |
| 状态 | 待评审 |
| 作者 | Tester |
| 关联 PRD | docs/iterations/v1.4.8/PRD-v1.4.8.md（已定稿 2026-04-07） |
| 关联技术文档 | docs/iterations/v1.4.8/TechDoc-v1.4.8.md（已定稿 2026-04-07） |
| 涉及常量 | `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD = '按字段区分发生额'`、`AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION = '是'`、`SUPPORTED_BUNDLE_VERSION = 2` |

---

## 一、测试范围总览

| 区域 | 描述 | 用例数 |
|------|------|--------|
| A | UI 行为：新行、下拉框、按钮显隐、互斥 disabled | 13 |
| B | 弹框交互 + 校验 | 14 |
| C | 导入匹配规则 — 字面值模式 | 9 |
| D | 导入匹配规则 — 正则模式 | 9 |
| E | 导入 Credit/Debit 双规则生效 | 12 |
| F | 三模式互斥（保存层 + 回归） | 5 |
| G | 持久化 + 向后兼容 | 7 |
| H | Bundle 导出 / 导入（含 bundleVersion） | 6 |
| I | 联动 + 粒度 | 4 |
| J | 回归 | 5 |
| K | 错误处理边界 | 3 |
| **合计** | | **87** |

| 测试类型分布 | 数量 |
|---|---|
| 功能 | 58 |
| 边界 | 13 |
| 兼容 | 6 |
| 回归 | 8 |
| 性能 | 2 |

| 优先级分布 | 数量 |
|---|---|
| P0 | 30 |
| P1 | 41 |
| P2 | 16 |

---

## 二、测试环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | macOS / Windows |
| 应用版本 | v1.4.8 |
| 数据库 | SQLite，需经过 `ensureAmountSplitRulesSupport` 迁移 |
| 测试模板 | 至少 4 个模板（详见第三节） |
| 测试数据 | xlsx / xls / csv 三种格式覆盖 |
| 工具 | DevTools（DOM/Console 检查）、SQLite 客户端（直连查 `template_amount_split_rules` 表） |
| 旧数据 | 至少 1 个 v1.4.7 及以下创建的旧模板，用于 AC1-17 / AC1-21 兼容性测试 |

---

## 三、测试数据准备

### 3.1 测试模板

**模板 T1 — 单金额列 + 类型列（场景 A）：**
- `template.headers` = `['DATE', 'AMOUNT', 'TXN_TYPE', 'DESCRIPTION']`
- 用于配置规则：`TXN_TYPE = C → AMOUNT 入 Credit`、`TXN_TYPE = D → AMOUNT 入 Debit`

**模板 T2 — 双金额列 + 类型列（场景 B）：**
- `template.headers` = `['DATE', 'AMOUNT1', 'AMOUNT2', 'TXN_TYPE', 'REMARK']`
- 用于配置规则：`TXN_TYPE = Credit → AMOUNT1 入 Credit`、`TXN_TYPE = Debit → AMOUNT2 入 Debit`

**模板 T3 — 旧模板（v1.4.7 及以下创建）：**
- 不含「按字段区分发生额」配置
- DB 中无 `template_amount_split_rules` 行
- 用于 AC1-17 兼容性

**模板 T4 — 已配置直接映射的模板：**
- `Credit Amount` / `Debit Amount` 已经分别映射到独立列
- 用于互斥校验回归

### 3.2 测试 CSV / XLSX

**文件 F1（场景 A，匹配充分）：** 列 `DATE, AMOUNT, TXN_TYPE, DESCRIPTION`，10 行数据，5 行 `TXN_TYPE = C`，5 行 `TXN_TYPE = D`。

**文件 F2（场景 B，匹配充分）：** 列 `DATE, AMOUNT1, AMOUNT2, TXN_TYPE, REMARK`，10 行数据，混合 `Credit` / `Debit`。

**文件 F3（全部未命中，可作为 TC1-52 系列中 file1.csv / file2.csv 的参考结构）：** 列 `DATE, AMOUNT, TXN_TYPE, DESCRIPTION`，10 行 `TXN_TYPE = X`（既不命中 `C` 也不命中 `D`）。多文件场景准备 2~3 个相同结构的文件（filename 不同，行内容可同）以执行 TC1-52 / TC1-52a / TC1-52b。

**文件 F4（缺条件字段列）：** 列 `DATE, AMOUNT, DESCRIPTION`（无 `TXN_TYPE`）。

**文件 F5（缺目标字段列）：** 列 `DATE, TXN_TYPE, DESCRIPTION`（无 `AMOUNT`）。

**文件 F6（条件字段值含首尾空格）：** 列同 F1，部分行 `TXN_TYPE = '  C  '` / `'  D  '`。

**文件 F7（大小写边界）：** 列同 F1，部分行 `TXN_TYPE = 'c'` / `'d'`（小写）。

**文件 F8（数字边界）：** 列同 F1，部分行 `TXN_TYPE = '1.0'` 部分行 `'1'`。

**文件 F9（含正则匹配数据）：** 列同 F1，`TXN_TYPE` 取值 `C`、`CR`、`Credit`、`D`、`Debit` 混合。

**文件 F10（性能用，1000+ 行）：** 列同 F1，1500 行交易数据。

### 3.3 测试 Bundle JSON

**Bundle B1（v1.4.7 旧 bundle）：** 顶层无 `bundleVersion` 字段，模板 entry 无 `amountSplitRules`。

**Bundle B2（v1.4.8 自身导出）：** 顶层 `bundleVersion = 2`，含 `amountSplitRules`。

**Bundle B3（人为伪造高版本）：** 顶层 `bundleVersion = 99`，其它结构同 B2。

---

## 四、测试用例

### A. UI 行为（13 cases）

#### TC1-1 「按字段区分发生额」行存在于映射关系管理对话框

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-1 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 已导入 |
| 测试步骤 | 1. 打开映射关系管理对话框（`createMappingDialog`） |
| 预期结果 | 在「映射关系设置」分组中存在一行新的配置项，左侧标签文本为 `按字段区分发生额` |
| 验证要点 | DOM 中存在 `<tr>` 包含 `<td>按字段区分发生额</td>`；位置在 `ADVANCED_MAPPING_FIELDS` 末尾（即位于「按正负号拆分的发生额」「根据发生额做映射的户名」「根据发生额做映射的账户号」之后） |

#### TC1-2 新行下拉框使用同款 .mapping-select 控件

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-2 |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 同 TC1-1 |
| 测试步骤 | 1. 检查新行右侧下拉框 DOM |
| 预期结果 | 控件类型为 `<select class="mapping-select">`，与其它映射设置行视觉一致 |

#### TC1-3 下拉框包含两个选项：空白与「是」

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-3 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 同 TC1-1 |
| 测试步骤 | 1. 点开新行下拉框，统计选项 |
| 预期结果 | 共 2 个 `<option>`：第 1 个 `value=""`（空白），第 2 个 `value="是"`；不含其它选项 |

#### TC1-4 下拉框默认值为空白

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-4 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板从未配置过该字段 |
| 测试步骤 | 1. 打开映射关系管理对话框<br>2. 检查新行下拉框默认值 |
| 预期结果 | `select.value === ''`，下拉框显示为空 |

#### TC1-5 空白时按钮隐藏

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-5 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 同 TC1-4 |
| 测试步骤 | 1. 检查新行右侧 |
| 预期结果 | 不存在可见的「发生额映射关系管理」按钮（DOM 中存在但 `hidden` 属性为 true，或不可见） |

#### TC1-6 选「是」后按钮立即出现

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-6 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 已导入 |
| 测试步骤 | 1. 打开映射关系管理对话框<br>2. 在新行下拉框中选择「是」 |
| 预期结果 | 下拉框右侧立即出现「发生额映射关系管理」按钮（同行渲染、`mapping-amount-split-manage-btn`、`hidden=false`） |

#### TC1-7 切回空白时按钮隐藏

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-7 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 已选「是」 |
| 测试步骤 | 1. 将下拉框切回空白 |
| 预期结果 | 「发生额映射关系管理」按钮立即隐藏 |

#### TC1-8 选「是」时三行被自动清空 + disabled + tooltip

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-22 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T4（已配过 Credit Amount / Debit Amount 直接映射），且「按正负号拆分的发生额」也有非空值 |
| 测试步骤 | 1. 打开映射关系管理对话框<br>2. 将新行下拉框切到「是」 |
| 预期结果 | `Credit Amount` / `Debit Amount` / `按正负号拆分的发生额` 三行：<br>① `select.value === ''`；<br>② `select.disabled === true`；<br>③ `select.title === '已开启"按字段区分发生额"，本字段不可用'`；<br>④ `<tr>` class 包含 `mapping-row-mutex-disabled` |

#### TC1-9 切回空白时三行 disabled 解除（值不恢复）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-23 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 已经历过 TC1-8（三行被清空 + disabled） |
| 测试步骤 | 1. 将新行下拉框切回空白 |
| 预期结果 | 三行 `select.disabled === false`，`title` 清空，class 不再含 `mapping-row-mutex-disabled`；但 `select.value` 仍然为 `''`（不恢复 TC1-8 之前的值） |

#### TC1-10 点击按钮弹出「发生额映射关系管理」对话框

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-8 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 已选「是」 |
| 测试步骤 | 1. 点击「发生额映射关系管理」按钮 |
| 预期结果 | 弹出 `createAmountSplitRulesDialog` 对话框（`.amount-split-rules-card`），覆盖在外层映射对话框之上 |

#### TC1-11 弹框标题与「完成」按钮位置

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-9, AC1-10 |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 弹框已打开 |
| 测试步骤 | 1. 检查弹框标题位置<br>2. 检查「完成」按钮位置 |
| 预期结果 | 左上角显示标题 `发生额映射关系管理`（无副标题）；右下角显示 `<button data-action="done">完成</button>` |

#### TC1-12 弹框主体显示固定 2 行规则文本

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-11, AC1-30 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 弹框已打开，模板 T1 |
| 测试步骤 | 1. 检查 `.amount-split-rules-body` 内容 |
| 预期结果 | 两个 `.amount-split-rule-row`：<br>第 1 行包含 `当 [select1] 的值为 [input1] 时， [select2] 映射为 Credit Amount` <br>第 2 行包含 `当 [select3] 的值为 [input2] 时， [select4] 映射为 Debit Amount`<br>无新增 / 删除规则按钮，固定 2 行；"映射为 Credit Amount" / "映射为 Debit Amount" 文案不可编辑 |

#### TC1-13 4 个下拉框选项 = template.headers，排除特殊枚举

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-12 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1，`template.headers = ['DATE', 'AMOUNT', 'TXN_TYPE', 'DESCRIPTION']` |
| 测试步骤 | 1. 打开弹框<br>2. 点开 4 个下拉框，统计选项 |
| 预期结果 | 每个下拉框均含 5 个 `<option>`：1 个空白选项 + 4 个 header 选项（`DATE`/`AMOUNT`/`TXN_TYPE`/`DESCRIPTION`）；**不包含** `自己输入`（`MERCHANT_ID_SELF_INPUT_OPTION`）和 `需要拼接字段`（`CONCAT_FIELDS_MAPPING_FIELD`） |

---

### B. 弹框交互 + 校验（14 cases）

#### TC1-14 点「完成」直接落库

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-14 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1，弹框打开 |
| 测试步骤 | 1. 第 1 行：条件字段 `TXN_TYPE`，条件值 `C`，目标字段 `AMOUNT`<br>2. 第 2 行：条件字段 `TXN_TYPE`，条件值 `D`，目标字段 `AMOUNT`<br>3. 点「完成」 |
| 预期结果 | 弹框关闭；DB 中 `template_amount_split_rules` 表存在 2 行数据：`row_index=0, target_field='Credit Amount', condition_field='TXN_TYPE', condition_value='C', mapped_field='AMOUNT'` 和 `row_index=1, target_field='Debit Amount', condition_field='TXN_TYPE', condition_value='D', mapped_field='AMOUNT'`；通过 `template:save-amount-split-rules` IPC 落库（不依赖外层「完成」） |

#### TC1-15 校验：条件字段未选

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-14 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 任一行的条件字段下拉框留空白<br>2. 其它字段填写完整<br>3. 点「完成」 |
| 预期结果 | 弹错误提示（`createAlertDialog`）：`请为两行规则分别选择条件字段`；用户点确认后弹框保持打开，已填字段不丢失 |

#### TC1-16 校验：目标字段未选

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-14 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 任一行的目标字段下拉框留空白<br>2. 其它字段填写完整<br>3. 点「完成」 |
| 预期结果 | 弹错误提示：`请为两行规则分别选择目标字段`；弹框保持打开，已填字段不丢失 |

#### TC1-17 校验：条件值输入框为空

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-28 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 任一行的条件值输入框留空（或仅含空白字符）<br>2. 其它字段填写完整<br>3. 点「完成」 |
| 预期结果 | 弹错误提示：`请填写条件值`；弹框保持打开，已填字段不丢失 |

#### TC1-18 校验：同行条件字段 == 目标字段

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-26 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 第 1 行：条件字段 `AMOUNT`，目标字段 `AMOUNT`<br>2. 其它字段填写完整<br>3. 点「完成」 |
| 预期结果 | 弹错误提示：`条件字段与目标字段不能相同`；弹框保持打开，已填字段不丢失 |

#### TC1-19 校验：正则语法错误

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29b |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 第 1 行：条件值 `/[/`（无效正则）<br>2. 其它字段填写完整<br>3. 点「完成」 |
| 预期结果 | 弹错误提示：`正则表达式语法错误`；弹框保持打开，已填字段不丢失 |
| 验证要点 | renderer 侧 `parseRegexLiteral`（与 main 侧 `compileRegexLiteral` 保持同步）抛 `Invalid regex literal` 或 `new RegExp` 抛 `SyntaxError` |

#### TC1-20 校验失败弹框保持打开 + 字段不丢失

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-14 |
| 类型 | 边界 |
| 优先级 | P0 |
| 前置条件 | 弹框打开，已填部分字段 |
| 测试步骤 | 1. 第 1 行：条件字段 `TXN_TYPE`，条件值 `C`，目标字段留空<br>2. 第 2 行：填写完整<br>3. 点「完成」<br>4. 弹错误后点确认 |
| 预期结果 | 错误弹框关闭后，重新进入「发生额映射关系管理」弹框，第 1 行的 `TXN_TYPE` / `C` 仍在原位，第 2 行所有值仍在原位 |
| 备注 | 实现细节：renderer 通过 `showError(message, currentDraft)` 在 `onConfirm` 中重新打开 `createAmountSplitRulesDialog`，传入 `draftRules: currentDraft` |

#### TC1-21 跨行可同字段（两行都用 TXN_TYPE 做条件）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-27 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 |
| 测试步骤 | 1. 第 1 行：条件字段 `TXN_TYPE`，条件值 `C`，目标字段 `AMOUNT`<br>2. 第 2 行：条件字段 `TXN_TYPE`，条件值 `D`，目标字段 `AMOUNT`<br>3. 点「完成」 |
| 预期结果 | 校验通过、落库成功；DB 中两行 `condition_field='TXN_TYPE'` 共存 |

#### TC1-22 跨行可同字段（两行都用 AMOUNT 做目标）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-27 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 |
| 测试步骤 | 1. 第 1 行：条件字段 `TXN_TYPE`，条件值 `C`，目标字段 `AMOUNT`<br>2. 第 2 行：条件字段 `DESCRIPTION`，条件值 `Debit`，目标字段 `AMOUNT`<br>3. 点「完成」 |
| 预期结果 | 校验通过、落库成功；DB 中两行 `mapped_field='AMOUNT'` 共存 |

#### TC1-23 外层 Credit/Debit 互斥：保存层互斥校验拦截

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-25 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T4（已配 Credit Amount / Debit Amount 直接映射），DevTools 直接构造一个绕过 UI 互斥的 payload |
| 测试步骤 | 1. 通过 DevTools 调用 `desktopApi.templates.saveMappings({ ..., mappings: [...含 Credit Amount 直接映射 + 按字段区分发生额=是...] })` |
| 预期结果 | IPC 返回错误结果：message = `「按字段区分发生额」与 Credit Amount / Debit Amount 直接映射、按正负号拆分的发生额三者不能同时设置`；DB 不会被修改 |
| 验证要点 | 由 `validateTemplateConfiguration` 中新增的"三方互斥"校验抛 `FileValidationError` |

#### TC1-24 「开关 = 是 但 rules 表为空」一致性校验

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-28b |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1，`template_amount_split_rules` 表为空（未配过弹框） |
| 测试步骤 | 1. 打开「映射关系管理」对话框<br>2. 在外层映射对话框中将「按字段区分发生额」选为「是」<br>3. **不打开「发生额映射关系管理」弹框**，直接点外层「映射关系管理」对话框的「完成」按钮 |
| 预期结果 | 保存报错：`请先在"发生额映射关系管理"中配置完整的两行规则`（errorCode = `AMOUNT_SPLIT_RULES_MISSING`）；外层对话框保持打开；DB 中开关行不被写入 |
| 备注 | Q-T2 决策（2026-04-07）：采纳 Dev 在 TechDoc §5.1.3 偷加的"开关-规则一致性"校验，PM 已补到 PRD §3.2.2 新增 AC1-28b。触发时机：保存外层「映射关系管理」对话框时，由 `template:save-mappings` handler 在 `database.saveMappings` 之前调 `database.getAmountSplitRules` 校验 |

#### TC1-25 弹框打开时回显之前保存的配置

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-16 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 已通过 TC1-14 落库两行规则 |
| 测试步骤 | 1. 关闭对话框<br>2. 重新打开映射关系管理对话框<br>3. 选「是」并点「发生额映射关系管理」按钮 |
| 预期结果 | 弹框 4 个下拉框分别回显 `TXN_TYPE`/`AMOUNT`/`TXN_TYPE`/`AMOUNT`，2 个输入框分别回显 `C`/`D` |
| 验证要点 | 数据来自 `template:get-mappings` 返回值的 `amountSplitRules` 字段（也可通过 `template:get-amount-split-rules` 单独获取） |

#### TC1-26 弹框点 X 关闭 — 返回外层映射对话框

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-14 |
| 类型 | 边界 |
| 优先级 | P2 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 点弹框右上角 `×` 关闭按钮 |
| 预期结果 | 弹框关闭，外层映射对话框被重新挂载（含外层 mappings / bigAccounts / fixedAssignments / amountSplitRules 草稿） |

#### TC1-27 弹框文本输入框接受 trim 处理

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 第 1 行条件值输入 `  C  `（带前后空格）<br>2. 其它字段填齐<br>3. 点「完成」 |
| 预期结果 | DB 中 `condition_value` 为 `C`（已 trim）；通过 `validateAmountSplitRulesPayload` 中的 `normalizeCell` 处理 |

---

### C. 导入匹配规则 — 字面值模式（9 cases）

#### TC1-28 字面值整串精确匹配

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `condition_value = 'C'`，文件 F1 含一行 `TXN_TYPE = 'C'` |
| 测试步骤 | 1. 导入 F1 |
| 预期结果 | 该行命中 Credit 规则，Credit Amount 列写入对应 `AMOUNT` 值 |

#### TC1-29 字面值不匹配前缀

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 边界 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `condition_value = 'C'`，文件含一行 `TXN_TYPE = 'CR'` |
| 测试步骤 | 1. 导入文件 |
| 预期结果 | 该行不命中（`'CR' !== 'C'`）；Credit Amount 列为空 |

#### TC1-30 字面值大小写敏感

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 边界 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `condition_value = 'C'`，文件 F7 含一行 `TXN_TYPE = 'c'` |
| 测试步骤 | 1. 导入 F7 |
| 预期结果 | 该行不命中（`'c' !== 'C'`）；Credit Amount 列为空 |

#### TC1-31 源字段先 trim 后比较

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `condition_value = 'C'`，文件 F6 含一行 `TXN_TYPE = '  C  '` |
| 测试步骤 | 1. 导入 F6 |
| 预期结果 | 该行命中（先 trim 后 `'C' === 'C'`）；Credit Amount 列写入 |
| 验证要点 | 验证 `matchAmountSplitConditionValue` 函数对源字段调 `String(...).trim()` |

#### TC1-32 数字不归一化（1.0 != 1）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `condition_value = '1'`，文件 F8 含一行 `TXN_TYPE = '1.0'` |
| 测试步骤 | 1. 导入 F8 |
| 预期结果 | 该行不命中（`'1.0' !== '1'`，字符串严格比较） |

#### TC1-33 空值不允许保存（边界）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-28 |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 任一行 condition_value 留空<br>2. 点「完成」 |
| 预期结果 | 同 TC1-17，弹错 `请填写条件值`，不落库 |

#### TC1-34 单字符与长字符匹配

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 边界 |
| 优先级 | P2 |
| 前置条件 | 模板 T1 |
| 测试步骤 | 1. 配置 `condition_value = 'X'`（单字符）<br>2. 配置 `condition_value = 'NORMAL_TRANSFER_OUTGOING'`（长字符）<br>3. 各导入相应文件 |
| 预期结果 | 单字符和长字符均按字面值精确匹配执行 |

#### TC1-35 含特殊字符（非正则触发字符）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29 |
| 类型 | 边界 |
| 优先级 | P2 |
| 前置条件 | 模板 T1 |
| 测试步骤 | 1. 配置 `condition_value = 'C-1'` 或 `'A.B'`（含 `-` `.` 等正则元字符但不以 `/` 开头）<br>2. 导入数据中含相同字面值的行 |
| 预期结果 | 走字面值精确匹配（`isRegexLiteral('C-1') === false`），命中 |

#### TC1-36 字面值含 `/` 开头但不是正则（语法限制说明）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29, AC1-29a |
| 类型 | 边界 |
| 优先级 | P2 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 配置 `condition_value = '/foo/'`（试图当字面值匹配源字段值就是 `/foo/`）<br>2. 点「完成」 |
| 预期结果 | 因匹配 `REGEX_LITERAL_PATTERN = /^\/(.+)\/([gimsu]*)$/` → 被识别为正则；导入时按正则 `/foo/` 执行 `regex.test`；如果用户实际想匹配字面值 `/foo/`，必须改写为正则形式 `/^\/foo\/$/`（详见 PRD §3.2.1 注意事项 — 已知语法限制） |
| 备注 | PRD 已声明此为已知限制，无转义机制 |

---

### D. 导入匹配规则 — 正则模式（9 cases）

#### TC1-37 正则 `/^C$/` 整串匹配 `C`

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29a |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `condition_value = '/^C$/'`，文件 F9 含一行 `TXN_TYPE = 'C'` |
| 测试步骤 | 1. 导入 F9 |
| 预期结果 | 命中（`/^C$/.test('C') === true`），Credit Amount 列写入 |

#### TC1-38 正则 `/^C.*/` 匹配 `C`、`CR`、`Credit`

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29a |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `condition_value = '/^C.*/'`，文件 F9 含 3 行 `TXN_TYPE = 'C'`、`'CR'`、`'Credit'` |
| 测试步骤 | 1. 导入 F9 |
| 预期结果 | 3 行均命中 |

#### TC1-39 正则分组 `/^(C|CR|Credit)$/` 多值匹配

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29c |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `condition_value = '/^(C|CR|Credit)$/'`，文件 F9 含相应数据 |
| 测试步骤 | 1. 导入 F9 |
| 预期结果 | `'C'`、`'CR'`、`'Credit'` 命中；`'CRX'` 不命中 |
| 备注 | PRD 强调：多值场景必须用正则分组语法，**不支持**逗号分隔（如 `C,CR,Credit` 会被当字面值整串匹配，无任何源行命中） |

#### TC1-40 正则 `/c/i` 大小写不敏感（显式）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29a |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `condition_value = '/c/i'`，文件含 `TXN_TYPE = 'C'` 和 `'c'` |
| 测试步骤 | 1. 导入 |
| 预期结果 | 两行均命中（`/c/i.test('C') === true` 且 `/c/i.test('c') === true`） |

#### TC1-41 正则 `/C/` 不自动加 i flag — 大小写敏感

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29a |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `condition_value = '/C/'`，文件含 `TXN_TYPE = 'C'` 和 `'c'` |
| 测试步骤 | 1. 导入 |
| 预期结果 | `'C'` 命中（注意 `/C/` 是 partial match，会命中 `Cxxx` 等），`'c'` 不命中 |

#### TC1-42 正则默认 test 整串（应明确边界，演示 partial match）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29a |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `condition_value = '/C/'`（无锚点） |
| 测试步骤 | 1. 导入文件 `TXN_TYPE = 'CRT'` 一行 |
| 预期结果 | **该行命中**（`/C/.test('CRT') === true`，因为是 partial match）<br>注：实现使用 `regex.test`（PRD §3.2.1）；用户如需整串匹配，需显式写 `/^C$/`（PRD 已注明） |

#### TC1-43 正则与源字段 trim 后的值比较

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29a |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `condition_value = '/^C$/'`，文件 F6 含 `TXN_TYPE = '  C  '` |
| 测试步骤 | 1. 导入 F6 |
| 预期结果 | 命中（`matchAmountSplitConditionValue` 先 trim 源字段为 `'C'` 再 `regex.test`） |

#### TC1-44 无效正则语法保存时报错

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29b |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 配置 `condition_value = '/[/'`<br>2. 点「完成」 |
| 预期结果 | 弹错 `正则表达式语法错误`；弹框保持打开，已填字段不丢失；`new RegExp('[', '')` 抛 `SyntaxError`，被 try/catch 拦截 |
| 备注 | 注意 renderer 与 main 两侧均要校验：renderer 通过 `parseRegexLiteral` 抛错前置拦截，main 通过 `validateAmountSplitRulesPayload` 内的 `compileRegexLiteral` 兜底 |

#### TC1-45 正则 flags 仅支持 `gimsu`

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-29a |
| 类型 | 边界 |
| 优先级 | P2 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 配置 `condition_value = '/c/x'`（`x` 不在 `[gimsu]*` 内） |
| 预期结果 | `REGEX_LITERAL_PATTERN = /^\/(.+)\/([gimsu]*)$/` 不匹配 → `isRegexLiteral` 返回 `false` → 该值被当作字面值处理（即字面值就是 `/c/x` 这一串字符），命中要求源字段值必须是 `/c/x` 字面字符串 |
| 备注 | 此为正则识别边界。若期望未来支持其它 flag，需更新 `REGEX_LITERAL_PATTERN` 常量 |

---

### E. 导入 Credit/Debit 双规则生效（12 cases）

#### TC1-46 场景 A — `TXN_TYPE = C` 写入 Credit

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-18 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置规则：第 1 行 `TXN_TYPE / C / AMOUNT`，第 2 行 `TXN_TYPE / D / AMOUNT`；导入文件 F1 |
| 测试步骤 | 1. 导入 F1 |
| 预期结果 | 5 行 `TXN_TYPE = C` 行的 `AMOUNT` 值写入 Credit Amount 列；同 5 行的 Debit Amount 列为空 |

#### TC1-47 场景 A — `TXN_TYPE = D` 写入 Debit

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-18 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 同 TC1-46 |
| 测试步骤 | 1. 导入 F1 |
| 预期结果 | 5 行 `TXN_TYPE = D` 行的 `AMOUNT` 值写入 Debit Amount 列；同 5 行的 Credit Amount 列为空 |

#### TC1-48 场景 B — `TXN_TYPE = Credit` 写入 AMOUNT1 → Credit

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-18 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T2 配置规则：第 1 行 `TXN_TYPE / Credit / AMOUNT1`，第 2 行 `TXN_TYPE / Debit / AMOUNT2`；导入文件 F2 |
| 测试步骤 | 1. 导入 F2 |
| 预期结果 | `TXN_TYPE = Credit` 行的 `AMOUNT1` 值写入 Credit Amount 列；Debit Amount 列为空 |

#### TC1-49 场景 B — `TXN_TYPE = Debit` 写入 AMOUNT2 → Debit

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-18 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 同 TC1-48 |
| 测试步骤 | 1. 导入 F2 |
| 预期结果 | `TXN_TYPE = Debit` 行的 `AMOUNT2` 值写入 Debit Amount 列；Credit Amount 列为空 |

#### TC1-50 两行同时命中（极端场景）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-18 |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 模板 T2，配置规则：第 1 行 `TXN_TYPE / Both / AMOUNT1`，第 2 行 `TXN_TYPE / Both / AMOUNT2`；构造一个 CSV 含一行 `TXN_TYPE = 'Both'` |
| 测试步骤 | 1. 导入 |
| 预期结果 | 该行 Credit Amount = `AMOUNT1` 值且 Debit Amount = `AMOUNT2` 值，两行规则相互独立、并行评估（PRD §3.4.1） |

#### TC1-51 两行都未命中

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-32 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `TXN_TYPE / C / AMOUNT` 和 `TXN_TYPE / D / AMOUNT`；构造一个 CSV 含一行 `TXN_TYPE = 'X'` |
| 测试步骤 | 1. 导入 |
| 预期结果 | 该行 Credit Amount 和 Debit Amount 均为空；导入流程不阻断 |

#### TC1-52 多文件批量导入 — 全部文件均未命中（按文件独立判定，告警合并列出）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-32, AC1-32a |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `TXN_TYPE / C / AMOUNT` 和 `TXN_TYPE / D / AMOUNT`；准备 2 个文件：<br>① `file1.csv`（10 行全部 `TXN_TYPE = X`，全部不命中）<br>② `file2.csv`（10 行全部 `TXN_TYPE = Y`，全部不命中） |
| 测试步骤 | 1. 同时导入 file1.csv + file2.csv |
| 预期结果 | 1. 导入流程跑完不阻断<br>2. 完成后弹出**单个**告警框，文案完全匹配（含换行）：<br><pre>以下文件全部未命中收支规则，请检查规则配置：<br>file1.csv<br>file2.csv</pre>3. 生成的 Excel 中两个文件对应的所有行 Credit/Debit 列均为空 |
| 验证要点 | 每个文件分别计算 `amountSplitMatchStats = { enabled: true, totalRows: 10, matchedRows: 0 }`；main.js 后续处理对每个文件**独立判定** `matchedRows === 0 && totalRows > 0`，把所有"全部未命中"的文件名收集到一个列表，合并为一条告警通过 `createWarningResult` 弹出 |
| 备注 | Q-T1 决策方案 C（2026-04-07）：按文件独立判定，避免"任一文件命中过则不告警"掩盖其它文件的问题 |

#### TC1-52a 多文件批量导入 — 部分文件全部未命中

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-32, AC1-32a |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `TXN_TYPE / C / AMOUNT` 和 `TXN_TYPE / D / AMOUNT`；准备 3 个文件：<br>① `file1.csv`（含 50 行，全部命中规则）<br>② `file2.csv`（含 N 行，**全部不命中**，TXN_TYPE 全为 `X`）<br>③ `file3.csv`（含 20 行，全部命中规则） |
| 测试步骤 | 1. 同时导入 file1.csv + file2.csv + file3.csv |
| 预期结果 | 1. 导入流程跑完不阻断<br>2. 弹出**单个**告警框，文案完全匹配（含换行）：<br><pre>以下文件全部未命中收支规则，请检查规则配置：<br>file2.csv</pre>3. **只列出 file2.csv**（file1 / file3 部分命中，不列入告警）<br>4. file1 / file3 的 Credit/Debit 列正确生成；file2 对应行 Credit/Debit 均为空 |
| 验证要点 | 各文件 `amountSplitMatchStats` 分别为：file1 `matchedRows=50`，file2 `matchedRows=0`，file3 `matchedRows=20`；只有 file2 进入告警列表 |
| 备注 | Q-T1 决策方案 C（2026-04-07）：按文件独立判定 |

#### TC1-52b 多文件批量导入 — 所有文件均至少部分命中（不弹告警）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-32a |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `TXN_TYPE / C / AMOUNT` 和 `TXN_TYPE / D / AMOUNT`；准备 2 个文件，每个都含 10 行数据，每个文件各有 5 行命中、5 行不命中 |
| 测试步骤 | 1. 同时导入两个文件 |
| 预期结果 | 1. 导入流程跑完不阻断<br>2. **不弹任何 "全部未命中" 告警**（因为没有任何文件出现 `matchedRows === 0 && totalRows > 0` 的情况）<br>3. 两个文件命中行的 Credit/Debit 正确生成，未命中行 Credit/Debit 为空 |
| 验证要点 | 各文件 `amountSplitMatchStats` 均为 `matchedRows=5`，告警列表为空，跳过 `createWarningResult` |
| 备注 | Q-T1 决策方案 C（2026-04-07）：仅当存在 `matchedRows === 0 && totalRows > 0` 的文件时才弹告警 |

#### TC1-53 源文件缺条件字段列 — 报错

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-31 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `TXN_TYPE / C / AMOUNT`；导入文件 F4（缺 `TXN_TYPE` 列） |
| 测试步骤 | 1. 导入 F4 |
| 预期结果 | 报错：`映射字段不存在：TXN_TYPE`；导入失败 |
| 验证要点 | `buildMappedRows` 在 `amountSplitConfig.enabled` 分支抛 `FileValidationError('FILE_READ', ...)` |

#### TC1-54 源文件缺目标字段列 — 报错

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-31 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置 `TXN_TYPE / C / AMOUNT`；导入文件 F5（缺 `AMOUNT` 列） |
| 测试步骤 | 1. 导入 F5 |
| 预期结果 | 报错：`映射字段不存在：AMOUNT`；导入失败 |

#### TC1-55 部分行命中 + 部分未命中

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-18, AC1-32 |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置 `TXN_TYPE / C / AMOUNT` 和 `TXN_TYPE / D / AMOUNT`；CSV 含 5 行命中 + 5 行 `TXN_TYPE = X` |
| 测试步骤 | 1. 导入 |
| 预期结果 | 5 行有 Credit/Debit 数据；5 行未命中行 Credit/Debit 均为空；**不弹**「全部未命中」告警（matched > 0） |

---

### F. 三模式互斥（保存层 + 回归）（5 cases）

#### TC1-56 选「是」时 UI 立即清空另两种模式（待落库的值）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-22 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T4：Credit Amount / Debit Amount / 按正负号拆分的发生额 三行均有非空值 |
| 测试步骤 | 1. 打开映射对话框<br>2. 在新行选「是」<br>3. 调用 `collectMappingDraftFromTable` 检查待落库 mappings |
| 预期结果 | 三行的 `mappedField` 均为 `''`；外层「完成」时 `template:save-mappings` 收到的 mappings 中三个字段均空 |

#### TC1-57 保存层校验：直接映射 + 按字段区分发生额 同时存在

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-25 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 通过 DevTools 构造一个绕过 UI 的 mappings payload：含 `Credit Amount: '某列'` 和 `按字段区分发生额: '是'` |
| 测试步骤 | 1. 调用 `desktopApi.templates.saveMappings({ ..., mappings: 上述 payload })` |
| 预期结果 | 报错：`「按字段区分发生额」与 Credit Amount / Debit Amount 直接映射、按正负号拆分的发生额三者不能同时设置`；DB 不被修改 |

#### TC1-58 保存层校验：正负号拆分 + 按字段区分发生额 同时存在

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-25 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 通过 DevTools 构造 payload：含 `按正负号拆分的发生额: '某列'` 和 `按字段区分发生额: '是'` |
| 测试步骤 | 1. 调用 `desktopApi.templates.saveMappings({...})` |
| 预期结果 | 同 TC1-57 报错 |

#### TC1-59 v1.4.7 已有互斥（直接映射 + 正负号拆分）回归

| 项目 | 内容 |
|------|------|
| 关联AC | 回归（v1.4.7 互斥校验未破坏） |
| 类型 | 回归 |
| 优先级 | P1 |
| 前置条件 | 通过 DevTools 构造 payload：含 `Credit Amount: '某列'` 和 `按正负号拆分的发生额: '某列'` |
| 测试步骤 | 1. 调用 `desktopApi.templates.saveMappings({...})` |
| 预期结果 | 报错：`"按正负号拆分的发生额"与 Credit Amount / Debit Amount 不能同时设置`（v1.4.7 已有错误文案，本次未破坏） |

#### TC1-60 三方都填（最严重情形）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-25 |
| 类型 | 边界 |
| 优先级 | P1 |
| 前置条件 | 通过 DevTools 构造 payload：含 `Credit Amount`、`Debit Amount`、`按正负号拆分的发生额`、`按字段区分发生额=是` 同时为非空 |
| 测试步骤 | 1. 调用 `desktopApi.templates.saveMappings({...})` |
| 预期结果 | 报错（按校验顺序优先抛三方互斥错或 v1.4.7 互斥错均可，但 DB 不被修改） |

---

### G. 持久化 + 向后兼容（7 cases）

#### TC1-61 保存后重新打开 — 完整回显

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-15, AC1-16 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 已通过 TC1-14 落库 |
| 测试步骤 | 1. 关闭对话框<br>2. 重新打开映射关系管理对话框 |
| 预期结果 | 外层下拉框回显「是」；按钮可见；点击按钮后弹框中 4 个下拉框 + 2 个输入框完整回显 |

#### TC1-62 旧模板（v1.4.7 及以下）打开不报错

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-17 |
| 类型 | 兼容 |
| 优先级 | P0 |
| 前置条件 | 模板 T3（v1.4.7 旧模板，DB 中无 `template_amount_split_rules` 行；`template_mappings` 中无「按字段区分发生额」行） |
| 测试步骤 | 1. 打开 T3 的映射关系管理对话框 |
| 预期结果 | 不报错；新行「按字段区分发生额」存在且默认值空白；按钮隐藏；其它三行 disabled 状态正常未触发 |

#### TC1-63 DB migration 幂等可重复执行

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-17 |
| 类型 | 兼容 |
| 优先级 | P0 |
| 前置条件 | 数据库已经过 `ensureAmountSplitRulesSupport` 迁移 |
| 测试步骤 | 1. 重启应用 → 触发 `database.init()` 再次执行 `ensureAmountSplitRulesSupport`<br>2. 检查表是否仍存在且无报错 |
| 预期结果 | 表存在；无报错；事务结构（`BEGIN/COMMIT/ROLLBACK`）幂等成功 |
| 验证要点 | SQLite 中执行 `SELECT name FROM sqlite_master WHERE name='template_amount_split_rules'` 返回 1 行；`SELECT name FROM sqlite_master WHERE name='template_amount_split_rules_template_id_idx'` 返回 1 行 |

#### TC1-64 删除模板时关联表级联删除

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-17 |
| 类型 | 兼容 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 已落库 2 行规则 |
| 测试步骤 | 1. 删除模板 T1<br>2. 检查 `template_amount_split_rules` 表 |
| 预期结果 | 关联的 2 行被级联删除（`FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE`） |

#### TC1-65 弹框草稿独立于下拉框（切回空白 → 切回是 → 草稿仍回显）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-24 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 已通过 TC1-14 落库 |
| 测试步骤 | 1. 打开映射对话框，外层下拉框已回显「是」<br>2. 切回空白<br>3. 再次切回「是」<br>4. 点击按钮打开弹框 |
| 预期结果 | 弹框中规则仍完整回显（草稿跟着模板走，跟外层下拉框「空白/是」状态无关，符合 PRD §3.3.4） |
| 验证要点 | 数据来源：`template:get-mappings` 返回的 `amountSplitRules` 始终存在，不被外层下拉框状态影响；`template:save-mappings` 不传 `amountSplitRules`（默认 `null`），不会清空 DB 中的 rules |

#### TC1-66 `legacyConcatMode`（PR #14）和新 feature 共存不冲突

| 项目 | 内容 |
|------|------|
| 关联AC | 回归 |
| 类型 | 兼容 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 已配「按字段区分发生额」；同时模板的 Currency 行已通过 `legacyConcatMode` 配过拼接字段 |
| 测试步骤 | 1. 打开映射对话框<br>2. 检查 Currency 行的 `dataset.legacyConcatMode` 状态<br>3. 检查新行下拉框状态 |
| 预期结果 | Currency 行的 `legacyConcatMode` 行为不变；新行的 select.value / 互斥处理不影响 Currency 行；`collectMappingDraftFromTable` 输出两者均正确 |

#### TC1-67 完整往返：保存 → 重启 app → 重新打开

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-15, AC1-16 |
| 类型 | 兼容 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配置完成 |
| 测试步骤 | 1. 配置 + 保存<br>2. 完全关闭应用<br>3. 重启应用<br>4. 打开 T1 映射对话框 |
| 预期结果 | 配置完整回显，DB 中 `template_amount_split_rules` 表数据持久存在 |

---

### H. Bundle 导出 / 导入（含 bundleVersion）（6 cases）

#### TC1-68 导出 bundle 顶层包含 `bundleVersion = 2`

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-19 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 已配「按字段区分发生额」 |
| 测试步骤 | 1. 导出模板 bundle<br>2. 用文本编辑器打开 JSON |
| 预期结果 | 顶层 JSON 包含 `"bundleVersion": 2`；与 `exportedAt` / `templates` 同级 |
| 验证要点 | `buildTemplateLibraryPayload` 写入 `bundleVersion: 2`（从 v1.4.7 的 1 升至 2） |

#### TC1-69 导出 bundle 每个 template entry 含 `amountSplitRules`（6 个值完整）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-19 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 同 TC1-68 |
| 测试步骤 | 1. 检查 JSON 中模板 T1 entry |
| 预期结果 | 包含 `amountSplitRules` 字段，值为 2 元素数组：<br>第 1 元素 `{ targetField: 'Credit Amount', conditionField: 'TXN_TYPE', conditionValue: 'C', mappedField: 'AMOUNT', rowIndex: 0 }`<br>第 2 元素 `{ targetField: 'Debit Amount', conditionField: 'TXN_TYPE', conditionValue: 'D', mappedField: 'AMOUNT', rowIndex: 1 }` |
| 备注 | 同时该模板 entry 的 `mappings` 中包含一行 `{ templateField: '按字段区分发生额', mappedField: '是' }` |

#### TC1-70 新版 app 打开旧 bundle（无 bundleVersion）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-21 |
| 类型 | 兼容 |
| 优先级 | P0 |
| 前置条件 | Bundle B1（v1.4.7 旧 bundle，无 `bundleVersion` 字段，无 `amountSplitRules`） |
| 测试步骤 | 1. v1.4.8 app 中导入 B1 |
| 预期结果 | 正常导入，不报错；导入后该模板的「按字段区分发生额」开关默认空白；DB 中 `template_amount_split_rules` 表对应模板无任何行 |
| 验证要点 | `readTemplateBundleFile` 中 `bundleVersion = Number(parsed?.bundleVersion || 1)` 兜底为 1，`Array.isArray(item.amountSplitRules) ? ... : []` 兜底为空数组 |

#### TC1-71 新版 app 打开 `bundleVersion = 2` 的 bundle

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-19 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | Bundle B2（v1.4.8 自身导出） |
| 测试步骤 | 1. v1.4.8 app 中导入 B2 |
| 预期结果 | 正常导入；导入后模板的「按字段区分发生额」开关 = 「是」；`template_amount_split_rules` 表写入 2 行规则 |
| 验证要点 | `database.saveMappings` 第 6 个参数收到 `entry.amountSplitRules`（数组），触发 DELETE+INSERT |

#### TC1-72 新版 app 打开人为伪造 `bundleVersion = 99` 的 bundle

| 项目 | 内容 |
|------|------|
| 关联AC | （Q1=C 预埋机制验证 — 见 PRD §3.3.5，TechDoc §6.2.1 / §6.2.2） |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | Bundle B3（顶层 `bundleVersion = 99`） |
| 测试步骤 | 1. v1.4.8 app 中导入 B3 |
| 预期结果 | 报错并拒绝：`此 bundle 来自更高版本的应用，请升级 (需要 bundleVersion 99 及以上)`；不写入任何模板数据 |
| 验证要点 | `readTemplateBundleFile` 中 `if (bundleVersion > SUPPORTED_BUNDLE_VERSION) throw FileValidationError(...)`；`SUPPORTED_BUNDLE_VERSION = 2` |
| 备注 | 此 TC 是 Dev 在 task #2 阶段明确要求 Tester 加入的 extra case，验证 v1.4.9+ 预埋机制的正确性。**AC1-20（v1.4.7 旧版 app 打开新 bundle）属于已知限制，不写测试** |

#### TC1-73 Bundle 导入路径写入新表 — 完整覆盖语义

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-19, AC1-21 |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 已存在且 DB 中有规则；准备一个 Bundle B2'（包含 T1 但其 `amountSplitRules = []`） |
| 测试步骤 | 1. 导入 B2' |
| 预期结果 | T1 的 `template_amount_split_rules` 表的对应记录被清空（DELETE+INSERT 路径，空数组 = 清空）；这是 Bundle 导入的"完整覆盖"语义，与外层 `template:save-mappings` 的"局部更新"语义不同（详见 TechDoc §6.2.3） |

---

### I. 联动 + 粒度（4 cases）

#### TC1-74 「根据发生额做映射的户名」在新模式下能正确感知 Credit/Debit

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-33 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置「按字段区分发生额」+「根据发生额做映射的户名」=`某列`；导入 F1 |
| 测试步骤 | 1. 导入 F1 |
| 预期结果 | 命中 Credit 规则的行 → `hasCreditAmount = true` → "户名"按 Credit 语义取值；命中 Debit 规则的行 → `hasDebitAmount = true` → "户名"按 Debit 语义取值 |
| 验证要点 | `buildMappedRows` 在 `amountSplitConfig.enabled` 分支中调用 `hasEffectiveAmount(mappedCellRaw)` 设置 `hasCreditAmount`/`hasDebitAmount`，`file-service.js:160-178` 现有逻辑无需修改即可工作 |

#### TC1-75 「根据发生额做映射的账户号」在新模式下感知正确

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-33 |
| 类型 | 功能 |
| 优先级 | P0 |
| 前置条件 | 模板 T1 配置「按字段区分发生额」+「根据发生额做映射的账户号」=`某列`；导入 F1 |
| 测试步骤 | 1. 导入 F1 |
| 预期结果 | 同 TC1-74 语义，"账户号"在新模式下与"直接映射"模式语义一致 |

#### TC1-76 同一模板对所有导入文件生效（模板级粒度）

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-34 |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 已配规则 |
| 测试步骤 | 1. 用 T1 导入 F1<br>2. 再用 T1 导入另一个不同文件 F1' |
| 预期结果 | 两次导入均按相同的「按字段区分发生额」规则匹配；规则不按文件细分 |

#### TC1-77 不同模板的配置互不干扰

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-34 |
| 类型 | 功能 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配规则 `TXN_TYPE / C / AMOUNT`；模板 T2 配规则 `TXN_TYPE / Credit / AMOUNT1` |
| 测试步骤 | 1. 用 T1 导入 F1<br>2. 用 T2 导入 F2 |
| 预期结果 | 两次导入分别使用各自模板的规则；DB 中 `template_amount_split_rules` 按 `template_id` 隔离；查询 `WHERE template_id = T1.id` 与 `WHERE template_id = T2.id` 互不影响 |

---

### J. 回归（5 cases）

#### TC1-78 v1.4.7 直接映射 Credit/Debit 不受影响

| 项目 | 内容 |
|------|------|
| 关联AC | 回归 |
| 类型 | 回归 |
| 优先级 | P0 |
| 前置条件 | 模板 T4（直接映射 Credit Amount / Debit Amount，新行下拉框为空白） |
| 测试步骤 | 1. 用 T4 导入相应文件 |
| 预期结果 | 导入流程与 v1.4.7 完全一致；Credit/Debit 列正确生成；新逻辑分支（`amountSplitConfig.enabled === false`）走原有 directAmount 路径 |

#### TC1-79 v1.4.7 按正负号拆分的发生额不受影响

| 项目 | 内容 |
|------|------|
| 关联AC | 回归 |
| 类型 | 回归 |
| 优先级 | P0 |
| 前置条件 | 一个配了「按正负号拆分的发生额」的模板（新行下拉框空白） |
| 测试步骤 | 1. 导入相应文件 |
| 预期结果 | 与 v1.4.7 行为一致；`signedAmountSourceField` 路径正常工作 |

#### TC1-80 v1.4.7 「映射字段不存在」报错路径不变

| 项目 | 内容 |
|------|------|
| 关联AC | 回归 |
| 类型 | 回归 |
| 优先级 | P1 |
| 前置条件 | 模板配置 `Credit Amount` 映射到 `某列X`；导入文件不含 `某列X` |
| 测试步骤 | 1. 导入 |
| 预期结果 | 报错文案与 v1.4.7 一致：`映射字段不存在：某列X`（错误风格统一） |

#### TC1-81 v1.4.7 PR #14 dateFormat 保存路径不被破坏

| 项目 | 内容 |
|------|------|
| 关联AC | 回归 |
| 类型 | 回归 |
| 优先级 | P0 |
| 前置条件 | 模板已设置 `dateFormat = 'DMY'` |
| 测试步骤 | 1. 在外层映射对话框中保存任意修改<br>2. 重新打开映射对话框检查 dateFormat |
| 预期结果 | `dateFormat` 仍为 `'DMY'`，未被误清；`saveMappings` 内部 `UPDATE templates ... date_format` 不被新增的 `template_amount_split_rules` 写入逻辑干扰（PR #14 commit `36b24fd` 修复未被破坏） |
| 验证要点 | `database.saveMappings` 签名 `(db, templateId, mappings, bigAccounts, fixedAssignments, dateFormat, amountSplitRules = null)`；`amountSplitRules` 默认 `null`（外层 IPC 不传）→ 不动 rules 表；`UPDATE templates` 仍为事务最后一步 |

#### TC1-82 xlsx / xls / csv 三种格式都能跑新逻辑

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-18 |
| 类型 | 兼容 |
| 优先级 | P1 |
| 前置条件 | 模板 T1 配规则；准备 3 个相同结构的文件，分别为 `.xlsx` / `.xls` / `.csv` 格式 |
| 测试步骤 | 1. 依次导入三种格式文件 |
| 预期结果 | 三种格式均能正确解析并按规则匹配；Credit/Debit 列结果一致 |
| 备注 | 注意 v1.4.7 PR #11 修复了 CSV 长数字精度问题，本 feature 不涉及数字精度（条件值字符串比较，不做归一化），与 PR #11 不冲突 |

---

### K. 错误处理边界（3 cases）

#### TC1-83 弹框校验失败 → 弹错误框 → 用户点确认 → 弹框仍打开 + 字段未丢失

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-14, AC1-28 |
| 类型 | 边界 |
| 优先级 | P0 |
| 前置条件 | 弹框打开 |
| 测试步骤 | 1. 第 1 行：条件字段 `TXN_TYPE`，条件值 `C`，目标字段 `AMOUNT`<br>2. 第 2 行：条件字段 `TXN_TYPE`，条件值 留空，目标字段 `AMOUNT`<br>3. 点「完成」<br>4. 弹错 `请填写条件值`，点确认 |
| 预期结果 | 弹框重新打开（同一 `createAmountSplitRulesDialog`），第 1 行 `TXN_TYPE`/`C`/`AMOUNT` 仍在原位，第 2 行 `TXN_TYPE`/`AMOUNT` 在原位、条件值仍为空 |
| 备注 | 此为 PRD §3.2 "完成按钮语义" 的核心交互保证，完整覆盖 §3.2.2 校验失败回退路径 |

#### TC1-84 DB 写入失败的 graceful degradation

| 项目 | 内容 |
|------|------|
| 关联AC | AC1-14 |
| 类型 | 边界 |
| 优先级 | P2 |
| 前置条件 | 通过 DB 文件权限或测试 stub 模拟写入失败 |
| 测试步骤 | 1. 弹框配置完整 → 点「完成」 |
| 预期结果 | IPC 返回错误 `errorCode = 'AMOUNT_SPLIT_RULES_SAVE_RUNTIME'`，message = `发生额映射关系保存失败`；前端弹错误框 `发生额映射关系保存失败，请查看控制台`；`saveAmountSplitRules` 内部 `BEGIN/ROLLBACK` 事务自动回滚，DB 状态保持一致；弹框保持打开 |

#### TC1-85 极大规模导入性能（1000+ 行）

| 项目 | 内容 |
|------|------|
| 关联AC | NFR-4 |
| 类型 | 性能 |
| 优先级 | P2 |
| 前置条件 | 模板 T1 配规则；文件 F10（1500 行交易数据） |
| 测试步骤 | 1. 导入 F10<br>2. 记录耗时 |
| 预期结果 | 导入完成；耗时与同等规模 v1.4.7 直接映射方案相当（PRD NFR-4：每行 1-2 次字符串比较 + 可选正则匹配，整体 O(N)）；无明显卡顿；正则匹配未引入 ReDoS 风险（NFR-5） |
| 备注 | 非严格性能基准，仅作观察 |

---

## 五、测试用例追踪矩阵

### 5.1 PRD AC 覆盖矩阵

| AC 编号 | 覆盖用例 |
|---------|---------|
| AC1-1 | TC1-1 |
| AC1-2 | TC1-2 |
| AC1-3 | TC1-3 |
| AC1-4 | TC1-4 |
| AC1-5 | TC1-5 |
| AC1-6 | TC1-6 |
| AC1-7 | TC1-7 |
| AC1-8 | TC1-10 |
| AC1-9 | TC1-11 |
| AC1-10 | TC1-11 |
| AC1-11 | TC1-12 |
| AC1-12 | TC1-13 |
| AC1-13 | TC1-15, TC1-16, TC1-17, TC1-27 |
| AC1-14 | TC1-14, TC1-15, TC1-16, TC1-20, TC1-26, TC1-83, TC1-84 |
| AC1-15 | TC1-61, TC1-67 |
| AC1-16 | TC1-25, TC1-61, TC1-67 |
| AC1-17 | TC1-62, TC1-63, TC1-64 |
| AC1-18 | TC1-46, TC1-47, TC1-48, TC1-49, TC1-50, TC1-55, TC1-82 |
| AC1-19 | TC1-68, TC1-69, TC1-71, TC1-73 |
| AC1-20 | **跳过（known limitation，详见 TechDoc §6.2.1）** |
| AC1-21 | TC1-70, TC1-73 |
| AC1-22 | TC1-8, TC1-56 |
| AC1-23 | TC1-9 |
| AC1-24 | TC1-65 |
| AC1-25 | TC1-23, TC1-57, TC1-58, TC1-60 |
| AC1-26 | TC1-18 |
| AC1-27 | TC1-21, TC1-22 |
| AC1-28 | TC1-17, TC1-33, TC1-83 |
| AC1-28b（PM 新增 — Q-T2 决策） | TC1-24 |
| AC1-29 | TC1-27, TC1-28, TC1-29, TC1-30, TC1-31, TC1-32, TC1-34, TC1-35, TC1-36 |
| AC1-29a | TC1-36, TC1-37, TC1-38, TC1-40, TC1-41, TC1-42, TC1-43, TC1-45 |
| AC1-29b | TC1-19, TC1-44 |
| AC1-29c | TC1-39 |
| AC1-30 | TC1-12 |
| AC1-31 | TC1-53, TC1-54 |
| AC1-32 | TC1-51, TC1-52, TC1-52a, TC1-55 |
| AC1-32a（Q-T1 决策方案 C 落地） | TC1-52, TC1-52a, TC1-52b |
| AC1-33 | TC1-74, TC1-75 |
| AC1-34 | TC1-76, TC1-77 |

> **跳过项**：AC1-20（v1.4.7 及以下旧版 app 打开 v1.4.8 bundle 的报错拒绝行为）属于 PRD 已声明的 known limitation，详见 PRD §3.3.5 + TechDoc §6.2.1。原因：v1.4.7 的 `readTemplateBundleFile` 不读取版本字段，已发布版本无法追溯阻断。本版本通过预埋 `bundleVersion = 2` 让 v1.4.9+ 后续版本能正确识别更高版本 bundle，TC1-72 验证此预埋机制的正确性。

### 5.2 NFR 覆盖

| NFR 编号 | 覆盖用例 |
|---------|---------|
| NFR-1（旧模板容错） | TC1-62 |
| NFR-2（bundle 兼容策略） | TC1-68, TC1-70, TC1-71, TC1-72 |
| NFR-3（弹框渲染性能） | TC1-13（隐含） |
| NFR-4（导入性能 O(N)） | TC1-85 |
| NFR-5（正则 ReDoS 防御） | TC1-85（隐含） |
| NFR-6（migration 幂等） | TC1-63 |

### 5.3 涉及测试模板与文件矩阵

| 模板/文件 | 涉及 TC |
|----------|---------|
| 模板 T1（场景 A） | TC1-1~TC1-22, TC1-25, TC1-27~TC1-55, TC1-61~TC1-67, TC1-68~TC1-77, TC1-82~TC1-85 |
| 模板 T2（场景 B） | TC1-48, TC1-49, TC1-50, TC1-77 |
| 模板 T3（旧模板） | TC1-62 |
| 模板 T4（已配直接映射） | TC1-8, TC1-9, TC1-23, TC1-56, TC1-78 |
| 文件 F1 | TC1-46, TC1-47, TC1-74, TC1-75 |
| 文件 F2 | TC1-48, TC1-49 |
| 文件 F3（参考结构） | TC1-52, TC1-52a, TC1-52b |
| 文件 F4 | TC1-53 |
| 文件 F5 | TC1-54 |
| 文件 F6 | TC1-31, TC1-43 |
| 文件 F7 | TC1-30 |
| 文件 F8 | TC1-32 |
| 文件 F9 | TC1-37, TC1-38, TC1-39 |
| 文件 F10 | TC1-85 |
| Bundle B1 | TC1-70 |
| Bundle B2 | TC1-71, TC1-73 |
| Bundle B3 | TC1-72 |

---

## 六、已知不测试项

| 项目 | 原因 |
|------|------|
| **AC1-20** v1.4.7 及以下版本 app 打开 v1.4.8 bundle 的报错拒绝 | PRD 已声明为 known limitation，详见 PRD §3.3.5 / AC1-20 / 第十一节 Release Note 草稿；TechDoc §6.2.1 决策为方案 C：本版本预埋 `bundleVersion = 2`、`readTemplateBundleFile` 加入 `> SUPPORTED_BUNDLE_VERSION` 校验（由 v1.4.9+ 实际生效）；v1.4.7 老用户由 release note 告知升级。Tester 在本次验收时仅通过 TC1-72 验证 v1.4.9+ 预埋机制的正确性，不在 v1.4.7 老 app 上做实际测试。 |

---

## 七、回归测试范围

| 范围 | 关联 TC |
|------|---------|
| v1.4.7 直接映射 Credit/Debit Amount 流程 | TC1-78 |
| v1.4.7 按正负号拆分的发生额流程 | TC1-79 |
| v1.4.7 「映射字段不存在」报错路径 | TC1-80 |
| v1.4.7 PR #14 dateFormat 保存路径修复 | TC1-81 |
| v1.4.7 已有的 Credit+Signed 互斥校验 | TC1-59 |
| v1.4.7 PR #14 legacyConcatMode（Currency 行）兼容 | TC1-66 |
| 三种文件格式（xlsx / xls / csv） | TC1-82 |
| 旧模板（v1.4.7 及以下）打开映射对话框 | TC1-62 |

---

## 八、Open Test Questions（已全部关闭 — 2026-04-07）

Tester 在编写本文档过程中**未发现** PRD 与 TechDoc 之间的矛盾。所有 AC 均能映射到具体可执行的测试步骤，除已知不测项 AC1-20 外。

以下为 Tester 在测试设计过程中产生的细节问题，**用户已于 2026-04-07 全部决策**：

### Q-T1 「全部未命中」告警是否区分多文件批量导入

PRD §3.4.3 / AC1-32 描述的告警文案 `本次导入 N 行，其中 0 行成功匹配收支规则，请检查规则配置` 中的 N 是否为：
- 选项 A：单个文件的总行数（每个文件单独触发一次告警）
- 选项 B：本次批量导入中所有文件的合计总行数（仅触发一次合并告警）
- 选项 C：每个文件**独立判定** `matchedRows === 0 && totalRows > 0`，把所有"全部未命中"的文件名收集到一个列表，**合并为一条告警**弹出

TechDoc §8.2 原实现倾向 B，但这会"任一文件命中过则不告警"掩盖另一文件的问题。

**✅ 答（2026-04-07）：选方案 C。**

实现细节：每个文件独立判定，告警合并列出所有未命中的文件名。新告警文案为：
```
以下文件全部未命中收支规则，请检查规则配置：
{file1.csv}
{file2.csv}
...
```

PRD §3.4.3 + TechDoc §8.2 将由 PM / Dev 同步更新；新增 AC1-32a 描述按文件独立判定 + 告警合并语义。

测试落地：
- TC1-52 已重写为多文件 + 全部文件未命中场景，关联 AC1-32 + AC1-32a
- 新增 TC1-52a：3 文件中仅 file2 全部未命中，告警仅列出 file2
- 新增 TC1-52b：所有文件均部分命中，不弹任何告警

### Q-T2 弹框「完成」按钮的"开关-规则一致性"边界

TechDoc §5.1.3 在 `template:save-mappings` handler 中加入了"开关 = 是 + rules 表为空"的校验，并报错 `请先在"发生额映射关系管理"中配置完整的两行规则`（errorCode = `AMOUNT_SPLIT_RULES_MISSING`）。这条文案不在 PRD §3.2.2 校验列表中，PRD 也没有 AC 显式覆盖。Tester 已经把它写到 TC1-24，但希望确认：
- 报错文案是否需要补到 PRD §3.2.2 / NFR / Release Note
- 若用户从未打开过弹框、直接在外层选「是」并点「完成」，本应在 UI 层即触发 disabled / hint。是否需要在前端也加一道前置提示，或者完全依赖后端报错？

**✅ 答（2026-04-07）：采纳。**

- 采纳 Dev 在 TechDoc §5.1.3 偷加的"开关 = 是 但 rules 表为空"校验
- PM 已补到 PRD §3.2.2 新增 **AC1-28b**：当外层映射对话框保存时，若「按字段区分发生额 = 是」但 `template_amount_split_rules` 表为空，报错 `请先在"发生额映射关系管理"中配置完整的两行规则`，错误码 `AMOUNT_SPLIT_RULES_MISSING`
- 触发时机：保存外层「映射关系管理」对话框时，由 `template:save-mappings` handler 在 `database.saveMappings` 之前调 `database.getAmountSplitRules` 校验
- TC1-24 已对齐：关联 AC 改为 AC1-28b，优先级 P1 → P0，操作步骤更清晰

### Q-T3 正则模式 partial match vs 整串 test 的用户期望

PRD §3.2.1 B 明确：`regex.test(trimmedSourceValue)` 是 partial match，整串匹配需用户显式写锚点（`/^...$/`）。但 PRD §3.2 中"匹配方式"列也写过"整串精确匹配"用于字面值模式。对于正则模式，TC1-42 已演示 `/C/` 会命中 `'CRT'`。建议 PM/Dev 确认这是否符合用户实际预期，必要时在用户文档中加入提示。

**✅ 答（2026-04-07）：不处理。**

- 接受用户自己学习正则 partial match 的语义（`regex.test` 默认不锚点）
- 不在 PRD / TechDoc / TestCases / Release Note / 用户文档中做额外提示
- 本议题关闭。TC1-42 保留原状，作为 partial match 的边界文档

---

## 九、变更记录

| 日期 | 变更内容 | 作者 |
|------|---------|------|
| 2026-04-07 | 初版生成，对齐 PRD-v1.4.8.md 全部 34 条 AC（跳过 AC1-20 known limitation），共 85 个 TC，覆盖 A-K 11 个区域；新增 TC1-72 验证 `bundleVersion = 99` 伪造拒绝（Dev 在 task #2 阶段明确要求） | Tester |
| 2026-04-07 | 根据用户 Q-T1/Q-T2/Q-T3 决策更新 TestCases：TC1-52 改写为聚合告警、新增 TC1-52a/52b；TC1-24 对齐 AC1-28b；§八 Open Test Questions 全部关闭 | tester |

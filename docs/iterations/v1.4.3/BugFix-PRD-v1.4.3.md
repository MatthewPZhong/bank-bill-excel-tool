# BugFix PRD - v1.4.3

## 概述

本文档描述新开账户模块中发现的两个 Bug，需要 dev 深入排查根因并修复。上一次修复尝试（label 改 div + 清理 ghost shell）已被回滚，验证未通过，需重新定位根因。

---

## Bug 1：多币种勾选框不可点击

### 复现步骤

1. 启动应用，点击模块切换按钮，切换到"新开账户生成网银账单"模块
2. 在币种输入区域，点击"多币种账户"勾选框（checkbox）
3. 观察勾选框状态

### 预期行为

点击勾选框后，checkbox 应变为选中状态（checked），币种输入框切换为多币种下拉选择模式。

### 实际行为

点击勾选框无反应，checkbox 始终处于未选中状态。

### 根因分析方向

HTML 结构中，"多币种账户" checkbox 嵌套在两层 `<label>` 中：

```
<label class="new-account-field">          <!-- 外层 label："币种"字段 -->
  <span class="new-account-label">币种</span>
  <div class="new-account-currency-row">
    <input class="new-account-currency-input" />   <!-- 币种文本输入框 -->
    ...
    <label class="new-account-checkbox-label">       <!-- 内层 label：多币种 checkbox -->
      <input class="new-account-multi-currency-checkbox" type="checkbox" />
      <span>多币种账户</span>
    </label>
  </div>
</label>
```

**关键问题**：外层 `<label class="new-account-field">` 是一个隐式关联的 label 元素。根据 HTML 规范，当 `<label>` 没有 `for` 属性时，它会关联其内部第一个可关联的表单控件。在此结构中，外层 label 关联的是 `<input class="new-account-currency-input">`（币种文本输入框），而非 checkbox。

当用户点击 checkbox 时，事件冒泡到外层 label，外层 label 的默认行为会将焦点（和 toggle）转发给它关联的币种文本输入框，从而**覆盖/抵消了内层 label 对 checkbox 的 toggle 效果**。这导致 checkbox 的状态被切换了两次（一次由内层 label，一次由外层 label 转发），最终回到原始状态，表现为"点击无反应"。

此外，`ensureCurrencyGhostShell()` 在初始化时会动态在币种输入框外层包裹一个 `<div class="enum-input-shell">`，并插入一个 ghost input（`<input class="enum-ghost-input">`）。这个 ghost input 的存在可能进一步影响外层 label 的关联目标。

**上次修复为什么失败**：将外层 label 改为 div 的思路是正确的方向，但回滚说明可能存在附带影响（样式变化、其他 label 依赖关系）未被充分处理。

### 建议修复方向

- 方案 A：将外层 `<label class="new-account-field">` 改为 `<div class="new-account-field">`，同时确认所有 `.new-account-field` 相关的 CSS 不依赖 label 元素选择器
- 方案 B：在 checkbox 的 click 事件上 `stopPropagation()`，阻止事件冒泡到外层 label
- 方案 C：给外层 label 添加显式 `for` 属性，或改为 `<div>`，仅对"币种"这一个 field 做处理

需要 dev 评估哪种方案对现有结构影响最小。

### 影响范围

- 新开账户模块的多币种功能完全不可用
- 所有需要选择多币种的新开账户场景均受影响
- 不影响网银账单生成模块

---

## Bug 2：新增行币种输入框重复

### 复现步骤

1. 启动应用，切换到"新开账户生成网银账单"模块
2. 点击"新增"按钮添加一行银行账号
3. 观察新增行中"币种"字段的输入框

### 预期行为

新增行应包含一个币种文本输入框（与第一行结构一致）。

### 实际行为

新增行出现两个币种输入框（一个正常输入框 + 一个额外的输入框）。

### 根因分析方向

`addNewAccountRow()` 函数（renderer.js:813）使用 `sourceRow.cloneNode(true)` 深拷贝第一行来创建新行。

**关键问题**：在应用初始化时，`initializeNewAccountRow()` 会调用 `ensureCurrencyGhostShell(refs.currencyInput)`（renderer.js:747），该函数会动态修改 DOM 结构：

1. 在币种输入框外层包裹一个 `<div class="enum-input-shell">`
2. 在 shell 内插入一个 ghost input（`<input class="enum-ghost-input">`）用于自动补全提示

原始 HTML 中币种区域的结构：
```
<div class="new-account-currency-row">
  <input class="new-account-currency-input" />
  ...
</div>
```

初始化后变为：
```
<div class="new-account-currency-row">
  <div class="enum-input-shell">
    <input class="enum-ghost-input new-account-currency-input" />  <!-- ghost -->
    <input class="new-account-currency-input enum-active-input" /> <!-- 真实 -->
  </div>
  ...
</div>
```

当 `cloneNode(true)` 拷贝第一行时，连同已经注入的 ghost shell 和 ghost input 一起拷贝了。随后 `initializeNewAccountRow(clone)` 再次调用 `ensureCurrencyGhostShell()`，但此时克隆行中的 currency input 已经被 shell 包裹（因为是从已初始化的行拷贝的），`ensureCurrencyGhostShell` 检测到 shell 已存在就跳过创建——但克隆来的 ghost input 依然保留。

这导致新增行中出现**两个可见的币种输入框**：一个是 ghost input（本应是半透明的补全提示），一个是真实输入框。视觉上表现为"两个币种输入框"。

### 建议修复方向

- 方案 A：在 `addNewAccountRow()` 的 `cloneNode` 之后、`initializeNewAccountRow` 之前，清除克隆行中的 ghost shell 结构（移除 `.enum-input-shell` wrapper 和 `.enum-ghost-input`，将真实 input 还原到原始位置）
- 方案 B：改用模板方式创建新行（innerHTML 或 `<template>` 元素），而非 cloneNode 已初始化的行
- 方案 C：在 `ensureCurrencyGhostShell` 中增加去重逻辑，先清除已有 ghost input 再创建

需要 dev 评估最佳方案。

### 影响范围

- 新开账户模块中"新增"银行账号功能的视觉和交互异常
- 可能导致用户在错误的输入框中输入币种，数据读取逻辑取到空值
- 不影响第一行（默认行）的币种输入
- 不影响网银账单生成模块

---

## 验收标准

### Bug 1 验收标准

1. 点击"多币种账户" checkbox，checkbox 状态正常切换（checked / unchecked）
2. 选中 checkbox 后，币种输入框切换为下拉多选模式
3. 取消选中 checkbox 后，恢复为单币种文本输入模式
4. 以上行为在第一行和新增行中均正常工作

### Bug 2 验收标准

1. 点击"新增"按钮后，新增行仅显示一个币种输入框
2. 新增行的币种输入框具备自动补全提示功能（ghost input 正常工作）
3. 连续点击"新增"多次，每行均只有一个币种输入框
4. 新增行的所有字段（银行名称、所在地、币种、银行账号、开户日期）均可正常输入

### 通用验收标准

1. 修复不影响网银账单生成模块的现有功能
2. 修复不影响新开账户模块其他字段的输入和交互
3. 账户映射弹窗中的多币种 checkbox 功能不受影响

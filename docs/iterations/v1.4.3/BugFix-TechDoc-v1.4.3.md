# Bug 修复技术方案 - v1.4.3

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.3 |
| 日期 | 2026-03-24 |
| 状态 | 待评审 |
| 作者 | Dev |
| 关联 PRD | docs/iterations/v1.4.3/PRD-v1.4.3.md |

---

## 一、排查总结

上一次修复（已回滚）未能成功的原因是：两个 Bug 的根因分析不够深入，修复方向有偏差。本次通过逐行阅读代码，确认了两个 Bug 的真正根因。

---

## 二、Bug 1：多币种勾选框不可点击

### 2.1 根因分析

**根因：HTML `<label>` 嵌套导致 checkbox 点击被外层 label 劫持**

`index.html` 第 86-105 行的 DOM 结构如下：

```html
<label class="new-account-field">                    <!-- 外层 label (A) -->
  <span class="new-account-label">币种</span>
  <div class="new-account-currency-row">
    <input class="new-account-currency-input" />      <!-- 第一个 labelable 后代 -->
    <div class="new-account-currency-dropdown-wrap" hidden>
      ...
    </div>
    <label class="new-account-checkbox-label">        <!-- 内层 label (B) -->
      <input type="checkbox" />                       <!-- checkbox -->
      <span>多币种账户</span>
    </label>
  </div>
</label>
```

根据 HTML 规范，`<label>` 元素如果没有 `for` 属性，会隐式关联其**第一个 labelable 后代元素**。在上述结构中：

- **外层 label (A)** 的第一个 labelable 后代是 `<input class="new-account-currency-input" type="text">`（第 89 行），不是 checkbox
- **内层 label (B)** 的第一个 labelable 后代是 `<input type="checkbox">`

当用户点击 checkbox 时，事件处理流程如下：

1. 内层 label (B) 收到 click -> 切换 checkbox 状态（`checked` 变为 `true`）
2. click 事件**冒泡**到外层 label (A)
3. 外层 label (A) 的 activation behavior 触发 -> 激活其隐式关联的控件，即**币种文本输入框**
4. 浏览器在同一次事件循环中处理了两次 label activation，导致 checkbox 状态被**回滚**（不同浏览器行为略有差异，但普遍表现为 checkbox 点击无效或状态不稳定）

这就是为什么 checkbox "点不了"的真正原因。

### 2.2 上次修复为何失败

上次修复将币种字段的外层 `<label class="new-account-field">` 改为 `<div>`。方向是对的，但问题在于：

1. 只改了币种行的 `<label>` -> `<div>`，破坏了所有 `.new-account-field` 的 CSS 一致性（其他行仍用 `<label>`）
2. 可能引入了其他回归问题导致被回滚

### 2.3 修复方案

**方案：将所有 `.new-account-field` 的 `<label>` 统一改为 `<div>`**

理由：
- 这些 `<label>` 元素实际上没有使用 `for` 属性，仅作为布局容器使用
- `<label>` 的隐式关联行为是 Bug 的根因，且对其他字段行也可能在未来引发类似问题
- 改为 `<div>` 对样式无影响（`.new-account-field` 已定义 `display: flex; flex-direction: column`，与标签语义无关）
- 语义上，每个字段行中已有 `<span class="new-account-label">` 作为视觉标签，`<label>` 的语义作用可忽略

**修改文件：`index.html` 第 78-118 行**

将所有 `<label class="new-account-field">` ... `</label>` 改为 `<div class="new-account-field">` ... `</div>`：

```html
<!-- 改前 -->
<label class="new-account-field">
  <span class="new-account-label">银行名称</span>
  <input ... />
</label>

<!-- 改后 -->
<div class="new-account-field">
  <span class="new-account-label">银行名称</span>
  <input ... />
</div>
```

共需修改 5 处 `<label class="new-account-field">` 及其对应的 `</label>`：
1. 银行名称（第 78, 81 行）
2. 所在地（第 82, 85 行）
3. 币种（第 86, 105 行） -- **这是直接修复 Bug 的关键改动**
4. 银行账号（第 106, 114 行）
5. 开户日期（第 115, 118 行）

**无需修改 JS 和 CSS**：
- JS 中 `getNewAccountRowElements` 使用 class 选择器（`.new-account-bank-name-input` 等），不依赖 `<label>` 标签名
- CSS `.new-account-field` 选择器是 class 选择器，不限定标签名
- `addNewAccountRow` 的 `cloneNode(true)` 克隆 DOM 节点，与标签名无关

### 2.4 影响分析

- 仅影响 `index.html` 的新开账户模块 DOM 结构
- 无 CSS 变更、无 JS 变更
- 对辅助功能（accessibility）的影响极小：这些 label 本就没有正确的语义关联（无 `for` 属性），改为 div 不降低可访问性

---

## 三、Bug 2：新增行币种输入框重复

### 3.1 根因分析

**根因：`cloneNode(true)` 克隆了已被 `ensureCurrencyGhostShell` 改造过的 DOM 结构，导致 ghost input 被误识别为真实 currency input**

详细的事件链：

**步骤 1：首行初始化后的 DOM 结构**

`initializeNewAccountRow`（第 744 行）对首行调用 `ensureCurrencyGhostShell(refs.currencyInput)`（第 747 行）。该函数（第 398-419 行）会：

1. 创建 `.enum-input-shell` div 包裹 currency input
2. 在 shell 内、currency input **之前**插入一个 ghost input

ghost input 的 className 赋值（第 411 行）：
```javascript
ghostInput.className = `${input.className} enum-ghost-input`;
```

原 input 的 className 是 `new-account-input new-account-currency-input`，所以 ghost input 的 className 变为：
```
new-account-input new-account-currency-input enum-ghost-input
```

首行初始化后 DOM 结构：
```html
<div class="enum-input-shell">
  <input class="new-account-input new-account-currency-input enum-ghost-input" />  <!-- ghost（排在前面） -->
  <input class="new-account-input new-account-currency-input enum-active-input" /> <!-- 真实 input -->
</div>
```

**步骤 2：cloneNode 克隆 DOM**

`addNewAccountRow`（第 813 行）执行 `sourceRow.cloneNode(true)`（第 820 行），深拷贝整行 DOM。克隆结果中 `.enum-input-shell` 及其两个子 input 都被原样复制。

**步骤 3：getNewAccountRowElements 指向错误元素**

`initializeNewAccountRow(clone, defaults)` 被调用（第 830 行），其中 `getNewAccountRowElements(row)`（第 745 行）执行：
```javascript
currencyInput: row.querySelector('.new-account-currency-input')
```

`querySelector` 返回 DOM 中**第一个**匹配元素。在克隆行中，ghost input 排在真实 input 之前（因为 `insertBefore` 的位置关系），且 ghost input 也带有 `.new-account-currency-input` class。

**因此 `refs.currencyInput` 指向了 ghost input，而不是真实的 currency input。**

**步骤 4：ensureCurrencyGhostShell 将 ghost input 变为"活跃"状态**

`ensureCurrencyGhostShell(refs.currencyInput)` 被调用（第 747 行），此时传入的是 ghost input：

1. 检查 `input.parentElement?.classList.contains('enum-input-shell')` -- ghost input 的 parent 确实是 shell -> `shell` 被赋值（不创建新 shell）
2. 检查 `shell?.querySelector('.enum-ghost-input')` -- 找到 ghost input 自身（它有 `enum-ghost-input` class）-> `ghostInput` 被赋值（不创建新 ghost）
3. 执行 `input.classList.add('enum-active-input')` -- 给 ghost input 添加了 `enum-active-input` class

**结果：ghost input 现在同时拥有 `enum-ghost-input` 和 `enum-active-input` 两个 class。**

在 CSS 中：
- `.enum-ghost-input`：`position: absolute; pointer-events: none; opacity: 1`
- `.enum-active-input`：`position: relative; z-index: 1`

`enum-active-input` 的 `position: relative` 覆盖了 `enum-ghost-input` 的 `position: absolute`（因为两者都是类选择器，后出现的或优先级更高的生效）。这导致 ghost input **脱离了绝对定位**，变成了一个**可见的、占据空间的第二个输入框**。

**这就是为什么新增行会出现两个币种输入框。**

### 3.2 上次修复为何失败

上次修复在 `addNewAccountRow` 中 clone 后清理 `.enum-input-shell`。但问题不在于 shell 被克隆，而在于 ghost input 的 className 包含了 `.new-account-currency-input`，导致 `querySelector` 选中了错误的元素。简单清理 shell 可能破坏后续 `ensureCurrencyGhostShell` 的正确执行流程。

### 3.3 修复方案

**方案：在 `ensureCurrencyGhostShell` 创建 ghost input 时，不复制原 input 的业务 class**

修改 `ensureCurrencyGhostShell` 函数（`renderer.js` 第 409-416 行）中 ghost input 的 className 赋值逻辑：

```javascript
// 改前（第 411 行）
ghostInput.className = `${input.className} enum-ghost-input`;

// 改后
ghostInput.className = 'new-account-input enum-ghost-input';
```

**但此方案过于硬编码，不够通用。** 更好的方案是让 ghost input 不包含可能导致误选的业务 class：

**推荐方案：在 `addNewAccountRow` 的 clone 流程中，清理 ghost shell 结构后重建**

修改 `addNewAccountRow` 函数（第 813-832 行），在 `cloneNode(true)` 之后、`initializeNewAccountRow` 之前，清理 clone 中的 enum-input-shell 结构：

```javascript
function addNewAccountRow(defaults = {}) {
  const sourceRow = getNewAccountRows()[0];
  if (!sourceRow) return;

  const clone = sourceRow.cloneNode(true);
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));

  // --- 新增：清理克隆行中的 ghost shell 结构 ---
  clone.querySelectorAll('.enum-input-shell').forEach((shell) => {
    const realInput = shell.querySelector('.enum-active-input');
    if (realInput) {
      realInput.classList.remove('enum-active-input');
      shell.parentNode.insertBefore(realInput, shell);
    }
    shell.remove();
  });
  // --- 新增结束 ---

  clone.querySelectorAll('input').forEach((input) => {
    if (input.type === 'checkbox') {
      input.checked = false;
    } else {
      input.value = '';
    }
  });
  elements.newAccountRows.appendChild(clone);
  initializeNewAccountRow(clone, defaults);
  syncNewAccountAddButtonVisibility();
  handleNewAccountFormMutation();
}
```

这样：
1. 克隆后，找到 shell 内的真实 input（带 `enum-active-input` class）
2. 将真实 input 移回 shell 的父节点（恢复原始 DOM 位置）
3. 移除 shell 及其内部的 ghost input
4. 后续 `initializeNewAccountRow` -> `ensureCurrencyGhostShell` 会从零创建全新的 shell 和 ghost input

**此方案的优点：**
- 不修改 `ensureCurrencyGhostShell` 的核心逻辑，避免影响其他调用方
- clone 后的 DOM 恢复到与 HTML 模板一致的原始状态，`initializeNewAccountRow` 正常执行
- ghost input 的 className 复制逻辑（`${input.className} enum-ghost-input`）无需修改，其设计意图是让 ghost 继承真实 input 的样式以正确显示建议文本

### 3.4 影响分析

- 仅影响 `addNewAccountRow` 函数
- `resetNewAccountRows`（第 835 行）对首行调用 `initializeNewAccountRow`，首行不经过 clone，不受影响
- `ensureCurrencyGhostShell` 的幂等性检查（`input.parentElement?.classList.contains('enum-input-shell')`）在清理后的 clone 行上正确执行（input 的 parent 不是 shell -> 正常创建新 shell）

---

## 四、修复变更汇总

| 文件 | 变更类型 | Bug | 描述 |
|------|----------|-----|------|
| `index.html` | DOM 修改 | Bug 1 | 5 处 `<label class="new-account-field">` 改为 `<div class="new-account-field">`，对应的 `</label>` 改为 `</div>` |
| `src/renderer.js` | 逻辑修改 | Bug 2 | `addNewAccountRow` 函数中 `cloneNode(true)` 之后新增 ghost shell 清理逻辑（约 6 行代码） |

无 CSS 变更。

---

## 五、与 v1.4.3 其他需求的关系

| 需求 | 关系 |
|------|------|
| 需求 5（多币种按钮修复与改造）| Bug 1 修复是需求 5 的前置条件。Bug 修复后 checkbox 可正常点击，多币种功能恢复，再进行序号显示等改造 |
| 需求 6（新增按钮位置修正）| Bug 1 修复将 `<label>` 改为 `<div>` 后，需求 6 中 "按钮移入 label 可能影响点击行为" 的风险消除（已不是 label） |
| 其他需求 | 无影响 |

---

## 六、测试验证要点

### Bug 1 验证

| 场景 | 预期行为 |
|------|----------|
| 首行：点击"多币种"checkbox | checkbox 状态正常切换，币种输入框切换为下拉框 |
| 首行：取消勾选"多币种"checkbox | checkbox 取消勾选，下拉框切换回文本输入框 |
| 首行：连续快速点击 checkbox | 状态正确响应每次点击 |
| 新增行：点击"多币种"checkbox | 同首行表现 |

### Bug 2 验证

| 场景 | 预期行为 |
|------|----------|
| 点击"新增"添加一行 | 新行币种区域只有一个输入框，无重复 |
| 添加多行（3+行） | 每行币种区域均只有一个输入框 |
| 新增行输入币种 | 自动补全建议正常显示（ghost input 正常工作） |
| 新增行勾选多币种 | 切换为下拉框，功能正常 |

### 回归验证

| 场景 | 预期行为 |
|------|----------|
| 银行名称/所在地/银行账号/开户日期字段 | 点击字段区域仍可正常聚焦到输入框（虽然不再有 label 隐式关联，但用户习惯是直接点击 input） |
| 首行币种自动补全 | ghost input 正常显示建议文本 |
| 填写完整后点击"生成" | 网银账单正常生成 |

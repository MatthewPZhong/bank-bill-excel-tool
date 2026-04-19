# TechDoc - 网银账单小助手 v1.5.2

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.2 |
| 日期 | 2026-04-16 |
| 作者 | Dev |
| 状态 | 定稿（终稿修订 2026-04-16） |
| 关联 PRD | `docs/iterations/v1.5.2/PRD-v1.5.2.md`（24 条 AC：AC1-1~AC1-4 + AC2-1~AC2-11 + AC3-1~AC3-9） |
| 依赖 | v1.5.1 已 merged 到 main；v1.5.2 从 v1.5.x 起分支；package.json version 将从 `1.5.1` 升为 `1.5.2` |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §6.1 需求 1 主/子模板名校验 | 纯前端判断。校验逻辑插在 `src/renderer-dialogs.js:2542` 的 `doneBtn.click` handler 最前面；`createAlertDialog` 已有现成封装。**零** DB/IPC 改动。低风险。 |
| §6.2 需求 2 单账号匹多文件 | 纯前端 UI 改造 + 状态机。后端 `file:complete-big-account-selection`（`src/main.js:6633`）协议不变——前端把 M:1 展开成 M 条 `assignments` 即可。UI 改动集中在 `createBigAccountSelectionDialog`（`src/renderer-dialogs.js:565-1147`）。中等工作量，风险主要在状态机边界（取消/切换/二次编辑）。 |
| §6.3 需求 3 按文件名映射模板 | 数据库新增 1 列；Repository + IPC + 前端三端联动；Bundle 字段扩展。匹配算法与 v1.5.1 `matchFileToTemplate`（`src/main.js:5273`）可复用表头校验；导入分支沿用主模板导入子模板的 `parentProvisionalEntries` 管线（`src/main.js:6009-6066`）。中等工作量。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | 需求 2 的"组内 M:1 展开为 M 条 assignments"需要考虑**单文件多 block**场景：`src/main.js:881` `applyBigAccountAssignmentsToFileEntries` 依赖 `identifyAccountBlocks` 把文件切成 N 块，一块一个 rowIndex。多对一语义下，某文件若有 3 个 block，是否全部覆盖？ | ✅ **PM 已拍板 2026-04-16：①B** — **只覆盖用户勾选的那个 block**（勾选粒度 = block）。§四 所有设计按 block 粒度重写：组结构字段从 `leftFileIndices` 改为 `leftBlockRowIndices`（直接存 `rows[i].index` / 即 `rowIndex`）；`buildBigAccountSelectionRows` 的 `fileIndex` 仅作"同文件 block 折叠可视化"的辅助字段，**不**作为 M:1 展开的 key；展开 key = `rowIndex`。 |
| R-2 | ~~需求 3 `filename_fixed_field` 空串匹配陷阱~~ **已失效**：最终方案改为纯表头匹配，不使用 `filenameFixedField` | 无需处理 |
| R-3 | 需求 3 主页面选「按文件名映射模板」时 `state.selectedTemplateId === '__FILENAME_MAPPING__'`，现有 `getTemplateMappingConfig(templateId)` 会找不到模板 → `TEMPLATE_NOT_FOUND`。需要在 `file:import` handler 顶部提前分流 | §四 详细设计分支 |
| R-4 | 需求 3 整批截断需要**清理** `statementImportSessions` 的 provisional 残留；当前 `file:import` 在 `resolveImportFileSelection` 通过后才会写入 session，因此新分支在表头/文件名校验阶段返回即可，不会遗留数据 | §四 2.3 复核 |
| R-5 | v1.5.1 `matchFileToTemplate` 对 headers 长度相同的"集合相等"比对有隐含"子集匹配"逻辑（`:5297-5299`），需求 3 需的是"给定某模板后是否匹配"，不是"从多个模板里挑"，Dev 建议**新增**一个简单的 `matchesTemplateHeaders(filePath, template)` 只做 boolean 判定避免误用 | §四 新增工具函数 |
| R-6 | 需求 2 "完成"按钮是"组闭合"按钮，与对话框主"完成"按钮同名同位，用户可能混淆；UI 上需明显区分（字号/颜色/位置） | 由 PM + 设计复核；Dev 在实现时把两按钮放在不同的行/区域，并以文字"结束当前编辑"替代"完成"（待 PM 确认是否改文案） |
| R-7 | Bundle 版本升级为 v5 会导致 v1.5.1 用户拒绝导入 v1.5.2 导出的 bundle（`main.js:1206-1211`）；若保持 v4 schema 透明扩展则 v1.5.1 只是忽略新字段，向后兼容更好 | ✅ **PM 已拍板 2026-04-16：③A — 保持 v4 透明扩展**。`SUPPORTED_BUNDLE_VERSION` 仍 `4`；已复核 `readTemplateBundleFile`（`src/main.js:1213-1235`）为对象解构式解析，未知字段自然忽略，不做 schema 校验，确认向下兼容成立。详见 §5.1.7。 |

### 1.3 与 PRD 的差异

- **R-1 关于单文件多 block 语义**：初稿 TechDoc §三 默认"A 方案"（整文件共享同一值），与 PRD 初稿方向一致；2026-04-16 用户拍板 **①B**（只覆盖被勾选 block），本轮 Reverse Sync 已全量同步修改至 §四、§七、§八、§十，本文档不再保留 A 方案残留。
- **R-7 关于 Bundle**：初稿 PRD §6.3.1 建议升为 v5；Dev 倾向保持 v4 透明扩展。2026-04-16 用户拍板 **③A — v4 透明扩展**；已落地到 §5.1.7（Bundle 策略段仅保留 A 方案）。
- **需求 3 设计变更**：初稿设计为"按文件名关键字匹配 + 表头二次校验"；最终实现改为**纯表头自动识别**（`matchesTemplateHeaders`）。`filenameFixedField` 数据库字段、映射管理 UI 模块、相关 CSS 均已删除或未落地。新增表头唯一性校验 `findConflictingTemplateByHeaders` 和多模板合并导出 `mergeGeneratedXlsxFiles` / `generateMultiTemplateGroupFiles`。
- **需求 2 UI 差异**：初稿设计为默认勾选 + 编辑/完成两个按钮；最终实现为默认不勾选 + 单个 toggle 按钮 (`.ba-multi-toggle-btn`)。

---

## 二、涉及的文件清单（终稿）

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/main.js` | 修改 | 新增 `FILENAME_MAPPING_TEMPLATE_ID` 常量 (`:127`) + `isFilenameMappingMode` helper (`:128`)；新增 `findConflictingTemplateByHeaders` (`:6261`)；新增 `matchesTemplateHeaders` (`:6273`)；新增 `handleFilenameMappingImport` (`:6291`)；新增 `mergeGeneratedXlsxFiles` (`:5249`)；改造 `generateMultiTemplateGroupFiles` (`:5291`)；`exportStatementByScope` 虚拟 ID 分支 (`:5842`)；`template:import` 表头唯一性校验 (`:3425`)；`template:import-bundle` 表头唯一性校验 (`:3877`)；`rebuildMatchedTemplateFileEntries` (`:625`) |
| `src/renderer-dialogs.js` | 修改 | `createMappingDialog` 完成按钮新增名称校验（需求 1）；`createBigAccountSelectionDialog` 多对一工具条 + 状态机 + `renderFileList` (`:679`) + `getGroupLetter` (`:670`) + `syncMultiToolbar` (`:1040`)；`extractOrderBtn` 过滤已映射 block (`:1312`)；映射管理 UI 的 `insertFilenameFixedFieldRows` 函数及相关调用**已删除** |
| `src/renderer.js` | 修改 | 主页面下拉默认选「按文件名映射模板」；导出按钮文本改为"当前批次文件"/"所有批次文件" (`:1460-1461`) |
| `src/styles.css` | 修改 | 新增 `.ba-multi-toggle-btn` (`:1247`)、`.ba-left-letter`、`.ba-multi-editing`、`.ba-multi-grouped` 等样式；`.mapping-filename-fixed-*` 相关样式**已删除** |
| `package.json` | 修改 | `version`: `1.5.1` → `1.5.2` |

---

## 三、需求 1：主/子模板的模板名校验

### 3.1 实现方案

前置校验放在 `src/renderer-dialogs.js:2542` 的 `doneBtn.click` handler **最前面**（优先于 `saveMappings(draftMappings)` 调用），条件命中时弹 `createAlertDialog` 并 `return`，**整个** click handler 中止，确保 mappings 不保存、主/子关系不更新。

**决策对齐**：决策 D1 — 使用 `subName.includes(parentName)` 做"子包含主"判定，无大小写/空格规范化。

```javascript
// src/renderer-dialogs.js:2542 附近（伪码，不动现有结构）
dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
  // v1.5.2 需求 1：子/主模板名校验（必须在 saveMappings 之前）
  if (isChildCheckbox.checked && parentSelect.value) {
    const parentId = Number(parentSelect.value);
    const parentTemplate = (state.templates || []).find((t) => String(t.id) === String(parentId));
    const currentName = String(payload.template.name || '');
    const parentName = String(parentTemplate?.name || '');

    // 子模板名必须包含主模板名
    if (!parentName || !currentName.includes(parentName)) {
      openModal(createAlertDialog('子模板与主模板模板名匹配不上，请检查。', {
        onConfirm: () => {
          // 点确认后返回映射关系管理页面（保留已编辑内容）
          openModal(createMappingDialog(payload));
        }
      }));
      return; // 阻断 saveMappings 调用
    }
  }

  // 以下沿用现有逻辑：saveMappings → setParentStatus → setChildParent …
  const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
  const draftMappings = collectMappingDraftFromTable(tbody);
  // … 现有保存流程 …
});
```

**为什么不在后端校验**：后端 `template:set-child-parent`（`src/main.js:3368`）只负责写库，前端早拦截可以避免 mappings 先写成功、主/子关系后失败导致的不一致。如用户希望兜底，`setChildParent` 也可加一层服务端校验，但本次 PRD 未要求，不实现。

### 3.2 改动点

| 文件 | 行号（约） | 改动内容 |
|------|-----------|---------|
| `src/renderer-dialogs.js` | :2542 `doneBtn.click` handler 第一行 | 新增 ~15 行校验代码 |

### 3.3 注意事项

- `createAlertDialog` 现有实现支持 `{ onConfirm }` 回调，重新 `openModal(createMappingDialog(payload))` 可以还原用户的编辑状态（payload 来自 `createMappingDialog` 接收的同一引用），但 `currentBigAccounts` / `currentFixedAssignments` 等 `let` 局部变量在新 `createMappingDialog` 调用时会**重置**。**风险**：若用户希望 retry 时保留之前的局部修改，需要把这些 let 变量通过 payload 透传回去，或直接"关闭对话框 + 提示用户重新打开"。最小改动建议：保持现状（用户点"确认"后回到原始数据），实际测试后再视需要改进。
- `parentSelect.value` 在用户仅勾了"设为子模板"但尚未选主模板时为 `""` → `parentTemplate` 为 undefined → 跳过校验（与 PRD §6.1.1 "未选主模板 不触发校验" 一致）。

---

## 四、需求 2：大账号确认页支持「单个账号匹多个文件」

### 4.1 实现方案

#### 4.1.1 UI 片段（HTML 最终实现）

`src/renderer-dialogs.js:605-620` footer 工具条：

```html
<div class="dialog-actions big-account-selection-footer">
  <button class="secondary-btn small extract-order-btn" type="button" data-action="extract-order">提取大账号顺序</button>
  <label class="ba-multi-mode-label">
    <input class="new-account-checkbox ba-multi-mode-checkbox" type="checkbox" />
    <span>单个账号匹多个文件</span>
  </label>
  <button class="secondary-btn small ba-multi-toggle-btn is-hidden" type="button">编辑</button>
  <!-- ... 搜索/记住/主完成 按钮 ... -->
</div>
```

**与初稿差异**：
- 默认**不勾选**（`multiMode = false`, `multiEditing = false`，HTML 无 `checked`）
- 初稿的"编辑"+"完成"两个按钮合并为 **1 个 toggle 按钮** `.ba-multi-toggle-btn`（`:612`），文本在"编辑"/"完成"之间切换
- toggle 按钮默认 `is-hidden`（`visibility: hidden` 占位不平移），勾选 checkbox 后显示

#### 4.1.2 前端状态机（决策 ①B：block 粒度）

在 `createBigAccountSelectionDialog` 作用域内新增状态变量（与现有 `checkedOrder`、`isRememberMode` 并列）：

```javascript
// src/renderer-dialogs.js:639-642
let multiMode = false;               // 对应勾选框，默认 false（不勾选）
let multiEditing = false;            // 默认非编辑态
let multiGroups = [];                // [{ leftBlockRowIndices:number[], rightAccount:{merchantId,currency} | null }]
let pendingGroup = null;             // 当前正在构建的组
```

**`syncMultiToolbar`**（`:1040-1047`）：根据 `multiMode` 和 `multiEditing` 同步 toggle 按钮的可见性和文本。

**决策 ①B 要点**：勾选单位是 **block**（对应 `currentFileRows` 每一行 = 每个 block），不是文件。`fileIndex`（由 `buildBigAccountSelectionRows` 注入，见 §4.1.3）仅用于可视化聚合或未来"按文件折叠"展示，**不**作为状态机 key。

**左右侧勾选事件改造**：
- 左侧 block 项新增 `<input type="checkbox" class="ba-left-block-checkbox">`（仅在 `multiMode && multiEditing` 时显示，否则渲染原数字序号）；勾选框 dataset 记录 `rowIndex`（即 `currentFileRows[i].index`）。
- 右侧大账号项复用原 `big-account-order-checkbox`，但在 `multiMode && multiEditing` 时 `big-account-order-index` 的 textContent 渲染为字母 `a/b/c...`（按组序号，非按勾选顺序）。

**配对逻辑（伪码 — block 粒度）**：

```javascript
function onLeftBlockChecked(rowIndex, checked) {
  if (!multiEditing) return;
  if (checked) {
    if (!pendingGroup) {
      pendingGroup = { leftBlockRowIndices: [rowIndex], rightAccount: null, startedBy: 'left' };
    } else {
      // 已有 pendingGroup → 追加本 block
      pendingGroup.leftBlockRowIndices.push(rowIndex);
    }
    // 如果 pendingGroup 在"先勾右侧"场景下已经有 rightAccount，本次追加左侧后仍在同组
  } else {
    // 取消某个已勾选的 block：从 pendingGroup 或已闭合组中移除
    removeBlockFromCurrentOrClosedGroup(rowIndex);
  }
  renderAlphaIndex();
}

function onRightAccountChecked(account, checked) {
  if (!multiEditing) return;
  if (checked) {
    if (pendingGroup && pendingGroup.rightAccount) {
      // 已绑大账号再勾新大账号 → 闭合旧组，开始新组
      closeGroup(pendingGroup);
      pendingGroup = { leftBlockRowIndices: [], rightAccount: account, startedBy: 'right' };
    } else if (pendingGroup) {
      pendingGroup.rightAccount = account;
    } else {
      pendingGroup = { leftBlockRowIndices: [], rightAccount: account, startedBy: 'right' };
    }
  } else {
    // 取消大账号：若它属于 pendingGroup 则清空 rightAccount；否则从已闭合组中移除
  }
  renderAlphaIndex();
}

function onMultiDoneClick() {
  // 编辑态结束：闭合 pendingGroup（若有效），冻结 multiGroups，清掉字母序号
  if (pendingGroup && pendingGroup.leftBlockRowIndices.length > 0 && pendingGroup.rightAccount) {
    closeGroup(pendingGroup);
  }
  pendingGroup = null;
  multiEditing = false;
  // 字母索引 → 隐藏；左侧已入组 block 显示"✓ 文件名 第N行 → 大账号"；未入组 block 按旧数字序号渲染
  rerenderAfterMultiDone();
}

function onMultiEditClick() {
  // 重新进入编辑态：D3 字母序号从 a 重开（multiGroups 不清空 —— 用户可继续追加新组）
  multiEditing = true;
  pendingGroup = null;
  renderAlphaIndex();  // 重新分配 a/b/c...
}
```

**字母序号分配**：按 `multiGroups` 数组索引 + `pendingGroup` 追加后的位置渲染。渲染时对每个右侧 `big-account-order-item` 查该大账号所属组的 index，若命中则 span 填 `String.fromCharCode(97 + index) + '.'`；否则保留原数字序号（取决于是否 multiEditing）。

#### 4.1.3 主"完成"按钮的展开发送（按 block 粒度，key = rowIndex）

`doneBtn.click`（`src/renderer-dialogs.js:1105`）改造：

```javascript
doneBtn.addEventListener('click', async () => {
  // v1.5.2 需求 2（决策 ①B）：若 multiMode=true 且有 multiGroups，按 block 粒度展开为 assignments
  let finalAssignments;
  if (multiMode && multiGroups.length > 0) {
    finalAssignments = [];

    // 1. 多对一组展开：每被勾选 block 产生一条 assignment
    //    key = rowIndex（即 currentFileRows[i].index，天然精确到 block）
    //    决策 ①B：**只**展开用户实际勾选的 rowIndex，不做"同文件其他 block 联动"
    const coveredRowIndices = new Set();
    multiGroups.forEach((group) => {
      group.leftBlockRowIndices.forEach((rowIndex) => {
        finalAssignments.push({
          rowIndex,
          merchantId: group.rightAccount.merchantId,
          currency: group.rightAccount.currency
        });
        coveredRowIndices.add(rowIndex);
      });
    });

    // 2. 未入组的 block：沿用 checkedOrder（1:1 旧逻辑，决策 D4）
    //    checkedOrder 是按 currentFileRows 下标顺序的 1:1 勾选结果；跳过已被多对一组覆盖的 rowIndex
    checkedOrder.forEach((item, idx) => {
      const row = currentFileRows[idx];
      if (!row || coveredRowIndices.has(row.index)) return;
      finalAssignments.push({
        rowIndex: row.index,
        merchantId: item.merchantId,
        currency: item.currency
      });
    });

    // 按 rowIndex 排序（`applyBigAccountAssignmentsToFileEntries` 内部基于 globalBlockIndex 消费）
    finalAssignments.sort((a, b) => a.rowIndex - b.rowIndex);
  } else {
    // 无多对一 → 走原逻辑
    finalAssignments = checkedOrder.map((item, index) => ({
      rowIndex: index, merchantId: item.merchantId, currency: item.currency
    }));
  }

  if (finalAssignments.length !== currentFileRows.length) {
    setStatus(`请勾选 ${currentFileRows.length} 个大账号（当前已选 ${finalAssignments.length}）`, 'error');
    return;
  }

  // 以下沿用 v1.5.1 流程
  const result = await desktopApi.files.completeBigAccountSelection({
    assignments: finalAssignments,
    mode: currentMode
  });
  // … 后续处理
});
```

**为什么 key = `rowIndex` 而不是 `(fileIndex, blockIndex)` 组合 key**：
- `buildBigAccountSelectionRows`（`src/main.js:857`）生成的 `rows[i].index` 是全局 block 顺序号，已经天然精确定位到"第几个文件的第几个 block"；
- 后端 `applyBigAccountAssignmentsToFileEntries`（`main.js:881`）内部维护 `globalBlockIndex` 作为 assignment 的查找 key，本身就是 block 粒度；
- 因此 `rowIndex` 单一字段已等价于组合 key，无需在前后端之间新增两个字段。

**关于 `fileIndex` 的保留**：仍在 `buildBigAccountSelectionRows` 里追加 `fileIndex` 字段（用于前端"同一文件多 block 折叠显示"或未来可视化分组），但它**不**参与 M:1 状态机的 key 判定。修改点：

```javascript
// src/main.js:857
fileEntries.forEach((entry, fileIndex) => {
  const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });
  blocks.forEach((block) => {
    rows.push({
      index: rowIndex,
      fileIndex,                        // ← v1.5.2 新增（可视化辅助，非状态机 key）
      sourceRowNumber: block.startRowNumber,
      fileName: path.basename(entry.filePath),
      filePath: entry.filePath,
      blockStartIndex: block.startIndex,
      blockEndIndex: block.endIndex
    });
    rowIndex += 1;
  });
});
```

**`renderFileList`**（`src/renderer-dialogs.js:679`）改造为四分支渲染：
- **编辑态**（`multiMode && multiEditing`）：保持原始顺序不排序，每行有 checkbox (`.ba-left-block-checkbox`) + 字母列 (`.ba-left-letter`) + 文件名
- **闭合态已入组 block**（`multiMode && !multiEditing && covered`）：显示 "check-mark a. 文件名 → 大账号"
- **multiMode 但未入组**：字母列留空 + 数字序号
- **非 multiMode**：原始数字序号渲染

**完成态排序逻辑**（`:691-701`）：uncovered 在前（原序），covered 在后按组 a→z 排（组内按 `originalIndex`）。

**`getGroupLetter(rowIndex)`**（`:670-677`）：查询某 rowIndex 所属组的字母（闭合组索引 or pendingGroup 追加位置）。

**编辑还原**：点编辑**保留 `multiGroups`**（不清空），恢复原始排序。

#### 4.1.4 后端零侵入

`file:complete-big-account-selection`（`src/main.js:6633`）、`applyBigAccountAssignmentsToFileEntries`（`:881`）**不改**。因为：
- 前端展开后 `assignments.length === expectedRows.length`（即 block 总数），通过原校验；
- 每个 block 的 `rowIndex` 仍对应 `applyBigAccountAssignmentsToFileEntries` 的 `globalBlockIndex`；
- M:1 语义通过"同一组的多个 rowIndex 共享同一 MerchantId+Currency"实现，后端感知不到是 1:1 还是 M:1。

### 4.2 改动点（终稿行号）

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `src/renderer-dialogs.js` | `:605-620` | footer 多对一工具条（checkbox + toggle 按钮） |
| `src/renderer-dialogs.js` | `:632-642` | DOM 引用 + 状态变量初始化（`multiMode=false`, `multiEditing=false`） |
| `src/renderer-dialogs.js` | `:670-677` | `getGroupLetter(rowIndex)` |
| `src/renderer-dialogs.js` | `:679-775` | `renderFileList()` 四分支渲染改造 |
| `src/renderer-dialogs.js` | `:875` | `isRowIndexCovered` 辅助函数 |
| `src/renderer-dialogs.js` | `:1040-1047` | `syncMultiToolbar()` toggle 按钮同步 |
| `src/renderer-dialogs.js` | `:1310-1317` | `extractOrderBtn` 过滤 `extractableRows`（已映射 block 不参与提取） |
| `src/styles.css` | `:1247-1258` | `.ba-multi-toggle-btn`、`.ba-multi-toggle-btn.is-hidden`（`visibility: hidden` 占位） |

### 4.3 注意事项

- **已映射 block 不参与提取**：`extractOrderBtn` 点击时过滤 `extractableRows`（`:1312-1317`），只对未入组 block 执行提取；确认弹窗只显示 `extractableRows`。
- **导出按钮文本**：scope 选择弹窗按钮文本改为"导出当前批次文件的{明细/余额}"/"导出所有批次文件的{明细/余额}"（`src/renderer.js:1460-1461`）。
- **mode 切换清空状态**：`syncModeUI`（`:1059-1061`）在切换 fixed/non-fixed 时清空 `multiGroups` + `pendingGroup`，避免 rowIndex 空间变化后对不上。
- **单文件多 block 渲染（决策 ①B 锁定）**：保持每 block 一行（`src/renderer-dialogs.js:679`）；每 block 独立勾选框；勾某文件的任一 block **不**联动其他 block。
- **编辑还原**：点编辑**保留 `multiGroups`**（不清空），只清空 `pendingGroup` 并恢复原始排序。

---

## 五、需求 3：从"按文件名映射"改为"按表头自动识别"（终稿）

### 5.1 实现方案

**设计变更**：初稿设计为"按文件名关键字匹配 → 表头二次校验"二步走方案。最终实现改为**纯表头自动识别**——不再使用 `filenameFixedField` 文件名关键字，直接以表头匹配所有已有模板。映射管理 UI 中的"按文件名映射模板"输入框模块已删除。

#### 5.1.0 虚拟 ID 短路 helper

`__FILENAME_MAPPING__` 仍为纯 UI 下拉值，不对应 `templates` 表任何真实记录。

```javascript
// src/main.js:127-129
const FILENAME_MAPPING_TEMPLATE_ID = '__FILENAME_MAPPING__';
function isFilenameMappingMode(templateId) {
  return templateId === FILENAME_MAPPING_TEMPLATE_ID;
}
```

调用点（已确认生效行号）：

| 调用点 | 文件:行号 |
|-------|----------|
| `file:import` handler 顶部分流 | `src/main.js:6651` |
| `getTemplateMappingConfig` 前置判断 | `src/main.js:1759` |
| `exportStatementByScope` 虚拟 ID 分支 | `src/main.js:5815` |
| `generateMultiTemplateGroupFiles` 返回值 | `src/main.js:5428` |
| `handleFilenameMappingImport` session 及返回值（多处） | `src/main.js:6446,6488,6504,6525,6586,6600,6617,6636` |
| `file:complete-big-account-selection` 虚拟 ID 分支 | `src/main.js:7468,7479` |

#### 5.1.1 表头匹配函数

`matchesTemplateHeaders`（`src/main.js:6273`）：用 `readRowsWithMetadata` 尝试读取，表头不匹配时 `FileValidationError` 含 `'表头'` 则返回 false，其他异常向上抛出。

```javascript
// src/main.js:6273-6285
function matchesTemplateHeaders(filePath, template) {
  const headers = Array.isArray(template?.headers) ? template.headers : [];
  if (headers.length === 0) return false;
  try {
    readRowsWithMetadata(filePath, headers);
    return true;
  } catch (error) {
    if (error instanceof FileValidationError && typeof error.message === 'string' && error.message.includes('表头')) {
      return false;
    }
    throw error;
  }
}
```

#### 5.1.2 导入流程 — `handleFilenameMappingImport`（`src/main.js:6291`）

**最终实现**与初稿有重大差异：

- **步骤 1**：`const allTemplates = database.listTemplates()` 取所有模板（**不再过滤** `filenameFixedField`）
- 对每个文件：`allTemplates.filter((t) => matchesTemplateHeaders(filePath, t))` **直接用表头匹配**
- 0 命中 → `FILENAME_MAPPING_NO_MATCH`（文案："无法通过表头匹配任何已有模板"，`:6350`）
- >=2 命中 → `FILENAME_MAPPING_AMBIGUOUS`（文案："表头同时匹配到多个模板"，`:6360`）
- 唯一命中 → 继续（**无 `HEADER_MISMATCH` 报错**，表头匹配本身就是筛选条件）
- **步骤 2（表头二次校验）已删除** — 初稿中的"文件名匹配后做表头校验"已无意义
- 步骤 3（`:6368-6408`）：为每个文件构造 `parentProvisionalEntries`，`matchedTemplateId` 保持在 entry 上
- 步骤 4（`:6410-6440`）：聚合大账号（含子模板 → 主模板兜底）
- 步骤 5-7：复用 `resolveImportFileSelection` + 大账号选择流程

**已删除的初稿代码/概念**：
- `eligibleTemplates` 过滤 `filenameFixedField` 非空模板 → 已删除
- `basename.includes(t.filenameFixedField)` 文件名关键字匹配 → 已删除
- `FILENAME_MAPPING_HEADER_MISMATCH` 错误码 → 已删除
- 映射管理 UI 的 `insertFilenameFixedFieldRows` 函数及调用 → 已删除（`src/renderer-dialogs.js`）
- CSS `.mapping-filename-fixed-*` 相关样式 → 已删除（`src/styles.css`）

#### 5.1.3 表头唯一性校验（新增功能，初稿未含）

为保障表头自动识别的可靠性，新增表头唯一性校验工具函数：

`findConflictingTemplateByHeaders(headers, excludeId)`（`src/main.js:6261`）：遍历所有模板，比对 `JSON.stringify(headers)` 是否相同（排除自身）。

**调用点**：

| 调用点 | 文件:行号 | 行为 |
|-------|----------|------|
| `template:import` handler | `src/main.js:3425` | `upsertTemplate` 前校验；重复时报 `TEMPLATE_HEADERS_DUPLICATE`，拒绝创建 |
| `template:import-bundle` handler | `src/main.js:3877` | forEach 内每个 entry 校验；重复时 skip + activity log 警告（不中断整批导入） |

#### 5.1.4 多模板合并导出（新增功能，初稿未含）

**`mergeGeneratedXlsxFiles(filePaths, mergedOutputPath)`**（`src/main.js:5249`）：
- 以第一个文件为基础 workbook，逐个追加后续文件的数据行（跳过表头行 r=0）
- 直接复制单元格对象（`{ ...cell }`）保留日期/数字格式

**`generateMultiTemplateGroupFiles`**（`src/main.js:5291`）改造：
- 按 `matchedTemplateId` 分组，每组独立调用 `generateStatementFiles`
- 步骤 8 路径（`selectedBigAccount` 有值）：调 `rebuildMatchedTemplateFileEntries` (`:625`) 注入 MerchantId
- 大账号选择路径（`selectedBigAccount` 为 null）：直接用 entries（已由 `applyBigAccountAssignments` 注入）
- 循环后收集 `allDetailPaths` / `allBalancePaths` / `allWarnings` / `allBillDates`
- `appendStatementSessionImport` 只调一次（`:5418`，避免 importCount 膨胀）
- 合并文件命名：`{模板数量}-COMMON-{日期范围}.xlsx` / `{模板数量}-BALANCE-{日期范围}.xlsx`

**`exportStatementByScope` 虚拟 ID 分支**（`src/main.js:5842`）：
- `isVirtualTemplate` 为 true 时，同样按 `matchedTemplateId` 分组生成 + 合并
- 合并命名逻辑与 `generateMultiTemplateGroupFiles` 一致

### 5.2 改动点（终稿行号）

| 文件 | 行号 | 改动内容 |
|------|------|---------|
| `src/main.js` | `:127-129` | `FILENAME_MAPPING_TEMPLATE_ID` 常量 + `isFilenameMappingMode` helper |
| `src/main.js` | `:6261-6268` | `findConflictingTemplateByHeaders` 工具函数 |
| `src/main.js` | `:6273-6285` | `matchesTemplateHeaders` 工具函数 |
| `src/main.js` | `:6291-6650` | `handleFilenameMappingImport` 全部实现 |
| `src/main.js` | `:5249-5289` | `mergeGeneratedXlsxFiles` |
| `src/main.js` | `:5291-5434` | `generateMultiTemplateGroupFiles` 改造 |
| `src/main.js` | `:5842-5927` | `exportStatementByScope` 虚拟 ID 分支 |
| `src/main.js` | `:3425` | `template:import` 表头唯一性校验 |
| `src/main.js` | `:3877` | `template:import-bundle` 表头唯一性校验 |
| `src/main.js` | `:6651` | `file:import` handler 虚拟 ID 分流 |

### 5.3 注意事项

- **无 `filenameFixedField` 依赖**：最终方案完全不使用 `filenameFixedField` 字段进行文件匹配，DB 迁移 / Repository / IPC / 前端模块中与该字段相关的初稿设计**均未落地或已回退**。
- **子模板参与匹配**：`allTemplates` 包含主/子/普通模板，表头匹配不做 `parentTemplateId` 过滤。
- **匹配到的子模板导出后的主模板上下文**：`handleFilenameMappingImport` 步骤 4 会从匹配到的子模板向上找主模板聚合 bigAccounts。
- **错误码精简**：最终仅保留 `FILENAME_MAPPING_NO_MATCH`、`FILENAME_MAPPING_AMBIGUOUS`；初稿的 `FILENAME_MAPPING_HEADER_MISMATCH` 已删除。
- **表头唯一性**：新增 `TEMPLATE_HEADERS_DUPLICATE` 错误码用于模板导入；bundle 导入为 skip + warn 不中断。

---

## 六、实现顺序建议（最小风险优先）

1. **先落需求 1**（最小风险）：仅前端一处 if-else，AC 简单，先跑通后用作"流程已通"基准。
2. **再落需求 3 数据层 + 小模块 UI**（中等风险）：DB 迁移 + 映射关系管理模块 + Bundle 字段；先把"每个模板能存/读 `filename_fixed_field`"闭环做好，**不启用**导入流程分支（保持用户走旧模板下拉）。
3. **再落需求 3 导入分支**（需回归 v1.5.1 功能）：启用 `__FILENAME_MAPPING__` 分支，编写 `handleFilenameMappingImport` + 错误截断；回归 v1.5.1 P0-3/P0-4 主模板导入子模板文件场景。
4. **最后落需求 2**（最高风险 — 状态机改造）：基于需求 3 稳定的基础上改造大账号确认页，便于独立测试。

每步都做一次 `npm run smoke` 回归。

---

## 七、任务分解

> **注**：以下为初稿规划，需求 3 的 G3-1 ~ G3-6（DB 迁移、Repository、IPC、映射管理 UI、Bundle 透传）在最终实现中已变更或删除。实际执行以 §九 实施日志为准。

> 组内按箭头顺序执行；组间按风险序 G1 → G3 → G2。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| G1-1 | 需求 1：`doneBtn` 校验插桩 | `src/renderer-dialogs.js` | AC1-1 ~ AC1-4 通过 | todo |
| G1-2 | 需求 1：校验失败后"用户已编辑数据"最小验证 | `src/renderer-dialogs.js` | 手动测试记录 | todo |
| **G3-0** | **需求 3：虚拟 ID `__FILENAME_MAPPING__` 短路 helper（前置）** | `src/main.js`, `src/renderer.js`, `src/renderer-dialogs.js` | 按 §5.1.0 清单逐项覆盖；虚拟 ID 下不命中任何按 ID 查表/启动 IPC 路径 | todo |
| G3-1 | 需求 3：DB 迁移 `ensureTemplateFilenameFixedFieldSupport` | `src/backend/database/migrations.js`, `src/backend/database.js` | 启动 app 无报错；`PRAGMA table_info(templates)` 含 `filename_fixed_field` | todo |
| G3-2 | 需求 3：Repository / utils / database 透传 | `src/backend/database/template-repository.js`, `utils.js`, `database.js` | `desktopApi.templates.list()` 返回值含 `filenameFixedField` | todo |
| G3-3 | 需求 3：IPC + preload `saveFilenameFixedField` | `src/main.js`, `src/preload.js` | 通过 devtools 手动调用写入成功 | todo |
| G3-4 | 需求 3：映射关系管理「按文件名映射模板」模块 UI | `src/renderer-dialogs.js`, `src/styles.css` | AC3-2 / AC3-3 / AC3-4 通过 | todo |
| G3-5 | 需求 3：主页面下拉默认值 `__FILENAME_MAPPING__` | `src/renderer.js`, `index.html`（可选） | AC3-1 / P1-9 | todo |
| G3-6 | 需求 3：Bundle v4 透明扩展 `filenameFixedField` | `src/main.js` | P1-7 / P1-8 | todo |
| G3-7 | 需求 3：`file:import` 新增 `__FILENAME_MAPPING__` 分支 | `src/main.js` | AC3-5 / AC3-6 / AC3-7 / AC3-8 通过 | todo |
| **G2-0** | **需求 2：排查"主模板多文件"分支兼容性（前置）** | 阅读 `src/main.js:6009-6066` `parentProvisionalEntries` 分支 + `main.js:881` `applyBigAccountAssignmentsToFileEntries` | 验证 `matchedTemplateId` 不被 M:1 映射修改；block 粒度展开不破坏每文件独立模板配置；如发现冲突停下来找 PM | todo |
| G2-1 | 需求 2：`buildBigAccountSelectionRows` 增加 `fileIndex` | `src/main.js` | `rows[i].fileIndex` 正确；v1.5.1 旧 UI 无感知 | todo |
| G2-2 | 需求 2：对话框 HTML 新增多对一工具条 + 编辑/完成按钮 | `src/renderer-dialogs.js`, `src/styles.css` | AC2-1 外观通过 | todo |
| G2-3 | 需求 2：`multiMode` 状态机（**leftBlockRowIndices，block 粒度**）+ 左右勾选事件 | `src/renderer-dialogs.js` | AC2-2 ~ AC2-7、AC2-12 通过 | todo |
| G2-4 | 需求 2：取消勾选框回滚 + 固定模式互斥 | `src/renderer-dialogs.js` | AC2-8 / AC2-10 / P1-3 / P1-4 | todo |
| G2-5 | 需求 2：主 `doneBtn` 按 block 粒度展开 assignments（key=rowIndex） | `src/renderer-dialogs.js` | AC2-9 / AC2-11 / AC2-12 / P0-4 ~ P0-6 / P0-12 | todo |
| Z-1 | 版本升级 | `package.json` | version=`1.5.2` | todo |
| Z-2 | 文档三件套（发版前）| `CHANGELOG.md`, `docs/VERSION_FEATURE_HISTORY.md`, `docs/USER_GUIDE.md` | 版本号 + 新功能条目 | todo |

---

## 八、实施计划（Commit 粒度）

> **注**：以下为初稿规划，实际 commit 历史以 git log 为准。需求 3 的 DB 迁移/Repository/映射管理 UI 相关 commit 在最终实现中不存在。

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `docs(v1.5.2): add PRD + TechDoc` | `docs/iterations/v1.5.2/*` | - |
| 2 | `feat(v1.5.2): mapping dialog — parent/child name validation` | `src/renderer-dialogs.js` | 1 |
| 3 | `feat(v1.5.2): add isFilenameMappingMode helper + shortcircuit callsites` | `src/main.js`, `src/renderer.js`, `src/renderer-dialogs.js` | 3 |
| 4 | `feat(v1.5.2): db migration — templates add filename_fixed_field` | `src/backend/database/migrations.js`, `src/backend/database.js` | 3 |
| 5 | `feat(v1.5.2): repository — expose filenameFixedField + setter` | `src/backend/database/template-repository.js`, `utils.js`, `database.js` | 3 |
| 6 | `feat(v1.5.2): ipc — saveFilenameFixedField + preload` | `src/main.js`, `src/preload.js` | 3 |
| 7 | `feat(v1.5.2): mapping dialog — filename-fixed-field module` | `src/renderer-dialogs.js`, `src/styles.css` | 3 |
| 8 | `feat(v1.5.2): main dropdown — default "按文件名映射模板"` | `src/renderer.js` | 3 |
| 9 | `feat(v1.5.2): bundle v4 — transparent filenameFixedField` | `src/main.js` | 3 |
| 10 | `feat(v1.5.2): file:import — filename mapping branch` | `src/main.js` | 3 |
| 11 | `chore(v1.5.2): verify parentProvisionalEntries compatibility for M:1` | 无代码改动（排查报告写入 changes/v1.5.2/log.md） | 2 |
| 12 | `feat(v1.5.2): big-account selection rows carry fileIndex` | `src/main.js` | 2 |
| 13 | `feat(v1.5.2): big-account dialog — multi-mode toolbar` | `src/renderer-dialogs.js`, `src/styles.css` | 2 |
| 14 | `feat(v1.5.2): big-account dialog — multi-mode state machine (block-level)` | `src/renderer-dialogs.js` | 2 |
| 15 | `feat(v1.5.2): big-account dialog — done btn expands groups by rowIndex` | `src/renderer-dialogs.js` | 2 |
| 16 | `chore(v1.5.2): bump version to 1.5.2` | `package.json` | - |
| 17 | `docs(v1.5.2): update CHANGELOG + VERSION_FEATURE_HISTORY + USER_GUIDE` | `CHANGELOG.md`, `docs/*` | - |

---

## 九、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。

### 2026-04-16 初稿

- 动作：PRD + TechDoc 初稿完成
- 证据：本文件 + `PRD-v1.5.2.md`
- 风险：
  - **需求 2 状态机改造**：左右勾选联动 + 字母/数字序号混合渲染 + 取消/切换/二次编辑的边界条件多，需要专项测试
  - **需求 3 导入流程**：整批截断时需确保 session 零残留；子模板参与匹配时需正确聚合主模板 bigAccounts
- 决策：
  - 决策 D1-D7 按用户拍板执行，TechDoc 未做任何方案外的扩展
  - Bundle 策略选 **v4 透明扩展**（不升 v5），除非 PM 明确要求升级

### 2026-04-16 Reverse Sync（4 条 blocker 拍板）

- 动作：用户对初稿 §十一 4 条 blocker 全部拍板，回写 PRD / TechDoc / spec / tasks
- 决策（按用户原话归纳）：
  1. **①B — block 粒度**：单文件多 block M:1 只覆盖用户勾选的那个 block，同文件其他 block 保持原值
  2. **②Dev 阶段排查**：v1.5.1 `parentProvisionalEntries` 分支与 M:1 叠加 → 在 G2 组首个前置 task 验证 `matchedTemplateId` 不被破坏
  3. **③A — v4 透明扩展**：Bundle 保持 v4，不升 v5；已复核 `readTemplateBundleFile` 不做字段严格校验
  4. **④Dev 前置 task**：虚拟 ID `__FILENAME_MAPPING__` 在 G3 组首个前置 task 统一加 `isFilenameMappingMode()` helper + 调用点清单短路
- 改动：
  - PRD：§6.2.1 ~ §6.2.3、§九 状态机、AC2 文案、新增 AC2-12、新增 P0-12、§十一 4 条打勾、§十二 新增变更记录行
  - TechDoc：§1.2 R-1 / R-7 标注决策、§1.3 同步差异说明、§四 状态机字段由 `leftFileIndices` 改为 `leftBlockRowIndices`、§4.1.3 展开 key 由 `(fileIndex, blockIndex)`/联动勾选改为 **单一 `rowIndex`**（block 粒度）、§4.3 删除"A 退路方案"残留、§五 新增 5.1.0 虚拟 ID 短路 helper 小节、§5.1.7 Bundle 策略锁定 A、§七 新增 G2-0 / G3-0 两个前置 task + 重编号、§八 Commit 计划同步
- 证据：本文件（`TechDoc-v1.5.2.md`）+ `PRD-v1.5.2.md` 同步更新；`changes/v1.5.2/spec.md`、`tasks.md` 同步更新
- 风险更新后的范围：
  - 需求 2 状态机改造风险**收窄**为"block 粒度展开 + rowIndex key 单一化"（相比原"fileIndex 联动 + 组合 key"更简单），但仍需 G2-0 前置排查保障 v1.5.1 兼容
  - 需求 3 数据迁移风险不变；虚拟 ID 短路通过 G3-0 前置 task 集中消化

### 2026-04-16 终稿修订

- 动作：TechDoc 更新为终稿，反映实际代码而非初稿设计
- 关键变更：
  - 需求 3：从"按文件名映射"改为"按表头自动识别"。删除 `filenameFixedField` 相关设计（DB/Repository/IPC/前端模块/CSS），替换为纯表头匹配 `matchesTemplateHeaders`。新增表头唯一性校验 `findConflictingTemplateByHeaders`、多模板合并导出 `mergeGeneratedXlsxFiles` / `generateMultiTemplateGroupFiles`
  - 需求 2：默认不勾选；编辑+完成合并为 1 个 toggle 按钮；`renderFileList` 四分支渲染；`extractOrderBtn` 过滤已映射 block；导出按钮文本改为"当前批次文件"/"所有批次文件"
  - 所有行号更新为实际代码行号（grep 确认）
- 证据：grep 确认的行号见 §四、§五各小节

### 可沉淀知识

- [ ] 需求 2 M:1 映射用"前端展开 + 后端不动协议"的方式实现，避免协议破坏——可记入 `knowledge/` 作为后续 UI 拓扑改造的范本
- [ ] 决策 ①B 确认："勾选粒度"在多 block 场景下应优先交给用户显式决定，而不是按文件粒度自动聚合——防止"隐式联动"破坏用户意图
- [ ] 虚拟 ID（UI-only 枚举值）必须在一处集中短路处理，禁止"哪里出错哪里补 if"——可记 `knowledge/` 作为前端枚举值共享到后端时的通用坑
- [ ] 表头自动识别要求模板间表头唯一性，否则会产生 AMBIGUOUS 误判——在模板导入时前置校验比导入文件时报错更友好

---

## 十、Open Technical Questions

无。所有 blocker 已拍板并落地。需求 3 设计变更（表头自动识别替代文件名映射）已在终稿中全面反映。

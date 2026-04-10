# TechDoc - 网银账单小助手 v1.5.0 (v2)

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.0 v2 |
| 日期 | 2026-04-10 |
| 作者 | Dev |
| 状态 | 已定稿（2026-04-10） |
| 关联 PRD | `docs/iterations/v1.5.0/PRD-v1.5.0.md`（v2 定稿，44 AC：AC1-1~AC1-11 + AC2-1~AC2-3 + AC3-1~AC3-13 + AC4-1~AC4-16 + AC5-1） |
| 依赖 | v1.4.9 已 merged 到 main，v1.5.0 从 main 起分支 |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §4.1 精度提升到 12 位 | **已实施**（v1 代码保留）。`roundAmountHighPrecision` + `calculateEndingBalanceFromAmounts` 高精度 + Excel 文本格式降级。无需再改。 |
| §4.2 标题文案改动 | 纯文本替换。`renderer-dialogs.js` 的 `dialog-title` + `记住大账号选择顺序` + footer 布局。无技术阻碍。 |
| §4.5 删除帮助图标 | 删除 v1 新增的 `.file-order-help-icon` HTML + CSS。无技术阻碍。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | §4.3 记住顺序持久化：当前 `big-account-order-store.js` 只存 `assignments`。需要扩展数据结构增加 `fileCount` / `files[]` 信息。存储格式向下兼容：旧 JSON 无 `files` 字段时读取不报错，fallback 到当前行为。 | 在 TechDoc 落定。 |
| R-2 | §4.3.4 导入时自动匹配 + 直接输出（D2-1）：需要在 `file:import` IPC handler 的大账号选择分支前插入自动匹配逻辑。匹配成功时复用 `file:complete-big-account-selection` 的后半段逻辑直接生成输出。 | 在 TechDoc 落定。 |
| R-3 | §4.4 提取大账号顺序：复用 v1 的 `identifyAccountsFromFile` / `findHeaderRowNumbersInRawRows` / `matchMerchantIds` 核心逻辑。IPC 从 `file:check-sort` 改为 `file:extract-big-account-order`，返回格式改为 `{ accounts: [{ merchantId, currency, matchType }] }`。前端弹出新对话框而非 alert。 | 在 TechDoc 落定。 |
| R-4 | §4.3.3 / §4.3.4 bundle 导出需包含记住顺序配置：`listTemplateBundleEntries` 返回的每个 entry 需追加 `bigAccountOrderConfig` 字段；import-bundle 时写入对应的 JSON 文件。 | 在 TechDoc 落定。 |

### 1.3 与 PRD 的差异（无）

Dev 不在本 TechDoc 中改写 PRD 任何条款。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/file-service/normalizers.js` | 已完成（v1） | `roundAmountHighPrecision` + `calculateEndingBalanceFromAmounts` 高精度 |
| `src/backend/file-service/writers.js` | 已完成（v1） | Excel 15 位有效数字判定 + 文本格式降级 |
| `src/backend/big-account-order-store.js` | 修改 | 扩展 `readBigAccountOrder` / `writeBigAccountOrder` 支持 `files[]` 数据 |
| `src/main.js` | 修改 | 删除 v1 check-sort/file-sort 代码；改 IPC `file:check-sort` → `file:extract-big-account-order`；新增自动匹配逻辑 in `file:import`；bundle 导出/导入追加 `bigAccountOrderConfig` |
| `src/preload.js` | 修改 | `checkSort` → `extractBigAccountOrder` |
| `src/renderer-dialogs.js` | 修改 | 标题文案改动；删除 tooltip；检查排序 → 提取大账号顺序弹框；记住顺序匹配失败弹框 |
| `src/styles.css` | 修改 | 删除 `.file-order-help-icon` / `.file-order-tooltip`；新增提取弹框样式 |
| `package.json` | 已完成（v1） | version 已为 `1.5.0` |
| `docs/iterations/v1.5.0/TechDoc-v1.5.0.md` | 重写 | 本文件 |

---

## 三、需求 1：精度 12 位（已实施，不再修改）

v1 代码保留：
- `roundAmountHighPrecision`（normalizers.js）
- `calculateEndingBalanceFromAmounts` 使用高精度（normalizers.js）
- `buildNumericCellValue` 15 位有效数字判定（writers.js）

---

## 四、需求 2 + 5：标题文案改动 + 删除帮助图标

### 4.1 文案替换

| 位置 | 原文 | 新文 |
|------|-----|-----|
| `renderer-dialogs.js` dialog-title | `请选择本次使用的大账号 / 币种` | `网银账单解析大账号确认` |
| `renderer-dialogs.js` remember label span | `记住大账号选择顺序` | `记住顺序` |

### 4.2 删除帮助图标

删除 `renderer-dialogs.js` 中 `big-account-split-header` 内的 `.file-order-help-icon` span。
删除 `styles.css` 中 `.file-order-help-icon` / `.file-order-tooltip` 规则。

### 4.3 Footer 布局调整

`定位大账号` + 搜索框向右平移：通过给 `big-account-search-label` 增加 `margin-left: auto` 实现自动推右。

---

## 五、需求 4：提取大账号顺序

### 5.1 IPC 设计

```
前端: "提取大账号顺序" 按钮点击
  ↓
renderer-dialogs.js: desktopApi.files.extractBigAccountOrder()
  ↓
preload.js: ipcRenderer.invoke('file:extract-big-account-order')
  ↓
main.js: ipcMain.handle('file:extract-big-account-order', handler)
  ↓
返回: { status: 'ok', accounts: [{ merchantId, currency, matchType, fileName }...] }
  或  { status: 'error', failedRows: [{ index, fileName }...] }
```

### 5.2 后端

复用 v1 的 `identifyAccountsFromFile` / `findHeaderRowNumbersInRawRows` / `matchMerchantIds` / `stripSpecialCharsForMatch`。

`file:extract-big-account-order` handler：
1. 从 `lastPendingBigAccountSelection` 获取 fileEntries + bigAccounts
2. 遍历文件，调用 `identifyAccountsFromFile` 提取账户
3. 对提取到的 merchantId，在 `expandedBigAccountOptions`（merchantId + currency 的展开列表）中查找匹配的大账号
4. 任一文件提取失败 → 返回 `{ status: 'error', failedRows }`
5. 全部成功 → 返回 `{ status: 'ok', accounts }`

### 5.3 前端弹框

新增 `createExtractBigAccountOrderDialog` 函数：

- 左侧：文件顺序列表（只读，复用 `big-account-file-item` 样式）
- 右侧：提取结果列表，每行显示 `merchantId currency [编辑]`
- 编辑行：双输入框（账户号 + 币种）+ 行内完成按钮
- 行内完成校验：精准匹配 `expandedBigAccountOptions`
- 右下角完成按钮：条件覆盖逻辑（有已勾选→二次确认）

### 5.4 完成后填入

将提取结果填入主页面的 `checkedOrder`，触发 `syncOrderIndices` + `syncCheckboxDisabled` 刷新 UI。

---

## 六、需求 3：记住顺序持久化增强

### 6.1 数据结构扩展

`big-account-order-store.js` 的 JSON 格式扩展：

```json
{
  "templateId": "123",
  "assignments": [...],
  "fileCount": 3,
  "files": [
    {
      "fileIndex": 0,
      "accountCount": 2,
      "accounts": [
        { "merchantId": "62001234567890", "currency": "CNY" },
        { "merchantId": "62009876543210", "currency": "USD" }
      ]
    }
  ],
  "updatedAt": "..."
}
```

向下兼容：`readBigAccountOrder` 读取时 `files` 不存在则 fallback 到 `null`。

### 6.2 保存时机

`file:complete-big-account-selection` handler 中，当 `mode === 'fixed' && rememberCheckbox.checked` 时：
1. 保存 `assignments`（已有）
2. 额外保存 `fileCount` + `files[]`（从 `pendingContext.fileEntries` + `identifyAccountBlocks` 计算）

### 6.3 导入时自动匹配

在 `file:import` handler 中，进入大账号选择分支前：
1. 检查模板是否有记住顺序配置（`readBigAccountOrder` 返回有 `files`）
2. 检查模式是否为 fixed（`readBigAccountMode`）
3. 文件个数不等 → 降级为 unfixed 模式，正常弹大账号确认页
4. 文件个数相等 → 逐文件匹配账户个数 + 账户号
5. 全部匹配 → 直接走 `complete-big-account-selection` 逻辑输出
6. 部分失败 → 返回特殊 status `remember-order-mismatch`，前端弹匹配失败框

### 6.4 Bundle 导出/导入

**导出**：`listTemplateBundleEntries` 返回每个 entry 时，额外读取 `readBigAccountOrder` 并附加到 entry 的 `bigAccountOrderConfig` 字段。

**导入**：`template:import-bundle` handler 中，如果 entry 有 `bigAccountOrderConfig` 字段，调用 `writeBigAccountOrder` 写入。

### 6.5 匹配失败提醒框

前端新增处理 `status: 'remember-order-mismatch'` 的分支，弹出提醒框：
- 逐行列出失败的文件名
- 「变更配置」按钮 → 以 fixed 模式打开大账号确认页
- 「确认」按钮 → 关闭，返回主页

---

## 七、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 |
|------|---------------|---------|
| 1 | `docs(v1.5.0): rewrite TechDoc for v2` | `TechDoc-v1.5.0.md` |
| 2 | `refactor(v1.5.0): remove v1 check-sort, tooltip, file-sort code` | `main.js`, `preload.js`, `renderer-dialogs.js`, `styles.css` |
| 3 | `feat(v1.5.0): rename dialog title and labels (requirement 2+5)` | `renderer-dialogs.js`, `styles.css` |
| 4 | `feat(v1.5.0): extract big account order dialog (requirement 4)` | `main.js`, `preload.js`, `renderer-dialogs.js`, `styles.css` |
| 5 | `feat(v1.5.0): remember order persistence enhancement (requirement 3)` | `big-account-order-store.js`, `main.js`, `preload.js`, `renderer-dialogs.js` |

---

## 八、Open Technical Questions（无）

本版本技术实现方案明确，无待定的技术问题。

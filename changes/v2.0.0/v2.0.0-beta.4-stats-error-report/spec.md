# Spec — v2.0.0-beta.4：usage-stats + error-report 可能原因 + 升正式版 2.0.0

> status: apply
> owner: team-lead
> created: 2026-04-30
> 分支：`v2.0.0-beta.4`（从 `v2.0.0` HEAD `6a51bb1` 切出）
> 节奏：beta.4 完成 → 直接 bump 到 `2.0.0` 正式版（去 beta，一次发版）

## 1. 背景

- v2.0.0-beta.3 系列（PR #29/#30/#31/#32a/#33）全部 merged，银行对账单处理模块闭环完成
- v2.0.0-beta.4 是 **2.0.0 GA 发版前最后一个 beta**，完成两件事 + bump 正式版：
  1. 隐藏 `.usage-stats.txt`（统计软件打开次数 + 各模块功能使用次数）
  2. 3 个模块的 error-report xlsx 加「可能原因」列（口语化）
- 完成后 `package.json.version` `2.0.0-beta.3` → `2.0.0`，按 v2.0.0 系列 GA 发版

## 2. 代码现状（必须有出处）

- **storage root**：`~/Documents/网银账单生成小助手/`，由 `src/main.js#ensureStorageRoot()`（L363）创建
- **3 个模块的 error-report 写出**（按行扫到的现状）：
  - 主模块（statementGenerator）：`src/backend/file-service/writers.js#writeErrorReport`（SheetJS）
  - 月度 Pending：`src/backend/pending-db/...` 或 `pending-export-store`（待 inventory）
  - 银行对账单处理：`src/main-process/exceljs-writer.js#writeErrorReport`（4 列：scenarioId / scenarioName / rowId / code / message）
- **app 生命周期钩子**：`src/main.js` `app.whenReady()` / `app.on('window-all-closed')` / `app.on('before-quit')`
- **现有功能集合**（按用户视角）：
  - 生成网银账单：导入模板 / 导入文件 / 导出明细 / 导出余额 / 模板管理 / 账户映射
  - 新开账户：生成余额账单 / 导出余额
  - 月度 Pending：规则管理 / 导入文件 / 开始运行 / 导出差异
  - 银行对账单处理：场景管理 / 导入文件 / 开始运行 / 导出文件
  - 切换页面风格

## 3. 目标

### 必做

#### F1 隐藏 usage-stats.txt（用户决策 Q1.1=A / Q1.2=A / Q1.3=B / Q1.4=C）

- **路径**：`~/Documents/网银账单生成小助手/.usage-stats.txt`（dot prefix，与 exports/error-reports/balance-seeds 同级）
- **格式**：key=value 简单文本（人类可读）
- **颗粒度**：用户视角"功能"（不是按钮 / IPC channel）
- **写盘时机**：关闭时 flush + 每 5 分钟自动 flush（混合，最坏丢 5 分钟）
- **隐藏方式**：dot prefix（macOS 默认隐藏；Windows 用户在 storage root 子目录里也不会主动看到）

**txt 内容设计**（用户决策 Q1.5：按功能模块汇总操作次数 + 总操作次数）：

```
appOpenCount=42
firstOpenedAt=2026-04-30T10:00:00
lastClosedAt=2026-04-30T18:30:00
sessionStartedAt=2026-04-30T18:00:00

[生成网银账单]
导入模板=10
导入文件=156
导出明细=89
导出余额=45
模板管理=23
账户映射=12
小计=335

[新开账户]
生成余额账单=8
导出余额=8
小计=16

[月度 Pending]
规则管理=3
导入文件=15
开始运行=12
导出差异=10
小计=40

[银行对账单处理]
场景管理=8
导入文件=20
开始运行=18
导出文件=15
小计=61

[切换页面风格]
切换=2
小计=2

总操作次数=454
```

**模块小计**：每个模块块末尾 `小计=N` 自动计算
**总操作次数**：所有模块小计之和（写在最后一行）

#### F2 error-report 加「可能原因」列（用户决策 Q3.1=C / Q3.2=A / Q3.3 精简风）

- **范围**：3 个模块全部统一加（一致性）
- **方式**：xlsx 每行 warning 加一列「可能原因」
- **风格**：口语化但精简（用户原话："语言还需再精简一点"）

**统一映射表**：`src/backend/file-service/error-causes.js`（新模块），`errorCodeToCause(code, context?) → string`

**初版 cause 表**（精简口语）：

| code | 可能原因 |
|---|---|
| inconsistent-recon-id-values | 多个字段抓到的对账 ID 不一致，无法判断该用哪个 |
| single-field-multi-recon-id | 单个字段里出现多个对账 ID，无法判断该用哪个 |
| multi-search-fields-multi-extract | 多个字段都抓到对账 ID，但值不同，无法判断该用哪个 |
| one-to-many | 一对多匹配，可能有重复数据 |
| many-to-one | 多对一匹配，可能有重复数据 |
| multi-gateway-match | 网关单里有多条匹配，已取第一条，请检查是否重复 |
| no-gateway-rows | 资金对账文件为空，C3 类场景跳过 |
| missing-assign-config | 场景配置漏了赋值字段 |
| no-bill-types-defined | 场景配置漏了账单类型 |
| blocked-by-prior-scenario | 这一行已被更高优先级场景锁定，不再处理 |
| invalid-column-count | 文件列数不对，请检查表头 |
| invalid-column-name | 文件列名不对，请检查表头 |
| missing-sheet | 文件少了必需的 sheet |
| file-not-found | 文件找不到 |
| missing-headers | 表头缺失，请检查文件 |
| missing-mapping | 列映射缺失，请检查模板 |
| duplicate-row | 重复行，已忽略 |
| missing-required-field | 必填字段为空 |
| amount-parse-error | 金额无法解析，请检查格式 |
| date-parse-error | 日期无法解析，请检查格式 |
| (default fallback) | （留空或写 "未知错误，请联系开发者"）|

**实施层**：
- 新建 `src/backend/file-service/error-causes.js`（导出 `errorCodeToCause(code)` + 映射表）
- 主模块 `writers.js#writeErrorReport`：加列
- Pending writer：加列（待 inventory 具体文件）
- 银行对账单 `exceljs-writer.js#writeErrorReport`：加列（5 列）

### 不做

- usage-stats 的 GUI 展示页（用户没要求）
- usage-stats 跨设备同步 / 上传统计后端（不是产品诉求）
- error-report 历史记录的回溯改造（仅新生成的 error-report 加列，旧文件不动）
- Windows attrib +H 真隐藏（dot prefix 已足够，避免 child_process 复杂度）

## 4. 功能点

### F1 — usage-stats 模块

`src/backend/usage-stats.js`（new）

```
模块导出：
  loadStats()                 // 读 .usage-stats.txt（不存在 → 默认）
  saveStats(stats)            // 原子写入（temp → rename）
  incrementFunction(moduleKey, functionKey)  // 内存累加
  flushIfDirty()              // 节流写盘
  recordSessionStart()        // appOpenCount++ + sessionStartedAt
  recordSessionEnd()          // lastClosedAt + flush
  startAutoFlushTimer()       // 每 5min 调 flushIfDirty
  stopAutoFlushTimer()
```

**txt 解析/序列化**：手写 INI-lite parser（不依赖外部库）—— 第一段 key=value（top）+ 多个 [section] block + 末尾总计

**功能 key 命名**（统一从中文 user-facing 字符串映射，避免代码层与 txt 内容字符串漂移）：

```js
const FUNCTION_REGISTRY = {
  '生成网银账单': ['导入模板', '导入文件', '导出明细', '导出余额', '模板管理', '账户映射'],
  '新开账户': ['生成余额账单', '导出余额'],
  '月度 Pending': ['规则管理', '导入文件', '开始运行', '导出差异'],
  '银行对账单处理': ['场景管理', '导入文件', '开始运行', '导出文件'],
  '切换页面风格': ['切换']
};
```

未在 registry 的 key 调用 `incrementFunction` 时静默忽略（防御性，未注册的 IPC 不污染 stats）。

**原子写入**：
1. 写 `<storage>/.usage-stats.txt.tmp`
2. fsync
3. rename → `.usage-stats.txt`
4. 失败时清理 tmp

### F2 — error-causes 映射

`src/backend/file-service/error-causes.js`（new）

```js
const CAUSE_MAP = { /* 见 §3 表 */ };

function errorCodeToCause(code) {
  return CAUSE_MAP[code] || '未知错误';
}

module.exports = { errorCodeToCause, CAUSE_MAP };
```

3 个 writer 集成：

- **主模块** `src/backend/file-service/writers.js`
  - `writeErrorReport` 当前列结构：（待 inventory）
  - 加最后一列「可能原因」，值 = `errorCodeToCause(row.code)`
- **银行对账单处理** `src/main-process/exceljs-writer.js`
  - `writeErrorReport` 当前 4 列（scenarioId / scenarioName / rowId / code / message）
  - → 5 列（scenarioId / scenarioName / rowId / code / message / 可能原因）
- **月度 Pending** `src/backend/pending-...`（待 inventory）

## 5. IPC handler → function key 映射（F1 计数集成点）

| IPC channel | module | function key |
|---|---|---|
| `templates:import` | 生成网银账单 | 导入模板 |
| `files:import` | 生成网银账单 | 导入文件 |
| `files:exportDetail` | 生成网银账单 | 导出明细 |
| `files:exportBalance` | 生成网银账单 | 导出余额 |
| `templates:list` / `templates:save` / `templates:delete` | 生成网银账单 | 模板管理 |
| `account-mappings:*` | 生成网银账单 | 账户映射 |
| `new-account:generate` | 新开账户 | 生成余额账单 |
| `new-account:export` | 新开账户 | 导出余额 |
| `pending:save-rule` / `pending:get-rule` | 月度 Pending | 规则管理 |
| `pending:import:start` | 月度 Pending | 导入文件 |
| `pending:reconcile:run` | 月度 Pending | 开始运行 |
| `pending:export:diff` | 月度 Pending | 导出差异 |
| `scenarios:*` | 银行对账单处理 | 场景管理 |
| `bank-statement:import` / `gateway-recon:import` | 银行对账单处理 | 导入文件 |
| `bank-statement:run` | 银行对账单处理 | 开始运行 |
| `bank-statement:export` | 银行对账单处理 | 导出文件 |
| `settings:set-ui-style` | 切换页面风格 | 切换 |

实施时统一在 ipcMain.handle 包装：每个 handler 末尾若 status==='ok' 则 incrementFunction（失败不计数）。

## 6. 决策

- **D1 路径**：dot prefix `.usage-stats.txt` 在 storage root（不污染 OS Documents 根）
- **D2 格式**：key=value + [section]，纯 txt 不引入 JSON
- **D3 颗粒度**：用户视角功能（不是 IPC channel / button click）
- **D4 写盘**：关闭 + 每 5 分钟（混合）
- **D5 隐藏**：仅 dot prefix（Windows 不调 attrib +H，避免 child_process 复杂度）
- **D6 失败不计数**：IPC handler status='ok' 才 increment（避免无效操作污染统计）
- **D7 未知 code**：error-causes 默认 fallback `未知错误`（不 throw，避免影响 error-report 主流程）
- **D8 USER_GUIDE 不写隐藏 txt**（用户原话需求 #2：使用手册只记录功能，不记录内部实现）

## 7. 不做

- 历史 error-report 文件回溯加列
- usage-stats GUI 展示
- 跨设备同步
- Windows attrib +H 真隐藏

## 8. 测试

- **smoke**：
  - `usage-stats.test.js`（新）：load/save round-trip / increment / flush / parse 异常 / 总和正确
  - `error-causes.test.js`（新）：所有已知 code 都有 cause / 未知 code fallback
  - 既有 smoke 78/78 不破坏
- **dry-run**：
  - 启动应用 → 各模块各做一次操作 → 关闭 → 检查 `.usage-stats.txt` 内容
  - 触发 1 条 warning → 导出 error-report → 检查"可能原因"列有内容
- **check-vars** 硬节点：版本 bump 前 + 提 PR 前

## 9. 实施顺序

1. F2 error-causes（最简，无外部依赖）+ 3 模块 writer 加列
2. F1 usage-stats 模块（独立纯函数库 + 单测）
3. F1 集成 main.js（启动 / 退出 / 各 IPC handler）
4. smoke + dry-run
5. bump 2.0.0-beta.3 → 2.0.0-beta.4 → 测试通过后 → 2.0.0
6. 文档三件套（CHANGELOG + VERSION_FEATURE_HISTORY + USER_GUIDE）
7. PR 草稿 → 用户明确指令后提 PR

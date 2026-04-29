---
status: 待 merge
integrated: false
---

# PR #34（待 merge，原 v2.0.0-beta.4）

- **分支**：`v2.0.0-beta.4` → `main`
- **版本**：`2.0.0`（GA 正式版，本 PR 一次性 bump `2.0.0-beta.3` → `2.0.0`）
- **依赖**：v2.0.0-beta 系列全部已 merge（PR #29/#30/#31/#32a/#33）

---

## Summary

v2.0.0 GA 正式版收尾迭代。两件事 + 一次性 bump 到正式版：

1. **隐藏 `.usage-stats.txt`**：用户文档存储根（`~/Documents/网银账单生成小助手/`）下记录软件打开次数 + 每个模块每个功能的使用次数 + 模块小计 + 总操作次数。dot prefix 隐藏，关闭时 flush + 每 5 分钟自动 flush。
2. **错误报告加「可能原因」列**：3 个模块（生成网银账单 / 月度 Pending / 银行对账单处理）的 error-report 统一加「可能原因」字段，口语化文案（如 `多个字段抓到的对账ID不一致，无法判断该用哪个`）。统一映射表 `src/backend/file-service/error-causes.js` 覆盖 22+ 已知 code。
3. **bump 2.0.0**：去 beta 后缀，标志 v2.0.0 系列 GA 发版。

## 用户决策（spec §6）

- Q1.1=A 路径 `~/Documents/网银账单生成小助手/.usage-stats.txt`
- Q1.2=A 格式 key=value 简单文本
- Q1.3=B 颗粒度 用户视角"功能"
- Q1.4=C 写盘 关闭 + 每 5 分钟混合
- Q1.5 按模块小计 + 总操作次数
- Q3.1=C 全 3 模块统一加
- Q3.2=A xlsx 加列 / .txt 加行
- Q3.3 精简口语风格
- 分支策略：v2.0.0-beta.4 隔离
- 节奏：beta.4 完成 → 直接 bump 2.0.0（一次发版）

## ⚠️ 关联功能 review（check-vars 软流程）

本 PR 改动主要集中在新增模块 + 现有 writer 加列：
- 新增 `src/backend/file-service/error-causes.js`（不在重要变量表）
- 新增 `src/backend/usage-stats.js`（不在重要变量表）
- 修改 `src/backend/logger.js#writeErrorReport`：仅追加一行可能原因，不改既有字段
- 修改 `src/main-process/exceljs-writer.js#writeErrorReport`：4 列 → 5 列
- 修改 `src/main-process/pending-session.js#exportErrorReport`：4 列 + N 列 → 5 列 + N 列
- 修改 `src/main.js`：app.whenReady / before-quit lifecycle hook + 24 个 IPC handler 入口加 tickUsageStats

**Risk-sensitive · 数据库迁移**：未触发（无 schema 变化）。
**Critical / Important-skeleton / Runtime-state / Minor**：未命中。

## 实施清单

### F1 隐藏 usage-stats（按 spec 验收 ✅）

- [x] `src/backend/usage-stats.js`：FUNCTION_REGISTRY + load/save/parse/serialize/incrementFunction/recordSessionStart/recordSessionEnd
- [x] INI-lite parser（手写，纯 string）
- [x] 原子写入（tmp → rename）
- [x] dot prefix 隐藏
- [x] main.js lifecycle 集成：whenReady → recordSessionStart + setInterval(5min) → before-quit recordSessionEnd + flush
- [x] 24 个 IPC handler 入口加 tickUsageStats（按 spec §5 映射）
- [x] smoke 40 用例（U1-U11 覆盖 round-trip / increment / parse 异常 / 落盘）

### F2 error-report 加「可能原因」（按 spec 验收 ✅）

- [x] `src/backend/file-service/error-causes.js`：CAUSE_MAP 22+ code（frozen）+ errorCodeToCause(code) fallback
- [x] `src/backend/logger.js#writeErrorReport`：加 `可能原因：${cause}` 行（.txt）
- [x] `src/main-process/exceljs-writer.js#writeErrorReport`：4 列 → 5 列
- [x] `src/main-process/pending-session.js#exportErrorReport`：第 5 列 + 用 err.code || err.severity 兜底
- [x] smoke 39 用例（已知 code 全覆盖 + fallback + frozen）

### bump + 文档（按 spec 验收 ✅）

- [x] package.json 2.0.0-beta.3 → 2.0.0-beta.4 → 2.0.0（GA）+ package-lock.json 同步
- [x] CHANGELOG.md：加 `## 2.0.0 - 2026-04-30` 段（含 v2.0.0 系列总览）
- [x] docs/VERSION_FEATURE_HISTORY.md：加 `## 2.0.0（GA 2026-04-30）` 段
- [x] docs/USER_GUIDE.md：顶部版本 `v2.0.0-beta.3` → `v2.0.0` + 新增 §三 错误报告章节（含可能原因映射示例）
- [x] **USER_GUIDE 不写隐藏 txt**（spec D8 元规则）

## smoke 结果

```
scenario-engines: 23/23 PASS
scenarios-repository: 5/5 PASS
scenario-dispatcher: 11/11 PASS
exceljs-writer: 3/3 PASS
bank-statement-io: 13/13 PASS
scenario-end-to-end: 23/23 PASS
error-causes: 39/39 PASS    ← 本 PR 新增
usage-stats: 40/40 PASS     ← 本 PR 新增
smoke test passed (157/157)
```

## 改动文件

### 新增 src

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/backend/usage-stats.js` | ~165 | FUNCTION_REGISTRY + load/save/parse/serialize/increment/session 钩子 |
| `src/backend/file-service/error-causes.js` | ~55 | CAUSE_MAP（frozen）+ errorCodeToCause |

### 修改 src

| 文件 | 改动 |
|---|---|
| `src/main.js` | +50 — usageStats lifecycle（whenReady + before-quit + 定时 flush）；24 个 IPC handler 入口加 tickUsageStats |
| `src/backend/logger.js` | +2 — 加 `可能原因：${errorCodeToCause(...)}` 行 |
| `src/main-process/exceljs-writer.js` | +3 — 5 列 + import error-causes |
| `src/main-process/pending-session.js` | +3 — 5 列 + import error-causes |

### smoke

| 文件 | 行数 | 说明 |
|---|---|---|
| `scripts/smoke/error-causes.js` | ~55 | 39 用例（已知 / fallback / frozen / 代表性 code） |
| `scripts/smoke/usage-stats.js` | ~145 | 40 用例（U1-U11） |
| `scripts/smoke-test.js` | +4 | 接入两个新 smoke 模块 |

### 文档 + 配置

| 文件 | 改动 |
|---|---|
| `package.json` | version 2.0.0-beta.3 → 2.0.0 |
| `package-lock.json` | 同步 |
| `CHANGELOG.md` | 加 `## 2.0.0 - 2026-04-30` 完整段（含 v2.0.0 GA 系列总览）|
| `docs/VERSION_FEATURE_HISTORY.md` | 加 `## 2.0.0（GA 2026-04-30）` 段 |
| `docs/USER_GUIDE.md` | 顶部版本 + §一 模块总览不变 + 新增 §三 错误报告 |
| `changes/v2.0.0-beta.4-stats-error-report/` | spec 三件套 |

## Test plan

- [x] `npm run smoke` 157/157 PASS
- [ ] GUI 实测：启动应用 → 各模块各做 1 次操作 → 关闭 → 检查 `~/Documents/网银账单生成小助手/.usage-stats.txt` 内容
- [ ] GUI 实测：触发 1 条 warning（如 C1 多字段不一致 / 文件列数不对）→ 导出 error-report → 检查"可能原因"列
- [ ] dot file 在 macOS Finder 默认不可见（隐藏验证）
- [ ] 老版本库（v2.0.0-beta.3 用户机）启动验证：`.usage-stats.txt` 不存在时自动创建；既有 stats 不丢失

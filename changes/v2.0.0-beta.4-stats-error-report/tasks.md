# Tasks — v2.0.0-beta.4：usage-stats + error-report 可能原因 + 升 2.0.0 正式版

## F2 — error-causes（先做，简单）

- [ ] T1.1 `src/backend/file-service/error-causes.js`（new）— `CAUSE_MAP` 22+ code → 口语化映射 + `errorCodeToCause(code)` 函数
- [ ] T1.2 inventory 3 模块所有 warning code（grep `code:`）+ 补全映射表
- [ ] T1.3 `writers.js#writeErrorReport`（主模块）加「可能原因」列
- [ ] T1.4 `exceljs-writer.js#writeErrorReport`（银行对账单处理）从 4 列 → 5 列
- [ ] T1.5 月度 Pending writer 加列（位置 inventory 后定）
- [ ] T1.6 smoke `error-causes.test.js`（CAUSE_MAP 完整性 + fallback）

## F1 — usage-stats 模块

- [ ] T2.1 `src/backend/usage-stats.js`（new）：FUNCTION_REGISTRY + load/save/increment/flushIfDirty/recordSessionStart/recordSessionEnd/timer
- [ ] T2.2 INI-lite parser（手写，不引外部库）
- [ ] T2.3 原子写入（temp → rename）
- [ ] T2.4 smoke `usage-stats.test.js`：round-trip / increment / parse 异常 / 总和正确

## F1 — 集成 main.js

- [ ] T3.1 `app.whenReady()` 调 `recordSessionStart` + `startAutoFlushTimer`（5min）
- [ ] T3.2 `app.on('before-quit')` 调 `recordSessionEnd`（flush + 写 lastClosedAt）
- [ ] T3.3 各 IPC handler 末尾 status='ok' 时调 `incrementFunction`（按 spec §5 映射表）
- [ ] T3.4 dry-run：启动 → 操作各模块 → 关闭 → 检查 `.usage-stats.txt` 内容正确

## bump + 文档 + PR

- [ ] T4.1 bump 阶段 1：`package.json` 2.0.0-beta.3 → 2.0.0-beta.4（开发期）+ `package-lock.json` 同步
- [ ] T4.2 测试 / dry-run / check-vars 通过
- [ ] T4.3 bump 阶段 2：2.0.0-beta.4 → **2.0.0**（GA 正式版）+ `package-lock.json` 同步
- [ ] T4.4 `CHANGELOG.md` 加 `## 2.0.0 - 2026-04-30` 段（首个 GA 发版，可总结 v2.0.0-beta 系列全部产物）
- [ ] T4.5 `docs/VERSION_FEATURE_HISTORY.md` 加 `## 2.0.0` 段（含 beta.4 两项功能）
- [ ] T4.6 `docs/USER_GUIDE.md` 加错误报告"可能原因"列说明；**不写隐藏 txt**（spec D8）
- [ ] T4.7 PR body 草稿 → `docs/prs/待merge-PR #N.md`
- [ ] T4.8 用户明确指令"提 PR" 后 team-lead 执行 `gh pr create`（v2.0.0-beta.4 → main）

## 验收标准

- ✅ `.usage-stats.txt` 在 storage root 内存在 + dot 前缀隐藏
- ✅ 启动后 appOpenCount 自增；关闭后 lastClosedAt 更新；各功能调用次数正确累计
- ✅ 模块小计 = 模块内功能次数之和；总操作次数 = 所有模块小计之和
- ✅ 3 模块 error-report 都有「可能原因」列，文案精简口语化
- ✅ 全部 22+ 已知 code 都有 cause 映射；未知 code fallback 默认值
- ✅ smoke 不回归（既有 78 + 新增 N PASS）
- ✅ check-vars 命中已自查
- ✅ 版本号 = `2.0.0`（去 beta）
- ✅ USER_GUIDE 仅记录功能，无隐藏 txt 实现细节

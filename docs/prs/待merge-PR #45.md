---
pr_number: 45
title: "[v2.1.3] feat — 新增模块「业务OP数据核对」+ 6 轮 fix（fix1-fix6）"
base: main
head: v2.1.3
created: 2026-05-14
---

# [v2.1.3] feat — 新增模块「业务OP数据核对」+ 6 轮 fix（fix1-fix6）

## Summary

v2.1.2 之后追加 patch 迭代：**新增模块「业务OP数据核对」**。

每日 T-2/T-1 业务OP + T-1 流水对账单导入 → 「业务OP T-2 期末余额 + 流水当日发生额 = 计算 T-1 OP」逻辑跑对账 → 与 T-1 业务OP 期末余额逐行精准比对（epsilon=1e-2）→ 三类差异（测算金额差异 / 多 OP 行 / 账户号增减）导出差异行 Excel。

## OPEN ISSUE 拍板（PRD §6.1，共 18 项 + 6 轮 fix 拍板补丁）

**已拍板（4 项 #A-#D + 14 项 #1-#15，跳过 #2 已合并到 #B）**：
- #A 动态 BU 枚举 / #B 单 OP 也对账 / #C T-2 残行追同 sheet / #D 模板入仓
- #1 双重校验 (B) / #3 中文「入」/「出」 / #4 替换原子事务 / #5 整批拒绝+失败报告 / #6 1:N 精准标差异 / #7 normalizeBu trim+lower / #8 日期下拉年±1 / #9 文件名格式 / #11 续导确认对话框 / #12 只列 ready 日期 / #13 复用 v2.1.2 list-ready/success / #15 重新导入清 runs

**fix 轮次拍板补丁**：
- **#10 fix2 拍板回滚 E**：差异表**无颜色高亮**（原"三类差异都标黄"回滚）
- **fix4 资金红线 bug**：multi_op_account_count 在 onlyInT1 路径漏算 → 修复 + smoke Case I 15 assertion
- **fix5 选项 B**：多 OP 相等行**也进 diff_rows**（原"相等行不进表"回滚）+ smoke Case J
- **#14 fix6 拍板回滚 F**：区间导出**单 sheet「差异」**（原多 sheet 按日期分回滚）

## 改动范围

**新增 11 个 src 文件 + 1 smoke + 4 preview PNG + 2 模板 xlsx**：
- `src/backend/biz-op-recon-db/`（5 文件）：migration / columns / 3 repository
- `src/backend/biz-op-recon-import/`（2 文件）：reader / validator
- `src/main-process/biz-op-recon-{session,writer}.js`
- `scripts/smoke/biz-op-recon.js`（119 assertion）
- `docs/previews/biz-op-recon-panel-*.png` × 4
- `assets/{业务OP账单,流水对账单}.xlsx`

**修改 13 个文件**：CHANGELOG / USER_GUIDE / VFH / package.json (2.1.2→2.1.3) / index.html / src/{main,renderer,renderer-dialogs,preload,backend/database}.js / src/styles-gemini-extra.css + Clear/styles-gemini-extra.css / scripts/smoke-test.js

## 5 commits 粒度

```
60b219f chore(scan-vars): 刷新统计报告（v2.1.3 提 PR 前）
6135abb chore(release): version bump 2.1.3 + 三件套 + smoke 119 + preview + 模板
c986503 feat(biz-op-recon): session 算法 + writer + IPC + 前端面板/dialog
20422b6 feat(backend,biz-op-recon-db): SQLite 4 表 + reader/validator + 3 repository
00717ed docs(iterations): PRD/spec/tasks v0.6 — 业务OP数据核对模块
```

## ⚠️ 关联功能 review（rules/important-variables.md 软约束）

| 命中 | 层级 | 自查结论 |
|---|---|---|
| `ipcRenderer` | Important-skeleton | preload bridge 新增 `window.desktopApi.bizOpRecon` namespace（17 个 IPC handler）；与现有 namespace 无冲突 |
| `MODULES` | Runtime-state | 新增 `biz-op-recon` 条目，主菜单新增「业务OP数据核对」入口；其他模块条目不动 |
| `dialog` | Runtime-state | 新增 6 个 dialog factory（业务OP 日期 / 流水日期 / 续导确认 / 对账日期 / 导出指定日期 / 导出区间）；fix1.5 删除 errorReport dialog 死代码 |
| `elements` | Runtime-state | 新增 `bizOpReconModulePanel` + 3 按钮 + BU 下拉 + 状态栏 ID |
| `state` | Runtime-state | 新增 `bizOpReconState` 子状态机（buList / selectedBu / 各按钮 disabled 状态等） |

**未命中 Critical / Risk-sensitive**。资金红线核心算法（normalizeBu / parseSignedAmount / AMOUNT_EPSILON / runReconciliation / compareT1OpWithComputed）已在 PRD §3.4/§3.5 + spec §五 充分 spec 化，建议后续迭代评估是否升格 important-variables.md。

## 自验证证据

- `npm run smoke` → **退出码 0**：biz-op-recon **119/119 PASS** + bank-bu-recon **41/41 PASS** + recon-id-fix 全套 + scenario-dispatcher 15/15 + usage-stats 46/46 + 全套 PASS
- `npm run preview:biz-op-recon` → 4 张 PNG 重跑成功（fix6 后版本，5月14 10:24）
- `node --check` → 全 src/*.js 语法 OK
- `npm run scan:vars` → 753 top-level names 统计已刷新

## 用户手动 UI 测试覆盖

- A 段 UI 样式（fix1+fix2+fix3 BU 行+下拉+日期 dialog）
- B 段业务OP 导入（含校验失败状态框 + 失败报告）
- C 段流水对账单导入
- D 段开始运行（含资金红线 D-红1/2/3/4）
- E 段导出差异（指定日期 + 区间，含 fix6 单 sheet）
- F 段边界（重新导入清 runs + 多 BU）
- G 段 v2.1.2 模块回归（Pending / 月度银行对账单 BU 回填校验 / 网银账单生成）
- H 段交付物检查（package.json / CHANGELOG / USER_GUIDE / smoke / preview）

## Test plan

- [x] smoke 全套 119/119 + 41/41 + 全套 PASS
- [x] preview 4 张 PNG 渲染正确（fix6 后版本）
- [x] 用户手动 UI 测试覆盖 8 个测试段
- [x] 资金红线 D-红1/2/3/4 / E-红1/2 / F1 自动 + 手动双重验证
- [x] v2.1.2 模块回归（算法 smoke + 用户手动 UI）
- [x] CHANGELOG / USER_GUIDE / VFH 三件套同步
- [x] PRD/spec/tasks v0.6（18 拍板 + 6 轮 fix 反向同步）

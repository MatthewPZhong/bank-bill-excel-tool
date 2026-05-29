# 任务拆分 — v2.1.11 迭代

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-05-29）|
| 关联 PRD | `PRD-v2.1.11.md` v0.2 |
| 关联 spec | `spec.md` v0.1 |
| 起草人 | PM（team-lead）|
| 执行方式 | 主线程 team-lead 拆分 → 委托 dev agent 实现（不亲自写代码）|

---

## 一、任务总览

| Phase | 标题 | 范围 | 工期 | 风险 | 委托 |
|---|---|---|---|---|---|
| **Phase 0** | 基线 | scan:vars + check:vars baseline + release-check 绿 | ~0.3 天 | 🟢 | team-lead |
| **Phase 1** | T1 单测运行日志 | run-unit-tests 改造 + 落盘 + unit | ~0.5 天 | 🟢 | dev ×1 |
| **Phase 2** | T3 C2 配置增强 | 多条件 AND + 行内新增 + FundType 下拉 + 对账字段可空 + 迁移 | ~3-4 天 | 🟡 | dev ×1 |
| **Phase 3** | T2 pending 移除核对 | 2 新表 + reader + IPC + 匹配 + 导出 2 sheet | ~5-7 天 | 🔴 | dev ×1（可再拆）|
| **Phase 4** | 收尾 | integration 补齐 + manual-test + 文档三件套 + version bump + check-vars | ~2-3 天 | 🟡 | team-lead + dev |

**合计**：~11-15 天（不含性能主线）。

## 二、Phase 间依赖

```
Phase 0（基线）
  ├─ Phase 1（T1）──────┐  独立，先行验证委托流程
  ├─ Phase 2（T3）──────┤  独立（T3.2 待 assets/FundType枚举值.xlsx；缺失走降级先做框架）
  └─ Phase 3（T2）──────┤  独立、最大、红线
                        ↓
                    Phase 4（收尾）依赖 1+2+3 完成
```
- Phase 1/2/3 文件基本不重叠，可并行；**协调点**：`preload.js` / `main.js`（T2 IPC 与 T3 FundType 若走 IPC）需顺序提交或分段，避免冲突。
- 启动节奏：**Phase 1 先跑通**（出第一份证据 + 验证委托）→ Phase 2/3 并行或顺序推进。

---

## 三、Phase 0 — 基线

### T01 — 改动前基线
- `npm run scan:vars` + `npm run check:vars` 留底；`npm run release-check` 确认改动前全绿。
- 验证：贴 release-check 末尾三段确认（smoke / unit / integration 全 PASS）。

---

## 四、Phase 1 — T1 单测运行日志（dev ×1）

### T02 — `run-unit-tests.js` 改造
- 捕获 `node --test` stdout/stderr（保留实时回显），解析 TAP 摘要（`# pass/# fail/# tests/# duration_ms`）。
- 终端打印 `==== N/N PASS ====` + 每文件汇总（仿 `integration-runner.js`）。
- 落盘 `logs/unit-tests/unit-<时间戳>.log`（纯文本：元信息 + 原始输出 + 汇总）。
- **退出码透传不变**。

### T03 — 配套
- `.gitignore` 加 `logs/`。
- `CLAUDE.md` 删/改"No unit test framework — npm run smoke is the only automated test"过时句（改为指向 test:unit/integration/release-check 三层）。

### T04 — T1 unit
- `tests/unit/run-unit-tests-parse.test.js`：TAP 摘要解析（全 pass / 有 fail / 0 测试 3 档）。
- 验证：`npm run test:unit` 见 N/N + 生成日志文件；`npm run test:unit:coverage` 正常；`release-check` 退出码语义不变。

---

## 五、Phase 2 — T3 C2 配置增强（dev ×1）

### T05 — 数据结构 + 惰性迁移
- `scenarios-repository.js` 读 C2 config 时 `normalizeC2Config`（单条件→`conditions:[]`）；保存以新结构写回。
- 引擎入口兜底归一化。unit：迁移幂等。

### T06 — 引擎多条件 AND
- `c2-offset-bill-mark.js:30-42` `classifyRowsByBillTypes` 改 `conditions.every(evaluateCondition)`。
- unit：多条件全满足/任一不满足/单条件兼容/空条件。

### T07 — UI 多条件渲染
- `renderer-dialogs.js:7698-7810` 按 seq 分组 + 子序号 `#{seq}.{idx}` + 行内 `[新增]`（当前行下方插空白条件）+ 删除/事件适配。

### T08 — FundType 值下拉
- 新 `constants/fund-type-enum.js`（读 `assets/FundType枚举值.xlsx` 第一 sheet，有序+缓存）。
- 条件行 + 赋值行 value：`field==='FundType'` → 严格单选下拉；文件缺失降级文本输入 + 提示。
- ⚠️ 依赖用户提供 xlsx；缺失时先交付降级框架。

### T09 — 对账字段可空
- 放开 `renderer-dialogs.js:6816-6818` C2 校验 + 删除门槛（允许 0 行 / 留空行）。

### T10 — T3 验证
- unit（classify/normalize/fund-type）+ smoke（C2 多条件）+ `npm run preview:scenario-config-c2` 回归。
- **强制 `/check-vars`**（命中 scenario/engine）。

---

## 六、Phase 3 — T2 pending 移除核对（dev ×1，红线）

### T11 — migration 2 新表
- `pending-db/migrations.js` 幂等加 `removed_pending_rows` + `pending_removal_matches`（DDL 见 spec §3.1）。不动现有表。

### T12 — `removed-reader.js`
- 解析 `移除归档Pending账单.xlsx`（第一 sheet，46 列，缺表头报错）。unit：解析/报错/数字 sheet 名。

### T13 — `removed-repository.js`
- `replaceByMonth` / `listByMonth`（含 raw_json + 索引列提取）。

### T14 — 导入后交互 + IPC
- `renderer-pending.js`（:432 后）确认弹窗 + 移除文件 picker；`preload.js` + `main.js` 新 channel `pending:removed:import`；`pending-session.js` 串接。

### T15 — `removal-match.js`（对账后自动）
- 复用 `rule-repository.matchFields` 多轮 fallback；写 `pending_removal_matches`。unit：多档配对 + 双向未匹配。

### T16 — writer 2 新 sheet
- `pending-export/writer.js exportSingleRun` 末尾追加 sheetA（missing+状态列）+ sheetB（移除有missing无，条件）。

### T17 — T2 验证
- unit（reader/match）+ integration `scripts/integration/pending-removal-reconcile.js`（端到端契约）。
- **强制 `/check-vars`**。

---

## 七、Phase 4 — 收尾

### T18 — release-check 全绿
- 所有新 unit + integration 入 `release-check`，全 PASS。

### T19 — manual-test-checklist
- 产出 `manual-test-checklist.md`（T1/T2/T3 GUI case，含选"否"零变化、多条件 AND、FundType 下拉、对账字段空、导出 2 sheet 核对）。

### T20 — 文档三件套 + CLAUDE.md
- `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` + CLAUDE.md 修正（T1）。

### T21 — version bump + 终检
- `package.json` → `2.1.11-beta.1`；`npm run scan:vars` + `/check-vars` + `release-check`（CLAUDE.md 硬节点）。

---

## 八、委托记录（team-lead 填）

| Phase | dev agent | 状态 | 证据/PR |
|---|---|---|---|
| Phase 1 | dev-phase1-t1 | ✅ 完成（1269/1269 PASS · 日志落盘 · 退出码透传 · team-lead 已验）| working tree |
| Phase 2a（T3 后端）| dev-phase2-t3 | ⚠️→✅ agent 卡死中断，但后端已完成（引擎 AND / 迁移 / fund-type-enum）；team-lead 已验证 + 修 H4 smoke 回归，基线 1269 unit + smoke 全绿 | working tree |
| Phase 2b（T3 前端/IPC/测试）| dev-phase2b-t3-frontend | ✅ 完成（1295 unit + smoke + c2 preview 截图 + check:vars，team-lead 已验）| working tree |
| Phase 3a（T2 后端：表/reader/repo/match）| dev-phase3a-t2-backend | ✅ 完成（migration/reader/repo/removal-match，1313 unit + smoke，team-lead 已验匹配红线逻辑对齐 engine）；⚠️ agent 截断遗漏 removal-match unit → 转 3b 第一优先 | working tree |
| Phase 3b（T2 交互/导出/integration + 补红线测试）| dev-phase3b-t2-frontend | ✅ 完成（1325 unit + 928 integration[pending-removal 36/36] + smoke + check:vars；team-lead 已验 removal-match 红线 12 用例 + main.js 对账后匹配触发 graceful）| working tree |
| SR-FIX round 1（C1 数值红线 + I1-I5 + C2 守卫）| dev-srfix-1 | ✅ 完成（1331 unit + 934 integration + smoke；team-lead 已验 C1 数值归一化 / I4 DELETE 事务 / I5 strict 旧值 option 代码）| working tree |
| 手测 fix A1（markValue.type 校验误报）| team-lead | ✅ 完成（renderMarkValue 渲染前规整 markValue.type；smoke + preview + check:vars 已验）| working tree |
| 手测增强（T2 状态列三态：核对无误/有差异/未匹配 + compareFields 比对）| dev-t2-status-enhance | ✅ 完成（1338 unit + 943 integration[pending-removal 51] + smoke；team-lead 已验比对实现；spec/PRD reverse sync 由 team-lead 补回写 — R2-I1）| working tree |

# v2.1.11 Self-Review Round 1 — Findings

| 字段 | 值 |
|---|---|
| 日期 | 2026-05-29 |
| 方式 | 3 路并行 adversarial review（sr-t2-redline / sr-t3-redline / sr-cross-cutting），只读 |
| 基线 | unit 1325/1325 + integration 928/928 + smoke 全绿（findings 均在"测试全绿"前提下发现，说明测试有盲区）|

## 数量小结

| 级别 | 数量 |
|---|---|
| 🔴 Critical | 1 功能红线 + 2 提-PR-前 todo |
| 🟡 Important | 7 |
| 🟢 Minor | 5 |

3 位 reviewer 一致评价：代码核心质量扎实（T2 匹配逻辑/T3 三处迁移/T1 退出码均无功能性崩溃），但有 1 个**实测复现的红线 bug** + 若干健壮性/体验缺口。

---

## 🔴 Critical

### C1 [功能红线 · 已实测复现] removal-match 数值字段比较与 pending 入库管线不一致 → 按金额配对系统性失配

- **出处**：pending 行入库走 `streaming-xlsx-reader.js:88-97`（数值 cell → `String(parseFloat(v))`，如 `"1234.5"`）；移除行走 `removed-reader.js:117`（`sheet_to_json({raw:false})` → 显示格式串，如 `"1,234.50"`）；`removal-match.js:35-46` 两侧 `String()` 后**字符串比较**。
- **实测复现**（reviewer 用 xlsx 构造 numFmt cell）：`1234.50` → pending `"1234.5"` vs removed `"1,234.50"` ❌；`1000` → `"1000"` vs `"1,000.00"` ❌；仅 General 格式巧合一致。
- **旁证**：C2 引擎对金额类字段显式用数值比较 `valuesEqual(...,{numeric:true})`（`c2-offset-bill-mark.js:101`），证明团队清楚金额不能裸字符串比 —— 但 removal-match 无任何数值归一化。
- **影响**（资金/对账红线）：`matchFields` 含 `金额`（常用 fallback key）时，本应被移除归档解释的 missing 行因金额串不等而落入「missing有_移除无」，同时该 removed 行落入「移除有_missing无」—— **同一笔被同时误报在两张 sheet**，对账人据此误判。
- **修复方案**：removal-match 比较前对数值类字段两侧统一归一化（复用 `engine-utils` 的 `isNumericFieldName`+`parseNumber`，与 C2 引擎口径一致）；并补「金额带千分位/尾零」的 unit + integration（现有测试全用纯字符串 key，零覆盖此 divergence）。

### C2 [提-PR-前 todo] `assets/` 两个 xlsx 未 git add（UNTRACKED）

- `assets/FundType枚举值.xlsx` + `assets/移除归档Pending账单.xlsx` 均 `??`（从未 add）。`fund-type-enum.test.js:49` 有 skip 守卫（文件缺失静默跳过）→ CI **假绿**。
- **影响**：PR 合并/打包后 asset 不进产物 → T3 FundType 下拉生产环境静默降级为文本输入；契约测试给假绿信号。
- **修复**：`git add` 两个 asset；建议把 :49 skip 守卫改 `assert.fail`（asset 缺失变硬失败）。

### C3 [提-PR-前 todo] `package.json` 未 bump（Phase 4 T21）

- 仍 `2.1.10`；docs 三件套已写 2.1.11。按 CLAUDE.md 硬节点：bump → `2.1.11-beta.1` + 重跑 `scan:vars` + `/check-vars`。

---

## 🟡 Important

| ID | 出处 | 问题 | 建议 |
|---|---|---|---|
| **I1** | `renderer-pending.js:658-683` | 对账后 `result.removalMatch` 被 renderer **完全忽略**，用户对"匹配 N 条/未匹配 M 条"零反馈（移除核对是核心卖点）| 对账完成文案追加 removalMatch 摘要 |
| **I2** | `main.js` reconcile:run | 移除文件按"导入月"入库，对账按 `payload.upperMonth` 匹配；不一致时静默零匹配无提示 | 匹配跳过/月份错配时给提示 |
| **I3** | `writer.js:354` vs exportAggregate | 聚合导出不含移除 2 sheet 且无说明 → 用户误判"无移除结果" | 聚合导出时若有移除数据给提示 |
| **I4** | `removal-match.js:68` | `DELETE pending_removal_matches` 在事务（:98 BEGIN）**之外**先提交；INSERT 抛错 ROLLBACK 后旧匹配已删未重建 | DELETE 挪进同一事务 |
| **I5** | `renderer-dialogs.js:124` | strict FundType 下拉：旧值不在枚举内时显示空（model 仍留旧值）→ 显示与数据背离，用户可能误选覆盖旧值 | 保留原值为 disabled option + 提示 |
| **I6** | `scenarios-bundle-import.js` | bundle 导入旧结构 C2（写入不迁移、读取才迁移）无端到端测试 | 补 1 条 integration/unit |
| **I7** | `rules/important-variables.md:194` | `conditionsLogic`(C1) 是 Critical 红线，对位的 C2 `billTypes`/`conditions` schema 未登记 → check:vars 符号匹配盲区漏报 | 评估升格入表 |

---

## 🟢 Minor

| ID | 问题 |
|---|---|
| M1 | spec 多处写"挂 `pending-session.js`"，实际逻辑落 `main.js`（功能等价，reverse sync 未回写）|
| M2 | `removed-reader` 46 列严格等值校验，列序/列名微调即拒收（设计取舍，知会）|
| M3 | C2 UX footgun：加了第二条件行但留空 → 该账单类型因 AND 整体静默不匹配（语义安全不赋错值，但易误操作）|
| M4 | `c1.png` 被重渲染但 C1 零代码改动（像素噪声，非误伤）→ PR body 备注 |
| M5 | `fund-type-enum.test.js:46` 硬编码 10 值 + :49 skip 守卫（并入 C2 一起改）|

---

## 修复优先级建议（team-lead）

- **必修（提 PR 前）**：C1（红线 bug）+ C2（asset add）+ C3（version bump）
- **建议本版修**（小改 + 红线/核心卖点）：I1（核心卖点反馈）+ I4（红线原子性）+ I5（防旧值误覆盖）+ I2/I3（防误判提示）
- **记 follow-up / PR body known-limitation**：I6（测试补充）+ I7（important-variables 升格）+ Minor 各项

## Reviewer 总评

- sr-t2-redline：1 Critical（数值）+ 4 Important + 3 Minor + 5 测试盲区
- sr-t3-redline：0 功能 Critical（迁移三重覆盖、AND 正确）+ 2 Important + 3 Minor — "主路径安全"
- sr-cross-cutting：2 提-PR-前 🔴（asset/bump）+ 2 Important + 2 Minor；T1 coverage 解析/尾部/降级/IPC 对齐/preview 回归 **5 个怀疑点实测均无问题** — "暂不直接提 PR，先清 2 个 🔴"

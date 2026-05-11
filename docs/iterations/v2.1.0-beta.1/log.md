# log — v2.1.0-beta.1 单据对账 ReconID 修复模块

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.1` |
| 关联 PRD | `PRD-v2.1.0-beta.1.md` |
| 关联 spec | `spec.md` |
| 关联 tasks | `tasks.md` |
| 起草日期 | 2026-04-30 |

> 实施过程中的关键决策、风险发现、可沉淀知识。每个里程碑追加一节。

---

## 2026-04-30 PM 回写 4 个 Open Question 决策完成

- **动作**：用户对 4 个 Open Question 给出决策（Q1=A / Q2=A / Q3=C / Q4=部分采纳），PM 角色按决策回写到 PRD-v2.1.0-beta.1.md / spec.md / tasks.md
- **决策摘要**：
  1. **Q1=A** — `lookupReconId` 直读 `row.reconId`（业务/对手账单 sheet 已带正确 reconId 列），删 dry-run fallback 与回查 reconResult 分支
  2. **Q2=A** — R5/R6 SubBizType 自动查 reconResult sheet 未命中 → SubBizType 留空 + warnings 报告，不中断
  3. **Q3=C** — 识读规律颜色冲突 → 取该行"有数据 cell"（cell.value 非 null/非 ''）出现频率最高的色；平票取首次出现色
  4. **Q4=部分采纳** — 单场景模式确认；主页面新增"场景"单选下拉（位置：行 1 「导入文件」与「开始运行」之间；空场景态 disabled；改场景列表后实时刷新；与 run 按钮联动）
- **可追溯标记**：所有修订段落已加 `<!-- 2026-04-30 决策回写：Q? -->` HTML 注释
- **PRD 修订段落**：D6 / D10 / D11 / 6.1 / 6.4 / 7.4 / 8.4 / 12.1 表头 / 14
- **spec 修订段落**：1.1（PR-A 文件 12 → 13）/ 三 `recon-id-fix:run` payload / 5.2.1 / 5.2.3 / 5.3 / 7 / 9.3 / 12
- **tasks 修订段落**：PR-A 总数 8 → 9（新增 A9）/ A3 / A4 / B12 / C1 / 9.3 smoke 5 → 6 用例
- **从 Open Question 移除**：原 spec §12 的 Q1（lookupReconId）和 Q2（颜色冲突）；原 PRD §14 的 SubBizType 未命中边界；保留远期 Q3（多场景批量跑）作未来扩展项
- **下一步**：通知 Dev 启动 PR-A（task A1-A9）；A9 与 A3/A4 强耦合，建议 A3 → A4 → A9 顺序实施

---

## 2026-04-30 PM 落 spec 完成

- **动作**：PM 角色落 v2.1.0-beta.1 三件套（PRD + spec + tasks + log），目录 `docs/iterations/v2.1.0-beta.1/`
- **依据**：用户 5 轮澄清 + 样例 xlsx（`samples/单据对账导出不平.xlsx` / `samples/单据对账导出不平-对平例子.xlsx`）+ v2.0.0-beta.3 三件套样板（PR #29-#33 完整实施路径）
- **关键决策记录**：
  1. 复用 v2.0.0-beta.3 `scenarios` 表，CHECK 约束扩 4 值（migration 走 RENAME-CREATE-INSERT-DROP-COMMIT 重建表）
  2. 新模块**不预置 builtin scenarios**（区别于 v2.0.0-beta.3）
  3. 单场景跑模式（**不复用** `scenario-dispatcher.js`，本模块独立 IO + 引擎）
  4. 输出格式无标黄需求 → **不复用** `exceljs-writer.js`，用 `xlsx-js-style`（已在依赖里）
  5. 资金红线双层防御：完全沿用 v2.0.0-beta.3 PR #33 round 2/3 的 4 IPC 入口主动清 + export 端 snapshot 校验
  6. 识读规律：纯规则（fields-equal mining + 颜色分组），不接大模型
  7. 规则修订（5 轮澄清最后一轮）：1v 多与多 v1 互斥，但 1v1 可与任一另一项共勾
- **证据**：
  - 样例 xlsx 4 sheet 表头确认（业务部门账单 23 列 / 对手部门账单 22 列 / 对账结果 18 列 / 订单修复 15 列）
  - v2.0.0-beta.3 实施路径完整复盘（migrations.js / scenarios-repository.js / scenario-dispatcher.js / bank-statement-io.js / exceljs-writer.js）
  - 当前 v2.0.0 GA package.json version=2.0.0；本迭代版本号 bump 由 PR-D 完成
- **风险**（PRD §十）：
  - 资金红线 ⚠️：错误 Reference 关联 / 错误 SubBizType 取值 / 共同 ID 拼接错位 / 场景配置变更后 stale result 导出
  - 算法稳定性 ⚠️：识读规律误判会污染场景库（缓解：识读仅"自动填表"不"自动落库"）
  - 数据库迁移：CHECK 约束变更需重建表 → 老库无损迁移用例必须覆盖
- **决策**：本三件套作为 v0.1 draft，待用户 review 后定稿；任何用户反馈先回写 PRD/spec/tasks，再开 PR-A
- **下一步**：通知 Dev 开始 PR-A（task A1-A8）；用户确认 spec 可进入实施

---

## 待补：PR-A 启动

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 待补：PR-B 启动

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 待补：PR-C 启动

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 2026-04-30 PR-D dev round 1 完成（5 task D1-D5）

- **动作**：dev 角色实施 PR-D 5 task（D1 版本号 bump / D2 CHANGELOG / D3 VERSION_FEATURE_HISTORY / D4 USER_GUIDE / D5 整体回归）
- **改动文件**（6 个）：
  - 版本号：`package.json`（"2.0.0" → "2.1.0-beta.1"）+ `package-lock.json`（root + `packages.""` 同步）
  - 项目配置：`CLAUDE.md`（Branch Structure 表新增 v2.1.0 行 + main 版本号 1.5.0 → 2.0.0 同步）
  - 三件套：`CHANGELOG.md`（顶部插入 v2.1.0-beta.1 段，5 模块全景 + 3 PR 汇总，PR-C 标取消）+ `docs/VERSION_FEATURE_HISTORY.md`（同结构）+ `docs/USER_GUIDE.md`（顶部版本号 + 模块总览第 5 项 + 1.5 章节 6 小节 + 5 个截图占位）
- **PR-C 取消反映**：USER_GUIDE 1.5 章节**不写识读规律小节**（原 1.5.5 留作"输出文件格式"）；CHANGELOG / VERSION_FEATURE_HISTORY 里 PR 汇总改为 3 PR（A/B/D），PR-C 标 `~~取消~~`
- **测试证据**：
  - `npm run smoke` **272/272 PASS**（baseline 不退步）
  - `npm run preview` + `npm run preview:all` 全部 PASS（45 个 preview）
  - `npm run scan:vars` 输出 v2.1.0-beta.1 报告（60 JS 文件 / 601 顶层声明 / A-share 101 / A-pair 153 / B-cross 254）
  - `npm run check:vars` skipped（PR-D 无 src/ 改动）
- **升格候选**（未在 `rules/important-variables.md` 但跨 ≥ 3 文件）：
  - Critical 候选：`BUSINESS_BILL_FIELDS` / `OPPONENT_BILL_FIELDS` / `ORDER_REPAIR_FIELDS`（4 sheet 字段常量，与 preload inline 副本严格同步；同类已收录 `BANK_STATEMENT_FIELDS` / `GATEWAY_RECON_FIELDS`）
  - Risk-sensitive 候选：`ensureScenariosCategoryReconIdFix` / `migrateC4ReconGroupsStructure` / `migrateC4ReconGroupsAmountLockedFieldPair`（DB 迁移函数，同 `ensureScenariosSupport` 等已收录条目结构）
  - 详细列表 + 跨文件分布见 `docs/analysis/var-reference-stats.md`
- **风险**：无新代码改动；纯文档 + 版本号 bump
- **决策**：dev round 1 完成等待用户手动测试；用户确认后由 team-lead 提 PR
- **下一步**：通知 team-lead "代码已完成自测，等用户测试"

---

## 待补：PR-D 用户测试 + PR 提交 + 发版

- 动作：—
- 证据：—
- 风险：—
- 决策：—

---

## 2026-04-30 PR-B Q1=B / Q2=a 决策回写（用户测试发现 spec/实现脱节）

- **背景**：用户跑 fixture（`/Users/pzhong/Desktop/小助手-Debug/2.0.0/订单枚举表/单据对账导出不平.xlsx`）做手工测试发现 2 个问题：
  - Q1：对账字段 dialog 每按"新增"按钮就 seq+1 → 用户配 (Currency, Amount, BizType) 三条时变成 OR；用户期望默认 AND
  - Q2：mode=both 共同 ID 取的是 OrderId，但用户期望文件（`/Users/pzhong/Downloads/单据对账修复-202604301427-基金-应导出文件.xlsx`）里的 commonId 实际是 reconId 拼接结果

- **决策**（用户拍板）：
  - **Q1=B**：去 seq 概念，改为 `reconGroups[]`（每组自带 leftTypeSeq/rightTypeSeq + fieldPairs[]，组内 AND，组间 OR）。dialog 默认 1 个 group + 1 行 fieldPair；"+ 新增字段对" 加 AND 行，"+ 新增 OR 分组" 另开 group block
  - **Q2=a**：commonId 基础部分从 `src.OrderId` 改为 `src.reconId`；下拉 option 文案"主边/从边单据 ID" → "主边/从边单据 reconId"

- **改动清单**（13 文件）：
  - **数据模型 + DB**：`src/backend/database/migrations.js`（新增 `migrateC4ReconGroupsStructure`，幂等扫 C4 场景按 seq 聚合 reconFields → reconGroups）+ `src/backend/database.js`（链路调用）
  - **C4 引擎**：`src/main-process/scenario-engines/c4-recon-id-fix.js`（`groupReconFields(cfg)` 直接读 `cfg.reconGroups` + fallback 兼容老 reconFields；`computeCommonId` 用 `src.reconId`）
  - **dialog**：`src/renderer-dialogs.js`（createDefaultScenarioConfig C4 默认改 reconGroups；dialog 主体 in-memory 把老 reconFields draft 转换；行 4 重写为分组 block + AND/OR 按钮分流；行 5 commonId option 文案改 reconId；validateScenarioDraft 适配 reconGroups；createScenarioConfirmDetailDialog C4 文本预览适配 reconGroups + commonId 文案改 reconId）
  - **smoke 更新**（6 文件）：`recon-id-fix-engine.js`（reconGroups 单测 + commonId reconId 期望值 + 新增多 group OR 集成用例 → 17 用例）/ `recon-id-fix-end-to-end.js`（E3 commonId 期望改 reconId+suffix）/ `recon-id-fix-ipc-handlers.js`（makeC4Payload 用 reconGroups）/ `recon-id-fix-scenario-ipc.js`（同上）/ `scenario-dispatcher.js`（makeC4Scenario 用 reconGroups）/ `scenarios-repository.js`（R6 用 reconGroups）
  - **smoke 扩**：`scripts/smoke/migrations-recon-id-fix.js` 加 G1-G5 共 5 个用例（reconFields → reconGroups 迁移 + 幂等三连 + 仅扫 C4 + JSON 解析容错 + reconFields 残留清理）

- **PRD/spec 更新**：
  - PRD §三 D4 重写（去 seq，改 reconGroups + AND/OR 按钮分流）
  - PRD §三 D5.2 修订（OrderId → reconId）+ §六 D6 5 条 RB 表 Reference 描述补充
  - PRD §八 8.2（config_json 结构 reconFields → reconGroups）+ §八 8.4（commonId 备注追加 reconId 说明）
  - spec §一 1.2 PR-B 文件清单扩到 12+ 文件
  - spec §二 2.5（新增）migration `migrateC4ReconGroupsStructure` 实现规约
  - spec §五.2.1（computeCommonId 改 reconId）+ §五.2.2（多 group OR 行为追加）
  - spec §九.2（smoke 范围更新到实际 17/9/5/15/11 用例）

- **测试证据**：`npm run smoke` 全套 232/232 PASS（baseline 226 + 6 新用例：5 个迁移 G1-G5 + 1 个多 group OR 集成）

- **风险（资金红线）**：
  - DB migration 必须幂等（已 G2 三连验证，修复 reconFields → reconGroups 转换不重复执行）
  - 老 reconFields[] 数据必须无损迁移（已 G1 验证 leftTypeSeq/rightTypeSeq + fieldPairs 全等聚合）
  - C2/C3 场景 reconFields[] 不能被误改（已 G3 验证：迁移仅扫 category='recon-id-fix'）
  - PR-A 已合并的资金红线（scenarios:* 4 IPC 按 category 分流清缓存 + export 端 stale-snapshot 防御 + C4 dialog 4 条数据完整性校验）一律保留语义，校验路径已适配 reconGroups 结构

- **风险显式提醒**：
  - 数据库迁移（CLAUDE.md §7 红线）：migration 已加幂等三连 smoke + 不影响 C1/C2/C3 smoke + JSON 解析容错
  - 资金（commonId 改语义）：用户验证文件已比对，reconId 拼接是正确语义；smoke 期望值已全部改完

---

## 2026-04-30 PR #36 round 1 P2 修复（_rowIdx tie-break 字典序 → 数字部分比较）

- **背景**：Codex bot review PR #36 round 1 给了 2 个 P2 finding（同一根因），都在 `src/main-process/scenario-engines/c4-recon-id-fix.js`：
  - **P2-1**（`pickBestByTieBreak` 第 360 行附近）：When Step 2 has at least 10 same-distance candidates, this string key makes `_rowIdx` sort lexicographically, so `opp_10` is chosen before `opp_2` even though the documented fallback is the smallest original row index.
  - **P2-2**（`tieBreakSubsets` 第 242 行附近）：For 1vN/Nv1 subset tie-breaks, using the raw `_rowIdx` string means otherwise-equal subsets choose rows like `opp_10` before `opp_2`. In pools with 10+ candidates and equal spread/distance/size, the fallback no longer reflects original input order.

- **根因**：`_rowIdx` 由 `classifyRows` 生成为 `'<side>_<idx>'` 字符串（idx 是原数组下标）；两处 tie-break 用 `r._rowIdx` 字符串字典序作兜底排序键。当原数组 ≥ 10 行时 `'opp_10'` < `'opp_2'`（字典序按字符比较，`'1' < '2'`），违反 spec 文档"原数组首个 row index"约定。

- **决策**（方案 A — 最小侵入）：新增 `parseRowIdxNum(rowIdx)` 工具函数解析 `_rowIdx` 数字部分（正则 `/_(\d+)$/` 末尾连续数字），两处 tie-break sort key 改用数字比较。`_rowIdx` 字符串本身保留（pairedLeft / pairedRight Set 等其他用法不变）。

- **改动清单**（4 文件）：
  - `src/main-process/scenario-engines/c4-recon-id-fix.js`：
    - 新增 `parseRowIdxNum(rowIdx)` 工具函数（位于 `parseBillDateMs` 之后，含 PR #36 round 1 P2 注释）
    - `pickBestByTieBreak` 排序 key 从 `idx: r._rowIdx || ''` 改为 `idxNum: parseRowIdxNum(r._rowIdx)`，比较逻辑 `a.idxNum - b.idxNum`
    - `tieBreakSubsets` 中 firstIdx 字符串排序 → `firstIdxNum = Math.min(...s.map(r => parseRowIdxNum(r._rowIdx)))`，比较逻辑改为数字比较
    - module.exports 暴露 `parseRowIdxNum`（smoke 单测用）
  - `scripts/smoke/recon-id-fix-engine.js`：
    - 修 `runRound4SubsetSumHelpers` 测试 4：`'F1'/'F2'/'F3'/'F4'` 改成生产格式 `'opp_1'/'opp_2'/'opp_3'/'opp_4'`，期望保持 subsetQ（含 opp_1 数字最小）
    - 新增 `runPR36P2PickBestByTieBreakNumeric`（P2-1 修复用例）：直接单测 `pickBestByTieBreak` 12 候选 + 端到端 Step 2 ≥10 候选验证选 `opp_2`（数字最小）
    - 新增 `runPR36P2TieBreakSubsetsNumeric`（P2-2 修复用例）：端到端 1v多 subset-sum 12 候选过滤后 10 候选 + 直接单测 `tieBreakSubsets` 同 spread/dist/size 数字部分兜底 + `parseRowIdxNum` 单测
    - tests 注册新增 2 用例（35 → 37）
  - `docs/iterations/v2.1.0-beta.1/spec.md`：
    - §五.2.3 `pickBestByTieBreak` 文档把"`_rowIdx` 字符串字典序最小"改为"`_rowIdx` 数字部分（解析后比较）最小"，伪代码 sort key 改 `idxNum`，附 P2 修复说明
    - §五.2.4.1 `tieBreakSubsets` 实现把字符串排序改为 `firstIdxNum = Math.min(...)` 数字比较，新增 `parseRowIdxNum` 工具函数文档块
  - `docs/iterations/v2.1.0-beta.1/log.md`：本节

- **测试证据**：
  - `npm run smoke` **262/262 PASS**（baseline 260 + 新增 2 P2 修复用例；recon-id-fix-engine smoke 35 → 37）
  - 真实 fixture 回归（无退步）：
    - 基金 fixture（`/Users/pzhong/Desktop/小助手-Debug/2.0.0/订单枚举表/单据对账导出不平.xlsx`）：fixedRowCount=80 / mainTouched=30 / oppTouched=50 / unmatched=0 / warnings=0（与 round 4/5 baseline 完全一致）
    - FX 中台入金 fixture（`/Users/pzhong/Desktop/小助手-Debug/2.1.0/FX中台入金-初始.xlsx`）：fixedRowCount=96 / mainTouched=36 / oppTouched=60 / unmatched=18 / warnings=0（与 round 5 baseline 完全一致）；用户用例 FTA202604280200028 ↔ 202604271439325696974017228 双双命中并共享 commonId
  - 修复前后行为差对照（手算）：
    - 候选数组 `['opp_10','opp_3','opp_5','opp_11','opp_7','opp_4','opp_8','opp_6','opp_9','opp_2']`
    - 字典序排序首个 = `'opp_10'`（修前 bug 行为）
    - 数字序排序首个 = `'opp_2'`（修后正确行为）

- **风险显式提醒**：
  - 资金红线（tie-break 唯一性 + 与原数组顺序一致）：修后行为更严格符合 spec 文档"原数组首个 row index"约定，对 ≥ 10 行的真实业务场景才有可观测差异；< 10 行场景行为不变（字典序与数字序在 0~9 范围内一致）
  - 资金红线（不破坏 round 1-5 已验证逻辑）：用户用例 FTA + 真实 fixture 全部回归 PASS；P2 修复仅影响"≥ 10 候选 + 同 dist/spread/distToMain/size 全等"路径，不改 Step 1 严格 / Step 2 单候选 / 池子 subset-sum / 双向一致性等其他路径
  - 兼容性：`_rowIdx` 字符串本身不变（pairedLeft / pairedRight Set / lastStepBy* Map 等用法保留），仅 sort key 改成数字解析

- **下一步**：等用户合并 PR #36

---

## 2026-04-30 PR #36 round 2 P2 修复（subset-sum 全局最优；DFS 全遍历维护 best）

- **背景**：user (MatthewPZhong) 在 PR #36 上提了新的 P2 finding（round 1 P2 修复之后再发现的）：

  > 这轮修复只把 `_rowIdx` 改成了数字比较，但 `enumerateAmountSubsets()` 仍然在 DFS 中达到 `maxSolutions` 后立即停止。后续 `tieBreakSubsets()` 只能在前 64 个枚举解里选最优，真正日期跨度更小/离主单更近的解如果排在第 65 个之后仍会被漏掉。

  user 提供了可复现用例：10 个 `2026-04-01` 候选 + 3 个 `2026-04-15` 候选、`target=300` 时，前 64 个解里 0 个全 04-15 子集（解空间 C(13,3)=286，前 64 解都是 04-01 子集主导），最终选了 04-01 子集（spread=0+distToMain=14day 次优），而非 3 个 04-15（spread=0+distToMain=0 全局最优）。

- **根因**：`enumerateAmountSubsets(...) → tieBreakSubsets(...)` 二段式语义错位：
  1. `enumerateAmountSubsets` DFS 遇到 `maxSolutions=64` 解后立即停（"先截断"）
  2. `tieBreakSubsets` 在前 64 解里排序选最优（"再排序"）

  这是"先截断再排序"——只有当全局最优能被前 64 解覆盖时才正确。`maxSolutions=64` 是 round 4 设计为防组合爆炸（O(2^n)）的上限，但对"全局最优排在第 N>64 位"的合理业务场景没法保证正确。

- **决策**（方案 A — 强烈推荐项，不选 B / C）：DFS 全遍历维护全局 best
  1. 新增工具函数 `findBestAmountSubset(candidates, targetCents, mainBillDate, options)`：
     - DFS 找到 `sum=target` 的解时，立即与"当前 best"做完整 tieBreak 比较（spread → distToMain → size → firstIdxNum）
     - 不收集 solutions 数组、不预截断；遍历所有可能解
     - 返回 `Array<row>`（最优子集，按 `_origIdx` 升序）；无解返回 `null`
  2. **池子算法**（`tryOneToManyPool` / `tryManyToOnePool`）改用 `findBestAmountSubset`，不再调用 `enumerateAmountSubsets` + `tieBreakSubsets` 二段式
  3. **保留** `enumerateAmountSubsets` / `tieBreakSubsets` 函数及其 exports（向后兼容 + 单测覆盖），但**注释明确标注"池子算法不再调用，仅供单测/向后兼容"**
  4. 性能保障（防止全遍历退化）：
     - 升序剪枝（`c.cents > remaining` break，与旧实现一致）
     - 后缀总和剪枝（`suffixSum[startIdx] < remaining` 时 return）
     - **top-k 后缀剪枝（新增）**：剩余可选元素中最大的 `(maxSize - depth)` 个的和 < remaining 也剪
     - `maxSize=8`（业务上限，与旧实现一致）
     - 启发式提前终止：当 best 已是 `spread=0 + distToMain=0 + size=2` 时 break（绝对最优下确界）
     - `hardCeiling=5M`（DFS visit 次数硬上限；仅极端数据兜底）

- **改动清单**（4 文件）：
  - `src/main-process/scenario-engines/c4-recon-id-fix.js`：
    - 新增 `findBestAmountSubset(candidates, targetCents, mainBillDate, options)` 函数（位于 `enumerateAmountSubsets` 之后、`tieBreakSubsets` 之前）
    - `tryOneToManyPool` 改用 `findBestAmountSubset` 替换 `enumerateAmountSubsets`+`tieBreakSubsets` 二段式（删 `subsets.length === 1 ? ... : tieBreakSubsets(...)` 分支）
    - `tryManyToOnePool` 同上
    - `enumerateAmountSubsets` / `tieBreakSubsets` 加注释（"池子算法不再调用；保留供单测/向后兼容"）
    - 文件头部 round 4 注释加 round 2 P2 修复段落
    - `module.exports` 加 `findBestAmountSubset`
  - `scripts/smoke/recon-id-fix-engine.js`：
    - import 加 `findBestAmountSubset`
    - **删除** `runRound4SubsetSumHelpers` 中"截断到 64"硬断言（line 742），改为"解数 ≤ maxSolutions"弱断言（覆盖函数本身行为，不再暗示池子语义合理）
    - 新增 4 个 smoke 用例：
      - `runPR36Round2P2UserRepro` — user 复现用例 10 个 04-01 + 3 个 04-15 + target=300 直接单测 `findBestAmountSubset` 返回全 04-15 子集；同时验证旧二段式仍 reproducible bug（防回归）
      - `runPR36Round2P2GlobalBestBeyond64` — 全局最优 `{opp_12, opp_13}` 排在第 N=91 位（C(14,2)=91 截断到 64 解里 0 个最优）→ 修后能找到
      - `runPR36Round2P2EndToEndPool` — 通过 `runReconIdFix` 走 `tryOneToManyPool` 验证端到端集成（mode=opp + oneToMany + 13 个 100 候选 + target=200 → 命中 firstIdxNum 最小子集 {S0, S1}）
      - `runPR36Round2P2PerformanceN20` — 复刻 `runRound4LargePoolPerformance` 的 n=20 场景，断言 `findBestAmountSubset` 找到 `{opp_18, opp_19}={789,211}=1000` 且 < 1s
    - tests 注册新增 4 个用例（37 → 41）
  - `docs/iterations/v2.1.0-beta.1/spec.md`：
    - §五.2.4 标题加 "PR #36 round 2 P2 修复 2026-04-30"
    - §五.2.4 加 "原 enumerate→tieBreak 二段式问题 + findBestAmountSubset 替代" 段落
    - §五.2.4 中 `tryOneToManyPool` / `tryManyToOnePool` 伪代码改用 `findBestAmountSubset`（删 `subsets.length === 1 ? ... : tieBreakSubsets(...)` 分支）
    - §五.2.4.1 `enumerateAmountSubsets` 注释加 "池子算法不再调用" 警告
    - §五.2.4.1 新增 `findBestAmountSubset` 完整伪代码 + 性能保障详解
    - §五.2.4.1 `tieBreakSubsets` 注释加 "池子算法不再调用" 警告
    - 性能边界提示更新为 "新实现 findBestAmountSubset 全遍历 + top-k 剪枝；n=20 实测 1.14ms / 次"
  - `docs/iterations/v2.1.0-beta.1/log.md`：本节

- **测试证据**：
  - `npm run smoke` **266/266 PASS**（baseline 262 + 新增 4 P2 round 2 用例；recon-id-fix-engine 37 → 41）
  - **user 复现用例验证**（pre/post fix 行为对照）：
    ```
    10 个 04-01 100 + 3 个 04-15 100 + target=300（mainBillDate=04-15）
    --- 修前（enumerateAmountSubsets+tieBreakSubsets）---
      总解数: 64（C(13,3)=286 截断）
      64 解中：全 04-15 子集 0 个 / 全 04-01 子集 36 个 / 混合 28 个
      tieBreak 选了 [opp_0, opp_1, opp_2]（3 个 04-01，distToMain=14day 次优）
    --- 修后（findBestAmountSubset DFS 全遍历）---
      选中: [opp_10, opp_11, opp_12]（3 个 04-15，spread=0+distToMain=0 全局最优）
    ```
  - **fixture 回归**（修前修后数字一致，不退步）：
    - `单据对账导出不平.xlsx × FX 入账 scenario`（同测试配置 baseline）：fixedRowCount=46 / mainTouched=18 / oppTouched=28 / unmatched=0 / warnings=0（修前修后完全一致）
    - `FX中台入金-初始.xlsx × FX 入账 scenario`：fixedRowCount=113 / mainTouched=44 / oppTouched=69 / unmatched=25 / warnings=0（修前修后完全一致）
    - 用户用例 **FTA202604280200028 ↔ 202604271439325696974017228** 双双命中：`Reference=PP_20260428020000_USD_HK0000720752-FIX`，主从共享 commonId
  - **性能对比**（n=20 大池子 100 次平均）：
    ```
    findBestAmountSubset       1.14ms / 次
    enumerateAmountSubsets+tieBreakSubsets   2.58ms / 次
    ```
    新实现的 top-k 后缀剪枝实际比"截断到 64 解"更快收敛到正确答案

- **风险显式提醒**：
  - **资金红线（subset-sum 唯一性 + 全局最优）**：本次修复**改变了池子算法的输出语义** — 原"前 64 解中最优" → 新"全局最优"。对"全局最优在前 64 解中"的常见场景行为不变（fixture 回归数据一致）；对"全局最优在 N>64 位"的边缘场景行为修正（user 复现用例）。
  - **资金红线（保留旧函数）**：`enumerateAmountSubsets` / `tieBreakSubsets` 仍 export，仅为向后兼容 + 单测覆盖；现有 smoke 既有用例 + round 1 P2 单测仍跑通；池子算法不再调用，**新代码不应再使用这两函数做池子配对**
  - **性能（防退化）**：n=20 大池子修后 1.14ms（比修前 2.58ms 更快）；hardCeiling=5M visit 上限作极端数据兜底（n>30 + cents 极小时可能触发）
  - **兼容性**：`enumerateAmountSubsets` / `tieBreakSubsets` 函数签名/行为完全保留；smoke 删的"截断到 64 硬断言"改为"解数 ≤ 64 弱断言"，不破坏函数行为单测

- **follow-up（已知，非 blocker）**：
  - hardCeiling 默认 5000000 是经验值（n=20 真实场景 < 1k visits）；若用户上极端数据（n>50 + cents 极小 + 多 BillDate）触发 abort，应在 unmatched.xlsx 加警示行
  - `findBestAmountSubset` 当前不返回"是否 abort"标志；future 可改返回 `{ subset, aborted }` 结构便于 unmatched 推断

- **下一步**：等用户合并 PR #36 round 2

---

## 2026-04-30 PR #36 round 3 P2 修复（删除"absolute optimal 早停"剪枝；user 提）

- **背景**：user (MatthewPZhong) 在 round 2 修复后再发现 P2 finding：

  > `isBestAbsoluteOptimal()` 把 `spread=0 + distToMain=0 + size=2` 当作绝对最优并让 DFS 提前返回，但 tie-break 还有最后一层 `firstIdxNum`。如果先遇到的是 `opp_10+opp_11` 这种 size=2 同日解，后面还有同样 spread/dist/size 但 firstIdx 更小的 `opp_2+opp_3`，当前实现会提前停在前者。
  >
  > 我用当前 head 复现：candidates `[opp_10:1, opp_2:50, opp_3:50, opp_11:99]`、target=100、同日时返回 `opp_10/opp_11`，但按完整 tie-break 应返回 `opp_2/opp_3`。建议不要在未证明 firstIdxNum 已不可更优时提前停止，或把最优下界条件也纳入 firstIdxNum。

  本地 head=f16166b 复现确认：`findBestAmountSubset(candidates, 100, '2026-04-15')` 返回 `[opp_10, opp_11]`（错），期望 `[opp_2, opp_3]`（对）。

- **根因**：round 2 引入的 `isBestAbsoluteOptimal()` 早停条件不充分。tie-break 实际有 4 阶（spread → distToMain → size → firstIdxNum），早停条件只覆盖前 3 阶（spread=0 / distToMain=0 / size=2）。bug 路径：

  1. DFS 按 cents 升序遍历：cents=1 (opp_10) < 50 (opp_2) < 50 (opp_3) < 99 (opp_11)
  2. 第一个找到的 sum=100 解：`opp_10(1) + opp_11(99)`，best={size=2, spread=0, dist=0, firstIdxNum=10}
  3. 触发 `isBestAbsoluteOptimal()` break → 不再尝试 `opp_2(50) + opp_3(50)`（firstIdxNum=2 更优）

- **决策**（方案 A — 强烈推荐项，不选 B/C）：完全删除 `isBestAbsoluteOptimal()` 早停剪枝
  - 理由 1：B（修剪枝条件含 firstIdxNum）复杂、依赖 candidates 排序约定、易再次出错
  - 理由 2：C（保留剪枝但延迟到完整遍历后）实现复杂、依赖 DFS 顺序约定
  - 理由 3：方案 A 最简单可证明正确；其他剪枝（升序前缀 / 后缀总和 / top-k 后缀 / maxSize=8 / hardCeiling=5M）已足够防爆炸
  - 性能影响：实测 n=20 大池子 1.02ms / 次（删一个 if 比 round 2 的 1.18ms 略快；远优于 round 2 之前的 2.58ms）

- **改动清单**（4 文件）：
  - `src/main-process/scenario-engines/c4-recon-id-fix.js`：
    - 删除 `isBestAbsoluteOptimal()` 函数（10 行）
    - 删除 DFS for 循环里 `if (isBestAbsoluteOptimal()) return;` 早停判定（line 379）
    - 文件头部 round 4 注释加 round 3 P2 修复段落
    - `findBestAmountSubset` 注释从 "启发式提前终止" 改为 round 3 修复说明
  - `scripts/smoke/recon-id-fix-engine.js`：
    - 新增 2 smoke 用例：
      - `runPR36Round3P2EarlyStopFirstIdx` — user 原文复现 `[opp_10:1, opp_2:50, opp_3:50, opp_11:99]` target=100 修后选 `[opp_2, opp_3]`
      - `runPR36Round3P2PerformanceN20NoEarlyStop` — 性能基线：删早停后 n=20 < 100ms（实测 1ms 量级）
    - tests 注册新增 2 用例（41 → 43）
  - `docs/iterations/v2.1.0-beta.1/spec.md`：
    - §五.2.4.1 `findBestAmountSubset` 注释里删除"启发式提前终止"行，加 round 3 修复说明
    - §五.2.4.1 伪代码删除 `isBestAbsoluteOptimal()` 函数 + DFS 内调用
    - 性能边界提示更新为"round 3 修后 n=20 实测 1.02ms / 次"
  - `docs/iterations/v2.1.0-beta.1/log.md`：本节

- **测试证据**：
  - `npm run smoke` **268/268 PASS**（baseline 266 + 新增 2 P2 round 3 用例；recon-id-fix-engine 41 → 43）
  - **user 复现用例验证**（pre/post fix 行为对照）：
    ```
    candidates [opp_10:1, opp_2:50, opp_3:50, opp_11:99]，target=100，所有 BillDate=2026-04-15
    --- 修前（带 isBestAbsoluteOptimal 早停）---
      DFS 升序 cents: opp_10(1) → opp_11(99)，先找到 [opp_10, opp_11]
      best={size=2, spread=0, dist=0, firstIdxNum=10} → 触发早停 break
      最终: [opp_10, opp_11] (firstIdxNum=10，错)
    --- 修后（删早停）---
      DFS 全遍历: 找到 [opp_10, opp_11] / [opp_2, opp_3]
      tryUpdateBest: firstIdxNum=2 < 10 → 更新 best
      最终: [opp_2, opp_3] (firstIdxNum=2，对)
    ```
  - **回归 baseline**（修前修后行为一致，不退步）：
    - smoke 全部既有用例：266/266 PASS（含基金 io 用例 / FX 中台入金 + FTA202604280200028 用户用例 / Round 4 大池子 fixture / round 1+2 P2 单测）
    - 用户用例 **FTA202604280200028 ↔ 202604271439325696974017228**：smoke `runRound5Step2IdxTieBreak`（Step 2 idx tie-break 路径）继续 PASS — 该用例走 Step 2 不走 subset-sum，本修不影响其行为
  - **性能对比**（n=20 大池子 50 次平均）：
    ```
    round 3 修后（删早停）   1.02ms / 次
    round 2 修后（带早停剪枝） 1.18ms / 次
    round 2 之前（旧二段式） 2.58ms / 次
    ```
    说明：早停只在"先命中绝对最优 + 后面还有大量待搜索分支"时省时间；在 P2-6 fixture 中其他剪枝已让 DFS 不会真正去探到漫长分支，删早停后实际略快。
  - **n=30 stress 验证**：21ms（无退化风险）

- **风险显式提醒**：
  - **资金红线（subset-sum 全局最优）**：本次修复让池子算法**真正**返回全局最优；round 2 早停剪枝在"先命中前 3 阶并列解"时会漏掉 firstIdxNum 更优的解。修后行为：tie-break 4 阶完整生效。
  - **回归不变**：所有既有 smoke 用例（含 FTA / 基金 io / FX 中台入金 / Round 4 大池子 / Round 5 Step 2 / round 1+2 P2 单测）行为不变。删早停只影响"DFS 在前 3 阶并列时是否继续探索 firstIdxNum"的语义边界；fixture 中 firstIdxNum 一致的解会以稳定顺序被选中（最小者）。
  - **性能（防退化）**：实测 n=20 删早停后 1.02ms / 次 远优于 round 2 之前 2.58ms / 次；hardCeiling=5M visit 上限作极端数据兜底（不变）

- **follow-up（已知，非 blocker）**：
  - 已合并 round 2 → round 3 是续修；user 复现脚本可作为永久回归用例（已 smoke 化为 P2-7 / P2-8）
  - hardCeiling=5M 默认值不变（n=20/30 实测均 < 50ms）

- **下一步**：通知 team-lead "代码已完成自测"等待用户测试 → user 确认 → 由 team-lead 提 round 3 commit / push

---

## 2026-05-09 PR #36 self-review round 5 修复（3 个 P3 finding；用户提示）

- **背景**：team-lead 在 PR #36 round 4（注释同步）push 后做 self-review，发现 3 个 P3 finding——都偏 UX/防御性，不影响资金正确性，但需在 PR-B merge 前一并扫干净。

- **3 个 P3 finding**：
  1. **P3-A — fixedRows 空 + unmatched 非空时 saveDialog UX 困惑**：
     - 当前行为：用户点导出弹 saveDialog，默认主名 `单据对账修复-{ts}-{name}.xlsx`；如果 fixedRows 空 → 不写主文件（用户选的路径上没文件）；如果 unmatched 非空 → 在同目录写**另一个固定名** `单据对账修复-未匹配-{ts}-{name}.xlsx`
     - 用户视角："我选了 A.xlsx，怎么桌面上是另一个名字？"
     - 修法：弹 saveDialog 前先判断；fixedRows 空 + unmatched 非空时 saveDialog 默认名直接用 unmatched 名；用户选定路径直接作为 unmatched 文件路径（"用户选什么 = 实际写什么"语义对得上）
  2. **P3-B — unmatched 文件名联动用户改的主文件名**：
     - 当前行为：unmatched 总是 `buildReconIdFixUnmatchedReportFileName(scenarioName, timestamp)` 拼出固定名 `单据对账修复-未匹配-YYYYMMDDHHmm-{scenarioName}.xlsx`
     - 用户场景：在 saveDialog 把主名改成 `4月对账.xlsx` → unmatched 仍是 `单据对账修复-未匹配-...` → 配对感弱
     - 修法：fixedRows + unmatched 都非空时，unmatched 文件名 = `{用户主文件 stem}-未匹配.xlsx`（同目录），`myreport.xlsx` → `myreport-未匹配.xlsx`
  3. **P3-C — buildReconIdFixSnapshot 用 stableJsonStringify**：
     - 问题：`JSON.stringify(scenario.config || {})` 按 object 属性插入顺序输出，同语义 config 在 SQLite round-trip / repository 重写后 key 顺序可能变化 → snapshot 字符串不同 → run 时落的 `scenariosSnapshot` 与 export 时重算的不一致 → 误判 stale-snapshot 拒导出
     - 修法：加 `stableJsonStringify(obj)` helper（递归按 key 排序），buildReconIdFixSnapshot 改用它；保证同语义 config 在任何 round-trip 后产出同一字符串

- **改动清单（4 文件）**：
  - `src/main.js`：
    - 新增 `stableJsonStringify` helper（位于 `buildReconIdFixSnapshot` 之上）
    - `buildReconIdFixSnapshot` 改用 `stableJsonStringify(scenario.config || {})`
    - `recon-id-fix:export` handler：
      - saveDialog 默认名分支：fixedRows 空 + unmatched 非空 → `buildReconIdFixUnmatchedReportFileName(...)` 否则主名（P3-A）
      - 写文件分支：fixedRows 空 → 用户选定路径直接作为 unmatched 文件路径；fixedRows 非空 → 写主 + 若 unmatched 非空联动主名 `{stem}-未匹配.xlsx`（P3-B）
  - `src/main-process/recon-id-fix-io.js`：
    - `buildUnmatchedReportFileName(scenarioName, timestamp, mainFileBaseName=null)` 加可选第 3 参；传入时用 `{sanitize(stem)}-未匹配.xlsx`，stem = mainFileBaseName 去 .xlsx（不区分大小写）；旧 2 参签名向后兼容
  - `scripts/smoke/recon-id-fix-ipc-handlers.js`：
    - 新增 `stableJsonStringify` helper（与 main.js 同源），buildReconIdFixSnapshot 同步改造
    - simulateExport：3 参 saveDialogResult + 4 参 saveDialogDefaultProbe（让 T18 用例校验 saveDialog 默认名）；分支按 P3-A/P3-B 行为重写
    - 改造 T16（unmatched 文件名联动主名 `t16-out-未匹配.xlsx`）+ T17（用户选定路径就是 unmatched 文件）
    - 新增 T18（P3-A：默认名 = unmatched 名）+ T19（P3-B：联动改主名 `myreport.xlsx` → `myreport-未匹配.xlsx`）+ T20（P3-C：同语义不同 key 顺序 → 同 snapshot；真实改动 → 不同；数组顺序敏感）
    - tests 总数 17 → 20
  - `scripts/smoke/recon-id-fix-io.js`：
    - 新增 R13（5 子用例）：buildUnmatchedReportFileName 第 3 参联动模式 — 主名带/不带 .xlsx / 大小写 / sanitize 危险字符 / 旧 2 参兼容 / 第 3 参 null 等价于不传
    - tests 总数 12 → 13

- **测试证据**：
  - `npm run smoke` **272/272 PASS**（baseline 268 + 6 新增/改造：T18 + T19 + T20 + R13 + T16/T17 行为校准）
  - 全部 P3 finding 验证：
    - P3-A：T18 captures saveDialog 默认名以 `单据对账修复-未匹配-` 开头（含 scenarioName）；用户选定路径 `t18-user-pick.xlsx` 实际写到该路径，mainFilePath null
    - P3-B：T19 用户改主名 `myreport.xlsx` → unmatchedFileName 实际为 `myreport-未匹配.xlsx`，与主文件同目录
    - P3-C：T20 同语义但 key 顺序不同的两份 config（matchRules / billTypes / reconGroups / output 顶层倒序 + 嵌套倒序）→ snapshot 串完全相等；真实改 mode='main' → 'both' → 不等；billTypes 数组顺序变化 → 不等（数组语义敏感不被排序）
  - 资金红线 stale-snapshot 防御回归：T12（场景 config 真实改动 → stale 拒导出）/ T13（场景已删 → stale 拒导出）继续 PASS
  - 主算法回归不变（不退步）：
    - smoke 全部既有用例 PASS（含 FTA202604280200028 ↔ 202604271439325696974017228 用户用例 / 基金 fixture / FX 中台入金 fixture）
    - subset-sum tie-break 4 阶（spread → distToMain → size → firstIdxNum）完整（PR #36 round 1-3 修复保留）

- **风险显式提醒**：
  - **资金红线（snapshot 防御）**：P3-C 改造涉及核心防御机制——stale-snapshot 拒导出是防"用户改场景后导出还是旧规则"的关键。修后行为：snapshot 串不再被 key 顺序漂移误判（保护用户不被假阳性 stale 拒导出），但**真实场景 config 改动仍正常触发 stale**——T20 反例校验 + T12/T13 旧用例继续验证。
  - **资金红线（不破坏 PR-A + PR-B round 1-4 已修复逻辑）**：subset-sum 全局最优 + tie-break 4 阶 + Step 2 多候选 + scenarios 分流清缓存 + Type 规则 + commonId reconId 取值 — 全部保留语义；smoke 272/272 反向证明
  - **UX 改进（P3-A/P3-B）**：纯 UX 改进，不改变文件内容；用户在原行为下虽困惑但拿到的告警 report 数据正确

- **下一步**：通知 team-lead "代码已完成自测"等待用户测试 → user 确认 → 由 team-lead 提 round 5 commit

---

## 2026-05-09 PR-B Round 5 微调（Step 2 多候选 tie-break）+ 1 决策回写

- **背景**：用户测试 Round 4 时发现一个用例没命中
  - 主单 FTA202604280200028（BillDate=04-28, USD 300000, 入账）
  - 期望从单 202604271439325696974017228（BillDate=04-27, USD 300000, 入账）
  - 实际：FX 中台入金 fixture 中还有一个 04-29 干扰行（USD 300000 入账），构成"主 04-28 vs 从 04-27/04-29 两个候选"
  - Round 4 实现：Step 2（±1day 容错 1v1）要求"恰好 1 个候选"→ 候选 2 个直接跳过 → 退到 Step 3.x 池子（subset 必 size ≥ 2，单元素 {300k} 不命中）→ 主 + 两个从全 unmatched

- **决策**（1 项 — Q1=a）：Step 2 ±1day 多候选时按 tie-break 挑 1 个 1v1 命中（不退池子）
  - **tie-break 顺序**：
    1. `|主.BillDate - 从.BillDate|` 最小（距离最近）
    2. 并列时按从单 `_rowIdx` 字符串字典序最小（原数组顺序首个；`_rowIdx` 形如 `'opp_0'` / `'main_3'`）
  - **双向一致性校验**：选定 `bestRight` 后从 `bestRight` 反查 `leftRows`，按同样 tie-break 选回最优主单；不是当前 `leftRow` 则让位（避免主从抢配冲突）
  - **Step 1（billDateMode='strict'）保持现状**：候选数必须恰好 1 + reverse 也恰好 1 才命中（资金红线最严）
  - **Q2 保持不变**：池子 subset-sum 仍要求 size ≥ 2

- **改动清单**（5 文件）：
  - `src/main-process/scenario-engines/c4-recon-id-fix.js`：
    - 新增 `pickBestByTieBreak(referenceRow, candidates)` 工具函数（dist → _rowIdx 字典序兜底）
    - 重写 `tryOneToOne` 的 Step 2（`billDateMode === '±1day'`）分支：候选 ≥ 1 时走 tie-break + 双向一致性
    - Step 1（`billDateMode === 'strict'`）保持原行为不动
    - exports 新增 `pickBestByTieBreak`
  - `scripts/smoke/recon-id-fix-engine.js`：
    - 新增 6 个 Round 5 用例：runRound5PickBestHelpers / runRound5Step2DistTieBreak / runRound5Step2IdxTieBreak（用户用例核心）/ runRound5Step2ReverseConflict（让位避免抢配）/ runRound5Step1Unchanged / runRound5Step2SingleCandidateUnchanged
    - tests 注册新增 6 个用例，total 29 → 35
  - `docs/iterations/v2.1.0-beta.1/PRD-v2.1.0-beta.1.md`：
    - §七.3.6 Step 2 实现细节加 Round 5 微调（tryOneToOne 伪代码 + pickBestByTieBreak）
    - §十六 PR-B 实施记录追加 Round 5 决策 + 测试证据
  - `docs/iterations/v2.1.0-beta.1/spec.md`：
    - §一.2 PR-B 文件清单标题改 "Round 5 微调后约 14 文件"
    - §五.2.3 新增章节 "tryOneToOne 与 Step 2 多候选 tie-break"（Round 5 微调）
  - `docs/iterations/v2.1.0-beta.1/log.md`：本节

- **测试证据**：
  - smoke 260/260 PASS（baseline 254 + Round 5 新增 6 用例）
  - 用户用例验证（FX 中台入金 fixture，`/Users/pzhong/Desktop/小助手-Debug/2.1.0/FX中台入金-初始.xlsx`）：
    - 主 FTA202604280200028 命中 → 从 202604271439325696974017228（04-27 target，dist=1day, _rowIdx=opp_0 字典序最小）
    - 从 04-29 decoy 进 unmatched
    - 期望 Reference = `PP_20260428020000_USD_HK0000720752_001`（reconId+suffix），实测 PASS
    - FX fixture 全量：fixedRowCount=96 / mainTouched=36 / oppTouched=60 / unmatched=18 / warnings=0
  - 真实 fixture「基金」回归（`/Users/pzhong/Desktop/小助手-Debug/2.0.0/订单枚举表/单据对账导出不平.xlsx`）：fixedRowCount=80 / mainTouched=30 / oppTouched=50 / unmatched=0（与 Round 4 baseline 完全一致，无退步）
  - Round 4 vs Round 5 对照（用户用例核心 minimal smoke）：
    - Round 4 行为下：fixedRows=0（候选 2 个直接跳过）
    - Round 5 行为下：fixedRows=1（命中 04-27 target，opp_0 _rowIdx 字典序最小）

- **风险显式提醒**：
  - 资金红线（Step 2 多候选时挑选规则）：tie-break 排序 deterministic（dist → idx 字符串字典序），保证每次跑结果一致；smoke 用例 runRound5Step2DistTieBreak / runRound5Step2IdxTieBreak 验证唯一性
  - 资金红线（双向一致性校验）：避免主单 M1 选 S 时 S 实际反向更想配 M2 → M1 让位 + M2 后续命中；smoke 用例 runRound5Step2ReverseConflict 验证（M1 让位 + M3 抢配失败 + M2 命中 S）
  - 资金红线（不破坏 PR-A + PR-B Round 1+2+3+4 已修复逻辑）：Step 1 严格行为不变 / Step 2 单候选行为不变 / 池子 subset-sum size ≥ 2 不变 / RB 全部规则不变 / unmatched writer 不变 / commonId 不变 / resolveSubBizType / lookupReconId 不变；smoke 全 260/260 PASS 验证
  - 性能：pickBestByTieBreak 是 O(n log n)（sort），在 ±1day 候选数较小（典型 ≤ 10）时完全可控；不影响整体复杂度

- **下一步**：等用户用 GUI 实测验证 Round 5

- **已知 follow-up**：
  - Round 5 仅微调 Step 2 行为；Step 3.x 池子 subset-sum size ≥ 2 不变，未来如果用户场景出现"池子 ±1day 单候选 = 主 Amount"想命中 1v1（而不是仅 1v多），可考虑独立的 Q2 修订
  - 双向一致性校验只看反向 pickBest 是否一致；如果业务上要求"反向候选数必须恰好等于 1"或"反向候选不超过某阈值"，可加独立约束（当前不约束反向候选数量）

---

## 2026-05-09 PR-B Round 4 subset-sum 重构 + 4 决策回写

- **背景**：用户测试 Round 3 算法发现池子语义实现错位
  - Round 3 实现：池子内"逐行 Amount 全等"过滤（每个候选从单 Amount === 主单 Amount）
  - 用户原始需求："1v多 = 同 BillDate，**用一笔主单 Amount 和多笔从单 Amount 匹配**"——会计对账常见做法（多笔小金额拼出大金额）
  - 用户用例：主 04-15 USD 270000，从 [F1 04-13 70k, F2 04-14 200k, F3 04-14 70k, F4 04-15 70k]，期望 {F2, F3} sum=270k 命中（Round 3 实现下 0 命中）

- **决策**（4 项）：
  1. **Decision 1 — 1v多 池子改 subset-sum + 其他对账字段 AND 全等过滤候选**：
     - 候选 = 池子里满足"BillDate（按 mode）+ 除 Amount 外其他对账字段 AND 全等"的从单
     - subset-sum(候选.Amount) === 主.Amount 找子集（size ≥ 2）
     - 找不到 → 进 unmatched（不再退一步）
  2. **Decision 2 — 多解 tie-break 4 阶**：
     - 解内日期跨度最小（max(子集 BillDate) - min(子集 BillDate)）
     - spread 并列时离主单 BillDate 最近（min(|主-从|)）
     - 仍并列时子集元素数最少
     - 仍并列时 firstIdx 字典序兜底（_rowIdx）
  3. **Decision 3 — 多v1 池子对称重构**：subset-sum(候选主.Amount) === 从.Amount + 同 tieBreak
  4. **Decision 4 — Step 3.2 找不到子集 → 直接进 unmatched**，不再退一步

- **改动清单**（5 文件）：
  - `src/main-process/scenario-engines/c4-recon-id-fix.js`：
    - 重写 `tryOneToManyPool` / `tryManyToOnePool`：候选过滤改"BillDate + 除 Amount 外其他对账字段 AND 全等"，Amount 走 subset-sum + tieBreak
    - 新增 `toCents(amount)` — 浮点 ×100 整数化避精度坑（特殊处理空串/null/非法值）
    - 新增 `rowsMatchOtherFieldPairs(left, right, otherFieldPairs)` — 池子候选过滤
    - 新增 `enumerateAmountSubsets(candidates, targetCents, maxSize=8, maxSolutions=64)` — DFS + 升序剪枝枚举所有解
    - 新增 `tieBreakSubsets(subsets, mainBillDate)` — 多解时按 spread → distToMain → size → firstIdx 字典序排序取首
    - 主入口 `runC4Scenario` 把 4 个池子调用改传 `grp.fieldPairs`（替换原 `amountPair`），由池子函数内部拆分 amountPair / otherFieldPairs
    - exports 新增 4 个 round 4 工具函数（toCents / enumerateAmountSubsets / tieBreakSubsets / rowsMatchOtherFieldPairs）
  - `scripts/smoke/recon-id-fix-engine.js`：
    - 重写 round 3 6 个池子用例（Step 3.1 / 3.2 / 3'.1 / RB2 / RB4 / runAmountLockedPoolUsage）为 subset-sum 语义
    - 新增 7 个 round 4 用例：runRound4SubsetSumHelpers / runRound4UserCase（用户原始用例 270k=200k+70k）/ runRound4NoSubsetFound / runRound4FloatPrecision / runRound4LargePoolPerformance / runRound4TieBreakMultiSolution / runRound4ManyToOneSymmetric
    - tests 注册新增 7 个用例，total 22 → 29
  - `docs/iterations/v2.1.0-beta.1/PRD-v2.1.0-beta.1.md`：
    - §三 D2 修订算法语义（subset-sum + 多解 tieBreak）
    - §六 D6 RB 表（RB2 / RB4 注明"subset-sum 主子集 / 从子集"）
    - §七.3.1 算法主流程（Round 4 修订）
    - §七.3.6 算法详细伪代码（subset-sum + tieBreak 全部）
    - §十二 P0 测试清单 — P0-5d Round 4 重新校准期望值（fixedRowCount=80 / unmatchedRowCount=0）+ 新增 P0-5f / P0-5g（subset-sum 命中 / tieBreak 多解）
    - §十六 PR-B 实施记录 — Round 4 4 决策 + smoke 254/254
  - `docs/iterations/v2.1.0-beta.1/spec.md`：
    - §一 1.2 PR-B 文件清单（Round 4 标记）
    - §五.2 引擎主入口（subset-sum 语义说明）
    - §五.2.4 池子算法实现细节（伪代码全部 round 4）
    - §五.2.4.1（新增）subset-sum 工具函数（toCents / rowsMatchOtherFieldPairs / enumerateAmountSubsets / tieBreakSubsets）
    - §九.2 PR-B smoke 范围（Round 4 update）
  - `docs/iterations/v2.1.0-beta.1/tasks.md`：
    - task B4 / B5 改 Round 4 重写标记
  - `docs/iterations/v2.1.0-beta.1/log.md`：本节

- **测试证据**：`npm run smoke` 254/254 PASS（baseline 247 + Round 4 新增 7 用例）；用户用例验证：270k = {F2, F3} 命中（spread=0d 优于 spread=1d 的 {F2,F1}/{F2,F4}）；F1 04-13 超 ±1day 进 unmatched；F4 因 tieBreak 落选

- **真实 fixture「基金」场景模拟跑（vs Round 3 baseline）**：
  - 配置：mode='both' / billTypes 主从都 reconId 含 'PP' / reconGroups Currency / Amount(locked) / BizType / matchRules 1v1+1v多
  - Round 3 基准期望（PRD §P0-5d）：fixedRowCount=28 / mainTouched=14 / oppTouched=14 / unmatchedRowCount=52
  - Round 4 实测：fixedRowCount=80 / mainTouched=30 / oppTouched=50 / unmatchedRowCount=0 / warnings=0
  - 解读：Round 3 因"逐行 Amount 全等"漏掉了 1v多 拆分场景；Round 4 subset-sum 修复后所有 PP 主从都成功对账（用户期望的"完美对账"）。注意：fixture 中部分主行因 BizType=出账/入账 区分有 OrderId 重复行（同一交易两面），算法独立处理是预期行为

- **风险显式提醒**：
  - 资金红线（subset-sum 多解唯一性）：tieBreak 4 阶排序确保每次跑 deterministic；smoke 用例验证唯一性
  - 资金红线（浮点精度）：toCents ×100 整数化避免 0.1+0.2!=0.3 经典坑
  - 性能边界：DFS + 升序剪枝 + maxSize=8 + maxSolutions=64 三道防线，业务场景候选 ≤ 数百时可控；smoke 大候选集（n=20）用例验证 < 1s
  - 资金红线（不破坏 PR-A 已合并 + Round 1+2+3 已修复）：5 模块切换 / scenarios CRUD / 类别四选一 / migration / scenarios 分流清缓存 / Q1 reconGroups / Q2 commonId reconId / Round 3 5 阶段算法 / Amount 锁定 / unmatched.xlsx writer / Type 修订（mode=both+1v多 全 Type=0 / mode=both+多v1 主 Type=2 从 Type=0）— 全部 smoke 保留 PASS

- **下一步**：等用户用 GUI 实测验证

- **已知 follow-up**：
  - subset-sum 性能边界：maxSolutions=64 上限是否足够（用户极端场景再调）
  - tieBreak 第 4 阶 firstIdx 走到的概率极低，作为兜底保证唯一性，未生产观察

---

## 2026-05-09 PR-B Round 3 算法重构 + 5 决策回写

- **背景**：用户测试 round 3 重新审视原始需求，发现 c4 引擎算法和 Type 规则有偏差。需重构算法 + 改 Type 规则 + 加告警 report + UI Amount 锁定。

- **决策**（5 项）：
  1. **Decision 1 — Type 规则修订（mode='both' RB4 修订）**：1v多 主从都 Type=`0`（原 主 0/从 2 → 改为 主 0/从 0）；多v1（RB2）保持原（主 2/从 0）；1v1（RB1）保持原（双 0）。**mode='main' / 'opp' R1-R7 不变**。
  2. **Decision 2 — 5 阶段算法重构**：
     - Step 1：同 BillDate 严格 + 全部 fieldPairs AND 全等 1v1
     - Step 2：BillDate ±1day 容错（D-1/D/D+1 任一相等）+ 其他对账字段 AND 全等 1v1
     - Step 3.1：池子 1v多 — 同 BillDate + Amount 单一字段对
     - Step 3.2：池子 1v多 — BillDate ±1day + Amount
     - Step 3'.1 / Step 3'.2：勾了 manyToOne 时，对剩余池子做同 BillDate / ±1day + Amount 多v1
     - 跨 group 共享 pairedLeft/pairedRight 集合，避免双重命中
  3. **Decision 3 — 单独 unmatched.xlsx 告警 report**：6 列（场景名/单据来源/OrderId/BillDate/Amount/未配原因）+ 文件名 `单据对账修复-未匹配-YYYYMMDDHHmm-{scenarioName}.xlsx` + sheet 名"未匹配单据"+ 与主修复文件一并由 export IPC 返回（mainFilePath + unmatchedFilePath 双文件）+ 表头字号 10pt
  4. **Decision 4 — UI Amount 字段对锁定**：新增 reconGroup 默认带 Amount 字段对作为第一行（leftField='Amount', rightField='Amount', locked: true）；锁定行 select disabled + 删除按钮隐藏；migration 兼容老数据（自动补 locked / 自动插入 Amount 锁定行）
  5. **Decision 5 — 其他细节**：
     - BillDate 字段名（主从 sheet 都叫 `BillDate`）
     - 池子内做两阶段（同 BillDate 先 → ±1day 后），与 Step 1+2 一致
     - Step 2 容错配对仍然要求其他对账字段 AND 全等（仅 BillDate 这一字段放宽）

- **改动清单**（待实施）：
  - **PRD-v2.1.0-beta.1.md**：§三 D2 / D4 / D6 / §七.3.1 / 7.3.5 / 7.3.6 / §八.4 / §九 IPC / §十.1.1 / §十六 PR-B 实施记录
  - **spec.md**：§一 1.2 / §三 IPC / §五.2 / 5.2.4 / 5.2.5 / 5.2.6 / §五.4 / §九.2 / §十二
  - **tasks.md**：B4/B5/B12 加 Round 3 标记；新增 B14（unmatched writer）/ B15（Amount 锁定 + migration）/ B16（statusBox unmatched 档）
  - **log.md**：本节
  - **代码**：c4-recon-id-fix.js 算法重写 / recon-id-fix-io.js 加 writeUnmatchedReport / main.js export 双文件 / renderer-dialogs.js Amount 锁定 + 默认带 / migrations.js 新 H 系列 + 调用链路 / smoke 全部用例重写

- **风险显式提醒**：
  - 资金红线（Type 规则改 + 算法改 + commonId 已是 reconId）：smoke 必覆盖 RB4 Type=0 + 5 阶段命中 + unmatched dump
  - 资金红线（stale-snapshot）：算法变了，PR-B Round 1 已有的"先 run 后改场景再 export 拒绝"smoke 必须保留
  - 数据库迁移（CLAUDE.md §7 红线）：新 migration `migrateC4ReconGroupsAmountLockedFieldPair` 必须幂等三连
  - 资金红线（不破坏 PR-A 已合并）：5 模块切换 / 类别四选一 / scenarios 分流清缓存 / C4 dialog 5 行布局 / migration 链路全部保留语义
  - 兼容性（C2/C3 reconFields[] 不变）：H 系列 migration 仅扫 category='recon-id-fix'

- **测试证据**：（待实施完成后补）
  - baseline smoke 232/232（v2.0.0 GA + PR-A + Round 1+2）
  - Round 3 重写后 smoke 总数 / 通过率 / 新增用例数（待补）
  - "基金"真实 fixture 模拟跑：fixedRowCount / unmatchedRowCount 与期望对比（待补）

- **下一步**：开始改代码 → smoke 全过 → 用真实 fixture 验证 → 通知 team-lead 用户测试

---

## 可沉淀知识（持续追加）

### v2.0.0-beta.3 → v2.1.0-beta.1 的"模块同构 + 场景独立"模式

- v2.0.0-beta.3 已在 `scenarios` 表上跑通 3 类（C1/C2/C3）；本迭代加第 4 类（C4）走的是同一张表
- 这种"category 枚举扩 + 单独 dialog factory + 单独引擎 + 单独 IO/writer"的模式可复用到未来更多对账类需求
- 关键约束：CHECK 约束变更必须 RENAME-CREATE-INSERT-DROP-COMMIT 重建表；v2.0.0-beta.3 marker 机制对老库迁移友好（不重 seed）但本迭代 marker 不动
- 如果未来还要扩 C5/C6...，建议：
  - migration 函数命名清晰反映扩到第几类（如 `ensureScenariosCategoryReconIdFix` → `ensureScenariosCategoryV5Foo`）
  - 每加一类 CHECK 都要重建一次表（SQLite 限制）
  - 老库测试：建议 keep 一份"v2.0.0 老库 fixture"在 `samples/` 里，每次扩展都要走一遍

### Defense in depth 双层防御沿用

- v2.0.0-beta.3 PR #33 round 2 + round 3 引入的"IPC 入口主动清 + export 端被动校验 snapshot"模式被本迭代直接复用
- 关键不变：**任何场景配置变更都必须让 stale result 失效**，否则会导致用户改场景后导出还是旧规则的输出（资金红线）
- 实践要求：每个新模块加 IPC 时，**4 个 scenarios:* handler 都要追加新模块的 result 清缓存** + **新 export handler 都要重读 scenario 比对 snapshot**

### 输出 writer 选型

- v2.0.0-beta.3 引入 exceljs 仅为标黄需求；其他 3 模块继续 SheetJS / xlsx-js-style
- 本模块输出无标黄需求 → 用 xlsx-js-style（与 pending-session 一致）
- 教训：**不要为了"统一"强行复用** exceljs-writer.js；它的 API 是为标黄场景设计的，复用反而绕弯
- 选型原则：是否需要 cell 样式（标黄/字体/背景）→ exceljs；普通表格 → xlsx-js-style

### 识读规律的工程化

- "纯规则推断" + "不落库 + 用户必须确认"= 双保险
- 颜色分组（同色同例）依赖用户文件本身已有的视觉标记，工程上易实现（ExcelJS cell.fill）
- fields-equal mining 的全等率阈值默认 0.8，可调（PR-C 实施时如果 fixture 命中率不到 0.8 再下调）

---

## 2026-05-09 PR-C 识读规律功能取消

**触发**：dev round 1 完成自测（278/278 PASS）→ 用户测试发现 alert 关闭后跳主页面（已修）→ 用户决定整体取消该功能。

**回退动作**：
- 工作目录 PR-C 改动全部回退（4 modified 恢复 + 2 untracked 删除）
- C4 dialog 删除「识读场景规律」按钮 + tooltip 常量（PR-A 占位代码也清理）
- PRD §十一 4 PR → 3 PR（A/B/D），PR-C 划线
- PRD §十六 PR-C 段标"已取消"+ 取消原因
- tasks.md PR-C 章节标 CANCELLED

**保留事项**：
- `samples/单据对账导出不平-对平例子.xlsx` fixture 暂留（PR-D 决定是否清理）
- exceljs 依赖保留（unmatched.xlsx writer + banker 模块仍依赖）

**经验教训**：
- 教训：未来类似"自动化辅助"功能要在 PRD 阶段先做 demo，不要等代码落地才发现用户不需要

**smoke 现状**：272/272 PASS（baseline 保持，PR-C 6 用例已删，回到 PR-B 合并后状态）

---

## 2026-05-11 PR-D 用户手测通过 + 真实 fixture 回归脚本入仓 + PR #37 提交

- **触发**：用户对话「看下现在这个项目上个版本迭代做完了吗」→「列测试单」→「哪些是你可以自己写测试用例自己测的？」→「需要」→「顺便也跑 FX 中台入金 fixture」→ P1 系列 + P0-9 stale-snapshot 提示文案手测全过 →「全部测试通过，提 PR」

- **新增**：`scripts/test-v2.1.0-fund-fixture.js`（3 case 自动化 P0-5d）
  - **Case A — 基金 PP-only legacy**（PRD §12 P0-5d 原始 baseline 复现，"subset-sum 命中所有 PP 主从"）：80/30/50/0/0 PASS
  - **Case B — 基金 PP+PR 当前用户 SQLite scenario id=5**（实际配置回归）：92/36/56/0/0 PASS
  - **Case C — FX 中台入金 PP-only suffix=`_001`**（log.md 467 行反推 Round 5 baseline）：96/36/60/18/0 PASS
  - 设计要点：fixture 缺失时跳过该 case 但不算 FAIL（避免外部 fixture 路径变动卡死脚本）；scenario config 硬编码在脚本里（不依赖用户 SQLite，CI 可跑）

- **PRD §12 P0-5d baseline 漂移发现**：
  - PRD 写 80/30/50/0 是 round 4 时 scenario 仅 PP 一组（PRD 1045 行明确"命中所有 PP 主从"）
  - 用户 SQLite `scenarios.id=5` `updated_at=2026-05-09T06:37` 后已加 PR 组（4 billTypes + 2 reconGroups）→ 实际跑 92/36/56/0/0
  - fixture mtime `2026-04-19` 早于 PRD baseline 写定日，fixture 未动；漂移仅来自用户 GUI 改 scenario
  - 决策：fixture 脚本同时跑两套（算法核心 + 当前配置），保留可追溯性；PRD §16 PR-D 段补漂移说明，§12 P0-5d 表格保留原值不动（作为 round 4 算法回归 baseline）

- **手测覆盖**：
  - 用户跑 P1-1 ~ P1-9（CRUD / 类别 dropdown / 老库迁移 / 重启 / 文件错误 / UI 互斥 / 保存校验）全过
  - 用户跑 P0-9 stale-snapshot 文案 2 case 全过：
    - 改 scenario.config → 弹窗 `导出失败：场景已变更，请重新点击"开始运行"再导出`（`src/main.js:2955+:3172`）
    - 删 scenario → 弹窗 `导出失败：场景已删除，请重新选择场景再运行`（`src/main.js:3164`）

- **风险显式提醒**（提 PR 前最后一道）：
  - 资金红线（版本号 bump + 三件套 → main）：本 PR 是 release 链路对外契约，merge 到 main 后所有用户启动看到 `v2.1.0-beta.1`；CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 中 4 → 5 模块描述必须与 PR-A/B 实际行为对齐
  - 资金红线（无 src/ 改动，但 fixture 脚本读取真实 IO 链路）：fixture 脚本调用 `readReconIdFixFile` + `runReconIdFix` 真实代码，3 case 全过反向证明 IO + 引擎在用户测试环境下行为稳定
  - 资金红线（合并后 v2.1.0 → main 同步）：merge 后按 memory `workflow_multi_version` cherry-pick 不适用（v2.1.0 是迭代分支，main ← v2.1.0 是正向合并）；v3.0.0 分支需后续 merge main 同步

- **测试证据**：
  - `npm run smoke` 272/272 PASS（2 次复测一致）
  - `node scripts/test-v2.1.0-fund-fixture.js` 3/3 PASS（基金 PP-only + 基金 PP+PR + FX 入账）
  - `npm run check:vars` SKIPPED（无 src/ 改动）
  - 用户手测 P1-1 ~ P1-9 + P0-9 全 PASS

- **下一步**：等用户合并 PR #37 → main → 按 memory `workflow_archive_pr_draft` 归档 `docs/prs/PR37-v2.1.0-beta.1.md`（integrated=true + merge commit hash）→ 按 memory `workflow_pr_integrate_prd` 把改动清单追加到 PRD §16 PR-D

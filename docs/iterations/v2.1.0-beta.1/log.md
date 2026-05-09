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

## 待补：PR-D 启动 + 发版

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

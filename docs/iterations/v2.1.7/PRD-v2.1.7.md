# PRD — v2.1.7 迭代：场景引擎完善 + 大账号 UI 修复 + 收单币种校验进度提示 + SQL 调优 + 系统通知 + 银行对账单结果未处理 sheet

| 字段 | 值 |
|---|---|
| 文档版本 | v0.11（2026-05-22 — T14 收口 + round 6 B4 真根因 + round 7-11 PR review 反馈循环；50 commit（最终 PR #51 merge 进 main），PR #51 OPEN；详 §22 v0.11 entry + §23 实施记录）；v0.10（2026-05-21 — round 5 用户测试 round 4 后反馈 2 项未通过 + 1 项 B1 微调：B1 round 4 字号 / Layout 正确，但用户要求去掉"（同时满足）/（满足任一）"文本，提示移到 tooltip / B4 round 4 加 `.big-account-split-left/right min-height: 0` 仍不能滚动 — PM 二次 grep 锁定**第 3 层 flex 嵌套坑**：`.big-account-file-list/order-list` 缺 `min-height: 0` / B2 跟随 B4 修好后才能验证）；v0.9 = round 4；v0.1-0.8 略 |
| 目标版本 | `v2.1.7`（patch） |
| 起始版本 | `v2.1.6`（main 含 v2.1.6 + 3 个 fix） |
| 起草日期 | 2026-05-20 |
| 起草人 | PM |
| 状态 | 定稿（v0.11）— round 6 B4 真根因 + T14 收口 + round 7-11 PR review 反馈循环全闭环；PR #51 OPEN |
| 关联文档 | `spec.md` v0.8 / `tasks.md` v0.7 |
| 涉及模块 | 银行对账单处理（C1/C2/C3）+ 网银账单生成（大账号 UI）+ 收单单据币种校验（状态框进度 + SQL 调优 + 系统通知）+ **全局数据库（F7-A1 PRAGMA 影响 3 套业务引擎：bank-bu-recon / biz-op-recon / acquiring-bill-currency）**。**F5 涉及的 C4 gateway 子模式延期 v2.1.8** |
| 工作分支 | `v2.1.7`（基于 `main`，PR 向 `v2.1.7 → main`） |
| 依赖 | v2.1.6（含 C1/C2/C3 完整骨架 + 大账号 multi-mode UI 完整骨架 + 收单单据币种校验模块 session.onProgress 链路已就绪 + `(month_key, recon_main_id)` 复合索引已建） |
| package.json.version | 暂保持 `2.1.6`，发布前由用户决策是否 bump 到 `2.1.7` |

---

## 一、需求概述

v2.1.7 包含 **6 项独立改动**（F1/F2/F3/F4/F6/F7），覆盖四个模块；**F5 延期 v2.1.8** 由专门 spec 评审：

1. **F1 — C1「提取ReconId-From Self」条件 AND/OR 开关**：当前 conditions 数组隐含 OR 语义（`c1-extract-recon-id.js:41 conditions.some()`），UI tooltip "满足任一条件即可进入提取" 也写死 OR。本次在条件行下方加 AND/OR 切换，让用户控制多条件聚合语义。
2. **F2 — C3「提取ReconId-From 网关」多笔等额改 1v1 ⚠️ 资金红线**：当前 `c3-gateway-recon-join.js:123-145` 用 `bankRows.forEach + matched[0]`，多笔等额银行行会**重复赋同一条网关 gwRow**。改为方案 A —— 在 bank 主循环里加 `usedGwRowIdx` Set 标记已用网关行，保持 first-match-wins 风格 + 网关单向消费。
3. **F3 — 大账号确认页"单个账号匹多个文件"勾选后文件名只剩"PP..."**（用户截图佐证）：根因 = `.big-account-file-item` 是 flex 容器但**子项 `.big-account-file-meta` / `.ba-file-name` 缺 `min-width:0`**（flex item 默认 min-width = content size，导致后缀 `→ ${merchantId} ${currency}` 把文件名挤到几乎没空间）+ CSS `text-overflow:ellipsis` 触发 → 最终视觉只剩 "PP..."。
4. **F4 — 「账单打标」改名 + 默认值放宽**：C2 类别展示名"账单打标" → "银行对账单字段赋值"；"打标值" 子 row → "赋值"；新增场景时 billTypes / reconFields **默认空**；**保存校验放宽到 billTypes ≥ 1 + reconFields 允许 0 行**。**DB category 值 `'offset-bill-mark'` 保持**。引擎 `c2-offset-bill-mark.js:60-71` 硬卡 `billTypes.length < 2` 同步放开（衍生约束详 §9.5）。
5. **F5 — ⏸ 延期 v2.1.8**：详 §十 延期说明。简述：本迭代仅做"BillDate 字符串化"单点 fix 不足以达到用户期望（用户提供 TEST2.xlsx 期望基线 = 57 行 / 10 渠道命中；F5 单点 fix 实测 28 行 / 9 渠道命中）。差距根因 = `maxSize=8` 硬上限 + manyToOne 遍历顺序 = 算法重设级别 = 资金红线大改需 ≥ 1 周专门评审。
6. **F6 — 收单单据币种校验模块状态框进度显示**：当前导入 / 运行阶段状态框只显示静态文本，500w 行级数据 8-15 分钟全程无反馈，用户无法判断"卡死/正常"。**复用现有 session.onProgress 链路**（已在 `acquiring-bill-currency-session.js:41-76` 完整实现，但 main.js handler 没接入），借鉴 `pending:import:progress` 范式补 IPC 进度事件通道 + renderer 状态框文本刷新。
7. **F7 — 收单单据币种校验 SQL 调优 + 完成系统通知（v2.1.7 内最小缓解，不动架构）**：F6 加 `await setImmediate` 后 stage 1-4 文案能依次到达，但 stage 4 `insertDiffRowsByJoin` 仍是大同步 SQL JOIN，i5-1135G7 + SATA SSD 真实数据下 macOS 仍会显示"应用无响应"。F7 拆 3 个子任务：① **A1 PRAGMA 全局应用**（database 启动钩子，WAL + NORMAL + 64MB cache + 256MB mmap，所有 3 套业务引擎受益）；② **A2 索引兜底**（PM 已验证 JOIN ON 复合索引 v2.1.6 已建，本次主要加 `source_file` 索引服务 writer 阶段 + ANALYZE 刷新统计）；③ **B1 Electron 原生 Notification**（runCheck return success/error 时弹通知）。
8. **round 2 — 用户手测反馈修复（R1-R5 + R6a/R6b/R6c）**：详 §十三。R1 F4 删按钮门槛 / R2 F6 fileCount 显式 / R3 状态框「：」换行（全局规则） / R4 F6 切模块再回按钮误启 / R5 F1 默认 AND（+ 资金红线护栏老 scenario fallback OR） / **R6a F3 multi 模式文件名根因细化（`.ba-file-row` grid 2 列硬编码 vs 子项 3 个）** / **R6b 大账号 dialog 列表滚动条丢失** / **R6c "确认大账号顺序" dialog 滚动恢复**。
9. **round 3 — 用户手测反馈修复（B1-B5 + F4 删空）**：详 §十四。B1 F1 radio 移回"条件"row 内部（用户再次反馈）/ B2 multi 完成态字母列丢失（R6a 副作用）/ B3 extract-order-card 左右对齐 + 共用滚动条 / B4 ≥20 文件场景滚动条不可用 / **B5 R3 wiring 漏接 🚨**（用户发现 setAcquiringBillCurrencyStatus 漏接；**PM grep 再发现 2 处漏接：updateBankStatementUi + updateReconIdFixUi**）/ F4 删空（R1 只改 display 没改 handler，需同步两处）。
10. **F8 — 银行对账单处理结果文件第 2 个 sheet 放未命中场景规则的行 🚨 资金红线**：详 §十五。**用户 round 3 拍板**"未处理" = **跑完 C1/C2/C3 dispatcher first-match-wins 后没有任何 scenario 命中的行**（不是 v2.1.x 的 `skippedRows`）。PM grep 验证：`scenario-dispatcher.js:122-123` 已有 `rowLockSet` 命中集合，F8 改造 = 一行 filter 反向得 unmatchedRows + writer 追加第 2 sheet；资金红线护栏 `modifiedRows` 集合完全不动。
11. **round 4 — 用户手测 round 3 反馈 3 项未通过**：详 §十六。**B1 用户拍板 Layout-1**（左列纵向"条件 label + AND radio + OR radio"，与右列 conditions 列表并排；radio label 字体 13px 与"筛选字段"对齐）；**B2 multi 完成态字母没显示**（PM 双路径 sketch：路径 A 修 letterSpan 渲染 / 路径 B 改 grid `minmax(24px,auto)`，dev 实测后选；**被 B4 阻塞手测**）；**B4 ≥20 文件场景滚动条没出现 — PM 真根因已锁定**：`.big-account-split-left/right` 是 `.ba-scroll-container` 的 grid 子项缺 `min-height: 0` → grid item 默认 `min-height: auto = content size` 穿透父 `max-height: 52vh` → file-list `overflow-y: auto` 永不触发；1 行 CSS 修复 + dev round 3 scrollbar 强制可见 CSS 保留。
12. **round 5 — 用户手测 round 4 反馈 B1 微调 + B4 仍不能滚动**：详 §十七。**B1 round 5 微调**（用户拍板：去掉 radio 文本"（同时满足）/（满足任一）"，提示合到"条件" label tooltip；PM 推荐**方案 B 单 tooltip 整合**到 6358 行现有"条件" ⓘ tooltip 文案，radio 仅保留"AND"/"OR"纯文字）；**B4 round 5 真根因第 2 层 🚨**：dev round 4 修对了第 2 层（grid item `.big-account-split-left/right` 加 `min-height: 0`），**但漏了第 3 层 flex item** `.big-account-file-list/order-list`（PM grep 验证它们是 split-left/right 的 flex column 子项，自身默认 `min-height: auto` 仍把父撑爆 → max-height: 52vh 仍被穿透）；round 5 一次性修齐**第 1 层 split-body 防御性兜底 + 第 3 层 file-list/order-list 主修**（共 2 行 CSS 双写）；**B2 跟随 B4**：round 4 路径 A 已修源码逻辑（pendingGroup 边界判断）；B4 修好后用户实测字母显示 → 路径 A 成功 / 仍不显示 → round 6 走路径 B（grid `minmax(24px, auto)`）。

6 项交付改动 + round 2 8 项小修 + round 3 6 项小修 + F8 新需求 + round 4 3 项小修 + round 5 2 项小修**完全独立**，无相互依赖，可并行落地。Dev 实施优先级：**B5（R3 漏接） + B1 + F4 删空 + round 4 B1/B2/B4 + round 5 B1/B4（用户体感最直接）** > B3 → F8（主功能写盘最后做）。

---

## 二、版本目标

### 2.1 必做

- F1 — 给 C1 dialog 加 AND/OR 切换；引擎 `rowMatchesAnyCondition` 按 `conditionsLogic` 走 every/some
- F2 — C3 引擎改 1v1（方案 A：bank 主循环加 `usedGwRowIdx` Set）
- F3 — 大账号 multi-mode 勾选后文件名完整显示（CSS flex 子项 `min-width:0`）
- F4 — C2 类别展示名 / dialog label / 错误文案 / 文档全量替换 + 默认值清空 + 校验放宽 + 引擎硬卡同步放宽
- F6 — 收单单据币种校验模块：接通现有 session.onProgress 链路 + 补 IPC 进度事件 + 状态框文本按阶段刷新
- F7-A1 — 全局 PRAGMA（journal_mode=WAL / synchronous=NORMAL / cache_size=-65536 / mmap_size=268435456）紧贴 database.js:42 现有 foreign_keys 之后
- F7-A2 — 索引兜底：加 `source_file` 索引（writer 阶段高频）+ 启动 ANALYZE 刷新统计；现有 JOIN ON 复合索引保留不动
- F7-B1 — Electron 原生 Notification：runCheck return success/error 时弹通知（main 进程，不新增 IPC）
- **round 2 R1** — F4 dialog billTypes 删按钮门槛 `<= 2 → === 1`
- **round 2 R2** — F6 session.js wrapper inserting payload 显式注入 `fileCount: filePaths.length`
- **round 2 R3** — `updateStatusBox` 入口 `.replace(/：/g, '：\n')` + `.status-box-text { white-space: pre-wrap }` + 顺手清 bizOpRecon hack
- **round 2 R4** — acquiring 模块加 inflightOperation flag + restorePanelState 按 flag 决定按钮 disabled
- **round 2 R5** — `createDefaultScenarioConfig('extract-recon-id')` 默认 `conditionsLogic: 'AND'` + dialog 移到独立 row 纵向 + AND 在上 + **资金红线护栏 pickConditionsLogicChecked(draft) 按 mode 分支老 scenario fallback OR**
- **round 2 R6a** — F3 multi 模式 `.ba-file-row { grid-template-columns: 28px 1fr → ?? }` 适配 3 子项（PM 推荐方案 C+B 组合：弹窗加宽 + JS 截断阈值 20→14 防御性下调；详 §13.7）
- **round 2 R6b** — 大账号 multi-mode dialog 列表滚动恢复：`.big-account-file-list / .big-account-order-list` 已有 `flex:1; overflow-y:auto`；PM 实测发现高度链已通（styles-gemini-extra.css `.ba-scroll-container max-height: 52vh`），**真实根因为 list 单行高度过高**（详 §13.8）
- **round 2 R6c** — `.extract-order-card` 子列表 `.extract-order-list` 缺 `max-height + overflow-y: auto`（modal-card 本身有兜底但内列表不能滚），加 2 行 CSS（详 §13.9）
- **round 3 B1** — F1 radio 移回"条件"row 内部 `.scenario-config-multi-wrap` 末尾（与"+ 新增条件"按钮同 wrap，移除独立"条件聚合"row + label）；资金红线护栏 pickConditionsLogicChecked / 引擎 fallback OR 不动
- **round 3 B2** — multi 完成态字母列丢失（R6a grid auto auto 1fr 副作用，PM 待 dev 实测决定方案 A min-width:24px / 方案 B grid 扩 4 列 / 方案 C letter padding）
- **round 3 B3** — extract-order-card 左右对齐 + 共用滚动条（方案 A 改单 grid 父容器一行横跨左右 + 外层单 overflow；方案 B 保留两栏 + sync-scroll JS；PM 推荐 A）
- **round 3 B4** — ≥20 文件场景滚动条不可用（PM 待 dev 用新增 ≥20 文件 preview fixture 验证真实表现 + 调试；可能涉及 `.ba-scroll-container max-height: 52vh` 在某 modal 高度下失效）
- **round 3 B5 🚨** — R3 wiring 漏接：① setAcquiringBillCurrencyStatus（用户发现）② **updateBankStatementUi**（PM 发现 L3330 直写）③ **updateReconIdFixUi**（PM 发现 L3684 直写）；三处全部改走 updateStatusBox + 加 render-status-box smoke wiring 审计断言
- **round 3 F4 删空** — R1 只改 L6716 显示按钮门槛，L6794 删除 handler **仍卡 `length > 2`**；PM 同步修两处：display `=== 1` → `< 0`（永远显示）+ handler `> 2` → `>= 1`（允许删空），保存校验 `< 1` 兜底
- **F8** — 银行对账单结果文件第 2 个 sheet 放**未命中场景规则的行** 🚨 资金红线：用户 round 3 拍板定义 = dispatcher first-match-wins 后无任何 scenario 命中的行；PM grep 验证 `scenario-dispatcher.js:122-123` 已有 `rowLockSet`，F8 改造 = dispatcher 反向 filter + writeWorkbookRows 加可选 unmatchedRows 入参；**资金红线护栏 modifiedRows filter 条件不动**；smoke 强制"matchedRows count == v2.1.6 baseline"
- **round 4 B1** — F1 radio 位置最终方案 Layout-1（用户拍板）：左列纵向"条件 label + AND radio + OR radio"，右列 conditions 列表；新增 `.scenario-config-label-stack` 容器；radio label 字体 13px 与"筛选字段"对齐（PM grep 已验证 `.scenario-config-label` 14px vs `.scenario-config-feature-grid label` 13px）；资金红线护栏 R5 三层不动
- **round 4 B4 真根因 fix** — `.big-account-split-left/right` 加 `min-height: 0`（1 行 CSS 双写 src + Clear）让 grid item 允许收缩到 < content size，让父 `.ba-scroll-container max-height: 52vh` 真正生效 → file-list `overflow-y: auto` 触发；dev round 3 scrollbar 强制可见 CSS 保留（双覆盖：触发滚动 + 持续可见）
- **round 4 B2** — multi 完成态字母没显示（被 B4 阻塞手测）；PM spec 双路径 sketch：路径 A 修 `letterSpan.textContent` 显式判 source='closed'（renderer-dialogs.js:1030-1037）/ 路径 B 改 `.ba-file-row grid-template-columns: auto minmax(24px, auto) 1fr`；dev 修完 B4 后用 DevTools 现场判断选哪条
- **round 5 B1 微调** — 去掉 radio 文本"（同时满足）"/"（满足任一）"；提示合到"条件" label tooltip（PM 推荐方案 B 单 tooltip 整合）；radio 仅保留 "AND" / "OR" 纯文字；资金红线护栏 R5 + B1 round 4 字体一致性 + Layout-1 全部不动
- **round 5 B4 真根因第 2 层 🚨** — dev round 4 修对第 2 层 grid item `.big-account-split-left/right` 但漏修**第 3 层 flex item** `.big-account-file-list/order-list`；PM grep 验证完整高度链 3 层 flex/grid 嵌套都需 `min-height: 0`；round 5 一次性修齐第 3 层（主修）+ 防御性给第 1 层 `.big-account-split-body` 也加（极小屏 edge case）；共 2 行 CSS × 2 文件双写
- 三件套（CHANGELOG / VFH / USER_GUIDE）发布前一次性更新
- smoke：F1/F2/F4/F6 各至少 1-2 用例；F3 手测 + preview 截图；F7 含全 19 个 smoke suite 回归矩阵 + 3 个新断言（PRAGMA 应用 / 索引存在 / Notification 调用桩）；round 2 R3 含 19 suite 全跑 + 1 updateStatusBox 单测；R5 含 3 个 dialog/引擎 fallback 断言；**R6a/R6b/R6c 纯 CSS 无 smoke，靠 preview screenshot regression + 手测**；round 3 B5 含 1 wiring 审计断言（grep `\.status-box-text.*textContent` 应全走 updateStatusBox）；F8 含 writer 第 2 sheet 写入 + 列对齐 smoke；**round 4 B1/B2/B4 纯 CSS+DOM 无 smoke，preview 必跑 + 手测（B4 修复后必跑 round 3 已建的 `applyBigAccountSelectionMultiLargePreviewState` ≥20 文件 fixture）**；**round 5 B1/B4 纯 CSS+DOM 无 smoke，preview 必跑 + 手测（B4 修复后用户实测能用鼠标滚轮/trackpad 在列表区域滚动）**

### 2.2 明确不做

- **⏸ F5 整体延期 v2.1.8**：本迭代不实施 BillDate 字符串化 + 算法重设；详 §十
- **不动**：F1/F2 命中类别外的其他场景类别（C4 / C2 业务逻辑除 F4 放宽外）
- **不动**：v2.1.6 收单单据币种校验模块的业务逻辑 / SQLite schema 业务表 / writer 输出格式 / 个人痕迹元数据模块（Module A）— F6 仅在主进程→渲染进程方向补进度事件；F7 仅在 database 启动 + 加索引 + 加 Notification，不动业务逻辑
- **不动**：F4 DB schema、scenarios.category 值（仅改 UI 展示名 + dialog label）
- **不做**：F2 引入更复杂的"全网匹配最大流"或双向 1v1（保持小步方案 A；B/C 留附录）
- **不做**：F6 进度持久化（不存 DB / 不存 session log）；不做"取消按钮"（仅展示进度，无中断能力）
- **不做**：F7 不引入 worker_threads / utilityProcess 子进程架构（A3 留 v2.1.8）
- **不做**：F7 不为 SQL JOIN 拆分批次（如 chunked LIMIT/OFFSET 批跑）—— 留 v2.1.8 A3 worker 架构方案统一解决
- **不做**：F7 不引入第三方通知库（如 node-notifier）—— 仅用 Electron 原生 Notification（已内置，零依赖）
- **不做**：round 2 R3 不批量改各模块 setStatus 调用方文案的半角 `:` → 中文「：」（PM 建议 spec 阶段 grep 一遍，少量必须换行的由调用方自行改）
- **不做**：round 2 R4 不扩散到其它模块（bankBuRecon/bizOpRecon/pending PM 已 grep 验证用 apply*ButtonState 范式无此问题）
- **不做**：R6a 不动 `.ba-file-row` grid-template-columns 硬编码（spec §13.7 已评估改 grid 子项数 = 跨 6 个分支的全局重构，超出本轮范围；按方案 C+B 组合最小修复）
- **不做**：R6 全系列不改业务逻辑、不改 JS 截断函数实现（仅 R6a 选 B 方案时改 truncateFileName maxLen 阈值常量）
- **不做**：round 3 B5 wiring 审计**不批量改各模块文案的半角 `:`**（R3 v0.6 已声明）；只确保所有 setXxxStatus 函数都走 updateStatusBox 入口
- **不做**：F8 不动 scenario-dispatcher `modifiedRows` filter 条件 / first-match-wins 行为（资金红线护栏）
- **不做**：F8 不动 v2.1.x `skippedRows`（Credit + Debit 都 0/空 静默 skip）链路；仍按现状走 error report warnings；F8 第 2 sheet 是 dispatcher 后未命中行，与 skippedRows 是**完全不同的两套数据**
- **不做**：F8 不动 reconIdFix / bankBuRecon / bizOpRecon / acquiringBillCurrency 等其它模块的导出（仅 statementGenerator 主功能明细文件）
- **不做**：F8 余额文件 `writeBalanceWorkbook` 不加第 2 sheet（余额基于已处理明细累加，与未命中场景无关）
- **不做**：F8 不加"未命中原因"诊断列（用户原话只要原始行）

---

## 三、需求清单总览

| # | 标题 | 模块 | 类型 | 风险 | AC 行数（预估） | 文件预估 | 用户拍板 |
|---|---|---|---|---|---|---|---|
| F1 | C1 条件加 AND/OR 开关 | 银行对账单处理 / C1 | 功能增强 | 🟡 中（改匹配语义） | 4 | dialog × 1 + engine × 1 + smoke × 1 | ✓ 按 PRD v0.1 推进；confirm/管理预览按 logic 切换 |
| F2 | C3 多笔等额改 1v1 | 银行对账单处理 / C3 | 算法重构 | 🔴 **HIGH（资金红线）** | 6 | engine × 1 + smoke × 3-4 | ✓ **方案 A（网关候选池 usedGwRowIdx Set）**；B/C 留附录 |
| F3 | 大账号 multi-mode 文件名"PP..." | 网银账单生成 / 大账号 UI | CSS bug（flex min-width:0 缺失） | 🟢 低 | 4 | css × 2（src + Clear 副本，若存在） | ✓ 用户截图佐证；根因 = `.big-account-file-item` flex 子项缺 `min-width:0` + multiMode-grouped 拼接后缀挤压 |
| F4 | 账单打标 → 银行对账单字段赋值 | 银行对账单处理 / C2 | 重命名 + 默认值 + 校验放宽 | 🟡 中（**衍生：引擎单 billType 行为按方案 A 实现**） | 8 | dialog × 1 + engine × 1 + USER_GUIDE × 1 + VFH × 1 + CHANGELOG × 1 + 注释 × 1 | ✓ 账单类型 ≥ 1 / 对账字段允许 0 行；衍生：C2 引擎 0 reconFields 走"无条件赋值"（方案 A） |
| F5 | BillDate 数字日期解析 + 算法 | 网关对账ReconID修复 / C4 gateway | 算法重设 | 🔴 **HIGH（资金红线）** | — | — | ⏸ **延期 v2.1.8**：详 §十；TEST2.xlsx 期望基线 57 行 / 单点 fix 28 行差距 = maxSize=8 上限 + manyToOne 遍历顺序，需算法重设 ≥ 1 周 |
| F6 | 收单币种校验状态框进度提示 | 收单单据币种校验 | UX 增强（IPC 事件 + 文本刷新） | 🟡 Low-Medium（IPC 事件 + 性能节流） | 7 | session × 1 + main × 1 + preload × 1 + renderer × 1 | ✓ 4 项细节定默认：文案用用户原话 / 节流 100ms / 5 阶段粒度按推荐 / 取消按钮不做 |
| F7 | 收单币种校验 SQL 调优 + 系统通知 | 全局数据库（A1）+ 收单单据币种校验（A2 + B1） | 性能 + UX（最小缓解，不动架构） | 🟡 中（A1 PRAGMA 全局回归 + WAL 旁文件落盘行为） | 9 | database × 1 + migrations × 1 + main × 1 + USER_GUIDE 提一句 WAL 旁文件 + smoke × 3 | ✓ 全部按推荐：A1 PRAGMA 4 条 / A2 source_file 索引 + ANALYZE / B1 Electron 原生 Notification；smoke 19 个 suite 全跑 |
| **round 2** | **用户手测反馈修复（R1-R5 + R6⏸）** | 跨多模块 | 小修汇总 | 🟢-🟡 中（R3/R5 影响面 ≥ 中）| 11 | dialog × 1 + session × 1 + renderer × 1 + styles × 1 + smoke × 2 | 详 §十三 round 2 节 |
| R1 | F4 billTypes 删按钮门槛 `<= 2 → === 1` | C2 dialog | 1 字符 diff | 🟢 低 | 1 | dialog × 1 | ✓ |
| R2 | F6 inserting 阶段 fileCount 显式注入 | acquiring session.js wrapper | bug 修 | 🟢 低 | 2 | session × 1 | ✓ |
| R3 | 状态框「：」（中文全角）后强制换行（全局规则） | renderer.js updateStatusBox + styles | 全局 UX | 🟡 中（影响所有模块状态框 → 19 suite 全过 + bizOpRecon 旧 hack 清理） | 3 | renderer × 1 + styles × 1 | ✓ `.replace(/：/g, '：\n')` + `white-space: pre-wrap`；只动中文「：」不动半角 `:` |
| R4 | F6 切模块再回来按钮被无脑解禁 | renderer acquiring 模块 | bug 修 | 🟢 低（限于 acquiring 模块；其它模块 PM 已 grep 验证无此问题） | 2 | renderer × 1 | ✓ acquiring 模块加 inflight flag；其它模块（bankBu/bizOp/pending）PM 验证已用 apply*ButtonState 范式无问题，不扩散 |
| R5 | F1 默认 AND（仅新建）+ dialog 纵向布局 + radio 移到独立行 | C1 dialog + 默认 config | 默认值变更 + UI | 🟡 中（默认值变 + 资金红线护栏：老 scenario 无 logic 字段 → 引擎仍 fallback OR） | 3 | dialog × 1 + smoke × 1 | ✓ 仅新建默认 AND；老 scenario fallback OR 不动；UI 移到独立行 + 纵向 + AND 在上 OR 在下 |
| **R6a** | F3 multi 模式文件名根因细化（`.ba-file-row` grid 2 列硬编码 vs 子项 3 个）| 大账号 multi dialog | CSS bug 修 | 🟡 中（待用户拍板方案 A/B/C 之一；PM 推荐 C+B 组合 §13.7） | 3 | css × 2（styles-gemini-extra.css 改 grid 列宽 + 可选 JS truncateFileName 阈值） | ⏸ 等用户拍板 A/B/C/(C+B) 后 spec 终稿 |
| **R6b** | 大账号 multi-mode dialog 列表滚动条丢失 | 大账号 multi dialog | CSS bug 修 | 🟢 低 | 2 | css × 1（行高 / 容器约束细化） | ✓ PM 已实测高度链通；真根因 = 单行高度撑长 + 容器 max-height 调整 |
| **R6c** | "确认大账号顺序" dialog 列表超屏不能滚 | extract-order-card dialog | CSS bug 修 | 🟢 低 | 2 | css × 1（`.extract-order-list` 加 max-height + overflow-y）| ✓ |
| **round 3** | **用户手测反馈修复（B1-B5 + F4 删空）+ F8 新需求** | 跨多模块 + 主功能 writer | 小修汇总 + 新功能 | 🟢-🔴 中（B5 R3 漏接修复 + F8 主功能写盘） | 18 | dialog × 1 + renderer × 1 + styles × 2 + writers × 1 + smoke × 2 | 详 §十四 round 3 节 + §十二 F8 节 |
| B1 | F1 radio 移回"条件"row 内部 | C1 dialog | DOM 重组 | 🟢 低 | 2 | dialog × 1 | ✓ |
| B2 | multi 完成态字母列丢失 | 大账号 multi dialog | CSS 副作用修 | 🟢-🟡 低中（待 dev 实测决定方案 A/B/C）| 2 | css × 1 | ⏸ 待 dev 实测 |
| B3 | extract-order-card 左右对齐 + 共用滚动条 | extract-order-card dialog | UI 重组 | 🟡 中（DOM/CSS 重写）| 3 | dialog × 1 + css × 1 | ✓ **用户 round 3 拍板方案 A**（单一 grid 表格 + 每行横跨左右 + 外层单 overflow + 移除 .extract-order-list 内层 overflow，~20 行 HTML+CSS） |
| B4 | ≥20 文件场景滚动条不可用 | 大账号 multi dialog | CSS 调试 | 🟡 中（PM 待 dev 实测真根因）| 2 | css × 1 + preview fixture × 1 | ⏸ 待 dev 实测 + preview fixture |
| **B5 🚨** | R3 wiring 漏接审计（3 处 + 加固） | renderer 全局 setStatus 体系 | 漏接修复 + 加固 | 🟡 中（3 处直写 statusBox，影响 acquiring + bankStatement + reconIdFix 模块）| 4 | renderer × 1 + smoke × 1 | ✓ 用户发现 1 处 + PM grep 再发现 2 处 |
| F4 删空 | R1 删按钮 handler `> 2` 没改 | C2 dialog | 1 字符 diff + 1 字符 diff | 🟢 低 | 1 | dialog × 1 | ✓ display + handler 同步 `>= 1` |
| **F8** | 银行对账单结果文件第 2 sheet 放**未命中场景规则的行** | scenario-dispatcher + statementGenerator 主功能 writer | 新功能 + dispatcher 反向 filter 🚨 资金红线 | 🔴 资金红线 + 🟡 中（写盘改造 + smoke 强制 matchedRows baseline 一致）| 9 | dispatcher × 1 + writers × 1 + main × 1 + smoke × 1 | ✓ **round 3 用户拍板定义** = dispatcher first-match-wins 后未命中行；PM grep 验证 rowLockSet 已就绪，一行 filter 反向得 unmatchedRows |
| **round 4** | **用户测 round 3 后反馈 3 项未通过（B1 + B2 + B4 全部立即实施）** | C1 dialog + 大账号 multi dialog | DOM 重组 + CSS 真根因 fix | 🟢 低 | 7 | dialog × 1 + css × 2（双写）| 详 §十六 round 4 节 |
| B1（round 4）| F1 radio Layout-1：左列纵向"条件 + AND + OR" | C1 dialog | DOM 重组 + CSS | 🟢 低 | 2 | dialog × 1 + css × 1 | ✓ **用户拍板 Layout-1**；radio label 字体 13px 与"筛选字段"对齐 |
| B2（round 4）| multi 完成态字母没显示 | 大账号 multi dialog | letterSpan 渲染 + grid track | 🟢 低 | 3 | dialog × 1 + css × 1 | ✓ **被 B4 阻塞**（用户原话无法手测）；PM 双路径 sketch — 路径 A 修 letterSpan / 路径 B 改 grid `minmax(24px,auto)`；dev 修完 B4 后用 DevTools 判断现场选 |
| B4（round 4）| ≥20 文件滚动条没出现 | 大账号 multi dialog | grid 子项 min-height: 0 | 🟢 低 | 2 | css × 1（双写）| ✓ **PM 真根因 grep 锁定** = `.big-account-split-left/right` 缺 min-height: 0 → grid item 默认 `min-height: auto` 穿透父 `.ba-scroll-container max-height: 52vh` → file-list `overflow-y:auto` 永不触发；1 行 CSS 修复 |
| **round 5** | **用户测 round 4 后 B1 微调 + B4 仍不能滚动** | C1 dialog + 大账号 multi dialog | DOM 微调 + CSS 真根因第 2 层 | 🟢 低 | 4 | dialog × 1 + css × 2（双写）| 详 §十七 round 5 节 |
| B1（round 5）| 去掉 radio 文本"（同时满足）/（满足任一）" + tooltip 整合 | C1 dialog | DOM 微调 + tooltip 文案扩展 | 🟢 低 | 2 | dialog × 1 | ✓ **用户拍板去文本**；PM 推荐方案 B 单 tooltip 整合到"条件" label 现有 ⓘ |
| B4（round 5）| 真根因第 2 层：第 3 层 flex item 也缺 min-height: 0 | 大账号 multi dialog | CSS 真根因 fix | 🟢 低 | 2 | css × 2（双写）| ✓ **PM 二次 grep 锁定**：round 4 修对第 2 层（grid item）但漏修第 3 层（flex item file-list/order-list）；spec §17.3 完整 3 层高度链 + 一次性修齐 |
| B2（round 5）跟随 | multi 完成态字母（B4 修好后用户实测）| 大账号 multi dialog | — | — | — | — | round 4 路径 A 已修源码；B4 修好后用户验证 → 成功收尾 / 失败 round 6 走路径 B |

---

## 四、代码现状（必须有出处）

| # | 关键文件:行号 | 现状描述 | 已知限制 / Bug |
|---|---|---|---|
| F1 | `src/main-process/scenario-engines/c1-extract-recon-id.js:36-42` | `rowMatchesAnyCondition` 用 `conditions.some()` 即 OR | 不支持 AND；语义硬编码 |
| F1 | `src/renderer-dialogs.js:6289` | dialog 行 3 tooltip "满足任一条件即可进入提取"，明示 OR | tooltip 硬编码，没有切换 UI |
| F1 | `src/renderer-dialogs.js:5704` | `createDefaultScenarioConfig('extract-recon-id')` 返回 `{ conditions: [{...}], ... }`，**无 conditionsLogic 字段** | 旧 scenario 都没该字段 → fallback 必须明确 |
| F1 | `src/renderer-dialogs.js:7532` | confirm dialog 文本 "条件（OR）：" 硬编码 | 需按 conditionsLogic 切换为 "条件（AND）：" / "（OR）" |
| F2 | `src/main-process/scenario-engines/c3-gateway-recon-join.js:123-145` | `bankRowsFiltered.forEach` × `gwRowsFiltered.filter(matched)`，多 match 取 `matched[0]` + warning，**不消费 gwRow** | 同金额多笔银行行 → 全部映射同 1 条 gwRow；用户反馈的多笔等额场景所有银行行赋同值 |
| F2 | `src/main-process/scenario-engines/c4-recon-id-fix.js:611-665` | `tryOneToOne` 范式：`pairedLeft/pairedRight` Set + 双向 tieBreak | 参考实现，F2 改造可借用 |
| F3 | `src/styles.css:1008-1013` | `.big-account-file-item { display:flex; align-items:center; gap:6px; padding:6px 14px; }` —— **flex 容器** | ⚠️ **未给子项设 `min-width:0`** → flex item 默认 `min-width:auto` = content size，挤压时不会让位 |
| F3 | `src/styles.css:1022-1027` | `.big-account-file-meta { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }` | ellipsis 规则**已就绪但触发不了**，因为 flex 父项不让它缩 |
| F3 | `src/styles-gemini-extra.css:411-416` | `.ba-file-name { font-family:..; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }` | 与 .big-account-file-meta 重复规则；同样卡在父 flex 不让缩 |
| F3 | `src/styles.css:969-983` | `.big-account-selection-split { width:min(100%, 1100px) }` + `.big-account-split-body { display:grid; grid-template-columns:1fr 1fr; }` | 弹窗总宽 1100px，左右各 ~550px；左侧文件列表实际可用宽度 ~536px（减 padding） |
| F3 | `src/renderer-dialogs.js:1037` | multiMode-grouped 分支：`meta.textContent = group ? '${displayName} → ${merchantId} ${currency}' : displayName` | **multiMode-grouped 状态独有**的"→ 大账号"后缀；非 multiMode 此行不执行 |
| F3 | `src/renderer-dialogs.js:1023-1038` | multiMode-grouped 行结构：`<marker ✓> + <letter a.> + <meta 文件名→大账号>` 3 个 flex 子项 | 前 2 个有固定/小宽度，meta 子项被前两者 + 后缀挤到 width ≈ 30-40px，只能显示 "PP..." |
| F3 | `src/renderer-dialogs.js:946-952` | `truncateFileName(fullName, 20)`：超 20 → 切成 `slice(0,6) + '...' + slice(-10)` | JS 截到 20 字符后 = `PPHK-X...0520-001.xlsx`（19 字符）；**这一步本身不是 bug，CSS 才是** |
| F3 | `src/renderer-dialogs.js:999, 1052, 1056` | 其它（非 grouped）分支均 `truncateFileName(fullName, 20) + rowSuffix` 后 textContent / innerHTML | 非 multiMode 时也截 20 但显示完整（容器够宽，CSS 不触发 ellipsis） |
| F4 | `src/renderer-dialogs.js:5391-5400, 5639-5645` | `SCENARIO_CATEGORY_LABELS['offset-bill-mark'] = '账单打标'` + 类别选择枚举 label '账单打标' | 类别展示名硬编码 |
| F4 | `src/renderer-dialogs.js:5709-5717` | C2 默认 config：billTypes 默认 2 行 `[{seq:1,field:'',op:'等于',value:''}, {seq:2,...}]`、reconFields 默认 1 行、markValue 默认 `{type:2,field:'',value:''}` | billTypes / reconFields 默认行预填了示例结构 |
| F4 | `src/renderer-dialogs.js:6629` | dialog 行 5 `<span class="scenario-config-label">打标值</span>` | label 硬编码"打标值" |
| F4 | `src/renderer-dialogs.js:5840-5842` | 校验错误文案：`'打标值的"账单类型"必须存在于上方账单类型列表中'` / `'打标值的字段不能为空'` / `'打标值的写入值不能为空'` | 3 处校验文案硬编码"打标值" |
| F4 | `src/renderer-dialogs.js:7544` | confirm dialog `'打标：'` 行硬编码 | 预览文案需改"赋值：" |
| F4 | `docs/USER_GUIDE.md:553` | "账单打标（C2）：双类型行..." | 用户文档 |
| F4 | `docs/VERSION_FEATURE_HISTORY.md:385` | "C2 场景（账单打标）：双类型行配对..." | 版本史文档 |
| F4 | `CHANGELOG.md:713` | "C2 场景（账单打标）：双类型行配对..." | 历史 changelog（**仅新版本段更新，老条目不动**） |
| F4 | `src/backend/database/migrations.js:342, 395, 466, 503, 556` | `category: 'offset-bill-mark'` + CHECK 约束含 `'offset-bill-mark'` + migration 内置场景名 'outbound改标为outbound Fail' 仍用 category 字符串 | **DB 层完全不动**，只改 UI 展示 |
| F4 | `src/main-process/scenario-engines/c2-offset-bill-mark.js:60-71, 72-83` | `if (billTypes.length < 2) { warning return }` + `if (reconFields.length === 0) { warning return }` | ⚠️ **引擎硬卡**：与 F4 新校验"billTypes ≥ 1 + reconFields 允许 0 行"**冲突**；spec 必须同步放开（详 §9.5） |
| F5 | （延期 v2.1.8） | — | 详 §十 |
| F7-A1 | `src/backend/database.js:39-42` | `init() { ... this.db = new DatabaseSync(this.dbPath); this.db.exec('PRAGMA foreign_keys = ON;'); ... }` | 仅 1 条 PRAGMA；缺 WAL / synchronous / cache_size / mmap_size，所有 DB 读写默认走 sync=FULL（性能慢 2-3 倍）|
| F7-A1 | `node:sqlite` DatabaseSync API | `db.exec(...)` 支持 `PRAGMA` 语法（与 better-sqlite3 类似）；多语句可在一个 exec 字符串里串 | DatabaseSync 是 Node 22+ 内置实验性 API；本项目 Electron 36 内嵌 Node 22 已就绪 |
| F7-A2 | `src/backend/database/migrations.js:967-997` | 已有 `idx_acquiring_bill_currency_flow_join` + `idx_acquiring_bill_currency_bill_join` 覆盖 `(month_key, recon_main_id)` JOIN ON | **PM 已验证**：JOIN ON 复合索引最优；F7-A2 真正缺的是 `source_file` 索引（见下行）|
| F7-A2 | `src/backend/acquiring-bill-currency-db/run-repository.js:114-141, 180-187` | `listDiffRowsBySourceFile` + `listAllDiffRowsByRun` + `listSourceFilesByRun` 在 writer 阶段高频按 `source_file` 查询 | 现有 schema **无 source_file 索引**；500w 行级数据 writer 阶段全表扫描 |
| F7-A2 | `src/backend/database/migrations.js` | 现有 ensure* helper 范式（`ensureAcquiringBillCurrencyTablesSupport` 等），全部 CREATE INDEX IF NOT EXISTS 幂等 | F7-A2 可新增独立 ensure helper 或追加到现有 helper 内 |
| F7-B1 | `src/main.js:6` | `const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');` | **未引入** `Notification` —— F7-B1 需在 destructure 加 `Notification` |
| F7-B1 | `src/main.js:10218, 10222`（runCheck handler return success / error 前）| 当前直接 `return { status: 'success', ...result }` 或 `return { status: 'error', message }` | 在 return 前追加 `new Notification({ title, body }).show()`；不破坏现有 return 链路 |
| F6 | `src/main-process/acquiring-bill-currency-session.js:41-76, 88-130` | `importFilesInTransaction` / `importFilesWithOverwrite` 已带 `onProgress` 参数；每文件切换触发 `{ stage:'reading', fileIndex, fileCount, filePath }`；reader 内层每 10000 行触发 `{ stage:'inserting', fileIndex, sourceFile, importedCount }` | **已就绪但 main.js handler 未接入** — onProgress 链路完整但事实上不工作 |
| F6 | `src/backend/acquiring-bill-currency-import/reader.js:271-412` | streamImportOneFile 内部 `if (onProgress && importedCount % 10000 === 0) onProgress({ sourceFile, importedCount })` | 节流粒度 10000 行；已实现，无需改 |
| F6 | `src/main-process/acquiring-bill-currency-session.js:163-237` | `runCheck` 函数**无 `onProgress` 参数**；5 个阶段（clearRunsByMonth / computeRunStats / insertRun / insertDiffRowsByJoin / writeRunOutputs）一气呵成，无任何回调 | 运行阶段缺进度回调链路，需补 onProgress 入参 + 阶段埋点 |
| F6 | `src/main.js:10119-10126, 10182-10187` | `sessionImport({ db, monthKey, filePaths })` 调用时**没传 onProgress** | handler 必须改成 `onProgress: (ev) => event.sender.send('acquiringBillCurrency:import:progress', ev)` |
| F6 | `src/main.js:10208-10248` | `acquiringBillCurrency:run` handler 调用 `runCheck({ db, monthKey, storageRoot })` 时没传 onProgress | handler 必须改成 `onProgress: (ev) => event.sender.send('acquiringBillCurrency:run:progress', ev)`；同步 runCheck 也补 onProgress 入参 |
| F6 | `src/main.js:9504-9523` | `pending:import:progress` 范式：`webContents = event.sender` + `webContents.send('pending:import:progress', ev)` | **F6 复用此范式**，是项目已有的"主进程→渲染进程进度通道"成熟实现 |
| F6 | `src/preload.js:206-227` | `pending.onImportProgress: (listener) => ipcRenderer.on('pending:import:progress', (_event, ev) => listener(ev))` | **F6 复用此 API 形式** — 在 `acquiringBillCurrency` 命名空间下新增 `onImportProgress` / `onRunProgress` |
| F6 | `src/preload.js:265-273` | `acquiringBillCurrency.{listMonths, sessionStatus, importFlow, importBill, run, export, clearMonth}` — 7 个 IPC channel 全是 invoke，**无任何订阅通道** | 需新增 2 个 `ipcRenderer.on` 订阅接口 |
| F6 | `src/renderer.js:4276-4340` | `runAcquiringBillCurrencyImport`：进入 handler 时 `setAcquiringBillCurrencyStatus('正在导入流水表（YYYY-MM）...', 'info')`，**直到 IPC return 才再 setStatus 成功/失败** | 中间无任何文本更新；用户等 8-15 分钟无反馈 |
| F6 | `src/renderer.js:4350-4377` | `handleAcquiringBillCurrencyRun`：进入时 `setAcquiringBillCurrencyStatus('正在对账（YYYY-MM）...', 'info')`，**直到 IPC return** | 同上 — 用户感知"卡死" |
| F6 | `src/renderer.js:4235-4242` | `setAcquiringBillCurrencyStatus(message, tone='info')` 仅改 .status-box-text 子节点 textContent + class | 可直接复用（不改其行为，只是高频调用） |
| R6a | `src/styles-gemini-extra.css:391-401` | `.ba-file-row { display: grid; grid-template-columns: 28px 1fr; align-items:center; gap:10px; }` —— **硬编码 2 列** | ⚠️ multi 各分支动态 append 3 子项（marker/checkbox + letter + meta），第 3 子项压到第 2 列 `1fr` 共享 → meta 可用宽度被前 2 子项挤掉触发 ellipsis = 真正"PP..."根因 |
| R6a | `src/styles-gemini-extra.css:411-419` | `.ba-file-name { min-width:0; flex:1 1 auto; ... text-overflow:ellipsis; }` | ⚠️ b1ba84b round 1 加 `min-width:0 + flex:1 1 auto`，但 **`flex` 对 grid 子项无效**（用户分析正确）；`min-width:0` 单独不够 |
| R6a | `src/renderer-dialogs.js:946-952 truncateFileName` | `keepStart=6, keepEnd=10, threshold=20`：`fileName.length <= 20` 直接返回原值 | 业务文件名 `PPchaxun1.csv 第9行`（18 字符）不触发 JS 截断；只能靠 CSS ellipsis 兜底（但 R6a 根因导致 ellipsis 触发后 meta 列宽太窄）|
| R6a | `src/renderer-dialogs.js:1002-1022 / 1023-1038 / 1039-1053` | multi-editing / multi-grouped / multi-uncovered 3 个分支各 append 3 子项给 `.ba-file-row` | 3 子项 vs 2 列 grid 不匹配（详 §13.7）|
| R6a | `src/renderer-dialogs.js:1054-1057` | 非 multi 分支 `innerHTML = ...idx + meta` 2 子项 | ✓ 与 grid 2 列对齐，无问题 |
| R6b | `src/styles-gemini-extra.css:16-25 .modal-card` | `display:flex; flex-direction:column; overflow:hidden; max-height: calc(100vh - 56px)` | ✓ modal-card 已有高度 + overflow 兜底 |
| R6b | `src/styles-gemini-extra.css:190-191` | `.big-account-selection-card { width: min(100%, 1080px); min-height: 540px; }` + `.big-account-selection-split { min-height: 600px; }` | ⚠️ `min-height: 600px` 强制最小高度可能与 modal-card max-height 冲突在小屏上 |
| R6b | `src/styles-gemini-extra.css:356-389` | `.big-account-split-body { flex:1; overflow:hidden; }` + `.ba-scroll-container { display:grid; grid-template-columns: 1fr 1fr; height:100%; min-height:360px; max-height: 52vh; }` + `.big-account-file-list/.big-account-order-list { flex:1; overflow-y:auto; }` | ✓ 高度链完整 |
| R6b | `src/renderer-dialogs.js:879` | dialog innerHTML 已含 `<div class="ba-scroll-container">` | ✓ 类已加 |
| R6b | PM 二次诊断 | 高度链通；用户描述"滚动条丢失"真实根因 = R6a 拼接的 `→ MERCHANT USD` 后缀让单行更高/更宽 → 内容总高 < max-height 52vh 时确实不出现滚动条；但**单行被挤压触发文件名 "PP..."**，用户误以为是滚动问题 | R6b 仅需细化"行高一致性 + 文件名完整显示后高度链验证"，可能与 R6a 修复合并 |
| R6c | `src/renderer-dialogs.js:1680-1700` | `.extract-order-card` modal-card 内含 `.extract-order-body`（grid 1fr/1.15fr）+ 2 个 `.extract-order-list` 子列表（文件顺序 + 大账号信息）+ `.dialog-actions` | 结构 OK |
| R6c | `src/styles-gemini-extra.css:1285-1296` | `.extract-order-card { width: min(100%, 760px) }` + `.extract-order-body { padding:18px 28px 8px; display:grid; ... gap:28px; }` + `.extract-order-list { display:flex; flex-direction:column; }` | ⚠️ `.extract-order-list` **没有 max-height + 没有 overflow-y** |
| R6c | `src/styles-gemini-extra.css:1297-1315` | `.extract-order-row { display:grid; grid-template-columns: 24px 1fr auto; ... }` + `.extract-order-row .eo-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }` | ✓ 行结构对（3 子项 vs 3 列），文件名能正常显示 |
| R6c | `.modal-card` 兜底 | `overflow:hidden + max-height: calc(100vh - 56px)` | ⚠️ modal-card overflow:hidden 切掉超屏内容，但 `.extract-order-list` **不能滚动**（CSS 没 overflow-y:auto）→ 用户看不到底部 |
| B1 | `src/renderer-dialogs.js:6332-6346` | R5 落地为独立 `.scenario-config-row` + label "条件聚合" + `.scenario-config-logic-stack` | 用户期望移回 `:6325-6331` "条件" row 内 `.scenario-config-multi-wrap` 末尾 |
| B2 | `src/renderer-dialogs.js:1027-1042 ba-multi-grouped 分支` | append 3 子项 `[markerSpan(✓) + letterSpan('a./b./c.') + meta]` | R6a grid `auto auto 1fr` 下 letter 列 auto = content size ≈ 12-14px；可能被 marker(也是 auto) 挤压 |
| B2 | `src/styles-gemini-extra.css:1887` | `.big-account-order-index--alpha { color: var(--muted); }` 仅 color | ⚠️ 无 min-width / padding；letter 列宽完全靠 content size |
| B2 | `src/styles.css:1301 .ba-left-letter` | inactive（styles.css disabled） | 不生效，需在 styles-gemini-extra.css 加 letter 列宽兜底 |
| B3 | `src/renderer-dialogs.js:1683-1701` | `.extract-order-card` 内 `.extract-order-body { grid 1fr/1.15fr }` 含 2 个独立 `.extract-order-list` 子 div（各自 overflow） | 两栏独立列表 → 行数可能不同 + 滚动各自独立 → 用户看不到对应关系 |
| B3 | `src/renderer-dialogs.js:940-944` | `mainSyncingScroll` 同步滚动范式已存在（大账号 multi dialog 用过）| 方案 B 可复用此范式 |
| B4 | `src/styles-gemini-extra.css:361-367` | `.ba-scroll-container { display:grid; grid-template-columns: 1fr 1fr; height:100%; min-height:360px; max-height: 52vh }` | 高度链已通；用户报告 ≥20 文件场景滚动条**不可用**（不是丢失），需 dev 实测真实表现 |
| B4 | `src/renderer-previews.js:627-636` | `applyBigAccountSelectionMultiPreviewState` 仅 5 文件 fixture | spec 阶段需新增 ≥20 文件 fixture 验证滚动 |
| **B5** | `src/renderer.js:519-538 updateStatusBox` | R3 已加 `replace(/：/g, '：\n')` + textContent 入口 | ✓ 全局规则就绪 |
| **B5 🚨 漏接 1** | `src/renderer.js:4245-4252 setAcquiringBillCurrencyStatus` | 直接 `text.textContent = message;` **不走 updateStatusBox** | ⚠️ R3 wiring 漏接（用户发现）|
| **B5 🚨 漏接 2** | `src/renderer.js:3298-3331 updateBankStatementUi` | L3330 `textEl.textContent = text;` **不走 updateStatusBox** | ⚠️ R3 wiring 漏接（PM grep 发现）|
| **B5 🚨 漏接 3** | `src/renderer.js:3647-3686 updateReconIdFixUi` | L3684 `textEl.textContent = text;` **不走 updateStatusBox** | ⚠️ R3 wiring 漏接（PM grep 发现）|
| B5 | `src/renderer.js:259 pendingStatusBox` | element 引用存在 + 无对应 set 函数（PM grep `pending.*status.*update` / `renderPendingStatus` / `applyPendingStatus` 全部为空）| ✓ 无需修（v2.1.x 阶段 pending 模块已废 statusBox 渲染）|
| F4 删空 | `src/renderer-dialogs.js:6716` | R1 改后 `config.billTypes.length === 1 ? '' : '<button remove>'`（保留 1 行）| ⚠️ 用户期望删空 = `< 0` 永远显示按钮 |
| F4 删空 | `src/renderer-dialogs.js:6794` | **R1 未改的 handler 仍卡 `config.billTypes.length > 2`** | ⚠️ display 改了但 handler 没改，点击按钮无效；F4 删空需同步改两处为 `>= 1` |
| F4 删空 | `src/renderer-dialogs.js:5832` | 保存校验 `c.billTypes.length < 1` 报"账单类型至少需要 1 行" | ✓ 校验兜底已就绪（R1 spec 已实现） |
| F8 | `src/main-process/scenario-dispatcher.js:122-123` | `const modifiedRows = bankRows.filter((r) => rowLockSet.has(r._rowId));` | ✓ **已有 rowLockSet 命中集合**；F8 改造 = 一行**反向 filter** 得 unmatchedRows |
| F8 | `src/main-process/scenario-dispatcher.js:138-151` | dispatcher return `{ modifiedRows, modifications, errorReport, stats }` | F8 改 return 新增 `unmatchedRows` + `stats.unmatchedRowCount` 字段；**modifiedRows filter 条件不动**（资金红线护栏） |
| F8 | `src/main.js:2858` | `BANK_STATEMENT_CATEGORIES = new Set(['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join'])` | ✓ dispatcher 入参已限定 C1/C2/C3；C4 走独立流水线（不在 unmatchedRows 范围） |
| F8 | `src/main.js:5948-5957` | `writeWorkbookRows({ rows: detailExportRows, outputFilePath })` | F8 加可选 `unmatchedRows` 入参（来源 dispatcher）|
| F8 | `src/backend/file-service/writers.js:223-260` | `writeWorkbookRows({ rows, outputFilePath, sheetName })` 单 sheet 接口 | F8 改造为可选 `unmatchedRows` 入参触发追加第 2 sheet "未命中场景行" |
| F8 | `src/backend/file-service/writers.js:237-302` | `writeBalanceWorkbook` 已支持多 sheet（per currency） | **不在 F8 范围**（余额文件不加 sheet）|
| F8（不用）| `src/main-process/statement-session.js:16 skippedRows` | v2.1.x `skippedRows` = Credit + Debit 都 0/空 静默 skip | **F8 不用此字段**；与"未命中场景"是完全不同的两套数据，spec §15.1 已明示 |
| **B1（round 4）** | `src/renderer-dialogs.js:6325-6346` | dev round 3 把 radio 放在 `.scenario-config-multi-wrap` **内部**（右列），与用户期望相反 | round 4 重做：新增 `.scenario-config-label-stack` 容器，左列纵向"条件 label + AND radio + OR radio" |
| **B1（round 4）** | `src/styles-gemini-extra.css:2274-2281 .scenario-config-label` | `font-weight: 500; color: #3c4043; width: 120px;` —— **无 font-size，继承父级（默认 ~14px）** | radio label 需显式设 13px（与"筛选字段"对齐）|
| **B1（round 4）** | `src/styles-gemini-extra.css:2477-2482 .scenario-config-feature-grid label` | `display: flex; align-items: center; gap: 8px; font-size: 13px;` | "筛选字段" label 字号基准 |
| **B1（round 4）** | `src/styles-gemini-extra.css:2284-2286 .scenario-config-row-multi .scenario-config-label` | `padding-top: 6px;` 多行 row label 顶端对齐 | round 4 新 label-stack 容器需保留顶端对齐效果 |
| **B2（round 4）⏸** | `src/styles-gemini-extra.css:1912-1918 .big-account-order-index--alpha` | dev round 3 已加 `min-width: 24px + text-align: center` | 用户实测无效；PM 候选根因 ⏸ 等截图 |
| **B2（round 4）⏸** | `src/renderer-dialogs.js:1027-1042 ba-multi-grouped` | `letterSpan.textContent = group ? '${String.fromCharCode(97 + groupInfo.groupIndex)}.' : '';` | 完成态 group 应有效；但 L1031 `multiGroups[groupInfo.groupIndex]` 在 pendingGroup 时 = `multiGroups[-1]` = undefined → letterSpan 空字符串（编辑态可能误判）|
| **B2（round 4）⏸** | `src/renderer-dialogs.js:1191-1198 findGroupByRowIndex` | pendingGroup 行返回 `{ source: 'pending', groupIndex: -1 }` | PM 候选根因：L1031 `multiGroups[-1] = undefined → group falsy → 字母空`；完成态前 closeCurrentGroup 应已把 pendingGroup 转 closed，但若有边界 case 未转 → 字母空 |
| **B4（round 4）⏸** | `src/styles-gemini-extra.css:191-192` | `.big-account-selection-card { width: min(100%, 1200px); min-height: 540px; }` + `.big-account-selection-split { min-height: 600px; }` | R6a 已加宽 1200，但 split-body `min-height: 600px` 强制下限 |
| **B4（round 4）⏸** | `src/styles-gemini-extra.css:361-367 .ba-scroll-container` | `height: 100%; min-height: 360px; max-height: 52vh;` | 52vh 在 1080p 屏 = 562px；split-body min-height 600px 时实际高度 ≥ 600 ＞ 562 → max-height 不再 cap → 父高度撑大 → 子 file-list 总高度可能 < 父高度 → 不滚动 |
| **B4（round 4）⏸** | `src/styles-gemini-extra.css:385-408` | dev round 3 已加 `scrollbar-width: thin + scrollbar-color + ::-webkit-scrollbar 8px` | 用户实测无效；说明根因不在 scrollbar 可见性，而在**滚动条本身不需要触发**（内容总高 < 容器高度）|
| **B1（round 5）** | `src/renderer-dialogs.js:6358-6368` | round 4 落地：`<span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>` + 2 个 `<label>AND（同时满足）</label>` / `<label>OR（满足任一）</label>` | round 5 改 tooltip 文案为多行 "AND：同时满足所有条件才命中；OR：满足任一条件即命中"；radio label 去掉"（同时满足）/（满足任一）"，仅保留 "AND" / "OR" |
| **B4（round 5）真根因第 2 层 🚨** | `src/styles-gemini-extra.css:390-400 .big-account-file-list/.big-account-order-list` | `flex: 1; overflow-y: auto; display: flex; flex-direction: column; ...` —— ⚠️ **缺 min-height: 0** | 是 `.big-account-split-left/right`（flex column 父）的 flex 子项；自身默认 `min-height: auto = content size` → 即使 round 4 split-left 加了 min-height: 0，file-list 自己仍把 split-left 撑到 content size 高度 → max-height: 52vh 仍被穿透 → file-list 自己 overflow-y: auto **永不触发** |
| **B4（round 5）防御性兜底** | `src/styles-gemini-extra.css:357-360 .big-account-split-body` | `flex: 1; padding: 8px 12px 0; overflow: hidden;` —— **缺 min-height: 0** | modal-card 的 flex column 子项；在极小屏（< 700px 高，1080p 下不会）边界 case 可能撑出 modal-card max-height；round 5 防御性加 `min-height: 0` 兜底 |
| **B4（round 5）完整高度链 PM 验证** | 见 spec §10.3.1 + spec §17.3 表格 | modal-card → big-account-selection-card+split（同一元素）→ split-body → ba-scroll-container → split-left/right → file-list/order-list；3 层 flex/grid 嵌套均需 `min-height: 0` | round 4 只修第 2 层 grid item；round 5 必须修第 3 层 file-list/order-list（用户报告主路径）+ 防御性加第 1 层 split-body |
| **B2（round 5）跟随** | round 4 路径 A 已 commit | 等 B4 修好后用户实测字母显示 | 成功 → 收尾；失败 → round 6 走路径 B（grid `auto minmax(24px, auto) 1fr`）|

---

## 五、术语

| 术语 | 含义 |
|---|---|
| C1 | 提取ReconId-From Self 场景类别（`extract-recon-id`） |
| C2 | 账单打标 场景类别（`offset-bill-mark`，本迭代后 UI 展示改名"银行对账单字段赋值"） |
| C3 | 提取ReconId-From 网关 场景类别（`gateway-recon-join`） |
| C4 | 单据/网关对账 ReconID 修复 场景类别（`recon-id-fix` / `gateway-recon-id-fix`） |
| 1v1 配对 | 左侧每行至多匹配 1 个右侧候选；左右两侧的"已被消费"标记互不重用（参考 c4 `tryOneToOne` 范式：`pairedLeft / pairedRight` Set） |
| BillDate | C4 算法骨架硬编码字段名；gateway 子模式入口把 `createTime` 映射为 `BillDate` 后供下游 `billDateMatches` / `parseBillDateMs` 用 |
| Excel 序列号 | Excel 日期格式列读出的浮点数，整数部分 = 自 1900-01-01 起的天数；带 1900 年闰年 bug |
| conditionsLogic | F1 新增的 scenario.config 字段，枚举值 `'AND'` / `'OR'`；缺失时引擎按 OR fallback（向下兼容） |
| settle_amount_abs | （v2.1.6 收单单据币种校验）— F6 不修改此字段，仅作为引用术语 |
| onProgress 链路 | F6 关键词。session 层暴露 `onProgress` 函数参数，main.js handler 实现 `(ev) => event.sender.send(channel, ev)` 把回调桥接到渲染进程；preload.js 暴露 `ipcRenderer.on(channel, listener)` 订阅 API |
| pending:import:progress 范式 | 项目已有的"主进程→渲染进程进度通道"成熟实现，定义于 `main.js:9520` + `preload.js:215`，F6 直接复用 |
| 节流粒度 | F6 性能要点。reader 已有 `importedCount % 10000 === 0` 节流；F6 仅做"主进程→渲染进程"事件丢弃（如 100ms 时间窗口），不改 reader 节流 |
| PRAGMA | SQLite 运行时配置指令。F7-A1 全局应用 4 条：journal_mode=WAL（读写并发）/ synchronous=NORMAL（WAL 模式下安全 + 性能 2-3 倍）/ cache_size=-65536（64MB 页缓存）/ mmap_size=268435456（256MB 内存映射，SATA SSD 顺序读受益）|
| WAL 旁文件 | journal_mode=WAL 切换后 SQLite 会自动产生 `tool-data.sqlite-wal` + `tool-data.sqlite-shm` 两个旁文件（与主 DB 同目录）；正常关闭时 wal 内容会 checkpoint 回主文件，但运行期间用户备份 DB 必须同时备份 3 个文件 |
| ANALYZE | SQLite 内置指令，扫描各表 + 索引刷新统计信息到 `sqlite_stat1` 系统表；查询规划器据此选择更优索引；F7-A2 启动时跑一次（幂等，无副作用）|
| Electron Notification | Electron 主进程原生 API `new Notification({ title, body }).show()`；macOS 走通知中心、Windows 走任务栏；零依赖、跨平台原生支持；不需要 IPC 通道 |

---

## 六、F1 — C1 条件加 AND/OR 开关

### 6.1 背景与目标

- **背景**：用户希望多条件组合可在 AND/OR 间切换。当前 C1 隐含 OR（`conditions.some()`），dialog tooltip 和 confirm 预览都写死"OR"。
- **目标**：在条件行下方加 AND/OR 切换；引擎按 `conditionsLogic` 走 every/some；旧 scenario fallback OR（保持向下兼容）。

### 6.2 影响范围

- 前端：`src/renderer-dialogs.js`（dialog C1 渲染 + tooltip + confirm 预览 + 校验 + 默认 config）
- 后端：`src/main-process/scenario-engines/c1-extract-recon-id.js`（`rowMatchesAnyCondition` → `rowMatchesConditions(row, conditions, logic)`）
- DB：**无 schema 变更**（`scenarios.config` 已是 JSON，新增字段即可）
- 兼容性：旧 scenario.config 无 `conditionsLogic` 字段 → fallback OR

### 6.3 设计方案

#### 6.3.1 UI 设计

```
[条件 ⓘ 满足下方条件即可进入提取]
  ┌─────────────────────────────────────────────────┐
  │  字段 [   ▼]  操作 [等于 ▼]  值 [        ]  ×   │
  │  字段 [   ▼]  操作 [等于 ▼]  值 [        ]  ×   │
  └─────────────────────────────────────────────────┘
  ＋新增条件

  条件聚合：  ◉ OR（满足任一）   ○ AND（同时满足）   ← 新增（radio 组）
```

- 控件：两个 radio 按钮（同 name 组）；默认 `OR`（与旧行为一致）
- 位置：紧贴"+ 新增条件"按钮下方
- 仅 1 行条件时 radio 仍显示（不隐藏，让用户能预设增加多行后的语义）
- 只读模式（view）下 radio 禁用

#### 6.3.2 数据 schema

`scenarios.config` 新增字段：

```js
{
  conditions: [...],        // 现有
  conditionsLogic: 'OR',    // 新增 — 'AND' / 'OR'；缺失时 fallback OR
  extractByFeature: ...,    // 现有
  extractByOtherField: ...  // 现有
}
```

`createDefaultScenarioConfig('extract-recon-id')`（`renderer-dialogs.js:5702-5708`）补 `conditionsLogic: 'OR'`。

#### 6.3.3 引擎实现

`c1-extract-recon-id.js` 改 `rowMatchesAnyCondition` → `rowMatchesConditions`：

```js
function rowMatchesConditions(row, conditions, logic) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  const fn = logic === 'AND' ? 'every' : 'some';
  return conditions[fn]((cond) => evaluateCondition(row, cond));
}

// runC1Scenario 内：
const logic = (config.conditionsLogic === 'AND') ? 'AND' : 'OR';
if (!rowMatchesConditions(row, conditions, logic)) return;
```

#### 6.3.4 confirm 预览文案

`buildScenarioConfirmDetailHtml`（`renderer-dialogs.js:7532`）：

```js
const logicLabel = (c.conditionsLogic === 'AND') ? 'AND' : 'OR';
html += `...条件（${logicLabel}）：...`;
```

#### 6.3.5 校验

`validateScenarioDraft`（`renderer-dialogs.js:5804-5829`）已校验 `conditions` 内容，无需额外校验（`conditionsLogic` 是枚举，默认即合法）。

### 6.4 验收标准

| AC 编号 | 验收条件 |
|---|---|
| AC-F1-1 | C1 dialog 新增/修改场景页面条件行下方显示 AND/OR radio 组；默认 OR；只读模式禁用 |
| AC-F1-2 | 切换到 AND 保存后，新场景运行 → 引擎仅在"所有条件全 true"时该行才进入提取；切回 OR → 任一条件 true 即进入 |
| AC-F1-3 | 旧 v2.1.6 scenario（无 conditionsLogic 字段）打开仍显示 OR 选中；首次保存自动写入 `conditionsLogic: 'OR'`（无行为差异） |
| AC-F1-4 | confirm dialog 与 scenario 列表"管理"页预览文案 `条件（AND）：` / `条件（OR）：` 跟随实际值 |

### 6.5 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | 旧 scenario 升级保存后 `conditionsLogic: 'OR'` 写盘，若用户实际期望 AND 会无声跑错 | 旧 scenario 无 logic 字段时 dialog 读出 → 显示 OR radio 选中；引擎 fallback OR；与旧行为一致，不存在静默变更 |
| 🟢 低 | 旧 spec smoke 用例如 `条件A=true && 条件B=false` 预期"命中"（OR）会在 AND 模式失败 | smoke 必须新增 AND mode 用例；旧 OR 用例不动 |

⚠️ **不命中 `rules/important-variables.md` 任何条目**（C1 引擎本身不在重要变量表）。

---

## 七、F2 — C3 提取ReconId-From 网关 多笔等额改 1v1 🚨 资金红线

### 7.1 背景与现状

#### 7.1.1 用户反馈

- 用户实测：银行对账单和网关账单同时存在多笔金额一致的行，C3 场景运行后**多笔银行行被赋同一条网关行的值**，导致后续业务环节误判。
- 期望：1v1 配对（一笔银行行 ↔ 一笔网关行）。

#### 7.1.2 代码现状（`c3-gateway-recon-join.js`）

```js
// L123-145（简化伪代码）
bankRowsFiltered.forEach((bankRow, index) => {
  const rowId = ensureRowId(bankRow, index);
  const matched = gwRowsFiltered.filter((gwRow) => gwMatchesBank(gwRow, bankRow, reconFields));
  if (matched.length === 0) return;
  if (matched.length > 1) warningCollector.push({ code: 'multi-gateway-match', ... });
  const chosen = matched[0];  // ⚠️ 多次循环都取到 matched[0]，gwRow 未被消费
  bankRow[assign.bankField] = chosen[assign.gwField];
  modCollector.record(...);
});
```

**Bug 表现**：3 笔等额银行行 + 3 笔等额网关行 → 3 笔银行行全部被赋 `gwRowsFiltered[0]` 的值（因为 `matched[0]` 始终是 gwRowsFiltered 里第一个等额行）。

#### 7.1.3 用户期望的"1v1"语义

- 银行行 B1 / B2 / B3 + 网关行 G1 / G2 / G3 金额全等 →
  - B1 ← G1
  - B2 ← G2
  - B3 ← G3
- 银行行 4 笔 + 网关行 3 笔 → 配 3 对 + 第 4 笔银行行不命中
- 银行行 3 笔 + 网关行 4 笔 → 配 3 对 + 第 4 笔网关行剩余（不写回，gw 数据本就不修改）

### 7.2 方案对比表

#### 方案 A：网关候选池标记已用 + 顺序消费（最小修改）

```js
const usedGwRowIdx = new Set();
bankRowsFiltered.forEach((bankRow, index) => {
  const rowId = ensureRowId(bankRow, index);
  const matched = gwRowsFiltered
    .map((g, i) => ({ row: g, idx: i }))
    .filter((x) => !usedGwRowIdx.has(x.idx) && gwMatchesBank(x.row, bankRow, reconFields));
  if (matched.length === 0) return;
  if (matched.length > 1) {
    warningCollector.push({ rowId, code: 'multi-gateway-match', ... });
  }
  const chosen = matched[0];                 // 仍取首个未消费的
  usedGwRowIdx.add(chosen.idx);              // ⭐ 标记已用
  // ... 写回 + record
});
```

| 维度 | 评分 |
|---|---|
| 改动量 | 最小（~5 行 diff） |
| 语义保留 | bank 侧仍是 forEach + 多匹配取首；与当前 first-match-wins 风格一致 |
| 是否对称 | **不对称** — bank 侧消费 gw，gw 不消费 bank；若同金额"银行 < 网关数量" → 多余 gw 被丢弃（符合预期，gw 本就不被写回） |
| smoke 覆盖 | 容易；可继承现有 C3 smoke 套件 |
| 资金风险 | 低 — 没有引入双向 tieBreak，行为可预测 |
| 局限 | 不做双向一致性校验；若 gw / bank 顺序敏感（rowIdx 决定 first），不同输入顺序结果不同 |

#### 方案 B：双向 1v1 + tieBreak（借鉴 C4 `tryOneToOne`）

```js
const pairedBank = new Set();
const pairedGw = new Set();
for (const bankRow of bankRowsFiltered) {
  if (pairedBank.has(bankRow._rowId)) continue;
  const candidates = gwRowsFiltered.filter((g) =>
    !pairedGw.has(g._rowId) && gwMatchesBank(g, bankRow, reconFields)
  );
  if (candidates.length === 0) continue;
  if (candidates.length > 1) {
    // 反向校验：candidates[0] 回看 bank 侧未用行的匹配数 == 1，否则跳过
    const bestGw = candidates[0];  // 或加 tieBreak 选最优
    const reverseCandidates = bankRowsFiltered.filter((b) =>
      !pairedBank.has(b._rowId) && gwMatchesBank(bestGw, b, reconFields)
    );
    if (reverseCandidates.length !== 1 && reverseCandidates[0] !== bankRow) continue;
  }
  pairedBank.add(bankRow._rowId);
  pairedGw.add(candidates[0]._rowId);
  // ... 写回 + record
}
```

| 维度 | 评分 |
|---|---|
| 改动量 | 中（~30-40 行 diff，含 tieBreak helper） |
| 语义保留 | 双向 1v1 严格匹配；与 C4 `tryOneToOne` 风格一致（项目内已有成熟范式） |
| 是否对称 | 对称 — 任一侧不重用 |
| smoke 覆盖 | 中（需新增"完全等额 / 部分等额 / 单边多余"3 类用例 + 双向校验失败用例） |
| 资金风险 | 低 — 严格 1v1 + 双向校验，行为最稳健 |
| 局限 | 多对多场景下双向校验失败会跳过该行（与方案 A 的"首个匹配"行为不同；可能漏配） |

#### 方案 C：同金额分组 + zip 顺序配对（保守的批处理）

```js
// 先按 reconFields 值组成 groupKey
const groups = new Map();  // key = recon 值 hash → { bank: [...], gw: [...] }
bankRowsFiltered.forEach((b) => {
  const key = computeKey(b, reconFields);
  if (!groups.has(key)) groups.set(key, { bank: [], gw: [] });
  groups.get(key).bank.push(b);
});
gwRowsFiltered.forEach((g) => {
  const key = computeKey(g, reconFields);
  if (!groups.has(key)) return;
  groups.get(key).gw.push(g);
});
groups.forEach(({ bank, gw }) => {
  const n = Math.min(bank.length, gw.length);
  for (let i = 0; i < n; i++) {
    // 按入参顺序 zip 配对
    bank[i][assign.bankField] = gw[i][assign.gwField];
    modCollector.record(bank[i]._rowId, ...);
  }
});
```

| 维度 | 评分 |
|---|---|
| 改动量 | 中（~50-60 行 diff，重写主循环） |
| 语义保留 | 完全按金额分组 zip，与 first-match-wins 语义有差异（不再"每个 bank 各自 filter"） |
| 是否对称 | 对称 — 多余侧整批不参与 |
| smoke 覆盖 | 中（需补"多组等额混合""跨 reconFields 字段组合"用例） |
| 资金风险 | 中 — 改了主循环结构；分组 key 必须严格对齐（数值/字符串/精度都要稳） |
| 局限 | 与 C3 现有 "1 个 bank → 多 gw 取首条" 语义有断层；现有用户对 first-match-wins 形成肌肉记忆，可能误解 |

#### ✓ 用户拍板：方案 A（网关候选池标记已用）

| 项 | 推荐理由 |
|---|---|
| 改动量小 | 最契合 v2.1.7 patch 版本的"小步快跑"节奏 |
| 语义保留 | 仍保留 C3 现有 forEach + first-match-wins 主体结构，只补"已用标记"约束 |
| 资金风险可控 | smoke 覆盖范围窄（3 类核心用例 + 旧 smoke 全回归即可），不引入双向 tieBreak 不确定性 |
| 后续可升级 | 若实测发现"非对称配对漏匹配"，可在 v2.1.8 平滑升级到方案 B/C |

**方案 B / C 留作附录**：spec/tasks 不实施；若用户后续反馈方案 A 在某些场景下漏配，按 §7.2 方案 B/C 描述升级（B 在 v2.1.8 实现成本 ~1 天，C 重写主循环成本 ~1.5 天）。语义差异详见 §7.3 对比表。

### 7.3 旧/新语义对比表

| 输入场景 | 当前行为（v2.1.6） | 方案 A | 方案 B | 方案 C |
|---|---|---|---|---|
| 3 笔等额银行行 + 3 笔等额网关行（reconFields 全等） | B1/B2/B3 全部赋 G1 值 | B1←G1, B2←G2, B3←G3 | B1←G1, B2←G2, B3←G3 | B1←G1, B2←G2, B3←G3 |
| 3 笔等额银行行 + 5 笔等额网关行 | B1/B2/B3 全部赋 G1 值 | B1←G1, B2←G2, B3←G3；G4/G5 剩余 | 同左 | 同左 |
| 5 笔等额银行行 + 3 笔等额网关行 | B1-B5 全部赋 G1 值 | B1←G1, B2←G2, B3←G3；B4/B5 不命中 | 同左 | 同左 |
| 1 笔银行行 + 1 笔网关行（其余全无匹配） | B1←G1 | B1←G1 | B1←G1 | B1←G1 |
| 2 笔银行行（金额不同）+ 2 笔网关行（一一对应） | B1←G1, B2←G2 | B1←G1, B2←G2 | B1←G1, B2←G2 | B1←G1, B2←G2 |
| 2 笔银行行（B1.amount=100, B2.amount=200）+ 1 笔网关行（G1.amount=100） | B1←G1（B2 无匹配） | B1←G1（B2 无匹配） | B1←G1（B2 无匹配） | B1←G1（B2 无匹配） |

### 7.4 验收标准

| AC 编号 | 验收条件 |
|---|---|
| AC-F2-1 | smoke：3 笔等额银行 + 3 笔等额网关 → 3 笔银行各自命中 G1/G2/G3，无重复赋值 |
| AC-F2-2 | smoke：3 笔等额银行 + 5 笔等额网关 → 仅 3 笔银行命中，剩余 2 笔网关不参与（不写回） |
| AC-F2-3 | smoke：5 笔等额银行 + 3 笔等额网关 → 仅 3 笔银行命中，剩余 2 笔银行 unmatched（不命中、不抛错） |
| AC-F2-4 | smoke：reconFields 完全无匹配的银行行 → 不写回（与旧行为一致） |
| AC-F2-5 | warningCollector：multi-gateway-match 警告仅在仍有 ≥ 2 个未用候选时触发（不再因首笔已被消费而多次触发 multi-match） |
| AC-F2-6 | 真实数据手测（用户提供 v2.1.6 反例样本）→ 1v1 命中数明显多于 v2.1.6（具体数字由实测决定） |

### 7.5 风险与回归保护 🚨 资金红线

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🔴 **HIGH（资金红线）** | C3 是"银行对账单 ← 网关账单" 字段赋值的核心入口，1v1 改动影响 ReconciliationId 等关键字段写回；错配可能引起后续对账偏差 | ① tasks 必须含 smoke A-F 6 用例 ② PR 前用户提供真实数据集回测 ③ `/check-vars` 必跑 ④ 命中 `runC3Scenario` 函数（虽未在重要变量表，但 C3 是资金红线场景类别） |
| 🟡 中 | 行号 / `ensureRowId` 顺序不确定时，配对顺序结果不稳定 | smoke 必须验证 "输入顺序固定 → 输出顺序固定"；如方案 B 的双向校验需用 deterministic tieBreak（参考 C4 `pickBestByTieBreak`） |
| 🟢 低 | warningCollector 提示文案变化 | confirm 文案与 USER_GUIDE 需补"1v1 配对"说明（发布前一次性更新文档三件套） |

⚠️ **重要变量检查**：F2 修改 `runC3Scenario`（不在重要变量表，但属于资金红线 C3 引擎入口）；建议本迭代结束 `/check-vars` 时**评估升格 `runC3Scenario` 进 Risk-sensitive 层**（同类 `runC2Scenario` / `runC4Scenario` 都该升格统一管控）。

---

## 八、F3 — 大账号确认页"单个账号匹多个文件"勾选后文件名只剩 "PP..."

### 8.1 背景与现状

#### 8.1.1 用户反馈 + 截图佐证

- 用户原话："网银账单解析大账号确认页面，勾选'单个账号匹多个文件'时，文件顺序里的文件名会缩成文本'……'"
- 用户后续提供截图：左侧"文件顺序"区，每行卡片**纵向 box 是正常大小**（约 60-80px 高），但**底部居中只显示"PP..."三个字符**（前两字符 + 省略号）
- 复现路径：网银账单生成主模块 → 上传多个文件（一般业务文件名形如 `PPHK-XXX-MMDD-NNN.xlsx`，30-40 字符长串）→ "确认大账号" → 勾选"单个账号匹多个文件" → 进入编辑态完成分组（grouped）→ 文件名只剩 "PP..."

#### 8.1.2 根因分析（用户截图后定位精确）

**根因 = CSS flex 子项缺 `min-width:0`**：

| # | 事实 | 位置 |
|---|---|---|
| 1 | `.big-account-file-item` 是 flex 容器 | `src/styles.css:1008-1013` |
| 2 | flex item 默认 `min-width: auto`（= 内容原始尺寸）—— **不会因父容器挤压而让位** | CSS 规范行为 |
| 3 | grouped 行结构：`[✓ marker] + [a. letter] + [meta 文件名→大账号]` 3 个 flex 子项；marker + letter 各占 ~20-30px 固定宽度 | `src/renderer-dialogs.js:1028-1038` |
| 4 | meta 子项内容 = `${displayName} → ${merchantId} ${currency}` —— 经 JS truncateFileName 截到 19 字符 + `→ XXX USD` 后缀 ≈ 30-35 字符 ≈ 250-300px | `src/renderer-dialogs.js:1037` |
| 5 | 容器 `.big-account-split-left` 实际宽度 ~536px（弹窗 1100px × 1/2 grid - padding）| `src/styles.css:969-983` |
| 6 | meta 子项**理论需要 300px** 但 flex 计算把它压到 ~30-40px（marker + letter + gap 优先）→ `text-overflow:ellipsis` 触发 → 仅显示 "PP..." | `.big-account-file-meta:1022-1027` |

**用户感知**："PP..." = `PPHK-X` 截到 2 字符 + `...` ellipsis。**不是 JS truncateFileName bug，不是 double-escape**。

#### 8.1.3 为什么非 multiMode 时不出问题

- 非 multiMode 行结构仅 `[数字序号 1.] + [meta 文件名]` 2 个子项；meta 子项可用宽度 ~480px，足够显示 20 字符截断后的文件名 → 不触发 ellipsis 收缩

### 8.2 影响范围

- 样式：`src/styles.css`（`.big-account-file-meta` 加 `min-width:0` + `flex:1 1 auto`）
- 样式：`src/styles-gemini-extra.css`（`.ba-file-name` 同步）
- 可选：`src/renderer-dialogs.js`（如保留 JS 截断，可考虑提阈值 / 改首尾保留策略）
- DB：无
- 兼容性：无影响（纯 CSS 修复 + 可选 JS 微调）

### 8.3 设计方案

#### 方案 A（推荐）：CSS 修复 — `.big-account-file-meta` / `.ba-file-name` 加 `min-width:0 + flex:1 1 auto`

```css
/* src/styles.css:1022-1027 现状 */
.big-account-file-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

/* 修复后 */
.big-account-file-meta {
  min-width: 0;       /* ⭐ flex 子项可缩小 */
  flex: 1 1 auto;     /* ⭐ 主轴占满剩余空间 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
```

同样在 `src/styles-gemini-extra.css:411-416` `.ba-file-name` 加 `min-width:0`。

**效果**：grouped 状态 meta 子项 = 容器宽 - marker - letter - gap ≈ 500px → 不会触发 ellipsis，完整显示"truncated 文件名 → 大账号"。

#### 方案 B（兜底）：JS 截断保留首尾段

如果某些极长文件名（如 `PPHK-INTERNATIONAL-XXX-LONGCODE-20240520-001.xlsx`）即使 500px 宽度仍超过 → ellipsis 兜底；JS `truncateFileName` 已有"首 6 字符 + ... + 末 10 字符"逻辑（`renderer-dialogs.js:946-952`），保留即可，**无需改 JS**。

#### tooltip 兜底（已就绪，无需新增）

- 行结构里 `meta.title = fullMeta` 已存在（`renderer-dialogs.js:1020, 1036, 1051`），hover 文件名行原生 tooltip 显示完整文件名 + 行号信息 —— 用户截图证据未否定此行为；F3 不改 tooltip 链路。

**推荐方案 A**（CSS 2 个属性 + 跨文件同步 ≤ 5 行 diff）；方案 B 留作"极长文件名兜底"，本次不动 JS。

### 8.4 验收标准

| AC 编号 | 验收条件 |
|---|---|
| AC-F3-1 | 不勾"单个账号匹多个文件" → 文件名显示与 v2.1.6 完全一致（regression baseline） |
| AC-F3-2 | 勾"单个账号匹多个文件" + 编辑态 → 文件名能完整显示（如 `PPHK-X...0520-001 → MERCH123 USD`），不显示纯 "PP..." |
| AC-F3-3 | 勾"单个账号匹多个文件" + 完成（grouped 闭合态）→ 同上 |
| AC-F3-4 | 鼠标 hover 文件名行 → tooltip 显示完整文件名 + 行号信息（沿用现有 `meta.title = fullMeta` 行为） |

### 8.5 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | `min-width:0` 影响非 multiMode 行的视觉 | 非 multiMode 行结构是 `[数字 1.] + [meta]`，meta 同样加 min-width:0 后行为不变（容器够宽，不会触发 ellipsis） |
| 🟢 低 | 极长文件名（> 100 字符）仍可能触发 ellipsis | 保留现有 JS truncateFileName 兜底 + tooltip 显示完整 |
| 🟢 低 | 跨样式文件遗漏（同名 `.big-account-file-meta` 在 styles-gemini.css 副本里也存在） | spec 阶段必须 grep `big-account-file-meta\|ba-file-name` 全量改完 |

⚠️ **重要变量检查**：F3 不命中 `rules/important-variables.md` 任何条目（纯 UI bug）。

⚠️ **previews 必须回归**：本改动涉及 CSS + 大账号 dialog 渲染，按 memory `workflow_frontend_previews` 必须重跑相关 `npm run preview:*`（覆盖 multiMode 启 / 关 2 张截图）。

---

## 九、F4 — 账单打标 改名为 银行对账单字段赋值

### 9.1 背景与目标

- **背景**：原名"账单打标"业务语义不够直观，用户希望改为更准确的"银行对账单字段赋值"。同时新增场景默认值清空（避免预填示例行误导）。
- **目标**：
  - UI 展示名全量替换（5 处代码 + 3 处文档）
  - "打标值" 行 label 改"赋值"（4 处含校验文案 + 1 处 confirm 预览）
  - 新增场景时账单类型 / 对账字段默认空（不预填示例 2 行 + 1 行）
- **明确不动**：DB `scenarios.category` 字段值 `'offset-bill-mark'`（不破坏历史 scenario 配置 + 不需要 migration）

### 9.2 影响范围

#### 9.2.1 代码改动（dialog + 校验 + 引擎 + 预览）

| 文件:行号 | 现状 | 目标 |
|---|---|---|
| `src/renderer-dialogs.js:5392` | `'offset-bill-mark': '账单打标'` | `'offset-bill-mark': '银行对账单字段赋值'` |
| `src/renderer-dialogs.js:5641` | `{ value: 'offset-bill-mark', label: '账单打标' }` | `{ value: 'offset-bill-mark', label: '银行对账单字段赋值' }` |
| `src/renderer-dialogs.js:5709-5717` | C2 默认 config：billTypes 2 行 / reconFields 1 行 / markValue 已含 type | **默认空**：`billTypes: []` / `reconFields: []` / `markValue: { type: null, field: '', value: '' }` |
| `src/renderer-dialogs.js:5832` | `if (!Array.isArray(c.billTypes) \|\| c.billTypes.length < 2) errors.push('账单类型至少需要 2 行')` | **改 < 1**：`if (!Array.isArray(c.billTypes) \|\| c.billTypes.length < 1) errors.push('账单类型至少需要 1 行')`（用户拍板） |
| `src/renderer-dialogs.js:5836` | `if (!Array.isArray(c.reconFields) \|\| c.reconFields.length === 0) errors.push('对账字段至少需要 1 行')` | **删除此行**：对账字段允许 0 行（用户拍板，但保留下面 `r.leftField/rightField 非空` 校验对非空行） |
| `src/renderer-dialogs.js:5840-5842` | `'打标值的"账单类型"必须存在...'` / `'打标值的字段不能为空'` / `'打标值的写入值不能为空'` | `'赋值的"账单类型"必须存在...'` / `'赋值的字段不能为空'` / `'赋值的写入值不能为空'` |
| `src/renderer-dialogs.js:6585-6593` | dialog 入口 `if (!Array.isArray(config.billTypes) \|\| config.billTypes.length < 2)` → 强补 2 行 / reconFields < 1 → 强补 1 行 | **完全删除强补逻辑**：首次打开 dialog 时 billTypes / reconFields 都空（与 5709-5717 默认配置一致） |
| `src/renderer-dialogs.js:6629` | `<span class="scenario-config-label">打标值</span>` | `<span class="scenario-config-label">赋值</span>` |
| `src/renderer-dialogs.js:7544` | `'打标：'` → `'类型#${mv.type} 的 ${field} 写入 "${value}"'` | `'赋值：'` → 同结构 |
| `src/main-process/scenario-engines/c2-offset-bill-mark.js:60-71` | `if (billTypes.length < 2) { warning('账单类型至少需要 2 行（PRD §7.2）'); return }` | ⚠️ **改为 < 1**：`if (billTypes.length < 1) { warning('账单类型至少需要 1 行'); return }` |
| `src/main-process/scenario-engines/c2-offset-bill-mark.js:72-83` | `if (reconFields.length === 0) { warning('对账字段至少需要 1 行'); return }` | ⚠️ **删除此卡校验** + 引擎需支持 "0 reconFields = 无条件赋值" 语义（详 §9.5 衍生待澄清） |

#### 9.2.2 文档改动（仅新版本段）

| 文件 | 改动 |
|---|---|
| `docs/USER_GUIDE.md:553` | "账单打标（C2）：..." → "银行对账单字段赋值（C2）：..."（**仅当前章节**；历史发版日志段保留旧名） |
| `docs/VERSION_FEATURE_HISTORY.md` | 新增 v2.1.7 段："C2 场景类别展示名调整 + 校验放宽（账单类型 ≥ 1、对账字段允许 0 行）（DB category 'offset-bill-mark' 保持不动）" |
| `CHANGELOG.md` | 新增 v2.1.7 段：同上 |
| `docs/iterations/v2.1.6/PRD-v2.1.6.md` | 不动（历史 PRD） |

#### 9.2.3 不动的部分（DB 兼容 + 注释）

- DB：`scenarios.category` 字段值、CHECK 约束、migration 内置场景 category 字符串 — **全部不动**
- 引擎文件名 `c2-offset-bill-mark.js` + 函数名 `runC2Scenario` — **不动**（与 category 字符串保持映射稳定；仅放宽内部校验）
- 引擎注释顶部 PRD §7.2 引用 — **同步更新**为本 PRD §九（spec 阶段处理）
- preview 截图：本次预览需更新 C2 dialog 截图（含新展示名 + 默认空状态）

### 9.3 验收标准

| AC 编号 | 验收条件 |
|---|---|
| AC-F4-1 | 场景管理弹窗"功能类别"列显示"银行对账单字段赋值"（替代"账单打标"） |
| AC-F4-2 | 新增场景类别选择下拉框选项显示"银行对账单字段赋值" |
| AC-F4-3 | 新增 C2 场景时 dialog 打开 → 账单类型行 0 条（无预填）、对账字段行 0 条（无预填）、"赋值"label 显示 |
| AC-F4-4 | dialog 校验：billTypes 0 行 → 报"账单类型至少需要 1 行"；billTypes 1 行通过；reconFields 0 行通过；reconFields 有行但 leftField/rightField 空 → 报错（沿用旧行为） |
| AC-F4-5 | 校验报错文案："赋值的'账单类型'必须存在..." / "赋值的字段不能为空" / "赋值的写入值不能为空"（3 处） |
| AC-F4-6 | 修改老 v2.1.6 已存在的 'offset-bill-mark' 场景（billTypes 2 行）→ dialog 能正常加载、显示新 label，校验照常通过 |
| AC-F4-7 | DB `scenarios.category` 字段值仍为 `'offset-bill-mark'`（grep `'offset-bill-mark'` src/ 命中点不变） |
| AC-F4-8 | 引擎 smoke：1 行 billType + 1 行 reconFields + markValue → 配对成功正常打标（旧 2+ billTypes 用例仍通过） |

### 9.4 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | C2 引擎放开 billTypes ≥ 1 + reconFields = 0 后，**单 billType 0 reconFields 的语义未定义**（详 §9.5） | spec 阶段必须落定衍生方案，否则 dialog 通过但 engine return 0 行修改的"假成功"会让用户困惑 |
| 🟢 低 | 改名后用户找不到（心智模型还停留在"账单打标"） | CHANGELOG / USER_GUIDE 显式说明改名 |
| 🟢 低 | 漏改某处旧名 | grep `账单打标\|打标值\|打标` 全文核对 + 校验文案 3 处全改 |
| 🟢 低 | 老 scenario（billTypes 已是 2 行）行为变化 | 引擎放开 ≥ 1 是**向下兼容**（≥ 2 自动也满足 ≥ 1）；旧用例不受影响 |

### 9.5 ⚠️ 衍生待澄清项：C2 引擎单 billType + 0 reconFields 的语义

**问题来源**：用户拍板"账单类型 ≥ 1 + 对账字段允许 0 行"，但 C2 引擎原本设计是**双 billType 笛卡尔配对**（leftType × rightType，按 reconFields AND 全等）。如下场景未定义：

| 输入 | 当前引擎（v2.1.6） | F4 放开后期望行为？ |
|---|---|---|
| billTypes = 1 行 + reconFields = 0 行 | 不跑（≥ 2 + ≥ 1 校验拒绝） | **待定** |
| billTypes = 1 行 + reconFields ≥ 1 行 | 不跑（≥ 2 校验拒绝） | **待定**（自己 vs 自己配对没意义） |
| billTypes = 2 行 + reconFields = 0 行 | 不跑（≥ 1 reconFields 校验拒绝） | **待定**（双类型但无配对字段） |
| billTypes = 2+ 行 + reconFields ≥ 1 行 | 正常笛卡尔配对（旧行为） | 不变 |

**可选语义方案**（PM 建议 spec 阶段拍板）：

- **方案 A**：单 billType + 0 reconFields = "无条件赋值"（凡是命中此 billType 的行直接写 markValue.field = markValue.value，不做配对）；2+ billTypes 仍走原配对逻辑
- **方案 B**：单 billType + 任意 reconFields = 引擎不跑 + warning（让用户必须配 2 个 billType）；放开校验**仅为后续 v2.1.8 扩展预留**，本次实际不解锁新场景
- **方案 C**：完整支持 1×0 / 1×N / 2×0 / 2×N 四种组合（最复杂，需重设计引擎主循环）

**PM 推荐**：**方案 A**（用户原意更接近"我想做无条件赋值，所以才要求允许 0 reconFields"），但**留 §15 待澄清让用户拍板**。

⚠️ **重要变量检查**：F4 不命中 `rules/important-variables.md` 任何条目（纯重命名 + UI 默认值 + 引擎校验放宽）；建议本迭代结束 `/check-vars` 时**评估升格 `runC2Scenario` 进 Risk-sensitive 层**（与 F2 推荐的 `runC3Scenario` / 已有的 `runC4Scenario` 对齐）。

⚠️ **previews 必须回归**：C2 dialog 视觉变化（label / 默认空状态），需更新对应 preview screenshot。

---

## 十、F5 — ⏸ 延期 v2.1.8 详细讨论

### 10.1 用户决策（2026-05-20）

**F5 整体延期到 v2.1.8 详细讨论**。本迭代 v2.1.7 不实施 BillDate 字符串化 + 算法重设。

### 10.2 延期理由（基于用户提供 TEST2.xlsx 期望基线证据）

| 维度 | 数据 |
|---|---|
| **用户期望基线**（TEST2.xlsx `订单修复` sheet） | **57 行修复 / 10 渠道命中**；最大子集 16 行（T54SWIC494447 = 9,751,101）|
| **F5 单点 fix 后实测**（BillDate 字符串化 + ±5 天）| **28 行 / 9 渠道命中** |
| **差距** | **29 行 / 1 渠道** |
| **现状无 fix 实测** | 0 行修复 / 77 行 unmatched |

### 10.3 差距根因（v2.1.8 spec 待详细评审）

1. **BillDate 数字日期解析**：`recon-id-fix-io.js:70` 用 `raw:true` 读 sheet，渠道 `createTime` 列是 Excel 真"日期"格式 → 出来是 number（46148.xx 序列号）→ `c4-recon-id-fix.js:1058-1065` gateway 映射段把 number 直接赋给 BillDate → `parseBillDateMs` 正则只认 `^(\d{4})[-/](\d{1,2})[-/](\d{1,2})` → 全部候选 fail。**单点 fix 可解（28 行）但不够达到 57 行**
2. **maxSize=8 硬上限**：`c4-recon-id-fix.js:findBestAmountSubset` 的 subset-sum 候选池 maxSize 硬限制 = 8；16 行子集（T54SWIC494447）+ 11 行子集（T54SWIC506630）被剪掉
3. **manyToOne 遍历顺序偏置**：`tryManyToOnePool` 按 right 行顺序消费 left 池子；T54SWIC470181 的 4M 因 1M 子池被前面渠道抢光而失败
4. **窗口扩大反而下降**：PM 实测 ±7/±10 命中数从 19/17 降回（candidates 过多导致 tie-break 在大池子里偏好"日跨度紧凑"的解，反而抢走"原本只能配上"的子集）

### 10.4 v2.1.8 PRD 应包含的内容（PM 留给下任 PM 的提示）

1. **算法重设范围**：放开 maxSize + 改 manyToOne 遍历顺序（按"子集大小降序"或"金额降序"）+ 评估 currency 字段过滤增强精度
2. **资金红线评审**：subset-sum 改 maxSize 涉及性能与正确性 trade-off，必须有专门设计评审 + 多轮 smoke
3. **回归保护**：v2.1.6 现有 business + gateway smoke 全套不得破坏；用户提供的 ADM TEST2.xlsx 作为期望基线证据
4. **实施工期**：根据 PM 当前评估 ≥ 1 周
5. **TEST 数据归档**：
   - TEST.xlsx（v2.1.6 实测 0 命中样本）
   - TEST2.xlsx（用户提供 `订单修复` sheet 含 57 行期望基线）
   - 路径：`/Users/pzhong/Desktop/小助手-Debug/2.1.7/`

### 10.5 v2.1.7 范围对 F5 的处理

| 维度 | 处理 |
|---|---|
| 代码改动 | **零** —— 不动 `recon-id-fix-io.js` / `c4-recon-id-fix.js` / `parseBillDateMs` |
| 文档 | CHANGELOG / VERSION_FEATURE_HISTORY 不写 F5；USER_GUIDE 不动 |
| smoke | 不新增 F5 用例；v2.1.6 现有 C4 smoke 仍跑（regression 保护，确保本迭代 5 项不误伤 C4） |
| previews | 不涉及 |
| 重要变量 | 不动 |
| 风险评估 | F5 延期**不增加风险**（v2.1.6 现状用户已知不达期望，延期是知情决策）|

### 10.6 v2.1.8 立项预告（F5 + A3 联合主题）

v2.1.8 主题双线绑定，PR 草稿与 spec 评审必须**联合处理**：

| 编号 | 范围 | 性质 | 工期预估 |
|---|---|---|---|
| **F5** | C4 manyToOne 算法重设：放开 `findBestAmountSubset` maxSize 硬上限 + 改 manyToOne 遍历顺序（按"子集大小降序"或"金额降序"）+ 评估 currency 字段过滤增强精度 | 资金红线 + 算法重设 | ~1 周 |
| **A3** | 把 `acquiring-bill-currency-session.runCheck` 整体搬到 worker_threads（或 Electron utilityProcess），彻底解除主进程 SQL 阻塞 | 架构级（IPC 桥接 + 数据序列化 + 错误传播 + 进度回调跨进程） | ~1-1.5 周 |

**联合处理理由**：

- F5 + A3 都涉及"长耗时 SQL JOIN 性能问题"的不同维度：F5 是**算法正确性**（57 行期望达成），A3 是**主进程不阻塞**（彻底解除"无响应"弹窗）
- v2.1.7 F7-A1（PRAGMA）+ F7-A2（索引）+ F7-B1（Notification）是**短期缓解**，预计能把 unresponsive 概率降低 30-50%；A3 才是**根本解**
- 联合评审能在 v2.1.8 spec 阶段一次性解决"performance + correctness + UX"三维度

**v2.1.8 PRD 必须包含**：

1. F5 算法重设范围细化（spec §10.4 PM 已留下 4 点提示）
2. A3 worker 架构设计：
   - 用 worker_threads（Node 原生）还是 Electron utilityProcess（更深整合 Electron 生命周期）—— 二选一拍板
   - SQL 在 worker 内重新打开 DB 连接（worker_threads 无法共享 DatabaseSync 实例）
   - 进度回调跨进程：worker 通过 postMessage → main → renderer（IPC 链路扩 1 跳）
   - 错误序列化：worker 抛错不能直接跨进程，需 message 包装
3. F5 + A3 联合资金红线评审：算法改 + 跨进程数据流改，PR 必须有专门 reviewer
4. 回归保护：v2.1.7 现有 19 个 smoke suite + v2.1.8 新增 worker smoke
5. TEST 数据归档：TEST.xlsx + TEST2.xlsx 仍是基线证据

**v2.1.7 不开始 v2.1.8 任何代码**，仅在本 PRD §十备注预告，避免 spec 阶段提前展开评审。

---

## 十一、F6 — 收单单据币种校验模块：状态框运行进度显示

### 11.1 背景与现状

#### 11.1.1 用户反馈

- 用户原话："'收单单据币种校验'模块的状态框在导入文件过程需显示当前进行的状态，比如『正在导入 xxxxx.xlsx 文件 (11/16 个文件)』类似文字；点击开始运行后，状态框需要显示当前对账运行的状态"
- 痛点：v2.1.6 收单币种校验对 500w × 2 行级数据需 8-15 分钟（含 inlineStr 流式解析 + SQL JOIN + xlsx 写盘），当前状态框只显示一次"正在导入..."/"正在对账..."直到 IPC return，**用户全程无反馈，难以判断"卡死/正常"**。

#### 11.1.2 现状画像（PM 读代码确认）

| 层 | 文件 | 现状 | F6 需要做什么 |
|---|---|---|---|
| **session.js（已就绪）** | `acquiring-bill-currency-session.js:41-76, 88-130` | `importFilesInTransaction` / `importFilesWithOverwrite` 完整支持 `onProgress({ stage, fileIndex, fileCount, filePath, importedCount })` 回调，每文件切换 + reader 内每 10000 行触发 | **不动** — 链路已就绪 |
| **reader.js（已就绪）** | `acquiring-bill-currency-import/reader.js:371-373` | `if (onProgress && importedCount % 10000 === 0) onProgress({ sourceFile, importedCount })` | **不动** — 节流粒度已合适 |
| **session.runCheck（待补）** | `acquiring-bill-currency-session.js:163-237` | 无 `onProgress` 入参；5 个阶段无回调埋点 | 加 `onProgress` 入参 + 5 阶段埋点（详 §11.3.2） |
| **main.js handler（待补）** | `main.js:10119-10126, 10182-10187, 10219` | `sessionImport` / `runCheck` 调用时**没传 onProgress** | 3 处都改为 `onProgress: (ev) => event.sender.send('acquiringBillCurrency:{import,run}:progress', ev)` |
| **preload.js（待补）** | `preload.js:265-273` | acquiringBillCurrency 命名空间下 7 个 invoke channel，**无任何订阅 API** | 新增 `onImportProgress(listener)` / `onRunProgress(listener)` 两个订阅接口 |
| **renderer.js（待补）** | `renderer.js:4276-4377` | `runAcquiringBillCurrencyImport` / `handleAcquiringBillCurrencyRun` 进入 handler 后仅 setStatus 一次静态文本，直到 IPC return | 进入 handler 前订阅 progress 事件 → 收到事件刷新文案 → IPC return 后取消订阅 |
| **现成范式可借鉴** | `main.js:9504-9523` + `preload.js:206-227` | `pending:import:progress` 通道已是项目成熟范式：`webContents = event.sender` + `webContents.send('pending:import:progress', ev)` + preload `ipcRenderer.on(...)` | **F6 直接 1:1 复制此范式**，仅改 channel 名 |

#### 11.1.3 PM 关键发现

**session 层进度回调链路已 100% 就绪**（v2.1.6 设计时就考虑到了进度提示），但 main.js 三处 handler **从未传入 onProgress** —— 整条链路是"开了路但没接电"。**F6 是接通现成链路 + 复制现成 IPC 范式 + 渲染端订阅**，不是从零造轮子。

### 11.2 影响范围

- 后端 session：`src/main-process/acquiring-bill-currency-session.js` — `runCheck` 加 onProgress 入参 + 5 处埋点
- 后端 main：`src/main.js` — 3 处 handler（importFlow / importBill / run）补 onProgress 桥接
- preload：`src/preload.js` — 新增 2 个订阅 API
- 前端 renderer：`src/renderer.js` — 2 个 handler 函数订阅 progress 事件 + 文本格式化 helper
- DB：**无**
- 兼容性：纯增量 — 老业务逻辑路径完全不变；进度事件**不参与业务正确性判定**（即使丢事件也只是 UI 提示不更新，不影响导入/对账结果）

### 11.3 设计方案

#### 11.3.1 IPC 通道命名

- 导入进度：`acquiringBillCurrency:import:progress`
- 运行进度：`acquiringBillCurrency:run:progress`

（命名对齐 `pending:import:progress` 范式 — `<namespace>:<phase>:progress`）

#### 11.3.2 progress 事件 payload schema

**导入阶段**（沿用 session 现有签名 + main.js 不再二次包装）：

```js
// 每文件切换触发
{ phase: 'import', stage: 'reading', fileIndex: 0, fileCount: 16, filePath: '/abs/path/xx.xlsx' }
// reader 内每 10000 行触发
{ phase: 'import', stage: 'inserting', fileIndex: 0, sourceFile: 'xx.xlsx', importedCount: 30000 }
```

**运行阶段**（F6 新增 — runCheck 5 阶段埋点）：

```js
{ phase: 'run', stage: 'clearing-old-runs' }       // runRepo.clearRunsByMonth 前
{ phase: 'run', stage: 'computing-stats' }         // runRepo.computeRunStats 前
{ phase: 'run', stage: 'inserting-run' }           // runRepo.insertRun 前
{ phase: 'run', stage: 'sql-joining', mismatchHint: <可选>}  // runRepo.insertDiffRowsByJoin 前
{ phase: 'run', stage: 'writing-xlsx', segmentIndex?: i, segmentCount?: n }  // writer.writeRunOutputs 前 / writer 内分 sheet 写
{ phase: 'run', stage: 'updating-paths' }          // runRepo.updateRunPaths 前
```

#### 11.3.3 渲染端文案模板（用户原话风格）

| stage | 文案 |
|---|---|
| `reading` | `正在导入 {sourceFile}（{fileIndex+1}/{fileCount} 个文件）` |
| `inserting` | `正在写入 {sourceFile}：已读取 {importedCount.toLocaleString()} 行（{fileIndex+1}/{fileCount} 个文件）` |
| `clearing-old-runs` | `正在清理该月旧 run 数据...` |
| `computing-stats` | `正在统计行数（{monthKey}）...` |
| `inserting-run` | `正在创建 run 记录...` |
| `sql-joining` | `正在做 SQL JOIN 比对币种...` |
| `writing-xlsx` | `正在写入差异表 Excel{ (sheet {i}/{n}) 可选段 }...` |
| `updating-paths` | `正在回填文件路径...` |
| `complete`（IPC return） | （原有 `对账完成（{monthKey}）：共 X 条，币种差异 Y 条，未匹配 Z 条` 文案不变） |
| `error`（IPC return） | （原有 `对账失败：{message}` 文案不变） |

#### 11.3.4 节流方案（性能）

| 层 | 节流策略 |
|---|---|
| reader.js → session.js | **已有** — `importedCount % 10000 === 0` 才触发 |
| session.js → main.js | **无需节流** — 上游 reader 已节流 |
| main.js → renderer（IPC） | **建议加 100ms 时间窗口节流**（合并高频事件）— main.js handler 内维护 `lastSentAt` 时间戳，距上次 send < 100ms 的事件**仅保留 stage 切换**事件，importedCount 累加事件丢弃 |
| renderer.js setAcquiringBillCurrencyStatus | **无需节流** — DOM textContent 更新成本可忽略 |

**节流落点拍板**：建议**在 main.js handler 层**做 IPC 节流（最易实现 + 不污染 session 通用层）。spec 阶段最终确定。

#### 11.3.5 边界处理

| 场景 | 行为 |
|---|---|
| 用户切换模块离开收单币种校验面板 | 仍订阅着事件 → renderer 收到事件但 statusBox 元素已 hidden → setStatus 仍执行（无副作用）；推荐 renderer 在 handler return 后**取消订阅**（保留 listener 引用 + ipcRenderer.removeListener）|
| 运行期间用户重叠点击其他模块 | 现有 `acquiringBillCurrencyOperationLock` 已防并发，F6 不引入新锁 |
| 进度事件传输失败 | `webContents.send` try/catch 吞掉错误（参考 `main.js:9520`）；不影响业务流程 |
| `success-no-files` 状态（runCheck 写盘失败但 DB COMMIT 成功）| runCheck 已抛错；最后一次进度事件可能停在 `writing-xlsx` 阶段；renderer 收到 IPC return 错误后用现有错误文案覆盖（行为不变） |

### 11.4 验收标准

| AC 编号 | 验收条件 |
|---|---|
| AC-F6-1 | 导入 16 个 xlsx 文件（500w 行级别）时，状态框文本至少切换 16 次（每文件切换至少 1 次「正在导入 xxx (i/16 个文件)」）|
| AC-F6-2 | 单文件导入过程中，状态框文本至少每 10000 行更新一次「正在写入 xxx：已读取 N 行」（reader 节流已保证）|
| AC-F6-3 | 点击「开始运行」后，状态框依次显示「清理旧 run」/「统计行数」/「SQL JOIN」/「写入 Excel」/「回填路径」5 阶段文本（顺序可见，不是直接卡在静态文本）|
| AC-F6-4 | 导入 / 运行成功后状态框最终文案与 v2.1.6 完全一致（如 `对账完成（YYYY-MM）：共 X 条...`）— 不破坏现有结尾提示 |
| AC-F6-5 | 失败路径（如表头错误 / OOM）状态框最终文案与 v2.1.6 完全一致 — 不破坏现有错误提示 |
| AC-F6-6 | 其它 7 个模块（网银账单生成 / 月度Pending / 业务OP / ... / 月度银行对账单BU回填）状态框不受影响（IPC 事件命名空间隔离）|
| AC-F6-7 | 节流：单次 import 流程中 IPC 事件总数 ≤ `fileCount × (1 + ceil(rowPerFile / 10000))`（不超过 reader 节流上限）|

### 11.5 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | IPC 高频事件拖慢主流程（每事件 IPC 序列化开销 ~0.1-1ms）| reader 已 10000 行节流；main.js handler 层再加 100ms 时间窗口节流；smoke 量级回归（用 v2.1.6 500w 行测试样本对比 F6 前后 totalElapsedMs 不应增长 > 5%）|
| 🟡 中 | renderer 未及时取消 progress listener 导致内存泄漏（每次 handler 调用都 `ipcRenderer.on` 累积）| renderer handler 在 try/finally 的 finally 块**显式 removeListener**；spec 必须明确 listener 引用管理 |
| 🟢 低 | session.runCheck 加 onProgress 参数后老 caller 不传 → 行为应与现状一致 | onProgress 默认值 `undefined`；session 内每处埋点都 `if (onProgress) onProgress({...})` 守护（参考 import 流程现有写法） |
| 🟢 低 | webContents.send 在窗口已销毁时抛错 | 复用 `main.js:9520` 的 try/catch swallow 写法 |
| 🟢 低 | 收单单据币种校验本身的资金红线（settle_currency_norm 比对 / mismatch_rows 计数 / cleanup 逻辑）| F6 **不改任何业务逻辑**；仅在 session.runCheck 函数内补 5 处 `if (onProgress) onProgress(...)` 守护语句，不修改任何已有数据流 |

⚠️ **重要变量检查**：F6 修改的 `runCheck` 函数本身不在 `rules/important-variables.md`（其引用的 `runRepo.insertDiffRowsByJoin` 等已升格 Critical 级，但 F6 不动这些）；建议本迭代结束 `/check-vars` 时**不升格新条目**（纯 UX 增强，无契约/资金/迁移红线命中）。

⚠️ **previews 不强制回归**：F6 仅改运行时状态框文本（动态展示），preview screenshot 默认走初始状态文案（"欢迎使用小助手"），与 v2.1.6 一致；除非用户明确要求新增"运行中"状态的 preview。

---

## 十二、F7 — 收单单据币种校验 SQL 调优 + 完成系统通知

### 12.1 背景与目标

#### 12.1.1 用户反馈 + 现状

- F6 加 `await setImmediate` 后 stage 1-4（clearing-old-runs / computing-stats / inserting-run / sql-joining）文案能依次到达
- 但 stage 4 `insertDiffRowsByJoin`（`run-repository.js:65-85`）仍是**单条大同步 SQL JOIN**（INSERT … SELECT … FROM bill INNER JOIN flow），event loop 不会让出
- i5-1135G7 + SATA SSD + 真实数据下 macOS 仍会显示"应用无响应"（事件循环阻塞 ≥ 5s → AppKit 触发 unresponsive 弹窗）

#### 12.1.2 目标（v2.1.7 内最小缓解，不动架构）

- **A1**：PRAGMA 全局应用，3 套业务引擎都受益（bank-bu-recon / biz-op-recon / acquiring-bill-currency）
- **A2**：索引兜底（writer 阶段加 source_file 索引 + ANALYZE 刷新统计）
- **B1**：runCheck return 成功/失败时弹 Electron 原生 Notification —— 即使 UI 显示无响应，用户也能从通知中心/任务栏感知"任务已完成/失败"

#### 12.1.3 明确不做（留 v2.1.8）

- **A3 worker_threads / utilityProcess**：把 SQL JOIN 整体搬到子进程彻底解除主进程阻塞 —— 架构级变更，详 §10.6
- **A4 SQL 分批跑**：chunked LIMIT/OFFSET 批跑 —— 与 worker 方案冲突，留 v2.1.8 统一决策

### 12.2 影响范围

| 子任务 | 改动文件 | 改动量 |
|---|---|---|
| A1 PRAGMA | `src/backend/database.js`（紧贴 L42 现有 foreign_keys 之后追加 4 条 PRAGMA）| ~6 行 diff |
| A2 索引 | `src/backend/database/migrations.js`（新增 source_file 索引 + 启动 ANALYZE）| ~15 行 diff |
| B1 Notification | `src/main.js:6`（destructure 加 `Notification`）+ `src/main.js:10218附近`（runCheck handler return 前 2 处）| ~20 行 diff |
| 文档 | `docs/USER_GUIDE.md` 提一句 WAL 旁文件（备份 DB 需 3 个文件）| ~3 行 |

### 12.3 设计方案

#### 12.3.1 A1 — PRAGMA 全局应用（`src/backend/database.js:42` 现有 foreign_keys 之后）

```js
// 现状（L41-42）
this.db = new DatabaseSync(this.dbPath);
this.db.exec('PRAGMA foreign_keys = ON;');

// 改后（追加 4 条）
this.db = new DatabaseSync(this.dbPath);
this.db.exec('PRAGMA foreign_keys = ON;');
// v2.1.7 F7-A1：全局 SQL 调优 — 所有 3 套业务引擎受益
this.db.exec('PRAGMA journal_mode = WAL;');        // 读写并发更好，崩溃恢复保留
this.db.exec('PRAGMA synchronous = NORMAL;');      // WAL 模式下安全，性能 2-3 倍
this.db.exec('PRAGMA cache_size = -65536;');       // 64MB 页缓存（负数 = KB 单位的倒数，-65536 = 65536KB = 64MB）
this.db.exec('PRAGMA mmap_size = 268435456;');     // 256MB 内存映射，SATA SSD 顺序读受益
```

**关键不变量**：
- `db.exec` 幂等：4 条 PRAGMA 多次 init 不会出错
- `journal_mode = WAL` 持久化在 DB 元数据中（首次启动后即生效，后续启动 idempotent）
- `synchronous = NORMAL` 仅在 WAL 模式下足够安全（非 WAL 模式应保留 FULL）；本次 WAL 已先设，顺序不能颠倒

**回归保护**：3 套业务引擎（bank-bu-recon / biz-op-recon / acquiring-bill-currency）共用同一 DB instance，PRAGMA 一次全应用；smoke 19 个 suite 必须全部通过（详 §12.5）

#### 12.3.2 A2 — 索引兜底 + ANALYZE

**PM 已验证现状**：
- `(month_key, recon_main_id)` 复合索引已建（v2.1.6 `idx_acquiring_bill_currency_flow_join` + `idx_acquiring_bill_currency_bill_join`）
- UNIQUE 约束本身也自动建索引
- **JOIN ON 字段已最优**，A2 无需新增 JOIN ON 索引

**A2 真正可加的索引**（writer 阶段高频）：

| 查询函数 | 当前 WHERE | 现有索引 | F7-A2 新增 |
|---|---|---|---|
| `listDiffRowsBySourceFile`（`run-repository.js:114`）| `d.run_id = ? AND b.source_file = ?` | `idx_acquiring_bill_currency_diff_run`（run_id 单列）| 加 `idx_acquiring_bill_currency_bill_source_file`（bill_imports.source_file 单列）|
| `listAllDiffRowsByRun`（`run-repository.js:130`）| `d.run_id = ?` ORDER BY `b.source_file ASC, b.source_row_index ASC`| run_id 单列已有 | 上述 source_file 索引同时服务 ORDER BY |
| `listSourceFilesByRun`（`run-repository.js:180`）| `month_key = ?` SELECT DISTINCT `source_file` | `idx_acquiring_bill_currency_bill_month`（month_key 单列）已有 | 不变 |

**A2 实现要点**：

```js
// migrations.js 内新增 ensure helper 或追加到 ensureAcquiringBillCurrencyTablesSupport
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_source_file
    ON acquiring_bill_currency_bill_imports(source_file);
`);

// database.js init() 末尾（所有 migration 跑完后）追加一次 ANALYZE
this.db.exec('ANALYZE;');
```

**`ANALYZE` 性质**：
- 幂等指令，可重复执行
- 扫描所有表+索引刷新 `sqlite_stat1` 系统表
- 启动开销：v2.1.6 用户 DB 体量下 < 100ms（启动期可接受）
- 让查询规划器选择更优索引（特别是 WHERE 多条件 / ORDER BY 的场景）

#### 12.3.3 B1 — Electron 原生 Notification（main.js）

```js
// L6 destructure 加 Notification
const { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification } = require('electron');

// 在 acquiringBillCurrency:run handler return 前（L10218 附近 success / L10222 附近 error）追加
// 成功：
try {
  if (Notification.isSupported()) {
    new Notification({
      title: '收单单据币种校验',
      body: `${monthKey} 对账完成（共 ${result.mismatchRows} 行差异）`
    }).show();
  }
} catch (_e) { /* swallow */ }

// 失败：
try {
  if (Notification.isSupported()) {
    new Notification({
      title: '收单单据币种校验',
      body: `对账失败：${err && err.message ? err.message : String(err)}`.slice(0, 200)
    }).show();
  }
} catch (_e) { /* swallow */ }
```

**关键不变量**：
- `Notification.isSupported()` 兜底：极端环境（如 SSH 无 GUI 头）下跳过，不抛错
- try/catch swallow：通知失败不影响 IPC return 业务结果
- 文案前缀统一 `「收单单据币种校验」`（用户原话）；body 限长 200 字符（macOS 通知中心截断兜底）
- 不弹通知给"取消"/"用户主动 cancel"路径（避免噪音）；仅 success + 真正 error

### 12.4 验收标准

| AC 编号 | 验收条件 |
|---|---|
| AC-F7-A1-1 | 启动应用后用 `sqlite3 tool-data.sqlite "PRAGMA journal_mode; PRAGMA synchronous; PRAGMA cache_size; PRAGMA mmap_size;"` 验证 4 条 PRAGMA 都已生效（`wal`/`1` 即 NORMAL/`-65536`/`268435456`）|
| AC-F7-A1-2 | DB 目录出现 `tool-data.sqlite-wal` + `tool-data.sqlite-shm` 旁文件；应用正常关闭后 wal 内容 checkpoint 回主文件；二次启动 wal 文件可能为空但不报错 |
| AC-F7-A1-3 | smoke 19 个 suite 全套通过（PRAGMA 影响所有业务引擎，必须无回归）|
| AC-F7-A2-1 | 启动应用后 `sqlite3 tool-data.sqlite ".schema acquiring_bill_currency_bill_imports"` 输出含 `idx_acquiring_bill_currency_bill_source_file` |
| AC-F7-A2-2 | 启动应用后 `sqlite3 tool-data.sqlite "SELECT name FROM sqlite_stat1 LIMIT 1;"` 至少返回 1 行（证明 ANALYZE 已跑）|
| AC-F7-A2-3 | writer 阶段 EXPLAIN QUERY PLAN 显示 `listDiffRowsBySourceFile` 用到新索引（手测，dev 模式）|
| AC-F7-B1-1 | 收单币种校验 runCheck 成功后 → macOS 通知中心 / Windows 任务栏出现"「收单单据币种校验」YYYY-MM 对账完成（共 N 行差异）"通知 |
| AC-F7-B1-2 | runCheck 抛错后 → 通知"「收单单据币种校验」对账失败：{message}"，body ≤ 200 字符 |
| AC-F7-B1-3 | `Notification.isSupported()` 为 false 的环境（如 CI 无 GUI）不抛错，仅 console.log 一行；现有 IPC return 链路不变 |

### 12.5 全 19 个 smoke suite 回归矩阵（F7-A1 PRAGMA 全局影响）

| Suite | 必跑理由 |
|---|---|
| `acquiring-bill-currency-progress.js` | F6 + F7 主战场 |
| `acquiring-bill-currency.js` | 收单币种校验核心；PRAGMA 直接影响 |
| `bank-bu-recon.js` | 月度银行 BU 回填校验；共享同一 DB instance |
| `bank-statement-io.js` | 银行对账单 IO；可能间接走 DB |
| `biz-op-recon.js` | 业务OP 数据核对；共享同一 DB instance |
| `error-causes.js` | 错误原因报告；FileValidationError 等 |
| `migrations-recon-id-fix.js` | C4 migration 幂等；A2 新加 source_file 索引需共存 |
| `recon-id-fix-end-to-end.js` | C4 端到端；DB 路径 |
| `recon-id-fix-engine-gateway.js` | C4 gateway 引擎 |
| `recon-id-fix-engine.js` | C4 business 引擎 |
| `recon-id-fix-io.js` | C4 IO |
| `recon-id-fix-ipc-handlers.js` | C4 IPC |
| `recon-id-fix-scenario-ipc.js` | C4 场景 IPC |
| `scenario-dispatcher.js` | C1/C2/C3 dispatcher（F1/F2/F4 已改 → 必须回归）|
| `scenario-end-to-end.js` | 场景端到端 |
| `scenario-engines.js` | C1/C2/C3 引擎汇总（F1/F2/F4 已改 → 必须回归）|
| `scenarios-repository.js` | 场景 DB CRUD |
| `scenarios.js` | 场景主入口 |
| `usage-stats.js` | 使用统计；间接 DB |

**A3 不在矩阵**：support.js 是公共 helper，不是独立 suite。

### 12.6 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | PRAGMA `journal_mode = WAL` 改变所有 DB 持久化行为；3 套业务引擎共享同一 DB instance | 全 19 个 smoke suite 必跑；spec §6 含详细回归矩阵；PR body 高亮"WAL 模式下回滚行为与 DELETE 模式有微妙差异" |
| 🟡 中 | WAL 旁文件产生 `*.sqlite-wal` + `*.sqlite-shm`，用户手动备份 DB 时可能漏拷 | USER_GUIDE 加一段提示"备份 DB 需同时备份 3 个文件"；CHANGELOG v2.1.7 段高亮 |
| 🟢 低 | `synchronous = NORMAL` 在非 WAL 模式下可能丢最后几笔事务（断电场景）| WAL 已先设；二者顺序写入保证；smoke 涵盖 |
| 🟢 低 | `cache_size = -65536`（64MB）在低内存机器上占用 | 用户 16GB RAM 充裕；macOS / Windows 桌面环境内存压力小 |
| 🟢 低 | `mmap_size = 268435456`（256MB）在 32-bit 环境受限 | 项目 Electron 36 全 64-bit；不支持 32-bit Windows |
| 🟢 低 | A2 source_file 索引重复建（如已被未来 migration 覆盖）| `CREATE INDEX IF NOT EXISTS` 幂等；与现有 ensure helper 范式一致 |
| 🟢 低 | A2 `ANALYZE` 启动期开销 | v2.1.6 用户 DB 体量 < 100ms；启动期可接受 |
| 🟢 低 | B1 Notification 在用户系统通知关闭时不展示 | `Notification.isSupported()` 兜底 + try/catch swallow；现有状态栏文案仍生效（不靠通知判定结果）|
| 🟢 低 | B1 通知文案过长在 macOS / Windows 截断 | body 限长 200 字符（spec §6.3.3）|

⚠️ **重要变量检查**：F7 修改 `AppDatabase.init`（database.js 类入口）+ `acquiringBillCurrency:run` handler return；后者引用了 `runCheck` 调用，但 F7 不动 runCheck 业务逻辑；建议本迭代结束 `/check-vars` 时**评估升格 `AppDatabase` / `AppDatabase.init` 进 Important-skeleton 层**（已是项目级 DB 单例门面，PRAGMA 配置点应明确）

⚠️ **previews 不涉及**：F7 无 UI 改动；preview 不变

---

## 十三、round 2 — 用户手测反馈修复（R1-R5 + R6a/R6b/R6c）

### 13.1 背景与目标

v2.1.7 round 1（F1-F4 + F6 + F7）落地后用户手测发现 6 个问题；R1-R5 已用户拍板可入 Dev；**用户后发来 F3 三件套 2 张截图，R6 拆为 R6a/R6b/R6c 三个子任务**。

| 编号 | 一句话描述 | 原 round 1 关联 | 用户拍板状态 |
|---|---|---|---|
| R1 | F4 dialog 账单类型行的删除按钮门槛错误（仍是 `<= 2` 老约束） | F4 | ✓ 改 `=== 1` 与 reconFields 对齐 |
| R2 | F6 状态框 inserting 阶段显示 `(i/? 个文件)` —— fileCount 缺失 | F6 | ✓ session.js wrapper 显式注入 fileCount |
| R3 | 多模块状态框文案"：xxx"在 280px 框内挤成一行，可读性差 | 全局（F6 触发 + bizOpRecon 历史 hack） | ✓ updateStatusBox 全局 `replace(/：/g, '：\n')` + `white-space: pre-wrap` + 顺手清 bizOpRecon hack |
| R4 | F6 跑 import/run 时切走再切回，4 按钮被无脑解禁，可重复触发 | F6 + acquiring 模块 panel restore | ✓ 仅 acquiring 模块加 inflight flag；其它模块 PM 已验证无问题 |
| R5 | F1 默认 OR 不符合用户日常工作场景（90% 用 AND） | F1 | ✓ 仅新建默认 AND；老 scenario fallback OR（资金红线护栏）；dialog 移到独立行 + 纵向 + AND 在上 |
| **R6a** | F3 multi 模式文件名 "PP..." 根因细化 | F3（round 1 b1ba84b `min-width:0 + flex:1 1 auto` 不彻底） | ⏸ **等用户拍板方案 A/B/C 之一**（PM 推荐 C+B 组合；详 §13.7）|
| **R6b** | 大账号 multi-mode dialog 列表滚动条丢失 | F3 衍生 | ✓ PM 二次诊断 — 高度链已通，真根因合并到 R6a 修复（详 §13.8）|
| **R6c** | "确认大账号顺序" dialog 列表超屏不能滚 | F3 衍生（提取大账号顺序后弹窗）| ✓ `.extract-order-list` 加 `max-height + overflow-y:auto`（详 §13.9）|

### 13.2 R1 — F4 billTypes 删按钮门槛改 `=== 1`

#### 13.2.1 现状

- `src/renderer-dialogs.js:6676` 当前条件：`isReadonly || config.billTypes.length <= 2 ? '' : '<button ... remove>'`
- 对照 `src/renderer-dialogs.js:6700` reconFields 条件：`isReadonly || config.reconFields.length === 1 ? ...'`
- 这是 v2.1.6 时代"账单类型至少 2 行"的老约束遗物；F4 round 1 已把校验/默认值放宽到 `>= 1`，但**删除按钮的最小保留门槛漏改**

#### 13.2.2 改动

```js
// L6676 现状
${isReadonly || config.billTypes.length <= 2 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}

// 改后（与 reconFields :6700 一致）
${isReadonly || config.billTypes.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
```

#### 13.2.3 验收

- billTypes 长度 = 1 时，该行无删除按钮（保留至少 1 行）
- billTypes 长度 ≥ 2 时，所有行都有删除按钮
- smoke：可补 1 case "billTypes 长度 2 时按钮可见"（非强制）

#### 13.2.4 风险

- 🟢 极低（1 字符 diff）

### 13.3 R2 — F6 inserting 阶段 fileCount 显式注入

#### 13.3.1 现状（PM 已 grep 验证）

| 文件:行号 | 现状 | 问题 |
|---|---|---|
| `src/backend/acquiring-bill-currency-import/reader.js:371-372` | `if (onProgress && importedCount % 10000 === 0) onProgress({ sourceFile, importedCount });` | reader 内部 progress payload **不带 fileCount** |
| `src/main-process/acquiring-bill-currency-session.js:62-64` | `onProgress: (p) => { if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p }); }` | `...p` 在 `fileIndex` 之后，**会覆盖**外层任何相同字段；当前没传 fileCount → 渲染端拿不到 |
| `src/main-process/acquiring-bill-currency-session.js:113-115` | overwrite 路径同样问题 | 同上 |
| `src/renderer.js:4264`（formatAcquiringBillCurrencyProgress） | `const n = ev.fileCount \|\| '?';` | fileCount undefined → 兜底显示 "?" |

#### 13.3.2 改动

```js
// session.js L62-64 现状（importFilesInTransaction）
onProgress: (p) => {
  if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p });
}

// 改后 — fileCount 在 ...p 之后，防止 reader payload 偶然覆盖；source-of-truth = filePaths.length
onProgress: (p) => {
  if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p, fileCount: filePaths.length });
}
```

session.js L113-115（importFilesWithOverwrite）同样修改。

#### 13.3.3 验收

- F6 smoke F6-B 增加断言：inserting 事件 payload 包含 `fileCount === filePaths.length`
- 手测：导入 16 个文件，状态框文案"正在写入 xxx：已读取 N 行 (i/16 个文件)" 而非 `(i/? 个文件)`
- spec §6.5 文案说明同步：「正在写入 xxx：已读取 N 行 (i/n 个文件)」中的 n 永远等于 filePaths.length

#### 13.3.4 风险

- 🟢 低（向 payload 加字段，不破坏现有字段；reader 内部不需要任何改动）

### 13.4 R3 — 状态框「：」（中文全角）后强制换行（全局规则）🚨 影响面广

#### 13.4.1 现状

| 文件:行号 | 现状 | 问题 |
|---|---|---|
| `src/renderer.js:519-538 updateStatusBox` | `textEl.textContent = message;` | textContent 不识别 `<br>` / `\n` 默认不换行（除非 CSS white-space 允许）|
| `src/renderer.js:4131-4143 setBizOpReconStatus` | 调 updateStatusBox 后**覆盖 innerHTML** = `formatBizOpReconStatusHtml(message)`，含 `<br>` 换行 | 局部 hack，已存在但只覆盖 bizOpRecon |
| `src/styles.css:344-358 .status-box` | 无 white-space 属性，默认 `normal`（折叠空白 + 不识别 `\n`）| 文案过长被框 280px 强制单行挤成省略 |
| `src/styles.css:2725-2727 #bankStatementStatusBox .status-box-text` | `white-space: pre-line;` 已设 | 仅 bank-statement 模块；其它模块未设 |

#### 13.4.2 方案 A（推荐，已用户拍板）：updateStatusBox 入口 replace + CSS 全局 pre-wrap

**入口替换**（`src/renderer.js:519` updateStatusBox 函数顶部）：

```js
function updateStatusBox(box, message, tone = 'info', options = {}) {
  // R3：中文「：」后强制换行（仅作用于全角冒号；半角 ':' 不动，避开 URL/timestamp/账号 case）
  const text = (message === null || message === undefined) ? '' : String(message).replace(/：/g, '：\n');
  ...
  const textEl = box.querySelector('.status-box-text');
  if (textEl) textEl.textContent = text;  // 改 message → text
  ...
}
```

**CSS 全局** (`src/styles.css` 加在 `.status-box` 附近)：

```css
.status-box-text {
  white-space: pre-wrap;  /* R3：识别 \n 换行 + 长行自动换 */
}
```

**清理 bizOpRecon hack**（`src/renderer.js:4131-4143`）：

```js
// 改后（A 方案覆盖了 hack 的场景）
function setBizOpReconStatus(message, tone = 'info') {
  if (!elements.bizOpReconStatusBox) return;
  updateStatusBox(elements.bizOpReconStatusBox, message, tone, {
    idleTitle: '欢迎使用小助手'
  });
  // R3 清理：原 innerHTML 覆盖 + formatBizOpReconStatusHtml 调用全部删除
}
```

**bankStatement 已有 `pre-line`**：与新增 `pre-wrap` 都能识别 `\n`，无冲突；如希望统一可一并改 `pre-wrap`（spec 备注）。

#### 13.4.3 不动方案 B（半角 → 全角）：本次不强制

PRD 不动各模块 setStatus 调用方文案里的半角 `:`（如 `tone: 'success'`）；R3 规则只识别中文「：」，触发换行的责任在文案作者，符合"约定优于配置"。

#### 13.4.4 文案审计建议（spec 阶段执行）

PM 建议 spec 阶段 grep 一遍所有 setStatus / setBankBuReconStatus / setBizOpReconStatus / setAcquiringBillCurrencyStatus 等调用方的文案，识别哪些用了半角 `:` 而希望换行的（如错误 detail 拼接）。**本次 R3 只加规则不强制改文案**；若有少量必须换行的半角 `:` 调用方文案，spec 标注后由调用方自行改成「：」。

#### 13.4.5 smoke + 验收

- smoke：`updateStatusBox` 单测 — 输入 `「正在导入：xxx」` 期望 textEl.textContent 含 `\n`（`正在导入：\nxxx`）
- 19 个 suite 全跑（updateStatusBox 全局影响）
- 手测：bizOpRecon / acquiring / bankBuRecon / pending 4 个模块状态框各跑一遍含「：」文案，肉眼确认换行

#### 13.4.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | 全局 setStatus 影响所有模块；可能"原本一行能装下的短文案"也被截成 2 行 | 触发条件只有「：」存在；现状所有模块文案中含「：」的本就期望换行（如`对账失败：xxx` / `导入完成：N 行`）；不会引入意外 |
| 🟢 低 | bizOpRecon hack 删除后 fallback 行为是否一致 | A 方案覆盖了 hack 场景；spec 必须 manual smoke biz-op-recon 状态框文案换行行为不变 |
| 🟢 低 | bankStatement 已有 `pre-line` 会与新 `pre-wrap` 冲突 | CSS 优先级 ID > class，`#bankStatementStatusBox .status-box-text` 仍取 `pre-line`；两者都识别 `\n`，行为兼容 |

### 13.5 R4 — F6 切模块后按钮误启用

#### 13.5.1 现状（PM 已 grep 验证）

| 文件:行号 | 现状 | 评估 |
|---|---|---|
| `src/renderer.js:4233 acquiringBillCurrencyState` | `const acquiringBillCurrencyState = { latestMonth: null };` | **没有 importing / running flag** |
| `src/renderer.js:4285 restoreAcquiringBillCurrencyPanelState` | `setAcquiringBillCurrencyStatus('欢迎使用小助手', 'info'); setAcquiringBillCurrencyButtonsDisabled(false);` | **无脑解禁** —— 切模块再回来 4 按钮全启用 |
| `src/renderer.js:1329-1334 setCurrentModule` | 切到 acquiring 时调 `restoreAcquiringBillCurrencyPanelState()` | 触发点确认 |
| `src/renderer.js:3938 restoreBankBuReconPanelState` | 调 `applyBankBuReconButtonState()`（按 state 决定） | **无此问题** |
| `src/renderer.js:4225 restoreBizOpReconPanelState` | 调 `applyBizOpReconButtonState()`（按 state 决定） | **无此问题** |

**衍生评估结论**：R4 仅 acquiring 模块受影响；bankBuRecon / bizOpRecon / pending 均已用 apply*ButtonState 范式，本次 R4 不扩散。

#### 13.5.2 改动

```js
// renderer.js L4233 — acquiringBillCurrencyState 加 inflight flag
const acquiringBillCurrencyState = {
  latestMonth: null,
  inflightOperation: null   // R4：'import' | 'run' | 'export' | null；切模块后据此决定按钮 disabled
};

// 在 runAcquiringBillCurrencyImport / handleAcquiringBillCurrencyRun / handleAcquiringBillCurrencyExport
// 函数 try 前置 + finally 清掉
async function runAcquiringBillCurrencyImport(kind) {
  ...
  acquiringBillCurrencyState.inflightOperation = 'import';  // ⭐
  setAcquiringBillCurrencyButtonsDisabled(true);
  ...
  try { ... } finally {
    acquiringBillCurrencyState.inflightOperation = null;     // ⭐
    if (unsubscribe) unsubscribe();
    setAcquiringBillCurrencyButtonsDisabled(false);
  }
}

// restoreAcquiringBillCurrencyPanelState 按 flag 决定
function restoreAcquiringBillCurrencyPanelState() {
  setAcquiringBillCurrencyStatus('欢迎使用小助手', 'info');
  // R4：有 inflight 任务时保持按钮禁用；无则解禁
  setAcquiringBillCurrencyButtonsDisabled(!!acquiringBillCurrencyState.inflightOperation);
}
```

**关键不变量**：
- inflightOperation 是 renderer 端的"乐观锁"，与 main.js `acquiringBillCurrencyOperationLock` 互补（main 端兜底；renderer 端 UI 体感正确）
- 任何 IPC 调用都必须 finally 清 flag（防泄漏）
- 即使用户主动 cancel 月份弹窗，flag 也未设（仅设在按钮 disable 之前那一行）

#### 13.5.3 验收

- 手测：开始 import 大数据 → 切到其它模块 → 切回 acquiring → 4 按钮仍 disabled
- 手测：完成 import → 切走再切回 → 4 按钮 enabled
- 手测：失败 import → 切走再切回 → 4 按钮 enabled（错误已显示）
- smoke 不强制（纯 UI 状态切换）

#### 13.5.4 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 仅 acquiring 模块受影响（PM 已验证其它模块用 apply*ButtonState 无此问题）| 修改面窄；不扩散到其它模块 |
| 🟢 低 | 异常路径漏清 flag | spec §13.5.2 强制要求 finally 清 flag；smoke 失败路径手测 |

### 13.6 R5 — F1 默认 AND（仅新建）+ dialog 纵向布局 + 资金红线护栏

#### 13.6.1 现状

| 文件:行号 | 现状 | 改动方向 |
|---|---|---|
| `src/renderer-dialogs.js:5707` | `conditionsLogic: 'OR'`（新建默认 OR）| 改 `'AND'`（仅新建默认值变，引擎 fallback 不动） |
| `src/main-process/scenario-engines/c1-extract-recon-id.js`（spec §2.2）| 引擎读 `config.conditionsLogic === 'AND' ? 'AND' : 'OR'`，缺失 fallback OR | **不动**（资金红线护栏） |
| `src/renderer-dialogs.js:6294-6306` | radio 在"条件" row 内 wrap；横向；OR 在前 AND 在后 | 改：移到独立 row + 纵向 + AND 在上 OR 在下 + label 字体与"筛选字段"一致 |
| `src/renderer-dialogs.js:6314 筛选字段 label` | `<label>筛选字段：` 直接文本（无特殊 class） | 参考样式：label 默认字号字重 |

#### 13.6.2 改动

**默认 config**：

```js
// src/renderer-dialogs.js:5707 现状
conditionsLogic: 'OR',

// 改后
// v2.1.7 round 2 R5：新建默认 AND（90% 业务场景）；老 scenario 无 logic 字段 → 引擎 fallback OR（资金红线护栏，spec §13.6.4）
conditionsLogic: 'AND',
```

**dialog HTML**（L6294-6306 重写）：

```html
<!-- 现状（横向，inline 在"条件" row 内） -->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    <button ...>+ 新增条件</button>
    <div class="scenario-config-logic-row">
      <span class="scenario-config-logic-label">条件聚合：</span>
      <label class="scenario-config-logic-option"><input type="radio" name="conditionsLogic" value="OR" ...> OR（满足任一）</label>
      <label class="scenario-config-logic-option"><input type="radio" name="conditionsLogic" value="AND" ...> AND（同时满足）</label>
    </div>
  </div>
</div>

<!-- 改后（独立 row + 纵向 + AND 在上 + label 复用默认 .scenario-config-row 样式，去掉 logic-row 特殊样式） -->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    <button ...>+ 新增条件</button>
  </div>
</div>
<!-- ⭐ 新增独立 row（与"条件"/"筛选字段"层级一致）-->
<div class="scenario-config-row">
  <span class="scenario-config-label">条件聚合</span>
  <div>
    <label style="display:block; margin-bottom:4px;">
      <input type="radio" name="conditionsLogic" value="AND" ${config.conditionsLogic === 'AND' || config.conditionsLogic === undefined ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
      AND（同时满足）
    </label>
    <label style="display:block;">
      <input type="radio" name="conditionsLogic" value="OR" ${config.conditionsLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
      OR（满足任一）
    </label>
  </div>
</div>
```

**关键 dialog 加载逻辑（资金红线护栏！）**：

```js
// dialog 打开时（C1 dialog 入口）— 必须明确区分"新建 vs 编辑"
// 新建：state.scenarioDraft.mode === 'create'，draft.config 来自 createDefaultScenarioConfig → 包含 'AND'
// 编辑：state.scenarioDraft.mode === 'edit'，draft.config 来自 DB scenarios.config JSON
//   - 老 scenario（v2.1.7 round 1 之前）DB 里无 conditionsLogic 字段 → JSON.parse 后 undefined
//   - dialog HTML 已写 `config.conditionsLogic === 'AND' || config.conditionsLogic === undefined ? 'checked' : ''` 给 AND
//     ⚠️ 这与"资金红线护栏：老 scenario fallback OR"冲突！
//   - 必须改：老 scenario 加载时 dialog 默认 OR 选中（避免用户编辑保存时无意把语义从 OR 变 AND）
```

修正 HTML 渲染逻辑：

```js
// 新增 helper 在 dialog 工厂 fn 内
function pickConditionsLogicChecked(draft) {
  // 新建：draft.mode === 'create' → 默认 AND
  // 编辑：draft.mode === 'edit'，老 scenario undefined → 默认 OR（资金红线护栏）；新 scenario 'AND' / 'OR' → 用本值
  if (draft.mode === 'create') return draft.config.conditionsLogic || 'AND';
  // edit 模式
  return draft.config.conditionsLogic || 'OR';
}

// 调用
const checkedLogic = pickConditionsLogicChecked(draft);
// HTML 用 checkedLogic === 'AND' / 'OR' 判定
```

#### 13.6.3 confirm 预览文案 + 列表预览（spec §2.3 已实现 logic 切换）

R5 不改 confirm 预览与列表预览 — 已按 `c.conditionsLogic === 'AND' ? 'AND' : 'OR'` 渲染；新建场景 confirm 显示 "条件（AND）：" 即为预期。

#### 13.6.4 ⚠️ 资金红线护栏（用户拍板必写）

**核心不变量**：

| 入口 | 默认值 |
|---|---|
| 新建场景 dialog | `conditionsLogic = 'AND'`（默认 + UI checked） |
| 编辑老 v2.1.6/v2.1.7-round1 scenario dialog（DB 无 logic 字段） | `conditionsLogic = 'OR'`（UI checked 默认 OR；用户不动 = OR 保留；用户主动改 AND = 写盘新值） |
| 编辑新 v2.1.7-round2 scenario dialog（DB 有 'AND' / 'OR'） | 用本值 |
| 引擎 fallback（runC1Scenario） | undefined → OR（spec §2.2 不动）|

**护栏理由**：用户原话"老 scenario 不能被静默改变语义"。如果 round 2 R5 把"老 scenario 加载时 UI 显示 AND"，用户点保存（未察觉）就把语义从 OR 翻成 AND，**资金事故**（场景命中率 = 行 × 1/N → 行 × 1，大量误命中）。

**护栏实现要点**（spec 必含）：
1. `createDefaultScenarioConfig('extract-recon-id')` 返回 `conditionsLogic: 'AND'`（仅 create 路径走此函数）
2. dialog 加载老 scenario 时按 `draft.mode === 'edit' && !draft.config.conditionsLogic` 检测 → UI checked OR
3. 引擎 fallback 永远 OR（不依赖 dialog）

#### 13.6.5 smoke 用例

新增 / 增强：

| Case | 输入 | 期望 |
|---|---|---|
| R5-A | createDefaultScenarioConfig('extract-recon-id') 返回值 | `conditionsLogic === 'AND'`（仅新建路径）|
| R5-B | dialog 工厂 fn 加载 mode=create draft | `pickConditionsLogicChecked` 返回 'AND'，HTML AND radio checked |
| R5-C | dialog 工厂 fn 加载 mode=edit + draft.config.conditionsLogic === undefined（老 scenario）| `pickConditionsLogicChecked` 返回 'OR'，HTML OR radio checked |
| R5-D | runC1Scenario({ config: { conditions: [...] /* 无 logic */ }, ...}) | 引擎 fallback OR（spec §2.2 已实现，回归保护）|
| R5-E | runC1Scenario({ config: { ..., conditionsLogic: 'AND' } }) | every 判定 |

#### 13.6.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | 默认 AND 改变用户新建场景体感（部分用户可能习惯 OR）| dialog UI radio 明示两个选项；用户可一键切；R5 已用户拍板"日常 90% 用 AND"|
| 🔴 资金红线 | 老 scenario 静默从 OR 变 AND | §13.6.4 三层护栏：默认 config（仅 create）+ pickConditionsLogicChecked（按 mode 分支）+ 引擎 fallback OR |
| 🟢 低 | radio 移到独立行 → preview 截图变化 | F1 preview 需重跑（已在 §14.3 preview 矩阵）|

⚠️ **重要变量检查**：R5 改 `createDefaultScenarioConfig` 默认值 + dialog 渲染逻辑；引擎 fallback 不动。建议 `/check-vars` 评估升格 `conditionsLogic` 进 Critical 层（业务契约锚点，影响 C1 行 → 1/N 命中率剧烈变化）。

### 13.7 R6a — F3 multi 模式文件名根因细化（待用户拍板方案）

#### 13.7.1 用户提供截图分析（截图 2 = "网银账单解析大账号确认" multi 模式）

- 文件名（如 `PPchaxun1.csv 第9行`，18 字符）显示为 **"PP..."**
- round 1（b1ba84b）`.ba-file-name { min-width:0; flex:1 1 auto }` 未根治

#### 13.7.2 PM 二次诊断真根因（用户分析 + grep 验证）

**两层根因叠加**：

**第 1 层（用户已点明）**：`.ba-file-name { flex:1 1 auto }` 对 grid 子项**无效** —— grid item 不接受 flex 属性，只接受 grid-column / justify-self / align-self。`min-width:0` 单独不够。

**第 2 层（PM 深挖发现）**：`.ba-file-row { grid-template-columns: 28px 1fr }` **硬编码 2 列**；但 `renderer-dialogs.js:1002-1053` multi 模式 3 个分支（editing / grouped / uncovered）各 append **3 个子项**给 `.ba-file-row`：

| 分支 | append 顺序 | 子项数 | 与 2 列 grid 不匹配后果 |
|---|---|---|---|
| `multiMode && multiEditing` | `[checkbox, letterSpan, meta]` | 3 | 第 3 子项 meta 被压到第 2 列 `1fr` 共享 → 实际宽度被前 2 子项压缩 |
| `multiMode && !multiEditing && covered`（grouped）| `[markerSpan, letterSpan, meta]` | 3 | 同上 |
| `multiMode`（uncovered）| `[letterSpan, indexSpan, meta]` | 3 | 同上 |
| 普通模式 | `[idx, meta]` innerHTML | 2 | ✓ 与 grid 2 列匹配 |

**最终视觉**：meta 列被挤到 30-60px → CSS `text-overflow:ellipsis` 触发 → 仅显示 "PP..."

#### 13.7.3 三个修复方案（PM 评估 + 推荐）

| 方案 | 改动 | 副作用 | 推荐度 |
|---|---|---|---|
| **方案 A** | `.ba-file-name { white-space: normal; word-break: break-all }` 文件名多行换行 | 行高变化、列表纵向更长、可能触发新的 R6b 滚动需求；UX 不一致（其它行 ellipsis） | ⚠️ 牺牲 ellipsis 一致性 |
| **方案 B** | JS `truncateFileName` maxLen 20 → 14（中间截断 + ...）让 CSS ellipsis 不触发 | 长文件名仍被 JS 截，但保留首尾段；行高保持一致；只动一个常量 | 🟢 治标但不治本（meta 列宽仍受 grid 2 列硬编码限制）|
| **方案 C** | `.ba-file-row { grid-template-columns: ... → 适配 3 子项 }` + 弹窗加宽（`.big-account-selection-card` 1080 → 1200）| 修根因；可能影响其它使用 `.ba-file-row` 的地方；preview 重跑 | 🟢 治本但改动面大（grid 改了影响所有 4 个分支）|
| **方案 C+B（PM 推荐）** | 方案 C（治本）+ 方案 B（防御性下调阈值留余地）| 双保险；极长文件名仍兜底 | ⭐ **推荐** |

#### 13.7.4 推荐方案 C+B 详细方案

**CSS 改动**（spec §8.7 给精确 sketch）：

```css
/* styles-gemini-extra.css L391-401 现状 */
.ba-file-row {
  display: grid;
  grid-template-columns: 28px 1fr;  /* ⚠️ 硬编码 2 列 */
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  ...
}

/* 改后（方案 C） — 用 grid-template-columns 动态适配 */
.ba-file-row {
  display: grid;
  grid-template-columns: auto auto 1fr;  /* ⭐ 3 列：marker/checkbox + letter/idx + meta */
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  ...
}

/* L411-419 .ba-file-name */
.ba-file-name {
  min-width: 0;                /* 保留（即使是 grid 子项也需要）*/
  /* 删除 flex: 1 1 auto（grid 子项无效）*/
  font-family: ...;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

**普通模式 2 子项分支兼容性**：grid 3 列 `auto auto 1fr`，2 子项时第 1 子项占 col-1，第 2 子项占 col-2（自动），col-3 空白 —— **不破坏普通模式视觉**（已实测理论分析；spec §8.7 要求 preview 回归验证）

**弹窗加宽**：

```css
/* styles-gemini-extra.css L190 现状 */
.big-account-selection-card { width: min(100%, 1080px); min-height: 540px; }
/* 改后 */
.big-account-selection-card { width: min(100%, 1200px); min-height: 540px; }
```

**JS 阈值微调**（方案 B 防御性）：

```js
/* renderer-dialogs.js:946-952 truncateFileName 现状 */
function truncateFileName(fileName, maxLen) {
  if (!fileName || fileName.length <= maxLen) return fileName || '';
  const keepStart = 6;
  const keepEnd = 10;
  if (fileName.length <= keepStart + keepEnd + 3) return fileName;
  return fileName.slice(0, keepStart) + '...' + fileName.slice(-keepEnd);
}

/* 调用方 :999 + :1715 */
truncateFileName(fullName, 20)
/* 改后（方案 B 防御性，仅 multi 分支调用降阈值）*/
truncateFileName(fullName, 14)  /* 仅在 R6a 影响的 multi 3 分支用 14 */
```

**或者**：保留 maxLen=20 默认，方案 C 已治本（grid 列宽适配后 meta 列有 ~600px 可显示完整 20 字符）；方案 B 仅留作"极长文件名兜底"，**spec 阶段先按方案 C 单独实施**，看 preview 截图效果决定是否合并方案 B。

#### 13.7.5 不动的部分

- `truncateFileName` 实现（如 spec §8.7 决定只用方案 C，则 JS 不动）
- 普通模式（非 multi）分支渲染（L1054-1057）
- ba-file-row 子项 append 顺序
- `.big-account-split-body` / `.ba-scroll-container` / `.big-account-file-list/.big-account-order-list` 高度链 CSS（spec §8.8 R6b 已验证已通）

#### 13.7.6 验收标准

- 手测：multi 编辑态文件名完整显示
- 手测：multi 闭合 grouped 态文件名 + "→ MERCHANT USD" 完整显示
- 手测：multi 未入组 uncovered 态文件名完整显示
- 手测：非 multi 模式文件名显示与 round 1 一致（regression baseline）
- preview screenshot：大账号 dialog × 4（multi 启-编辑 / multi 启-grouped / multi 关 / 普通）

#### 13.7.7 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | grid 3 列改动影响所有使用 `.ba-file-row` 的地方（包括普通模式 2 子项）| spec §8.7.4 已分析理论兼容性 + preview 回归矩阵 4 张图必查 |
| 🟢 低 | 弹窗加宽 1080→1200 在小屏（< 1280px）可能触发 width: min(100%,...) 100% 路径 | 弹窗本身有 `width: min(100%, ...)`，小屏自动收缩；min-height: 540px 保持不变 |
| 🟢 低 | preview screenshot 全部需重跑 | 已列入 §14.3 矩阵 |

#### 13.7.8 ⏸ 等用户拍板

PM 推荐方案 C+B（C 治本 + B 防御性）；用户可选：
- **方案 A**：换行显示，舍弃 ellipsis
- **方案 B**：仅 JS 截断阈值改小
- **方案 C**：仅 grid 3 列治本（**PM 推荐 minimum viable**）
- **方案 C+B**：grid 3 列 + JS 阈值微调（**PM 推荐 robust**）

spec 阶段先按 **方案 C** 落地，**方案 B 备选**（如 preview 截图发现某些边界文件名仍超长可启用）。

### 13.8 R6b — 大账号 multi-mode dialog 列表滚动条丢失（合并到 R6a 修复）

#### 13.8.1 PM 二次诊断（高度链已通）

用户描述"列表滚动条丢失"。PM grep 现状：

- `.modal-card { display:flex; flex-direction:column; overflow:hidden; max-height: calc(100vh - 56px) }` ✓
- `.big-account-selection-card { width: min(100%, 1080px); min-height: 540px }` + `.big-account-selection-split { min-height: 600px }` ✓
- `.big-account-split-body { flex:1; overflow:hidden }` ✓
- `.ba-scroll-container { display:grid; grid-template-columns: 1fr 1fr; height:100%; min-height:360px; max-height: 52vh }` ✓
- `.big-account-file-list/.big-account-order-list { flex:1; overflow-y:auto }` ✓

**高度链完整**。`ba-scroll-container` 类已在 `renderer-dialogs.js:879` dialog innerHTML 加。

#### 13.8.2 真实根因（合并到 R6a）

用户截图 2"滚动条丢失"的真实原因 = R6a multi 各分支 3 子项 vs grid 2 列硬编码导致**单行可能被拉高（如换行 wrap）或撑出水平 overflow**。R6a CSS fix（方案 C grid 3 列）后：
- 单行高度恢复正常
- 列表内容总高度 < `max-height: 52vh` → 不需要滚动条（这是预期行为）
- 内容总高度 > `max-height: 52vh` → 自动出现垂直滚动条（已有 `overflow-y:auto`）

**R6b 不需要独立 CSS 改动**；spec §13.8 仅做"R6a 修复后回归验证 R6b 高度链"。

#### 13.8.3 验收标准

- 手测：导入 ≥ 20 个文件 + multi 模式 → 列表自动出现垂直滚动条
- 手测：导入 5 个文件 + multi 模式 → 列表无滚动条（内容总高 < 52vh）
- 手测：弹窗不超屏（modal-card max-height 兜底生效）

#### 13.8.4 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 用户描述与 PM 诊断不一致（用户说"滚动条丢失"，PM 认为是 R6a 单行挤压副作用）| 手测 ≥ 20 文件场景必须确认滚动条出现；如仍无滚动则深挖 |
| 🟢 低 | `.big-account-selection-split { min-height: 600px }` 在小屏（< 720px 高）可能与 modal-card max-height: calc(100vh - 56px) 冲突 | spec §8.8 提示 dev 在小屏测试；可能需 `min-height: min(600px, 80vh)` 微调，但本轮不强制 |

### 13.9 R6c — "确认大账号顺序" dialog 列表超屏不能滚

#### 13.9.1 PM 二次诊断

`renderer-dialogs.js:1680-1700` `.extract-order-card` modal-card 内：

- `.modal-card` 兜底 ✓ `max-height: calc(100vh - 56px) + overflow:hidden`
- `.extract-order-card { width: min(100%, 760px) }` ✓
- `.extract-order-body { padding:18px 28px 8px; display:grid; grid-template-columns: 1fr 1.15fr; gap:28px }` ✓
- `.extract-order-list { display:flex; flex-direction:column }` —— ⚠️ **没有 max-height + 没有 overflow-y**

**modal-card overflow:hidden** 切掉超屏内容，但 `.extract-order-list` **不能滚动** → 用户看不到底部。

#### 13.9.2 修复方案

**最小 CSS 改动**（spec §8.9 给精确 sketch）：

```css
/* styles-gemini-extra.css L1294-1296 现状 */
.extract-order-list {
  display: flex;
  flex-direction: column;
}

/* 改后 */
.extract-order-list {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 280px);  /* ⭐ 留 280px 给 modal header/body padding/dialog-actions */
  overflow-y: auto;                 /* ⭐ 自动出现垂直滚动条 */
}
```

**为什么用 `100vh - 280px`**：modal-card overflow:hidden + max-height calc(100vh - 56px) → modal 内容区可用 ~100vh - 56px = 100vh - 56px ≈ 95vh。modal 内 dialog-header (~56px) + extract-order-body padding (~26px) + dialog-actions (~64px) + col-header (~32px) + 余量 = ~200-220px → 列表可用 ~`100vh - 280px`，留余量更安全。

#### 13.9.3 不动的部分

- `.extract-order-card` 宽度
- `.extract-order-body` grid 列宽
- `.extract-order-row` 内部结构（grid 3 子项 vs 3 列 ✓ 对齐，文件名 ellipsis 正常）
- `truncateFileName` 调用（`renderer-dialogs.js:1715` `truncateFileName(fileName, 20)` 保留）

#### 13.9.4 验收标准

- 手测：导入 ≥ 30 个文件 + 点"提取大账号顺序" → 弹窗内列表自动出现垂直滚动条，能滚到底部
- 手测：导入 5 个文件 → 弹窗内列表无滚动条（内容少）
- 手测：弹窗不超屏（modal-card 兜底）
- preview 不必新增（extract-order-card 当前可能没单独 preview 入口）

#### 13.9.5 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | `calc(100vh - 280px)` 在极小屏（< 400px 高，几乎不可能）算出负值 | CSS auto fallback；max-height 负值 = auto；不会破坏布局 |
| 🟢 低 | 用户在弹窗内编辑大账号（点"编辑"按钮展开 input）行高变化 | overflow-y:auto 自动适应；无副作用 |

---

## 十四、round 3 — 用户手测反馈修复（B1-B5 + F4 删空）

### 14.1 背景与目标

v2.1.7 round 2（R1-R5 + R6a/R6b/R6c）落地后用户手测**通过 F1 主功能、R4、R6 主功能**；反馈 **5 个 bug + 1 个 R1 未彻底问题**。其中 B5（R3 wiring 漏接）是用户发现 1 处 + **PM grep 再发现 2 处**。

| 编号 | 一句话描述 | 原 round 关联 | 用户拍板状态 |
|---|---|---|---|
| B1 | F1 radio 移回"条件"row 内部（再次反馈）| F1 / R5 | ✓ DOM 重组，逻辑不动 |
| B2 | multi 完成态字母列丢失（R6a auto auto 1fr 副作用）| R6a | ⏸ 待 dev 实测决定方案 A/B/C（letter 列宽兜底） |
| B3 | extract-order-card 左右对齐 + 共用滚动条 | R6c | ⏸ 等用户拍板方案 A（重组单 grid）/ B（sync-scroll JS）— PM 推荐 A |
| B4 | ≥20 文件场景滚动条不可用 | R6b | ⏸ 待 dev 实测真根因 |
| **B5 🚨** | R3 wiring 漏接（用户 1 处 + PM 2 处）| R3 | ✓ setAcquiringBillCurrencyStatus + updateBankStatementUi + updateReconIdFixUi 三处全部改走 updateStatusBox + render-status-box smoke wiring 审计断言 |
| F4 删空 | R1 只改 display 没改 handler | R1 | ✓ display + handler 同步 `< 0`/`>= 1` 删空；保存校验 `< 1` 兜底 |

### 14.2 B1 — F1 radio 移回"条件"row 内部

#### 14.2.1 现状（PM grep 确认）

| 文件:行号 | 现状 | 用户期望 |
|---|---|---|
| `src/renderer-dialogs.js:6325-6331` | "条件" `.scenario-config-row scenario-config-row-multi` + `.scenario-config-multi-wrap` 含 multi-rows + "+ 新增条件" 按钮 | radio 移到此 wrap 末尾 |
| `src/renderer-dialogs.js:6332-6346` | R5 落地为**独立** `.scenario-config-row` + label "条件聚合" + `.scenario-config-logic-stack` AND/OR 纵向 radio | 整块移除 |

#### 14.2.2 改动方案

```html
<!-- 现状 L6325-6331（条件 row） -->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
  </div>
</div>
<!-- L6332-6346 整块删除（独立 row + label "条件聚合"）-->

<!-- 改后：radio 移到 .scenario-config-multi-wrap 末尾，紧贴 "+ 新增条件" 按钮 -->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
    <!-- B1 round 3：radio 移回"条件"row 内部；保留 round 2 R5 资金红线护栏（pickConditionsLogicChecked 按 mode 分支 + 引擎 fallback OR 不动） -->
    <div class="scenario-config-logic-inline" style="margin-top:8px;">
      <label style="display:block; margin-bottom:4px;">
        <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        AND（同时满足）
      </label>
      <label style="display:block;">
        <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        OR（满足任一）
      </label>
    </div>
  </div>
</div>
```

#### 14.2.3 资金红线护栏（不动）

R5 三层护栏全部保留：
1. createDefaultScenarioConfig 仅 create 返回 'AND'
2. pickConditionsLogicChecked(draft) 按 mode 分支老 scenario fallback OR
3. 引擎 c1-extract-recon-id.js fallback OR

B1 仅 DOM 重组，**所有 JS 逻辑不动**。

#### 14.2.4 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | DOM 重组可能与 round 2 preview screenshot 不一致 | F1 preview 必跑（已在 §14.3 矩阵） |

### 14.3 B2 — multi 完成态字母列丢失

#### 14.3.1 现状（PM grep）

| 文件:行号 | 现状 | 评估 |
|---|---|---|
| `src/renderer-dialogs.js:1027-1042 ba-multi-grouped` | append 3 子项 `[markerSpan(✓) + letterSpan('a./b./c.') + meta]` | 3 子项 vs R6a `auto auto 1fr` 3 列匹配 |
| `src/styles-gemini-extra.css:1887` | `.big-account-order-index--alpha { color: var(--muted); }` 仅 color | ⚠️ letter 列无 min-width / padding，列宽完全靠 content size |
| R6a 后 grid | `auto auto 1fr` | 第 2 列 letter auto = content size ≈ 12-14px（"a." = 2 字符 × ~6px = 12px）|

#### 14.3.2 三个候选方案（dev 实测后定）

| 方案 | 改动 | 优势 | 劣势 |
|---|---|---|---|
| **A** | `.big-account-order-index--alpha` 加 `min-width: 24px` | 最小改动 1 行 | 仅 grouped 分支 letter 字母有效；checkbox/idx 不同子项可能不一致 |
| **B** | grid `auto auto 1fr` → `auto 24px auto 1fr`（4 列固定 letter 列宽 24px）| 显式 letter 列宽 | 需重新评估非 multi 模式 2 子项分布；可能进一步破版 |
| **C** | `.ba-left-letter` / `.big-account-order-index--alpha` 加 `padding-right: 4px` | 不改 grid，仅给 letter 加内边距 | 视觉效果与 min-width 接近但更"自适应" |

#### 14.3.3 PM 推荐方案 A

- 改动量最小（1 行）
- 直接命中 letter 列宽问题
- 不破坏 grid `auto auto 1fr` 结构（R6a 已落地）

```css
/* styles-gemini-extra.css L1887 现状 */
.big-account-order-index--alpha { color: var(--muted); }

/* 改后（方案 A）*/
.big-account-order-index--alpha {
  color: var(--muted);
  min-width: 24px;           /* B2 round 3：letter 列宽兜底，防 R6a grid auto 收缩 */
  text-align: center;        /* 字母居中显示（视觉一致）*/
}
```

#### 14.3.4 验收

- 手测 multi 完成态：字母 "a./b./c." 列显示正常
- 手测 multi 编辑态：checkbox + letter + meta 3 列布局不破
- 手测非 multi 模式：idx + meta 2 子项布局不破（regression）

### 14.4 B3 — extract-order-card 左右对齐 + 共用滚动条（用户 round 3 拍板方案 A）

#### 14.4.1 用户期望（截图佐证 + round 3 拍板）

- 左侧"文件顺序" x.行 与 右侧"大账号信息" x.行 **上下边界横线对齐**（同一 row 横向并排）
- **共用一个滚动条**（左右一起滚）
- 用户原话："文件顺序栏里的 x.行 与 大账号信息栏里的 x.行的上下边界横线是平行的；共用一个滚动条"
- ✓ **用户 round 3 拍板方案 A**：单一 grid 表格 + 每行横跨左右 + 外层单 overflow + 移除 `.extract-order-list` 内层 overflow，~20 行 HTML+CSS

#### 14.4.2 现状（PM grep）

`renderer-dialogs.js:1683-1701` 当前结构：两个独立 `.extract-order-list` 子 div，各自 overflow，行数不同步。
`styles-gemini-extra.css:1285-1315`：`.extract-order-card width: min(100%, 760px)` + `.extract-order-body { display:grid; grid-template-columns: 1fr 1.15fr; gap:28px }` + `.extract-order-list { display:flex; flex-direction:column }`（R6c 已加 `max-height: calc(100vh - 280px) + overflow-y:auto`）

#### 14.4.3 实施方案 A（用户拍板）

**HTML 改造**（`renderer-dialogs.js:1683-1701` + 1707-1779 渲染逻辑）：

```html
<!-- 现状 -->
<div class="extract-order-body">
  <div>
    <div class="extract-order-col-header">文件顺序：</div>
    <div class="extract-order-list extract-file-list"></div>
  </div>
  <div>
    <div class="extract-order-col-header">大账号信息：</div>
    <div class="extract-order-list extract-account-list"></div>
  </div>
</div>

<!-- 改后：单一 grid 父容器，每行横跨左右；外层单 overflow -->
<div class="extract-order-body">
  <div class="extract-order-col-header">文件顺序：</div>
  <div class="extract-order-col-header">大账号信息：</div>
  <!-- 每行 = 一对左右 cell，按 index 联动 extractableRows + extractedAccounts -->
  <!-- 行内容 dev 阶段渲染 -->
</div>
```

**CSS 改造**（`styles-gemini-extra.css:1286-1296`）：

```css
/* 现状 */
.extract-order-body {
  padding: 18px 28px 8px;
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 28px;
}
.extract-order-list {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 280px);  /* R6c 已加 */
  overflow-y: auto;                  /* R6c 已加 */
}

/* 改后（方案 A）*/
.extract-order-body {
  padding: 18px 28px 8px;
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 0 28px;                      /* row gap 0（行边界横线由 border-bottom 提供）；col gap 28 */
  max-height: calc(100vh - 220px);  /* ⭐ 外层单 overflow */
  overflow-y: auto;
}
/* ⭐ 删除 .extract-order-list 类（DOM 重组后不再使用），或保留空规则避免误用 */

/* col-header sticky 在顶部 */
.extract-order-col-header {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fff;
  font-size: 12px;
  color: var(--muted);
  font-weight: 500;
  padding: 0 0 8px;
}

/* 每行的左右 cell 共用 .extract-order-row 类，但现在跨 grid column 各占 1 列 */
.extract-order-row {
  display: grid;
  grid-template-columns: 24px 1fr auto;  /* idx | name | edit（右侧才有 edit）*/
  align-items: center;
  gap: 12px;
  padding: 10px 6px;
  border-bottom: 1px solid var(--line-soft);
}
/* 注：因 grid row 自动对齐，左右 .extract-order-row 即使 height 不一致也会按本 row 最大 height 对齐 */
```

**JS 渲染**（`renderer-dialogs.js:1707-1779` 重构）：

```js
const extractFileListContainer = extractDialog.querySelector('.extract-order-body');
// 删除单独的 extract-file-list / extract-account-list 子 div 引用

const maxRows = Math.max(extractableRows.length, extractedAccounts.length);
for (let i = 0; i < maxRows; i++) {
  const fileRow = extractableRows[i];
  const accountRow = extractedAccounts[i];

  // 左 cell：文件顺序
  const leftCell = document.createElement('div');
  leftCell.className = 'extract-order-row';
  if (fileRow) {
    const fullName = fileRow.fileName || '';
    const rowSuffix = fileRow.sourceRowNumber ? ` 第${fileRow.sourceRowNumber}行` : '';
    const displayName = truncateFileName(fullName, 20) + rowSuffix;
    leftCell.innerHTML = `<span class="eo-idx">${i + 1}.</span><span class="eo-name" title="${escapeHtml(fullName + rowSuffix)}">${escapeHtml(displayName)}</span><span></span>`;
  }
  extractFileListContainer.appendChild(leftCell);

  // 右 cell：大账号信息（含编辑按钮）
  const rightCell = document.createElement('div');
  rightCell.className = 'extract-order-row';
  if (accountRow) {
    rightCell.dataset.index = i;
    rightCell.dataset.merchantId = accountRow.merchantId;
    rightCell.dataset.currency = accountRow.currency;
    // ... 原 extractedAccounts.forEach 内 indexSpan / textSpan / editBtn / editContainer 逻辑搬到这里 ...
  }
  extractFileListContainer.appendChild(rightCell);
}
```

**关键不变量**：
- grid auto row 自动对齐：左右 cell 按本 row 最大 height 取齐，文件顺序行与大账号行**上下边界对齐**
- 单 overflow：`.extract-order-body` 外层滚动，左右一起滚
- 编辑按钮逻辑（textSpan / editBtn / editContainer / editBtn click handler / editContainer .extract-edit-done click handler）保留不动，仅 DOM 父容器从 `.extract-account-list` 改为右 cell
- R6c 的 `max-height + overflow-y` 从 `.extract-order-list` 迁移到 `.extract-order-body`

#### 14.4.4 验收

- 手测：导入 ≥ 10 文件 → 弹"确认大账号顺序" → 左右两栏行高对齐（一行 = 一对左右 cell）
- 手测：滚动单滚动条 → 左右一起滚
- 手测：编辑按钮 + 输入框展开 → 该 row 高度变化 → 对齐 row 跟随变化（grid auto row）
- 手测：导入 ≥ 30 文件 → 单滚动条自动出现，能滚到底部
- preview 必跑：extract-order-card 视觉验证（详 §16.3 矩阵）

#### 14.4.5 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | DOM 重组影响编辑按钮 click handler 闭包引用 | 保留 textSpan/editBtn/editContainer 子项引用 + click handler；仅父容器变 |
| 🟢 低 | 左右行数不一致（extractableRows.length ≠ extractedAccounts.length）| max(N, M) 循环，少的一侧渲染空 cell 占位 |
| 🟢 低 | preview screenshot 大变 | preview 必跑（已列入 §16.3）|

### 14.5 B4 — ≥20 文件场景滚动条不可用 ⏸ 待 dev 实测

#### 14.5.1 现状（PM grep）

- `.ba-scroll-container { height: 100%; min-height: 360px; max-height: 52vh; }` 高度链已通
- preview fixture `applyBigAccountSelectionMultiPreviewState` 仅 5 文件（`renderer-previews.js:627-636`）
- 用户实测 ≥20 文件场景"滚动条不可用"（不是"不出现"）

#### 14.5.2 真根因待 dev 实测

可能原因：
- 候选 A：`.ba-scroll-container max-height: 52vh` 在某 modal 高度 / `min-height: 600px` 冲突时计算异常
- 候选 B：rendererfileListContainer / orderListContainer 内 padding 撑高
- 候选 C：滚动条**视觉可见但无法拖动 / 滚轮无响应**（pointer-events / z-index 异常）
- 候选 D：R6a grid 改动后行高变化导致总高 < max-height 不触发滚动

#### 14.5.3 spec 阶段必跑步骤

1. **新增 preview fixture** `applyBigAccountSelectionMultiLargePreviewState`（≥20 文件，rows[0..19]）
2. dev 实测打开此 preview → 观察"不可用"具体表现（不出现 / 出现但不能滚 / 滚到一半卡）
3. 用 DevTools 检查 `.ba-scroll-container` computed height + max-height + overflow
4. 根据实测调试方向：可能需调 `.big-account-selection-split { min-height: min(600px, 80vh) }` 或 `.ba-scroll-container { max-height: min(52vh, calc(100vh - 280px)) }` 等

#### 14.5.4 验收

- 手测 ≥20 文件 + multi 模式：垂直滚动条出现 + 鼠标 / 滚轮可滚到底部 + 滚到底后能看到最后一行完整
- 手测 5 文件：滚动条不出现（regression baseline）

### 14.6 B5 🚨 — R3 wiring 漏接审计（用户发现 1 处 + PM 发现 2 处）

#### 14.6.1 PM 全局 grep 审计（事实清单）

| 函数 | 文件:行号 | 现状 | R3 wiring |
|---|---|---|---|
| `setStatus` | renderer.js:545 | ✓ 走 updateStatusBox | 接 |
| `setNewAccountStatus` | renderer.js:558 | ✓ 走 updateStatusBox | 接 |
| `setBankBuReconStatus` | renderer.js:3911 | ✓ 走 updateStatusBox | 接 |
| `setBizOpReconStatus` | renderer.js:4136 | ✓ 走 updateStatusBox（含 R3 注释） | 接 |
| **`updateBankStatementUi`** | **renderer.js:3298-3331** | ❌ L3330 `textEl.textContent = text;` | **🚨 漏接** |
| **`updateReconIdFixUi`** | **renderer.js:3647-3686** | ❌ L3684 `textEl.textContent = text;` | **🚨 漏接** |
| **`setAcquiringBillCurrencyStatus`** | **renderer.js:4245-4252** | ❌ L4248 `text.textContent = message;` | **🚨 漏接（用户发现）** |
| `pendingStatusBox` 渲染 | renderer.js:259 | 仅 element 引用，无 set 函数（PM grep `pending.*status` / `renderPendingStatus` / `applyPendingStatus` 均无）| ✓ 无需修 |

#### 14.6.2 修复方案

**3 处全部改走 updateStatusBox 入口**（自动获得 R3 `replace(/：/g, '：\n')` + null/undefined 兜底）：

```js
/* renderer.js:3298-3331 updateBankStatementUi 现状 */
function updateBankStatementUi() {
  if (!elements.bankStatementStatusBox) return;
  const bs = state.bankStatementSession;
  ...
  let text;
  let tone = 'info';
  if (!bs) { text = '欢迎使用小助手'; tone = 'neutral'; }
  ...
  const textEl = elements.bankStatementStatusBox.querySelector('.status-box-text');
  if (textEl) textEl.textContent = text;          // ❌ 漏接
  elements.bankStatementStatusBox.dataset.tone = tone;
  ...
}

/* 改后 — 走 updateStatusBox（自动 R3 换行 + null 兜底）*/
function updateBankStatementUi() {
  if (!elements.bankStatementStatusBox) return;
  const bs = state.bankStatementSession;
  ...
  let text;
  let tone = 'info';
  if (!bs) { text = '欢迎使用小助手'; tone = 'neutral'; }
  ...
  // B5 round 3：走 updateStatusBox 入口（R3 wiring）+ 保留按钮 disabled 逻辑
  updateStatusBox(elements.bankStatementStatusBox, text, tone);
  ...
  // 按钮 disabled 控制（保留 L3334-3337）
  if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = false;
  ...
}
```

**setAcquiringBillCurrencyStatus 同样改造**（详 spec §9.6）。
**updateReconIdFixUi 同样改造**（详 spec §9.6）。

#### 14.6.3 加固：render-status-box smoke wiring 审计

新增 smoke 断言（详 spec §9.6.4）：

```js
// scripts/smoke/render-status-box.js（已在 R3 创建）追加 wiring 审计
// grep 整个 src/renderer.js，所有 statusBox.querySelector('.status-box-text').textContent =
// 应该全部出现在 updateStatusBox 函数内（renderer.js:519-538）；非此函数内的直写视为漏接
const rendererSource = fs.readFileSync('src/renderer.js', 'utf8');
const directWrites = rendererSource.match(/\.status-box-text['"`\]]?\)?\.textContent\s*=/g) || [];
// 应该只在 updateStatusBox 函数内出现 1 次
assert.ok(directWrites.length <= 1,
  `B5 wiring 审计：发现 ${directWrites.length} 处 .status-box-text.textContent = 直写，应只在 updateStatusBox 内 1 次`);
```

#### 14.6.4 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟡 中 | 3 处改造 + 1 处 smoke 审计；若 updateStatusBox 调用方文案有意区别 textContent vs innerHTML | 全部走 textContent（updateStatusBox 默认行为）；R3 已删 bizOpRecon innerHTML hack，B5 与之对齐 |
| 🟢 低 | smoke 审计可能误报"updateStatusBox 函数内的 textContent" | 断言 `<= 1`（允许 updateStatusBox 本身）；如未来扩展可改正则更精确 |

### 14.7 F4 删空 — R1 display + handler 同步 `>= 1`

#### 14.7.1 PM 二次发现 — R1 改了一半

R1 round 2 commit 只改了 L6716 **display 条件**：

```js
${isReadonly || config.billTypes.length === 1 ? '' : '<button remove>'}  // R1: <= 2 → === 1
```

**但 L6794 handler 仍卡老逻辑**：

```js
if (Number.isFinite(idx) && config.billTypes.length > 2) {  // ⚠️ R1 漏改！仍 > 2
  config.billTypes.splice(idx, 1);
  ...
}
```

用户测试：billTypes = 2 行 → 按钮显示（R1 改后），点击 → handler `length > 2` 不成立 → 删不掉。

#### 14.7.2 用户期望（删空）

- 删除按钮**始终显示**（即使只剩 1 行也能删到 0 行）
- 保存仍校验 ≥ 1 行报错（已就绪 L5832）

#### 14.7.3 修复方案

```js
/* L6716 display 现状 */
${isReadonly || config.billTypes.length === 1 ? '' : '<button remove>'}

/* 改后（删空，永远显示按钮）*/
${isReadonly ? '' : '<button remove>'}
```

```js
/* L6794 handler 现状 */
if (Number.isFinite(idx) && config.billTypes.length > 2) {
  config.billTypes.splice(idx, 1);
  ...
}

/* 改后（允许删到 0 行）*/
if (Number.isFinite(idx) && config.billTypes.length >= 1) {
  config.billTypes.splice(idx, 1);
  ...
}
```

#### 14.7.4 资金红线兜底（已就绪不动）

`renderer-dialogs.js:5832` `if (!Array.isArray(c.billTypes) || c.billTypes.length < 1) errors.push('账单类型至少需要 1 行');` 保存时校验 ≥ 1 行报错，符合用户期望"支持删空，保存时拦截"。

#### 14.7.5 验收

- 手测：billTypes 2 行 → 按钮显示 → 点击 → 删除成功（length=1）
- 手测：billTypes 1 行 → 按钮显示 → 点击 → 删除成功（length=0）
- 手测：billTypes 0 行 → 保存校验报"账单类型至少需要 1 行"
- 手测：用户主动加回（点 "+ 新增账单类型"）→ length 恢复

#### 14.7.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 删空后用户可能困惑（看 dialog 全空）| 用户主动操作（点删除按钮）；提示来自保存校验，不会破坏现有数据 |
| 🟢 低 | reconFields / markValue 引用已删 billType seq | L6796-6803 已有"重排 seq + 校正 reconFields/markValue 引用回退到 1" 兜底逻辑，R1 改前已稳定 |

---

## 十五、F8 — 银行对账单结果文件第 2 个 sheet 放未命中场景规则的行 🚨 资金红线

### 15.1 用户原话 + 拍板定义

"用银行对账单处理模块生成的处理结果文件，第二个 sheet 放导入的银行对账单文件里未经过处理的行数据"

**用户 round 3 拍板定义**："未处理" = **"未命中场景规则的行"** —— 跑完所有 enabled scenarios (C1 extract-recon-id / C2 offset-bill-mark / C3 gateway-recon-join) 的 scenario-dispatcher first-match-wins 后，**没有任何 scenario 命中**的行。

**不是** v2.1.x 阶段的 `skippedRows`（Credit + Debit 都 0/空 的静默 skip）；那个仍按现状走 error report path。

### 15.2 PM 验证现状（scenario-dispatcher）

| 文件:行号 | 现状 | F8 改造点 |
|---|---|---|
| `src/main-process/scenario-dispatcher.js:122-123` | `const modifiedRows = bankRows.filter((r) => rowLockSet.has(r._rowId));` | ✓ **已有 rowLockSet 记录命中行**；F8 改造 = 一行 filter 反向得 unmatchedRows |
| `src/main-process/scenario-dispatcher.js:138-151` | dispatcher return `{ modifiedRows, modifications, errorReport, stats: { totalRows, hitRowCount, ... } }` | F8 改 return 增加 `unmatchedRows` 字段（保持 modifiedRows 行为不变 = **资金红线不动**）|
| `src/main.js:2858` | `BANK_STATEMENT_CATEGORIES = new Set(['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join'])` | ✓ dispatcher 入参已限定 C1/C2/C3（C4 不在内，符合定义） |
| `src/main.js:5948-5957` | `writeWorkbookRows({ rows: detailExportRows, outputFilePath: detailOutput.outputFilePath })` | **明细文件**单 sheet writer → F8 改为追加第 2 sheet |
| `src/main.js:6021` `writeBalanceWorkbook` | **余额文件**已支持多 sheet（per currency） | **不在 F8 范围**（F8 仅明细文件加 sheet） |
| `src/backend/file-service/writers.js:223-260 writeWorkbookRows` | 单 sheet 接口 | F8 改造为支持可选 `unmatchedRows` 入参追加第 2 sheet |

**PM 关键发现**：dispatcher L122-123 已有 `rowLockSet` 命中行集合 — F8 改造 = **一行 filter 反向**得到未命中行，**改动量极小**且**完全不影响 matchedRows 集合**（资金红线不动）。

### 15.3 实施方案

#### 15.3.1 scenario-dispatcher 改造

```js
// scenario-dispatcher.js L122-151 现状
const modifiedRows = bankRows
  .filter((r) => rowLockSet.has(r._rowId))
  .map((r) => { ... });

return {
  modifiedRows,
  modifications: allModifications,
  errorReport: allWarnings,
  stats: {
    totalRows: bankRows.length,
    hitRowCount: modifiedRows.length,
    scenarioHitCount,
    hitScenarioIds,
    warningCount: allWarnings.length,
    skippedC3Count,
    skippedC4Count
  }
};

// 改后 — 增加 unmatchedRows 字段，资金红线 modifiedRows 完全不动
const modifiedRows = bankRows
  .filter((r) => rowLockSet.has(r._rowId))
  .map((r) => { ... });
// ⭐ F8 新增：反向 filter 得未命中行；保留原始 bankRows 顺序 + 不映射（用户要原始行）
const unmatchedRows = bankRows.filter((r) => !rowLockSet.has(r._rowId));

return {
  modifiedRows,
  unmatchedRows,                  // ⭐ F8 新增
  modifications: allModifications,
  errorReport: allWarnings,
  stats: {
    totalRows: bankRows.length,
    hitRowCount: modifiedRows.length,
    unmatchedRowCount: unmatchedRows.length,  // ⭐ F8 新增
    scenarioHitCount,
    hitScenarioIds,
    warningCount: allWarnings.length,
    skippedC3Count,
    skippedC4Count
  }
};
```

**关键不变量（资金红线）**：
- `modifiedRows` 集合**与 v2.1.6 完全一致**（filter 条件 `rowLockSet.has(r._rowId)` 不动）
- `unmatchedRows = bankRows - modifiedRows`（仅反向 filter，不影响匹配判定）
- `modifiedRows.length + unmatchedRows.length === bankRows.length`（无遗漏 / 无重复）
- first-match-wins 行为不动

#### 15.3.2 writers.js 改造

`writeWorkbookRows` 扩展可选 `unmatchedRows` 入参：

```js
// src/backend/file-service/writers.js:223-260 现状
function writeWorkbookRows({ rows, outputFilePath, sheetName = 'COMMON' }, formatters) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  applyExportFieldFormats(ws, rows, formatters);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  applyWatermark(wb);  // v2.1.6
  XLSX.writeFile(wb, outputFilePath);
}

// 改后 — 可选 unmatchedRows 触发第 2 sheet
function writeWorkbookRows({ rows, outputFilePath, sheetName = 'COMMON', unmatchedRows = null }, formatters) {
  const wb = XLSX.utils.book_new();

  // 第 1 sheet：主明细
  const ws = XLSX.utils.json_to_sheet(rows);
  applyExportFieldFormats(ws, rows, formatters);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  // ⭐ F8 第 2 sheet：未命中场景行（原始列，不映射）
  if (Array.isArray(unmatchedRows)) {
    // 即使 0 行也输出表头 sheet（与 v2.1.6 acquiring-bill-currency 差异表"0 差异行仍输出"一致）
    const unmatchedWs = unmatchedRows.length > 0
      ? XLSX.utils.json_to_sheet(unmatchedRows.map((r) => stripInternalFields(r)))
      : XLSX.utils.aoa_to_sheet([Object.keys(unmatchedRows[0] || rows[0] || {}).filter((k) => !k.startsWith('_'))]);
    XLSX.utils.book_append_sheet(wb, unmatchedWs, '未命中场景行');
  }

  applyWatermark(wb);
  XLSX.writeFile(wb, outputFilePath);
}

// stripInternalFields helper：删除 _rowId / _hitScenarioId 等内部字段
function stripInternalFields(row) {
  const cleaned = {};
  for (const k of Object.keys(row)) {
    if (!k.startsWith('_')) cleaned[k] = row[k];
  }
  return cleaned;
}
```

#### 15.3.3 main.js 调用方改造

```js
// src/main.js:5948-5957 现状
writeWorkbookRows({
  rows: detailExportRows,
  outputFilePath: detailOutput.outputFilePath
});

// 改后 — 把 dispatcher 返回的 unmatchedRows 传入
writeWorkbookRows({
  rows: detailExportRows,
  outputFilePath: detailOutput.outputFilePath,
  unmatchedRows: processingResult?.unmatchedRows || []  // ⭐ F8 新增（来源 dispatcher）
});
```

**注**：spec 阶段需 PM 追加 grep `processingResult` 在哪里组装，确保 `unmatchedRows` 字段从 dispatcher 流到 main.js export 路径。

### 15.4 sheet 命名 + 列结构（用户拍板）

| 项 | 值 |
|---|---|
| sheet 名 | `未命中场景行` |
| 列结构 | **保留原始银行对账单行所有列**（不映射，不加诊断列）—— 用户原话"只要原始行，不要诊断" |
| 空数据 | 即使 0 行也输出含表头的空 sheet（与 v2.1.6 acquiring-bill-currency 差异表"0 差异行仍输出表头版"一致） |
| 内部字段过滤 | `_rowId` / `_hitScenarioId` / `_modifiedColumns` 等 `_` 前缀字段必须 strip（不暴露给用户）|

### 15.5 验收标准

| AC 编号 | 验收条件 |
|---|---|
| AC-F8-1 | 导入测试样本含 N 行 → 跑 C1/C2/C3 dispatcher → 处理结果明细 xlsx 含 2 个 sheet：主明细 + 未命中场景行；**`modifiedRows.length + unmatchedRows.length === N`**（无遗漏） |
| AC-F8-2 | 未命中场景行 sheet 列 = **原始银行对账单行所有列**（无"未处理原因"列）|
| AC-F8-3 | 内部字段 `_rowId` / `_hitScenarioId` / `_modifiedColumns` 不出现在第 2 sheet |
| AC-F8-4 | 导入测试样本所有行都命中场景 → 第 2 sheet 仅含表头（0 行） |
| AC-F8-5 | 导入测试样本所有行都未命中场景 → 第 2 sheet 含全部 N 行 |
| AC-F8-6 | 混币种场景：每个 currency 明细文件都含第 2 sheet（各文件独立的 dispatcher 结果）|
| AC-F8-7 | **🚨 资金红线**：smoke "matchedRows count 与 v2.1.6 baseline 一致"（dispatcher first-match-wins 行为不动）|
| AC-F8-8 | smoke：`modifiedRows + unmatchedRows = 输入总行数`（无遗漏） |
| AC-F8-9 | smoke：`modifiedRows ∩ unmatchedRows = ∅`（无重复行，dispatcher first-match-wins 互斥）|

### 15.6 ⏸ 待澄清子项（不阻塞 spec，dev 阶段可决策）

PM 在 spec §（F8 节）标 ⏸：

1. **"处理结果文件" 是否仅指明细文件？** PM 假设是（用户没明确）：
   - 明细文件（`writeWorkbookRows` 出口）：F8 加第 2 sheet ✓
   - 余额文件（`writeBalanceWorkbook` 出口）：**不加**（与未命中场景无关，余额是基于已处理的明细累加）
   - PM 推荐：仅明细文件加第 2 sheet
2. **一次导出可能产 N 个文件（每币种 / 每大账号），是否每个文件都加 sheet vs 单独产 1 个"未命中行汇总"文件？**
   - PM 推荐：**每个明细文件都加 sheet**（与文件本身上下文一致，用户对单文件可独立审计；且 v2.1.6 acquiring-bill-currency 差异表也是 1 对 1 输出）
   - 替代方案（不推荐）：单独"未命中汇总"文件（用户需多文件对照，UX 差）

### 15.7 风险与回归保护 🚨 资金红线

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🔴 **资金红线** | scenario-dispatcher 行为变化可能影响 C1/C2/C3 命中数 | spec §15.3.1 关键不变量：`modifiedRows` filter 条件不动；仅**反向 filter** 加 unmatchedRows；smoke AC-F8-7 强制"matchedRows count == v2.1.6 baseline" |
| 🟡 中 | 主功能 writer 改造影响所有 currency 文件 | smoke 必跑混币种场景；旧 writer 单测全部回归通过 |
| 🟡 中 | dispatcher 入参限定 C1/C2/C3，但**用户启用 C4 gateway 子模式场景**时是否影响 unmatchedRows 定义？ | C4 走独立流水线（`main.js:2858` 注释），不进 dispatcher → 不影响 unmatchedRows；spec §15.3.1 已注明 |
| 🟢 低 | xlsx 文件大小增加 | 0 unmatchedRows 时只多表头 ~1KB；N 行时按 N × 列数线性增长 |
| 🟢 低 | watermark applyWatermark(wb) 顺序需在 writeFile 前 | 沿用 v2.1.6 Module A 范式（spec §2.1）|
| 🟢 低 | `_` 前缀字段泄露 | `stripInternalFields` helper 强制过滤；smoke AC-F8-3 断言 |

⚠️ **重要变量检查**：F8 修改 `runScenarioDispatcher` 返回 schema（新增 `unmatchedRows` + `stats.unmatchedRowCount`）；`writeWorkbookRows` 加可选入参 `unmatchedRows`。dispatcher 是 **C1/C2/C3 资金红线主路径**，建议 `/check-vars` 评估 `runScenarioDispatcher` 升格 Critical 层。

⚠️ **previews 不涉及**：F8 仅改 writer 输出，无 UI 改动。

---

## 十六、round 4 — 用户手测 round 3 后反馈修复（B1 + B2 + B4 全部立即实施）

### 16.1 背景与目标

v2.1.7 round 3 落地后用户手测反馈 3 项未通过：

| 编号 | 一句话描述 | 原 round 3 关联 | 用户拍板状态 |
|---|---|---|---|
| B1（round 4）| F1 radio 位置仍不对，用户拍板 Layout-1（左列纵向"条件 + AND + OR"，与右列 conditions 并排）| round 3 B1（radio 放在 .scenario-config-multi-wrap 内部错位）| ✓ 立即入 Dev |
| **B4（round 4）** | ≥20 文件场景滚动条没出现 | round 3 B4 / R6a | ✓ **PM 真根因已锁定**：grid 子项缺 `min-height: 0` 穿透 max-height；1 行 CSS 双写修复 |
| **B2（round 4）** | multi 完成态字母没显示（被 B4 阻塞手测）| round 3 B2 / R6a | ✓ PM 双路径 sketch（路径 A 修 letterSpan / 路径 B 改 grid minmax(24px,auto)）；dev 修完 B4 后实测选 |

### 16.2 B1（round 4）— F1 radio Layout-1（用户拍板）

#### 16.2.1 用户原话 + 拍板 Layout

用户原话："AND/OR 单选按钮的位置置于'条件'row里的文本'条件'下方一行，而不是在整个row的下方"

**Layout-1（用户拍板）**：

```
条件 ⓘ     | 条件1▼
● AND      | 条件2▼
○ OR       | + 新增条件
```

左列纵向堆叠 **label "条件" + AND radio + OR radio**；右列是 conditions 列表 + "+ 新增条件" 按钮。

#### 16.2.2 现状（PM grep）

- `src/renderer-dialogs.js:6326-6346`（dev round 3 commit 25a492c 落地状态）：radio 放在 `.scenario-config-multi-wrap` **内部**（右列末尾，"+ 新增条件"按钮下方），**与用户期望相反**
- `src/styles-gemini-extra.css:2274-2281 .scenario-config-label`：`width: 120px; font-weight: 500; color: #3c4043;` —— **无 font-size，继承父级默认 ~14px**
- `src/styles-gemini-extra.css:2477-2482 .scenario-config-feature-grid label`：`font-size: 13px;`（"筛选字段" label 基准）
- `src/styles-gemini-extra.css:2284-2286 .scenario-config-row-multi .scenario-config-label`：`padding-top: 6px;`（多行 row label 顶端对齐）

**字体差异确认**：`.scenario-config-label` 14px（默认） vs `.scenario-config-feature-grid label` **13px**；round 4 B1 radio label 必须显式设 **13px** 与"筛选字段"对齐。

#### 16.2.3 改动 diff（HTML）

```html
<!-- L6325-6346 现状（round 3 dev 落地）-->
<div class="scenario-config-row scenario-config-row-multi">
  <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
    <!-- B1 round 3：radio 在 .scenario-config-multi-wrap 内部 — 用户反馈位置错 -->
    <div class="scenario-config-logic-inline" style="margin-top:8px;">
      <label>...AND radio...</label>
      <label>...OR radio...</label>
    </div>
  </div>
</div>

<!-- 改后（B1 round 4 Layout-1）：左列纵向 label + radio；右列 conditions -->
<div class="scenario-config-row scenario-config-row-multi">
  <!-- ⭐ B1 round 4：新增左列容器，纵向堆叠 label + AND + OR radio -->
  <div class="scenario-config-label-stack">
    <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>
    <div class="scenario-config-logic-inline">
      <label class="scenario-config-logic-option">
        <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        AND（同时满足）
      </label>
      <label class="scenario-config-logic-option">
        <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
        OR（满足任一）
      </label>
    </div>
  </div>
  <div class="scenario-config-multi-wrap">
    <div class="scenario-config-multi-rows" data-multi="conditions"></div>
    ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
  </div>
</div>
```

#### 16.2.4 改动 diff（CSS）

```css
/* styles-gemini-extra.css 新增（在 .scenario-config-label 附近，约 L2287 后）*/

/* B1 round 4：scenario-config-label-stack 容器 — 左列纵向堆叠 label + radio 组 */
.scenario-config-label-stack {
  flex-shrink: 0;
  width: 120px;           /* 与 .scenario-config-label 同宽，保持左列对齐 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-self: flex-start; /* 顶端对齐（取代原 .scenario-config-row-multi .scenario-config-label padding-top 效果）*/
  padding-top: 6px;       /* 与原 padding-top: 6px 对齐 */
}

/* B1 round 4：radio 内部 inline 容器 */
.scenario-config-logic-inline {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* B1 round 4：radio label 字体 13px（与 .scenario-config-feature-grid label 对齐）*/
.scenario-config-logic-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;        /* ⭐ 字体一致性：与"筛选字段" label 对齐 */
  font-weight: normal;    /* 不复用 .scenario-config-label 的 font-weight: 500 */
  color: #3c4043;
  cursor: pointer;
}
.scenario-config-logic-option input[type="radio"] {
  margin: 0;
  cursor: pointer;
}
```

#### 16.2.5 关键不变量

- **资金红线护栏 R5 三层全部不动**（默认 config / pickConditionsLogicChecked / 引擎 fallback OR）
- 仅 DOM 重组 + CSS 新规则；JS 逻辑（checkedLogic / 事件绑定）不动
- 老 `.scenario-config-logic-stack` / `.scenario-config-logic-stack-option`（round 2 R5 留下的）若已不被任何 HTML 引用可删除（spec 阶段确认）

#### 16.2.6 验收

- 手测新建 C1 场景 → dialog 显示左列"条件 ⓘ\nAND（同时满足）\nOR（满足任一）"纵向 + 右列 conditions 列表
- 手测编辑老 scenario（无 conditionsLogic）→ 左列 OR radio 选中（fallback OR）
- 手测编辑新 scenario（写过 'AND'）→ 左列 AND radio 选中
- 手测 radio label 字号肉眼接近"筛选字段" label（13px）
- F1 / R5 / B1 round 3 / B1 round 4 preview 必跑（每次 B1 变动都重跑）

#### 16.2.7 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | DOM 重组影响 round 2/3 已落地行为 | 资金红线护栏三层不动；preview 必跑视觉验证 |
| 🟢 低 | 老 logic-stack CSS class 残留 | spec 阶段 grep `scenario-config-logic-stack` 全文确认无引用后可删除 |

### 16.3 B4（round 4）— ≥20 文件滚动条没出现（PM 真根因已锁定：grid 子项缺 min-height:0 穿透 max-height）

#### 16.3.1 PM 完整高度链 grep 验证

**完整高度链**（styles-gemini-extra.css 行号已 PM grep 实测）：

```
.modal-card (max-height: calc(100vh - 56px))                      ← L16-24
  .big-account-selection-card (width: min(100%, 1200px); min-height: 540px)  ← L191
    .big-account-selection-split (min-height: 600px)               ← L192
      .big-account-split-body (flex: 1; overflow: hidden)          ← L357-360
        .ba-scroll-container (display: grid; max-height: 52vh;
                              min-height: 360px)                   ← L361-367
          .big-account-split-left / .big-account-split-right       ← L369-376
              (display: flex; overflow: hidden)
              ⚠️ ⚠️ ⚠️ 缺 min-height: 0 ⚠️ ⚠️ ⚠️
            .big-account-split-header (40px 固定高度)
            .big-account-file-list / .big-account-order-list       ← L385-390
                (flex: 1; overflow-y: auto)
```

#### 16.3.2 真根因（经典 CSS 陷阱）

**`.big-account-split-left/.big-account-split-right` 是 `.ba-scroll-container` 的 grid 子项**。

CSS 规范：**grid item 默认 `min-height: auto`，等于 content size**。

后果（20+ 文件场景）：
1. content size = header (40px) + file-list flex:1 撑满（≈ 20 × 40px = 800px）→ split-left 内容总高 ≈ 840px
2. grid item 默认 `min-height: auto = 840px` → **不允许收缩到 < 840px**
3. **`.ba-scroll-container max-height: 52vh = 562px`（1080p 下）被 grid item 穿透**
4. ba-scroll-container 实际高度被 grid item 撑到 ≈ 840px
5. 父 `.big-account-split-body { flex:1; overflow:hidden }` 把超出 modal 可用高度的部分**隐藏**
6. **file-list 自己的 `overflow-y: auto` 永远不触发**（flex:1 在 grid item 里一直能撑下，scrollHeight = clientHeight）
7. **用户看不到底部 + 没有滚动条产生**

#### 16.3.3 修复方案（1 行 CSS）

```css
/* styles-gemini-extra.css L369-376 现状 */
.big-account-split-left,
.big-account-split-right {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #fff;
}

/* 改后（B4 round 4 真根因 fix）*/
.big-account-split-left,
.big-account-split-right {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #fff;
  /* ⭐ B4 round 4：让 grid 子项允许收缩到 < content size，让父 .ba-scroll-container max-height:52vh 真正生效；
     不加这行 → grid item min-height: auto = content size 穿透 max-height → file-list overflow-y:auto 永不触发 */
  min-height: 0;
}
```

**双写**：`src/styles-gemini-extra.css` + `Clear/styles-gemini-extra.css`（Dev 双路径范式，与 R6a / R6c 一致）。

#### 16.3.4 dev round 3 scrollbar 强制可见 CSS 保留

**不要删** dev round 3 加的 `scrollbar-width: thin` + `scrollbar-color` + `::-webkit-scrollbar` 规则（styles-gemini-extra.css:391-408）—— 那是另一回事（macOS overlay-style 兜底，让 thin scrollbar 持续可见而不是 hover 才出现）。

**配合本次 `min-height: 0` 一起完整覆盖**两阶段：
- B4 round 4 修：`min-height: 0` → overflow-y:auto 触发 → 滚动条**产生**
- B4 round 3 留存：`scrollbar-width: thin + ::-webkit-scrollbar` → 滚动条**持续可见**

#### 16.3.5 验收

- 手测 round 3 已建 `applyBigAccountSelectionMultiLargePreviewState` fixture（≥20 文件）→ 弹窗内列表自动出现垂直滚动条
- 手测滚动到底 → 能看到最后一行
- 手测 5 文件 → 列表无滚动条（内容少，预期）
- DevTools 验证：`.big-account-split-left clientHeight < scrollHeight`（实际高度被 max-height cap 在 52vh）

#### 16.3.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | min-height: 0 在某些小屏 / 极端 viewport 下让弹窗收缩过度 | `.ba-scroll-container min-height: 360px` 已就绪 floor 兜底 |
| 🟢 低 | 同 grid 子项规则影响 .big-account-split-right 大账号顺序列表 | 双侧对称改动，行为一致 |

### 16.4 B2（round 4）— multi 完成态字母没显示（被 B4 阻塞 + 候选方案双选）

#### 16.4.1 用户原话佐证

用户原话："截图整个文件顺序列表 + 大账号顺序列表做不到，因为没有滚动条执行操作" —— **B2 完成态字母测试被 B4 阻塞**。修完 B4 后 B2 才能完整手测。

#### 16.4.2 PM 双候选根因（dev 阶段判断现场表现选）

**候选 1：letterSpan textContent 为空**（renderer-dialogs.js:1037）

```js
// L1030-1037
const groupInfo = findGroupByRowIndex(rowIndex);
const group = groupInfo ? multiGroups[groupInfo.groupIndex] : null;
// ...
letterSpan.textContent = group ? `${String.fromCharCode(97 + groupInfo.groupIndex)}.` : '';
```

PM grep `findGroupByRowIndex` (L1191-1198)：

```js
function findGroupByRowIndex(rowIndex) {
  if (pendingGroup && pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
    return { source: 'pending', groupIndex: -1 };  // ⚠️ pendingGroup 时返回 -1
  }
  const idx = multiGroups.findIndex((g) => g.leftBlockRowIndices.includes(rowIndex));
  if (idx >= 0) return { source: 'closed', groupIndex: idx };
  return null;
}
```

**当 source='pending'**（pendingGroup 行）→ `groupIndex = -1` → `multiGroups[-1] = undefined` → `group = falsy` → **`letterSpan.textContent = ''`**

**完成态预期**所有 group 应已 close，但若 closeCurrentGroup 边界 case 漏转 pendingGroup → 字母空。

#### 16.4.3 候选 2：grid 第 2 列宽度被压

R6a `grid-template-columns: auto auto 1fr`（styles-gemini-extra.css L398-400）。dev round 3 加 `.big-account-order-index--alpha { min-width: 24px }` 试图给 letter span 加最小宽度。

**问题**：`min-width` 在 grid item 上**有效**但 **grid track size auto** 不一定按 grid item min-width 来计算 track 宽度。track 宽度受 `grid-template-columns` 控制；如要保证 track ≥ 24px，应改用 **`grid-template-columns: auto minmax(24px, auto) 1fr`**。

#### 16.4.4 修复方案（dev 阶段实测选）

**spec 提供两路 fix sketch，dev 拿到 B4 修复后的 multi 完成态截图判断现场选哪条**：

**路径 A（候选 1 真根因）— 修 letterSpan 渲染**：

```js
// renderer-dialogs.js L1030-1037 改后
const groupInfo = findGroupByRowIndex(rowIndex);
// 显式判 source — 完成态分支只接受 closed group；pending group 走 fallback（空字母 + console.warn）
let letterText = '';
if (groupInfo && groupInfo.source === 'closed' && groupInfo.groupIndex >= 0) {
  letterText = `${String.fromCharCode(97 + groupInfo.groupIndex)}.`;
} else if (groupInfo) {
  // 完成态命中 pending（边界 case）→ 警告 + 显示 '?'（更易调试）
  console.warn(`B2: ba-multi-grouped 分支命中 pendingGroup row ${rowIndex}，字母用 '?' 占位`);
  letterText = '?.';
}
letterSpan.textContent = letterText;
```

**路径 B（候选 2 真根因）— 改 grid track 宽度**：

```css
/* styles-gemini-extra.css L398-400 现状 */
.ba-file-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  ...
}

/* 改后（B2 round 4 候选 2）— minmax 让第 2 列至少 24px */
.ba-file-row {
  display: grid;
  grid-template-columns: auto minmax(24px, auto) 1fr;
  ...
}
```

#### 16.4.5 dev 实施步骤

1. 先修 B4（spec §16.3）让滚动条可用
2. dev 启动 round 3 `applyBigAccountSelectionMultiLargePreviewState` fixture，进入 multi 完成态
3. Chrome DevTools 选一个 grouped 行的 letterSpan：
   - 看 textContent 是否为空 → 真根因 = 候选 1 → 走路径 A
   - textContent 有值但视觉看不见 → 看 Computed width → 真根因 = 候选 2 → 走路径 B
4. 提交修复（可能两路径都需要做）
5. 用户回归测试如仍不行 → round 5

#### 16.4.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 路径 A console.warn 太多噪音 | 仅在边界 case 触发；正常完成态无 warn |
| 🟢 低 | 路径 B grid track minmax 影响非 multi 模式 2 子项 | 非 multi 第 2 列也用 minmax(24px, auto)，但 idx span 自身宽度已 ≥ 24（22px + padding）→ 无视觉差异 |

### 16.5 ⏸ 待澄清子项

- [x] **B2 路径 A vs B**（dev 实测后定）— spec §16.4.4 双路径都已给 sketch；**dev round 4 已选路径 A 修源码**（无 DevTools 实测，基于源码 grep）；round 5 等 B4 修好后用户实测验证；如仍不通过 → round 6 走路径 B
- [x] **round 4 收尾**：用户回归 round 5（B1 微调 + B4 仍不能滚 + B2 跟随）→ round 5 已起

---

## 十七、round 5 — 用户手测 round 4 后反馈修复（B1 微调 + B4 真根因第 2 层）

### 17.1 背景与目标

| 编号 | 一句话描述 | 原 round 4 关联 | 用户拍板状态 |
|---|---|---|---|
| B1（round 5）| 去掉 radio 文本"（同时满足）/（满足任一）"，提示合到"条件" label tooltip | round 4 B1 Layout-1 字号 / 位置 OK，仅文本微调 | ✓ 立即入 Dev（用户拍板）|
| **B4（round 5）真根因第 2 层 🚨** | 第 3 层 flex item `.big-account-file-list/order-list` 缺 `min-height: 0` | round 4 修对第 2 层 grid item 但漏修第 3 层 flex item | ✓ 立即入 Dev（PM grep 锁定）|
| B2（round 5）跟随 | 字母没显示（B4 修好后用户实测验证）| round 4 路径 A 已 commit | ⏸ 等用户实测 → 成功收尾 / 失败 round 6 走路径 B |

### 17.2 B1（round 5）— 去掉 radio 文本 + tooltip 整合

#### 17.2.1 用户原话 + 拍板

用户原话："AND/OR 单选按钮的文本'（同时满足）'和'（满足任一）'去掉，相关提醒加入到 tooltip 里"

#### 17.2.2 现状（PM grep 确认）

`src/renderer-dialogs.js:6358-6368`（round 4 落地状态）：

```html
<span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>
<div class="scenario-config-logic-inline">
  <label class="scenario-config-logic-option">
    <input type="radio" name="conditionsLogic" value="AND" ${checkedLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
    AND（同时满足）
  </label>
  <label class="scenario-config-logic-option">
    <input type="radio" name="conditionsLogic" value="OR" ${checkedLogic === 'OR' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
    OR（满足任一）
  </label>
</div>
```

#### 17.2.3 两个方案 PM 评估

| 方案 | 改动 | 优势 | 劣势 |
|---|---|---|---|
| **方案 A** | 每个 radio 后加独立 ⓘ tooltip：`AND <span class="scenario-config-tooltip" title="同时满足所有条件才命中">ⓘ</span>` | 每个 radio 都有独立提示，悬停可见 | **2 个 ⓘ 图标视觉杂乱**；与"条件" label 自己的 ⓘ 重复 |
| **方案 B（PM 推荐）** | 把"条件" label 的 tooltip 文案扩展为多行说明（含 AND + OR 各自语义），radio 仅保留 "AND" / "OR" 纯文本 | 单 tooltip 视觉干净；与现有 `条件 ⓘ` 自然结合（行 6358）；改动量最小 | 用户需先看到"条件" ⓘ 才能看到 AND/OR 说明（但 ⓘ 位置就在 radio 上方一行，肉眼可达）|

#### 17.2.4 推荐方案 B 改动 diff

```html
<!-- L6358 "条件" label tooltip 现状 -->
<span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑">ⓘ</span></span>

<!-- 改后：tooltip 文案扩展为含 AND + OR 各自说明 -->
<span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的聚合逻辑：&#10;AND — 同时满足所有条件才命中&#10;OR — 满足任一条件即命中">ⓘ</span></span>

<!-- L6360-6367 radio label 现状 -->
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="AND" ...>
  AND（同时满足）
</label>
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="OR" ...>
  OR（满足任一）
</label>

<!-- 改后：仅保留 "AND" / "OR" 纯文本 -->
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="AND" ...>
  AND
</label>
<label class="scenario-config-logic-option">
  <input type="radio" name="conditionsLogic" value="OR" ...>
  OR
</label>
```

**关键不变量**：
- `&#10;` 是 HTML 实体换行符；浏览器 native tooltip 支持多行（macOS / Windows / Linux 行为略不同 — macOS Chrome 显示为 ` / `分隔，Windows 显示真换行）
- 资金红线护栏 R5 三层不动（默认 config / pickConditionsLogicChecked / 引擎 fallback OR）
- 仅文案 + 删括号；radio 行为 / 样式 / 字号（B1 round 4 13px font-weight:normal）全部不动

#### 17.2.5 验收

- 手测 hover "条件" ⓘ → 显示 tooltip：`按下方选择的聚合逻辑：` + 两行 AND / OR 说明
- 手测 radio label 只显示 "AND" / "OR"（无括号文本）
- 手测新建 C1 场景 → 默认 AND checked（资金红线护栏不动）
- 手测编辑老 scenario → fallback OR checked
- F1 preview 必跑（视觉变化）

#### 17.2.6 风险

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 多行 tooltip 在不同 OS 视觉一致性 | `&#10;` 是 HTML 标准；macOS / Windows / Linux 浏览器各自原生兜底；不需新 CSS |
| 🟢 低 | 用户看不到 tooltip（未 hover）| AND / OR 是行业通用术语，用户大概率懂；ⓘ 视觉提示 hover 可看 |

### 17.3 B4（round 5）真根因第 2 层 🚨 — 第 3 层 flex item 也缺 min-height: 0

#### 17.3.1 用户报告 + dev round 4 状态

- dev round 4（commit fb88040）给 `.big-account-split-left/right` 加 `min-height: 0`（grep 验证位置正确，与 spec §10.3.2 sketch 一致）
- 用户实测：**仍不能用鼠标滚轮/trackpad 在列表区域滚动** = overflow **完全没触发**
- **说明 round 4 修对了第 2 层但漏了别的层**

#### 17.3.2 PM 完整高度链 grep 验证 — 3 层 flex/grid 嵌套

PM 用 `grep -B2 -A8` 把 `.modal-card` / `.big-account-selection-card/split` / `.big-account-split-body` / `.ba-scroll-container` / `.big-account-split-left/right` / `.big-account-file-list/order-list` 全部 grep 完整 CSS 后的诊断：

```
.modal-card (display: flex; flex-direction: column; max-height: calc(100vh - 56px); overflow: hidden)
  .big-account-selection-card.big-account-selection-split (同一元素 3 个 class；width: 1200px; min-height: 600px)
  │
  ├── .dialog-header (flex item, 默认 min-height: auto = ~80px content)
  │
  └── .big-account-split-body (flex item: flex:1, overflow:hidden, padding:8px 12px 0)
      ⚠️ 第 1 层 flex item — 缺 min-height: 0
      （1080p 边界 case 才触发，正常 viewport 不需要；防御性兜底）
      │
      └── .ba-scroll-container (display: grid; height: 100%; max-height: 52vh; min-height: 360px)
          │
          ├── .big-account-split-left (grid item: display: flex column, **min-height: 0 ✓** dev round 4)
          │   │
          │   ├── .big-account-split-header (flex item, 40px fixed)
          │   │
          │   └── .big-account-file-list (flex item: flex:1, overflow-y:auto)
          │       ⚠️⚠️⚠️ 第 3 层 flex item — 缺 min-height: 0
          │       默认 min-height: auto = content size（20+ 文件 ~800px）
          │       → 把父 split-left 撑到 800px（即使 split-left min-height: 0）
          │       → 把祖父 ba-scroll-container 撑超 max-height: 52vh = 562px
          │       → 自己 overflow-y: auto 永不触发（scrollHeight = clientHeight）
          │
          └── .big-account-split-right (同上)
```

#### 17.3.3 真根因（经典 flex 嵌套坑）

**flex/grid item 默认 `min-height: auto`**。每一层 flex/grid 嵌套都需要显式设 `min-height: 0`，否则 content size 会从最内层一路向上撑过所有父级的 max-height/height 约束。

**round 4 修对了第 2 层 grid item（split-left/right），但漏了第 3 层 flex item（file-list/order-list）**。结果：
- split-left 自己 min-height: 0 ✓
- 但子 file-list 仍 `min-height: auto = ~800px`
- file-list 把 split-left 撑到 800px
- split-left 把 ba-scroll-container 撑到 800px
- ba-scroll-container max-height: 52vh ≈ 562px **被穿透**
- 父 split-body overflow:hidden 把超出部分**隐藏**
- file-list 自己 overflow-y:auto **永不触发**（scrollHeight = clientHeight）

#### 17.3.4 修复方案（一次性修齐 2 处 + 防御性 1 处）

```css
/* styles-gemini-extra.css L390-400 现状 */
.big-account-file-list,
.big-account-order-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  display: flex; flex-direction: column; gap: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 80, 60, 0.3) transparent;
}

/* 改后（B4 round 5 真根因第 2 层 fix）*/
.big-account-file-list,
.big-account-order-list {
  flex: 1;
  overflow-y: auto;
  /* ⭐ B4 round 5：第 3 层 flex item 也需要 min-height: 0 — 与 round 4 给 .big-account-split-left/right 的 min-height: 0 配套
     默认 min-height: auto = content size → 即使父 split-left 加了 min-height: 0，file-list 自己仍把父撑到 content size 高
     → 祖父 ba-scroll-container max-height: 52vh 仍被穿透 → 自己 overflow-y: auto 永不触发
     这是经典 flex 嵌套坑：每层 flex item 都需要显式 min-height: 0，content size 才不会从最内层一路撑过所有父级约束 */
  min-height: 0;
  padding: 6px 8px;
  display: flex; flex-direction: column; gap: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 80, 60, 0.3) transparent;
}
```

```css
/* 防御性兜底：styles-gemini-extra.css L357-360 .big-account-split-body */
.big-account-split-body {
  flex: 1;
  padding: 8px 12px 0;
  overflow: hidden;
  /* ⭐ B4 round 5 防御性：modal-card 的 flex column 子项；正常 1080p viewport 下 split-body 可用 ~944px 远大于 ba-scroll-container max-height 52vh = 562px 不触发
     但极小屏（< 700px 高）边界 case 下可能 content size 撑超 modal-card max-height: calc(100vh - 56px)
     防御性加 min-height: 0 兜底（不影响主路径，纯极端 case 保护）*/
  min-height: 0;
}
```

**双写**：`src/styles-gemini-extra.css` + `Clear/styles-gemini-extra.css`（与 R6a / R6c / round 4 B4 一致的 Dev 双路径范式）。

#### 17.3.5 dev round 3 scrollbar 强制可见 CSS 保留

**不要删** dev round 3 加的 styles-gemini-extra.css:396-413（`scrollbar-width: thin + scrollbar-color + ::-webkit-scrollbar 8px`）：
- B4 round 5 修：`min-height: 0` 第 3 层 → 滚动条**产生**
- B4 round 3 留存：`scrollbar-width: thin` → 滚动条**持续可见**（防 macOS overlay-style 仅 hover 显示）

#### 17.3.6 验收

- 手测打开 round 3 已建 `applyBigAccountSelectionMultiLargePreviewState` fixture（≥20 文件）→ 列表自动出现垂直滚动条
- 手测能用**鼠标滚轮 + trackpad** 在列表区域滚动到底
- 手测 5 文件 → 列表无滚动条（regression）
- 手测大账号顺序列表（右列）同步出现滚动条（split-right 也修了）
- DevTools：`.big-account-file-list clientHeight < scrollHeight`（内容总高超容器，触发 overflow）；`.big-account-split-left clientHeight ≈ 52vh = ~562px`（被父 max-height cap）

#### 17.3.7 风险与回归保护

| 风险等级 | 风险 | 缓解 |
|---|---|---|
| 🟢 低 | 第 3 层 min-height: 0 在小屏下让 file-list 收缩过度 | `.ba-scroll-container min-height: 360px` 已就绪 floor 兜底；jump 父级 |
| 🟢 低 | split-body 防御性 min-height: 0 影响 modal-card flex 计算 | 主路径下 split-body 实际高度 >> min-height（flex:1 撑大）；不会触发负面影响 |
| 🟢 低 | 仍有第 4 层 flex/grid 嵌套漏修 | PM grep 完整高度链已穷举 3 层（spec §17.3.2）；如未来扩展新嵌套层需补 min-height: 0 |

### 17.4 B2（round 5）跟随 — B4 修好后用户实测

#### 17.4.1 round 4 状态

dev round 4 commit 09ea8fc 已走路径 A 修源码（`renderer-dialogs.js:1030-1037` letterSpan textContent 显式判 source='closed'）。但 dev 无 DevTools 实测，基于源码 grep 推理。

#### 17.4.2 round 5 策略

**不主动改 B2**。等 B4 修好后用户实测 multi 完成态：

- ✓ **字母 a/b/c 显示** → 路径 A 已修好 → B2 收尾
- ✗ **字母仍不显示** → round 6 走**路径 B**（改 `.ba-file-row grid-template-columns: auto minmax(24px, auto) 1fr`）

PM 在 spec §10.4 已提供路径 B 完整 sketch，round 6 dev 直接照实施。

### 17.5 ⏸ 待澄清子项

- [ ] **round 5 B4 修复后是否真能滚**：dev 修完后 spec §17.3.6 4 项手测 + DevTools 检查必跑；如仍不行 → round 6 PM 深挖（可能涉及第 4 层嵌套或 specificity 冲突）
- [ ] **B2 是否需要 round 6 路径 B**：等用户 round 5 测试反馈

---

## 十八、跨需求事项

### 16.1 文档三件套更新时机

- 触发节点：发布前一次性更新（不在中间 fix 阶段更新）
- 文件：`CHANGELOG.md` + `docs/VERSION_FEATURE_HISTORY.md` + `docs/USER_GUIDE.md`
- F4 改名后必须显式在 USER_GUIDE / CHANGELOG / VFH 三处说明
- F6 在 USER_GUIDE 收单单据币种校验章节补一段"运行进度反馈"说明（含示意文案）
- **F5 延期**：CHANGELOG / VFH / USER_GUIDE **不提及 F5**（避免用户期待本版本修复）
- R6 修复后 CHANGELOG / VFH 提一句"大账号确认页 multi 模式文件名完整显示 + 列表滚动恢复"（与 F3 round 1 合并表述）
- **F8 加入 USER_GUIDE "银行对账单处理"章节末尾**：「处理结果文件第 2 个 sheet 列出未命中场景规则的行（跑完所有 enabled 场景后无任何 scenario 命中的原始行）」

### 16.2 check-vars 跑点

| 节点 | 是否必跑 |
|---|---|
| F2 spec 完成后 | 必跑（评估 runC3Scenario 升格） |
| F4 spec 完成后 | 必跑（评估 runC2Scenario 升格 + 引擎放宽涉及资金红线） |
| F6 spec 完成后 | 必跑（PM 评估**预期不升格** — F6 不改业务/资金/迁移逻辑） |
| F7 spec 完成后 | 必跑（评估 `AppDatabase` / `AppDatabase.init` 升格 Important-skeleton，因 PRAGMA 配置点全局影响）|
| **F8 spec 完成后** | **必跑**（评估 `runScenarioDispatcher` 升格 Critical 层；F8 改 dispatcher 返回 schema 是资金红线主路径）|
| 提 PR 前 | 必跑（CLAUDE.md 第 7 条 + memory `workflow_important_vars_check`） |
| 合并到 main 前 | 必跑 |
| `package.json.version` bump 时 | 必跑（如本迭代决定 bump 到 2.1.7） |

### 16.3 previews 回归矩阵

涉及前端 dialog / panel 改动的需求（F1/F3/F4/R5/R6 + B1/B2/B3/B4 + F4 删空），必须按 memory `workflow_frontend_previews` 重跑对应 preview：

| 需求 | preview 命令（待 spec 阶段确认具体命令） |
|---|---|
| F1 | C1 dialog screenshot（新增 AND/OR radio） |
| F3 | 大账号 dialog screenshot × 2（multiMode 启 / 关）|
| F4 | C2 dialog screenshot（新展示名 + 默认空状态） |
| F6 | **可选** — F6 仅改运行时动态文案；preview 默认走"欢迎使用小助手"初始态，与 v2.1.6 一致，不强制回归 |
| F7 | **不涉及**（纯 DB + main 进程改动）|
| R5 | C1 dialog screenshot 更新（radio 移到独立 row + 纵向 + AND 在上）|
| **R6a** | 大账号 dialog × 4 必跑：multi 关初始 / multi 编辑态 / multi grouped 闭合态 / multi uncovered 态 |
| R6b | 无独立 preview（合并到 R6a 验证）|
| R6c | extract-order-card 不一定有 preview 入口；spec §13.9.4 注明 PM 在 spec 阶段确认是否新增 |
| **B1** | C1 dialog 重跑（radio 从 R5 独立 row 移回"条件"row 内部）|
| **B2** | 大账号 dialog multi grouped 闭合态重跑（letter 列宽兜底验证）|
| **B3** | **必跑** — extract-order-card 视觉完全重组（单 grid 表格 + 单滚动条）|
| **B4** | **新增** preview fixture `applyBigAccountSelectionMultiLargePreviewState`（≥20 文件） |
| B5 | 无（纯 wiring，状态框文案运行时变化无 preview）|
| F4 删空 | C2 dialog screenshot（删按钮永远显示）|
| **F8** | **不涉及**（writer 输出，无 UI 改动）|

未涉及前端的需求（F2 / F6 业务路径 / F7 / R1/R2/R3/R4 / B5 / F8）—— 无需 preview 回归。F5 延期不涉及任何前端。

### 16.4 smoke 套件

| 需求 | smoke 新增用例数（预估） |
|---|---|
| F1 | 2-4 |
| F2 | 4-6 |
| F3 | 0 |
| F4 | 3-4 |
| F5 | **0**（延期）|
| F6 | 2-3 |
| F7 | 3 |
| R1-R5 | R1 1 / R2 1 增强 / R3 4 / R4 0 / R5 5 |
| R6a/R6b/R6c | 0（纯 CSS）|
| **B1-B5 + F4 删空** | **B1 0（preview）/ B2 0 / B3 0（preview + 手测）/ B4 0（手测 + 新 fixture）/ B5 1（wiring 审计断言）/ F4 删空 1（删空后保存校验）**|
| **F8** | **3-4**（① dispatcher 反向 filter unmatchedRows ② `modifiedRows + unmatchedRows = totalRows` 无遗漏 ③ `modifiedRows ∩ unmatchedRows = ∅` 无重复 ④ writer 第 2 sheet 行数验证 + 内部字段 strip） + 🚨 **资金红线断言** `modifiedRows count == v2.1.6 baseline`（dispatcher 行为不动）|
| **合计** | **18-26 新增 smoke 用例**（F + round 2 + round 3 + F8 总计）|

**额外 F7-A1 + R3 + F8 dispatcher 全 19 个 smoke suite 回归矩阵**：分别详 §12.5 / §8.4.3 / §15.7，全局影响必跑无回归

### 16.5 版本号策略

- 当前 `package.json.version = "2.1.6"`（暂保持）
- 6 项需求 + round 2 8 项小修 + round 3 6 项小修 + F8 全部完成 + smoke 通过后，用户决策是否 bump 到 `2.1.7`（patch 版）
- 三件套更新与 version bump 同步进行

---

## 十九、数据 / 状态 / 安全影响

| 类别 | 说明 |
|---|---|
| 数据结构变更 | **无业务表 schema 变更**；F1 在 `scenarios.config` JSON 内新增 `conditionsLogic` 字段（JSON 字段无需 migration）；**F7-A2 新增索引** `idx_acquiring_bill_currency_bill_source_file`（幂等 CREATE INDEX IF NOT EXISTS，无表结构变更）；**R5 不动 schema**（默认值变更仅影响新建 scenario） |
| 状态流转变更 | F2 `runC3Scenario` 引入 `usedGwRowIdx` Set（运行时局部状态，无持久化）；F6 引入 2 个新 IPC 事件通道（`acquiringBillCurrency:import:progress` + `acquiringBillCurrency:run:progress`），事件 payload 不持久化；**F7-A1 PRAGMA `journal_mode = WAL`** 改变 SQLite 持久化模式（旁文件 `*.sqlite-wal` + `*.sqlite-shm` 产生）；**R4 acquiring 模块新增 `inflightOperation` flag**（renderer 端运行时状态，无持久化）|
| 权限 / 安全 | 无；F7-B1 Notification 走系统通知中心（macOS）/ 任务栏（Windows）原生权限，无新增 |
| 回滚策略 | F1：删 `conditionsLogic` 读取逻辑，引擎回退 `some()`；F2：恢复 `matched[0]` 单行 patch；F3：CSS 回滚；F4：DB 不动，UI 改回旧文案 + 引擎硬卡复原；F6：删 main.js handler 内 onProgress 桥接 + renderer 内 listener 订阅，session 层 onProgress 守护语句保留无副作用；**F7-A1 回滚**：删 4 条 PRAGMA + 用户需手动 `PRAGMA journal_mode = DELETE` 切回（spec 提示用户操作）；**F7-A2 回滚**：删 index + ANALYZE 是 no-op；**F7-B1 回滚**：删 Notification 调用 + destructure；**round 2 回滚**：R1 改回 `<= 2` / R2 删 fileCount 注入 / R3 删 replace + CSS + 恢复 bizOpRecon hack / R4 删 inflightOperation flag / R5 改回默认 `'OR'` + dialog HTML 复原；**R6a 回滚**：`.ba-file-row` grid-template-columns 改回 `28px 1fr` + 弹窗 width 改回 1080 + truncateFileName 阈值改回 20；**R6c 回滚**：删 `.extract-order-list` max-height + overflow-y 2 行 CSS |
| 旧数据兼容 | F1：旧 scenario 无 conditionsLogic 字段 → 引擎 fallback OR；F4：DB category 字段不变 → 旧 scenario 100% 兼容；F6：不涉及数据；F7-A1：journal_mode WAL 切换持久化在 DB 元数据，旧 DB 首次启动后自动切换（首次启动时会产生 wal 旁文件）；F7-A2：CREATE INDEX IF NOT EXISTS 幂等，旧 DB 无影响；**R5 旧 scenario 100% 兼容**（pickConditionsLogicChecked 按 mode 分支 → 编辑老 scenario UI 显示 OR + 引擎 fallback OR；护栏详 §13.6.4）；**R6 不涉及数据**（纯 CSS）|

---

## 二十、非功能性要求

| 类别 | 要求 |
|---|---|
| 向下兼容 | F1 / F4 / F6 / F7 必须 100% 兼容 v2.1.6 历史 scenario / DB / 业务数据；F2 行为变更需通过文档显式告知；F7-A1 WAL 模式向下兼容老 DB（首次启动自动切换）；**R5 100% 向下兼容**（老 scenario 三层护栏 fallback OR） |
| 性能 | F2 `usedGwRowIdx` Set lookup 是 O(1)，对 1k 行级数据无明显性能影响；F6 IPC 事件总数 ≤ `fileCount × (1 + ceil(rowPerFile / 10000))`（reader 节流上限），端到端 totalElapsedMs 增长 < 5%（与 v2.1.6 对比）；**F7-A1 期望提升**：synchronous=NORMAL 在 WAL 下相比 FULL 写入快 2-3 倍；cache_size=64MB + mmap_size=256MB 让大表 JOIN 在 SATA SSD 上少触发磁盘 IO；**F7-A2 ANALYZE 启动开销 < 100ms**；**R3 `replace(/：/g, '：\n')` 单次 ≤ 5μs**（每条状态文案最多几十字符），CSS pre-wrap 浏览器原生支持无额外性能 |
| 鲁棒性 | F6 `webContents.send` 失败 / renderer 已销毁场景必须 try/catch swallow（参考 `main.js:9520` 范式）；F4 引擎放宽后 0 行 billTypes / 单 billType 1 reconFields 边界场景必须 graceful（warning 不抛错）；**F7-B1 Notification 必须 `Notification.isSupported()` 兜底 + try/catch swallow**，通知失败不影响 IPC return；**R3 message === null/undefined 必须返回 `''`**（spec §13.4.2 入口 String 转换前 null check）；**R4 异常路径 finally 必须清 inflightOperation flag**（spec §13.5.4） |

---

## 二十一、待澄清问题（待用户拍板）

### 17.1 ⏸ 不阻塞 spec/Dev 推进，但需要用户后续跟进

- [ ] **F4 单 billType 引擎语义（§9.5）**：放开 billTypes ≥ 1 + reconFields = 0 后，单 billType + 0 reconFields 的语义。PM 推荐方案 A（无条件赋值）；spec 阶段**先按 A 实现**，若用户回复改方案 B 改约 5 行代码即可
- [ ] **R6 F3 二次诊断（§十三 R6）**：等用户提供 3 张截图（编辑态 / grouped 闭合态 / 切换模式后），PM 根据截图重新评估根因；本轮 round 2 spec 不写 R6 fix
- [ ] **R3 文案审计（§13.4.4）**：spec 阶段 grep 所有 setStatus 调用方文案识别"含半角 `:` 而希望换行"的情况；如有，由调用方自行改为「：」；本次 R3 只加规则不强制改文案

### 20.1 ⏸ 真正阻塞 spec/Dev 推进，但需要用户后续跟进

#### v0.9 新增待澄清项

- [ ] ⏸ **round 4 B2 路径 A vs B**（§16.4.4）：PM 双路径 sketch 都已写好；dev 修完 B4 后用 DevTools 现场判断（textContent 空 → 路径 A 修 letterSpan / textContent 有值但视觉不见 → 路径 B 改 grid minmax(24px,auto)）；不阻塞 dev 立即启动
- [ ] ⏸ **round 4 收尾**：用户回归 B1/B2/B4 修复后如仍不通过 → round 5

#### v0.8 新增待澄清项（v0.9 部分锁定）

- [x] **B2 multi 完成态字母列方案**（§14.3.3 round 3 / §16.4 round 4）：round 3 加 min-width:24px 用户验证无效；round 4 PM 提供双路径 sketch（路径 A 修 letterSpan / 路径 B 改 grid track minmax），dev 修完 B4 后实测选
- [x] **B4 ≥20 文件场景真根因**（§14.5 round 3 / §16.3 round 4）：round 3 加 scrollbar-width:thin 用户验证无效；round 4 **PM grep 锁定真根因** = `.big-account-split-left/right` 缺 `min-height: 0` 让 grid item 默认 `min-height: auto` 穿透 max-height（经典 CSS 陷阱）；1 行 CSS 修复
- [ ] ⏸ **F8 "处理结果文件" 范围 + 每文件 vs 汇总文件**（§15.6）：PM 推荐"仅明细文件加 sheet" + "每个明细文件都加 sheet"（不汇总）；dev 实施可按推荐先做，若用户后续反馈再调

### 19.2 已拍板（v0.8 收尾，仅留档）

#### v0.7 / 之前已拍板

##### v0.5 已拍板项

#### v0.5 已拍板项

- [x] **F1**：confirm 预览 / 管理列表硬编码 OR 两处按 logic 切换 —— 按 PRD v0.1 推进
- [x] **F2 方案选择**：✓ 方案 A（网关候选池 usedGwRowIdx Set）；B/C 留附录
- [x] **F2 测试数据**：用户提供 v2.1.6 反例样本由 Dev 阶段手测验证
- [x] **F3 round 1 根因**：✓ 用户截图佐证 — CSS flex 子项缺 `min-width:0` + multiMode-grouped 后缀挤压（不是 double-escape）；R6 round 2 待用户提供截图
- [x] **F4 默认值**：✓ billTypes 默认 0 行 / reconFields 默认 0 行；校验 billTypes ≥ 1 / reconFields 允许 0 行
- [x] **F4 历史文档**：✓ USER_GUIDE 仅改当前章节、保留历史发版日志段
- [x] **F5 整体延期 v2.1.8**：✓ TEST2.xlsx 期望 57 行 vs 单点 fix 28 行差距 = maxSize=8 + manyToOne 遍历顺序 = 算法重设 ≥ 1 周（详 §十）
- [x] **F6 文案风格**：✓ 用用户原话格式 `正在导入 xxxxx.xlsx 文件 (11/16 个文件)`
- [x] **F6 节流落点**：✓ main.js handler 100ms 时间窗口节流
- [x] **F6 5 阶段粒度**：✓ 按 PRD §11.3.2 推荐 5 阶段，SQL JOIN 单阶段若实测仍 1-2 分钟无反馈留 v2.1.8 优化
- [x] **F6 取消按钮**：✓ 先不做（超出本次范围，留 v2.1.8）
- [x] **F7-A1 PRAGMA 4 条值**：✓ WAL / NORMAL / -65536 / 268435456（用户指定）
- [x] **F7-A2 加什么索引**：✓ PM 验证 JOIN ON 复合索引 v2.1.6 已建；新加 source_file 索引（writer 阶段高频）+ ANALYZE 刷新统计
- [x] **F7-B1 Notification 文案**：✓ 成功 `「收单单据币种校验」{monthKey} 对账完成（共 N 行差异）` / 失败 `「收单单据币种校验」对账失败：{message}`
- [x] **F7 架构边界**：✓ 不引入 worker_threads / utilityProcess（A3 留 v2.1.8 联合 F5 处理）
- [x] **v2.1.8 立项**：✓ F5 + A3 联合主题（详 §10.6）

#### v0.6 新增拍板项

- [x] **R5 默认 AND 仅新建生效**：✓ 老 scenario fallback OR（资金红线护栏；§13.6.4 三层护栏：默认 config / pickConditionsLogicChecked / 引擎 fallback）
- [x] **R3 冒号换行仅中文「：」**：✓ `.replace(/：/g, '：\n')` 不动半角 `:`（避开 URL/timestamp/账号）

#### v0.7 新增待澄清项（v0.8 已用户拍板 → 移至已拍板）

- [x] **R6a F3 multi 文件名方案**：✓ 用户选 C MVP（grid 3 列治本），spec §8.7 落地

#### v0.7 已拍板项

- [x] **R6b 滚动条丢失真根因合并到 R6a**：✓ PM 二次诊断高度链已通，R6b 实质是 R6a 单行挤压副作用；R6a 修复后 R6b 自动恢复，spec §13.8 只做"R6a 修复后高度链回归验证"
- [x] **R6c `.extract-order-list` 加 max-height + overflow-y**：✓ 2 行 CSS 修复（spec §13.9）
- [x] **R6 系列不动 JS 业务逻辑**：✓ 全部纯 CSS 修复（R6a 方案 B 选项仅改 1 个 JS 常量阈值，不动函数实现）

#### v0.8 新增已拍板项

- [x] **B1 radio 移回"条件"row 内部**：✓ DOM 重组到 `.scenario-config-multi-wrap` 末尾；资金红线护栏不动
- [x] **B3 extract-order-card 方案 A**：✓ 用户 round 3 拍板单 grid 表格 + 每行横跨左右 + 外层单 overflow + 移除 `.extract-order-list` 内层 overflow（~20 行 HTML+CSS）
- [x] **B5 R3 wiring 漏接审计**：✓ 三处全部改走 updateStatusBox（用户发现 1 处 + PM grep 再发现 2 处：updateBankStatementUi / updateReconIdFixUi）+ render-status-box smoke 加固
- [x] **F4 删空 R1 未彻底**：✓ display + handler 同步 `< 0` / `>= 1`；保存校验 `< 1` 兜底
- [x] **F8 "未处理"定义**：✓ 用户 round 3 拍板 = **dispatcher first-match-wins 后无任何 scenario 命中的行**（不是 v2.1.x skippedRows）；PM 验证 `scenario-dispatcher.js:122-123` rowLockSet 已就绪，一行反向 filter 得 unmatchedRows
- [x] **F8 列结构**：✓ 用户拍板"保留原始银行对账单行所有列 + 不加诊断列"（不加"未命中原因"）
- [x] **F8 资金红线护栏**：✓ `modifiedRows` filter 条件不动；smoke 强制 `modifiedRows count == v2.1.6 baseline`

### 19.3 收尾时统一拍板（不阻塞）

- [ ] **版本号 bump**：6 项需求 + round 2 8 项小修 + round 3 6 项小修 + F8 全部完成 + smoke 通过后是否一次性 bump 到 `2.1.7`？还是分批发？默认一次性

---

## 二十二、变更记录

| 版本 | 日期 | 修订 |
|---|---|---|
| v0.1 | 2026-05-20 | 起草；5 项需求覆盖（F1-F5）；F2 给出 3 方案对比表 + 推荐方案 A；F5 实施方案已用户拍板（引擎入口转字符串） |
| v0.2 | 2026-05-20 | 追加 F6 — 收单单据币种校验模块状态框运行进度显示；§一/§二/§三/§四/§五/§十二/§十三/§十四/§十五同步更新；新增 §十一 F6 章节（章节标号 §十一原跨需求事项 → §十二 顺延）；PM 关键发现：session.onProgress 链路 v2.1.6 已就绪但 main.js handler 未接入，F6 = 接通现有链路 + 复用 `pending:import:progress` 范式，不是从零造轮子 |
| v0.3 | 2026-05-20 | **用户拍板汇总收尾**：① F2 锁定方案 A（B/C 留附录）；② F3 用户截图佐证 → 根因细化为 CSS flex 子项缺 `min-width:0`（不是 double-escape，不是 JS 截断）+ 方案 A CSS 2 属性修复；③ F4 校验放宽到 billTypes ≥ 1 + reconFields 允许 0 行 + 引擎硬卡同步放开 + 新增 §9.5「单 billType 衍生待澄清」（推荐方案 A 无条件赋值）；④ F5 新增 §10.7「验收基线澄清」含多档窗口实测表（±1 12 / ±3 19 / ±5 28 / ±7 19 / ±10 17 / ±30 5）+ 用户期望 57 件差 29 件诊断 + AC-F5-4 改 ⏸ TBD 占位；⑤ F6 4 项细节定默认（文案原话 / 100ms 节流 / 5 阶段推荐 / 不做取消按钮）；§十五待澄清重整为「真正阻塞」「已拍板」「收尾拍板」三段 |
| v0.4 | 2026-05-20 | **F5 整体延期 v2.1.8**：用户提供 TEST2.xlsx 期望基线证据 = 57 行 / 10 渠道 / 最大子集 16 行；F5 单点 fix 后实测 28 行 / 9 渠道，差距根因 = maxSize=8 硬上限 + manyToOne 遍历顺序 = 算法重设级别（资金红线大改 ≥ 1 周）；§十重写为「F5 延期说明」专章（仅含决策理由 / 差距根因 / v2.1.8 PRD 提示 / v2.1.7 范围对 F5 处理）；§一/§二/§三/§四/§十二/§十三/§十四/§十五同步清理 F5 references；smoke F5 用例数改为 0（仅 v2.1.6 现有 C4 smoke 防回归）；本迭代范围收缩 6 项 → 5 项 |
| v0.5 | 2026-05-21 | **追加 F7 — 收单币种校验 SQL 调优 + 完成系统通知**：3 子任务（A1 PRAGMA / A2 索引 + ANALYZE / B1 Electron Notification）；§一/§二/§三/§四/§五术语同步更新；新增 §十二 F7 专章；原 §十二 → §十三 跨需求；原 §十三/十四/十五/十六/十七 顺延为 §十四-§十八；§十 F5 延期专章末尾追加 §10.6「v2.1.8 立项预告 F5 + A3 联合主题」；§十六 待澄清新增 5 项 F7 已拍板项；smoke 套件加 F7 3 用例 + 19 个 suite 全量回归矩阵；本迭代范围扩 5 → 6 项；**PM 关键发现**：JOIN ON 复合索引 v2.1.6 已建（idx_acquiring_bill_currency_flow_join + idx_acquiring_bill_currency_bill_join），F7-A2 真正可加的是 source_file 索引服务 writer 阶段 |
| v0.6 | 2026-05-21 | **追加 round 2 用户手测反馈修复 R1-R5（R6 ⏸）**：① R1 F4 删按钮门槛 `<= 2` → `=== 1`（1 字符 diff）；② R2 F6 session.js wrapper inserting payload 显式注入 fileCount（防 `...p` 覆盖）；③ R3 updateStatusBox 入口 `.replace(/：/g, '：\n')` 仅中文「：」+ CSS `.status-box-text { white-space: pre-wrap }` + 顺手清 bizOpRecon hack（全局影响 → 19 suite 全跑）；④ R4 acquiring 模块 inflightOperation flag（PM 验证 bankBu/bizOp/pending 已用 apply*ButtonState 范式无此问题，R4 不扩散）；⑤ R5 F1 默认 AND 仅新建 + dialog 移到独立 row 纵向 AND 在上 OR 在下 + **资金红线三层护栏**（默认 config 仅 create 用 AND / pickConditionsLogicChecked(draft) 按 mode 分支老 scenario fallback OR / 引擎 fallback OR 不动）；⑥ R6 F3 二次诊断⏸ 等用户 3 张截图；新增 §十三 round 2 专章（R1-R6 五节 + 资金红线护栏专段 §13.6.4）；§十三 跨需求 → §十四；§十四-§十八 顺延为 §十五-§十九；§十七 待澄清重整为「真正阻塞」「已拍板」「收尾拍板」三段 + v0.6 新增 3 项；本迭代 6 项需求 + round 2 5 项小修 |
| v0.7 | 2026-05-21 | **用户发来 F3 三件套 2 张截图，R6 ⏸ → 🟡 in spec 拆 R6a/R6b/R6c**：① R6a multi 模式文件名 "PP..." 根因细化为**两层叠加**：① `.ba-file-name { flex:1 1 auto }` 对 grid 子项无效（用户已分析）+ ② **`.ba-file-row { grid-template-columns: 28px 1fr }` 硬编码 2 列 vs multi 各分支动态 append 3 子项**（PM 深挖发现）；PM 给 4 个方案对比表 + 推荐 C+B 组合（grid 3 列治本 + JS 阈值 14 防御性），spec §8.7 已按 C+B 写好 sketch 等用户拍板；② **R6b PM 二次诊断高度链已通**，"滚动条丢失"真实根因 = R6a 单行挤压副作用，R6a 修复后 R6b 自动恢复，spec §13.8 只做回归验证；③ R6c `.extract-order-list` 加 `max-height + overflow-y: auto` 2 行 CSS（modal-card overflow:hidden + 内列表无 overflow → 看不到底部）；§十三 标题 + §13.1 表格更新；新增 §13.7/§13.8/§13.9 三节；§十七 待澄清加 v0.7 R6a 方案拍板项 + R6b/R6c 已拍板项；§四 代码现状追加 R6 行；本迭代 6 项需求 + round 2 8 项小修；**PM 关键发现**：用户描述"flex 对 grid 无效"正确但只是表层；真根因是 grid 列数硬编码不匹配子项数 |
| v0.8 | 2026-05-21 | **用户手测 round 3 通过 F1/R4/R6 主功能；反馈 5 bug + 1 新需求 F8**：① B1 F1 radio 移回"条件"row 内部（DOM 重组，资金红线护栏不动）；② B2 multi 完成态字母列丢失（R6a 副作用，PM 推荐方案 A `min-width:24px`，待 dev 实测）；③ **B3 extract-order-card 左右对齐 + 共用滚动条 → 用户 round 3 拍板方案 A**（单 grid 表格，每行横跨左右 + 单 overflow，~20 行 HTML+CSS）；④ B4 ≥20 文件场景滚动条不可用（待 dev 实测真根因 + 新建 fixture）；⑤ **B5 🚨 R3 wiring 漏接审计** — 用户发现 setAcquiringBillCurrencyStatus 漏接；PM grep 再发现 2 处（updateBankStatementUi + updateReconIdFixUi）；三处全部改走 updateStatusBox + render-status-box smoke wiring 审计；⑥ F4 删空 — R1 只改 display 没改 handler（L6794 仍卡 `> 2`），同步两处为 `>= 1` 删空 + 保存校验 `< 1` 兜底；⑦ **F8 🚨 资金红线** — 用户 round 3 拍板定义"未处理" = **scenario-dispatcher first-match-wins 后无任何 scenario 命中的行**（不是 v2.1.x skippedRows）；PM grep 验证 `scenario-dispatcher.js:122-123` rowLockSet 已就绪，**一行反向 filter** 即可得 unmatchedRows；改 dispatcher return + writeWorkbookRows 加可选 unmatchedRows 入参 + 第 2 sheet "未命中场景行"（原始列，不映射，不加诊断列）；新增 §十四 round 3 专章（B1-B5 + F4 删空 7 节）+ §十五 F8 专章；原 §十四-§十九 顺延 §十六-§二十一；§十九 待澄清重整 + v0.8 已拍板项 7 条；本迭代 6 项需求 + round 2 8 项小修 + round 3 6 项小修 + F8；**PM 关键发现**：① B5 用户发现 1 处 + PM grep 再发现 2 处漏接（renderer.js:3330 + :3684）；② F4 R1 commit 只改 display L6716 没改 handler L6794，需同步两处；③ F8 dispatcher rowLockSet 已就绪，改造极轻量且不动 modifiedRows 资金红线 |
| v0.9 | 2026-05-21 | **用户手测 round 3 后反馈 3 项未通过（B1 位置仍不对 + B2 字母没显示 + B4 滚动条没出现）；起 round 4 章节 + 3 task**：① **B1 用户拍板 Layout-1**（左列纵向"条件 label + AND radio + OR radio"，与右列 conditions 并排）；PM grep 验证字体差异 `.scenario-config-label` 14px vs `.scenario-config-feature-grid label` 13px → spec 显式设 radio label 13px；新增 `.scenario-config-label-stack` 容器 + `.scenario-config-logic-option` 字体 class；② **B4 PM grep 真根因已锁定**（不需要等截图）= `.big-account-split-left/right` 是 `.ba-scroll-container` 的 grid 子项，缺 `min-height: 0` → grid item 默认 `min-height: auto = content size` 穿透父 `max-height: 52vh` → file-list `overflow-y:auto` 永不触发（经典 CSS 陷阱）；1 行 CSS 修复双写 src + Clear；dev round 3 scrollbar 强制可见 CSS 保留（双覆盖）；③ **B2 跟随 B4 验证**（用户原话 B2 测试被 B4 阻塞）；PM 双路径 sketch：路径 A 修 letterSpan textContent 显式判 source='closed'（防 pendingGroup 边界 case 空字母）/ 路径 B 改 grid `auto minmax(24px, auto) 1fr`；dev 修完 B4 后用 DevTools 现场判断；新增 §十六 round 4 专章；原 §十六-§二十一 顺延 §十七-§二十二；§三总览 / §四代码现状 / §一/§二同步更新；§二十待澄清重整 v0.9 新增 + v0.8 锁定项；**PM 关键发现**：① B4 真根因不是滚动条可见性而是 grid item 穿透 max-height（与 R6a flex/grid item 教训类似的 CSS 陷阱）；② B2 被 B4 阻塞手测，需先修 B4 才能完整验证；③ B1 字体一致性需 `.scenario-config-logic-option { font-size: 13px; font-weight: normal }` 显式区别于 `.scenario-config-label` 14px+500 |
| v0.10 | 2026-05-21 | **用户手测 round 4 反馈 B1 微调 + B4 仍不能滚动 + B2 跟随；起 round 5 章节 + 2 task**：① **B1 round 5 微调**（用户拍板：去掉 radio 文本"（同时满足）/（满足任一）"，提示合到"条件" label tooltip；PM 推荐方案 B 单 tooltip 整合到 6358 行现有 ⓘ tooltip 文案 `按下方选择的聚合逻辑：&#10;AND — 同时满足所有条件才命中&#10;OR — 满足任一条件即命中`，radio 仅保留 "AND"/"OR" 纯文字）；② **B4 round 5 真根因第 2 层 🚨** — dev round 4 修对第 2 层 grid item `.big-account-split-left/right` 但漏修第 3 层 flex item `.big-account-file-list/order-list`；PM 二次 grep 完整 3 层 flex/grid 嵌套高度链（modal-card → split-body → split-left/right → file-list）锁定真根因 = file-list 自己 `min-height: auto = content ~800px` 把父 split-left 撑超 `ba-scroll-container max-height: 52vh = 562px` 即使 split-left 加了 min-height: 0；round 5 一次性修齐第 3 层（主修）+ 防御性给第 1 层 split-body 也加（极小屏 edge case，1080p 不触发），2 行 CSS 双写；dev round 3 scrollbar 强制可见 CSS 保留；③ **B2 跟随 B4**：round 4 路径 A 已 commit，B4 修好后用户实测字母显示 → 路径 A 成功 / 仍不显示 → round 6 走路径 B（grid `auto minmax(24px, auto) 1fr`）；新增 §十七 round 5 专章（17.1-17.5）；原 §十七-§二十二 顺延 §十八-§二十三；§三总览 / §四代码现状 / §一/§二同步更新；**PM 关键发现**：① B4 是经典 flex 嵌套坑 — 每层 flex/grid item 都需要显式 min-height: 0（content size 会从最内层一路撑过所有父级 max-height 约束），round 4 只修第 2 层不够，必须修到最内层；② round 5 一次性给第 3 层（主修）+ 第 1 层（防御性兜底）都加 min-height: 0，避免 round 6 再发现遗漏；③ B1 文案微调用 HTML 实体 `&#10;` 实现多行 tooltip（原生浏览器支持），不需新 CSS |
| v0.11 | 2026-05-21 | **T14 收口反向同步 + 实施记录**：① **§二十三 实施记录**完整填表（50 commit 全列表 + integrated:true 标记防 archive 重复；6 round 历程总结表）；② **B4 round 6 用户测试通过后实测发现 PM round 5 推断不完整** — DevTools 数据揭示 splitLeft_h=5952 远超 max-height 447，真根因是 `.ba-scroll-container` 缺 `grid-template-rows: 1fr`（grid 第 4 个坑）— 不是 min-height:0 不够（round 4/5 加的 3 处 min-height:0 都 computed = '0px' 生效），而是 grid 容器默认 `grid-auto-rows: auto = content size` 让 grid item 跑出父高度；commit a9cb2ad 加 1 行 CSS 双写修齐；spec §11.3.8 round 6 真根因补章已追加；③ **knowledge/css-flex-grid-overflow-pitfalls.md 沉淀** — flex/grid 嵌套穿透 max-height **必修两条线**（每层 flex/grid item min-height:0 + grid 父 grid-template-rows:1fr），缺一不可，附 v2.1.7 完整 4 round 历程 + DevTools 验证数据 + 排查 SOP；knowledge/index.md 同步入索引；④ spec 反向同步 3 处文件路径歧义已修（§8.4.2 styles.css→styles-gemini-extra.css / §9.8.4 F8 SheetJS 改 SheetJS + ExcelJS 双版本 / §11.3.8 round 6 grid-template-rows 真根因补章）；**PM round 5 推断为什么不完整** — flex 链路 min-height:0 思路对，但 grid 父容器还要管 grid-template-rows，spec 阶段如果父是 `display: grid` 必须显式检查 grid-template-rows 不能只看 min-height:0 链；T14 收口经验沉淀完成 |

---

## 二十三、实施记录

```yaml
integrated: true   # T14 收口后追加，防 archive PR 草稿重复（memory workflow_pr_integrate_prd）
integrated_at: 2026-05-21
integrated_by: PM
total_commits: 38
total_rounds: 7  # round 1（F1-F4+F6+F7）+ F6 微调 + round 2 R1-R5 + round 3 B1-B5+F4 删空+F8 + round 4 B1+B2+B4 + round 5 B1+B4 + round 6 B4
```

### 23.1 50 commit 完整表（v2.1.7 vs main）

按 commit 时间逆序（最新在上）；每行标对应 PRD/spec 章节定位：

| # | Commit | Round | Type | 内容 | PRD § / spec § |
|---|---|---|---|---|---|
| 50 | `551f3bc` | round 12-补 | fix | I-10 important-variables sheet 1 名 + .gitignore 撤回 .claude lock | self-review I-10 follow-up |
| 49 | `355a59b` | round 12 | fix | self-review I-1 / I-2 / I-3 / I-6 / I-10 — 6 处文档卫生 | self-review 收口 |
| 48 | `51bf2bb` | round 11 | fix | tasks T14 收口标 ☑ + PR draft Test plan 勾选 + smoke 数 19→22 | PR #51 review round 2 follow-up |
| 47 | `2fe0b77` | round 10 | fix | package-lock.json 同步 + CHANGELOG 已知 case 闭环 | release 文档对齐 |
| 46 | `e1264ae` | round 9 | fix | **F2 1v1 空 gw / 已等值 gw 卡池修复** 🚨 资金红线（PR #51 reviewer round 3 Finding 1）| spec §3.8 反向同步补章（v2.1.8 v2.1.7-minor I-7） |
| 45 | `c142e45` | round 8 | fix | F8 全未命中 saveDialog 触发条件 follow-up（PR #51 reviewer round 2 Finding 1）| PRD §15 AC-F8-5 |
| 44 | `2781d7c` | round 7 | fix | PR #51 review 2 P1 + P3（F2 gw 误消费 + F8 全未命中 sheet + PRD trailing whitespace）| PRD §7 / §15 |
| 43 | `070c0b9` | T14 后 | chore | PR #51 归档 YAML 回填 pr_url / status open / integrated true | workflow_archive_pr_draft |
| 42 | `e7604b0` | T14 后 | chore | 归档 PR #51 草稿 → PR51-v2.1.7.md（integrated:true）| workflow_archive_pr_draft |
| 41 | `10116f1` | T14 收口 | release | bump 2.1.6→2.1.7 + 文档三件套 + scan:vars 重跑 | workflow_docs_update |
| 40 | `d337068` | T14 收口 | docs | **PM T14 反向同步 spec/PRD/tasks + check-vars 升格 10 + knowledge 沉淀** | spec §9 / §11 / PRD §23 / knowledge/css-flex-grid-overflow-pitfalls.md |
| 39 | `7234c32` | C-1 self-review | fix | bizOpRecon 状态框 R3 换行失效 — white-space normal → pre-wrap | PRD §13.4 R3 + spec §8.4 |
| 38 | `a9cb2ad` | round 6 | fix | B4 `.ba-scroll-container` 加 `grid-template-rows: 1fr` 真根因 | spec §11.3.8（T14 反向同步追加） |
| 37 | `3f72cfc` | round 5 | fix | B4 file-list 第 3 层 min-height:0 + split-body 第 1 层防御 | PRD §17.3 / spec §11.3 |
| 36 | `66a3559` | round 5 | fix | B1 去 AND/OR 括号 + 单 tooltip 整合 | PRD §17.2 / spec §11.2 |
| 35 | `09ea8fc` | round 4 | fix | B2 multi 完成态字母 路径 A | PRD §16.4 / spec §10.4 |
| 34 | `b244cbc` | round 4 | fix | B1 F1 Layout-1 纵向 + 字体 13px | PRD §16.2 / spec §10.2 |
| 33 | `fb88040` | round 4 | fix | B4 split-left/right 第 2 层 min-height:0 grid item | PRD §16.3 / spec §10.3 |
| 32 | `d289779` | round 3 | feat | **F8** dispatcher unmatchedRows + 第 2 sheet 🚨 资金红线 | PRD §15 / spec §9.8 |
| 31 | `a94792e` | round 3 | fix | B4 ≥20 文件 scrollbar-width:thin 强制可见 | PRD §14.5 / spec §9.5 |
| 30 | `b63b73e` | round 3 | fix | B3 extract-order-card 单 grid + 共享 overflow | PRD §14.4 / spec §9.4 |
| 29 | `9d35a08` | round 3 | fix | B2 multi 完成态 letter min-width:24px | PRD §14.3 / spec §9.3 |
| 28 | `fe0d31f` | round 3 | fix | F4 删空 — billTypes 删按钮永显 + 校验 ≥ 1 兜底 | PRD §14.7 / spec §9.7 |
| 27 | `25a492c` | round 3 | fix | B1 F1 radio 移回"条件" row 内（用户再次反馈）| PRD §14.2 / spec §9.2 |
| 26 | `06b7b8e` | round 3 | fix | **B5 R3 wiring 全局审计** + 修 3 处漏接 🚨 | PRD §14.6 / spec §9.6 |
| 25 | `c0e38ef` | round 2 | fix | R6c extract-order-card 内容超屏滚动恢复 | PRD §13.9 / spec §8.9 |
| 24 | `6b64690` | round 2 | chore | R6b R6a 后滚动条回归验证（无独立 commit） | PRD §13.8 / spec §8.8 |
| 23 | `9c080d1` | round 2 | fix | R6a F3 multi 文件名 grid 3 列 + 弹窗加宽 1200 | PRD §13.7 / spec §8.7 |
| 22 | `a51e15d` | round 2 | feat | **R5 F1 默认 AND + 资金红线三层护栏** 🚨 | PRD §13.6 / spec §8.6 |
| 21 | `c70372a` | round 2 | fix | R4 acquiring 切模块后按钮 disabled 状态保留 | PRD §13.5 / spec §8.5 |
| 20 | `bcabe29` | round 2 | feat | R3 状态框中文「：」自动换行（全局规则） | PRD §13.4 / spec §8.4 |
| 19 | `e24156e` | round 2 | fix | R2 F6 inserting 透传 fileCount 消除 '?' | PRD §13.3 / spec §8.3 |
| 18 | `4ffc376` | round 2 | fix | R1 F4 billTypes 删按钮门槛对齐 reconFields | PRD §13.2 / spec §8.2 |
| 17 | `4580be2` | F6 微调 | fix | F6 6 阶段文案业务化 + setImmediate 让 UI 响应 | PRD §11 / spec §6 |
| 16 | `131252f` | F7 | feat | **F7-B1** runCheck 完成系统通知 + 3 smoke | PRD §12 / spec §7 |
| 15 | `dacb5d0` | F7 | perf | **F7-A2** source_file 索引 + 启动 ANALYZE | PRD §12 / spec §7 |
| 14 | `e262ae4` | F7 | perf | **F7-A1 全局 PRAGMA** WAL+NORMAL+64MB+256MB 🚨 全局影响 | PRD §12 / spec §7 |
| 13 | `5ad3fc7` | round 1 | test | F6 收单币种校验进度 smoke 4 用例 | PRD §11 / spec §6 |
| 12 | `b81d848` | round 1 | feat | F6 preload 订阅 API + renderer 文案刷新 | PRD §11 / spec §6 |
| 11 | `5e9df82` | round 1 | feat | F6 main handler 桥接 onProgress IPC + 100ms 节流 | PRD §11 / spec §6 |
| 10 | `6d803da` | round 1 | feat | F6 session.runCheck 加 onProgress 6 阶段埋点 | PRD §11 / spec §6 |
| 9 | `a5d6eed` | round 1 | refactor | F4! 账单打标 → 银行对账单字段赋值 全量替换 | PRD §9 / spec §5 |
| 8 | `e4ce8cf` | round 1 | feat | F4 C2 dialog 默认空 + 校验放宽 + 删强补 | PRD §9 / spec §5 |
| 7 | `61a186b` | round 1 | feat | F4 C2 引擎放宽 billTypes ≥ 1 + reconFields 0 无条件赋值 | PRD §9 / spec §5 |
| 6 | `b1ba84b` | round 1 | fix | F3 大账号 multiMode 文件名 CSS flex min-width:0 修复 | PRD §8 / spec §4 |
| 5 | `26e28db` | round 1 | test | F2 C3 1v1 smoke 5 case + regression | PRD §7 / spec §3 |
| 4 | `360292c` | round 1 | feat | **F2! C3 引擎 1v1 方案 A** — 网关候选池 Set 🚨 资金红线 | PRD §7 / spec §3 |
| 3 | `623e75a` | round 1 | test | F1 C1 AND/OR smoke + preview | PRD §6 / spec §2 |
| 2 | `3eaec9b` | round 1 | feat | F1 C1 dialog 加 AND/OR radio + confirm 预览 logic 切换 | PRD §6 / spec §2 |
| 1 | `b1edf3d` | round 1 | feat | F1 C1 引擎 conditionsLogic AND/OR 切换 | PRD §6 / spec §2 |

### 23.2 6 round 历程总结

| Round | 范围 | commit 数 | 关键发现 |
|---|---|---|---|
| **round 1**（F1-F4 + F6 + F7） | 6 项需求初版 | 18（包含 F7 + F6 微调）| Dev 全部按 spec 落地；F4 重命名扇出 + F6 onProgress 链路顺利 |
| **round 2**（R1-R5 + R6a-R6c） | 用户首测反馈 8 项小修 | 8 | R6a 真根因细化为 grid 2 列硬编码 vs 子项 3 个；R5 资金红线三层护栏首次落地；R3 全局 setStatus 换行规则 |
| **round 3**（B1-B5 + F4 删空 + F8） | 用户 round 2 测试反馈 7 项 | 7 | B5 PM grep 再发现 2 处 R3 wiring 漏接；F4 R1 commit 漏改 handler；F8 dispatcher rowLockSet 反向 filter |
| **round 4**（B1 + B2 + B4） | 用户 round 3 测试反馈 3 项 | 3 | B4 第 1 次诊断：split-left/right grid item min-height:0；B1 Layout-1 字体一致 |
| **round 5**（B1 + B4） | 用户 round 4 测试反馈 2 项 | 2 | B4 第 2 次诊断：file-list 第 3 层 + split-body 第 1 层 min-height:0；B1 去括号 + tooltip 整合 |
| **round 6**（B4 真根因第 3 次诊断）| 用户 round 5 测试反馈 1 项 | 1 | **B4 真根因彻底锁定**：`.ba-scroll-container` 缺 `grid-template-rows: 1fr` —— DevTools 实测 splitLeft_h=5952 远超 max-height 447；min-height:0 是必要但不充分条件，grid-template-rows 才是 grid 容器关键 |
| **C-1 + T14 收口**（v2.1.8 v2.1.7-minor M-4 补行）| bizOpRecon R3 self-review + PM T14 反向同步 + release bump + 归档 | 5（#39-#43）| C-1 fix bizOpRecon white-space normal→pre-wrap；T14 PM 反向同步 spec/PRD/tasks + check-vars 升格 10 + knowledge css-flex-grid-overflow-pitfalls.md 沉淀；release 2.1.6→2.1.7 + 文档三件套；PR #51 OPEN 归档草稿 + YAML 回填 |
| **round 7**（PR #51 reviewer round 2 P1+P3，v2.1.8 v2.1.7-minor M-4 补行）| reviewer Finding × 3 | 1（#44）| F2 gw 误消费修 + F8 全未命中 sheet + PRD trailing whitespace |
| **round 8**（F8 全未命中 saveDialog follow-up，v2.1.8 v2.1.7-minor M-4 补行）| reviewer round 2 Finding 1 follow-up | 1（#45）| F8 saveDialog 触发条件 `modifiedRows>0 \|\| unmatchedRows>0` 对齐 PRD AC-F8-5 |
| **round 9**（F2 1v1 空 gw / 已等值 gw 卡池修复，v2.1.8 v2.1.7-minor M-4 补行）| reviewer round 3 Finding 1，🚨 资金红线 | 1（#46）| **F2 candidates filter 加第 3 层（空 gw 排除）+ oldValue===newValue 时仍 lock+消费 gw**；详 spec §3.8（v2.1.8 v2.1.7-minor I-7/I-8 反向同步） |
| **round 10-12**（release 文档 + self-review 卫生，v2.1.8 v2.1.7-minor M-4 补行）| PR draft / Test plan / package-lock / 6 处文档卫生 | 4（#47-#50）| round 10 package-lock + CHANGELOG / round 11 tasks T14 标 ☑ + Test plan + smoke 数 / round 12 self-review I-1/2/3/6/10 / round 12-补 I-10 sheet 名 + .gitignore |

### 23.3 F5 延期 v2.1.8 状态

PRD §十 已明确 F5（C4 gateway 子模式 BillDate 数字日期解析 + 算法重设）延期到 v2.1.8 单独评估；本迭代不动 C4 任何代码。v2.1.8 PRD 起草时按 PRD §10.6 立项预告（F5 + A3 worker 联合主题）展开。

### 23.4 关联 PR

- v2.1.7 PR（T14 收口阶段 gh pr create，PR 号回填）
- PR body 草稿存档：`docs/prs/待merge-PR #NN.md` → 提 PR 后改名 `PR{N}-v2.1.7.md` + 加 `integrated: true`

### 23.5 v2.1.8 v2.1.7-minor 追修清单（2026-05-26）

PR #51 merge 后 self-review 列 10 项 minor，由 v2.1.8 顺手处理（用户 2026-05-26 拍板）：

| ID | 描述 | 状态 | 实施位置 |
|---|---|---|---|
| **I-4** | commit 数各处不一致（38/39/49 各处散）| ✅ 已修（v2.1.8 commit `XXX`）| 12 处引用统一对齐到 **50** commits（PR #51 merge 实际数）|
| **I-5** | PRD §23.1 表追加 T14 + round 7-12 的 11 commit | ✅ 已修 | §23.1 表追加 12 行（#39 ~ #50） |
| **I-7** | spec §三 F2 章节反向同步 round 9 三层 filter | ✅ 已修 | spec §3.8 新增「round 9 反向同步补章」 |
| **I-8** | spec/PRD 明示 round 9 "空 gw 排除"业务规则 | ✅ 已修 | spec §3.8.3 业务规则明示（资金红线表） |
| **I-9** | smoke 补 F2-G/H 反向 case（封死 round 7-9 回归）| ✅ 已修 | scripts/smoke/scenario-engines.js + F2-G/H（45/45）|
| **M-1** | F2 round 9 warning 文案"匹配到 N 行"语义模糊 | ✅ 已修 | c3-gateway-recon-join.js 拆 2 步 filter + warning 区分原始/可用数 |
| **M-2** | F8 全未命中 + 用户取消保存框 → errorReport 漏写 | ✅ 已修 | main.js errorReport 写入提前到 saveDialog 之前 |
| **M-3** | round 10 commit `2fe0b77` 同时改 package-lock + CHANGELOG，commit 粒度风格漂移 | ❌ 不可修 | 历史 commit 不可改，仅 backlog 记录 |
| **M-4** | PRD §23.2 表头"6 round 历程总结"但 round 7-11 没补 row | ✅ 已修 | §23.2 表追加 5 行（C-1+T14 / round 7 / 8 / 9 / 10-12） |
| **M-5** | round 11 commit message 自反矛盾（"5 round"应为 round 7-11 = 5）| ❌ 不可修 | commit message 已上链；round 12 commit `355a59b` tasks.md 标题已纠正为"round 7-11" |

**总结**：10 项中 **8 项已修 + 2 项不可修（仅记录）**。spec/PRD/CHANGELOG 文档对齐 + 业务代码 2 处优化（M-1 warning 文案 / M-2 errorReport 提前）+ smoke 补 2 case（F2-G/H）。

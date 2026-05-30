# v2.1.12 迭代清单（Backlog — 立项画像）

> v0.1（2026-05-29 起草）：v2.1.11 stable 发布（merge `a9d90bb` → stable bump `f4b9e86`，T1 单测日志 + T2 pending 移除核对 + T3 C2 字段赋值增强）后，汇总 v2.1.8~v2.1.11 **顺延 / 未做 / follow-up** 项，作为 v2.1.12+ 候选范围。
> ✅ **v0.2（2026-05-30 立项拍板，取代 v0.1「版本号待定」）**：版本 **`v2.1.12`，分 α / β 两阶段**（α=业务+收尾 / β=性能），命名 `-alpha.N` / `-beta.N` → 收敛 stable `v2.1.12`；**F5-cont 不做**；新增 3 个用户需求（VCC业务OP计算新模块 / 网关 extra fee 匹配 / 资金对账不平跳过提示修正）。详见文末「立项拍板结论（v0.2）」；下方 v0.1 候选分析保留作背景。
> 数据来源：v2.1.11 backlog（A3-multi-worker / F5-cont / A3-spread 详述 + D29-D36）+ 各版本 PRD「不做」+ self-review/PR follow-up。

---

## 主题概览（候选 — 3 重头戏 + 3 收尾 + 4 评估）

### A. 重头戏候选（主线 · 需单独 spec + POC · 二选一或排期）

| 编号 | 主题 | 性质 | 风险 | 工期 | 延期轨迹 |
|---|---|---|---|---|---|
| **F5-cont** | C4 manyToOne 算法重写（subset-sum DFS+剪枝 → ILP / 网络流 / 启发式）| 🔴 资金红线 · 算法范式 | 🔴 HIGH | ~2-3 周 | **v2.1.7→8→9→10→11 连延 5 版** |
| **A3-multi-worker** | 多 worker pool 并行（acquiringBillCurrency + bizOpRecon + pending 复用，write-splitting）| 🔴 性能 · 架构升级 | 🟡 MID | ~2 周 | v2.1.9 立项 → v2.1.10 仅单 worker → v2.1.11 顺延 |
| **A3-spread** | A3 worker 化扩散到 bankBuRecon / bankStatement / reconIdFix（"主进程不卡"）| 性能 · UX | 🟡 MID | ~4 周（每模块 ~1 周）| v2.1.8 起一直评估 |

> 详述（背景/方案对比/决策点 D29-D36）见 `docs/iterations/v2.1.11/backlog.md` 对应章节 —— 本文件不重复，仅汇总状态。

### B. 收尾候选（清债 · 小工期）

| 编号 | 主题 | 风险 | 工期 | 来源 |
|---|---|---|---|---|
| **SR-log-1-dual-write-removal** | 删 `app_activity_log.txt` 旧写入路径（保留 JSON Lines 新归档）| 🟢 LOW | ~0.5 天 | v2.1.9 D34=a 双写至今未删，v2.1.10/11 都评估却没动 |
| **I6** | bundle 导入旧结构 C2 场景的端到端测试补充 | 🟢 LOW | ~0.5 天 | v2.1.11 PR #55 self-review follow-up |
| **I7** | `rules/important-variables.md` 升格 C2 `billTypes`/`conditions` schema（check:vars 符号匹配盲区）| 🟢 LOW | ~0.5 天 | v2.1.11 PR #55 self-review follow-up |

### C. 评估项（条件触发 — 暂不立项）

| 编号 | 主题 | 触发条件 |
|---|---|---|
| **SR-log-1-log-cleanup-ui** | 永久保留日志的批量清理 UI | 用户反馈日志膨胀 / 主动要清理入口 |
| **N5-channels-scale** | 渠道枚举下拉虚拟滚动 | 用户平均创建渠道 > 50 个 |
| **progress-throttle** | acquiringBillCurrency progress 事件 `chunkCount>100` 节流（v2.1.10 spec P1-9 TODO，main.js:~10599 注释亦待更新）| 大数据量进度刷屏反馈 |
| **spec-reverse-sync-minor** | v2.1.11 spec 微调（实际落点 main.js 非 pending-session / removed-reader 46 列严格校验取舍 / C2 空条件行 UX 提示）| 顺手清 |

---

## 主题详述（重头戏）

### F5-cont — C4 算法重写（🔴 连延 5 版 · 资金红线）
- **背景**：现 subset-sum DFS+剪枝在大候选 pool 下会误剪正确解；期望基线 TEST2.xlsx 57 行 / 10 渠道命中，v2.1.8 修 4/5 根因后实测 ~28 行 / 9 渠道，剩根因 #5 = 算法范式本质限制。
- **候选范式**：ILP（引 solver lib）/ 网络流（最小费用最大流，手写）/ 启发式+局部搜索。详 v2.1.11 backlog §F5-cont + D35。
- **风险红线**：C4 命中数直接影响对账金额匹配（资金红线）；算法切换破坏现有 byte-for-byte 测试；solver lib 包体。**必须 POC + 资金红线评审**。

### A3-multi-worker — 多 worker pool 并行（你 2026-05-29 问起的 worker pool）
- **背景**：v2.1.10 已实现单 worker（runCheck 跨进程化，event loop lag 66ms→1.3ms / 48.7x），但总耗时反增（worker 冷启 + DB 重开 + IPC）；多 worker 并行 chunk 才是加速目标（500w 行 18s → 7-9s，2-3x）。
- **技术核心**：SQLite WAL single-writer → 必须 write-splitting（reader 并行 SELECT JOIN → 主进程单 writer 批量 INSERT）。
- **待 spec 决策点**：D29 worker 数 / D30 write-splitting 方案 / D31 小数据回退阈值 / D32 跨模块 pool 共享 / D33 OOM 防御 / D34 进度聚合 —— 详 v2.1.11 backlog。
- **风险红线**：多 worker INSERT 写竞争触发 SQLITE_BUSY；byte-for-byte 资金一致性（多档数据集验证 + 单 worker fallback）；OOM 低配机器。

### A3-spread — A3 扩散其他对账模块
- bankBuRecon / bankStatement / reconIdFix 的 runCheck 提取 `runCheckCore` + worker 化（复用 v2.1.10 A3 范式）。reconIdFix 与 F5-cont C4 算法重写共同评估。详 v2.1.11 backlog §A3-spread + D36。

---

## 明确不做（范围边界 · 沿用 v2.1.x PRD 决策，非遗忘）

- **架构**：DB worker 跨线程共享（SQLite DatabaseSync 不支持）；bill_imports/flow_imports 加 CASCADE 到 runs（资金真理源不可跟随 run 删）。
- **测试**：覆盖率数字目标；CI 强制阻断（先观察）；第 3 层 main/renderer/session 编排 UI 单测（靠 smoke+preview+手测）。
- **功能**：N2 自取值表达式/模板（仅静态串）；N4 整表清理（仅清 raw_json 字段、保留行骨架+差异行）；N5 内置「通用」渠道可改名/删；**T2 聚合导出的移除核对**（仅单 run）；T3 FundType 下拉在线枚举编辑（仅读 xlsx）。

---

## 风险红线汇总（CLAUDE.md 规则 7）

| 主题 | 风险 | 级别 |
|---|---|---|
| F5-cont | C4 算法切换直接影响对账金额匹配 | 🔴 资金红线 |
| A3-multi-worker | write 竞争 SQLITE_BUSY / byte-for-byte / OOM | 🔴 + 🟡 |
| A3-spread | 各模块 runCheckCore 提取的业务逻辑差异 | 🟡 |
| SR-log-1 删旧双写 | 老用户日志路径切换 | 🟢（一次性提示 + USER_GUIDE 更新）|

---

## 待拍板决策点（v2.1.12 spec 阶段）

| ID | 主题 | 决策 |
|---|---|---|
| **D-NEXT-1** | **v2.1.12 主线选型** | F5-cont（资金红线，连延最久）/ A3-multi-worker（性能，用户问起）/ A3-spread / 纯收尾批 —— 二选一或排期 |
| D29-D34 | A3-multi-worker 6 点 | 沿用 v2.1.11 backlog（worker 数/write-splitting/回退/跨模块/OOM/进度）|
| D35 | F5-cont 算法范式 | ILP / 网络流 / 启发式 三选一（待 POC）|
| D36 | A3-spread 优先级 | 先做用户反馈"主进程卡"的模块 |

---

## 立项拍板结论（v0.2 · 2026-05-30）

用户拍板（3 轮决策）：

- **版本号**：`v2.1.12`（沿用 patch 号），**分 α / β 两阶段**推进；命名沿用项目惯例 `-alpha.N` / `-beta.N` → 收敛 stable `v2.1.12`（命名细节 spec 阶段最终定）。
- **F5-cont**：❌ 不做（连延第 6 版，留待后续）。
- **需求 1 模块归属**：VCC业务OP计算 = **新建第 6 模块**（独立于现有第 5 模块「业务OP数据核对」`bizOpRecon`，`src/renderer.js:70`）。
- **需求 1 计算语义**：**期初OP + 发生额 = 期末OP**；发生额 = 发生额入 − 发生额出（期初OP 指导入流水的上月值，由用户输入；期末OP 指导入流水所在月份，计算得出）。

### α 阶段（业务 + 收尾 · ~3-4 周）

| 块 | 内容 | 风险 |
|---|---|---|
| **需求1** | 新建第 6 模块「VCC业务OP计算」：导入文件→统计总条数→弹框确认月份+总条数→统计发生额出/入→状态框完成后点「开始运行」→弹框（显示发生额出/入/总额 + 输入期初OP→计算期末OP）→各文件发生额出/入/总额 + 输入OP + 计算OP 汇总落本地一张表→「显示余额」按钮：下拉选月份+查看→显示该月输入OP/总发生额/计算OP。UI 复用「月度银行对账单BU回填校验」样式，「导出差异」按钮替换为「显示余额」，其余按钮/状态框样式位置大小不变。 | 🟡 新持久化表 |
| **需求5** | 网关场景 extra fee 匹配（C3「资金对账不平」/ `gateway-recon-join`，`c3-gateway-recon-join.js`）：场景新增/修改弹窗（提取ReconId-From 网关 + 网关对账单，`renderer-dialogs.js`）左下角加勾选框「网关对账单金额与银行对账单不一致」，勾选后出现「网关对账单金额 + [输入框4字符] = 银行对账单金额」，匹配时订单金额 + extra fee 与银行对账单匹配。 | 🔴 资金红线 · 必做 POC + 评审 |
| **需求6** | 资金对账不平跳过提示条件修正（`renderer.js:3424` / `3472`）：仅当启用了「提取ReconId-From 网关」(`gateway-recon-join`) 类场景时才弹「需导入资金对账不平结果表 / 继续将跳过」提示；未启用则不弹、不要求该表。 | 🟢 |
| **收尾** | SR-log-1（删 `app_activity_log.txt` 旧双写）+ I6（bundle 旧结构 C2 端到端测试）+ I7（`important-variables.md` 升格 C2 `billTypes`/`conditions` schema） | 🟢 |

### β 阶段（性能架构 · ~6 周）

| 块 | 内容 | 风险 |
|---|---|---|
| **A3-multi-worker** | 多 worker pool 并行 chunk + write-splitting（reader 并行 SELECT JOIN → 主进程单 writer 批量 INSERT），目标 500w 行 2-3x。决策点 D29-D34。 | 🔴 SQLITE_BUSY / byte-for-byte / OOM · 必做 POC |
| **A3-spread** | 扩散 `runCheckCore` + worker 化到 bankBuRecon / bankStatement / reconIdFix（排在 multi-worker 范式落地之后）。决策点 D36。 | 🟡 |

---

**当前状态**：v0.2（2026-05-30 — 立项拍板完成，进入 α spec 阶段）。

**下一步**：PM 起 **α 阶段 spec**（需求1/5/6 + 收尾）；需求5（资金红线）spec 含 POC + 资金评审计划。β 阶段 spec 待 α 推进后另起。

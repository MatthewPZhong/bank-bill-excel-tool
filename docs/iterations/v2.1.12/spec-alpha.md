# v2.1.12 α 阶段 Spec（总纲）

> 状态：draft v0.1（2026-05-30）｜阶段：α（业务 + 收尾）｜版本：`v2.1.12-alpha.N`
> 立项结论见 `backlog.md`「立项拍板结论（v0.2）」。本总纲串起 3 份子 spec，汇总全局风险与开放问题。
> 起草方式：PM agent 分块起草（req1/req5）+ team-lead 接手补全（req6/收尾 + req1 §6，因 agent 在本环境多次中断）。

## 1 α 范围总览

| 块 | 子 spec | 工期 | 风险 | 状态 |
|---|---|---|---|---|
| 需求1 VCC业务OP计算（新建第 6 模块）| [`spec-alpha-req1-vcc.md`](./spec-alpha-req1-vcc.md) | ~6.5–8 天 | 🟡 新持久化 + 🔴 金额计算 | 完整，10 开放问题 |
| 需求5 网关 extra fee 匹配 | [`spec-alpha-req5-extrafee.md`](./spec-alpha-req5-extrafee.md) | ~3–5 天 | 🔴 资金红线（改 C3 匹配）| 完整，7 开放问题 |
| 需求6 资金对账不平跳过提示修正 | [`spec-alpha-req6-cleanup.md`](./spec-alpha-req6-cleanup.md) §1 | ~0.5–1.5 天 | 🟢 | ⚠️ 现状已实现，待澄清 |
| 收尾批 SR-log-1 / I6 / I7 | [`spec-alpha-req6-cleanup.md`](./spec-alpha-req6-cleanup.md) §2-4 | ~1.5–2 天 | 🟢（SR-log-1 破坏性）| 完整 |

**α 合计粗估 ~12–17 天（~2.5–3.5 周）**，与立项 ~3–4 周一致。

### 不做边界（α）
- VCC 模块：不导出 Excel（仅"显示余额"）、不跨月汇总、多币种暂不合并（见 req1 Q6）
- extra fee：默认范围仅 C3，不含 C4（见 req5 Q1）
- 性能（A3-multi-worker / A3-spread）属 β 阶段，本 spec 不含

## 2 全局风险红线汇总（CLAUDE.md 规则 7）

| 来源 | 红线 | 防御 |
|---|---|---|
| 需求5 | extra fee 改变 C3 网关核销金额匹配 → 错配/幽灵核销 | 默认关 byte-for-byte 一致（req5 §2.4）；`gwMatchesBank` undefined→null 防御；POC DS1-DS9 + 真实数据人工核对 |
| 需求1 | 发生额求和 + 期末OP=期初OP+发生额 属资金计算 | 精度策略（整数分/decimal）；出入方向识别；空/非数字行整批拒绝；测试覆盖正/负/小数/空 |
| SR-log-1 | 删 `app_activity_log.txt` 旧写入是破坏性变更 | 停止新写入但**保留历史文件不删**（删数据红线）；首次一次性迁移提示；USER_GUIDE 更新 |

**合并前硬要求**：需求5 必须有"真实网关+银行账单端到端 + 人工核对核销结果"证据，不能只靠单测。

## 3 开放问题汇总（共 20 个 · 2026-05-30 已全部定论）

### 3.1 ✅ 阻塞问题已拍板（4 个）

| # | 来源 | 拍板结论 |
|---|---|---|
| **A** | req5 Q1 | ✅ **仅 C3**（不含 C4；C4 匹配渠道账单非银行账单）|
| **B** | req6 Q-r6-1 | ✅ **数据维度**：启用 C3 但本次导入账单无命中行时也不弹"将跳过"→ 加数据侧预检（需求6 工期 +~1 天）|
| **C** | req1 Q2 | ✅ **流水对账单（28列，同第5模块）**：`出入方向`(direction) 分入/出 + `对账金额`(recon_amount) 求和，月份取 `账单日期`(bill_date_raw) |
| **D** | req5 Q5 | ✅ **A1**：fee 仅作用于"银行侧=发生额绝对值"字段对 |

### 3.2 资金红线 · 采纳 PM 推荐（⚠️ 请 review 时复核 — 规则 7）

| # | 来源 | 采纳方案 |
|---|---|---|
| E | req5 Q4 | extra fee 允许正负（代数 `gw+fee=bank`，用户填正=加/负=减）+ 允许小数 + 4ch 仅视觉不硬限 |
| F | req1 Q5 | VCC 金额：乘 100 转整数分求和、金额列存 TEXT；空值跳过、非数字行整批拒绝 |
| G | req5 Q7 | extra fee 精确 `===`，加法处 `Math.round((gw+fee)*100)/100` 归一到分 |

> 🔴 三项均为资金红线，已写入各子 spec；合并前必须有"真实数据端到端 + 人工核对"证据。E 的"允许正负"已规避方向歧义（方向由用户输入符号决定）。

### 3.3 业务默认 · 采纳推荐（如不符你的实际，告知即调）

| # | 来源 | 采纳方案 |
|---|---|---|
| H | req1 Q6 | ✅ **已定：支持混币种，计算全量发生额**（所有币种 `对账金额` 不分币种合并求和；🔴 口径=不区分币种的金额合计、非货币余额，已确认）|
| I | req1 Q8 | 出入方向非法值 / 一文件多月份 → 整批拒绝 + 错误报告（资金不容静默跳过）|

### 3.4 技术/UX 细节 · 按推荐走（可 Dev 定，列出供知会）

| # | 来源 | 推荐 |
|---|---|---|
| req1 Q1 | 扫描/统计中间结果存 main 进程会话（仿 lastRunCache）|
| req1 Q3 | 2 表（runs + run_files），不落流水原始行 |
| req1 Q4 | 同月多 run 留历史，显示余额取最新 |
| req1 Q7 | "显示余额"用弹框（复用 ExportDialog 结构）|
| req1 Q9 | module.id = `vcc-op-calc`，名称「VCC业务OP计算」|
| req1 Q10 | 期初OP 必填、允许正负小数、空/非数字禁用计算 |
| req5 Q2 | config 用嵌套 `extraFee:{enabled,amount}` |
| req5 Q3 | 旧场景惰性兜底（缺字段即关），不做 migration |
| req5 Q6 | 勾选框作为弹窗 body 末行靠左（非浮动） |
| req6 Q-cl-1 | SR-log-1 保留旧文件、停止写入、首次迁移提示 |
| req6 Q-cl-2 | I7 升格归 Risk-sensitive（与 runC2Scenario 同层）|

## 4 测试策略

| 层 | 覆盖 |
|---|---|
| unit（`node:test`）| VCC session 计算/精度（正/负/小数/空）；C3 extra fee DS1-DS9（含零回归 byte-for-byte）；I6 bundle 旧结构 C2 导入升级 |
| integration | scenario IPC 契约 |
| smoke | C3 extra fee 端到端 + 零回归断言；VCC 导入→计算→落库→查询 |
| preview 回归 | C3 配置弹窗（改 DOM）；VCC 新面板（补 4 处入口）|
| 资金红线手测 | 真实网关+银行账单（金额含手续费差）人工核对核销 |
| 总闸 | `npm run release-check` 全绿 + 提 PR 前 `/check-vars` |

未覆盖：第 3 层 UI 编排单测（靠 smoke+preview+手测）；性能（β 阶段）。

## 5 整体任务拆分 / 排期建议（供 team-lead）

各子 spec 已有任务表（req1 §6 T-vcc-1..9 / req5 §8 T1..9 / req6 §7 T-r6/T-cl）。建议执行顺序：

1. **先收尾批 + 需求6**（低风险、独立，快速清债建立节奏）：T-cl-1/2/3 + T-r6-1
2. **需求5 extra fee**（资金红线，先锁引擎+零回归单测，再 UI）：req5 T1→T5→T6→T2/3/4→T7/8/9
3. **需求1 VCC 模块**（最大，关键路径 DB→session→IPC→前端）：req1 T-vcc-1→3→4→5/6/7→8/9

> ⚠️ **实现阶段委托策略待定**：PM agent 在本会话环境多次中断（socket / tool-parse），4 次仅 1 完整成功。dev agent 同环境风险类似。建议实现阶段：要么主线程直接小步实现 + 频繁落盘，要么 dev agent 任务切到极小粒度（单文件单任务）并强制增量提交。提 PR 约束见 MEMORY `workflow_no_tester_no_auto_pr`（用户手测循环结束 + 明确说"提 PR"后才提）。

## 6 下一步

1. ✅ §3.1 四个阻塞问题已拍板（2026-05-30），结果已回填各子 spec（req5/req6/req1 reverse sync 完成）。
2. spec **draft v0.1 定稿**（资金红线 E/F/G + 业务默认 H/I 采纳推荐，待用户 review 复核；如无异议即进入实现）。
3. team-lead 按 §5 顺序拆 dev 任务、委托实现：先收尾批 + 需求6（低风险）→ 需求5 extra fee（资金红线，先锁引擎+零回归）→ 需求1 VCC 模块（最大）。
4. ⚠️ 实现委托策略（见 §5）：agent 在本环境不稳定，倾向主线程小步实现 + 频繁落盘，或 dev agent 极小粒度任务。

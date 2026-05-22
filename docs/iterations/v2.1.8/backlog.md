# v2.1.8 迭代清单（Backlog）

> 立项阶段清单，spec 评审启动后逐项展开为 PRD-v2.1.8.md / spec.md / tasks.md。
> 来源：v2.1.7 PRD §十「F5 延期 + A3 联合」预告 + 本次（2026-05-22）用户新增 G1。

## 主题概览

v2.1.8 双线绑定 + 工程基建一线，共 **4 个独立条目**：

| 编号 | 主题 | 性质 | 风险 | 工期预估 | 来源 |
|---|---|---|---|---|---|
| **F5** | C4 manyToOne 算法重设（BillDate 数字日期 + maxSize 上限 + 遍历顺序 + currency 过滤） | 资金红线 · 算法重设 | 🔴 HIGH | ~1 周 | v2.1.7 PRD §10.4 / §10.6 延期项 |
| **A3** | `acquiringBillCurrency.runCheck` 搬到 worker_threads / utilityProcess | 架构级 · 跨进程 IPC | 🔴 HIGH | ~1-1.5 周 | v2.1.7 PRD §10.6 / §12.1.3 联合主题 |
| **A4** | SQL JOIN chunked LIMIT/OFFSET 分批跑（与 A3 联合决策） | 性能优化 | 🟡 MID | 与 A3 合并评估 | v2.1.7 PRD §12.1.3 留挂 |
| **G1** | 引入单元测试框架 + 全量铺设 unit test | 工程基建 · 测试基础设施 | 🟢 LOW | ~1-2 周（按"全量铺"口径） | 2026-05-22 用户立项 |

**资金红线提醒（CLAUDE.md 规则 7）**：F5 + A3 + A4 三条都涉及资金 / 对账 / 状态机变更，spec 阶段必须有专门 reviewer。G1 不动业务代码，但 unit case 一旦落地会**钉死现有金额/币种/对账契约**，PR review 需关注 case 期望值的准确性。

---

## F5 — C4 manyToOne 算法重设

**背景**：v2.1.7 延期。用户提供 TEST2.xlsx 期望基线 57 行 / 10 渠道命中，v2.1.7 单点 fix 仅达到 28 行 / 9 渠道命中（差距 29 行 / 1 渠道）。

**根因（PM 已诊断，详 v2.1.7 PRD §10.3）**：

1. `recon-id-fix-io.js:70` 用 `raw:true` 读 sheet → Excel 日期变成 number 序列号 → `c4-recon-id-fix.js:1058-1065` 直接赋给 BillDate → `parseBillDateMs` 正则不认 → 候选全 fail（单点 fix 可解 28 行）
2. `c4-recon-id-fix.js:findBestAmountSubset` 的 subset-sum `maxSize=8` 硬上限剪掉 16 行 / 11 行子集
3. `tryManyToOnePool` 按 right 行顺序遍历 left 池 → 4M 子池被前面渠道抢光
4. 窗口扩大（±7/±10）反而下降 —— tie-break 偏置

**v2.1.8 需做（详 v2.1.7 PRD §10.4 PM 留言）**：

- [ ] BillDate 数字日期解析 fix（`recon-id-fix-io.js` + `c4-recon-id-fix.js:1058-1065`）
- [ ] 放开 `findBestAmountSubset` maxSize 硬上限（或按金额量级动态调整）
- [ ] 改 manyToOne 遍历顺序：按"子集大小降序"或"金额降序"
- [ ] 评估 currency 字段过滤增强精度
- [ ] 性能与正确性 trade-off 设计评审 + 多轮 smoke
- [ ] 回归保护：v2.1.6 现有 business + gateway smoke 全套不得破坏

**TEST 数据基线**：`/Users/pzhong/Desktop/小助手-Debug/2.1.7/`
- `TEST.xlsx`（v2.1.6 实测 0 命中）
- `TEST2.xlsx`（用户提供"订单修复"sheet 含 57 行期望基线）

**重要变量影响（待 check-vars 详查）**：触及 `c4-recon-id-fix.js` 的 `findBestAmountSubset` / `tryManyToOnePool` / `parseBillDateMs` —— 至少 Critical 层 1 项 + Important-skeleton 层 1 项。

---

## A3 — runCheck 跨进程化（worker_threads / utilityProcess）

**背景**：v2.1.7 F7-A1（PRAGMA）+ F7-A2（索引）+ F7-B1（系统通知）是短期缓解，预计降低 unresponsive 概率 30-50%。A3 是根本解 —— 彻底解除主进程 SQL 阻塞。

**待评估决策点（spec 阶段拍板）**：

- [ ] **架构选型**：worker_threads（Node 原生）vs Electron utilityProcess（更深整合）—— 二选一
- [ ] **DB 连接**：worker_threads 无法共享 `DatabaseSync` 实例 → worker 内重新打开 + 复用现有 PRAGMA
- [ ] **进度回调链路**：worker → main → renderer 多一跳 IPC，需复用 v2.1.7 F6 的 `acquiringBillCurrency:run:progress` 范式
- [ ] **错误传播**：worker 抛错不能直接跨进程 → 需 message 包装 + 反序列化
- [ ] **取消语义**：renderer 取消 → main → worker.terminate() / postMessage('cancel')
- [ ] **冷启动开销**：worker 启动 + DB 重连耗时是否抵消并行收益

**回归保护**：v2.1.7 现有 19 个 smoke suite 全跑 + 新增 worker 专项 smoke。

**重要变量影响**：`acquiring-bill-currency-session.js` 全文搬迁，触及 Runtime-state 层多项。

---

## A4 — SQL JOIN chunked 分批跑

**背景**：v2.1.7 PRD §12.1.3 明确留挂。「与 worker 方案冲突，留 v2.1.8 与 A3 统一决策」。

**待评估**：

- [ ] 若 A3 worker 方案直接解决"主进程不阻塞"，A4 是否必要？
- [ ] 若仍需要：chunked LIMIT/OFFSET 拆分点选哪一层 SQL（外层 JOIN / 内层子查询）
- [ ] chunk size 选型（10w / 50w / 100w 行）

**决策窗口**：A3 spec 评审中一并决策，**不独立立项**。

---

## G1 — 单元测试框架引入（全量铺设）

**用户决策（2026-05-22）**：要做就直接全部做，不渐进试点。

### 背景

v2.1.7 现状（CLAUDE.md 已陈述）：
- 无单元测试框架
- `npm run smoke` 是唯一被认可的自动化测试（集成级）
- `scripts/test-v*.js` 是按 feature 切分的集成测试，与 smoke 同层级
- preview 截图覆盖 UI 回归

**缺口**：纯逻辑层（normalizers / validators / scenario-engines）0 unit 兜底，bug 高发区只靠 smoke 粗筛。

### 目标

为应用建立单元测试基础设施 + **全量铺设** 第 1 层（纯函数）+ 第 2 层（带轻副作用模块）unit case。

### 范围

**纳入 unit 全量覆盖**（按 CLAUDE.md / 项目实际结构分层）：

🟢 **第 1 层（纯函数）** —— ROI 最高，**必须 100% 覆盖**：

- [ ] `src/backend/file-service/normalizers.js`（日期 / 金额 / 币种归一）
- [ ] `src/backend/file-service/common.js`（`FileValidationError` 构造与序列化）
- [ ] `src/backend/file-service/error-causes.js`（错误分类映射）
- [ ] `src/backend/acquiring-bill-currency-import/validator.js`
- [ ] `src/backend/bank-bu-recon-import/validator.js`
- [ ] `src/backend/biz-op-recon-import/validator.js`
- [ ] `src/backend/pending-import/validator.js`
- [ ] `src/main-process/scenario-engines/engine-utils.js`
- [ ] `src/main-process/scenario-engines/c1-extract-recon-id.js`
- [ ] `src/main-process/scenario-engines/c2-offset-bill-mark.js`
- [ ] `src/main-process/scenario-engines/c3-gateway-recon-join.js`
- [ ] `src/main-process/scenario-engines/c4-recon-id-fix.js`（**与 F5 强相关 —— F5 算法重设的 unit case 在此沉淀**）
- [ ] `src/constants/*.js`（字段表自洽性）
- [ ] `src/backend/*-db/columns.js`（schema 完整性）

🟡 **第 2 层（带轻副作用，fixture 支持）** —— **必须覆盖**：

- [ ] `src/backend/database/template-repository.js`（in-memory sqlite）
- [ ] `src/backend/database/scenarios-repository.js`
- [ ] `src/backend/database/settings-repository.js`
- [ ] `src/backend/balance-seed-store.js`（tmpdir）
- [ ] `src/backend/balance-adjustment-store.js`
- [ ] `src/backend/big-account-mode-store.js`
- [ ] `src/backend/big-account-order-store.js`
- [ ] `src/backend/own-account-store.js`
- [ ] `src/backend/file-service/readers.js`（tmpdir + 小 fixture xlsx）
- [ ] `src/backend/file-service/writers.js`
- [ ] `src/backend/pending-db/*-repository.js`（4 个 repository）
- [ ] `src/backend/acquiring-bill-currency-db/*-repository.js`（2 个）
- [ ] `src/backend/bank-bu-recon-db/*-repository.js`（2 个）
- [ ] `src/backend/biz-op-recon-db/*-repository.js`（3 个）
- [ ] `src/main-process/monthly-balance.js`（注入 mock store）
- [ ] `src/main-process/recon-id-fix-engine.js`
- [ ] `src/main-process/statement-generation.js`

🔴 **第 3 层（编排 / UI）** —— **明确不做 unit**，依赖 smoke + preview + 手动测试：

- `src/main.js`（IPC orchestration，~7500 行）
- `src/preload.js`（contextBridge）
- `src/renderer.js` / `src/renderer-dialogs.js` / `src/renderer-pending.js` / `src/renderer-previews.js`
- `src/main-process/*-session.js`（3 个 session 状态机，归 smoke）
- `src/main-process/pending-archive-worker.js`（worker 子进程，归 smoke）

### 框架选型

**默认推荐：Node 内置 `node:test`**

理由：
- 零 devDependencies 新增（符合项目轻量化偏好，当前 devDeps 只有 3 个）
- Node 22 已稳定，与 `node:sqlite`（项目已用）同代
- 语法接近 Jest，无学习成本
- 自带 TAP reporter，CI 友好

> spec 阶段如需对比 Vitest / Jest，可在 PRD-v2.1.8.md G1 §1 加替代方案对比。

### 不做

- ❌ 不强制 CI 阻断（试跑 1-2 个版本后再决定是否升级为阻断）
- ❌ 不追求覆盖率数字（覆盖率 ≠ 质量；只测"纯逻辑 + 高 bug 风险"）
- ❌ 不动 `scripts/test-v*.js`（保留作为集成层，新建 `tests/unit/` 隔离）
- ❌ 不替代 smoke / preview / 手动测试

### 流程影响

| 维度 | 变化 |
|---|---|
| 目录新增 | `tests/unit/`（按 src 镜像分层） |
| package.json | 新增 `"test:unit": "node --test tests/unit/"` |
| PR body | 触及第 1/2 层模块时，新增"unit case 列表"段落 |
| check-vars | 重要变量 case 钉死（变更需同步更新 case） |
| smoke / preview | **不变** |
| 文档三件套 | CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 同步登记 G1 |
| 多版本维护 | cherry-pick 时 unit case 一起带走，**降低**回归风险 |

### 风险

- 🟢 不动业务代码，不影响线上行为
- 🟡 **case 期望值的"权威性"问题**：第一批 case 直接基于"当前实现"录入，等于把"当前行为"凝固成契约 → 需在 PR review 阶段人工复核每条 case 是不是"业务真实期望"而非"实现 bug 的复刻"
- 🟡 工期：1-2 周全量铺，**会挤压 F5/A3/A4 并行带宽**

### 与 F5 的协同

F5 算法重设过程中产生的"输入 → 期望输出"对，**直接落成 c4-recon-id-fix.js 的 unit case**。G1 是 F5 的"算法正确性 guard" —— F5 改完 unit 全绿 = 没改坏存量行为；F5 期望新增的 57 行 case 进 unit = 新行为契约固化。

**实施顺序建议**：
1. G1 框架搭建 + 第 1 层全量铺（前 3-5 天）
2. F5 spec 评审同时启动，TEST2.xlsx 期望基线先转 unit case
3. F5 实现 + 第 2 层 unit 并行
4. A3 spec 评审晚启动（worker 架构设计 ≥ 3 天）
5. A4 决策跟随 A3

---

## v2.1.8 spec 评审启动 checklist

启动 v2.1.8 spec 评审时需要补齐：

- [ ] 建立 `PRD-v2.1.8.md`（仿 v2.1.7 PRD 结构，每条目独立章节）
- [ ] 建立 `spec.md`（资金红线评审输出）
- [ ] 建立 `tasks.md`（task 颗粒拆分）
- [ ] F5 / A3 / A4 / G1 顺序与并行带宽决策
- [ ] 重新跑 `npm run scan:vars`，评估 c4-recon-id-fix 相关变量是否需升格
- [ ] TEST.xlsx / TEST2.xlsx 是否纳入 fixture 库

---

**当前状态**：立项 backlog，**v2.1.7 未合并 main 前不开始 v2.1.8 任何代码**（沿用 v2.1.7 PRD §10.6 约束）。

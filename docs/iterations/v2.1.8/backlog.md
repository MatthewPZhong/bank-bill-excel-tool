# v2.1.8 迭代清单（Backlog）

> 立项阶段清单，spec 评审启动后逐项展开为 PRD-v2.1.8.md / spec.md / tasks.md。
> 来源：v2.1.7 PRD §十「F5 延期 + A3 联合」预告 + 2026-05-22 用户新增 G1 + 2026-05-22 用户新增 N1/N2/N3。

## 主题概览

v2.1.8 双线绑定 + 工程基建一线 + 3 项功能/缺陷，共 **7 个独立条目**：

| 编号 | 主题 | 性质 | 风险 | 工期预估 | 来源 |
|---|---|---|---|---|---|
| **F5** | C4 manyToOne 算法重设（BillDate 数字日期 + maxSize 上限 + 遍历顺序 + currency 过滤） | 资金红线 · 算法重设 | 🔴 HIGH | ~1 周 | v2.1.7 PRD §10.4 / §10.6 延期项 |
| **A3** | `acquiringBillCurrency.runCheck` 搬到 worker_threads / utilityProcess | 架构级 · 跨进程 IPC | 🔴 HIGH | ~1-1.5 周 | v2.1.7 PRD §10.6 / §12.1.3 联合主题 |
| **A4** | SQL JOIN chunked LIMIT/OFFSET 分批跑（与 A3 联合决策） | 性能优化 | 🟡 MID | 与 A3 合并评估 | v2.1.7 PRD §12.1.3 留挂 |
| **G1** | 引入单元测试框架 + 全量铺设 unit test | 工程基建 · 测试基础设施 | 🟢 LOW | ~1-2 周（按"全量铺"口径） | 2026-05-22 用户立项 |
| **N1** | 收单单据币种校验：两种导入表 cleanup 动作置后执行 | 性能优化 · cleanup 时机 | 🟡 MID（待澄清"置后"语义） | ~0.5-1 天 | 2026-05-22 用户立项 |
| **N2** | 场景管理 — From 网关 — 对账成立后赋值：第二下拉框新增"自取值" + 输入框 | 功能增强 · UI + 引擎 + DB migration | 🟡 MID | ~1-2 天 | 2026-05-22 用户立项 |
| **N3** | 银行对账单处理：(1) 状态框命中场景号与 UI 序号不一致修复；(2) 新增"处理后行数据 + 命中场景"列导出 | 缺陷修复 + 功能增强 | 🟡 MID | ~1-2 天 | 2026-05-22 用户立项 |

**资金红线提醒（CLAUDE.md 规则 7）**：F5 + A3 + A4 三条都涉及资金 / 对账 / 状态机变更，spec 阶段必须有专门 reviewer。G1 不动业务代码，但 unit case 一旦落地会**钉死现有金额/币种/对账契约**，PR review 需关注 case 期望值的准确性。N2/N3 触及对账配置/对账结果导出，属于对账契约边缘，spec 阶段需 review。

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

## N1 — 收单单据币种校验：两种表 cleanup 置后执行

**用户原话**：「收单单据币种校验模块两种表的 cleanup 的动作置后执行」

### 代码现状（PM 调研 2026-05-22）

**两张表（实际共涉及 3 张）**：
- `acquiring_bill_currency_flow_imports` — 收单流水表（48 列）
- `acquiring_bill_currency_bill_imports` — 收单单据表（26 列）
- `acquiring_bill_currency_diff_rows` — 差异行结果表（cleanup 时一起清）

**cleanup 函数**：
- `cleanupAfterRunBackground`：`src/main-process/acquiring-bill-currency-session.js:278`
- `cleanupOrphanData`：`src/main-process/acquiring-bill-currency-session.js:329`（启动期孤儿清理，与本需求**无关**）

**cleanup 当前调用点**：
- 对账后异步清理：`src/main.js:10307`（`acquiringBillCurrency:run` IPC handler 内，runCheck return 后 `setImmediate` 触发）
- 启动期孤儿清理：`src/main.js:10527`（migration 完成后 `setImmediate`）

**runCheck 6 阶段流水**：
```
P1: clearing-old-runs      → clearRunsByMonth 清历史
P2: computing-stats        → 计算本月 flow/bill 统计
P3: inserting-run          → 插入新 run 记录
P4: sql-joining            → SQL JOIN 写 diff_rows
P5: writing-xlsx           → 生成 diff.xlsx + report.xlsx
P6: updating-paths         → 回填文件路径
→ handler return 后 setImmediate → cleanupAfterRunBackground（异步分批清 3 张表）
```

### 用户决策（2026-05-22）

✅ **采用解读 B**：移出对账链路，改延后触发。

### 改动点（解读 B）

- [ ] runCheck return 后**不再立即触发** `cleanupAfterRunBackground`，仅打 `cleanupPending=true` 标志
- [ ] 标志位持久化到 SQLite（settings 表或 runs 表新列）—— 应用退出也不丢
- [ ] 接入选定触发时机的钩子（详见下方"待澄清")

### 待澄清（B 内部子决策）

**用户反问 Q1（2026-05-22）**：「下次进入模块时清——清的过程会卡吗？」

**PM 读代码回答**（`acquiring-bill-currency-session.js:275-318` + `main.js:204-222`）：
- UI 渲染层：**不卡**（每批 50000 + `setImmediate` 让出 + 单批短事务）
- mutex lock 层：**间接卡**——用户进入模块想立即按"导入/运行"，会被 mutex 挡到 cleanup 完成（500w 行约 20-40 秒/表，3 表合计可能 1 分钟级）

**PM 重新倾向（推翻原 (1)+(2) 组合）**：

| 方案 | 触发点 | 用户感知 | PM 推荐 |
|---|---|---|---|
| α | 进入模块时清 + UI 显示进度 + 按钮 disable | 看见状态但等待感强 | |
| **β** | **应用退出时清**（`app.before-quit`）为主 + 进入模块时为兜底 | 主路径 0 感知，退出多等几十秒可接受 | ✅ |
| γ | 进入模块 + N 秒无操作触发（idle callback） | 感知最小但实现复杂 | |

**用户拍板（2026-05-22）**：✅ **β** — 应用退出时清为主（`app.before-quit`）+ 进入模块时为兜底。

### 改动点细化（β 方案）

- [ ] `app.before-quit` 钩子：检测 `cleanupPending=true` → 阻塞退出（`event.preventDefault()`）→ 弹"正在清理上次结果..."进度框 → cleanup 完成后 `app.quit()`
- [ ] 进入模块兜底：用户切到收单单据币种校验模块时，main.js handler 检查 `cleanupPending=true` → 若有，触发后台 cleanup（保持 v2.1.7 setImmediate 异步模式）+ UI 仅 toast 提示不阻断
- [ ] `cleanupPending` 持久化：建议存 SQLite `acquiring_bill_currency_runs` 表新列 `cleanup_pending INTEGER DEFAULT 0`，runCheck 成功后 SET=1，cleanup 完成 SET=0
- [ ] runCheck 内 `setImmediate(cleanupAfterRunBackground)` 触发链路**移除**（main.js:10307），改为仅打标志位
- [ ] 启动期 `cleanupOrphanData` 不变（已覆盖应用强杀场景，β 不影响）

### 风险点

- **DB 写锁竞争**：cleanup 异步分批 DELETE 每批自包含 `safeBegin/COMMIT`，置后不解决根本问题，反而推迟问题
- **重试语义变化**：cleanup 推迟后，若用户重跑 runCheck，需确认 P1 `clearRunsByMonth` 是否覆盖未清的 diff_rows
- **重要变量影响**：触及 `acquiring-bill-currency-session.js` Runtime-state 层多项

---

## N2 — 场景管理：From 网关「对账成立后赋值」新增"自取值"

**用户原话**：「新增/修改场景 — 提取ReconId-From 网关中，"对账成立后赋值"的右侧第二个下拉框新增枚举值"自取值"，"自取值"置于下拉框枚举值列表从上向下数第二个；"对账成立后赋值"的右侧第二个下拉框的为"自取值"时，下拉框的右侧出现输入框」

### 代码现状（PM 调研 2026-05-22）

**场景类型 → 引擎**：
- 场景类型：`gateway-recon-join`（C3）
- 引擎文件：`src/main-process/scenario-engines/c3-gateway-recon-join.js`
- 关键函数：`runC3Scenario()`（:68），赋值逻辑 :99-173

**UI 位置**：
- 对话框工厂：`src/renderer-dialogs.js:6103-6115`（C3 dialog）
- 第二下拉框：`<select data-field="assign-bank">` —— 用户口中的"右侧第二个下拉框"
- 事件绑定：`renderer-dialogs.js:6228-6233`

**当前枚举值（45 项）**：
- 来源常量：`src/constants/bank-statement-fields.js:60-63` 的 `BANK_STATEMENT_FIELDS_FOR_C3`
- 字段：44 个标准银行字段 + 1 个虚拟字段「发生额绝对值」
- preload 中也 inline 一份（需同步）

**数据存储结构**：
```js
config_json.assign = {
  gwField: "Amount",          // 网关字段
  bankField: "Credit Amount"  // 银行字段（第二下拉当前值）
}
```

**引擎读取逻辑**：`c3-gateway-recon-join.js:158-172` 直接 `chosen.row[assign.gwField]` 赋值

**项目已有"下拉=X 时显示输入框"先例**：`renderer-dialogs.js:6420-6435`（C1 条件行 `opNeedsValue()` 模式）—— **可直接复用**

### 改动点

#### UI 层（`renderer-dialogs.js`）

- [ ] 第二下拉框枚举列表插入「自取值」到从上往下第 2 位
- [ ] 第二下拉框 change 事件新增分支：选「自取值」→ 右侧显示 `<input type="text">`
- [ ] dialog 保存时收集 `customValue` 字段
- [ ] dialog 打开时按 `assign.mode` 回显（"direct" → 隐藏 input，"custom" → 显示 input）

#### 数据结构（`config_json.assign`）

- [ ] 扩展为 `{ gwField, bankField, mode: 'direct' | 'custom', customValue: string }`
- [ ] **数据库 migration 必需**：`src/backend/database/migrations.js` 新增 idempotent migration，扫描所有 scenarios 的 `config_json`，为旧 scenario 补 `assign.mode = 'direct'`

#### 引擎层（`c3-gateway-recon-join.js`）

- [ ] :158-172 新增分支：
  ```js
  const newValue = (assign.mode === 'custom')
    ? assign.customValue
    : normalizeCellValue(chosen.row[assign.gwField]);
  ```

#### 同步点

- [ ] `src/preload.js` 中 inline 的 `BANK_STATEMENT_FIELDS_FOR_C3` 需同步（或评估是否能去重）
- [ ] 场景模板 bundle 导出 v3 → 是否需要 bundleVersion 升 v4？（取决于旧版本能否 graceful 降级）

### 用户决策（2026-05-22）

✅ **采用 (a) 静态字符串**：用户填什么就赋什么，纯静态值。表达式/模板留 v2.1.9+。
✅ **v2.1.8 就做**（不延期）。

### 用户决策（2026-05-22 Q2）

✅ **字段命名**：`assign.mode`（`'direct' | 'custom'`）+ `assign.customValue`（字符串）
✅ **输入框校验**：不允许空（保存时校验报错）+ 200 字符上限 + 不限字符类型
✅ **模板 bundle 版本**：继续 v3（向后兼容只追加字段，旧版本 reader 忽略走 direct 路径）

### 风险点

- **对账契约变更**：scenarios 数据结构升级，需保证 v2.1.7 老 scenario 自动 graceful 升级（用户场景库已沉淀，不能丢） → migration 补 `assign.mode='direct'`
- **模板 bundle 兼容**：CLAUDE.md 已记录 `bundleVersion` v2→v3，需评估 N2 是否触发 v4（PM 评估：不需要，向前兼容）

---

## N3 — 银行对账单处理：场景号修复 + 新增导出列

**用户原话**：
- (1)「银行对账单处理对账后，状态框显示的命中场景号与场景管理里的序号对不上」
- (2)「银行对账单处理对账后，还需生成一个 xlsx 文件，存放经过处理后的行数据，加一个字段显示命中了什么场景」

### 代码现状（PM 调研 2026-05-22）

**模块入口**：
- Session：`src/main-process/bank-bu-recon-session.js:51` `runReconciliation()`
- Dispatcher：`src/main-process/scenario-dispatcher.js:66` `runAllScenarios()`（first-match-wins 调度，v2.1.7 F8 扩展）
- C4 独立流水线：`src/main-process/recon-id-fix-engine.js:12` `runReconIdFix()`
- IPC：`src/main.js:3011` `bank-statement:run` handler

### N3-1 现状 — 命中场景号不对齐根因

| 端 | 编号来源 | 值示例 |
|---|---|---|
| **Main 端** | `scenario-dispatcher.js:99` → `hitScenarioIds.push(scenario.id)` **直接推 DB 自增 id** | `[1, 5, 7, 9]`（如场景表中部分被删除） |
| **IPC 字段** | `main.js:3045` 返回 `stats.hitScenarioIds` | |
| **Renderer 显示** | `renderer.js:3319` `已处理：xx 行命中（场景 ${ids.join('、')}）` **直接渲染 DB id** | "场景 1、5、7、9" |
| **场景管理 UI 列表** | `renderer-dialogs.js:5506` 用 `displayIndex` (1-based 列表顺序) | "1、2、3、4"（同样 4 个场景） |

**根因**：Main 端用 DB id，UI 列表用 displayIndex —— 两者编号体系不同。

### N3-2 现状 — 处理后行数据 + 命中场景列

**当前导出**：
- **主输出** xlsx（用户 saveDialog 选路径）：
  - Sheet 1「渠道对账单」（命中行）
  - Sheet 2「未命中场景行」（v2.1.7 F8 新增）
- **Error-report** xlsx（自动落 `exports/{date}/`）：5 列错误报告

**行数据持有**：
- 变量：`processingResult.modifiedRows`（`main.js:3032`）
- **已有 metadata**：`_hitScenarioId` + `_hitScenarioName`（`scenario-dispatcher.js:141` 已附加）
- 但 `exceljs-writer.js:25-29` 的 `INTERNAL_FIELDS` 过滤掉了 `_` 前缀字段 → Excel 不可见

**与 v2.1.7 F8 关系**：N3-2 是 `exceljs-writer` 同一 writer 的**扩展**，不是新起独立 xlsx —— 复用现有第 2 sheet 机制 + 新增可见列。

### 改动点

#### N3-1（命中场景号修复）

**方案二选一（用户拍板）**：

| 方案 | 改动 | 优点 | 缺点 |
|---|---|---|---|
| **A** | Main 端推 displayIndex（按 scenarios 列表顺序的 1-based 编号） | UI 一致 | Main 端需查询 scenarios 列表算 displayIndex |
| **B** | Renderer 端显示前查 scenarios 列表把 DB id 翻成 displayIndex | Main 端不动 | Renderer 多一次查询 |

PM 倾向 A（场景编号是用户视角概念，应在数据源头统一）。

- [ ] 修改 `scenario-dispatcher.js:99` 推送结构 `{ id, displayIndex, name }`
- [ ] 修改 `renderer.js:3319` 显示 `displayIndex` 而非 `id`

#### N3-2（新增 Sheet 3 — 用户决策 2026-05-22）

✅ **采用：复用同一 xlsx，新增 Sheet 3** 放"处理后行数据 + 命中场景列"。

**Sheet 1（渠道对账单）和 Sheet 2（未命中场景行）保持原状不动**，避免破坏 v2.1.6/v2.1.7 已稳定的输出格式。

- [ ] 修改 `exceljs-writer.js`：新增 Sheet 3 写入分支
- [ ] Sheet 3 数据源：`processingResult.modifiedRows`（已附 `_hitScenarioId` + `_hitScenarioName` metadata）
- [ ] Sheet 3 列结构 = 原 44 列 banker headers + 末尾新增「命中场景」列
- [ ] `INTERNAL_FIELDS` 过滤逻辑保留（其他下划线字段仍然过滤，仅"命中场景"通过显式列拼装）

### 用户决策（2026-05-22）

✅ **N3-2 方案**：复用 xlsx + 新增 Sheet 3（非 Sheet 1 加列，非独立 xlsx）

### 用户决策（2026-05-22 Q3 + Q4）

✅ **N3-1 方案**：A — Main 端推 `displayIndex`（源头统一，源数据 = `scenarios` 列表按顺序的 1-based 序号）
✅ **N3-2 Sheet 3 命名**：`命中场景行`（与 Sheet 2 "未命中场景行" 对仗）
✅ **N3-2 Sheet 3 范围**：只放 `modifiedRows`（命中行）
✅ **N3-2 "命中场景"列位置**：末尾追加（44 列原 headers 之后）
✅ **N3-2 "命中场景"列值格式**：`[序号] 场景名称`（与 N3-1 状态框文案对仗，序号同样用 displayIndex）

### 风险点

- **资金红线**：bank-bu-recon 是核心对账模块，N3-1 改 IPC 字段结构需 smoke 全跑
- **modifiedRows + unmatchedRows = bankRows** 不变量已护栏，新增列不影响
- **重要变量影响**：触及 `scenario-dispatcher.js` 的 `hitScenarioIds`、`exceljs-writer.js` 的 `INTERNAL_FIELDS` —— 至少 Important-skeleton 层 1 项

---

## v2.1.8 spec 评审启动 checklist

启动 v2.1.8 spec 评审时需要补齐：

- [ ] 建立 `PRD-v2.1.8.md`（仿 v2.1.7 PRD 结构，每条目独立章节）
- [ ] 建立 `spec.md`（资金红线评审输出）
- [ ] 建立 `tasks.md`（task 颗粒拆分）
- [ ] F5 / A3 / A4 / G1 / N1 / N2 / N3 顺序与并行带宽决策
- [ ] 重新跑 `npm run scan:vars`，评估相关变量是否需升格
- [ ] TEST.xlsx / TEST2.xlsx 是否纳入 fixture 库
- [x] N1 "置后"语义 → **B：移出对账链路**（2026-05-22 用户拍板）
- [x] **N1-B 触发时机** → **β：退出时清为主 + 进入时兜底**（2026-05-22 用户拍板）
- [x] N2 "自取值"语义 → **(a) 静态字符串**（2026-05-22 用户拍板）
- [x] N2 v2.1.8 范围 → **就做，不延期**（2026-05-22 用户拍板）
- [x] N2 字段命名 → **`assign.mode` + `assign.customValue`**；输入框：不允许空 + 200 字符 + 不限字符（2026-05-22 用户拍板）
- [x] N3-1 修复方案 → **A：Main 端推 displayIndex**（2026-05-22 用户拍板）
- [x] N3-2 输出形态 → **复用同一 xlsx + 新增 Sheet 3**（2026-05-22 用户拍板）
- [x] N3-2 Sheet 3 → 名"命中场景行" / 只放 modifiedRows / 末尾追加列 / `[序号] 场景名称`（2026-05-22 用户拍板）
- [x] **整体并行带宽** → **v2.1.8 单版本走完 7 项**（2026-05-22 用户拍板）

---

**当前状态**：~~立项 backlog~~ → **已升级为 PRD/spec/tasks 三件套**（2026-05-22 v0.1）。本文件保留作为立项画像与决策溯源参考，不再更新。

**升级后文档**：
- `PRD-v2.1.8.md` v0.1 — 14 章节，含需求概述/版本目标/7 项功能详细/验收矩阵/风险汇总/三件套登记
- `spec.md` v0.1 — 8 章节，含 27 个 spec 决策点（F5/A3/N1/N2/N3 资金红线评审）
- `tasks.md` v0.1 — 42 个 task / 9 Phase / 依赖图

**仍按 v2.1.7 PRD §10.6 约束**：v2.1.7 未合并 main 前不开始 v2.1.8 任何代码。

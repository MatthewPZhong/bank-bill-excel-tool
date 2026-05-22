# PRD — v2.1.8 迭代：C4 算法重设 + runCheck 跨进程化 + 单元测试框架 + 3 项功能/缺陷

| 字段 | 值 |
|---|---|
| 文档版本 | v0.2（2026-05-22 — T08 Reverse Sync 修订 F5 改动点：BillDate 字符串化从 reader 入口 → c4 引擎入口；spec.md F5-D4 同步改为 (b)）；v0.1 = 初始版起草 |
| 目标版本 | `v2.1.8`（patch / minor 待定，G1 引入新目录可能升 minor） |
| 起始版本 | `v2.1.7`（v2.1.7 完成时 main 状态；本 PRD 制定时 v2.1.7 尚未合并 main） |
| 起草日期 | 2026-05-22 |
| 起草人 | PM |
| 状态 | 起草中（v0.1，待 spec 评审 + 用户最终拍板） |
| 关联文档 | `backlog.md`（立项画像）/ `spec.md`（待建）/ `tasks.md`（待建）/ v2.1.7 PRD §十（F5 延期记录） |
| 涉及模块 | 银行对账单处理（C4 算法 + N3-1/N3-2）+ 收单单据币种校验（A3 跨进程 + A4 SQL 分批 + N1 cleanup 置后）+ 场景管理（N2 自取值）+ 全局工程基建（G1 单元测试） |
| 工作分支 | `v2.1.8`（基于 `main`，待 v2.1.7 → main 合并后从 main 拉） |
| 依赖 | v2.1.7（含 F7-A1 全局 PRAGMA / F7-A2 索引 + ANALYZE / F8 scenario-dispatcher unmatchedRows + 第 2 sheet / 18+ 个 smoke suite） |
| package.json.version | 暂保持 `2.1.7`；发布前由用户决策是否 bump 到 `2.1.8` |

---

## 一、需求概述

v2.1.8 包含 **7 项独立改动**（F5/A3/A4/G1/N1/N2/N3），覆盖四个模块 + 一项工程基建：

1. **F5 — C4 manyToOne 算法重设 🔴 资金红线**：v2.1.7 延期项，用户提供 TEST2.xlsx 期望基线 57 行 / 10 渠道命中，v2.1.7 单点 fix 仅达 28 行 / 9 渠道命中。根因 = `recon-id-fix-io.js:70` BillDate 数字日期 + `c4-recon-id-fix.js:findBestAmountSubset` maxSize=8 硬上限 + `tryManyToOnePool` 遍历顺序偏置。本次重设：BillDate 字符串化 + 放开 maxSize + 改遍历顺序 + 评估 currency 字段过滤。
2. **A3 — runCheck 跨进程化**：v2.1.7 F7-A1/A2/B1 是短期缓解（PRAGMA + 索引 + 通知），unresponsive 概率仅降 30-50%。A3 把 `acquiring-bill-currency-session.runCheck` 整体搬到 `worker_threads` 或 Electron `utilityProcess`，彻底解除主进程 SQL 阻塞。
3. **A4 — SQL JOIN chunked 分批跑**：与 A3 联合评估；若 A3 worker 方案直接解决主进程不阻塞，A4 可能不必要。spec 阶段二选一。
4. **G1 — 单元测试框架引入（全量铺设）**：当前无单元测试框架，只有 smoke 集成测试。引入 Node 内置 `node:test`（零依赖），全量覆盖第 1 层纯函数（normalizers / validators / scenario-engines / constants）+ 第 2 层带 fixture 模块（repository / store / writer / reader）。第 3 层 main.js / renderer / session 明确不做 unit。
5. **N1 — 收单单据币种校验 cleanup 置后执行**：用户反馈"cleanup 动作置后执行"。现状（`acquiring-bill-currency-session.js:278`）已是异步分批（每批 50000 行 + setImmediate 让出），UI 不卡；但用户进入模块新一次导入会被 mutex 挡到 cleanup 完成（500w 行约 1 分钟）。采用 **β 方案**：移出对账链路，主清理时机改 `app.before-quit`（应用退出时），进入模块时为兜底。
6. **N2 — 场景管理 From 网关「对账成立后赋值」新增"自取值"**：C3 引擎 `assign.bankField` 第二下拉框新增「自取值」枚举（位置：从上往下第 2 位），选中时下拉框右侧显示输入框（静态字符串，不允许空 + 200 字符上限）。数据结构 `config_json.assign` 扩展 `{ mode: 'direct' | 'custom', customValue }`，DB migration 自动补旧 scenario `mode='direct'`。模板 bundle 继续 v3。
7. **N3 — 银行对账单处理：场景号修复 + Sheet 3 导出**：
   - N3-1：状态框命中场景号显示 DB id 但场景管理 UI 用 displayIndex 编号 → 不对齐。**方案 A**：Main 端（`scenario-dispatcher.js:99`）推 `displayIndex` 替换 DB id。
   - N3-2：复用同一 xlsx 新增 **Sheet 3「命中场景行」**，放 `modifiedRows` 命中行 + 末尾追加列「命中场景」格式 `[序号] 场景名称`。Sheet 1/Sheet 2 不动。

7 项改动相对独立，无强依赖（F5 ↔ G1 有协同点：F5 算法 case 沉淀到 G1 unit case）。

---

## 二、版本目标

### 2.1 必做

- **F5** — `recon-id-fix-io.js:70` BillDate 字符串化 + `c4-recon-id-fix.js:findBestAmountSubset` 放开 maxSize（或按金额量级动态调整）+ `tryManyToOnePool` 遍历改"子集大小降序 / 金额降序"+ 评估 currency 字段过滤。验证基线：TEST2.xlsx 期望 57 行 / 10 渠道命中
- **A3** — `runCheck` 搬到 worker_threads / utilityProcess（spec 阶段二选一），worker 内重开 DB 连接（同 PRAGMA），进度回调跨进程，错误序列化跨进程
- **A4** — 二选一：(a) A3 worker 已解决问题 → A4 不做；(b) 仍需要 → chunked LIMIT/OFFSET（spec 阶段决策）
- **G1** — 引入 `node:test`；新建 `tests/unit/` 目录镜像 src 分层；`package.json` 加 `"test:unit": "node --test tests/unit/"`；全量覆盖第 1+2 层
- **N1** — `app.before-quit` 钩子触发 cleanup 为主路径 + 进入模块时为兜底；`cleanupPending` 标志位持久化到 `acquiring_bill_currency_runs` 表新列；runCheck 内 setImmediate 触发链路移除
- **N2** — `renderer-dialogs.js` C3 dialog 第二下拉新增"自取值"枚举（第 2 位）+ 右侧条件输入框；`config_json.assign` 扩展 `mode` + `customValue`；`c3-gateway-recon-join.js:158-172` 加分支；DB migration 旧 scenario 补 `mode='direct'`
- **N3-1** — `scenario-dispatcher.js:99` 推送结构改 `{ id, displayIndex, name }`，`main.js:3045` IPC 字段扩展，`renderer.js:3319` 显示 displayIndex
- **N3-2** — `exceljs-writer.js` 新增 Sheet 3「命中场景行」写入分支，列结构 = 原 44 列 + 末尾「命中场景」格式 `[序号] 场景名称`
- 三件套（CHANGELOG / VFH / USER_GUIDE）发布前一次性更新
- smoke：F5（TEST2.xlsx fixture 期望 57 行 1 个用例）/ A3（worker 启动 + DB 连接 + 进度回传 + 错误序列化 4 用例）/ N1（cleanup 触发时机 2 用例）/ N2（assign.mode='custom' 引擎赋值 1 用例 + dialog 保存校验 1 用例 + migration 旧场景升级 1 用例）/ N3-1（displayIndex 对齐 1 用例）/ N3-2（Sheet 3 写入 + 列对齐 1 用例）；G1 不在 smoke 覆盖范围，独立 `npm run test:unit`

### 2.2 明确不做

- **不做** F5 引入更激进的全局最优算法（如 ILP / 网络流），保持 subset-sum + 遍历顺序优化的小步方案
- **不做** A3 把全套业务模块（bank-bu-recon / biz-op-recon）也搬到 worker（仅 acquiring-bill-currency.runCheck），评估通过后续版本再扩散
- **不做** A3 worker 间 DB 共享（worker 内独立连接，避免 SQLite 跨线程坑）
- **不做** A4 与 A3 双轨实施（二选一）
- **不做** G1 强制 CI 阻断（先观察 1-2 版本，再决定升级阻断）
- **不做** G1 追求覆盖率数字目标（覆盖率 ≠ 质量；只测纯逻辑 + 高 bug 风险）
- **不做** G1 第 3 层（main.js / renderer / session）unit 覆盖（继续靠 smoke + preview + 手动）
- **不做** N1 cleanup 算法优化（保持 50000 行/批 + setImmediate；本次仅改触发时机）
- **不做** N1 cleanup 进度条 UI（β 方案应用退出时已经会弹"正在清理上次结果..."进度框，进入模块兜底走静默 toast）
- **不做** N2 "自取值"支持表达式 / 模板（如 `{{xxx}}`），仅静态字符串；表达式留 v2.1.9+
- **不做** N2 模板 bundle 升 v4（向前兼容只追加字段，旧 reader 忽略 mode/customValue 走 direct）
- **不做** N3-1 改场景管理 UI 显示 DB id（保持 displayIndex 不变；统一让 Main 端跟 UI 走）
- **不做** N3-2 在 Sheet 1（渠道对账单）追加「命中场景」列（避免破坏 v2.1.6/v2.1.7 已稳定的输出格式）
- **不做** N3-2 新起独立 xlsx 文件（复用同一 xlsx 文件，新增 Sheet 3）
- **不做** N3-2 Sheet 2「未命中场景行」补「未命中原因」列（用户未要求；保持 v2.1.7 F8 原状）

---

## 三、需求清单总览

| # | 标题 | 模块 | 类型 | 风险 | 文件预估 | 用户拍板 |
|---|---|---|---|---|---|---|
| F5 | C4 manyToOne 算法重设 | 网关对账ReconID修复 / C4 | 算法重设 | 🔴 **HIGH（资金红线）** | engine × 1 + io × 1 + smoke × 2-3 + fixture × 2 | ✓ v2.1.7 §十延期项；TEST2.xlsx 期望 57 行 / 10 渠道 |
| A3 | runCheck 跨进程化 | 收单单据币种校验 | 架构级 · 跨进程 IPC | 🔴 **HIGH** | session × 1 + main × 1 + preload × 1 + worker × 1（新建） + smoke × 3-4 | ✓ v2.1.7 §10.6 立项；worker_threads vs utilityProcess 待 spec 拍板 |
| A4 | SQL JOIN chunked 分批跑 | 收单单据币种校验 | 性能优化 | 🟡 MID | 与 A3 联合 | ⏸ 二选一：若 A3 解决问题则不做 |
| G1 | 单元测试框架引入（全量） | 全局工程基建 | 测试基础设施 | 🟢 LOW | tests/unit/ 镜像目录（~30+ 文件） + package.json | ✓ 2026-05-22 用户立项，全量铺第 1+2 层 |
| N1 | cleanup 置后执行（β 方案） | 收单单据币种校验 | 性能 / UX | 🟡 MID | session × 1 + main × 1 + DB migration × 1 + smoke × 2 | ✓ 2026-05-22 用户拍板 β（退出时为主 + 进入时兜底） |
| N2 | 「对账成立后赋值」新增"自取值" | 场景管理 / C3 | 功能增强 · UI + 引擎 + DB | 🟡 MID | dialog × 1 + engine × 1 + migration × 1 + constants × 1 + preload × 1 + smoke × 3 | ✓ 2026-05-22 用户拍板：静态字符串 / mode+customValue / v3 兼容 |
| N3 | 银行对账单：场景号修复 + Sheet 3 | 银行对账单处理 | 缺陷修复 + 功能增强 | 🟡 MID（IPC 字段变更） | dispatcher × 1 + main × 1 + renderer × 1 + writer × 1 + smoke × 2 | ✓ 2026-05-22 用户拍板：N3-1=A / N3-2=Sheet 3 复用 xlsx |

---

## 四、F5 — C4 manyToOne 算法重设 🔴 资金红线

### 4.1 背景

v2.1.7 PRD §十 延期项。用户提供 `/Users/pzhong/Desktop/小助手-Debug/2.1.7/TEST2.xlsx`「订单修复」sheet 含 57 行期望基线 / 10 渠道命中（最大子集 16 行 T54SWIC494447 = 9,751,101）。v2.1.7 仅做"BillDate 字符串化"单点 fix 实测 28 行 / 9 渠道命中，差距 29 行 / 1 渠道。

### 4.2 根因（PM v2.1.7 已诊断）

| # | 根因 | 影响 |
|---|---|---|
| 1 | `recon-id-fix-io.js:70` `raw:true` 读 sheet → Excel 日期变 number 序列号 → `c4-recon-id-fix.js:1058-1065` 直接赋 BillDate → `parseBillDateMs` 正则不认 → 候选 fail | 28 行可解 |
| 2 | `findBestAmountSubset` subset-sum `maxSize=8` 硬上限 → 16 行（T54SWIC494447）/ 11 行（T54SWIC506630）子集被剪 | ≥ 11 行 |
| 3 | `tryManyToOnePool` 按 right 行顺序遍历 left → 4M 子池被前面渠道抢光（T54SWIC470181） | ≥ 1 渠道 |
| 4 | 窗口扩大（±7/±10）反而下降（tie-break 偏置） | 反向影响 |

### 4.3 改动点

- [ ] **BillDate 数字日期解析**（T08 Reverse Sync 改 — spec.md F5-D4 v0.3）：在 `c4-recon-id-fix.js:1058-1065` gateway 映射段，把 `createTime` number 序列号转 ISO 字符串后赋给 `BillDate`，让 `parseBillDateMs` 能识别。**不动** `recon-id-fix-io.js:70` raw 模式（共用函数 sheetToObjects 影响 8 sheet × N 字段，资金红线扩面）
- [ ] **maxSize 放开**：`c4-recon-id-fix.js:findBestAmountSubset` 的 maxSize=8 改为动态（如按金额量级 / 候选池大小）；或干脆放开到 candidates.length，按性能 trade-off
- [ ] **manyToOne 遍历顺序**：`tryManyToOnePool` 改"子集大小降序"或"金额降序"，避免大子集被先消费
- [ ] **currency 字段过滤**（评估）：增加 currency 等值过滤，缩小候选池
- [ ] **性能护栏**：maxSize 放开后 subset-sum 复杂度 O(2^n)，需评估超时阈值（如单渠道 candidates > 20 时降级）

### 4.4 资金红线护栏

- [ ] smoke 矩阵 19 个 suite **全跑 + 0 regression**
- [ ] v2.1.6 baseline 命中数不得下降
- [ ] TEST2.xlsx 期望 57 行 / 10 渠道作为新基线
- [ ] TEST.xlsx（0 命中样本）继续作为护栏（不应该误升）

### 4.5 G1 协同

F5 算法重设过程中产生的"输入 → 期望输出"对，**直接落成 `c4-recon-id-fix.js` 的 unit case**：
- TEST2.xlsx 57 行期望基线 → 解析为 fixture JSON
- 每个子集匹配关系 → 1 个 unit case
- maxSize 放开前后行为对比 → 回归 case

### 4.6 风险

- 🔴 资金红线：subset-sum 改 maxSize 涉及性能与正确性 trade-off
- 🔴 算法重设需专门 reviewer
- 🟡 性能：放开 maxSize 可能导致单渠道处理超时
- 🟡 重要变量：`findBestAmountSubset` / `tryManyToOnePool` / `parseBillDateMs` 至少 Critical 1 + Important-skeleton 1 项

---

## 五、A3 — runCheck 跨进程化

### 5.1 背景

v2.1.7 F7-A1（PRAGMA）+ F7-A2（索引 + ANALYZE）+ F7-B1（Notification）是短期缓解，预计降低 unresponsive 概率 30-50%。A3 是根本解。

### 5.2 待 spec 阶段决策

| # | 决策点 | 选项 | PM 倾向 |
|---|---|---|---|
| D1 | 跨进程方案 | (a) worker_threads（Node 原生） / (b) Electron utilityProcess（深度整合） | (b) — Electron 生命周期一致性更好 |
| D2 | DB 连接 | worker 内重开 DB 连接 + 同 PRAGMA（v2.1.7 F7-A1） | 必须重开（worker_threads 无法共享 DatabaseSync 实例） |
| D3 | 进度回调链路 | worker → main → renderer（多一跳 IPC，复用 v2.1.7 F6 的 `acquiringBillCurrency:run:progress` 范式） | 必须；冗余传输换实现简单 |
| D4 | 错误传播 | worker 抛错 → message 包装 → main 反序列化 → IPC | 必须；FileValidationError 结构需保持 |
| D5 | 取消语义 | renderer 取消 → main → `worker.terminate()` 或 `postMessage('cancel')` | 推荐 `postMessage('cancel')` + worker 内主动检查（terminate 暴力，DB 锁可能残留） |
| D6 | 冷启动开销 | worker 启动 + DB 重连 ~ 100-500ms | 可接受（runCheck 本身分钟级） |

### 5.3 改动点

- [ ] 新建 `src/main-process/acquiring-bill-currency-worker.js`（worker entry）
- [ ] `acquiring-bill-currency-session.js` 拆出 runCheck 可跨进程部分（去 Electron 依赖）
- [ ] `main.js:10281` handler 改为 worker 调度
- [ ] `preload.js` progress 订阅 API 不变（保持 F6 范式）
- [ ] worker 内 DB 重开 + PRAGMA 应用复用 `database.js` 启动钩子

### 5.4 风险

- 🔴 架构级改动，涉及 IPC 桥接 + 数据序列化 + 错误传播 + 进度回调 4 个维度
- 🟡 worker 启动开销 + DB 重连
- 🟡 错误堆栈跨进程信息丢失
- 🟡 取消语义需新增协议
- 🟡 重要变量：`acquiring-bill-currency-session.js` Runtime-state 多项

---

## 六、A4 — SQL JOIN chunked 分批跑

### 6.1 二选一决策

- **(a) A3 worker 已解决主进程不阻塞 → A4 不做**：PM 倾向
- **(b) 仍需要 chunked**：spec 阶段决定 chunk size（10w / 50w / 100w 行）+ 拆分点（外层 JOIN / 内层子查询）

### 6.2 待 spec 阶段决策

依赖 A3 设计完成后再决定。

---

## 七、G1 — 单元测试框架引入（全量铺设）

### 7.1 背景

CLAUDE.md 已陈述：无单元测试框架，`npm run smoke` 是唯一被认可的自动化测试（集成级）。纯逻辑层 0 unit 兜底。

### 7.2 用户决策（2026-05-22）

✅ 要做就直接全部做，不渐进试点。

### 7.3 框架选型

**默认推荐：Node 内置 `node:test`**
- 零 devDependencies 新增（符合项目轻量化偏好）
- Node 22 已稳定，与 `node:sqlite`（项目已用）同代
- 语法接近 Jest，零学习成本
- 自带 TAP reporter

> spec 阶段如需对比 Vitest / Jest，可在 spec.md 加替代方案对比。

### 7.4 覆盖范围

🟢 **第 1 层（纯函数）100% 覆盖**：

- `src/backend/file-service/normalizers.js`
- `src/backend/file-service/common.js`
- `src/backend/file-service/error-causes.js`
- `src/backend/acquiring-bill-currency-import/validator.js`
- `src/backend/bank-bu-recon-import/validator.js`
- `src/backend/biz-op-recon-import/validator.js`
- `src/backend/pending-import/validator.js`
- `src/main-process/scenario-engines/engine-utils.js`
- `src/main-process/scenario-engines/c1-extract-recon-id.js`
- `src/main-process/scenario-engines/c2-offset-bill-mark.js`
- `src/main-process/scenario-engines/c3-gateway-recon-join.js`
- `src/main-process/scenario-engines/c4-recon-id-fix.js`（**与 F5 强相关，作为 F5 算法正确性 guard**）
- `src/constants/*.js`
- `src/backend/*-db/columns.js`

🟡 **第 2 层（带轻副作用，fixture 支持）100% 覆盖**：

- `src/backend/database/template-repository.js`（in-memory sqlite）
- `src/backend/database/scenarios-repository.js`
- `src/backend/database/settings-repository.js`
- `src/backend/balance-seed-store.js` / `balance-adjustment-store.js`
- `src/backend/big-account-mode-store.js` / `big-account-order-store.js` / `own-account-store.js`
- `src/backend/file-service/readers.js` / `writers.js`（tmpdir + 小 fixture xlsx）
- `src/backend/pending-db/*-repository.js`（4 个）
- `src/backend/acquiring-bill-currency-db/*-repository.js`（2 个）
- `src/backend/bank-bu-recon-db/*-repository.js`（2 个）
- `src/backend/biz-op-recon-db/*-repository.js`（3 个）
- `src/main-process/monthly-balance.js`
- `src/main-process/recon-id-fix-engine.js`
- `src/main-process/statement-generation.js`

🔴 **第 3 层（编排 / UI）明确不做 unit**，依赖 smoke + preview + 手动测试：

- `src/main.js` / `src/preload.js` / `src/renderer*.js` / `src/main-process/*-session.js` / `src/main-process/pending-archive-worker.js`

### 7.5 流程影响

| 维度 | 变化 |
|---|---|
| 目录新增 | `tests/unit/`（按 src 镜像分层） |
| package.json | 新增 `"test:unit": "node --test tests/unit/"` |
| PR body | 触及第 1/2 层模块时，新增"unit case 列表"段落 |
| check-vars | 重要变量 case 钉死（变更需同步更新 case） |
| smoke / preview | **不变** |
| 文档三件套 | 同步登记 G1 |
| 多版本维护 | cherry-pick 时 unit case 一起带走，**降低**回归风险 |

### 7.6 不做

- ❌ 不强制 CI 阻断（试跑 1-2 版本再决定）
- ❌ 不追求覆盖率数字
- ❌ 不动 `scripts/test-v*.js`（保留作为集成层）
- ❌ 不替代 smoke / preview / 手动测试

### 7.7 与 F5 协同

F5 算法重设的 TEST2.xlsx 期望基线 → 直接落成 `c4-recon-id-fix.js` 的 unit case，等于把"57 行期望"沉淀为永久契约。

### 7.8 实施顺序建议

1. G1 框架搭建 + 第 1 层全量铺（前 3-5 天）
2. F5 spec 评审同时启动，TEST2.xlsx 期望基线先转 unit case
3. F5 实现 + 第 2 层 unit 并行
4. A3 spec 评审晚启动（worker 架构设计 ≥ 3 天）
5. A4 决策跟随 A3

### 7.9 风险

- 🟢 不动业务代码，不影响线上行为
- 🟡 **case 期望值的"权威性"问题**：第一批 case 直接基于"当前实现"录入，等于把"当前行为"凝固成契约 → PR review 需人工复核每条 case 是不是"业务真实期望"而非"实现 bug 的复刻"
- 🟡 工期：1-2 周全量铺，会挤压 F5/A3/A4 并行带宽

---

## 八、N1 — 收单单据币种校验：cleanup 置后执行（β 方案）

### 8.1 用户决策（2026-05-22）

✅ **β 方案**：移出对账链路，主清理时机改 `app.before-quit`，进入模块时为兜底。

### 8.2 现状回顾

- cleanup 函数：`acquiring-bill-currency-session.js:278` `cleanupAfterRunBackground`
- 现调用点：`main.js:10307`（runCheck 成功后 setImmediate 触发）
- 现状已是异步分批（每批 50000 行 + setImmediate 让出 event loop），UI 不卡
- **间接卡点**：mutex lock 互斥 import/run/export/cleanup → 用户进入模块新一次导入会被 lock 挡到 cleanup 完成

### 8.3 改动点

- [ ] **runCheck 解耦**：`main.js:10307` 移除 setImmediate(cleanupAfterRunBackground)；改为仅 SET `cleanupPending=1` 到 DB
- [ ] **持久化标志位**：`acquiring_bill_currency_runs` 表新增 `cleanup_pending INTEGER DEFAULT 0`；runCheck 成功后 SET=1，cleanup 完成 SET=0
- [ ] **app.before-quit 钩子**：检测 `cleanupPending=1` runs → `event.preventDefault()` 阻塞退出 → 弹"正在清理上次结果..."模态框（含进度 `onProgress` 回调）→ cleanup 完成后 `app.quit()`
- [ ] **进入模块兜底**：用户切到收单单据币种校验模块时，main.js 检查 `cleanupPending=1` → 若有，触发后台 cleanup（保持 setImmediate 异步模式）+ UI 仅 toast 提示，不阻断用户操作
- [ ] **启动期 cleanupOrphanData 不变**（已覆盖应用强杀场景，β 不影响）

### 8.4 DB migration

```sql
-- 幂等 migration（database/migrations.js）
ALTER TABLE acquiring_bill_currency_runs ADD COLUMN cleanup_pending INTEGER DEFAULT 0;
-- 旧记录默认 0（已完成清理）
```

### 8.5 风险

- 🟡 `app.before-quit` 钩子需谨慎处理重复进入（用户连续点关闭）
- 🟡 模态框 UI 需新建（项目目前无"退出前阻塞"先例）
- 🟡 进入模块兜底触发时机：spec 阶段确认是 IPC handler 入口 还是 renderer 切 tab 事件
- 🟡 重要变量：`acquiring-bill-currency-session.js` Runtime-state 多项 + 新增 DB schema 列

---

## 九、N2 — 场景管理 From 网关「对账成立后赋值」新增"自取值"

### 9.1 用户决策（2026-05-22）

✅ "自取值" = **静态字符串**（用户填什么就赋什么）
✅ 字段命名：`assign.mode`（`'direct' | 'custom'`）+ `assign.customValue`（字符串）
✅ 输入框校验：不允许空 + 200 字符上限 + 不限字符类型
✅ 模板 bundle 继续 v3（向前兼容）

### 9.2 改动点

#### UI 层（`src/renderer-dialogs.js`）

- [ ] C3 dialog 第二下拉框（`select[data-field="assign-bank"]`）枚举列表插入「自取值」到从上往下第 2 位
- [ ] 第二下拉 change 事件新增分支：选「自取值」→ 右侧显示 `<input type="text" maxlength="200">`
- [ ] dialog 保存时：
  - 若 mode='custom' && customValue 为空 → 校验报错"自取值不能为空"
  - 若 mode='custom' → 保存 `assign.customValue`
  - 若 mode='direct' → 不保存 customValue
- [ ] dialog 打开时按 `assign.mode` 回显（'direct' → 隐藏 input，'custom' → 显示 input + 填回 customValue）

#### 数据结构

```js
config_json.assign = {
  gwField: "Amount",
  bankField: "Credit Amount",  // 'direct' 模式
  mode: 'direct' | 'custom',
  customValue: "用户填写的字符串"  // 'custom' 模式
}
```

#### 引擎层（`src/main-process/scenario-engines/c3-gateway-recon-join.js`）

- [ ] :158-172 赋值逻辑加分支：
  ```js
  const newValue = (assign.mode === 'custom')
    ? assign.customValue
    : normalizeCellValue(chosen.row[assign.gwField]);
  ```

#### DB migration（`src/backend/database/migrations.js`）

- [ ] 幂等 migration：扫描所有 scenarios，对 category='gateway-recon-join' 的 config_json，若 `assign.mode` 字段不存在，补 `mode='direct'`

#### 同步点

- [ ] `src/constants/bank-statement-fields.js:60-63` `BANK_STATEMENT_FIELDS_FOR_C3` 在数组第 2 位插入「自取值」（含特殊 value 如 `__CUSTOM__`）
- [ ] `src/preload.js` 中 inline 的 `BANK_STATEMENT_FIELDS_FOR_C3` 同步

### 9.3 项目复用模式

`src/renderer-dialogs.js:6420-6435` 已有「下拉值=X 时显示输入框」先例（C1 条件行 `opNeedsValue()` 模式），可直接复用 DOM 结构 + 事件绑定模式。

### 9.4 风险

- 🟡 对账契约变更：scenarios 数据结构升级，migration 必须确保旧 scenario graceful 升级
- 🟡 模板 bundle 兼容：CLAUDE.md 已记录 `bundleVersion` v3，本次不升 v4（向前兼容只追加字段）
- 🟡 preload inline 常量需同步（项目历史坑）
- 🟡 重要变量：`scenarios` 数据结构 + `c3-gateway-recon-join.js` 赋值逻辑

---

## 十、N3 — 银行对账单处理：场景号修复 + Sheet 3 导出

### 10.1 用户决策（2026-05-22）

✅ **N3-1 方案 A**：Main 端推 `displayIndex`（源头统一）
✅ **N3-2 输出形态**：复用同一 xlsx + 新增 Sheet 3「命中场景行」
✅ Sheet 3 范围：只放 `modifiedRows`（命中行）
✅ Sheet 3 列结构：原 44 列 headers + 末尾「命中场景」列
✅ 列值格式：`[序号] 场景名称`

### 10.2 N3-1 现状根因

| 端 | 编号来源 | 值 |
|---|---|---|
| Main | `scenario-dispatcher.js:99` `hitScenarioIds.push(scenario.id)` 推 DB id | `[1, 5, 7, 9]` |
| IPC | `main.js:3045` 返回 `stats.hitScenarioIds` | |
| Renderer | `renderer.js:3319` 直接显示 ids | "场景 1、5、7、9" |
| UI 列表 | `renderer-dialogs.js:5506` 用 `displayIndex` 1-based 顺序 | "1、2、3、4" |

### 10.3 N3-1 改动点

- [ ] **`scenario-dispatcher.js:99`** 推送结构改为 `{ id, displayIndex, name }`
- [ ] **`main.js:3045`** IPC 返回 `stats.hitScenarios = [{id, displayIndex, name}]`（注：字段重命名 from `hitScenarioIds` to `hitScenarios`，需 grep 调用方同步）
- [ ] **`renderer.js:3319`** 状态框文案改用 `displayIndex`
- [ ] **displayIndex 来源**：spec 阶段确认是从 `scenarios-repository.js` 按列表顺序 1-based 派发，还是 dispatcher 入参时 main.js 计算

### 10.4 N3-2 改动点

- [ ] **`exceljs-writer.js`** 新增 Sheet 3 写入分支
- [ ] Sheet 3 数据源：`processingResult.modifiedRows`（v2.1.7 F8 已附 `_hitScenarioId` + `_hitScenarioName` metadata）
- [ ] Sheet 3 列结构 = 原 44 列 bank headers + 末尾新增「命中场景」列
- [ ] 「命中场景」列值 = `[${displayIndex}] ${scenarioName}`（displayIndex 同 N3-1 派发）
- [ ] `INTERNAL_FIELDS` 过滤逻辑保留（其他 `_` 前缀字段仍过滤）；「命中场景」列通过白名单显式拼装
- [ ] Sheet 1/Sheet 2 完全不动

### 10.5 风险

- 🟡 N3-1 IPC 字段结构变更 → 需 grep 所有调用方
- 🟡 N3-1 displayIndex 派发口径需统一（避免 main 端和 UI 计算不一致）
- 🟢 N3-2 新增 Sheet 不影响 v2.1.6/v2.1.7 现有输出格式
- 🟢 v2.1.7 F8 已有 `modifiedRows + unmatchedRows = bankRows` 不变量护栏
- 🟡 重要变量：`scenario-dispatcher.js` hitScenarioIds（字段重命名）+ `exceljs-writer.js` INTERNAL_FIELDS（白名单扩展）

---

## 十一、验收矩阵

| # | 验收项 | 验证手段 | 通过标准 |
|---|---|---|---|
| F5-1 | TEST2.xlsx 跑出 57 行 / 10 渠道命中 | 手测 + smoke fixture | ≥ 57 行 / 10 渠道 |
| F5-2 | TEST.xlsx（0 命中样本）不应误升 | smoke | = 0 行 |
| F5-3 | 19 个 smoke suite 全跑 | npm run smoke | 全绿 0 regression |
| F5-4 | maxSize 放开后性能 | 手测大样本 | 单渠道 < 30s |
| A3-1 | runCheck 主进程不阻塞 | 手测 500w 行 | 跑期间主窗口能交互 |
| A3-2 | worker 错误传播 | smoke | FileValidationError 结构保留 |
| A3-3 | worker 取消 | smoke | 取消后 DB 无锁残留 |
| A3-4 | 进度回调 | 手测 | 5 阶段文案依次到达 |
| G1-1 | 第 1 层 100% 覆盖 | npm run test:unit | 14 个文件全部有 case |
| G1-2 | 第 2 层 100% 覆盖 | npm run test:unit | ~20 个文件全部有 case |
| G1-3 | 不影响 smoke | npm run smoke | 全绿 |
| N1-1 | runCheck 后无自动 cleanup | 手测 | DB 表数据保留，cleanup_pending=1 |
| N1-2 | app.before-quit 触发 cleanup | 手测退出 | 弹模态框 + 清完才退出 |
| N1-3 | 进入模块兜底 | 手测切回模块 | toast 提示 + 后台清 |
| N2-1 | dialog 新增"自取值" | 手测 + preview | 枚举第 2 位 + 选中显示 input |
| N2-2 | 引擎 mode='custom' 赋值 | smoke | 写入 customValue |
| N2-3 | DB migration 旧场景升级 | smoke | 旧 scenario 自动补 mode='direct' |
| N2-4 | 校验空值报错 | 手测 | 选自取值不填 → 保存报错 |
| N3-1-1 | 状态框 displayIndex 对齐 | 手测 | 状态框序号 = 场景管理序号 |
| N3-2-1 | Sheet 3 写入 + 列对齐 | smoke + 手测 | Sheet 名"命中场景行" + 末尾列 `[序号] 场景名称` |
| N3-2-2 | Sheet 1/Sheet 2 不变 | smoke | 列结构与 v2.1.7 一致 |

---

## 十二、风险汇总

### 12.1 资金红线（CLAUDE.md 规则 7）

- 🔴 **F5** 算法重设：subset-sum maxSize 改动涉及性能与正确性 trade-off，必须专门 reviewer + 多轮 smoke + TEST2.xlsx 基线验证
- 🔴 **A3** 跨进程改动：IPC 数据序列化 + 错误传播 + 取消语义 4 个维度均涉及对账正确性
- 🟡 **N2** 对账配置数据结构变更：旧 scenario 必须 graceful 升级
- 🟡 **N3-1** IPC 字段重命名：需 grep 全部调用方
- 🟡 **G1** unit case 期望值权威性：避免把实现 bug 凝固成契约

### 12.2 重要变量影响（待 `npm run scan:vars` 重跑后评估升格）

- F5：`findBestAmountSubset` / `tryManyToOnePool` / `parseBillDateMs` / `BillDate`
- A3：`acquiring-bill-currency-session` Runtime-state 全套
- N1：`cleanup_pending`（DB 新列）+ `cleanupPending`（runtime flag）
- N2：`config_json.assign` 结构（接口契约）+ `BANK_STATEMENT_FIELDS_FOR_C3`
- N3：`hitScenarioIds` → `hitScenarios`（IPC 字段重命名）+ `INTERNAL_FIELDS`（白名单扩展）+ `displayIndex` 派发口径

### 12.3 工期与并行带宽

- 总工期粗估：4-5 周
- 用户决策：**单版本走完**，不拆分
- PM 建议串并行：G1 框架（前 3-5 天单独）→ F5 + N1 + N2 + N3 并行（中段 1-2 周）→ A3 + A4 收尾（后段 1-1.5 周）

---

## 十三、文档三件套登记（发版前一次性更新）

- [ ] `CHANGELOG.md` v2.1.8 章节
- [ ] `docs/VERSION_FEATURE_HISTORY.md` v2.1.8 主题概述
- [ ] `docs/USER_GUIDE.md`：
  - N2 场景管理「对账成立后赋值 - 自取值」使用说明
  - N1 应用退出时清理提示说明
  - N3-2 处理结果 xlsx 第 3 个 sheet 说明
  - G1 不写入用户手册（开发者工具）

---

## 十四、实施记录（dev 阶段填）

待 dev 启动后按 round 累积。

---

**当前状态**：v0.1 起草中，**v2.1.7 未合并 main 前不开始 v2.1.8 任何代码**（沿用 v2.1.7 PRD §10.6 约束）。

下一步：
1. 等 v2.1.7 → main 合并
2. 启动 spec.md 资金红线评审（F5/A3/N2/N3 4 项）
3. 启动 tasks.md task 颗粒拆分（按文件粒度 3-5 文件/task）
4. 跑 `npm run scan:vars` 评估重要变量升格

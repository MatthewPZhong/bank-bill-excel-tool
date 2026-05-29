# v2.1.11 迭代清单（Backlog — 立项画像）

> v0.1（2026-05-28 起草）：v2.1.10 β 7 Phase 完成 + SR-FIX Round 1+2 闭环后立项；本文件锁定 v2.1.11+ 候选范围。
> 启动节奏：v2.1.10 用户测试 → SR-FIX 后续 round（如有）→ 提 PR → merge main → 在 main 上新建 `v2.1.11` 分支。

## 主题概览（候选 — 4 主线 + 2 评估）

> **v0.2 范围更新（2026-05-29 — reverse sync）**：用户在 main 新建 v2.1.11 分支后追加 **3 个需求**（T1 单测运行日志 / T2 pending 移除核对 / T3 C2「银行对账单字段赋值」增强），详见 `PRD-v2.1.11.md`。这 3 项与下方性能主线**并存**且**优先推进**；性能主线（A3-multi-worker / F5-cont）顺延为本版后续 Phase，沿用 D29-D36。

### v2.1.11 用户追加需求（2026-05-29 — 优先推进，详见 PRD-v2.1.11.md）

| 编号 | 主题 | 性质 | 风险 | 状态 |
|---|---|---|---|---|
| **T1-test-log** | 单元测试运行日志（终端 N/N 汇总 + 落盘存档） | 测试基建 | 🟢 LOW | spec 待产出 |
| **T2-pending-removal** | pending 月度核对新增「导入移除pending并核对」流程 | 数据核对 · 导出契约 | 🔴 HIGH | spec 待产出 |
| **T3-c2-config** | C2 字段赋值页增强（多条件 AND / FundType 下拉 / 对账字段可空） | 业务规则 · UI · 引擎 | 🟡 MID | spec 待产出 |

### v2.1.11 性能主线（原立项 4 项 — 顺延为后续 Phase）

| 编号 | 主题 | 性质 | 风险 | 工期预估 | 来源 |
|---|---|---|---|---|---|
| **A3-multi-worker** | 多 worker pool（多 chunk 并行）— acquiringBillCurrency + bizOpRecon + pending 复用 | 🔴 性能 · 架构升级 | 🟡 MID | ~2 周 | 2026-05-28 用户拍板（v2.1.10 评估"对账时间缩短"方案对比 — 多 worker 比换 DuckDB ROI 更高） |
| **F5-cont** | C4 manyToOne ILP / 网络流重写 | 🔴 资金红线 · 算法范式 | 🔴 HIGH | ~2-3 周 | v2.1.7 / v2.1.8 / v2.1.9 / v2.1.10 连续延期；需要单独 spec 评估算法范式（subset-sum DFS+剪枝 → ILP/网络流）+ 资金红线评审 |
| **SR-log-1-dual-write-removal** | v2.1.9 SR-log-1 双写删旧（删 `app_activity_log.txt` 旧写入路径） | 🟡 收尾 | 🟢 LOW | ~0.5 天 | v2.1.9 D34=a 锁双写 1 版本 = v2.1.9；v2.1.10 评估留到 v2.1.11 |
| **A3-spread** | A3 worker 化扩散到其他对账模块（不含多 worker 并行 — 仅"主进程不卡"） | 性能 · UX | 🟡 MID | ~4 周（每模块 ~1 周）| v2.1.10 PRD §六 "不做扩散到 bankBuRecon / bizOpRecon / pending" 决策 |

**v2.1.11 合计预估**：~4-5 周（A3-multi-worker + F5-cont 必做；其余视优先级）

### 评估项（视 v2.1.10 上线后实际使用情况）

| 编号 | 主题 | 触发条件 |
|---|---|---|
| **N5-channels-scale** | N5 渠道枚举膨胀（用户创建超 50 个渠道时）UI 下拉虚拟滚动 | v2.1.9 上线后观察渠道平均创建数量；如普遍 > 50 个则启动；否则继续延 |
| **SR-log-1-log-cleanup-ui** | SR-log-1 永久保留日志的批量清理 UI（v2.1.9 D36=a 仅文件系统暴露）| 用户反馈日志膨胀 / 主动要清理入口 |

---

## A3-multi-worker 主题详述（v2.1.11 重点）

### 立项背景（基于 v2.1.10 评估 — 2026-05-28 用户拍板）

v2.1.10 A3 实现单 worker pool（1 worker）+ A4 chunked（10w 行/chunk 串行）— 主要价值是"主进程不卡"（event loop lag 主进程 66ms → worker 1ms 改善 48x）。但**对账总耗时反而 +5%-1300%**（worker cold-start + DB 重开 + IPC 序列化开销）。

500w 行外推 ~18s；用户希望进一步**缩短**对账时间。

### 方案对比（v2.1.10 评估）

| 方案 | 500w 行总耗时 | 加速 | 工期 | 风险 | 数据迁移 |
|---|---|---|---|---|---|
| v2.1.10 单 worker baseline | ~18s | 1x | — | — | — |
| **多 worker pool（本主题）** | **~7-9s** | **2-3x** | ~2 周 | 中等 | 无需 |
| 算法优化 F5-cont C4 ILP | ~10-15s | 1.2-1.8x | 2-3 周 | 高 | 无 |
| SQL profiling + 索引细化（再做 F7-A2）| ~15s | 1.2x | 几天 | 低 | 无 |
| 换 DuckDB 嵌入式 OLAP | ~3-6s | 3-5x | 2-3 个月 | 极高 | 24GB 老库迁移 |
| 换 PostgreSQL | ~15-25s | 持平或反慢 | 2-3 个月 | 极高 | 同上 + 部署 |

**用户选 A3-multi-worker（ROI 最高）**。

### 范围（用户拍板 — 3 模块复用）

| 模块 | 当前 v2.1.10 状态 | v2.1.11 改造 | 加速预期 |
|---|---|---|---|
| **acquiringBillCurrency** 收单单据币种校验 | 单 worker + chunked 10w | **多 worker 并行 chunk**（核心改造）| 2-3x（500w 行 18s → 7-9s）|
| **bizOpRecon** 业务运营对账（OP 数据核对）| 主进程同步 | **A3 改造 + 多 worker 并行**（复用 v2.1.10 worker 框架 + 本主题 chunked 并行）| 视数据规模 |
| **pending** 月度 pending 数据核对 | 主进程同步 | **A3 改造 + 多 worker 并行**（复用同上）| 视数据规模 |

**不在范围**（v2.1.12+ 评估）：
- bankBuRecon / bankStatement / reconIdFix — 用户未指定本版复用

### 技术核心（SQLite 并发约束 — write-splitting 设计）

SQLite WAL 模式 single-writer 限制 — 多 worker 直接并行 INSERT 会触发 SQLITE_BUSY（30s 等待）。**必须 write-splitting**：

```
主进程：拆 N chunks
  ↓ 分发给 M 个 worker（M = min(CPU 核数, 4)）
worker 1-M: 并行执行 SELECT JOIN（reader 并发不冲突） → 中间结果 message 回主进程
  ↓ 各 worker 完成
主进程：汇总 → 单 writer 批量 INSERT diff_rows（串行）
```

加速理论上限 ~3-4x（INSERT 阶段必须串行 — 占总耗时 ~20%）。

### 决策点（v2.1.11 spec 阶段拍板）

| ID | 主题 | 选项 | 待 spec |
|---|---|---|---|
| **D29** | worker 默认数量 | (a) 固定 4 / (b) `os.cpus().length / 2` / (c) settings 可调 | 待 spec |
| **D30** | write-splitting 方案 | (a) 主进程汇总后单 writer / (b) 每 worker temp table + 主 worker ATTACH 汇总 / (c) BEGIN IMMEDIATE 多 writer 排队 | 待 spec POC 评估 |
| **D31** | 小数据回退策略 | < 100w 行时 worker 启动开销 > 收益 — 自动回退单 worker？阈值多少？ | 待 spec |
| **D32** | 跨模块 pool 共享 | (a) 每模块独立 pool / (b) 统一共享 pool / (c) 同模块独立 + 资源调度 | 待 spec |
| **D33** | OOM 防御 | 4 worker × ~800MB peak ≈ 3.2GB；8GB RAM 低配机器风险；是否动态降级 worker 数？ | 待 spec |
| **D34** | 进度回调聚合 | 多 worker progress events 主进程合并策略（按 chunkIndex 排序 / 不排序流式发送）| 待 spec |

### 风险（CLAUDE.md 规则 7）

| 风险 | 级别 | 缓解 |
|---|---|---|
| **多 worker INSERT 写竞争触发 SQLITE_BUSY 30s 等待** | 🔴 HIGH | spec 阶段必须 write-splitting 设计（D30）|
| **byte-for-byte 资金红线** — 多 worker 并行结果与单 worker 一致 | 🔴 HIGH | contract test 多档数据集（500/5000/50000/500w）byte-for-byte 验证；保留单 worker fallback 路径 |
| **OOM 低配机器**（4 worker × 800MB = 3.2GB）| 🟡 MID | D33 动态 worker 数 + settings 默认 worker=2 兜底 |
| **bizOpRecon / pending 的 runCheck 函数还没纯函数化** | 🟡 MID | 复用 v2.1.10 A3 范式 — 提取 `runCheckCore` + contract test + worker 入口适配 |
| **跨模块 DB 写锁竞争**（acquiring 多 worker 跑期间 bizOpRecon 也跑）| 🟡 MID | spec §四 D32 评估全局调度策略；可能默认串行 |

### v2.1.11 启动 checklist

- [ ] v2.1.10 用户测试通过
- [ ] v2.1.10 SR-FIX 后续 round 如有需求闭环
- [ ] v2.1.10 PR 提交 + Codex review（如有）+ merge main
- [ ] 用户在 main 上新建 `v2.1.11` 分支
- [ ] PM 起 v2.1.11 PRD / spec / tasks / manual-test-checklist 四件套
- [ ] Phase 0 POC：实测 write-splitting 方案 D30 + 4 worker 加速基线
- [ ] Dev 启动 Phase 1（多 worker pool 框架）

---

## F5-cont 主题详述（持续延期 — v2.1.11 必做）

### 立项背景

v2.1.7 / v2.1.8 / v2.1.9 / v2.1.10 连续延期。v2.1.8 F5 已修 4/5 根因（BillDate 字符串化 / maxSize 放开 / 遍历顺序 / currency 字段过滤）；剩余根因 #5 = **subset-sum DFS+剪枝算法的本质性能 / 准确度限制**。

期望基线：TEST2.xlsx 57 行 / 10 渠道命中。v2.1.8 实测 28 行 / 9 渠道。仍有缺口。

### 候选算法范式

| 范式 | 性能 | 准确度 | 实施复杂度 |
|---|---|---|---|
| 现状 subset-sum DFS+剪枝 | O(2^N) 最坏 | 局部最优 | 已有 |
| ILP (Integer Linear Programming) | NP-hard 但小规模有现成 solver | 全局最优 | 高（引入 solver lib） |
| 网络流（最小费用最大流）| O(V²E) | 全局最优 | 中（手写算法）|
| 启发式 + 局部搜索 | 多项式 | 近似最优 | 中 |

**待 spec 阶段评估 POC + 资金红线评审**。

### 风险

| 风险 | 级别 |
|---|---|
| **资金红线** — C4 命中数直接影响对账金额匹配 | 🔴 资金红线 |
| 引入 solver lib（如 javascript-lp-solver / GLPK.js）增加包体 | 🟡 |
| 算法范式切换破坏现有 byte-for-byte 测试 | 🟡 |

---

## SR-log-1-dual-write-removal 主题详述

### 背景

v2.1.9 SR-log-1 全局告警日志改造（按月+日两层归档 / JSON Lines / 永久保留）；D34=a 双写策略保留 v2.1.9 一个版本（旧 `app_activity_log.txt` 路径 + 新 JSON Lines 路径）。v2.1.10 评估留到 v2.1.11 删除旧路径。

### 改造范围

- 删 `app_activity_log.txt` 写入路径
- 保留新 JSON Lines 归档
- USER_GUIDE 改"故障排查"段去掉 `app_activity_log.txt` 引用
- 老用户启动期一次性提示"日志路径变更"（可选）

### 工期 ~0.5 天

---

## A3-spread 主题详述

### 背景

v2.1.10 PRD §六明确"不做 A3 扩散到 bankBuRecon / bizOpRecon / pending / reconIdFix" — 3 套引擎评估后续版本再扩散。

v2.1.11 A3-multi-worker 已经把 bizOpRecon 和 pending 纳入复用（参与多 worker）— 这两个模块在 v2.1.11 已 worker 化。

A3-spread 范围收敛为：
- **bankBuRecon**（单据对账）— v2.1.11 是否做？待评估（用户未指定）
- **bankStatement** 银行对账单生成 — v2.1.11 是否做？待评估
- **reconIdFix** 单据对账 ReconID 修复 — 与 F5-cont C4 算法重写共同评估

工期 ~4 周（每模块 ~1 周）。**与 v2.1.11 主线 A3-multi-worker 不冲突**，但工期叠加。

---

## 主题间依赖

```
A3-multi-worker ── 重度依赖 v2.1.10 A3 + A4 框架
                ├─ acquiringBillCurrency 复用 worker pool + chunked
                ├─ bizOpRecon 先 A3 化（提取 runCheckCore） → 接 multi-worker
                └─ pending 同上

F5-cont（C4 算法）── 独立可并行
                  └─ 资金红线评审是 hard requirement

SR-log-1-dual-write-removal ── 完全独立 / 工期短，可任意 Phase 收尾时插入

A3-spread（bankBuRecon / bankStatement / reconIdFix）── 独立可并行
                                                    └─ 复用 v2.1.10 A3 范式 + v2.1.11 multi-worker（如适合）
```

## 风险红线汇总（CLAUDE.md 规则 7）

| 主题 | 风险 | 级别 | 缓解 |
|---|---|---|---|
| A3-multi-worker | SQLite WAL single-writer 限制下 write-splitting 设计 | 🔴 | spec §四 D30 + POC 实测 |
| A3-multi-worker | byte-for-byte 资金红线 | 🔴 | contract test 多档 + 单 worker fallback |
| A3-multi-worker | OOM 低配机器 | 🟡 | D33 动态 worker 数 |
| F5-cont | C4 算法切换直接影响对账金额匹配 | 🔴 资金红线 | spec 阶段 POC + 评审 |
| F5-cont | solver lib 引入 | 🟡 | 包体 / 维护成本评估 |
| A3-spread | 各模块 runCheck 提取 runCheckCore 时业务逻辑差异 | 🟡 | 每模块独立 byte-for-byte contract |
| SR-log-1-dual-write-removal | 老用户启动期日志路径切换 | 🟢 | 一次性提示 + USER_GUIDE 更新 |

## 待 spec 阶段决策点（v2.1.11 范围预留）

| ID | 主题 | 决策点 | PM 倾向（v0.1）|
|---|---|---|---|
| **D29** | A3-multi-worker | worker 默认数量 | 待 spec — 倾向 (b) `os.cpus().length / 2` + (c) settings 可调上限 |
| **D30** | A3-multi-worker | write-splitting 方案 | 待 spec POC — 倾向 (a) 主进程汇总后单 writer（最简）|
| **D31** | A3-multi-worker | 小数据回退策略 | 待 spec — 倾向 < 100w 行回退单 worker |
| **D32** | A3-multi-worker | 跨模块 pool 共享 | 待 spec — 倾向 (a) 每模块独立 pool（避免资源争抢复杂度）|
| **D33** | A3-multi-worker | OOM 防御 | 待 spec — 倾向 settings 默认 worker=2 + 高级用户可调到 4-8 |
| **D34** | A3-multi-worker | 进度回调聚合 | 待 spec — 倾向不排序流式（按 worker 顺序合并 progress 事件）|
| **D35** | F5-cont | 算法范式 | 待 spec POC — ILP / 网络流 / 启发式 三选一 |
| **D36** | A3-spread | 是否本版同时做 bankBuRecon / bankStatement / reconIdFix | 待 spec 评估优先级 — 倾向先做用户实际反馈"主进程卡"的模块 |

---

**当前状态**：v0.2（2026-05-29 — 用户追加 T1/T2/T3 三需求，已从 main 建 `v2.1.11` 分支，`PRD-v2.1.11.md` v0.1 起草完成；性能主线 A3-multi-worker / F5-cont 顺延为后续 Phase）。

**下一步**：用户 review `PRD-v2.1.11.md`（尤其 §三.2 spec decision points）→ 落 spec / tasks / manual-test-checklist → 委托 dev 实现 T1/T2/T3。

# v2.1.10 迭代清单（Backlog — β 范围）

> v0.1（2026-05-27 起草）：v2.1.9 α / β 拆分（详 v2.1.9 backlog v0.4 §α / β 拆分策略）；本文件锁定 β 范围（v2.1.10 分支 → main）。
> 启动节奏：v2.1.9 α PR 提交后立即建分支 + PM 起 β 三件套；β Dev 等 v2.1.9 α merge 后启动。

## 主题概览（β 范围 — 4 主线 + 1 延期 + 1 评估）

### β 主线（4 项 — 从 v2.1.9 拆出延后做）

| 编号 | 主题 | 性质 | 风险 | 工期预估 | 来源 |
|---|---|---|---|---|---|
| **A3** | runCheck 跨进程化（worker_threads / utilityProcess） | 🔴 架构级 · 跨进程 IPC | 🔴 HIGH | ~1.5 周 | v2.1.7 PRD §10.6 → v2.1.8 §十四 → v2.1.9 α/β 拆分 |
| **A4** | SQL JOIN chunked LIMIT/OFFSET 分批跑（与 A3 联合评估 / 实施） | 性能优化 | 🟡 MID | ~0.5 周 | v2.1.7 PRD §12.1.3 → v2.1.8 §十四 |
| **N4-cont-1** | 收单单据 raw_json 历史保留体积治理：手动清入口 + 滚动保留窗口 | 体积治理 · UX | 🟡 MID | ~5 天 | v2.1.8 PRD §十四 |
| **N4-cont-2** | FK CASCADE 改造：`diff_rows.bill_import_id` / `run_id` 加 ON DELETE CASCADE | 🔴 DB schema 破坏性 | 🔴 HIGH | ~3 天 | v2.1.8 PRD §十四 |

**β 合计预估**：~4 周（PM 上限估算）

### 继续延期到 v2.1.11+

| 编号 | 主题 | 原因 |
|---|---|---|
| **F5-cont** | C4 manyToOne ILP/网络流重写 | 2026-05-27 用户决定 v2.1.9 不做；v2.1.10 也不做；需要单独 spec 评估算法范式（subset-sum DFS+剪枝 → ILP/网络流）+ 资金红线评审 |

### 评估项（视 v2.1.9 上线后实际使用情况）

| 编号 | 主题 | 触发条件 |
|---|---|---|
| **N5-channels-scale** | N5 渠道枚举膨胀（用户创建超 50 个渠道时）UI 下拉虚拟滚动 | v2.1.9 上线后观察渠道平均创建数量；如普遍 > 50 个则启动；否则继续延 |

## 主题间依赖

```
A3 (worker 架构) ── 必须与 A4 联合 spec 评审
                  └─ 决定 A4 是否需要 chunked（若 worker 解决主进程阻塞，A4 可能不必要）

N4-cont-1 (体积治理 UX) ── 独立可并行
N4-cont-2 (FK CASCADE) ── 与 N4-cont-1 强关联（同收单模块 DB 改造，建议合一个 Phase）
                       ── 与 v2.1.9 N5 channels FK 范式需统一（v2.1.9 已锁 ON UPDATE CASCADE，v2.1.10 N4-cont-2 加 ON DELETE CASCADE 范式）
```

## 风险红线（CLAUDE.md 规则 7）

| 风险 | 级别 | 缓解 |
|---|---|---|
| A3 worker 跨进程化 与 v2.1.9 N1' idle cleanup 计时器交互 | 🔴 HIGH | spec 阶段明确 worker 进程边界 + lastActiveTs 跨进程同步策略 |
| A3 worker DB 重连 + PRAGMA + 跨进程错误序列化 | 🔴 HIGH | spec 阶段拍板 worker_threads vs utilityProcess + DB 连接独立 |
| N4-cont-2 FK CASCADE 改造（第 2 次破坏性 schema） | 🔴 DB 不可逆 | 复用 v2.1.9 SR-backup-1 sqlite backup API；活动日志 + 标志位 + 回滚 |
| N4-cont-1 滚动保留窗口策略需评估 | 🟡 数据保留 | spec 阶段拍板保留窗口大小（最近 N 月？N 个 run？N MB？）+ 手动清入口 UI 位置 |

## v2.1.10 启动 checklist（v2.1.9 α PR 提交后）

- [ ] v2.1.9 α PR 进 review
- [ ] PM 立即起 v2.1.10 PRD/spec/tasks/manual-test-checklist 四件套
- [ ] 待 v2.1.9 α merge 到 main
- [ ] 用户在 main 上新建 `v2.1.10` 分支
- [ ] Dev 启动 Phase 0
- [ ] **不依赖 v2.1.9 α 用户验收上线**（按用户拍板"α 提 PR 后立即开 β 分支"）

## 与 v2.1.9 α 的强依赖

| v2.1.10 依赖 | v2.1.9 α 提供 |
|---|---|
| 跨进程化备份（A3 worker 内独立 DB 连接） | SR-backup-1 sqlite backup API（v2.1.9 已建 `src/backend/database/backup.js`） |
| N4-cont-2 FK 改造 | v2.1.9 N5 已锁定的 channels FK 范式 |
| N4-cont-1 体积治理与 v2.1.9 N4 重构（顺带项）一致性 | v2.1.9 顺带项 N4 重构（D22=是） |

## 待 spec 阶段决策点（β 范围预留 — v0.2 全部拍板）

| ID | 主题 | 决策点 | PM 倾向（v0.1） | 用户最终拍板（v0.2） |
|---|---|---|---|---|
| **D23** | A3 | 架构选型：worker_threads（Node 原生）vs Electron utilityProcess（更深整合） | 待 POC | ✅ **(a) worker_threads**（2026-05-28 Phase 0 POC 实测胜出 — 启动 4.8x + IPC 3.5x；详 `scripts/poc/v2.1.10-a3-comparison.md`）|
| **D24** | A3 | worker DB 连接：独立 connection 还是 message-based RPC | 独立 connection（简单） | ✅ **(a) 独立 connection**（2026-05-28 Phase 0 POC DatabaseSync 两栈均通过；详 POC §三）|
| **D25** | A4 | 是否做（若 A3 解决主进程阻塞则不做） | 待 A3 落地后评估 | ✅ **(b) 做 A4**（2026-05-28 评审拍板 — 不等 A3 实测；防 cancel 响应慢 + 进度回调精细化是 hard requirement；详 PRD §四 D25）|
| **D26** | N4-cont-1 | 保留窗口策略：最近 N 月 / N 个 run / N MB | 待 spec 拍板 | ✅ **(e) 7 天短窗口 + settings 可调 1-30 天**（2026-05-28 评审拍板 — N4-cont-1 范围收敛为仅清"对账成功"行 raw_json，7 天足够复查；详 PRD §四 D26）|
| **D27** | N4-cont-1 | 手动清入口 UI 位置：收单模块独立按钮 / 应用设置弹框 | 收单模块独立按钮 | ✅ **(-) N/A 无 UI**（2026-05-28 评审拍板 — 复用 v2.1.9 N1' idle 30min cleanup 自动触发，0 UI；详 PRD §四 D27）|
| **D28** | N4-cont-2 | FK CASCADE 改造范围：仅 `diff_rows.bill_import_id` + `run_id` / 顺带其他表 | 仅这 2 个 FK | ✅ **(a) 仅这 2 个 FK**（接受 PM 倾向）|

## N4-cont-1 重大方案变更（v0.2 reverse sync，非 D 决策点）

| 维度 | v0.1 | v0.2 |
|---|---|---|
| **清理范围** | 清所有老月份 raw_json | **仅清"对账成功"行 raw_json**（保留差异行）|
| **触发** | 手动按钮 + 启动期标记 | **复用 v2.1.9 N1' idle 30min cleanup**（src/main.js:11155-11178）|
| **保留窗口** | 6 月 + 500MB 双门槛 | **7 天**（settings retention_days 单键，可调 1-30）|
| **UI** | 收单模块独立按钮 + 弹框 | **0 UI** |
| **工期** | ~5 天 | ~2-3 天 |
| **依据** | PM 预测式立项 | 用户评审追问 + `diff_rows` schema 不冗余存字段（`src/backend/database/migrations.js:1506`）→ 仅清成功行可保留 diff xlsx 重导能力（`src/main-process/acquiring-bill-currency-writer.js:184`）|

---

**当前状态**：v0.2（2026-05-28 — D23-D28 全部拍板 + Phase 0 POC 完成 + N4-cont-1 方案变更落地）。
**下一步**：Phase 1 启动 — T06-T11 worker 框架 + DB 连接 + 错误序列化（详 tasks.md §四）。

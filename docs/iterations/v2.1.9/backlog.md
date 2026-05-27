# v2.1.9 迭代清单（Backlog — α 范围）

> v0.5（2026-05-27）：用户立项 **SR-log-1** 全局告警统一日志化（按月+日两层归档 / JSON Lines / 永久保留）；D29-D37 9 项决策定案（含 D35 级联取消）；α 工期上调到 ~5.4 周。
> v0.4（2026-05-27）：用户决定 v2.1.10 候选项全部前移到本版（除 F5-cont），并拆 α / β 两版发布；本文件锁定 α 范围（v2.1.9 分支 → main）；β 范围（A3/A4/N4-cont-1/N4-cont-2）见 `docs/iterations/v2.1.10/backlog.md`。
> v0.3（2026-05-27）：D18 grep 修订为 (a)，反向同步五件套。
> v0.2（2026-05-27）：起草 17 项决策定案 + D2 reverse sync 解读。
> v0.1（2026-05-26）：v2.1.8 PR #52 merge 前起草。

## 主题概览（α 范围 — 9 项）

| 编号 | 主题 | 性质 | 风险 | 工期预估 | 来源 |
|---|---|---|---|---|---|
| **N5** | 银行对账单按"银行渠道"区分场景（DB schema + 渠道 CRUD + 双维 dispatcher + Sheet 3 拆出） | 🔴 资金红线 · 对账契约 + 破坏性 migration | 🔴 HIGH | ~1.5-2 周 | 2026-05-27 用户立项 |
| **N6** | 状态框「：」后两次换行 → 一次（renderer 文案 minor） | 缺陷修复 · UI 文案 | 🟢 LOW | ~0.5 天 | 2026-05-27 用户立项 |
| **N7** | 场景管理页面新增按渠道维度的「导入模板」「导出模板」（独立 bundle 类型） | 功能增强 · 新 bundle 类型 + 冲突合并 | 🟡 MID | ~3-4 天 | 2026-05-27 用户立项 |
| **SR-backup-1** | sqlite backup API 改造（N5 migration 依赖前置） | 鲁棒性补强 · 基建 | 🟢 LOW | ~1 天 | v2.1.8 SR2 沉淀 |
| **G1-cont** | 单元测试全量铺：第 1 层剩余 13 + 第 2 层 24 文件 | 工程基建 · 测试覆盖 | 🟢 LOW | ~1.5-2 周 | v2.1.8 PRD §十四（升格自 v2.1.10 候选） |
| **SR-policy-1** | `integration-runner.js` 末尾自动输出"当前清单 markdown 表" → 自动同步 `integration-test-policy.md §七` | 工程化补强 | 🟢 LOW | ~0.5 天 | v2.1.8 SR4 沉淀（升格自 v2.1.10 候选） |
| **N1-settings** | idle 30min 阈值 settings 化（v2.1.8 N1''-D8 锁硬编码 → 配置化） | UX · 可配置 | 🟢 LOW | ~0.5 天 | v2.1.8 spec §3.2.2 D8（升格自 v2.1.10 候选） |
| **N4 重构（顺带）** | N4 migration 的 `fs.copyFileSync` 切换到 SR-backup-1 新 API | 一致性补强 | 🟢 LOW | ~0.5 天 | spec §8.3 顺带项 |
| **SR-log-1** | **全局告警统一日志化**（按月+日两层归档 / JSON Lines / 永久保留 / wrapper hijack 175 处 renderer + 改造 49 处 main console.error） | 工程基建 · 告警可追溯 | 🟡 MID（涉及 175+ 处已有代码改造） | ~3.5 天 | 2026-05-27 用户立项（α 升格） |

**α 合计预估**：~5.4 周（PM 上限估算，含 SR-log-1 ~3.5 天）

## β 范围（移到 v2.1.10）

| 编号 | 主题 |
|---|---|
| A3 | runCheck 跨进程化 |
| A4 | SQL JOIN chunked LIMIT/OFFSET（与 A3 联合） |
| N4-cont-1 | 收单单据 raw_json 历史保留体积治理 |
| N4-cont-2 | FK CASCADE 改造（`diff_rows.bill_import_id` / `run_id` ON DELETE CASCADE） |

详 `docs/iterations/v2.1.10/backlog.md`。

## 继续延期（v2.1.11+ 评估）

| 编号 | 主题 |
|---|---|
| F5-cont | C4 manyToOne ILP/网络流重写 |
| N5-channels-scale | 渠道枚举膨胀的虚拟滚动优化（视 v2.1.9 上线后实际使用观察） |

## α / β 拆分策略（2026-05-27 用户拍板）

| 决策 | 选项 | 拍板 |
|---|---|---|
| 版本号 | α=2.1.9 / β=2.1.10 / α=2.1.9 + β=2.1.9.1 / α=2.1.9-alpha + β=2.1.9-beta | **α=2.1.9 / β=2.1.10** |
| β 启动时机 | α PR 后立即开 β 分支 / α merge 后再开 / α 用户验收后再开 | **α 提 PR 后立即开 β 分支**（α review 期间 PM 起 β 三件套） |
| 分支策略 | α 用 v2.1.9 / β 用 v2.1.10 共用 v2.1.9 / α β 同时双分支 | **α 用 v2.1.9 分支，β 用 v2.1.10 分支**（隔离干净） |

## 主题间依赖（α 范围）

```
独立可并行：N6 / SR-policy-1 / N1-settings / 顺带 N4 重构
N5 是主线 ── 依赖：SR-backup-1（migration 备份基础设施前置）
N5 完成后 ── N7（依赖：渠道枚举可用 + scenarios 关联 channel_id）
G1-cont 是工程基建 ── 与所有 N 项并行（写 test 不阻塞 src 改动；但 src 改动后 test 期望要同步）
```

## 资源警告（CLAUDE.md 规则 5）

α 5 周 ≈ v2.1.8 实际工期（3 周）的 1.7 倍。**单 PR 体量预估**：

- commit 数：~40-60（v2.1.8 = 22）
- 改动文件：~50-80
- 集成测试新增断言：~250+（v2.1.8 基线 1276）

虽然分了 α / β，α 内部仍含 1 个 🔴 资金红线（N5）+ 多个 🟢 LOW 基建。spec 评审阶段需重点审 N5。

## 27 项决策定案（α 范围 — 含 D1-D18 + D19-D22 新增）

### N5（11 项 — 全锁）

| ID | 决策 | 内容 |
|---|---|---|
| D1 | (a) | 「通用」渠道系统内置，不可删不可改名 |
| **D2** | **(c)** | **先专属 + 后通用**（专属优先，通用兜底） |
| D3 | (a) | 未匹配 → fallback 通用 + 保留原始 `<Channel>-<地区>` |
| D4 | (a) | 「转移」=搬运（A→B 后 A 无） |
| D5 | (a) | `scenarios.channel_id INTEGER FK`（ON UPDATE CASCADE） |
| D6 | (a) | 新增行落库后变「修改」 |
| D7 | (b) | 用 column mapping 后的逻辑字段 `Channel` / `地区` |
| D14 | (a) | 独立报表落 `error-reports/{date}/` |
| D15 | (a) | 文件名 `命中场景行-{原文件 basename}-{timestamp}.xlsx` |
| D16 | **(b) 修订** | 「匹配渠道」列值 = **实际命中场景所属渠道 label**（通用→「通用」；专属→「name-ownerLocation」）— 2026-05-27 用户反馈后从 (a) 改 (b)（用户场景：通用下场景 + BOSH-CN 银行账单 → 命中通用 → 期望显示「通用」而非「BOSH-CN」原始字段） |
| D17 | (b) | 列序 `\| 匹配渠道 \| 匹配状态 \| 命中场景 \|` |

### N7（6 项 — 全锁）

| ID | 决策 | 内容 |
|---|---|---|
| D8 | (a) | footer 序 `新增场景 / 导入模板 / 导出模板 / 完成` |
| D9 | (b) | 独立新文件类型 `scenarioBundleVersion=1` |
| D10 | (a) | 单文件多渠道结构 |
| D11 | (a) | 自动创建缺失渠道 + 落库前弹确认框 |
| D12 | (a) | 同名场景冲突跳过 + 报告 |
| D13 | (a) | 默认文件名 `scenarios-bundle-{YYYYMMDD}.json` |

### N6（1 项 — 全锁）

| ID | 决策 | 内容 |
|---|---|---|
| **D18** | **(a)** | **改外层文案**（`renderer.js:3338, 3351` 删 `\n`），仅银行对账单 2 行；保留 v2.1.7 round 2 R3 §8.4.2 内层 replace 设计 |

### α 升格新增决策点（4 项 — 2026-05-27 用户全部拍板按 PM 推荐）

| ID | 主题 | 决策点 | 拍板 |
|---|---|---|---|
| **D19** | G1-cont | 单元测试框架 + CI 阻断 | **(a)** ✅ 沿用 v2.1.8 既定（node:test + CI 不阻断） |
| **D20** | SR-policy-1 | integration-runner 输出格式 | **(c)** ✅ in-place 编辑 `integration-test-policy.md §七` + 时间戳 + stdout |
| **D21** | N1-settings | settings UI 位置 | **(c) ✅** 不做 UI 仅 settings 表手动改（2026-05-27 用户审查后从 (a) 修订到 (c) — Phase 8.6 dev agent #2 自行扩展新建 `createAppSettingsDialog` factory + ⚙️ 入口按钮被用户否决，全部回退；后端 settings 表 + migration + 范围 5-180 校验 + IDLE_CLEANUP_MS 启动期读保留） |
| **D22** | N4 重构（顺带） | 是否本版同步改 v2.1.8 已发的 N4 备份调用 | **(a)** ✅ 是 — backup.js 基建已建，N4 切换成本 0；一致性消除存量风险 |

### 其他 3 项拍板（2026-05-27 用户拍板）

| 项 | 拍板 | 说明 |
|---|---|---|
| **SR-backup-1 是否本版前置** | **✅ 是**（前置） | N5 不可逆破坏性 migration 必须前置 backup 基建；POC + fallback 设计在 Phase 1 完成 |
| **「通用」渠道删除阻止策略** | **✅ 阻止删除 + 提示先转移** | spec §3.2 (b) 选项；DB 层 + UI 层双重保护；与 D4 转移搬运语义一致 |
| **集成测试覆盖范围** | **✅ N5:6+ / N7:5+ / G1:400+ / SR-log-1:4+** | 0 regression 硬约束；合计预估 ~330 新断言 + ~280 unit case + ~12 SR-log-1 unit |

### SR-log-1 决策点（9 项 — 2026-05-27 用户拍板）

| ID | 决策点 | 拍板 | 含义 |
|---|---|---|---|
| **D29** | 日志目录结构 | (a-修订) **`logs/{YYYY-MM}/{MM-DD}/{level}.log`** | 月+日两层归档；与 D32 永久保留搭配跨年浏览自然 |
| **D30** | 告警类型分类 | (a) 仅级别 error/warning/info（3 类） | 直观最常用 |
| **D31** | 日志格式 | (b) JSON Lines | 结构化便于 grep+jq；IDE 可阅读 |
| **D32** | 日志保留策略 | (a) **永久保留** | 用户拍板；不滚动 |
| **D33** | renderer 上报 IPC | (a)+(c) preload 单接口 + wrapper hijack | setStatus + createAlertDialog 内部自动调用 reportLog；调用方零改动 |
| **D34** | 兼容 `app_activity_log.txt` | (a) 双写 1 版本 | v2.1.9 双写 / v2.1.10 评估删旧 |
| **D35** | 启动期清理超期 | **取消** | D32 永久保留级联推断；不实施清理机制 |
| **D36** | 日志查看 UI | (a) **仅文件系统暴露** | 用户拍板；不加按钮入口 |
| **D37** | ESLint 强约束 | (b) 暂不引 | 保持轻量化偏好（devDeps 仅 3 个）；v2.1.10+ 评估 |

### SR-log-1 日志目录结构示意

```
Documents/网银账单生成小助手/
├── app_activity_log.txt              # D34=a 保留双写
├── logs/                             # D29 新结构
│   ├── 2026-05/                      ← 月级归档
│   │   ├── 05-27/                    ← 日级目录
│   │   │   ├── error.log             ← JSON Lines
│   │   │   ├── warning.log
│   │   │   └── info.log
│   │   ├── 05-28/
│   │   └── ...
│   ├── 2026-06/
│   └── 2027-05/                      ← 跨年自然归档
└── error-reports/                    # 业务专属，不动
```

### SR-log-1 风险提醒（CLAUDE.md 规则 7 — 数据保留 / 大范围 refactor）

| 风险 | 等级 | 处置 |
|---|---|---|
| 大范围 refactor — 175 处 renderer + 49 处 main console.error 改造 | 🟡 MID | wrapper hijack 集中改 setStatus / createAlertDialog 工厂；调用方零改动；改完后 grep 监控防回退 |
| 永久保留导致磁盘膨胀（1 年 ~365 日期目录） | 🟡 数据保留 | USER_GUIDE 写明日志位置 + 用户手动清理；v2.1.10+ 评估按日期范围批量清理 UI |
| 双写 app_activity_log.txt 期间数据冗余 | 🟢 LOW | 仅 v2.1.9 一版双写；v2.1.10 评估删旧 |
| renderer wrapper hijack 破坏 setStatus 原行为 | 🟡 兼容 | 集成测试覆盖原 4 状态行为不变 + wrapper 异常 graceful（不抛出阻塞 UI） |

## ⚠️ D2 = (c) Reverse Sync 解读（CLAUDE.md 规则 3）

用户需求 §1 原话：**「所有银行渠道的银行对账单的处理都需要过"通用"的场景」**

PM 实施解读（基于 D2=(c)）：

> 「都需要过通用」**不是**「每行强制必经通用所有场景」，而是「通用渠道对所有渠道都生效，作为专属未命中后的兜底场景集」。

调度模型（基于 v2.1.7 F8 first-match-wins）：

```
行 R → 拼 <Channel-地区> → 匹配渠道 X
  ↓
[ 专属渠道 X 的场景集 ] first-match-wins
  ↓ 未命中
[ 通用渠道的场景集 ] first-match-wins
  ↓ 未命中
→ 行 R 进入「未命中场景行」Sheet 2
```

## 风险红线（CLAUDE.md 规则 7）

| 风险 | 级别 | 处置 |
|---|---|---|
| Sheet 3 输出契约二次变更（v2.1.8 加 → v2.1.9 拆） | 🔴 资金红线 | USER_GUIDE / CHANGELOG 必须显式说明；影响用户后处理脚本 |
| DB schema 破坏性（channels 表 + scenarios.channel_id 外键 + backfill 通用） | 🔴 不可逆 | 复用 v2.1.8 N4 备份范式 + sqlite backup API（**SR-backup-1 前置**） |
| dispatcher 调度模型从单维（scenarios 列表）→ 双维（渠道×场景） | 🔴 对账契约 | scan:vars 必跑 + 集成测试新增渠道维度用例 6+ 个 |
| G1-cont 全量铺 case 期望值"权威性" | 🟡 工程基建 | spec 阶段评审 case 期望值是否反映业务真实而非实现 bug |
| N4 重构改 v2.1.8 已发代码 | 🟡 已发代码改动 | 必须 smoke + 集成测试全跑保 N4 行为不变 |
| 模板 bundle 体系新增独立类型 `scenarioBundleVersion=1`（与 `bundleVersion=4` 互认隔离） | 🟡 兼容 | spec 阶段明确 bundle 文件 type 字段；reader 区分 |

## v2.1.8 self-review 已落实清单（不进 v2.1.9）

已在 v2.1.8 PR #52 self-review 阶段处理，**保留备查**：

- ✅ SR1 dryrun-user-sample.js hitScenarioIds 残留修复（必修）
- ✅ SR1 N4 双源真理 TEMPLATE_BILL_HEADERS（必修）
- ✅ SR2 N4 WAL checkpoint 返回值检查 + busy abort
- ✅ SR2 N4 备份时间戳改紧凑格式
- ✅ SR2 N4 totalRewritten 统计修正（剔除 JSON.parse 跳过行）
- ✅ SR2 N4 fault injection 2 用例（backup-failed + batch-failed）
- ✅ SR3 N1' 多 run 累积串行清 smoke
- ✅ SR3 N1' Phase 2 多 monthKey FK 边界 smoke
- ✅ SR4 gateway-recon-fields `__CUSTOM__` sentinel 防踩坑注释
- ✅ SR4 integration-runner 失败 stderr 截最后 30 行
- ✅ SR4 scenario-dispatcher displayIndex fallback 语义注释
- ✅ SR4 exceljs-writer INTERNAL_FIELDS 投影过滤说明注释
- ✅ SR4 integration-test-policy §三 N/N PASS 硬约束 + §六 release-check 仅开发机本地跑备注
- ✅ SR5 spec §3.2.2 N1''-D6 实施简化反向同步
- ✅ SR5 spec §3.2.2 N1''-D7 多窗口语义补
- ✅ SR5 spec §3.2.2 N1''-D11 三重保险降级路径文档化

---

**当前状态**：v0.6（2026-05-27 — **全部决策点拍板完成 ✅**；D19-D22 + SR-backup-1 前置 + 通用删除阻止 + 集成测试范围 7 项全部按 PM 推荐通过；α 范围 9 主题；累计 36 项决策全锁）。
v0.5（2026-05-27）：SR-log-1 立项；D29-D37 9 项决策定案。
**下一步**：用户新建 `v2.1.9` 分支 → Dev 启动 Phase 0（T01 分支 / T02 scan:vars / T03 grep updateStatusBox 已完成）→ 按 tasks.md v0.3 依赖图推进 9 个主题（~5.4 周）。
**仍待用户拍板**：~~无~~（spec 评审 checklist 已全勾选）。

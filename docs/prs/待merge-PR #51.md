---
pr_number: 51  # 占位，提 PR 后回填
version: v2.1.7
branch: v2.1.7
target_branch: main
status: draft
integrated: false  # 提 PR 后置 true（按 memory workflow_pr_integrate_prd）
draft_by: PM (T14-F)
draft_at: 2026-05-21
---

# PR #51 草稿（待 team-lead 提 PR）

## PR title

```
[v2.1.7] 6 项主功能 + B5 wiring 加固 + F8 dispatcher 第 2 sheet
```

（≤ 70 字符；附带 ⚠️ 资金红线声明 + 全局影响声明 + check-vars 升格清单）

## PR body

````markdown
## Summary

v2.1.7 共 38 commit，7 轮迭代收敛，覆盖 6 项主功能 + 多轮用户反馈修复：

- **F1 C1 AND/OR 切换**：C1 提取 reconId 场景支持多条件 AND（同时满足）/ OR（任一满足）逻辑切换 ⚠️ R5 三层护栏（默认 AND + dialog helper + 引擎 fallback OR 兼容老数据）
- **F2 C3 1v1 方案 A**：⚠️ 资金红线 — 网关 reconId 匹配改用 Set 候选池严格 1v1，消除"幽灵核销"风险
- **F3 大账号 multi-mode 文件名 grid 修复**：CSS grid 3 列治本 + 弹窗加宽
- **F4 C2 重命名 + 校验放宽**：「账单打标」→「银行对账单字段赋值」（10+ 处扇出 + 历史段不动）；billTypes ≥ 1 + reconFields 0 无条件赋值（spec §5.7 方案 A）
- **F6 收单单据币种校验进度反馈**：6 阶段 onProgress 链路 + UI 文案业务化
- **F7-A1 全局 SQLite PRAGMA**：⚠️ 全局影响 — WAL + NORMAL + 64MB cache + 256MB mmap；性能提升 + 旁文件备份提示（USER_GUIDE 已加）
- **F7-A2 source_file 索引 + ANALYZE**
- **F7-B1 Electron 完成系统通知**

**多轮用户反馈修复**：
- round 2 R1-R5 + R6a-R6c：R5 资金红线三层护栏 + R3 状态框中文「：」全局自动换行（全模块影响）
- round 3 B1-B5 + F4 删空 + F8：**B5 R3 wiring 全局审计**（用户发现 1 处 + PM grep 再发现 2 处共 3 处直写改走 `updateStatusBox`） + **F8 dispatcher 反向 filter `unmatchedRows` + writer 第 2 sheet "未命中场景行"** ⚠️ 资金红线 modifiedRows + unmatchedRows = bankRows 契约
- round 4-6 B4 CSS flex/grid 嵌套穿透 max-height：**4 轮诊断**才彻底修好；真根因 = `.ba-scroll-container` 缺 `grid-template-rows: 1fr`（不是 min-height:0 不够）；经验沉淀到 `knowledge/css-flex-grid-overflow-pitfalls.md`

**F5 延期 v2.1.8**：C4 gateway 子模式 BillDate 数字日期解析 + 算法重设（TEST2.xlsx 期望 57 行 vs 单点 fix 28 行，根因 = maxSize=8 + manyToOne 遍历顺序），与 A3 worker_threads 联合主题。

## ⚠️ 资金红线声明（5 个红线节点）

| 节点 | 风险 | 防护 |
|---|---|---|
| **F2 C3 1v1 方案 A** | 同一网关行被多个银行行重复匹配 → 幽灵核销 | Set gwCandidatePool 严格 1v1 + smoke c3 5 case |
| **F4 C2 校验放宽** | billTypes < 1 / reconFields 错位 | dialog 校验 + 引擎 fallback 双层 + smoke c2 全套 |
| **F7-A1 全局 PRAGMA** | WAL 旁文件备份遗漏 / 低配机内存爆 | USER_GUIDE 加旁文件备份提示 + cache_size 文档说明 |
| **F8 dispatcher 第 2 sheet** | modifiedRows + unmatchedRows ≠ bankRows | 反向 filter `!rowLockSet.has(_rowId)` 契约 + smoke baseline modifiedRows 不漂移 |
| **R5 F1 默认 AND** | 老 scenario 被改为 AND 漏行 | 三层护栏（createDefault 'AND' + helper edit 老数据 fallback 'OR' + 引擎 fallback 'OR'） |

## ⚠️ 全局影响声明（4 个全局影响节点）

| 节点 | 影响范围 | 回归覆盖 |
|---|---|---|
| **F7-A1 PRAGMA** | 全局 SQLite | smoke 19 suite + DB 备份恢复演练（含 *.sqlite-wal + *.sqlite-shm） |
| **R3 状态框「：」换行** | 全模块状态栏文案 + CSS pre-wrap | smoke 19 suite + 6+ 模块状态栏手测 |
| **B5 wiring 加固** | 3 处直写 statusBox → 统一走 `updateStatusBox` | smoke 19 suite + acquiring + bankStatement + reconIdFix 手测 |
| **F4 C2 重命名** | 10+ 处文案扇出（「账单打标」→「银行对账单字段赋值」） | smoke + preview + USER_GUIDE F4 历史段不动 |

## ⚠️ 关联功能 review（check-vars T14-E 升格 10 条）

`rules/important-variables.md` v8 → v9 同步升格：

**Critical（业务契约锚点）3 条**：
- `runAllScenarios` / scenario-dispatcher — 银行账单场景化引擎统一入口 + first-match-wins + 反向 filter 契约
- `unmatchedRows` 字段 — dispatcher 反向 filter 输出（与 reconIdFix 同名字段严格区分两条流水线）
- `conditionsLogic` 字段 — F1 C1 AND/OR 切换契约 + R5 三层护栏

**Important-skeleton（系统骨架）2 条**：
- `AppDatabase` / `AppDatabase.init` — F7-A1 全局 PRAGMA 设置点
- `updateStatusBox` — R3 全局中文「：」换行 + B5 wiring 入口

**Risk-sensitive（资金 / 过滤 / 迁移红线）5 条**：
- `pickConditionsLogicChecked` — R5 三层护栏第 2 层
- `runC1Scenario` — F1 引擎 + R5 三层护栏第 3 层
- `runC2Scenario` — F4 重命名 + 校验放宽
- `runC3Scenario` — F2 方案 A 资金红线
- `writeBankStatementOutput` — F8 第 2 sheet 契约 + ExcelJS vs SheetJS 注意

详见 `rules/important-variables.md` v9 元数据 + 各条目「变更 review 要点」。

## 实施记录（PRD §二十三 v0.11）

- 38 commit 完整表（按时间逆序 + commit hash + 对应 PRD/spec §引用）：详见 PRD §23.1
- 6 round 历程总结表：详见 PRD §23.2
- F5 延期状态：详见 PRD §23.3 + §十

## 知识沉淀

- `knowledge/css-flex-grid-overflow-pitfalls.md` — **v2.1.7 B4 round 3-6 完整经验**：flex/grid 嵌套穿透 max-height 必修两条线（每层 flex/grid item `min-height: 0` + grid 父容器 `grid-template-rows: 1fr`），缺一不可；含 DevTools 实测数据 + 排查 SOP + 双写范式
- `knowledge/index.md` 同步入索引

## Test plan

- [ ] `npm run smoke`（19 suite 全过）— 含 F7-A1 PRAGMA 全局回归 + R3 状态框换行 + B5 wiring + F8 第 2 sheet + F2/F4/R5 资金红线
- [ ] `npm run preview`（主 UI 截图最新）
- [ ] `npm run preview:account`（账号映射截图最新）
- [ ] F1 C1 dialog AND/OR 切换：新建场景默认 AND radio 选中 + 编辑老场景 OR radio 选中
- [ ] F2 C3 真实银行账单 + 网关账单端到端（1v1 防幽灵核销）
- [ ] F3 大账号 multi-mode ≥ 20 文件场景：弹窗滚动条出现 + 文件名 grid 3 列正常
- [ ] F4 C2 场景：billTypes=1 + reconFields=0 端到端 + 文案"银行对账单字段赋值"
- [ ] F6 收单单据币种校验：6 阶段进度文案显示 + 完成 Notification 弹出
- [ ] F7-A1 启动后：`tool-data.sqlite` 同目录出现 `*.sqlite-wal` + `*.sqlite-shm` 旁文件
- [ ] F8 银行账单导出：sheet 1 已处理 + sheet 2 未命中场景行 + 行数互斥无遗漏
- [ ] R3 全模块状态栏：中文「：」后自动换行（acquiring / bankStatement / reconIdFix / bankBuRecon / bizOpRecon）
- [ ] B5 wiring：3 处历史漏接（直写 `box.textContent`）已改走 `updateStatusBox`，tone 颜色 + 换行均生效
- [ ] DB 备份恢复：手动备份 `tool-data.sqlite` + WAL 旁文件，恢复后启动 DB 正常（CHANGELOG/USER_GUIDE 提示已添加）

## 关联文档

- PRD：`docs/iterations/v2.1.7/PRD-v2.1.7.md` v0.11（含 §二十三 实施记录 38 commit 全列表 + 6 round 历程）
- spec：`docs/iterations/v2.1.7/spec.md` v0.9（含 T14 反向同步 3 处：§8.4.2 styles.css→styles-gemini-extra.css / §9.8.4 F8 SheetJS+ExcelJS 双版本 / §11.3.8 B4 round 6 真根因补章）
- tasks：`docs/iterations/v2.1.7/tasks.md` v0.8（T14 收口子项清单）
- 知识：`knowledge/css-flex-grid-overflow-pitfalls.md`（B4 round 3-6 完整经验）
- 升格清单：`rules/important-variables.md` v9（10 条新升格）

## 维护提示

- 三件套（`CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md`）由 team-lead 与 version bump 同步更新；本 PR 不在 commit 列表内单独提
- PR 合并后按 memory `workflow_pr_integrate_prd` + `workflow_archive_pr_draft`：归档 `docs/prs/待merge-PR #51.md` → `PR51-v2.1.7.md` + 加 `integrated: true`
- 多版本并行（按 memory `workflow_multi_version`）：v2.1.7 → main merged 后评估是否同步到 v3.0.0 开发分支
- 若与 obsidian 同步（按 memory `workflow_sync_iterations_to_obsidian`）：用户说"同步"时 rsync `docs/iterations/v2.1.7/*.md` 到 obsidian vault
````

## team-lead 提 PR 时的命令模板

按 memory `workflow_no_tester_no_auto_pr`，等用户明确"提 PR"后执行：

```bash
# 1. version bump（package.json 2.1.6 → 2.1.7）+ 三件套 + important-variables.md commit
git add package.json package-lock.json CHANGELOG.md docs/VERSION_FEATURE_HISTORY.md docs/USER_GUIDE.md rules/important-variables.md
git commit -m "[v2.1.7] release: version bump + 三件套 + important-variables v9 升格 10 条"

# 2. PRD/spec/tasks/knowledge commit（PM T14 产出）
git add docs/iterations/v2.1.7/PRD-v2.1.7.md docs/iterations/v2.1.7/spec.md docs/iterations/v2.1.7/tasks.md knowledge/css-flex-grid-overflow-pitfalls.md knowledge/index.md docs/prs/待merge-PR\ \#51.md
git commit -m "[v2.1.7] docs: PRD v0.11 实施记录 + spec v0.9 反向同步 + tasks v0.8 T14 + knowledge flex/grid + PR 草稿"

# 3. push + PR
git push -u origin v2.1.7
gh pr create --base main --head v2.1.7 --title "[v2.1.7] 6 项主功能 + B5 wiring 加固 + F8 dispatcher 第 2 sheet" --body "$(cat docs/prs/待merge-PR\ \#51.md | sed -n '/^## PR body/,/^## team-lead/p' | sed '1d;$d')"

# 4. 提 PR 成功后：归档 + integrated:true（按 memory workflow_archive_pr_draft + workflow_pr_integrate_prd）
mv "docs/prs/待merge-PR #51.md" "docs/prs/PR51-v2.1.7.md"
# 编辑 docs/prs/PR51-v2.1.7.md 头部 integrated: true + pr_number 回填
```

## PM 完成事项确认（T14 PM 工作 6 项）

- ☑ T14-A spec 反向同步 3 处（§8.4.2 styles.css→styles-gemini-extra.css / §9.8.4 F8 SheetJS+ExcelJS 双版本 / §11.3.8 B4 round 6 真根因补章 + DevTools 数据）
- ☑ T14-B knowledge 沉淀（`knowledge/css-flex-grid-overflow-pitfalls.md` + index.md）
- ☑ T14-C PRD v0.11 实施记录（§二十三 38 commit 全列表 + 6 round 历程 + integrated:true）
- ☑ T14-D tasks v0.8（T14 标进行中 + 收口子项清单）
- ☑ T14-E check-vars 升格 10 条（`rules/important-variables.md` v8 → v9）
- ☑ T14-F PR body 草稿（本文件）

剩余 team-lead 工作：T14-G version bump / T14-H 三件套 / T14-I important-variables.md 落盘（已在文档中，commit 阶段确认）/ T14-J commit+push+PR / T14-K PR 草稿归档。

# v3.2.18 发布与集成记录

本文件记本轮范围、模块合入与最终证据；模块内的审查处置与验证细节见各自 spec / TechDoc，不重复复制。

## 本轮信息

| 项目 | 事实 |
| --- | --- |
| 目标版本 | 3.2.18 |
| 操作范围 | 2026-11-16 用户要求把除 `feat/retire-recon-modules` 外的功能分支一起推送并合入远端 release 分支，准备发版。开 PR、合并 main、打正式标签与对外发布尚未授权 |
| 正式基线 | `v3.2.17` → `a7f268f2e2499d67bab464ef90f20b56c9344014` |
| release 分支 | `release/v3.2.18`，2026-11-16 从基线新建（此前本地与远端均不存在）；工作树 `.claude/worktrees/release-v3.2.18` |
| 远端 main | `a7f268f2`（即基线），已包含在 release 历史 |
| 排除 | `feat/retire-recon-modules`（用户指定不纳入；当前在主签出，基于 `a7f268f2`，有未提交改动，未动） |

## 纳入范围（清单 A4）

各分支均基于 `v3.2.17`（`a7f268f2`），按下表顺序 `--no-ff` 合入。

| 内容 | 源分支 / 末端 | 合入提交 | 文档 |
| --- | --- | --- | --- |
| backlog 登记：`publication-legacy-concurrency` 在 Windows CI 偶发 `ADMISSION_TIMEOUT` | `chore/backlog-b93-admission-timeout-flake` / `06294e49` | `cfeb96ef` | backlog B93 |
| 工具箱拆分 Worker 内存超限时给出中文可解释提示 | `fix/toolbox-split-oom-message` / `0773a5c7` | `5a83465d` | backlog B99 |
| 核对上一账单日余额弹窗说明字号、金额标黑、句号换行 | `feat/balance-seed-mismatch-text` / `170e6bd7` | `e34b55b5` | — |
| 设置新增「数据管理」页：保留期限迁入，新增链接表保留期限与空闲过期清理 | `feat/data-management-retention` / `7afaedb0` | `de175c51` | [Spec](feat/data-management-retention/spec.md)、[TechDoc](feat/data-management-retention/techdoc.md) |
| 网银导出明细直接另存、导出余额范围弹窗调整；模板管理【更新】只替换模板字段并保留映射 | `feat/statement-export-template-update` / `1c9e1c08` | `3307e4ae` | [Spec](feat/statement-export-template-update/spec.md)、[TechDoc](feat/statement-export-template-update/techdoc.md) |
| 【导入模板】新模板命名弹框（渠道名-地区）；余额管理账户号搜索与币种筛选 | `feat/template-import-naming` / `ac31c772` | `e2ae51a1` | [Spec](feat/template-import-naming/spec.md)、[TechDoc](feat/template-import-naming/techdoc.md) |
| 设置「账户管理」导入/导出与翻页移到底栏，表格只显示 8 个字段 | `feat/bank-accounts-layout` / `95c8f348` | `ab6d1f96` | [Spec](feat/bank-accounts-layout/spec.md) |
| 映射字段「字段筛选特征值」支持多个具名特征值，「特征值管理」弹窗 | `feat/mapping-feature-values` / `e6baf0e7` | `bcd85fc1`、`a9f05dd5` | [Spec](feat/mapping-feature-values/spec.md)、[TechDoc](feat/mapping-feature-values/techdoc.md) |

各分支合入前均无远端分支、未跑模块 PR 的 Windows CI；Windows 证据以本轮 release PR 的 CI 为准。

### 合入处理

- `knowledge/backlog.md`：`fix/toolbox-split-oom-message` 与 `feat/statement-export-template-update` 都用了 B95；后者的 B95–B97 已被其 TechDoc 与 `feat/template-import-naming`（B98）引用，改前者为 B99。删去各分支“在途分支占用编号”的临时说明，条目按编号排列。
- `rules/integration-test-policy.md` §七：合入时取 release 版本，完整集成后回写。
- IPC 计数：`data-management-retention`、`statement-export-template-update`、`template-import-naming` 各新增 2 个、`mapping-feature-values` 新增 1 个通道，两两合入时 git 把相同的 302→304 视为同一改动自动合并；`archive-task-policy-registry.test.js` 按合计改为 IPC 309、exclude 159、support action 16，`execution-descriptor-archive-baseline.test.js` 与 `task-policy-registry.js` 两侧条目都保留。
- `architecture/boundaries.json`：用三方 JSON 合并保留各分支的 `allowedApiFields` 增项与 `policyChanges` 条目。
- 跨分支语义冲突（`8fbf993e`）：`statement-export-template-update` 的模板【更新】失效引用检查按 v3.2.16 单套 `template.featureFilter` 收集筛选字段，`mapping-feature-values` 改为多特征值数组后该检查读不到特征值。改为逐个特征值计入、只有生效映射选用的特征值为启用，提示行带特征值名；`statement-template-update.js` 脚手架同步注入名并新增 ⑬ 用例。
- 架构历史检查（`policyChanges`）：合入后报 351 处 `ARCH-POLICY-HISTORY`（`renderer-dialog-configuration`、`renderer-statement`、`renderer-dialog-app-settings` 的 `allowedApiFields`）。v3.2.17 及更早快照的已有迁移链止于基线集合，各模块分支的条目只到本分支的集合；按 v3.2.17 先例，给基线之后仍持有较早集合的提交补登到合入后最终集合的放宽，来源取覆盖这些提交的分支末端或合并提交（3 个边界共 14 条，本文件为其 designDoc）。

## 升版与发布文档（清单 C1–C2）

- `package.json` / `package-lock.json` 升为 3.2.18（`npm version 3.2.18 --no-git-tag-version`，保留 `package.json` 原格式）。
- `CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md` 新增 3.2.18 条目，`docs/USER_GUIDE.md` 版本与版本说明更新（各模块的使用说明已随模块分支写入），`src/main-process/release-notes/release-notes.json` 顶部新增 3.2.18 升级弹窗要点 5 条。

## 遗留项处置（清单 B4）

本轮纳入的分支未修复 backlog 中目标为 v3.2.18 的既有条目（B45、B47、B48、B52–B58、B60、B70、B75、B77、B79、B86、B92）；是否在本版前补做或顺延，待发版前确认，届时更新各条目标版本。本轮新增 B93、B94、B95、B96、B97、B98、B99。

## 待人工复核（清单 C5）

- **B94（P1，资金）**：链接表默认保留期限非永久，升级后第一次空闲即删除网关对账单数据日期超过 15 天、银行对账单表超过 60 天的行，不可恢复；须资金负责人确认默认值并完成打包版回归。
- **B96（P2）**：模板【更新】起，主映射或拆分映射指向表头外字段的存量模板会被拦截生成（以前静默输出空值）；发版前用真实库副本只读扫描受影响模板。
- **特征值 BillDate 合计行（资金红线）**：BillDate 选「字段筛选特征值」时，合计行识别改为取所选特征值的源单元格；集成用例确认合计金额不作为交易导出，仍须人工复核。
- 实机 GUI：B95（导出交互与模板【更新】）、B98（导入模板命名与余额管理筛选）；数据管理、账户管理布局、多特征值的界面只有渲染生命周期截图证据。

## 验证（清单 C4）

- 2026-11-16 在候选 `9bd81077`（升版提交）上运行 `npm run release-check`：EXIT=0。lint 通过；架构检查通过（解析 832/832 文件，历史检查 333 个提交）；单测 10280/10284（0 失败）；集成 109 个脚本 3885/3885；smoke 通过。`rules/integration-test-policy.md` §七 由 runner 回写，单独提交。
- 合入前各模块分支的验证见各自 TechDoc；`feat/mapping-feature-values` 末端另跑过完整 `release-check`（EXIT=0）与两轮 Codex 审查。合入后本轮未做 release 级 Codex 审查。
- 远端 Windows CI：各模块分支未推送过，没有 Windows 证据；本轮 release 开 PR 后以 PR 的 Windows CI 为准（开 PR 尚未授权）。

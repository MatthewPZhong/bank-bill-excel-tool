# v3.2.9 发布记录

## 当前发布状态（2026-09-19）

已完成六功能集成与代码自审，Windows 复验新增确认原生 AM/PM 裁切 P2，132px 修复已实现、待最终复验；版本准备提交为 `5001d331bb78bdb82dfaa018ee705b51681bde4f`。完整本地门禁已通过，Windows/人工/规模验收未闭环，尚未发布、合并 main 或打正式标签。下方历史门禁保留原结论，不代表当前候选。

- 任务范围：用户明确要求自审至无 P2 Finding，执行 weekly-release 全流程，最终核实本地/远端 main 均为 3.2.9。授权覆盖所需提交、推送、PR、合并、升版、正式标签及发布；不得把授权写成验收通过。
- 目标版本/分支：`3.2.9` / `release/v3.2.9`；基线 `v3.2.8` → `2ba9ef14fe972363b604955636cff0c9ac53700f`。
- 本轮按用户即时发版请求执行；冻结范围截止：2026-09-19T01:11:38+08:00，时区 Asia/Shanghai。Skill 的周一窗口不是自动调度，不新增计划任务。
- 接手 release：`6bd55efe0eb1d90c16cd92f3a78e54a39a36b966` + 18 项已备份外观/文档改动，随后提交为上述版本准备提交；已有 merge 成果全部复用。
- 本轮证据目录：`/private/tmp/v329-release-20260919-3_bafjvz/`。自审文档见 [release-review-2026-09-19.md](release-review-2026-09-19.md)。

## 冻结纳入与顺延

| 功能 | 合同 | 源提交 / 合并提交 |
|---|---|---|
| 业务 OP 自动错误报告 | [Spec](codex/v3.2.9-biz-op-error-report-auto-save/Spec-v3.2.9-biz-op-error-report-auto-save.md) / [TechDoc](codex/v3.2.9-biz-op-error-report-auto-save/TechDoc-v3.2.9-biz-op-error-report-auto-save.md) | `3efe5c78` / `896fe12d` |
| 存档模块保留期限 | [Spec](codex/v3.2.9-archive-retention-by-module/spec.md) / [TechDoc](codex/v3.2.9-archive-retention-by-module/techdoc.md) | `a2bd6e81` / `e1c31139` |
| 定时深色模式 | [Spec](codex/v3.2.9-night-mode/spec.md) / [TechDoc](codex/v3.2.9-night-mode/techdoc.md) | `654ba97a` / `e134cf4e` |
| 存档永久删除 | [Spec](codex/v3.2.9-archive-center-permanent-delete/spec.md) / [TechDoc](codex/v3.2.9-archive-center-permanent-delete/techdoc.md) | `b78cf3a5` / `d3ebded6` |
| 工具箱按行拆分 | [Spec](codex/v3.2.9-toolbox-split-by-rows/spec.md) / [TechDoc](codex/v3.2.9-toolbox-split-by-rows/techdoc.md) | `c03eeb4f` / `0b36ecb6` |
| VCC 多 Sheet 与待确认导出 | [Spec](codex/v3.2.9-vcc-fin-op-multisheet-review-export/v3.2.9_VCC_Spec.md) / [TechDoc](codex/v3.2.9-vcc-fin-op-multisheet-review-export/v3.2.9_VCC_TechDoc.md) | `069e340c` / `6bd55efe` |

另纳入 `codex/repository-organization@fd18667a6fecc6c0384dfbfa08a231cd05439354`（merge `07392111`）及本 release 已有外观修复。六项产品合同共 12 份均位于 `changes/v3.2.9/codex/`。

顺延：`fund-recon-background`、`template-manager`、`toolbox-ui` 的源 ref 仍在基线，未提交实现不属于本版；主目录的账户映射设计稿和 archive-batch-lifecycle 资料保留原处，不混入。本轮没有删除任何开发分支。

## weekly-release 执行清单

- [x] A1/A2/B1/B3：已核实上一正式发布、现有 release、工作区及备份边界，未重建 release。
- [x] B2：fetch 实际 origin；main 要求 `smoke-test`、`build` 严格检查，禁止强推且 admins 同样受保护。production-release 有指定用户审批，正式标签有创建/不可变规则。
- [x] B4/B5：核对六源 SHA 均为祖先且实际实现存在；当前 `origin/main` 与基线相同并包含于 release，暂无新增 hotfix。
- [x] C1/C2：版本和锁文件 3.2.9；同步 CHANGELOG、版本功能历史和使用手册。
- [x] C3：核心候选 `5001d331` 已提交；后续仅文档和验收脚本修订另行记录，不将未提交内容当已发布。
- [x] C4 本地自动门禁：完整 release-check exit 0；499 个单测文件，7,861 PASS / 0 FAIL / 3 Windows 专用 SKIP；59 个集成脚本全部通过，2,574/2,574。
- [ ] A3/C4 平台/C5/C6：新增 AM/PM 裁切 P2 修复待平台复验；人工及 VCC 完整性能门禁仍待闭环。
- [x] D1/D2：同名 release 已推送并建立 release→main 草稿 [PR #239](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/239)；每次推送均核对 head，候选 SHA 见 PR 及下方续做记录。
- [ ] D3/D4：最终 head 的 Windows 检查/构建与必要验收通过后，重新核对 main 及合并条件。
- [ ] E1–E5：满足发布条件后进入锁定窗口、合并 PR、核实最终 main 检查、创建并核验附注 `v3.2.9`。目前未宣称仓库已被技术锁定。
- [ ] F1–F4：标签发布 workflow、正式 Release、setup/portable/blockmap/latest.yml 与 SHA512 全部实测核验。
- [ ] G1–G3：补齐 PR→最终 main→tag→产物追溯，保留顺延项，并在不覆盖主目录未提交资料的前提下快进本地 main。

## 本轮验收状态

本地完整门禁：Node 24.13.0，`UNIT_TEST_CONCURRENCY=2 npm run release-check`，日志 `release-check.log`，exit 0。lint、smoke、499 个单测文件与 59 个集成脚本通过；单测 7,861 PASS / 0 FAIL / 3 Windows 专用 SKIP，集成 2,574/2,574。原门槛 toolbox RSS 31/31，本次未复现历史失败，不改写历史结果。UI 和独立跨层探针见本轮自审；首次设置脚本旧 API 夹具失败及修复后通过均保留。

门禁在核心候选 `5001d331` 开始，结束后核对 1,521 个固定输入：生产代码、依赖、单测与集成输入全部一致；仅两份独立 GUI 验证脚本变化，已分别实跑通过并重新 lint。另新增 PF runner 三文件，小导出、停写取消及平台拒绝前置核验通过；文档、证据与 runner 自动生成的集成表一并形成后续候选。详见 [evidence-summary.json](self-review-2026-09-19/evidence-summary.json)。

新增 Windows 专项 evidence workflow 由草稿 PR 触发，收集原生时间输入、真实 Main、设置交互、VCC Electron/ASAR 和 PF 证据。collector 的绿色状态只表示证据步骤正常结束；exit 2 仍明确代表存在 NOT_RUN，不能替代完整验收。

VCC Spec AC30/RV12 与 TechDoc §12.4 要求 Windows x64/16 GiB/SSD/Electron 36.9.5 的完整链路、Excel/WPS 和 PF01–PF05；已有组件百万行测试不能替代。真实人工验收记录已向用户询问，尚未收到；在此期间继续自动验证及候选包准备，不记录人为签字。发布前还须完成对应存档和原生系统流程的必要平台验收。逐项操作与证据字段见 [候选包人工验收清单](manual-acceptance-2026-09-19.md)。

## 当前候选的 Windows CI 续做

- 已推送候选 `d17a44ddb93c5b030f901a1cd785a26e8896544f`，建立草稿 [PR #239](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/239)，来源 `release/v3.2.9`、目标 `main`。远端 release head 已核对相同；main 尚在 `2ba9ef14`。
- 首次 [Windows 专项运行](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35375147094) 为 FAIL：原生时间输入 14/16，后续专项全部跳过。原始事件显示 Windows 原生 12 小时控件将首位 `1` 解释为 `13:30`，`20` 解释为 `14:30`→`14:00`；应用完整保存了实际控件值。失败来自验证器假定 24 小时按键解释，未见生产保存丢失证据。
- 验证器改用结束时间 `14:00` 严格触发两种小时制的 dark→light→dark，并将关闭排队后的新编辑固定为 `19:30`，继续严格检查最终保存及失焦保持。另记录裸控件 `20` 和区域信息，不用观测值替代产品断言。本机 16/16 通过，修正后 Windows 结果待新候选 CI；未修改生产逻辑。原始和修正证据见 [evidence-summary.json](self-review-2026-09-19/evidence-summary.json)。
- 专项工作流的各独立检查在候选身份核验成功后继续采集，即使另一专项失败；没有 `continue-on-error`，真实失败仍令工作流失败，避免第一项失败使所有证据缺失。


### 第二轮 Windows 与验证器修正

- 候选 `66f357bd` 的 [Windows 专项](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/35376141525) 仍为 FAIL，独立检查已全部继续采集：原生键盘 16/16 通过，真实 Main 呈现 2/2、22 个断言通过；后者未测量 AM/PM 内部文字可见性。
- 设置交互首组在 30 秒超时，其他五组布局通过。隔离隐藏窗口增加 `backgroundThrottling:false` 并记录阶段，不增加超时或减少交互断言；本机修正后 6/6、4/4 场景、73 个断言通过，Windows 待复测。
- VCC 的 Electron/ASAR 和 PF 检查因 Windows 子进程继承空值 `ELECTRON_RUN_AS_NODE` 进入 Node 模式而启动失败。改为删除变量及其大小写变体；原导出、缓存、内容、取消和 PF 判定保留。本机在父进程变量值为 `1` 的条件下，ASAR 导出、小样本 PF 通过，非 Windows 基线仍明确 exit 2 / NOT_RUN。
- Windows 截图中的 AM/PM 可能受 104px 时间框裁切，正在补 UA shadow DOM 字段和文字的几何证据，以及只改内存样式的 132px 对照。尚未将截图疑点写成已确认产品缺陷或已修复。
- 证据见 [第二轮摘要](self-review-2026-09-19/windows-round2-summary.json) 和 [证据索引](self-review-2026-09-19/evidence-summary.json)。本轮尚未变更生产源码；最终候选仍须实际 Windows 检查及必要人工验收。

## 历史本地集成与验证记录

以下为当时范围、状态和证据，保留失败与独立复跑记录；后续版本状态以上方本轮清单为准。

### 2026-09-12 本地集成记录

- 目标分支：`release/v3.2.9`。
- 上一正式基线：`v3.2.8` / `2ba9ef14fe972363b604955636cff0c9ac53700f`。
- 本轮已纳入范围：业务 OP 自动保存错误报告、按模块配置存档保留期限、定时深色模式；仅进行本地 release 集成，未推送、升版、创建 PR、正式标签或发布。
- 集成日期：2026-09-12。

## 纳入模块

| 模块 | 源分支 | 纳入提交 | 集成方式 |
| --- | --- | --- | --- |
| 业务 OP 导入错误报告自动保存与状态反馈 | `codex/v3.2.9-biz-op-error-report-auto-save` | `3efe5c78e8cde10d89db90d4509d883b28d61f4f` | 独立 worktree 无冲突合并，保留 merge commit |
| 按模块配置存档保留期限与保存队列保护 | `codex/v3.2.9-archive-retention-by-module` | `a2bd6e817a08190e82caecfe4f248054b25cae6e` | 基于首次集成结果继续合并；生产代码无冲突，自动测试清单由 runner 重建 |
| 定时深色模式与外观设置 | `codex/v3.2.9-night-mode` | `654ba97a24223d671d61b0737974d1b6942ceb16` | 基于两模块集成继续合并；保留 Biz OP 文本布局、期限保存队列与主题配色，精确合并两条设置 IPC |

Biz OP 源分支原有 20 个未提交文件已核对归属并形成上述提交，包含最后一轮 review 的 renderer 状态反馈修复。源提交内容与保存的快照逐文件一致。主工作区保持 `main` 及既有未提交改动。

## 首次 Biz OP 集成验证（896fe12d）

- `UNIT_TEST_CONCURRENCY=2 npm run release-check`：2026-09-12 14:00:55 +08:00 完成，exit 0 / PASS。lint、smoke 通过；470 个单测文件，7,351 PASS / 0 FAIL / 3 SKIP；54 个集成脚本全部通过，汇总 2,500/2,500。
- Electron 原生 DOM：`node scripts/verify-biz-op-v329-renderer-dom.js <本次证据目录>`，10/10 PASS，布局、长路径换行和文本选择检查通过。
- 3 个跳过项均为既有 Windows 专属 PowerShell/packaged canary 测试，本次新增测试没有跳过。
- 本次 [候选摘要与验证结果](codex/v3.2.9-biz-op-error-report-auto-save/integration-candidate-20260912.json)绑定 14 个代码、测试和脚本文件；合并前再次核对全部与源提交一致。测试后仅补充本记录、验证记录、候选摘要及 runner 自动刷新的集成清单。
- 完整日志、DOM 输出与截图保存在本地忽略目录 `logs/verification/release-v3.2.9/biz-op-auto-report/`，日志 SHA-256 已记入候选摘要。日志不随源码提交。
- Windows Excel/WPS 打开报告及完整 Windows 应用人工验收未执行，仍为正式交付前的验收项。

原 `candidate-sha256.json` 与旧验证记录保留为 review 修复前的历史证据；本次结果使用新的候选摘要和日志，不覆盖旧记录。

## 模块保留期限组合验证

- 本次合并前 release 为 `896fe12d29e518ccece8afce5c3d120b1c6de5c7`，源分支 22 个文件与其最新完整门禁及复审摘要逐项一致，已提交为 `a2bd6e81`。
- `src/main.js` 自动合并保留了模块期限 resolver、维护 IPC 和 Biz OP 自动报告的既有注入。唯一文本冲突是自动集成测试清单，规则正文没有冲突。
- 合并后的 Electron 设置布局与交互 6/6 PASS，覆盖两种尺寸及三档缩放；Biz OP 原生 DOM 10/10 PASS。
- 新增 `scripts/integration/archive-biz-op-auto-report-retention.js`，真实组合回归 6/6 PASS：OP/FLOW 模块有限期限、永久和继承、历史批次期限不变、双向修改设置后的未决归档恢复，以及真实 INPUT hold 和 Documents 报告保护。该脚本使用现有 fixture 的装配入口，没有修改生产源码或公共 helper。
- 组合完整命令 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-09-12 14:26:40 +08:00 完成，exit 0 / PASS：lint、smoke 通过；471 个单测文件，7,361 PASS / 0 FAIL / 3 SKIP；56 个集成脚本全部通过，汇总 2,516/2,516。其中模块期限 10/10、Biz OP 自动报告 12/12、组合回归 6/6。
- 自动集成清单由本次全量 runner 成功后重新生成，包含两个模块及新增组合脚本，未手工拼接运行数字或改动规则正文。
- 本次 [组合候选摘要与验证结果](codex/v3.2.9-archive-retention-by-module/integration-candidate-20260912.json)绑定 29 个代码、测试和脚本文件，门禁后再次核对全部一致。最终补充仅为验证记录和摘要。
- 当前组合日志及 DOM 截图位于本地忽略目录 `logs/verification/release-v3.2.9/archive-retention-integration/`，日志 SHA-256 已记入候选摘要，不随源码提交。首次 Biz OP 集成记录和源模块的历史验证证据保留。
- Windows、Excel/WPS、安装包及真实业务人工验收仍未执行。

## 定时深色模式组合验证

- 本次合并前 release 为 `e1c31139dcb7eeca3edbc12dd293e4419b56950f`。夜间模式源分支 74 个文件已核对归属并提交为 `654ba97a`：29 个代码/测试/脚本、1 份自动集成清单、44 份功能文档、预览与验收资料。另有 11 份 ignored 日志保存在源工作区及本次恢复备份。
- Biz OP CSS 的文本选择、长路径换行、按钮及 footer 布局与夜间主题变量同时保留。Main、Preload、Renderer 和设置存储保留全部三模块改动；生产代码没有额外业务语义变更。
- 两条新增设置 IPC 同时纳入后，精确数量断言更新为 267 个 IPC、131 个 exclude；分类、reserve/no-file 数量及启动保护保持原契约。
- 更新两份源文档中已经失效的“演示时间选择”描述，反映用户后续确认的本机时间行为。离线 HTML 保留源分支交付字节和 SHA；其中 35 处空白行尾空格作为生成产物原有格式保留，其余本轮差异通过空白检查。
- 隔离 Electron 夜间界面矩阵 15/15 组、30 个日夜主题场景、2,580 个断言通过，300 次加载文件摘要比对一致。新增 `DARK_MODE_UI_EVIDENCE_DIR` 可选输出目录，原源分支的 30 张截图和三份 JSON 历史证据未覆盖。
- 设置原有 6 组尺寸/DPR 矩阵通过；新增主题和期限交错保存 4/4 场景、73 个断言通过，覆盖成功、失败回滚、切页、主题事件、重开等待、最终 intent 和删除/关闭保护。
- Biz OP 日夜两色真实 Controller 20/20 交互用例、14/14 状态/布局检查通过，包含 saved、failed、pending、cleanup warning 和 success；受测状态卡最低对比度为浅色 5.269:1、深色 7.839:1。
- 完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-09-12 14:55:48 +08:00 结束，**exit 1 / FAIL**。lint、smoke 通过；474 个单测文件，7,381 PASS / 0 FAIL / 3 SKIP；57 个集成脚本中 56 个通过，汇总 2,520/2,522。唯一失败脚本为 `toolbox-large-split-multi-sheet`，29/31；三项跳过均为既有 Windows 专属测试。
- 失败来自工具箱 50 万/150 万行扫描的 RSS 门禁：首次增量为 83/154 MiB，154 同时违反每个样本严格小于 150 MiB 的上限及本次 140 MiB effective budget。该脚本、37 个本地 JS 调用链文件、runner 和依赖清单与合并前及正式基线字节一致，采样链不加载 Electron Main 或主题代码；源码相同不足以证明失败只是噪声，也不能排除依赖实物、运行时或原实现的内存问题。
- 全量 runner 在失败时按规则保留上轮成功的 §七 自动清单，因此该表仍对应 56 脚本的历史通过记录；本次实际发现的 57 个脚本和失败结果以本节及日志为准。没有手工生成成功清单或放宽 RSS 门槛。
- 上述 GUI 均为隔离临时 userData、真实 Renderer/CSS 与内存业务 API。源分支最新真实 Main 冷启动记录仍为 `BLOCKED / BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE`：当时 314 MiB 预算未满足 1024 MiB 申请，业务窗口未创建。本轮未重试或修改预算、激活保护；不能据 GUI 结果宣称真实冷启动或全程无闪白通过。
- Windows 安装包、Excel/WPS、原生系统缩放/物理显示器及完整业务人工验收未执行。

- 一次原门槛独立复跑 `node scripts/integration/toolbox-large-split-multi-sheet.js` 于 2026-09-12T15:01:41.682249+08:00 结束，exit 0 / 31/31 PASS。脚本自动按原预算边界规则采集五组，tier1 为 [85, 88, 90, 94, 89] MiB，tier2 为 [139, 131, 142, 136, 135] MiB；没有调整数据规模、采样规则或硬门槛。这次成功不改写首次完整门禁 FAIL，不证明原始失败已经被解释或永久消除。
- 当前 [三模块候选摘要](codex/v3.2.9-night-mode/integration-candidate-20260912.json)绑定 50 个代码、测试与脚本。完整门禁的 1,399 个固定输入在结束后摘要一致；两份组合 GUI 验证脚本单独以专项结果和摘要绑定。日志及截图位于本地忽略目录 `logs/verification/release-v3.2.9/night-mode-integration/`。
- 本次完成本地功能集成，完整门禁和正式验收尚未全部通过；发布冻结前需闭环工具箱内存门禁及上述人工/平台验收。

## 原生时间输入 review 修复（2026-09-15）

- 修复保存期间禁用原生时间框导致连续键入 `19` 最终保存为 `09` 的 P2；保持编辑焦点、串行合并后续修改，并防止旧回包清除新草稿。同步更新离线 HTML、TechDoc 和回归脚本。
- 当前专项：24/24 定向单测、6/6 存储/IPC 集成、13/13 原生键盘场景、1/1 离线 HTML 输入及重载、两色 GUI 172 个断言、6/6 设置布局与 4/4 主题/期限交错保存场景通过。详见[原生时间输入修复记录](codex/v3.2.9-night-mode/evidence/native-input-fix-20260915.md)。
- 本轮修改尚未提交；未重跑完整门禁，也未改变上述 RSS、真实 Main 冷启动和 Windows/人工验收的未决结论。修复前候选摘要与历史证据保留。

## 关闭后时间编辑 review 修复（2026-09-15）

- 修复关闭操作排队时，关闭之后的新时间编辑被错误结算而丢失的 P2。关闭前旧草稿沿用原语义；关闭后新修改接续保存或校验，失败原因不被内部续存掩盖。同步更新共享 UI、离线 HTML、TechDoc 与回归。
- 当前专项：28/28 单测、6/6 存储/IPC 集成、16/16 原生键盘场景、1/1 离线 HTML 输入与重载、两色 GUI、6/6 设置布局、4/4 主题/期限组合场景及 6 组独立异步交错均通过。详见[关闭队列修复记录](codex/v3.2.9-night-mode/evidence/off-queue-fix-20260915.md)。
- 本轮修改未提交或推送；未重跑完整门禁，前述 RSS、冷启动与平台验收未决项保持原记录。

## 第三轮 Windows 发现与修复

`2bbf2043` 的 Windows 证据确认104px原生时间框裁切AM/PM，132px完整、恢复104px再次失败，输入值不变。生产CSS、离线预览、布局断言及TechDoc已同步132px；当前不能用之前完整门禁或旧Windows结果覆盖这次生产样式变化，待新候选重新验证。VCC ASAR与小样本已在Windows通过，PF因SSD证据不足保持NOT_RUN。设置验证器增加实际窗口呈现，保留30秒时限和原断言。详细证据及状态见[发布前自审](release-review-2026-09-19.md)。

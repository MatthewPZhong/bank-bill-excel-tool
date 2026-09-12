# v3.2.9 本地集成记录

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

# v3.2.9 发布前自审（2026-09-19）

## 当前结论

六项功能的合同、实现和跨模块交接已独立复审，本轮 Windows 复验新增确认一个 P2：原生 12 小时时间框裁切 AM/PM；132px 修复已实现，最终 Windows 复验待完成。其余功能未发现新的 P0/P1/P2 产品缺陷。已修正文档状态和组合验收夹具漂移；代码审查结论不等于全部发布门禁通过。完整本地门禁 exit 0：单测 7,861 PASS / 0 FAIL / 3 Windows 专用 SKIP，59 个集成脚本全部通过（2,574/2,574）。VCC AC30/RV12 的 Windows、Excel/WPS 和 PF01–PF05 仍有待验项目，当前不能宣布正式发布完成。

## 审查身份与范围

- 已发布基线：`v3.2.8^{commit}` = `2ba9ef14fe972363b604955636cff0c9ac53700f`，本轮 fetch 后 `origin/main` 仍相同。
- 只读审查内容：release `6bd55efe0eb1d90c16cd92f3a78e54a39a36b966` 加已有 18 项外观/记录改动。已逐文件备份 SHA-256，未覆盖其他功能分支改动。
- 版本准备提交：`5001d331bb78bdb82dfaa018ee705b51681bde4f`，收口既有外观修复、版本 3.2.9 和三份发布文档。后续仅追加文档/验证脚本的变动另记录并单独核验；新发现产品问题需重新回到修复与复审。
- 六个源 SHA 均为 release 祖先；同时核对实际接口、代码和集成测试，未只按分支包含关系判断。

| 功能 | 合同 | 源提交 / 合并提交 |
|---|---|---|
| 业务 OP 自动错误报告 | [Spec](codex/v3.2.9-biz-op-error-report-auto-save/Spec-v3.2.9-biz-op-error-report-auto-save.md) / [TechDoc](codex/v3.2.9-biz-op-error-report-auto-save/TechDoc-v3.2.9-biz-op-error-report-auto-save.md) | `3efe5c78` / `896fe12d` |
| 存档模块保留期限 | [Spec](codex/v3.2.9-archive-retention-by-module/spec.md) / [TechDoc](codex/v3.2.9-archive-retention-by-module/techdoc.md) | `a2bd6e81` / `e1c31139` |
| 定时深色模式 | [Spec](codex/v3.2.9-night-mode/spec.md) / [TechDoc](codex/v3.2.9-night-mode/techdoc.md) | `654ba97a` / `e134cf4e` |
| 存档永久删除 | [Spec](codex/v3.2.9-archive-center-permanent-delete/spec.md) / [TechDoc](codex/v3.2.9-archive-center-permanent-delete/techdoc.md) | `b78cf3a5` / `d3ebded6` |
| 工具箱按行拆分 | [Spec](codex/v3.2.9-toolbox-split-by-rows/spec.md) / [TechDoc](codex/v3.2.9-toolbox-split-by-rows/techdoc.md) | `c03eeb4f` / `0b36ecb6` |
| VCC 多 Sheet 与待确认导出 | [Spec](codex/v3.2.9-vcc-fin-op-multisheet-review-export/v3.2.9_VCC_Spec.md) / [TechDoc](codex/v3.2.9-vcc-fin-op-multisheet-review-export/v3.2.9_VCC_TechDoc.md) | `069e340c` / `6bd55efe` |

仓库整理 `codex/repository-organization@fd18667a` 经 `07392111` 纳入，含通用规则/Skill 和规范目录；不是第七项业务功能。账户映射设计稿、未提交的 fund-recon-background/template-manager/toolbox-ui 不进入本轮。

## Findings 与闭环

| 项目 | 结果 |
|---|---|
| 存档删除 Spec/TechDoc 的 `release/3.2.9` 和“未实施”状态漂移（P3） | 改为实际 `release/v3.2.9`，引用现有实施证据，保留平台 NOT_RUN；不更改删除授权或验收合同。 |
| 设置组合脚本仍使用删除预检引入前的 API 夹具（验证缺口） | 首次 5/6 PASS、行为组等待确认框超时；确认缺少 `prepareDeleteBatch` 与清理列表接口。补齐受控 token/完整结果后 6/6 PASS，主题与期限交错保存 4/4、73 断言 PASS。无生产逻辑改动。 |
| 真实 Main 验证脚本在 DOM 更新后截到旧画面（验证缺口） | 增加实际呈现帧订阅与 DOM/像素核对，旧图负例被拒绝、新图通过；隔离路径及真实 3.2.9 版本均检查。未修改产品代码。 |
| 用户指南仍有 v2 当前终态、解归档“未处理”、rows 字段模式条件及报告范围描述（P3） | 按对应 Spec 修正：当前终态 v3、结果“待确认”与数据集状态分离、字段步骤加条件、报告限真实失败导入的可用诊断。保留历史说明。 |
| 上轮 VCC FilePlan 初次 metadata 绑定阻断 | 当前 merge 已修复；本轮真实 Main handler→Service→Worker→Archive 再次通过，冻结身份未被改写。 |

本轮只补充已授权发布所需文档和验证，不把“无 P2”当作人工验收签字。

Windows 首次专项发现验证器的 24 小时按键假设与原生 12 小时输入不符（14/16）。原始事件证明控件先产生 `13:30` / `14:00`，应用随后保存相同值，未见生产输入被回包覆盖。已调整夹具，保留严格主题切换和关闭后新值持久化断言，本机 16/16 通过；新候选 Windows 复验待运行。详情见 [release.md](release.md#当前候选的-windows-ci-续做)，失败证据保留。

第二轮 Windows 已确认原生输入 16/16、真实 Main 启动/重载 22 断言通过；随后发现设置验证的隐藏窗口超时与两个 VCC 验证器的 Electron 启动环境问题。修正已在本机通过，Windows 待复验。另从真实截图发现 **104px 原生时间框疑似裁切 AM/PM（潜在 P2）**；既有 DOM 检查没有覆盖内部字段，正在补几何证据，未将这一疑点记为已关闭。见 [第二轮证据](self-review-2026-09-19/windows-round2-summary.json)。

## 本次实测与边界

| 检查 | 当前结果与边界 |
|---|---|
| 存档/期限独立跨层探针 | 6/6 PASS；含调用者 token、同内容换 inode、只读副本、共享 Blob 新引用、持久计划重开及维护 owner token。真实 SQLite/文件，受控故障注入。 |
| VCC 实际 Main 导入链 | 混合三 Sheet 原件→两类来源→两份业务 hold→重开恢复→单类型释放 PASS，外部文件不变。窗口/文件对话框为夹具。 |
| rows 独立整数探针 | 7,031 组、3,509,509 个范围、19 组超限拒绝 PASS；完整 1000 项结果 167,088 B。只证明规划/预算，不替代实际工作簿容量。 |
| 外观原生键盘 | 16/16 场景 PASS；真实 Electron 36.9.5 time 控件/CDP 键鼠，包含慢保存、失败、关闭前后合法/非法草稿。 |
| 日夜界面矩阵 | 15 组、30 个主题、2,760 断言 PASS；1080×760、1240×860、2560×1440，各 DPR 及 125%/150% 网页缩放。隐藏窗口/业务 API 夹具，不等于物理显示器。 |
| 真实 Main 冷启动/重载 | 最终 3.2.9 两场景 2/2、22 断言 PASS，临时 userData/Documents、真实启动准入及单实例锁。六张实际呈现帧覆盖两种冷启动、重载和设置；逐点核对截图与 DOM。未连续采样全过程，不证明首帧或无闪白。 |
| 完整本地门禁 | `UNIT_TEST_CONCURRENCY=2 npm run release-check` exit 0，Node 24.13.0，基于 `5001d331`；499 个单测文件，7,861 PASS / 0 FAIL / 3 SKIP；59 个集成脚本全部通过，2,574/2,574。含原门槛 toolbox RSS 31/31；自动集成清单由 runner 生成。 |
| 最终候选内容覆盖 | 1,521 个原门禁输入中只有两份独立 GUI 验证脚本变化，已分别实跑通过并重新 lint；生产代码、依赖、单测与集成输入全部一致。新增 PF 三脚本单独语法/lint、真实小导出和停写取消通过。最终提交另由 Windows CI 验证。 |
| 新增 PF runner 的本机核验 | 小导出 19 Sheet/40 附页行 PASS；10,000 Pending 停写取消 PASS、39 ms 收口、forced=false、清理 PASS。macOS Windows 前置核验正常 exit 2 且未生成大样本。上述均不计 PF01–PF05 正式验收；真正 drain 等待仍 NOT_RUN。 |
| Windows/Excel/WPS/完整性能验收 | 尚未通过；不能将本地组件百万行测量、模拟对话框或 XML 回读升级为正式平台/人工 PASS。 |

详细需求矩阵：[存档/期限](self-review-2026-09-19/archive.md)、[BizOP/rows](self-review-2026-09-19/bizop-toolbox.md)、[VCC](self-review-2026-09-19/vcc.md)。结构化身份与结果：[evidence-summary.json](self-review-2026-09-19/evidence-summary.json)。原始日志保留在 `/private/tmp/v329-release-20260919-3_bafjvz/`；正式 CI/候选 SHA 及后续发布状态见 [release.md](release.md)。

## 发布前未完成项

- 取得对应最终内容的 Windows 必需检查、构建和候选安装包证据；本地完整门禁已通过。
- 按 VCC AC30/RV12、TechDoc §12.4 完成真实 Windows、Excel/WPS、PF01–PF05。Worker 使用同 PID 的 worker_threads，全进程 RSS 不能伪装成独立线程 RSS 或重复相加；观测缺口需明确记录，不能伪造符合原合同。
- Windows 原生另存/覆盖/占用、存档删除重启/离线介质、实际物理显示器及真实业务内容按适用合同验收。只使用专用测试数据，用户业务库不参与本轮自动探针。
- 待条件满足后按 weekly-release 完成受保护 PR、最终 main 检查、附注标签、发布资产及本地 main 快进。未完成前保留待验，禁止把文档更新当成验收结果。

- 几何验证器处理 UA 伪属性与固定弹层零高容器后，本机真实 Main 两场景、26 个断言通过，104px / 132px / 恢复 104px 的小时、分钟、文本范围均完整，输入值不变；本机为 24 小时格式，不替代 Windows AM/PM 结果。见 [本机原生内部字段证据](self-review-2026-09-19/native-geometry-macos.json)。Windows 三处 harness 修复已独立逐行复核，原断言和失败出口均保留。


## Windows 原生时间框 P2 修复

候选 `2bbf2043` 的真实 Main 在 Windows/en-US 下显示 `h:mm a`。开始/结束框的 104px 宽度都使 AM/PM 超出 datetime-edit 裁切区并侵入时钟按钮；132px 对照完整，恢复104px再次失败，输入 `18:08` / `19:08` 全程未变。几何取证没有缺项；两张实际呈现截图与逐字段结果见 [第三轮摘要](self-review-2026-09-19/windows-round3-summary.json)。

修复仅将两时间列加宽至132px，保留原生小时制、输入/保存语义和其余尺寸；重生成离线预览时同步带入已合入 release 的现有 CSS。自动回归严格要求正式宽度及恢复后字段完整，并增加1080×760窗口、150%页面缩放下的字段与横向溢出检查；104px历史对照保留为复现证据，不冒充正式结果。当前修复候选尚待新的完整门禁与 Windows 复验。

同轮 VCC Electron/ASAR 与 PF小样本在Windows通过，证明启动环境修复有效；完整 PF因磁盘 MediaType=Unspecified，无法证明SSD而保持NOT_RUN。设置首组仍超时：1次双rAF约2.05秒，11次约21.93秒，26.44秒才进入主题场景。新harness在交互前显示隔离原生测试窗并记录状态/每次双rAF耗时，保留30秒上限及原断言，Windows效果待复验。

本机修复验证：15组尺寸/设备缩放/页面缩放、30个主题场景全部通过；真实Main两场景、38个断言通过，包含1080×760、150%页面缩放的内部字段完整性及无横向溢出；设置6/6、73个交互断言通过。见[修复后本机证据](self-review-2026-09-19/native-time132-repair-macos.json)。Windows及本次生产样式变化后的完整门禁仍待完成。

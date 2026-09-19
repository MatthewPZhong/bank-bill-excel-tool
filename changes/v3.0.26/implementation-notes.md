# Implementation Notes — v3.0.26

## Baseline

- Goal/spec：[`spec.md`](./spec.md)
- Initial plan：用户批准“平盘文案 + 不平结果 FundType + R5 Extra Fee + 删除标题”完整方案。
- Done when：[`test-spec.md`](./test-spec.md) 自动验证完成，资金红线人工复核项明确记录。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
|---|---|---|---|
| `FundType` 插入第 6 列 | 用户明确指定；对应银行原始字段可通过 `rawRow` 追溯 | 追加到末列 | 20 列后续字段整体右移，模板与读取兼容必须同步 |
| C4 同时接受 19/20/21 列 | 旧 4-sheet 与 v3.0.14 后文件仍可能被用户导入 | 只支持新模板 | 读取器按精确白名单契约识别，不放宽任意额外列 |
| 新增 R5 专用金额助手 | 旧 `bankAmountAbs` 被 DBS-Charge 复用 | 原地修改共享函数 | R5 与审计包含手续费，DBS 保持既有结果 |
| 手续费有符号参与且合计不再取绝对值 | 用户批准公式明确 | 对手续费取绝对值或合计后取绝对值 | 负手续费可冲减，合计可为 0 或负数 |
| 负合计不命中任何正/负对手金额 | 网关与调拨对手金额的既有访问器都会取绝对值 | 改变对手金额旧口径 | 仅银行合计保留负号，避免把本次需求扩散到对手侧 |
| 非法手续费候选级跳过并告警 | 不允许静默当 0，同时避免单行脏数据阻断整批 | 整批失败或降级为 0 | 其它合法行可继续运行，异常可观测 |
| DBS 两步显式使用旧比较口径 | PM 复核发现步骤2复用了 R5 `amountEqual` | 只保留旧 `bankAmountAbs` 导出 | 阻止 R5 新口径静默污染 DBS 步骤2 |
| 删除标题固定但成功提示保留表名 | 用户只要求页面标题变更 | 所有删除文案都泛化 | 实际删除目标仍可在成功反馈中审计 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
|---|---|---|---|
| `FundType` 只需要原值，不需要 trim 或推导 | 用户明确要求取对应银行值 | 若业务期望标准化会出现格式差异 | mapper 单测锁定原值；后续需独立需求 |
| R5 继续沿用现有转分规则 | 用户明确选择现有分精度 | 高精度手续费按既有舍入 | 分位边界单测 |
| DBS-Charge 当前不含手续费是本次保护行为 | 用户确认本次只改 R5 | DBS 可能继续漏掉业务上应含手续费的匹配 | 非零 fee 回归锁定；是否调整另行立项 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
|---|---|---|---|---|
| 仅保留旧 `bankAmountAbs` 即可保护 DBS | DBS 步骤2改用显式旧网关/银行比较器 | 步骤2原本直接复用 R5 `amountEqual`，该函数已改为含手续费 | 修复一个未在初始依赖判断中识别的跨引擎污染风险 | 是 |
| 负合计可与负对手金额命中 | 负合计不命中正、负对手金额 | 对手访问器仍固定取绝对值；改变它会扩大本次资金口径 | 修正测试预期，不改变既有对手金额语义 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
|---|---|---|
| 仓库基线 | `main` / package `3.0.25` / tracked clean | 无既有 tracked 改动被覆盖 |
| PM 规格与资金盲区复核 | 发现 DBS 步骤2比较器污染、负合计预期冲突、warning 血缘和模板描述缺口 | 已反向同步 spec/test-spec，并转交 Dev 修复 |
| 分支承接 | `codex/v3.0.26` | 未提交 WIP 已离开 `main` 工作分支，随后形成提交 `99af71a` 并推送 |
| PR 交付 | PR #101 | 用户追加授权后创建；合并前按最终 PR patch 执行 self-review |
| 全部单元测试 | `npm run test:unit` → `3855/3855 PASS` | 本次定向测试与全仓回归均通过 |
| 前置资金输出集成 | `pre-fund-reconciliation-output-contract.js` → `15/15 PASS` | 真实模板 21 列、FundType 血缘、5/6-sheet 与 C4 回读 |
| 多对多输出集成 | `bank-statement-many-to-many-review-sheet.js` → `33/33 PASS` | 含手续费金额不改变只读审计与命中行输出边界 |
| 完整发布门禁 | `npm run release-check` → lint、smoke、3855 单测、43 个集成脚本全部通过；集成 `1978/1978 PASS` | 全仓行为、迁移、流式大文件与发布契约回归 |
| UI 几何与预览 | `verify:main-panel-alignment` → `6/6 PASS`；已回读平盘主页面与链接表删除弹框 preview | 文案、按钮尺寸/样式及双尺寸三档缩放不漂移 |
| 重要变量门禁 | `scan:vars` → 202 文件 / 2329 顶层声明；`check:vars -- --include-minor` 命中 `bankAmountWithExtraFee`，`dialog/elements` 为局部或既有引用 | R5/DBS/多对多资金边界已按 v30 清单逐项复核 |
| 启动性能 | `startup:measure` 5 次：总耗时平均 778.135ms，ready-to-show 平均 171.222ms | 低于日常启动门槛，无可见启动回退 |
| Team-lead 最终 review | 代码、测试、模板、spec、版本文档、重要变量与 PR #101 最终 patch 三层复核，无新增 P0-P4 Finding | 自动化范围内可合并；未替代下述人工资金和 Windows 实机验收 |
| PR #101 合并 | merge commit `fa416aa` | 2026-07-25 合入 `main`；远程与本地开发分支已删除 |
| 合并后 `npm ci` + `release-check` | PASS | unit `3855/3855`、43 个 integration 脚本 `1978/1978`，lint 与 smoke 全绿 |
| 发布前主页面布局 | `6/6 PASS` | 两种窗口尺寸 × Windows 100%/125%/150%，单行、多行和控件垂直中心误差均低于 `0.004px` |
| 发布前启动性能 | PASS | 5 次建窗到可见平均 `102.107ms`，ready-to-show 平均 `173.357ms` |
| 发布前变量硬节点 | PASS | `scan:vars` 为 202/2329；`check:vars -- --include-minor` 因 `src` 无新改动安全跳过 |
| 生产依赖审计 | 9 条 advisory | 2 moderate、7 high、0 critical；相对 v3.0.25 未改依赖图，新增计数来自 advisory 数据更新，保留为安全治理 follow-up |
| 发布仓库门控 | PASS | GitHub 仓库为 PUBLIC；`v3.0.26` tag 与 Release 均不存在 |
| annotated tag | `v3.0.26` → `f229c2c` | annotated tag object `5cbd4b4`，peeled commit 精确指向已推送 `main` 的发布准备提交 |
| Windows Release workflow | run `30156308464` PASS | 17m21s；远端 release-check、几何、构建、包检查、更新资产校验及发布后验证全部通过 |
| GitHub Release | `v3.0.26` latest | 非 draft、非 prerelease；Setup、blockmap、portable、`latest.yml` 四资产 uploaded |
| 公开更新资产回读 | PASS | `latest.yml` SHA-256 `07f3af5...ec1e5` 与元数据一致；Setup/portable 匿名 Range 均为 HTTP 206，文件头均为 `MZ` |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 交付影响 |
|---|---|---|---|
| 真实正负手续费与两种 R5 来源 | PROBE | 使用真实或脱敏样本逐笔人工复核 | ⚠️ 资金红线；自动测试不能替代 |
| Windows Excel/WPS 模板显示 | PROBE | Windows 实机打开新 21 列结果 | 不阻断代码完成，但不得宣称实机已验收 |
| Windows 生产升级 canary | BLOCK-ANNOUNCEMENT | 使用 v3.0.25 安装版验证 v3.0.26 在线升级、SmartScreen 与用户数据保留 | 不阻断技术发布，但阻断发布公告 |
| 生产依赖安全升级 | FOLLOW-UP | 单独升级并回归 `electron-updater`、`marked` 等可修复 advisory | 不在发布收尾中静默改变依赖；当前公开 GitHub updater 不携带私有仓库凭据 |
| GitHub 发布保护 | FOLLOW-UP | 为 `production-release`、`main` 和 `v*` tag 配置服务端保护 | 当前 environment 无 protection rules、`main` 未保护，发布事实有效但审批治理不足 |
| `check:dist` 版本核验 | FOLLOW-UP | 增加 asar 内 `package.json.version` 与仓库版本一致性断言 | hosted runner 先干净构建，故不影响本次资产；单独运行 `check:dist` 仍可能误验旧本地产物 |

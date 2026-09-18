# 实施记录

> **当前状态：已撤回代码改动。** 用户随后明确要求“不要动代码”；本轮源代码、测试及三份产品文档已恢复到修改前状态，VCC 开关已恢复关闭。本目录保留此前检查与短暂试验的历史证据，不能解读为当前配置已开启。完整 release-check 发现两项失败后按用户要求停止（退出码 130），没有完整 PASS，也没有完成修复或重新验收。

## Baseline

见 [spec.md](spec.md)。基线 `f75e76d140c4019980c5387e715ab9a99f9e8ffe`，Node 24.13.0 / macOS。

## Decisions

- 按用户指定的三个模块检查，并仅开启实际入口、数据来源与输出合同已经接通的动作。
- 首批限于 VCC `export-audit`，覆盖数据管理导出与导入异常审计；资金对账、Statement、VCC 结果导出的接线缺口保留可审阅证据。
- 仅修改现有生产策略，保留单 Worker / 256 MiB 阶段预算、baseline / probe 证据标签及空 benchmark；不修改历史冻结的 release evidence，不将用户授权记为测试 PASS。
- 既有未跟踪文件保留；不修改真实数据库，不启动或关闭用户 Electron。

## Deviations

- 初步根据 VCC capability 判断三项导出可继续启用；追到真实 Main 后发现结果导出没有调用受管 dispatcher，且 dispatcher 固定 `production:false`。已在编辑生产代码前同步 spec，并向用户说明首批范围。
- 资金对账 policy 的 `maxArtifacts=1` 最初被误读为单 Excel 输出限制；继续追到 `artifact-generator.generate` 后确认该 artifact 是包含多输出和退款 marker 的 manifest。已修正 spec：真正缺口是 Main 消费/发布/结算接线，不需要更改现有多输出合同。

## Evidence

- 已只读重建当前 Runtime / Manifest：66 个动作、48 个已注册策略、12 个启用；本次前已跟踪工作区无改动。
- 新增三项 production:true 验证先在关闭配置下执行，0 PASS / 3 FAIL，均为 POLICY_PRODUCTION_DISABLED；启用后 3 PASS / 0 FAIL，真实 native Worker 和默认 durable Publisher 在临时目录完成输出，三种变体 Workbook 与原路径相同、业务表快照相同。Archive handoff 回调在专项中为观察桩，真实二启恢复另由既有 output-recovery 专项覆盖。
- 三模块平台专项（8 个测试文件）147 PASS / 0 FAIL / 0 SKIP，退出码 0；包含 VCC 实际 Publisher 硬退出后的二启存档恢复、来源/产物拒绝、串行互斥，以及资金对账 artifact/runtime 和 Statement service。
- Electron 36.9.5 / Node 22.19.0 以 Node 模式运行相同三项生产请求，3 PASS / 0 FAIL / 0 SKIP。没有启动真实 Main 或用户界面。
- 当前独立 Manifest/strategy 验证 396/396，通过；启用动作由 12 增至 13，仅新增 VCC export-audit。
- 完整 release-check 执行中。

## Remaining Unknowns

- 资金对账需接 Main 会话及多文件发布；Statement 需接应用 Registry、交互和发布；VCC 结果导出需接 Main authority 与真实 production 请求。
- Windows packaged、实际用户导出、Excel/WPS 和目标规模均未执行；源码配置启用不等于正在运行的应用已切换。

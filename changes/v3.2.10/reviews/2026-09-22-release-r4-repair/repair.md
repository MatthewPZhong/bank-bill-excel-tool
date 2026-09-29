# v3.2.10 第四轮 G8 审查修复

依据：[第四轮独立审查](../2026-09-22-release-rereview-r4/review.md)。RR4-01～03 已实现修复：工厂组合保持对象身份，不同静态调用创建的实例不再混淆，G1 已解释的原生回调入口进入授权检查。新增 33 项回归全部通过；全部架构 270/270 PASS，正式 CLI 31 active、0 诊断、0 stale。完整 release-check 已在最终冻结的 1701 个输入上重新运行并通过：9044 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过。本报告是修复记录及自检，修复后的独立复审未执行。

## 对象、范围与契约

- 工作区：`tmp/worktrees/release-v3.2.10`；分支 `release/v3.2.10`，HEAD `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加前三轮未提交修复。
- 修改前冻结 4188 个已有文件，保存 [SHA-256 清单](input-manifest.json)、[原有 tracked 差异](input-diff.patch)及 10 个计划修改文件的 before/ 字节副本。
- 对应 G8-AC-05 / TechDoc §4.4、G8-AC-16 / §4.7。机器边界、例外、schema、Spec、生产 src 及业务输出合同保持；没有通过扩大授权集合消除诊断。
- 本轮修改 4 个检查器、新增一个回归文件，并更新现行说明和修复证据；集成策略表由正式集成 runner 在全通过后自动更新。
- 所有修复仍未提交，没有推送、PR、升版、标签或发布。

## 逐项修复

| 项目 | 实现 | 正反例 |
| --- | --- | --- |
| RR4-01 工厂组合丢失同一对象 | 身份值与能力值共用静态 bind、成员选择、返回和实参解析；嵌套属性按需取得身份，同一结果的别名写入和 helper 逃逸继续检查。 | bound、多层 bind、嵌套成员、解构、Object.assign、包装工厂均有 VM 证据和拒绝断言。原 20 个 Renderer 边界探针另行复验。 |
| RR4-02 不同工厂实例混淆 | 新分配对象以源文件、分配 AST 位置、函数 AST 身份及可解释调用上下文区分。返回外部共享对象时保留原分配身份，不附加新的工厂实例身份。 | 不同普通/绑定调用、嵌套成员、包装工厂、闭包和 spread 副本保持合法；真实共享返回对象、共享嵌套成员和共享闭包被修改后仍拒绝。原独立多实例反例恢复为 0 诊断。 |
| RR4-03 原生回调漏记受限入口 | executionScopes 暴露与闭包扩展一致的 callbackTargets；G1 对显式目标和已纳入闭包的回调目标在原调用位置匹配受限恢复函数。准确 allowedSites 仍是停止点。 | reduce/reduceRight/map/forEach、容器/返回/参数转发回调均拒绝。未执行的 helper 参数、未选择成员、普通同名函数、安全迭代及准确授权对照保持。真实源码副本的 reduce 在 prepare 处报恢复入口违规。 |

另外补了两个条件别名对照：候选对象形状不同不能使可能共享身份消失。第一版中这两项仍漏报，现已保留候选身份并通过测试。它们属于同一对象身份修复范围。

源码：[Renderer](../../../../scripts/architecture/renderer-contracts.js)、[scanner](../../../../scripts/architecture/scan.js)、[执行闭包](../../../../scripts/architecture/contracts.js)、[G1 规则](../../../../scripts/architecture/rules.js)；[新增回归](../../../../tests/unit/architecture/release-rereview-r4.test.js)。callStart 只用于内部 AST 来源标识，不改变配置格式或 CLI 接口。

## 验证

| 验证 | 当前结果 |
| --- | --- |
| 最终 33 项回归对修复前版本 | **21 FAIL / 12 PASS**。使用 before/ 恢复 4 个检查器并补未改 schema，5 个文件逐一匹配起点 SHA；测试运行在独立临时目录。[输入核对](regressions-before-inputs.json)、[日志](regressions-before-final.log) |
| RR2–RR4 回归 | **100/100 PASS**（34 + 33 + 33），与全部架构数量重叠，不相加。[日志](regressions-after.log) |
| 全部架构专项 | **270/270 PASS**，0 fail/skip。[日志](architecture-tests.log) |
| 正式架构 CLI | **31 active、0 pending/partial、0 诊断、0 stale**；765/765 解析。[JSON](architecture-check.json)、[日志](architecture-cli.log) |
| 检查器及新测试 lint | 5 个文件 no-undef：0 errors/warnings。[结果](tool-lint.json) |
| 完整 release-check | **PASS**；2026-09-22 11:43:25–12:00:05（Asia/Shanghai），UNIT_TEST_CONCURRENCY=2 npm run release-check。[输入](gate-input-manifest.json)、[日志](release-check.log)、[结果](release-check-result.json) |
| 全量单测 | **9044 PASS、0 FAIL、4 项 Windows 条件跳过**；9048 total、828 suites。 |
| 全量集成 | **68/68 脚本 PASS**；有计数用例 2901/2901，另 1 个脚本无用例计数。Renderer lifecycle 233/233。[验证汇总](verification.json) |

首轮 2026-09-22 11:16:41–11:42:32 的完整门禁 exit 1：lint、架构、smoke、9044 项单测通过（4 项 Windows 条件跳过），67/68 集成脚本通过；renderer-lifecycle 在沙箱内启动 264ms 后 SIGABRT，没有输出断言。源码及 HEAD 未漂移。[首轮日志](sandbox-gate/release-check.log)、[首轮结果](sandbox-gate/release-check-result.json)、[原生崩溃摘要](electron-startup-failure.json)。

同一隔离 Electron 脚本在沙箱外 233/233 PASS，证据指向 macOS 原生启动环境差异；未改测试、未跳过断言。[复验日志](renderer-lifecycle-unsandboxed.log)、[复验记录](electron-retry.json)。随后对同一候选在沙箱外完整重跑，单测并发为 2；单项补跑不替代完整门禁。

原始探针分别保留：

- [Renderer 实际配置复验](renderer-realconfig-after.json)：原脚本不变，在内存追加反例，只扫描与执行 VM stub，不改生产文件。
- [不同实例复验](separate-instances-after.jsonl)：真实 clean 仅有 read，静态诊断为 0。
- [G1 原生回调与安全对照](g1-neighbors-after.json)：内存恢复 stub 证明执行次数；既有安全路径保持。
- [G1 真实源码静态探针](g1-real-source-after.json)：仅选实际 active G1 boundary，复制生产源码后增加 reduce 入口并静态扫描，诊断落在 prepare 调用位置。没有执行真实恢复 IO，不把它写成完整 31 边界 mutant 扫描。

[探针逐项断言汇总](probe-verification.json)确认违规路径拒绝及安全对照通过。探针 exit 0 只表示取证完成；违规路径必须产生诊断，合法对照必须保持无诊断。

## 性能处理、自检与边界

沿用 implementation-notes / blindspot-pass。初版身份比较在真实配置中重复展开大型对象并扫描全仓调用列表，相关运行已主动中止，未记作 PASS。CPU 采样定位后，成员身份改为按需解析，参数来源和成员写入按当前 analysis 缓存。最终正式 CLI 完成约 70 秒、全部架构约 108 秒；这属于本机观察，不是平台性能保证。保留[采样汇总](profile-summary.log)及[实施记录](implementation-notes.md)。最早的授权夹具 callee 为空仅是测试草稿问题，修正后的前后结果见上表。

已验证的不变量：同一可解析对象的别名修改不能丢失；同一工厂的不同静态调用不能因返回字面量相同而混淆；真正的共享对象不因调用次数被错误拆开；已进入执行闭包的受限回调必须在入口位置检查授权。新增回归与生产配置共同核验，配置允许集合未放宽。

本轮不证明任意运行时 this、反射、同一调用点的任意动态重复实例或跨文件动态对象身份。原生/注入执行器的直接回调仍沿用“可能执行”的保守闭包策略；源码可解析 helper 则沿实际调用传播。未以零诊断或 active 数量声称 G8 全部防倒退合同已通过。

本轮修复后的独立复审尚未执行。真实产品 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收不由这些静态探针、VM stub 或自动门禁代替。

## 保护与回退

最终核对确认：1701 个门禁输入及 HEAD 均未漂移；起始 4188 个已有文件中，仅计划内 10 个检查器/说明/集成策略文件变化。792 个业务 src 文件、216 个既有审查/修复证据、2 个架构机器 JSON 及主工作区 865 个已有 dirty 文件均保持；另新增本轮回归和证据。[最终保护证据](preservation-final.json)、[交付核对](delivery-check.json)。

[本轮增量补丁](incremental.patch)按起始 dirty 状态生成，保留前三轮修复，反向应用预检通过；回退只应针对本轮增量，不能整体撤销已有未提交差异。before/ 保存 10 个计划修改文件的原始内容。

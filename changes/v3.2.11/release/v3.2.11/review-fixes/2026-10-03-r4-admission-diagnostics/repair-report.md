# release/v3.2.11 第四轮准入诊断修复

## 结论与基线

基线：`release/v3.2.11@fb5d4bad55f9c41070ef6da9e3a302a13351a4a2`。确认并修复资源准入原因和候选额度丢失的 P2；聚焦和专项通过，发布门禁检查项目已分段完成，本项 P2 修复完成。

## 复现与实现

生产策略 → Governor → Supervisor → SafeError → rows service → Main 错误结果链中，普通档 768 MiB 超过固定 512 MiB 时，修复前最终提示将静态 1024 MiB 标成申请资源，附加“释放内存后重新启动应用”。本轮隔离复现与用户报告一致。

1. Governor 的 simple job 预检补回适用内存上限，正确区分固定 H 与兼容 Bcompat。
2. Supervisor 保留白名单枚举与数值，在协议编码前生成原因、实际候选、适用上限和明确的兼容建议；静态五维向量改标为“静态资源基线”。不携带 owner、源路径或业务载荷。
3. SafeErrorV1 仍为 code/message/stage/detailLines 四字段。协议后直接展示 detailLines；下游不解析提示文字推测类型，也不依赖被协议舍弃的 Error.details。
4. rows 对原因缺失或未知使用中性资源不足说明，只有明确兼容预算不足才给对应重启建议。固定额度、执行配置、资格、读取算法和前三轮修复均保持原值。

## 最终错误检查

| 场景 | 修复后 |
| --- | --- |
| 只剩 768 MiB 普通档，固定上限 512 MiB | 明确固定上限原因、候选 768、上限 512；无重启或兼容预算建议 |
| 768／384 MiB 两档都超过固定 256 MiB | 保留两个候选及 256 MiB 上限；无重启建议 |
| pending 兼容：固定上限 2048 MiB、Bcompat 512 MiB、旧需求 1024 MiB | 明确启动兼容预算 512 与固定总预算 2048；保留释放内存后重启建议 |
| 原因缺失、未知枚举、文案含 compatibility | 中性说明，不从文案推断兼容预算，不补重启建议 |

Renderer 静态调用链核对：`src/renderer/dialogs/toolbox.js` 的 `submitSplit()` 将结果的 detailLines 交给 `showToolboxAlert()`，后者逐行转义后交给公共提示框；此项不作为实际桌面 GUI 验收。

新增集成以真实运行时返回的 SafeError 驱动 service，再调用 Main 的实际 toolboxFailureResult；明确断言 Error.details 已被协议移除。固定拒绝均零 Worker、零 Publisher、零授予租约，原件和原有输出文件不变。

## 验证

- 聚焦单测：36/36 PASS（Supervisor 诊断、rows 错误映射、SafeError codec）。
- 新增准入诊断集成：3/3 PASS。
- 发布门禁项目：全部通过；完整命令在集成阶段中断，保持冻结输入后续跑完整集成阶段。单测 9593 PASS / 0 FAIL / 4 Windows SKIP；集成 82/82 PASS。

`UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-10-03T16:17:41.672671+08:00 开始；已完成 lint、架构 788/788（42 个历史提交）、smoke 和单测 9593 PASS / 0 FAIL / 4 Windows SKIP，集成阶段随会话中断，未取得这次完整命令的退出码。复核 1783 个冻结输入完全一致后，于 2026-10-03T16:43:33.002190+08:00 至 2026-10-03T16:54:31.217837+08:00 用正式 `npm run test:integration` 续跑整个集成阶段，耗时 658.22 秒，退出码 0，82/82 脚本（3101 项计数检查）通过。所有门禁检查项目已完成；保留原始中断日志及续跑日志，不将分段完成写成一次完整命令退出成功。期间仅 runner 自动生成的集成清单变化，规则正文与其余输入摘要一致。

机器可读记录见 [validation-result.json](validation-result.json)，提示对照见 [修复前](before-result.json)／[修复后](after-result.json)。

复跑：`node scripts/integration/toolbox-rows-admission-diagnostics.js`；`UNIT_TEST_CONCURRENCY=2 npm run release-check`。

## 验证边界

实际平台为 macOS／Node。Windows x64／Electron 身份、可用内存、原生对话框及冻结源计数使用受控夹具；本轮验证错误返回链，不将固定拒绝用例记为完整生成或发布成功。没有重新执行 Windows 实机压力、安装包、Excel/WPS 或完整 GUI 人工验收。原始日志位于主检出 `outputs/release-v3.2.11/2026-10-03-r4-admission-diagnostics/`。

# release/v3.2.11 CSV 扫描档位适用性修复

## 结论与基线

已实现 CSV reader 创建前的低档适用性限制，并补齐真实读取量、源身份及单对象容量保护。聚焦单测、生产链路专项、65 MiB 兼容样本及最终完整 `release-check` 均通过，原 CSV 准入 P2 已关闭。

修复基线为 `release/v3.2.11@72c80bab465ca36fb098ac4271a8ea1de782c880`。原始独立复现见 [before-result.json](before-result.json)：有效 CSV 含 900,000 个数据行、8 列、14,400,016 字节。在 Main IPC／生产策略／Governor／真实 Worker 链路中，低档 OOM，普通档成功。

## 修复后的行为

| 输入与资源条件 | 行为 |
| --- | --- |
| 真实 CSV 不超过 256 KiB，且低档资源满足 | 保留低档；实际读取量受同一上限约束。 |
| 真实 CSV 超过 256 KiB | 不参与低档候选，普通档仍可经 Governor 获批。 |
| 适用的普通档暂时缺少资源 | 原请求继续有界等待；超时返回中文资源提示，不创建解析 Worker。 |
| 适用普通档超过固定硬额度 | 立即返回 RESOURCE_BUDGET_UNAVAILABLE，不用不适用的低档顶替。 |
| 无已获资格的适用候选 | 在排队和创建 reader 前返回 RESOURCE_MEMORY_PROFILE_UNAVAILABLE。 |
| 排队／开读前来源身份变化 | 返回 TOOLBOX_SPLIT_READ_CONTEXT_STALE，重新选择源文件。 |
| 低档实际读入超过上限或单行对象超预算 | 返回 EXECUTION_INPUT_PROFILE_UNSUITABLE，先于完整文本解析或格式化 cell 分配。 |

256 KiB 是本轮整表 CSV reader 的保守低档容量范围，**不是 CSV 的统一支持大小上限**。更大 CSV 保留普通档机会；65 MiB 公共扫描和按字段补扫真实 Worker 回归通过，rows 专属 64 MiB 限制继续只拒绝 rows。内容为 XLSX 的 .csv 文件按 magic 识别，保留流式 XLSX 低档。

## 实现与责任

- `toolbox-split-read-owner` 按真实格式与既有 source snapshot 判断适用性。Main 只读格式头和文件属性，不在准入前解析整个文件。metadata 与字段补扫共用判定；Renderer 的额外资源参数仍被拒绝。
- `admission-only-owner` 接受 Main 静态同步判定；Governor phase 请求的布尔 allowLowMemory 只收窄候选。策略资格、额度、采样、安全余量、互斥和真实退出屏障继续独立执行。
- 获批后再次核验 source snapshot；同一快照和格式事实传给 Worker。Worker 开读前复核来源，格式 facade 要求实际格式匹配 Main 判断。
- 低档 CSV 使用固定上限的 fd 读取，最多读取上限加一个哨兵字节；超限在 Buffer 转文本和整表解析前拒绝。stat 后的增长不能使读取无界。空表不进入旧的二次无界读取；二进制类型变化不回退到整表 Excel reader。
- 极宽行在创建带样式的 cell 之前按结构与文本计入现有 maxSingleRecordBytes，超过预算受控失败；普通档和兼容 CSV 的原有解析语义保留。
- 没有 OOM 后扩大堆重试。现有生产 qualified 清单、profileId、policyDigest、阶段预算与 Worker limits 均未修改。

## 验证

| 检查 | 结果 |
| --- | --- |
| CSV、扫描 owner、准备 owner、内存策略聚焦单测 | 43/43 PASS |
| Governor、continuation、dispatch、格式入口及 Worker 单测 | 80/80 PASS |
| 新生产 CSV 准入与容量专项 | 17/17 PASS |
| 65 MiB 公共／字段扫描与 rows 拒绝 | 4/4 PASS |
| lint | PASS |
| 架构 | 788/788 文件、40 个历史提交，PASS |
| 完整 release-check | PASS，退出码 0；单测 9582 PASS / 0 FAIL / 4 Windows SKIP；集成 80/80 脚本、3085 项计数检查 |

17 项专项使用真实 Main IPC 函数、当前生产策略、Governor 和真实 Worker，覆盖原始 90 万行样本、等待／超时／固定配额拒绝、metadata／字段补扫、pending 零预算兼容、边界两侧、密集短行／空行／引号／无效 UTF-8、极宽行、真实格式识别、文件增长／身份变化及取消。每项检查 owner、租约、队列、载体观察和临时目录收口。

最终完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-10-03T00:43:27.805179+08:00 至 2026-10-03T01:05:39.208215+08:00 执行，耗时 1331.4 秒。冻结 1780 个代码、测试和配置输入，结束后核对全部摘要；仅 runner 自动生成的集成测试清单变化，规则正文保持原字节内容。最终源码未在门禁后修改。机器可读结果与文件摘要见 [validation-result.json](validation-result.json)。

此前一轮完整门禁也已通过；随后只将新增参数错误提示统一为中文，故重新对最终源码执行完整命令。首轮日志保存在原始证据目录的 `first-pass/`，不与最终运行混记。

## 证据与复跑

```sh
node scripts/integration/toolbox-csv-admission.js
node scripts/integration/toolbox-split-csv-scope.js
UNIT_TEST_CONCURRENCY=2 npm run release-check
```

原始日志和冻结输入摘要位于主检出目录 `outputs/release-v3.2.11/2026-10-03-csv-admission-repair/`。首次专项运行中，夹具错误要求未创建的扫描目录必须存在；已改为断言无残留，不修改产品清理规则，随后专项通过。

## 验证边界

- 实际 Worker 和文件 IO 在 macOS / Node v25.8.0 执行。生产准入测试的 Windows x64 / Electron 36.9.5 身份及可用内存为夹具，实际使用当前 qualified 清单。
- 本轮未重新执行 Windows 原生文件锁／压力、安装包、Excel/WPS 或完整 GUI 人工验收；不扩大此前用户确认的人工验收范围。
- 本报告记录提交前验证内容；提交后的状态与远端 SHA 以最终交付记录为准。

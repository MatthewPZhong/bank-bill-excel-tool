# release/v3.2.11：BIFF8 低内存适用性修复

## 结论

已修复 `15e44b0f` 审查确认的 P2，并覆盖字段补扫及正式 rows 生成中的同类条件。当前 BIFF8 解析会在逐行消费前物化完整 overlay、workbook 和 projection；现有实现没有可证明这些分配安全的低档读取合同，因此 BIFF8 仅保留普通档候选。普通档资源不足时继续有界等待或按固定上限拒绝。

实际低档 reader 同时设置防御：误将 BIFF8 交给低档 Worker 时，在上述分配前返回 `EXECUTION_INPUT_PROFILE_UNSUITABLE`。生产 `qualified` 人工确认清单、所有档位额度、CSV 已验证低档边界、流式 XLSX 及 rows 专属源预算保持现有合同。

目标分支：`release/v3.2.11`；修复前提交：`15e44b0ffaa304790f6821771791eacf085072b9`。本报告与修复代码随同一后续提交交付。

## 修改与调用链

1. `toolbox-input-kind.js` 提供统一的低档适用性判断：按实际 magic 的 XLS 不适用；XLSX 保留流式低档；CSV 继续依据冻结来源大小判断 256 KiB 边界。
2. `toolbox-split-read-owner.js` 在 metadata 和字段补扫各次准入前消费判断；`toolbox-row-split/service.js` 在正式生成前重新消费判断。`allowLowMemory: false` 只删除低档候选，普通档继续由 Governor 的固定预算、实时采样及活动覆盖决定。
3. `execution-memory-options.js` 将两个低档阶段的 CSV 读取上限与 BIFF8 拒绝选项统一装配。`toolbox-format-io.js` 把配置传至 BIFF8 pass，`biff8-pass.js` 在首次整表读取前拒绝。两个 Worker 调用方移除重复的 CSV 配置片段，继续校验实际输入类型和来源身份。

没有为 BIFF8 增加未经验证的磁盘大小门槛；小 BIFF8 同样使用普通档。不将 rows 的 64 MiB 限制应用于公共扫描，也不自动转换输入或 OOM 后提高堆重试。

## 修复前后同样本复现

样本是合法 BIFF8，20,000 数据行 × 8 列，2,906,624 字节，保存为 `input.csv`。前后样本 SHA-256 相同；真实 Main handler、生产策略、Governor 和 Node Worker 运行在 macOS arm64 / Node 24.13.0，Windows/Electron 身份与可用内存读数由夹具注入。

| 条件 | 修复前 | 修复后 |
| --- | --- | --- |
| 可用内存 512 MiB | 创建 153/8 MiB 堆 Worker，`ERR_WORKER_OUT_OF_MEMORY` | 零 Worker；等待 5 秒后 `ADMISSION_TIMEOUT`，中文资源超时说明 |
| 可用内存 2048 MiB | 普通档 460/8 MiB 堆，正确返回 20,000 行、8 列 | 同一普通档堆配置，正确返回 20,000 行、8 列 |
| 来源与关闭 | 原件摘要未变，载体退出 | 原件摘要未变，载体退出，无残留责任 |

证据：[修复前](before-result.json)、[修复后](after-result.json)、[复跑脚本](reproduce.cjs)。在仓库根执行 `node changes/v3.2.11/release/v3.2.11/review-fixes/2026-10-03-r5-biff8-admission/reproduce.cjs` 会记录当前实现的结果；历史 before 文件只保存修复前观察。

## 自动验证

- 聚焦单测：35/35 PASS，覆盖格式识别、BIFF8 pass、扫描 owner 和 rows 缓存／发布。
- 新专项：`node scripts/integration/toolbox-biff8-admission.js`，15/15 PASS。
- 专项涵盖 512 MiB 扫描超时；`.csv`／`.xls` 的真实 magic；字段补扫内存下降；同一 token 的 rows 768 MiB 等待；恢复后完整 20,000 行缓存、分块写出、产物校验、发布和独立 ExcelJS 回读；固定硬上限；强制低档 metadata／字段／rows 的受控拒绝；关闭取消；来源变化；小 BIFF8 普通档；旧兼容路径。
- 每个夹具结束检查 Worker 真正退出、owner 清理责任完成、队列／lease／活动记录归零、私有目录移除。强制低档三例故意绕过 Main 候选筛选，只证明实际 reader 的防御；不计作 BIFF8 低档成功容量验收。

完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-10-03T17:45:04.590243+08:00 至 2026-10-03T18:08:18.197122+08:00 执行，耗时 1393.61 秒，退出码 0。lint、架构 788/788 （43 个历史提交）、smoke、单测 9595 PASS / 0 FAIL / 4 Windows SKIP、集成 83/83 脚本（3116 项计数检查）全部通过。冻结 1784 个代码／测试／配置输入，期间只有 runner 自动更新集成清单，规则正文与其他输入摘要一致。

机器可读结果及证据摘要见 [validation-result.json](validation-result.json)。完整原始日志保留于主检出的 `outputs/release-v3.2.11/2026-10-03-r5-biff8-admission/`。

## 验证边界

专项和全量测试使用本机运行时；Windows/Electron 身份与可用内存注入不等于 Windows 真压力。归档回执使用隔离 fixture；实际 Publisher、SQLite 缓存、XLSX writer 和独立回读有执行。此次未重跑 Windows 实机、安装包、Excel/WPS 或完整产品 GUI 人工验收，也不撤销或扩大已登记的人工 qualified 结论。

普通档成功证明本样本的工作流正确，不承诺任意大小／形状的 BIFF8 都能在普通档执行。更广泛 BIFF8 流式／有界读取改造不属于本次修复。

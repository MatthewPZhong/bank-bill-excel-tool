# release/v3.2.11 正式 rows CSV 准入修复

## 结论与基线

基线：`release/v3.2.11@87bdb924b58ceddc23a1c262dbddf57ae54cf55f`。已补齐正式 rows 生成阶段的输入适用性及实际 CSV 读取保护；聚焦、跨阶段检查及最终完整 release-check 均通过，本项 P2 已关闭。

[修复前独立复现](before-result.json)使用 1,500,000 个数据行、8 列、24,000,016 字节的合成 CSV。通过实际 Main metadata 入口、同一 token 的 rows 准备与执行、当前生产策略和 Supervisor，在 2048 MiB 可用内存下完成普通档扫描，再降至 768 MiB：正式生成获批 `rows-generation-low-v1`，真实 230/8 MiB Node Worker 返回 `ERR_WORKER_OUT_OF_MEMORY`。已进入真实 SQLite 缓存构建，未进入发布；原件及正式目标无改动，私有目录正常清理。

## 修复行为

1. Main 从 rows 的 FilePlan 获取冻结来源，在每次正式生成前识别真实格式并复核身份。大于 256 KiB 的 CSV 设置 `allowLowMemory:false`，普通档仍可参与准入。Renderer 没有提供该参数的入口。
2. Supervisor 冻结布尔事实；固定总配额预检和 phase 申请执行相同过滤。参数仅支持 simple job，base、rows 验证和后续发布各自的资源合同保持原值。通用平台不引入领域依赖。
3. 缓存 Worker 在计算来源摘要后、打开 reader 前复核身份。rows 低档明确传入 `csvMaxSourceBytes`，由同一 fd 最多读上限加一个哨兵字节；复用文本解析前超限拒绝和单行对象保护。
4. 源文件在等待期间变化时，Worker 在解析前报来源失效。失败、取消、关闭都沿现有真实退出、SQLite 关闭及 Main 私有目录清理处理。

256 KiB 仅用于当前整表 CSV reader 的低档适用性；更大 CSV 保留普通档机会，rows 的 64 MiB 专属源预算没有扩展到公共扫描。生产人工 `qualified`、profile、配置摘要与 Worker limits 未变。预扫描及清理责任的既有修复保留。

## 核心回归结果

| 场景 | 结果 |
| --- | --- |
| 原始 150 万行：普通档 metadata → 同一 token → 768 MiB → 正式 rows | `ADMISSION_TIMEOUT`，中文提示，零生成 Worker、零 Publisher，原件保留，仅计划文件被清理 |
| 20,000 行 CSV 超低档边界：同一 token 排队，内存恢复至 2048 MiB | 普通档 460/8 MiB Worker 完成 SQLite 缓存、分块输出、验证、真实 Publisher、归档回执夹具及独立逐行回读 |
| 262143／262144／262145 字节 | 前两项低档完整成功；后一项等待后使用普通档成功 |
| 256 KiB 密集单列 131,071 行 | 真实 230/8 MiB Worker 低档完整成功，两个输出逐行回读一致 |
| 普通档超出固定硬额度 | `RESOURCE_BUDGET_UNAVAILABLE`，不启动生成 Worker，不用不适用低档顶替 |
| 排队期间来源变化 | `ARCHIVE_INPUT_CHANGED`，不构造缓存或发布输出 |
| 排队关闭、Renderer 额外资源参数 | 分别取消释放或在 Main 拒绝；无生成 Worker |
| 防御性测试强制真实 Worker 使用低档读取超限 CSV | `EXECUTION_INPUT_PROFILE_UNSUITABLE`，不依赖 OOM 结束，无发布 |
| pending 兼容、XLSX 内容使用 csv 扩展名 | 原兼容生成成功；实际 XLSX 保留流式低档并回读一致 |

所有集成用例均核对真实 Worker 关闭、活动记录、base／phase 租约、队列、扫描目录和 rows 私有目录收口。固定硬额度用例直接从可信 Main service 装配 FilePlan，计数为夹具；防御性 Worker 用例显式注入更小的执行配置，仅验证实际 reader 的最后保护，不作为生产资格证据。

## 检查记录

| 检查 | 结果 |
| --- | --- |
| rows 与 Supervisor 聚焦单测 | 118/118 PASS，含 6 项新增回归 |
| rows CSV 跨阶段专项 | 13/13 PASS |
| lint | PASS |
| 架构 | PASS，788/788 文件、41 个历史提交 |
| 最终完整 release-check | PASS，退出码 0；单测 9588 PASS / 0 FAIL / 4 Windows SKIP；集成 81/81 脚本、3098 项计数检查 |

最终完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-10-03T02:11:37.240793+08:00 至 2026-10-03T02:32:29.295776+08:00 执行，耗时 1252.05 秒。冻结 1782 个源码、测试和配置输入；仅 runner 自动生成的集成清单变化，规则正文与全部其他输入摘要一致。最终源码未在门禁后修改。完整门禁也重新运行了前两轮 CSV 预扫描与扫描清理回归。机器可读结果及提交前文件摘要见 [validation-result.json](validation-result.json)。

## 复跑与验证边界

```sh
node scripts/integration/toolbox-rows-csv-admission.js
node --test tests/unit/main-process/toolbox-row-split*.test.js tests/unit/main-process/background-execution/supervisor-admission-diagnostics.test.js tests/unit/main-process/background-execution/supervisor.test.js
UNIT_TEST_CONCURRENCY=2 npm run release-check
```

实际执行环境为 macOS / Node v25.8.0。Windows x64 / Electron 36.9.5 身份和可用内存为受控夹具；native 对话框、TaskLifecycle 批次身份及归档耐久回执为夹具。实际 Main 函数、生产资格策略、Supervisor、Worker、SQLite、XLSX Writer、验证、Publisher 和恢复代码均使用当前仓库实现。

150 万行样本的修复后结果仅证明资源不足时在生成前受控退出；本轮没有把它记为普通档完整生成成功。完整生成／发布由 20,000 行和低档边界样本验证。首次复现装配遗漏捕获 Main 函数返回值，修正夹具后完成复现；未将该夹具错误列为产品缺陷。

本轮未重新执行 Windows 实机压力、安装包、Excel/WPS 或完整 GUI 人工验收，也不扩大此前人工 `qualified` 的验收范围。原始日志及冻结输入摘要位于主检出 `outputs/release-v3.2.11/2026-10-03-rows-csv-admission-repair/`。报告记录提交前验证，提交和远端状态见最终交付记录。

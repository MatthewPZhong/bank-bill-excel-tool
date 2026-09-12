# v3.2.9 存档模块保留期限 — 验证记录

## 本地 release 组合复验（2026-09-12）

- 源分支 22 个文件与修复后的完整门禁及最近独立 review 摘要逐项一致，已提交为 `a2bd6e817a08190e82caecfe4f248054b25cae6e`。本次在既有 release `896fe12d29e518ccece8afce5c3d120b1c6de5c7` 上合并，保留已纳入的 Biz OP 自动错误报告功能。
- 生产代码自动合并成功；唯一文本冲突是自动集成清单，最终由组合全量 runner 成功后重新生成，没有手工改规则正文或合并测试数字。
- 新增真实组合集成脚本 `scripts/integration/archive-biz-op-auto-report-retention.js`，6/6 PASS：OP/FLOW 模块期限、永久与继承、历史快照、改配置后同 Task/同 batch 恢复不重复发布、pin/hold 释放，以及存档过期清理不删除 Documents 报告。仅新增测试脚本，未因测试修改生产语义或公共 helper。
- `UNIT_TEST_CONCURRENCY=2 npm run release-check` 于 2026-09-12 14:26:40 +08:00 完成，exit 0 / PASS：lint、smoke 通过；471 个单测文件，7,361 PASS / 0 FAIL / 3 SKIP；56 个集成脚本全部通过，汇总 2,516/2,516。其中模块期限 10/10、Biz OP 自动报告 12/12、组合回归 6/6。
- 合并后 Electron 设置布局与交互 6/6 PASS，Biz OP 原生 DOM 10/10 PASS。3 项单测跳过均为既有 Windows 专属检查。
- 当前组合以 [integration-candidate-20260912.json](integration-candidate-20260912.json) 和 [release 记录](../../release.md)为准，绑定 29 个代码、测试和脚本的 SHA-256；门禁后核对内容一致。
- Windows、Excel/WPS、安装包及真实业务人工验收仍未执行。本次仅本地集成，未推送、升版、创建 PR、标签或正式发布。

以下记录保留模块分支实现与 review 当时的状态；其中“未提交”“未合入 release”及原门禁统计不代表上述当前组合状态。历史证据未覆盖。

日期：2026-09-12。分支：`codex/v3.2.9-archive-retention-by-module`。

## 工作区与范围

- 基线为已核对远端的附注标签 `v3.2.8`，提交 `2ba9ef14fe972363b604955636cff0c9ac53700f`。
- 独立 worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v329-archive-retention-by-module`。
- 主目录已有未提交迭代和文档整理；本次源码及文档均写入独立 worktree。
- 依赖通过本 worktree 的 `node_modules` 符号链接复用现有安装，未新增依赖或修改 lockfile。
- 未改应用版本号、未提交、未推送、未合入 release/main；未访问真实业务数据库或清理用户存档。

## 已完成验证

| 检查 | 结果 | 主要覆盖 |
| --- | --- | --- |
| policy、Controller、ArchiveService 单测 | 121/121 PASS | 全局兼容、模块覆盖、14 scopes、别名、损坏配置、非法输入、3 个建批入口、快照 |
| UI 契约、IPC、TaskLifecycle、存档位置迁移单测 | 136/136 PASS | 既有任务生命周期与服务迁移、永久显示、退出闸门 |
| Task policy 注册闭合检查 | 24/24 PASS | 新接口归类存档维护，IPC 与 registry 精确闭合 |
| 新集成脚本 | 10/10 PASS | 真实 SQLite / 文件、14 模块、TaskLifecycle、outbox 故障恢复、历史期限、过期/永久/锁/hold |
| Electron 设置布局与行为 | 6/6 PASS | 1240×860 / 1080×760，各 100% / 125% / 150%；快速保存、隔离、永久、继承、失败回滚、重开竞态 |
| 独立 renderer 竞态实验 | 2/2 PASS | 保存期间加载不提前读取，离开后的失效请求不再读取 |
| 完整本地门禁 | PASS，退出码 0 | lint、smoke；单测 7,299 通过 / 0 失败 / 3 平台跳过；54 个集成脚本全部通过 |

针对性测试间可能有覆盖重合，不将各行数字相加作为唯一用例总数。

最终完整命令为 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，共有 468 个单测文件、7,302 项单测，3 项跳过均为 Windows 专属 PowerShell / packaged canary 检查。集成 runner 汇总 2,498 个有计数的断言，54 个脚本均返回成功（其中一个脚本不输出断言计数）。本次新脚本也在完整门禁中以 10/10 通过。

集成 runner 自动刷新 `rules/integration-test-policy.md` 中的脚本清单、断言数和耗时，包含新增存档模块期限脚本；未手工改该文件的规则正文。

## 发现与处理

1. 真实 TaskLifecycle 文件任务原来绕过 Controller，并固定使用 Service 的 60 天默认值。现由工厂注入 resolver 统一处理 3 条建批入口。
2. 永久到期日 `null` 原来被 renderer 的空值合并当作缺失；已用属性存在性判断并补行为断言。
3. 保存期间离开并重开设置，旧 `getSettings` 快照可能被慢 `getStats` 延迟，覆盖刚保存的显示。现先开启 loading，等待保存，再发读取；实际 DOM 延迟回包验证通过。
4. 第一轮完整门禁发现新 IPC 尚未归入 task policy；已补存档维护分类及精确总数断言。此轮还因 worktree 缺本地 `node_modules`，使历史克隆测试的 `NODE_PATH` 无法找到 `xlsx`；已复用本机现有依赖解决。首轮结果不计作最终 PASS。

首轮完整门禁在单测阶段退出 1：7,296 通过、3 失败、3 平台跳过，后续集成未运行。完成接口登记、依赖路径和 renderer 竞态修正后，从头重跑最终完整命令并通过；最终代码没有省略失败检查。

## 复现与证据

```sh
node --test tests/unit/main-process/archive-retention-policy.test.js tests/unit/main-process/archive-center-controller.test.js tests/unit/main-process/archive-service.test.js
node scripts/integration/archive-center-module-retention.js
node scripts/verify-app-settings-layout.js
UNIT_TEST_CONCURRENCY=2 npm run release-check
```

[设置页截图](evidence/archive-retention-settings.png) 来自真实 Electron 窗口，数据为测试 stub。每个窗口使用独立临时 userData 并在运行后清理；Electron 在沙箱内无法启动，已通过获准的升级权限完成验证。

[完整门禁原始日志](evidence/release-check.txt) 保存最后一次成功命令的完整输出。最终 `git diff --check` 通过。

未执行 Windows / Excel / WPS 或真实业务人工验收，也未构建安装包。本项未改变 Excel 输出格式或对账规则；以上自动测试不代替正式版本发布验收。

## Review 后修复：删除确认不得中断期限保存

日期：2026-09-12。前述记录保留首次实现的验证过程；本节记录 review 发现的界面边界修复及修复后的最终门禁。

### 问题与修复

连续选择 30 天、永久时，第一次保存可能仍在等待响应。此时返回列表并打开删除确认会移除设置弹窗；保存队列因为弹窗已离开 DOM 停止处理最后一次选择。审查中的隔离 Electron 探针确认，控件仍为永久而 API stub 中保存的配置为 30 天，取消确认后返回／关闭按钮仍禁用。

`confirmArchiveBatchDelete` 现先检查设置加载、正在保存及待保存意图。状态尚未收口时只在原反馈区域提示稍后重试，不创建或打开删除确认；队列仍可完成最终选择。成功或失败收口后，删除确认与取消恢复沿用原流程。返回列表会取消设置加载，已取消请求不继续阻塞删除；未改期限解析、批次到期日、删除 IPC 或后端删除逻辑。

### 回归与最终结果

- 实际 Electron DOM 新增 5 类交叉场景：取消设置加载后的旧响应，以及全局／模块期限各自的最终永久保存成功／失败。验证原弹窗保持挂载、提示可见、未调用删除 API、最终选择按顺序保存、失败回滚、其他模块不变、保存结束可打开并取消删除确认、返回／关闭及重新打开设置正常。
- 最初新增加载场景曾把返回列表后已取消的请求误判为仍在加载，首轮验证失败；已按既有请求失效语义修正断言，没有扩大生产行为来维持该错误假设。
- 另在临时快照中仅去掉本次删除入口保护，实际 Electron 回归按预期失败：`default saved final permanent: delete confirmation detached the pending settings dialog`。临时快照及 userData 均已清理，正式 worktree 保持修复内容。
- 修复后 `node scripts/verify-app-settings-layout.js` 为 6/6 PASS。交互回归在 1240×860、100% 组合执行；布局覆盖两个窗口尺寸和三档缩放。
- `node --test --test-reporter=spec tests/unit/archive-center-ui-contract.test.js` 为 27/27 PASS；两个变更 JS 的 `node --check` 和最终 `git diff --check` 通过。
- 修复后的完整命令 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 退出码 0：lint、smoke 通过；468 个单测文件、7,302 项单测中 7,299 通过、0 失败、3 项 Windows 平台检查跳过；54 个集成脚本全部通过，runner 汇总 2,498 个有计数的断言，其中模块保留期限为 10/10 PASS。

[修复后完整门禁日志](evidence/review-fix-release-check.txt) 是本次修复后的最终门禁证据；原日志保留。集成 runner 仅自动刷新 `rules/integration-test-policy.md` 的清单耗时与汇总。本轮仍未执行 Windows、安装包或真实业务人工验收，未提交或推送。

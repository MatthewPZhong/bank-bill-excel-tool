# Template rename `beforeStart` evidence preflight

## Task Brief

- Goal: 修复生成网银账单模板重命名在执行前报错“beforeStart evidence 必须是对象”。
- Context: `template:rename` 是 `no-file` Task Run；统一 IPC 包装层在没有模块自定义 `beforeStart` 时仍执行最终 Hold 复核。
- Constraints: 保留最终 Hold 复核；不改变模板名称校验、SQLite 写入、模板库同步和使用统计口径；不碰当前工作区其他未完成改动。
- Done when: 普通 `no-file` handler 能通过任务准入并进入 execute；非法自定义 evidence 仍由生命周期拒绝；入口级回归测试通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| `template:rename` 使用普通函数 handler，没有自定义 `prepare/beforeStart` | `src/main.js` 的 `template:rename` 注册；`ipc-task-contract.js#normalizeIpcTaskHandler` | 修复不能依赖模板入口自行补 evidence |
| `runArchiveAwareOperation` 会为所有 `no-file` 任务安装最终 `beforeStart` 包装 | `src/main.js#runArchiveAwareOperation` | 必须保留包装，以继续执行最终 Hold gate |
| 包装在无自定义 hook 时返回 `null` | `src/main.js#runArchiveAwareOperation` | `null` 与生命周期 evidence 契约冲突 |
| 生命周期只跳过 `undefined`，其余 evidence 必须是非数组对象 | `src/main-process/archive-center/task-lifecycle.js#runOperationOnly` | 无 evidence 应返回 `{}` 或 `undefined`，不能放宽生命周期校验 |
| 远端当前分支仍有同一实现 | `git show origin/codex/v3.2.0-r4-review-hardening:src/main.js` | 不能通过同步已有远端修复解决 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 报错是否由模板名内容触发 | 已知未知 | 中 | 容易 | 异常在 execute 前由生命周期抛出 | PROBE | 沿 `template:rename` → wrapper → lifecycle 调用链检查 | 否，与 `BC-GB-2608` 内容无关 |
| 应修模板入口还是共享包装层 | 盲区 | 高 | 容易 | 同一空 evidence fallback 覆盖 59 个 `no-file` policy | PROBE | 检查 policy inventory 和 wrapper 契约 | 修共享包装层，避免逐入口补丁 |
| 能否删除包装层 | 状态生命周期 | 高 | 容易 | 包装层还承担最终 Hold 复核 | PROBE | 检查 `assertTaskPolicyNotHeld` 三段 gate | 不能删除，只修返回值 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 增加 no-file 包装契约回归测试 | 锁住最终 Hold gate 与对象 evidence | 旧实现测试先失败 | 若无法稳定断言则改测可导出的纯函数 seam | 只撤回测试 |
| 2 | 将无自定义 hook fallback 改为 `{}` | 修复所有普通 no-file handler，保留严格 evidence 校验 | 定向测试通过 | 若影响自定义 evidence，则收缩为只处理 hook 缺失分支 | 单行回滚 |
| 3 | 跑 policy/lifecycle 聚焦测试与重要变量检查 | 防止 task policy、状态终结和审计接线回归 | 相关测试全绿，检查无未解释命中 | 失败则停止扩大验证并定位 | 不触及业务数据 |
